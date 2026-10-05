// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ScopeView } from "../src/integration/pi/prompt.ts";
import { operatingNote } from "../src/integration/pi/prompt.ts";
import { createLocalModelRuntime } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { handleOwnerCommand, isKnownCommand } from "../src/kernel/commands.ts";
import { silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import type { RouterProcess } from "../src/models/router.ts";
import { openDb } from "../src/state/db.ts";
import { toolCallsForScope } from "../src/state/tool-calls.ts";
import { type IyyeTool, ToolBroker, type ToolContext, type Toolkit } from "../src/tools/broker.ts";
import { currentTimeTool, describeTime, systemStatusTool } from "../src/tools/probes.ts";
import { toolsReport } from "../src/tools/report.ts";
import { fakeRouterProcess, freePort, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";

const FIXED = new Date("2026-10-02T09:42:00Z");

/** A tool with an effect, for the owner-only "act" toolkit. */
const actTool: IyyeTool = {
	name: "light_on",
	label: "Light on",
	description: "Turns the light on.",
	summary: "turn the light on",
	parameters: Type.Object({}),
	run: async () => "on",
};

function standardKits(): Toolkit[] {
	return [
		{ name: "core", description: "the time", effect: "read", tools: [currentTimeTool(() => FIXED)] },
		{
			name: "machine",
			description: "this computer",
			effect: "read",
			tools: [systemStatusTool({ memory: () => 42.5, loadedModels: async () => ["small"], paths: [tmpdir()] })],
		},
		{ name: "home", description: "the house", effect: "act", tools: [actTool] },
	];
}

function broker(db = openDb(":memory:"), toolkits = standardKits(), maxCallsPerTurn = 8) {
	return new ToolBroker({ db, toolkits, log: silentLogger, maxCallsPerTurn });
}

type Exec = (
	id: string,
	p: unknown,
	s: AbortSignal | undefined,
	u: undefined,
	c: never,
) => Promise<{
	content: { text: string }[];
	isError?: boolean;
}>;
const exec = (def: { execute: unknown }) => (def.execute as Exec)("call", {}, undefined, undefined, undefined as never);

describe("probes", () => {
	test("current_time gives the local date, weekday, timezone offset and ISO time", () => {
		const s = describeTime(FIXED, "Europe/Berlin");
		assert.match(
			s,
			/^Friday, 2 October 2026 at 11:42 \(Europe\/Berlin, UTC\+02:00\)\. ISO: 2026-10-02T09:42:00\.000Z$/,
		);
		assert.match(describeTime(FIXED, "UTC"), /09:42 \(UTC, UTC\+00:00\)/);
	});

	test("system_status reports disk, memory, uptime, load and models without revealing the home path", async () => {
		const tool = systemStatusTool({ memory: () => 42.5, loadedModels: async () => ["small"] });
		const out = await tool.run({}, { scope: "owner", principal: "owner" }, undefined);
		assert.match(out, /^Disk \(volume of home folder\): \d+\.\d GB free of \d+\.\d GB$/m);
		assert.match(out, /^Memory available for new work: 42\.5 GB$/m);
		assert.match(out, /^Uptime: \d+ d \d+ h$/m);
		assert.match(out, /^Loaded models: small$/m);
		assert.ok(!out.includes(process.env.HOME ?? "/nonexistent"));
	});
});

describe("tool broker", () => {
	test("read-only toolkits are for everyone; a toolkit with effects only for the owner; order is fixed", () => {
		const b = broker();
		const contact = b.forSession({ scope: "contact:x", principal: "contact" });
		assert.deepEqual(contact.names, ["current_time", "system_status"], "contacts get every read-only toolkit");
		assert.deepEqual(
			contact.toolkits.map((k) => k.name),
			["core", "machine"],
		);
		const owner = b.forSession({ scope: "owner", principal: "owner" });
		assert.deepEqual(owner.names, ["current_time", "system_status", "light_on"]);
		assert.deepEqual(
			owner.toolkits.map((k) => `${k.name}:${k.effect}`),
			["core:read", "machine:read", "home:act"],
		);
		// The declared order never depends on anything but the toolkit list (a change costs a full reprocessing).
		assert.deepEqual(
			broker()
				.forSession({ scope: "owner", principal: "owner" })
				.definitions.map((d) => d.name),
			owner.names,
		);
		assert.deepEqual(owner.toolkits[0]!.tools, [`current_time: ${currentTimeTool().summary}`]);
	});

	test("tool and toolkit names are unique", () => {
		const kits = standardKits();
		assert.throws(
			() => broker(openDb(":memory:"), [...kits, { ...kits[0]!, name: "other" }]),
			/duplicate tool current_time/,
		);
		assert.throws(() => broker(openDb(":memory:"), [...kits, { ...kits[0]!, tools: [] }]), /duplicate toolkit core/);
	});

	test("the system prompt lists tools grouped by toolkit", () => {
		const note = operatingNote(broker().forSession({ scope: "contact:x", principal: "contact" }).toolkits);
		assert.match(note, /use these read-only tools/);
		assert.match(note, /^- the time \(core\):\n {2}- current_time: /m);
		assert.match(note, /^- this computer \(machine\):\n {2}- system_status: /m);
		assert.doesNotMatch(
			operatingNote(broker().forSession({ scope: "owner", principal: "owner" }).toolkits),
			/read-only/,
		);
		assert.match(operatingNote([]), /you have no tools/);
	});

	test("calls are authorized again at execution time, against the session's principal", async () => {
		const db = openDb(":memory:");
		const b = broker(db);
		const contact: ToolContext = { scope: "contact:x", principal: "contact" };
		// Simulate a wrongly built tool list: bind the owner-only tool to a contact's context.
		const def = (
			b as unknown as { definition: (t: IyyeTool, c: ToolContext, b: { used: number }) => { execute: unknown } }
		).definition(actTool, contact, { used: 0 });
		const r = await exec(def);
		assert.equal(r.isError, true);
		assert.match(r.content[0]!.text, /light_on is not available here/);
		assert.deepEqual(
			toolCallsForScope(db, "contact:x").map((c) => [c.tool, c.toolkit, c.principal, c.outcome]),
			[["light_on", "home", "contact", "denied"]],
		);
	});

	test("each turn has a call budget, reset at the next turn", async () => {
		const db = openDb(":memory:");
		const tools = broker(db, standardKits(), 2).forSession({ scope: "owner", principal: "owner" });
		const time = tools.definitions[0]!;
		assert.equal((await exec(time)).isError, undefined);
		assert.equal((await exec(time)).isError, undefined);
		const third = await exec(time);
		assert.equal(third.isError, true);
		assert.match(third.content[0]!.text, /tool call limit for this turn \(2\) reached/);
		tools.beginTurn();
		assert.equal((await exec(time)).isError, undefined);
		assert.deepEqual(
			toolCallsForScope(db, "owner").map((c) => c.outcome),
			["ok", "ok", "denied", "ok"],
		);
	});

	test("a failing tool is reported to the model as an error and recorded", async () => {
		const db = openDb(":memory:");
		const failing: IyyeTool = {
			name: "flaky",
			label: "Flaky",
			description: "fails",
			summary: "fails",
			parameters: Type.Object({}),
			run: async () => {
				throw new Error("disk unreadable");
			},
		};
		const r = await exec(
			broker(db, [{ name: "t", description: "t", effect: "read", tools: [failing] }]).forSession({
				scope: "s",
				principal: "owner",
			}).definitions[0]!,
		);
		assert.equal(r.isError, true);
		assert.equal(r.content[0]!.text, "flaky failed: disk unreadable");
		assert.equal(toolCallsForScope(db, "s")[0]!.outcome, "error");
	});
});

test("/tools lists toolkits in order with who may use them, and the latest calls with their toolkit", async () => {
	const db = openDb(":memory:");
	const b = broker(db);
	await exec(b.forSession({ scope: "owner", principal: "owner" }).definitions[0]!);
	const report = toolsReport(db, b.toolkits);
	assert.match(
		report,
		/^toolkits, in declaration order:\n {2}core — the time · everyone \(read-only\)\n {4}current_time: /,
	);
	assert.match(report, / {2}home — the house · owner only \(has effects\)/);
	assert.match(report, /last 1 call\(s\):\n {2}\d{4}-\d\d-\d\d \d\d:\d\d you: core\/current_time → ok$/);
	const ctx = { models: {} as never, db, issuer: "owner_web", toolsReport: () => toolsReport(db, b.toolkits) };
	assert.equal((await handleOwnerCommand("/tools", ctx)).reply, report);
	assert.ok(isKnownCommand("/tools"));
});

describe("tools in Pi conversations", () => {
	const sb: Sandbox = sandbox();
	let router: RouterProcess;
	let runtime: ModelRuntime;
	const requestsFile = join(sb.stateDir, "fake-router-requests.jsonl");
	const requests = (): {
		tools?: { function: { name: string } }[];
		messages: { role: string; content: unknown }[];
	}[] =>
		existsSync(requestsFile)
			? readFileSync(requestsFile, "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l))
			: [];
	const OWNER: ScopeView = { kind: "owner", channel: "web" };
	const JULIA: ScopeView = { kind: "contact", displayName: "Julia", channel: "telegram" };

	before(async () => {
		writeFileSync(join(sb.stateDir, "models.ini"), renderPreset(sb.registry));
		router = fakeRouterProcess(sb, await freePort());
		await router.start();
		const client = new RouterClient(router.url);
		await client.load("small");
		await waitFor(async () => (await client.listModels()).get("small")?.value === "loaded");
		runtime = await createLocalModelRuntime({ routerUrl: router.url, registry: sb.registry });
	});
	after(async () => {
		await router.stop();
		sb.cleanup();
	});
	beforeEach(() => rmSync(requestsFile, { force: true }));

	const setup = () => {
		const db = openDb(":memory:");
		const conv = new PiConversations({
			db,
			runtime,
			stateDir: sb.stateDir,
			identity: "You are Iyye.",
			log: silentLogger,
			tools: broker(db),
		});
		return { db, conv };
	};

	test("the owner asks for the time: the model calls current_time and answers from its result", async () => {
		const { db, conv } = setup();
		const r = await conv.turn({
			scope: "owner",
			view: OWNER,
			model: "small",
			text: "what time is it [[tool:current_time]]",
		});
		assert.equal(r.ok, true);
		assert.match(r.ok ? r.text : "", /^tool result: Friday, 2 October 2026 at \d\d:42/);
		const [first] = requests();
		assert.deepEqual(
			first!.tools!.map((t) => t.function.name),
			["current_time", "system_status", "light_on"],
			"declared in toolkit order",
		);
		assert.match(JSON.stringify(first!.messages[0]), /use these tools; use them instead of guessing/);
		assert.deepEqual(
			toolCallsForScope(db, "owner").map((c) => [c.tool, c.outcome]),
			[["current_time", "ok"]],
		);
		await conv.disposeAll();
	});

	test("the owner asks for disk space: system_status runs", async () => {
		const { conv } = setup();
		const r = await conv.turn({ scope: "owner", view: OWNER, model: "small", text: "[[tool:system_status]]" });
		assert.match(r.ok ? r.text : "", /tool result: Disk \(volume of .*\): [\d.]+ GB free/);
		await conv.disposeAll();
	});

	test("a contact gets every read-only toolkit, but never a toolkit with effects, even if the model calls it", async () => {
		const { db, conv } = setup();
		const r = await conv.turn({
			scope: "contact:julia",
			view: JULIA,
			model: "small",
			text: "[[tool:light_on]]",
		});
		const [first] = requests();
		assert.deepEqual(
			first!.tools!.map((t) => t.function.name),
			["current_time", "system_status"],
		);
		assert.match(JSON.stringify(first!.messages[0]), /read-only tools; use them instead of guessing/);
		assert.ok(r.ok);
		assert.equal(
			toolCallsForScope(db, "contact:julia").filter((c) => c.outcome === "ok").length,
			0,
			"light_on never executed",
		);
		// Owner decision (plan 0.004 §8): read-only tools, including this computer's state, are for contacts too.
		const status = await conv.turn({
			scope: "contact:julia",
			view: JULIA,
			model: "small",
			text: "[[tool:system_status]]",
		});
		assert.match(status.ok ? status.text : "", /tool result: Disk \(volume of .*\): [\d.]+ GB free/);
		assert.deepEqual(
			toolCallsForScope(db, "contact:julia")
				.map((c) => [c.toolkit, c.tool, c.outcome])
				.filter((c) => c[2] === "ok"),
			[["machine", "system_status", "ok"]],
		);
		await conv.disposeAll();
	});

	test("a model stuck calling a tool is stopped by the per-turn budget and still finishes", async () => {
		const { db, conv } = setup();
		const r = await conv.turn({
			scope: "owner-loop",
			view: OWNER,
			model: "small",
			text: "[[toolloop:current_time]]",
		});
		assert.ok(r.ok);
		assert.match(r.ok ? r.text : "", /tool call limit for this turn \(8\) reached/);
		const outcomes = toolCallsForScope(db, "owner-loop").map((c) => c.outcome);
		assert.deepEqual(outcomes, [...Array(8).fill("ok"), "denied"]);
		await conv.disposeAll();
	});

	test("without a broker a session has no tools at all", async () => {
		const conv = new PiConversations({
			db: openDb(":memory:"),
			runtime,
			stateDir: sb.stateDir,
			identity: "You are Iyye.",
			log: silentLogger,
		});
		await conv.turn({ scope: "owner-none", view: OWNER, model: "small", text: "hi" });
		const [first] = requests();
		assert.equal(first!.tools, undefined);
		assert.match(JSON.stringify(first!.messages[0]), /you have no tools/);
		await conv.disposeAll();
	});
});
