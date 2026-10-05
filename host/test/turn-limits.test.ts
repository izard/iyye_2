// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The 2026-10-03 Telegram incident fixes: thinking sent explicitly per model,
 * a reply cut off before answering is recovered, and large tool results from
 * earlier turns are trimmed from requests (never from the transcript).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { Type } from "typebox";
import { currentTurnStart, HOST_NOTE_PREFIX, trimEarlierToolResults } from "../src/integration/pi/context.ts";
import { operatingNote } from "../src/integration/pi/prompt.ts";
import { createLocalModelRuntime, thinkingLevelFor } from "../src/integration/pi/runtime.ts";
import {
	PiConversations,
	RECOVERY_NOTE,
	RECOVERY_NOTE_EMPTY,
	RECOVERY_NOTE_TOOL_LOOP,
} from "../src/integration/pi/sessions.ts";
import { silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import { loadRegistry, RegistryError } from "../src/models/registry.ts";
import type { RouterProcess } from "../src/models/router.ts";
import { openDb } from "../src/state/db.ts";
import { toolCallsForScope } from "../src/state/tool-calls.ts";
import { type IyyeTool, shorten, ToolBroker } from "../src/tools/broker.ts";
import { fakeRouterProcess, freePort, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";

const BIG = `Web content (quoted data): https://example.org/page\n${"Lorem ipsum dolor sit amet. ".repeat(200)}`;

test("trimming: large results from earlier turns become stubs; the current turn and a recovery note are untouched", () => {
	const tr = (name: string, text: string) => ({
		role: "toolResult",
		toolName: name,
		content: [{ type: "text", text }],
	});
	const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
	const msgs = [
		user("how old is Kloster Reutberg?"),
		{ role: "assistant", content: [] },
		tr("web_fetch", BIG),
		tr("current_time", "13:14"),
		{ role: "assistant", content: [{ type: "text", text: "Founded 1606." }] },
		user("and Bunin?"),
		{ role: "assistant", content: [] },
		tr("web_search", BIG),
		user(`${HOST_NOTE_PREFIX} answer now`),
	];
	assert.equal(currentTurnStart(msgs), 5, "the host note is not a new turn");
	const out = trimEarlierToolResults(msgs);
	assert.match(
		(out[2]!.content as { text: string }[])[0]!.text,
		/^\[Earlier web_fetch result, \d+ characters, not repeated here\. It began: Web content \(quoted data\): https:\/\/example\.org\/page — call the tool again if you need its content\.\]$/,
	);
	assert.equal(out[3], msgs[3], "small results stay");
	assert.equal(out[7], msgs[7], "the current turn's results stay, even during recovery");
	assert.equal((msgs[2]!.content as { text: string }[])[0]!.text, BIG, "the input is not modified");
});

test("the registry's thinking setting: off by default, on or off only", () => {
	const sb = sandbox();
	try {
		const raw = JSON.parse(readFileSync(sb.registryPath, "utf8"));
		raw.models[0].thinking = "on";
		writeFileSync(sb.registryPath, JSON.stringify(raw));
		const r = loadRegistry(sb.registryPath);
		assert.equal(r.models[0]!.thinking, "on");
		assert.equal(r.models[1]!.thinking, "off");
		raw.models[0].thinking = "sometimes";
		writeFileSync(sb.registryPath, JSON.stringify(raw));
		assert.throws(() => loadRegistry(sb.registryPath), RegistryError);
	} finally {
		sb.cleanup();
	}
});

describe("turn limits on the fake router", () => {
	const sb: Sandbox = sandbox();
	let router: RouterProcess;
	const requestsFile = join(sb.stateDir, "fake-router-requests.jsonl");
	const requests = () =>
		existsSync(requestsFile)
			? readFileSync(requestsFile, "utf8")
					.trim()
					.split("\n")
					.map(
						(l) =>
							JSON.parse(l) as {
								model: string;
								max_tokens?: number;
								chat_template_kwargs?: Record<string, unknown>;
								messages: { role: string; content: unknown }[];
							},
					)
			: [];
	const big: IyyeTool = {
		name: "big",
		label: "Big",
		description: "returns a long text",
		summary: "a long text",
		// No arguments at all: extra ones are rejected by validation before the tool runs.
		parameters: Type.Object({}, { additionalProperties: false }),
		run: async () => BIG,
	};

	before(async () => {
		const raw = JSON.parse(readFileSync(sb.registryPath, "utf8"));
		raw.models.find((m: { name: string }) => m.name === "small-2").thinking = "on";
		writeFileSync(sb.registryPath, JSON.stringify(raw));
		sb.registry = loadRegistry(sb.registryPath);
		writeFileSync(join(sb.stateDir, "models.ini"), renderPreset(sb.registry));
		router = fakeRouterProcess(sb, await freePort());
		await router.start();
		const client = new RouterClient(router.url);
		for (const m of ["small", "small-2"]) await client.load(m);
		await waitFor(async () => {
			const s = await client.listModels();
			return s.get("small")?.value === "loaded" && s.get("small-2")?.value === "loaded";
		});
	});
	after(async () => {
		await router.stop();
		sb.cleanup();
	});
	beforeEach(() => rmSync(requestsFile, { force: true }));

	async function conversations() {
		const db = openDb(":memory:");
		const conv = new PiConversations({
			db,
			runtime: await createLocalModelRuntime({ routerUrl: router.url, registry: sb.registry }),
			thinkingLevel: (m) => thinkingLevelFor(sb.registry, m),
			stateDir: sb.stateDir,
			identity: "You are Iyye.",
			log: silentLogger,
			tools: new ToolBroker({
				db,
				log: silentLogger,
				toolkits: [{ name: "core", description: "basics", effect: "read", tools: [big] }],
			}),
		});
		return { db, conv };
	}
	const owner = { kind: "owner" as const, channel: "web" as const };

	test("thinking is sent explicitly on every request: off by default, on (with a larger output limit) when the registry says so", async () => {
		const { conv } = await conversations();
		await conv.turn({ scope: "t-off", view: owner, model: "small", text: "hi" });
		await conv.turn({ scope: "t-on", view: owner, model: "small-2", text: "hi" });
		const [off, on] = requests();
		assert.deepEqual(off!.chat_template_kwargs, { enable_thinking: false });
		assert.equal(off!.max_tokens, 4096);
		assert.deepEqual(on!.chat_template_kwargs, { enable_thinking: true });
		assert.equal(on!.max_tokens, 2048, "half the slot (4096 tokens in the test registry), at most 16,384");
		await conv.disposeAll();
	});

	test("a reply cut off at the output limit gets one recovery step with tools closed, and the person gets an answer", async () => {
		const { db, conv } = await conversations();
		const r = await conv.turn({
			scope: "t-len",
			view: owner,
			model: "small",
			text: "how old is Kloster Reutberg? [[length]]",
		});
		assert.ok(r.ok, JSON.stringify(r));
		assert.equal(r.ok && r.text, `echo: ${RECOVERY_NOTE}`);
		const rs = requests();
		assert.equal(rs.length, 2);
		assert.match(JSON.stringify(rs[1]!.messages.at(-1)), /Note from Iyye's host, not from the person/);
		assert.deepEqual(toolCallsForScope(db, "t-len"), [], "no tools ran");
		await conv.disposeAll();
	});

	test("a reply that ends with no answer gets one recovery step: thinking off for that request, tools still open", async () => {
		const { conv } = await conversations();
		const r = await conv.turn({
			scope: "t-empty",
			view: owner,
			model: "small-2",
			text: "Bunin's Nobel piece? [[empty]]",
		});
		assert.ok(r.ok, JSON.stringify(r));
		assert.equal(r.ok && r.text, `echo: ${RECOVERY_NOTE_EMPTY}`);
		const [first, recovery] = requests();
		assert.deepEqual(first!.chat_template_kwargs, { enable_thinking: true }, "the model thinks as configured");
		assert.deepEqual(recovery!.chat_template_kwargs, { enable_thinking: false }, "the recovery request does not");
		assert.equal(requests().length, 2);
		// The next ordinary turn thinks again.
		await conv.turn({ scope: "t-empty", view: owner, model: "small-2", text: "thanks" });
		assert.deepEqual(requests().at(-1)!.chat_template_kwargs, { enable_thinking: true });
		await conv.disposeAll();
	});

	test("a cut-off reply's recovery also goes out with thinking off", async () => {
		const { conv } = await conversations();
		const r = await conv.turn({ scope: "t-cut", view: owner, model: "small-2", text: "long [[length]]" });
		assert.ok(r.ok && r.text === `echo: ${RECOVERY_NOTE}`);
		assert.deepEqual(requests().at(-1)!.chat_template_kwargs, { enable_thinking: false });
		await conv.disposeAll();
	});

	test("compaction goes out with thinking off, and the next turn thinks again (2026-10-05)", async () => {
		const { conv } = await conversations();
		for (const n of [1, 2, 3]) await conv.turn({ scope: "t-comp", view: owner, model: "small-2", text: `part ${n}` });
		const live = (
			conv as unknown as {
				live: Map<
					string,
					{ session: { compact(): Promise<unknown>; settingsManager: { applyOverrides(o: object): void } } }
				>;
			}
		).live;
		const session = live.get("t-comp")!.session;
		// Keep almost nothing recent, so these few turns are enough to compact.
		session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		await session.compact();
		const isSummary = (r: { messages: { role: string; content: unknown }[] }) =>
			/summar/i.test(JSON.stringify(r.messages.find((m) => m.role === "system")?.content ?? ""));
		const summaries = requests().filter(isSummary);
		assert.ok(summaries.length >= 1, "a summarization request was sent");
		for (const r of summaries) assert.equal(r.chat_template_kwargs?.enable_thinking, false, "summaries do not think");
		await conv.turn({ scope: "t-comp", view: owner, model: "small-2", text: "thanks" });
		// Pi may compact again after it (on its own, also without thinking); the turn's own request thinks.
		const turn = requests()
			.filter((r) => !isSummary(r))
			.at(-1)!;
		assert.match(JSON.stringify(turn.messages.at(-1)), /thanks/);
		assert.equal(turn.chat_template_kwargs?.enable_thinking, true, "the next turn thinks again");
		for (const r of requests().filter(isSummary)) assert.equal(r.chat_template_kwargs?.enable_thinking, false);
		await conv.disposeAll();
	});

	test("a tool-call loop is stopped, even when every call is rejected before it runs, and the person still gets an answer", async () => {
		const { db, conv } = await conversations();
		// `big` takes no arguments: these are rejected by validation every time, like the 125 over-long queries.
		const r = await conv.turn({
			scope: "t-loop",
			view: owner,
			model: "small-2",
			text: 'research it [[callloop:big|{"query":"far too long"}]]',
		});
		assert.ok(r.ok, JSON.stringify(r));
		assert.equal(r.ok && r.text, `echo: ${RECOVERY_NOTE_TOOL_LOOP}`);
		const rs = requests();
		assert.equal(rs.length, 4, "three rejected calls, then the recovery request");
		assert.deepEqual(rs.at(-1)!.chat_template_kwargs, { enable_thinking: false });
		assert.deepEqual(toolCallsForScope(db, "t-loop"), [], "nothing ran");
		await conv.disposeAll();
	});

	test("a big result is sent in full during its own turn, as a stub in later turns, and stays complete in the transcript", async () => {
		const { conv } = await conversations();
		const first = await conv.turn({ scope: "t-trim", view: owner, model: "small", text: "read it [[tool:big]]" });
		assert.ok(first.ok);
		await conv.turn({ scope: "t-trim", view: owner, model: "small", text: "thanks" });
		const rs = requests();
		const toolMsg = (i: number) => JSON.stringify(rs[i]!.messages.find((m) => m.role === "tool"));
		assert.ok(toolMsg(1).includes("Lorem ipsum dolor sit amet. Lorem"), "full during its own turn");
		const later = toolMsg(rs.length - 1);
		assert.match(later, /Earlier big result, \d+ characters, not repeated here/);
		assert.ok(!later.includes("Lorem ipsum dolor sit amet. Lorem"));
		assert.ok(
			readFileSync(conv.sessionFile("t-trim")!, "utf8").includes("Lorem ipsum dolor sit amet. Lorem"),
			"transcript intact",
		);
		await conv.disposeAll();
	});
});

test("a closed turn refuses every further tool call", async () => {
	const db = openDb(":memory:");
	const tools = new ToolBroker({
		db,
		log: silentLogger,
		toolkits: [
			{
				name: "core",
				description: "x",
				effect: "read",
				tools: [
					{
						name: "t",
						label: "t",
						description: "t",
						summary: "t",
						parameters: Type.Object({}),
						run: async () => "ran",
					},
				],
			},
		],
	}).forSession({ scope: "s", principal: "owner" });
	tools.closeTurn();
	const r = await (
		tools.definitions[0]!.execute as (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }>
	)("c", {}, undefined, undefined, undefined);
	assert.equal(r.isError, true);
	assert.match(r.content[0]!.text, /tools are closed for this reply/);
	tools.beginTurn();
	assert.equal(
		(
			await (tools.definitions[0]!.execute as (...a: unknown[]) => Promise<{ content: { text: string }[] }>)(
				"c",
				{},
				undefined,
				undefined,
				undefined,
			)
		).content[0]!.text,
		"ran",
	);
});

test("with the web toolkit, the prompt asks for facts to be checked, not answered from memory", () => {
	const kit = (name: string) => ({ name, description: name, effect: "read" as const, tools: [`${name}_tool: x`] });
	assert.match(
		operatingNote([kit("core"), kit("web")]),
		/check it with web_search; do not answer such questions from memory alone/,
	);
	assert.doesNotMatch(operatingNote([kit("core")]), /web_search/);
});

test("an over-long tool argument is shortened at a word boundary with a note, never rejected (2026-10-05)", () => {
	const long = `${"vision language model video encoding research ".repeat(10)}`.trim();
	const s = shorten(long, 300);
	assert.ok(s.text.length <= 300 && !s.text.endsWith(" "));
	assert.ok(long.startsWith(s.text));
	assert.match(
		s.note,
		/^\(Your \d+-character query was shortened to its first \d+ characters\. Use a few words\.\)\n$/,
	);
	assert.deepEqual(shorten("  short  query ", 300), { text: "short query", note: "" });
});
