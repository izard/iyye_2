// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Plan 0.004 T4 (with the parts of 0.003 K2 it needs): the decision client, journal and toolkit selection in shadow. */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DecisionClient, verdict } from "../src/decisions/client.ts";
import { decisionsReport } from "../src/decisions/report.ts";
import {
	selectionQuestions,
	TOOLKIT_SELECTION,
	ToolkitSelectionShadow,
	type TurnInfo,
} from "../src/decisions/toolkit-selection.ts";
import { createLocalModelRuntime } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { handleOwnerCommand, isKnownCommand } from "../src/kernel/commands.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import type { RouterProcess } from "../src/models/router.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { type IyyeTool, ToolBroker, type Toolkit, type ToolkitSummary } from "../src/tools/broker.ts";
import { CHECKPOINT, FakeKev } from "./fixtures/fake-kev-http.ts";
import { fakeRouterProcess, freePort, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";

const KITS: ToolkitSummary[] = [
	{ name: "core", description: "the time and your memory", effect: "read", tools: ["current_time: the current time"] },
	{
		name: "machine",
		description: "the state of the computer you run on",
		effect: "read",
		tools: ["system_status: free disk space"],
	},
	{
		name: "web",
		description: "the public web",
		effect: "read",
		tools: ["web_search: search the web", "web_fetch: read one page"],
	},
];

const rows = (db: Db) =>
	db.prepare("SELECT * FROM decisions ORDER BY created_at, rowid").all() as Record<string, unknown>[];

describe("decision client and journal", () => {
	const kev = new FakeKev();
	before(() => kev.start());
	after(() => kev.stop());
	beforeEach(() => {
		kev.answer = () => 0.5;
		kev.status = 200;
		kev.up = true;
		kev.delayMs = 0;
	});

	test("an answer is journaled with the exact state, its hash, the checkpoint and per-question verdicts", async () => {
		const db = openDb(":memory:");
		kev.answer = (id) => (id === "web" ? 0.82 : id === "machine" ? 0.12 : 0.45);
		const client = new DecisionClient({ db, service: kev.service });
		const d = await client.ask(TOOLKIT_SELECTION, {
			scope: "owner",
			subjectRef: "turn@t",
			state: { message: "weather in Kazan?" },
			questions: [
				{ id: "web", instructions: "web?" },
				{ id: "machine", instructions: "machine?" },
				{ id: "other", instructions: "other?" },
			],
		});
		assert.equal(d.status, "ok");
		assert.deepEqual(d.verdicts, { web: "yes", machine: "no", other: "abstain" });
		const [r] = rows(db);
		assert.equal(r!.role, "toolkit_selection");
		assert.equal(r!.mode, "shadow");
		assert.equal(r!.state_json, '{"message":"weather in Kazan?"}');
		assert.match(String(r!.state_hash), /^[0-9a-f]{64}$/);
		assert.equal(r!.checkpoint, CHECKPOINT.run);
		assert.equal(r!.temperature, 2.41);
		assert.equal(kev.requests.at(-1)!.questions.web!.type, "noul");
		client.recordOutcome(d.id, { used: ["web"] }, "tool_calls");
		assert.equal(rows(db)[0]!.outcome_source, "tool_calls");
	});

	test("malformed answers, HTTP errors and timeouts are errors; a service that is not up is skipped; nothing throws", async () => {
		const db = openDb(":memory:");
		const client = new DecisionClient({ db, service: kev.service, timeoutMs: 200 });
		const ask = () =>
			client.ask(TOOLKIT_SELECTION, {
				scope: null,
				subjectRef: null,
				state: "s",
				questions: [{ id: "q", instructions: "?" }],
			});
		kev.answer = () => 1.5;
		assert.match((await ask()).error!, /no valid answer for q/);
		kev.answer = () => "yes";
		assert.equal((await ask()).status, "error");
		kev.answer = () => 0.5;
		kev.status = 500;
		assert.match((await ask()).error!, /HTTP 500/);
		kev.status = 200;
		kev.delayMs = 500;
		assert.equal((await ask()).status, "error", "timeout");
		kev.delayMs = 0;
		kev.up = false;
		assert.equal((await ask()).status, "skipped");
		assert.deepEqual(
			rows(db).map((r) => r.status),
			["error", "error", "error", "error", "skipped"],
		);
	});

	test("the abstention band", () => {
		const band = { low: 0.3, high: 0.6 };
		assert.deepEqual(
			[0, 0.3, 0.31, 0.59, 0.6, 1].map((p) => verdict(p, band)),
			["no", "no", "abstain", "abstain", "yes", "yes"],
		);
	});
});

describe("toolkit selection, shadow", () => {
	const kev = new FakeKev();
	before(() => kev.start());
	after(() => kev.stop());

	test("one question per permitted toolkit except core, worded from its description and tools", () => {
		const qs = selectionQuestions(KITS);
		assert.deepEqual(
			qs.map((q) => q.id),
			["machine", "web"],
		);
		assert.match(
			qs[1]!.instructions,
			/does the assistant need the public web, that is: search the web; read one page\?$/,
		);
		assert.deepEqual(selectionQuestions([KITS[0]!]), []);
	});

	test("asked after the turn, only when the device is free and no chat waits; the outcome is the toolkits actually called", async () => {
		const db = openDb(":memory:");
		const device = new DeviceSlot();
		let chat = true;
		kev.answer = (id) => (id === "web" ? 0.9 : 0.1);
		const shadow = new ToolkitSelectionShadow({
			db,
			client: new DecisionClient({ db, service: kev.service }),
			device,
			chatPending: () => chat,
			log: silentLogger,
		});
		const turn: TurnInfo = {
			scope: "owner",
			principal: "owner",
			text: "what is the weather in Kazan?",
			toolkits: KITS,
			startedAt: "2026-10-03T10:00:00.000Z",
			endedAt: "2026-10-03T10:00:30.000Z",
			ok: true,
		};
		for (const [tool, toolkit, at] of [
			["web_search", "web", "2026-10-03T10:00:05.000Z"],
			["web_fetch", "web", "2026-10-03T10:00:10.000Z"],
			["system_status", "machine", "2026-10-03T09:59:00.000Z"], // before the turn: not this turn's
		]) {
			db.prepare(
				"INSERT INTO tool_calls (id, scope, principal, tool, toolkit, args_json, outcome, result, started_at, finished_at) VALUES (?, 'owner', 'owner', ?, ?, '{}', 'ok', '', ?, ?)",
			).run(`${tool}-${at}`, tool, toolkit, at, at);
		}
		shadow.observe(turn);
		shadow.observe({ ...turn, ok: false }); // a failed turn is not asked
		shadow.observe({ ...turn, toolkits: [KITS[0]!] }); // only core: nothing to ask
		assert.equal(shadow.pending, 1);
		assert.equal(await shadow.drainOnce(), 0, "a chat is waiting");
		chat = false;
		const release = device.tryAcquire("chat:job")!;
		assert.equal(await shadow.drainOnce(), 0, "the device is busy");
		release();
		assert.equal(await shadow.drainOnce(), 1);
		assert.equal(device.holder, null);
		const [r] = rows(db);
		assert.equal(r!.subject_ref, "turn@2026-10-03T10:00:00.000Z");
		assert.equal(
			r!.state_json,
			JSON.stringify({ message: "what is the weather in Kazan?" }),
			"only the pre-decision state",
		);
		assert.deepEqual(JSON.parse(String(r!.outcome_json)), {
			used: ["web"],
			toolkits: {
				machine: { p: 0.1, verdict: "no", used: false },
				web: { p: 0.9, verdict: "yes", used: true },
			},
		});
	});

	test("/decisions reports per-toolkit agreement and what acting on it would cost", async () => {
		const db = openDb(":memory:");
		const client = new DecisionClient({ db, service: kev.service });
		const record = async (msg: string, p: Record<string, number>, used: string[], at: string) => {
			kev.answer = (id) => p[id] ?? 0;
			const shadowDb = db;
			const d = await new DecisionClient({ db: shadowDb, service: kev.service, now: () => new Date(at) }).ask(
				TOOLKIT_SELECTION,
				{
					scope: "owner",
					subjectRef: null,
					state: { message: msg },
					questions: selectionQuestions(KITS),
				},
			);
			client.recordOutcome(
				d.id,
				{
					used,
					toolkits: Object.fromEntries(
						Object.keys(p).map((k) => [k, { p: p[k], verdict: d.verdicts[k], used: used.includes(k) }]),
					),
				},
				"tool_calls",
			);
		};
		await record("weather?", { machine: 0.1, web: 0.9 }, ["web"], "2026-10-03T10:00:00Z");
		await record("disk space?", { machine: 0.2, web: 0.1 }, ["machine"], "2026-10-03T10:05:00Z"); // a miss
		await record("hello", { machine: 0.1, web: 0.45 }, [], "2026-10-03T10:10:00Z"); // unsure web: extra
		const report = decisionsReport(db, { state: "up", detail: "kev" }, 2);
		assert.match(report, /^decision service: up: kev\nmode: shadow \(nothing acts on these answers\)/);
		assert.match(report, /toolkit_selection: 3 asked · 3 ok · 0 errors · 0 skipped/);
		assert.match(report, /machine: 3 turns · used 1 · needed&used 0 · missed 1 · extra 0 · unsure 0 · recall 0%/);
		assert.match(report, /web: 3 turns · used 1 · needed&used 1 · missed 0 · extra 1 · unsure 1 · recall 100%/);
		assert.match(
			report,
			/if it acted \(sticky, add-only per conversation and day\): 1 tool-list change\(s\).*, 1 turn\(s\) missing a needed toolkit/,
		);
		assert.match(report, /recent misses:\n {2}2026-10-03 10:05 machine p=0\.20: disk space\?/);
		assert.match(report, /2 turn\(s\) waiting to be asked/);
		assert.ok(isKnownCommand("/decisions"));
		const ctx = { models: {} as never, db, issuer: "owner_web", decisionsReport: () => report };
		assert.equal((await handleOwnerCommand("/decisions", ctx)).reply, report);
	});
});

describe("shadow cannot change a turn", () => {
	const sb: Sandbox = sandbox();
	const kev = new FakeKev();
	let router: RouterProcess;
	let runtime: ModelRuntime;
	const requestsFile = join(sb.stateDir, "fake-router-requests.jsonl");
	const declared = () =>
		existsSync(requestsFile)
			? readFileSync(requestsFile, "utf8")
					.trim()
					.split("\n")
					.map((l) =>
						(JSON.parse(l) as { tools?: { function: { name: string } }[] }).tools?.map((t) => t.function.name),
					)
			: [];

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
		summary: name,
		parameters: Type.Object({}),
		run: async () => `${name} ok`,
	});
	const kits = (): Toolkit[] => [
		{ name: "core", description: "basics", effect: "read", tools: [tool("current_time")] },
		{ name: "machine", description: "this computer", effect: "read", tools: [tool("system_status")] },
		{ name: "web", description: "the web", effect: "read", tools: [tool("web_search")] },
	];

	test("whatever the model answers (always yes, always no), the declared tools are the same, and outcomes are joined", async () => {
		const runs: (string[] | undefined)[][] = [];
		for (const answer of [1, 0, null]) {
			rmSync(requestsFile, { force: true });
			const db = openDb(":memory:");
			kev.answer = () => answer ?? 0.5;
			const shadow =
				answer === null
					? null
					: new ToolkitSelectionShadow({
							db,
							client: new DecisionClient({ db, service: kev.service }),
							device: new DeviceSlot(),
							chatPending: () => false,
							log: silentLogger,
						});
			const conv = new PiConversations({
				db,
				runtime,
				stateDir: sb.stateDir,
				identity: "You are Iyye.",
				log: silentLogger,
				tools: new ToolBroker({ db, log: silentLogger, toolkits: kits() }),
				afterTurn: shadow ? (t) => shadow.observe(t) : null,
			});
			const scope = `owner-shadow-${answer}`;
			for (const text of ["[[tool:system_status]]", "hello", "[[tool:web_search]]"]) {
				const r = await conv.turn({ scope, view: { kind: "owner", channel: "web" }, model: "small", text });
				assert.ok(r.ok);
				await shadow?.drainOnce();
			}
			runs.push(declared());
			if (shadow) {
				const outcomes = rows(db).map((r) => (JSON.parse(String(r.outcome_json)) as { used: string[] }).used);
				assert.deepEqual(outcomes, [["machine"], [], ["web"]], "outcome = toolkits the model actually called");
			}
			await conv.disposeAll();
		}
		assert.deepEqual(runs[0], runs[1], "always-yes and always-no declare the same tools");
		assert.deepEqual(runs[0], runs[2], "and the same as no shadow at all");
		assert.ok(
			runs[0]!.every(
				(names) => JSON.stringify(names) === JSON.stringify(["current_time", "system_status", "web_search"]),
			),
		);
	});
});
