// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** The `thinking_need` shadow role (2026-11-14): would Kev have asked the thinking model, beside whether the chat model did. */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { DecisionClient } from "../src/decisions/client.ts";
import { labelDecision, labelQueue } from "../src/decisions/labels.ts";
import { decisionsReport, roleReport } from "../src/decisions/report.ts";
import { ASKS_QUESTION, NEED_QUESTION, THINKING_NEED, ThinkingNeedShadow } from "../src/decisions/thinking-need.ts";
import { ALWAYS_ON, type TurnInfo } from "../src/decisions/toolkit-selection.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import { type Db, openDb } from "../src/state/db.ts";
import type { ToolkitSummary } from "../src/tools/broker.ts";
import { ASK_THINKING_TOOL, THINKING_TOOLKIT } from "../src/tools/thinking.ts";
import { FakeKev } from "./fixtures/fake-kev-http.ts";

const CORE: ToolkitSummary = {
	name: "core",
	description: "the time and your memory",
	effect: "read",
	tools: ["current_time: the current time"],
};
const THINKING: ToolkitSummary = {
	name: THINKING_TOOLKIT,
	description: "a stronger reasoning model on mbp for hard questions",
	effect: "act",
	tools: [`${ASK_THINKING_TOOL}: a careful answer from the reasoning model on mbp`],
};

const rows = (db: Db) =>
	db.prepare("SELECT * FROM decisions ORDER BY created_at, rowid").all() as Record<string, string | null>[];

function turn(text: string, at: string, more: Partial<TurnInfo> = {}): TurnInfo {
	const end = new Date(new Date(at).getTime() + 30_000).toISOString();
	return {
		scope: "owner",
		principal: "owner",
		text,
		toolkits: [CORE, THINKING],
		startedAt: at,
		endedAt: end,
		ok: true,
		...more,
	};
}

/** One question to the thinking model, as the broker records it. */
function asked(db: Db, at: string, result: string, scope = "owner"): void {
	db.prepare(
		"INSERT INTO tool_calls (id, scope, principal, tool, toolkit, args_json, outcome, result, started_at, finished_at) VALUES (?, ?, 'owner', ?, ?, '{}', 'ok', ?, ?, ?)",
	).run(`${scope}-${at}`, scope, ASK_THINKING_TOOL, THINKING_TOOLKIT, result, at, at);
}

describe("thinking need (shadow)", () => {
	const kev = new FakeKev();
	before(() => kev.start());
	after(() => kev.stop());
	beforeEach(() => {
		kev.answer = () => 0.5;
		kev.up = true;
		kev.requests.length = 0;
	});

	function make(db: Db, state: { chat: boolean } = { chat: false }) {
		const device = new DeviceSlot();
		let tick = 0;
		const client = new DecisionClient({
			db,
			service: kev.service,
			now: () => new Date(Date.parse("2026-11-14T12:00:00Z") + 1000 * tick++),
		});
		const shadow = new ThinkingNeedShadow({
			db,
			client,
			device,
			chatPending: () => state.chat,
			ready: () => kev.up,
			log: silentLogger,
		});
		return { device, shadow };
	}

	test("the toolkit stays always declared: the role never decides what a session is offered", () => {
		assert.ok(ALWAYS_ON.includes(THINKING_TOOLKIT));
		assert.equal(THINKING_NEED.mode ?? "shadow", "shadow");
	});

	test("a turn with the thinking model on offer is asked afterwards, when Kev is up, no chat waits and the device is free", async () => {
		const db = openDb(":memory:");
		const state = { chat: true };
		const { device, shadow } = make(db, state);
		kev.answer = (id) => (id === NEED_QUESTION.id ? 0.7 : 0.2);
		const t = turn("Three people check into a hotel room that costs 30…", "2026-11-14T10:00:00.000Z");
		asked(db, "2026-11-14T09:59:00.000Z", "The thinking model answered after 90 s: 4"); // before the turn: not its call
		asked(db, "2026-11-14T10:00:05.000Z", "The thinking model on mbp is not available now (mbp is unreachable)");
		asked(db, "2026-11-14T10:00:08.000Z", "The thinking model answered after 200 s: nobody lost a dollar");
		asked(db, "2026-11-14T10:00:09.000Z", "The thinking model answered after 3 s: x", "contact:c1"); // another scope

		assert.equal(shadow.observe(t), undefined, "shadow: nothing comes back");
		shadow.observe({ ...t, ok: false }); // a failed turn is not asked
		shadow.observe({ ...t, toolkits: [CORE] }); // the tool was not on offer (an untrusted contact)
		shadow.observe({ ...t, text: "  " }); // nothing to judge
		assert.equal(shadow.pending, 1);

		assert.equal(await shadow.drainOnce(), 0, "a chat is waiting");
		state.chat = false;
		kev.up = false;
		assert.equal(await shadow.drainOnce(), 0, "Kev is not up: the turn waits, it is not journaled as skipped");
		assert.equal(rows(db).length, 0);
		kev.up = true;
		const release = device.tryAcquire("chat:job")!;
		assert.equal(await shadow.drainOnce(), 0, "the device is busy");
		release();
		assert.equal(await shadow.drainOnce(), 1);
		assert.equal(device.holder, null);
		assert.equal(shadow.pending, 0);

		const [r] = rows(db);
		assert.equal(r!.role, "thinking_need");
		assert.equal(r!.mode, "shadow");
		assert.equal(r!.scope, "owner");
		assert.equal(r!.subject_ref, "turn@2026-11-14T10:00:00.000Z");
		assert.equal(r!.state_json, JSON.stringify({ message: t.text }), "only the pre-decision state");
		assert.deepEqual(
			(JSON.parse(r!.questions_json!) as { id: string }[]).map((q) => q.id),
			[NEED_QUESTION.id, ASKS_QUESTION.id],
		);
		assert.deepEqual(JSON.parse(r!.verdicts_json!), { [NEED_QUESTION.id]: "yes", [ASKS_QUESTION.id]: "no" });
		assert.deepEqual(JSON.parse(r!.outcome_json!), { called: true, calls: 2, answered: 1, away: false });
		assert.equal(r!.outcome_source, "tool_calls");
		assert.equal(r!.label_strength, "weak");
		// Kev was sent the message and the two questions, nothing else.
		assert.deepEqual(kev.requests.at(-1)!.state, { message: t.text });
		assert.deepEqual(Object.keys(kev.requests.at(-1)!.questions), [NEED_QUESTION.id, ASKS_QUESTION.id]);
	});

	test("whatever Kev answers, only the decision journal changes (§15 #16)", async () => {
		for (const p of [0.01, 0.99]) {
			const db = openDb(":memory:");
			const { shadow } = make(db);
			kev.answer = () => p;
			const tables = (
				db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
					name: string;
				}[]
			)
				.map((t) => t.name)
				.filter((n) => n !== "decisions" && !n.includes("fts"));
			const counts = () =>
				Object.fromEntries(
					tables.map((n) => [n, (db.prepare(`SELECT count(*) AS n FROM "${n}"`).get() as { n: number }).n]),
				);
			const beforeCounts = counts();
			shadow.observe(turn("what is 2 + 2?", "2026-11-14T10:00:00.000Z"));
			assert.equal(await shadow.drainOnce(), 1);
			assert.deepEqual(counts(), beforeCounts);
			assert.equal(rows(db).length, 1);
			assert.deepEqual(JSON.parse(rows(db)[0]!.outcome_json!), {
				called: false,
				calls: 0,
				answered: 0,
				away: false,
			});
		}
	});

	test("/forget: a queued turn of the forgotten scope is never asked", async () => {
		const db = openDb(":memory:");
		const { shadow } = make(db);
		shadow.observe(turn("prove it", "2026-11-14T10:00:00.000Z", { scope: "contact:c1", principal: "contact" }));
		shadow.observe(turn("and this", "2026-11-14T10:01:00.000Z"));
		shadow.forgetScopes(["contact:c1"]);
		assert.equal(await shadow.drainOnce(), 1);
		assert.deepEqual(
			rows(db).map((r) => r.scope),
			["owner"],
		);
	});

	test("the owner's label is kept beside the record of what the chat model did, and the queue offers the role", async () => {
		const db = openDb(":memory:");
		const { shadow } = make(db);
		kev.answer = () => 0.9; // Kev: needed; the chat model did not ask → they disagree
		shadow.observe(turn("compare Mamba with a transformer, carefully", "2026-11-14T10:00:00.000Z"));
		await shadow.drainOnce();
		kev.answer = () => 0.1;
		shadow.observe(turn("thanks!", "2026-11-14T10:05:00.000Z"));
		await shadow.drainOnce();
		const [hard, easy] = rows(db);

		const q = labelQueue(db, { n: 5, daily: 15, now: new Date("2026-11-14T13:00:00Z") });
		assert.deepEqual(
			q.items.map((i) => [i.role, i.question, i.via, i.instructions]),
			[
				["thinking_need", NEED_QUESTION.id, "disagree", NEED_QUESTION.instructions],
				["thinking_need", NEED_QUESTION.id, "random", NEED_QUESTION.instructions],
			],
			"one owner question a turn, the hard case first; the second wording is Kev's only",
		);

		assert.equal(
			labelDecision(db, [hard!.id!.slice(0, 8), "yes"], "owner_web", "2026-11-14T13:01:00Z"),
			`labelled ${hard!.id!.slice(0, 8)} (thinking_need): the message needed the thinking model`,
		);
		assert.match(
			labelDecision(db, [easy!.id!.slice(0, 8), ASKS_QUESTION.id, "no"], "owner_web", "t"),
			/was not asked "asks_for_careful_answer"; its questions: needs_thinking_model/,
		);
		const after = rows(db)[0]!;
		assert.deepEqual(
			JSON.parse(after.outcome_json!),
			{ called: false, calls: 0, answered: 0, away: false },
			"what happened stays",
		);
		assert.equal(after.label_strength, "weak");
		assert.deepEqual(db.prepare("SELECT decision_id, question, value, via FROM decision_labels").all(), [
			{ decision_id: hard!.id, question: NEED_QUESTION.id, value: 1, via: "disagree" },
		]);
	});

	test("a turn told the thinking model was away is no judgement of the chat model's: marked, and left out of that comparison", async () => {
		const db = openDb(":memory:");
		const { shadow } = make(db);
		kev.answer = () => 0.9;
		shadow.observe(
			turn("prove there are infinitely many primes", "2026-11-14T10:00:00.000Z", { noted: ["thinking"] }),
		);
		shadow.observe(turn("and that the square root of 2 is irrational", "2026-11-14T10:05:00.000Z", { noted: [] }));
		assert.equal(await shadow.drainOnce(), 2);
		const [told, free] = rows(db);
		assert.deepEqual(JSON.parse(told!.outcome_json!), { called: false, calls: 0, answered: 0, away: true });
		assert.deepEqual(JSON.parse(free!.outcome_json!), { called: false, calls: 0, answered: 0, away: false });

		// Kev said yes and nothing was asked in both; only the turn that had the choice is a disagreement.
		const q = labelQueue(db, { n: 5, daily: 15, now: new Date("2026-11-14T13:00:00Z") });
		assert.deepEqual(
			q.items.map((i) => [i.id, i.via]),
			[
				[free!.id, "disagree"],
				[told!.id, "random"],
			],
		);
		labelDecision(db, [told!.id!, "yes"], "owner_web", "t");
		const report = decisionsReport(db, { state: "up", detail: "kev" });
		assert.match(
			report,
			/ {2}1 turns with the thinking model on offer: the chat model asked it in 0 \(and 1 more while it could not be reached: the chat model was told, so they are not compared with it\)\n/,
		);
		assert.match(report, / {2}your labels: 1 \(needed in 1\); the chat model's choice agrees on 0 of 0\n/);
		assert.match(report, / {2}needs_thinking_model: 1 yes · 0 unsure · 0 no;/);
		assert.match(
			report,
			/ {4}against your labels: agrees on 1 of 1 it decided \(0 unsure\)\n/,
			"Kev is still scored on it",
		);
		assert.match(report, new RegExp(`yes, the thinking model not asked:\\n {4}${free!.id!.slice(0, 8)} `));
		assert.doesNotMatch(report, new RegExp(`${told!.id!.slice(0, 8)} p=`), "not listed as the chat model's miss");
	});

	test("/decisions scores Kev's two wordings and the chat model's own choice, the latter two on the owner's labels", async () => {
		const db = openDb(":memory:");
		const { shadow } = make(db);
		const record = async (text: string, at: string, need: number, asks: number, call: boolean) => {
			kev.answer = (id) => (id === NEED_QUESTION.id ? need : asks);
			if (call) asked(db, at.replace(":00.000Z", ":05.000Z"), "The thinking model answered after 60 s: ok");
			shadow.observe(turn(text, at));
			await shadow.drainOnce();
			return rows(db).at(-1)!.id!;
		};
		const a = await record("a riddle about three doors", "2026-11-14T10:00:00.000Z", 0.8, 0.7, true);
		const b = await record("explain KAN versus MLP in depth", "2026-11-14T10:10:00.000Z", 0.7, 0.9, false);
		await record("good morning", "2026-11-14T10:20:00.000Z", 0.1, 0.1, false);
		const d = await record("ask the thinking model what day it is", "2026-11-14T10:30:00.000Z", 0.2, 0.45, true);
		shadow.observe(turn("still waiting", "2026-11-14T10:40:00.000Z"));
		labelDecision(db, [a, "yes"], "owner_web", "t");
		labelDecision(db, [b, "yes"], "owner_web", "t");
		labelDecision(db, [d, "no"], "owner_web", "t");

		const report = decisionsReport(db, { state: "up", detail: "kev" }, 0, 0, shadow.pending);
		assert.match(report, /mode: shadow \(nothing acts on these answers\)/);
		assert.match(report, /thinking_need: 4 asked · 4 ok · 0 errors · 0 skipped/);
		assert.match(report, / {2}4 turns with the thinking model on offer: the chat model asked it in 2\n/);
		assert.match(report, / {2}your labels: 3 \(needed in 2\); the chat model's choice agrees on 1 of 3\n/);
		assert.match(
			report,
			/ {2}needs_thinking_model: 2 yes · 0 unsure · 2 no; mean p 0\.50 where asked, 0\.40 where not\n {4}yes where it was not asked 1 · no where it was asked 1 · best threshold p ≥ 0\.20 → 3\/4 agree with the chat model's own choice/,
		);
		assert.match(report, / {4}against your labels: agrees on 3 of 3 it decided \(0 unsure\)\n/);
		assert.match(
			report,
			/ {2}asks_for_careful_answer: 2 yes · 1 unsure · 1 no; mean p 0\.57 where asked, 0\.50 where not\n.*\n {4}against your labels: agrees on 2 of 2 it decided \(1 unsure\)/,
		);
		assert.match(
			report,
			new RegExp(
				` {2}needs_thinking_model yes, the thinking model not asked:\\n {4}${b.slice(0, 8)} p=0\\.70 \\(labelled\\): \\{"message":"explain KAN versus MLP in depth"\\}`,
			),
		);
		assert.match(
			report,
			new RegExp(
				` {2}needs_thinking_model no, the thinking model asked:\\n {4}${d.slice(0, 8)} p=0\\.20 \\(labelled\\)`,
			),
		);
		assert.match(report, / {2}1 turn\(s\) waiting to be asked/);
		assert.match(report, /your labels \(yes · no · skipped;.*\n {2}thinking_need needs_thinking_model: 2 · 1 · 0/);

		const role = roleReport(db, "thinking_need");
		assert.match(
			role,
			/^thinking_need \(schema 1, unsure between 0\.3 and 0\.6; shadow — the chat model decides for itself/,
		);
		assert.match(
			role,
			/needs_thinking_model=0\.80 yes, asks_for_careful_answer=0\.70 yes → \{"called":true,"calls":1,"answered":1,"away":false\}/,
		);
	});
});
