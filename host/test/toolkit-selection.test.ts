// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.004 §3.4: toolkit selection acting. Kev chooses, before a turn,
 * which permitted toolkits to add; a session starts with the always-on ones,
 * only ever adds, keeps the broker's order, and its prompt lists exactly the
 * declared tools, after a reopen and a restart too.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DecisionClient } from "../src/decisions/client.ts";
import { decisionsReport, roleReport } from "../src/decisions/report.ts";
import { INCLUDE_AT, ToolkitSelector } from "../src/decisions/toolkit-selection.ts";
import { createLocalModelRuntime } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import type { RouterProcess } from "../src/models/router.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { type IyyeTool, ToolBroker, type Toolkit, type ToolkitSummary } from "../src/tools/broker.ts";
import { FakeKev } from "./fixtures/fake-kev-http.ts";
import { fakeRouterProcess, freePort, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";

const summary = (name: string, effect: Toolkit["effect"] = "read"): ToolkitSummary => ({
	name,
	description: `the ${name}`,
	effect,
	tools: [`${name}_tool: ${name}`],
});
const rows = (db: Db) =>
	db.prepare("SELECT * FROM decisions ORDER BY created_at, rowid").all() as Record<string, unknown>[];

describe("the selector", () => {
	const kev = new FakeKev();
	before(() => kev.start());
	after(() => kev.stop());
	beforeEach(() => {
		kev.answer = () => 0.5;
		kev.status = 200;
		kev.up = true;
	});
	const permitted = ["core", "machine", "web", "reminders", "plans"].map((n) => summary(n));
	const req = (active: string[] = ["core", "reminders", "plans"]) => ({
		scope: "owner",
		principal: "owner" as const,
		text: "what is your uptime?",
		permitted,
		active,
		fresh: false,
	});

	test("asks only about inactive, selectable toolkits; keeps one out only below p 0.2; no call when none is left", async () => {
		const db = openDb(":memory:");
		const sel = new ToolkitSelector({
			db,
			client: new DecisionClient({ db, service: kev.service }),
			log: silentLogger,
		});
		assert.equal(INCLUDE_AT, 0.2);
		kev.answer = (id) => (id === "machine" ? 0.2 : 0.19);
		const n = kev.requests.length;
		assert.deepEqual(await sel.choose(req()), ["machine"], "the uptime case: 0.285 would be kept by 0.2, not by 0.3");
		assert.deepEqual(Object.keys(kev.requests.at(-1)!.questions), ["machine", "web"], "never core, reminders, plans");
		const [r] = rows(db);
		assert.deepEqual([r!.mode, r!.schema_version, r!.status], ["acting", 2, "ok"]);
		assert.deepEqual(await sel.choose(req(["core", "machine", "reminders", "plans"])), []);
		assert.deepEqual(Object.keys(kev.requests.at(-1)!.questions), ["web"]);
		assert.deepEqual(await sel.choose(req(["core", "machine", "web", "reminders", "plans"])), []);
		assert.equal(kev.requests.length, n + 2, "nothing to choose: no call");
	});

	test("when Kev cannot answer, every candidate is included", async () => {
		const db = openDb(":memory:");
		const sel = new ToolkitSelector({
			db,
			client: new DecisionClient({ db, service: kev.service }),
			log: silentLogger,
		});
		kev.up = false;
		assert.deepEqual(await sel.choose(req()), ["machine", "web"]);
		kev.up = true;
		kev.status = 500;
		assert.deepEqual(await sel.choose(req()), ["machine", "web"]);
		kev.status = 200;
		kev.answer = () => 1.5; // out of range: an error, never a guess
		assert.deepEqual(await sel.choose(req()), ["machine", "web"]);
		assert.deepEqual(
			rows(db).map((r) => [r.status, r.mode]),
			[
				["skipped", "acting"],
				["error", "acting"],
				["error", "acting"],
			],
		);
	});

	test("a cancelled turn cancels its Kev call", async () => {
		const db = openDb(":memory:");
		const sel = new ToolkitSelector({
			db,
			client: new DecisionClient({ db, service: kev.service }),
			log: silentLogger,
		});
		kev.delayMs = 2000;
		const abort = new AbortController();
		const started = Date.now();
		const p = sel.choose({ ...req(), signal: abort.signal });
		setTimeout(() => abort.abort(), 50);
		assert.deepEqual(await p, ["machine", "web"]);
		assert.ok(Date.now() - started < 1500);
		kev.delayMs = 0;
	});
});

describe("sessions with acting selection", () => {
	const sb: Sandbox = sandbox();
	const kev = new FakeKev();
	let router: RouterProcess;
	let runtime: ModelRuntime;
	const requestsFile = join(sb.stateDir, "fake-router-requests.jsonl");
	type Req = { tools?: { function: { name: string } }[]; messages: { role: string; content: unknown }[] };
	const requests = (): Req[] =>
		existsSync(requestsFile)
			? readFileSync(requestsFile, "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l) as Req)
			: [];
	const declared = (r: Req) => r.tools?.map((t) => t.function.name) ?? [];
	const system = (r: Req) =>
		r.messages
			.filter((m) => m.role === "system")
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
			.join("\n");

	before(async () => {
		await kev.start();
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
		await kev.stop();
		sb.cleanup();
	});

	const tool = (name: string): IyyeTool => ({
		name,
		label: name,
		description: name,
		summary: `${name} summary`,
		parameters: Type.Object({}),
		run: async () => `${name} ok`,
	});
	const kits = (): Toolkit[] => [
		{ name: "core", description: "basics", effect: "read", tools: [tool("current_time")] },
		{ name: "machine", description: "this computer", effect: "read", tools: [tool("system_status")] },
		{ name: "web", description: "the web", effect: "read", tools: [tool("web_search"), tool("web_fetch")] },
		{ name: "shell", description: "act on things", effect: "act", tools: [tool("run_it")] },
		{ name: "reminders", description: "reminders", effect: "self", tools: [tool("reminder_create")] },
	];
	const conversations = (db: Db) => {
		const selector = new ToolkitSelector({
			db,
			client: new DecisionClient({ db, service: kev.service }),
			log: silentLogger,
		});
		return {
			selector,
			conv: new PiConversations({
				db,
				runtime,
				stateDir: sb.stateDir,
				identity: "You are Iyye.",
				log: silentLogger,
				maxLive: 1,
				tools: new ToolBroker({ db, log: silentLogger, toolkits: kits() }),
				toolkitSelection: { alwaysOn: (n) => selector.alwaysOn(n), choose: (r) => selector.choose(r) },
				afterTurn: (t) => selector.observe(t),
			}),
		};
	};

	test("starts with the always-on toolkits, only adds, keeps the order it declared, and the prompt lists exactly what is declared", async () => {
		rmSync(requestsFile, { force: true });
		const db = openDb(join(sb.dir, "sel.db"));
		let { conv } = conversations(db);
		const owner = { kind: "owner" as const, channel: "web" as const };
		const turn = (c: PiConversations, scope: string, text: string, p: Record<string, number>) => {
			kev.answer = (id) => p[id] ?? 0;
			return c.turn({ scope, view: owner, model: "small", text });
		};

		assert.ok((await turn(conv, "owner", "hello", {})).ok);
		let r = requests().at(-1)!;
		assert.deepEqual(declared(r), ["current_time", "reminder_create"], "a fresh session: core and reminders only");
		assert.ok(!system(r).includes("web_search") && !system(r).includes("system_status"));
		assert.ok(system(r).includes("current_time"));

		assert.ok((await turn(conv, "owner", "[[tool:web_search]] who won?", { web: 0.9 })).ok);
		r = requests().at(-1)!;
		// Pi declares an added toolkit after the ones declared before (the transcript's order); it then never moves.
		assert.deepEqual(declared(r), ["current_time", "reminder_create", "web_search", "web_fetch"]);
		assert.ok(system(r).includes("web_search"));
		assert.ok(!system(r).includes("system_status"));

		const before = requests().length;
		assert.ok((await turn(conv, "owner", "thanks", {})).ok);
		const same = requests().slice(before);
		assert.deepEqual(declared(same[0]!), declared(r), "sticky: nothing is removed");
		assert.equal(system(same[0]!), system(r), "and the prompt is unchanged, so the cache holds");

		assert.ok((await turn(conv, "owner", "free disk?", { machine: 0.7 })).ok);
		r = requests().at(-1)!;
		assert.deepEqual(declared(r), ["current_time", "reminder_create", "web_search", "web_fetch", "system_status"]);

		// Pin the request after the add has settled (the next turn), to compare reopens with.
		assert.ok((await turn(conv, "owner", "ok", {})).ok);
		r = requests().at(-1)!;
		// Evicted (another scope opens, maxLive 1), then reopened: the declared set is restored from the
		// transcript, and the tools and system text are identical, so the conversation stays cached.
		assert.ok((await turn(conv, "other", "hi", {})).ok);
		assert.ok((await turn(conv, "owner", "again", {})).ok);
		assert.deepEqual(declared(requests().at(-1)!), declared(r));
		assert.equal(system(requests().at(-1)!), system(r));
		assert.ok(system(r).includes("system_status"));

		// A restart: new conversations over the same state.
		await conv.disposeAll();
		({ conv } = conversations(db));
		assert.ok((await turn(conv, "owner", "after restart", {})).ok);
		assert.deepEqual(declared(requests().at(-1)!), declared(r));
		assert.equal(system(requests().at(-1)!), system(r));

		// Outcomes: what was added, kept out, declared and called.
		const outcomes = rows(db)
			.filter((x) => x.outcome_json)
			.map((x) => JSON.parse(String(x.outcome_json)) as { added: string[]; used: string[]; fresh: boolean });
		assert.deepEqual(outcomes[0], {
			include_at: 0.2,
			fresh: true,
			added: [],
			kept_out: ["machine", "web", "shell"],
			declared: ["core", "reminders"],
			used: [],
			ok: true,
		});
		assert.deepEqual([outcomes[1]!.added, outcomes[1]!.used, outcomes[1]!.fresh], [["web"], ["web"], false]);
		const report = decisionsReport(db, { state: "up", detail: "" });
		assert.match(report, /acting: toolkit_selection/);
		// "hello" then "who won?" is a new question, not a miss: the count is an upper bound, listed for the owner.
		assert.match(
			report,
			/web: asked \d+ · added 1 \(used 1\) · kept out \d+ · kept out, then added on the next turn 1/,
		);
		assert.match(
			report,
			/machine: asked \d+ · added 1 \(used 0\) · kept out \d+ · kept out, then added on the next turn 1/,
		);
		assert.match(report, /web kept out for "hello", added for "\[\[tool:web_search\]\] who won\?"/);
		assert.match(report, /2 add\(s\) after a conversation's first turn/);
		assert.match(roleReport(db, "toolkit_selection"), /schema 2, .*acting — without Kev: include the toolkit/);
		db.close();
	});

	test("an empty reply's recovery gets every permitted toolkit, so 'look it up' has something to look with", async () => {
		rmSync(requestsFile, { force: true });
		const db = openDb(":memory:");
		const { conv } = conversations(db);
		kev.answer = () => 0;
		const r = await conv.turn({
			scope: "owner-empty",
			view: { kind: "owner", channel: "web" },
			model: "small",
			text: "[[empty]] who won the prize?",
		});
		assert.ok(r.ok);
		const [first, recovery] = requests().slice(-2);
		assert.deepEqual(declared(first!), ["current_time", "reminder_create"]);
		assert.ok(declared(recovery!).includes("web_search") && declared(recovery!).includes("system_status"));
		assert.ok(system(recovery!).includes("web_search"));
		await conv.disposeAll();
	});

	test("never wider than the grant: a contact is not asked about, and never gets, an act toolkit; Kev down declares every permitted one", async () => {
		rmSync(requestsFile, { force: true });
		const db = openDb(":memory:");
		const { conv } = conversations(db);
		kev.answer = () => 1;
		const n = kev.requests.length;
		const contact = { kind: "contact" as const, channel: "telegram" as const, displayName: "Julia", trusted: false };
		assert.ok((await conv.turn({ scope: "contact:x", view: contact, model: "small", text: "hi" })).ok);
		assert.deepEqual(Object.keys(kev.requests[n]!.questions), ["machine", "web"]);
		assert.ok(!declared(requests().at(-1)!).includes("run_it"));
		kev.up = false;
		assert.ok(
			(await conv.turn({ scope: "owner-down", view: { kind: "owner", channel: "web" }, model: "small", text: "hi" }))
				.ok,
		);
		assert.deepEqual(declared(requests().at(-1)!), [
			"current_time",
			"system_status",
			"web_search",
			"web_fetch",
			"run_it",
			"reminder_create",
		]);
		kev.up = true;
		// Background work never selects: it declares its read-only toolkits and Kev is not asked.
		const m = kev.requests.length;
		assert.ok(
			(await conv.turn({ scope: "iyye:bg:1", view: { kind: "background" }, model: "small", text: "look" })).ok,
		);
		assert.deepEqual(declared(requests().at(-1)!), ["current_time", "system_status", "web_search", "web_fetch"]);
		assert.equal(kev.requests.length, m);
		await conv.disposeAll();
	});
});
