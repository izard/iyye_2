// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.017 N1: owner labels per question, and the daily labelling queue.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { labelCountLines, labelDecision, labelQueue, localDay, queueReport } from "../src/decisions/labels.ts";
import { decisionsReport } from "../src/decisions/report.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { addTombstone } from "../src/state/tombstones.ts";

const NOW = new Date(2026, 9, 27, 10, 0, 0);
const LATER = new Date(2026, 9, 27, 18, 0, 0);
const TOMORROW = new Date(2026, 9, 28, 9, 0, 0);

let seq = 0;
function decision(
	db: Db,
	o: {
		role: string;
		scope?: string;
		schema?: number;
		status?: string;
		state?: unknown;
		questions: string[];
		verdicts?: Record<string, string>;
		outcome?: unknown;
		strength?: "weak" | "owner";
		at?: string;
	},
): string {
	seq++;
	const id = `${seq.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
	const state = JSON.stringify(o.state ?? `message ${seq}`);
	db.prepare(
		`INSERT INTO decisions (id, role, schema_version, mode, scope, subject_ref, state_json, state_hash, questions_json,
			status, verdicts_json, created_at, outcome_json, outcome_source, label_strength)
		 VALUES (?, ?, ?, 'shadow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		o.role,
		o.schema ?? 1,
		o.scope ?? "owner",
		`s${seq}`,
		state,
		`h-${state}`,
		JSON.stringify(o.questions.map((q) => ({ id: q, instructions: `Does it ${q}?` }))),
		o.status ?? "ok",
		JSON.stringify(o.verdicts ?? Object.fromEntries(o.questions.map((q) => [q, "no"]))),
		o.at ?? `2026-10-20T10:${String(seq % 60).padStart(2, "0")}:00.000Z`,
		o.outcome === undefined ? null : JSON.stringify(o.outcome),
		o.outcome === undefined ? null : "test",
		o.outcome === undefined ? null : (o.strength ?? "weak"),
	);
	return id;
}

const salience = (db: Db, o: Partial<Parameters<typeof decision>[1]> = {}) =>
	decision(db, { role: "memory_salience", questions: ["worth_remembering"], ...o });

test("the migration carries every owner label over, one row per answered question", () => {
	const db = openDb(":memory:");
	const a = salience(db, { outcome: { worth_remembering: true }, strength: "owner" });
	const b = decision(db, {
		role: "fact_relation",
		questions: ["same_fact", "contradicts", "refines"],
		outcome: { same_fact: false, contradicts: true, refines: false },
		strength: "owner",
	});
	salience(db, { outcome: { worth_remembering: false, transfer: "completed_empty" } }); // weak: not a label
	db.exec("DELETE FROM decision_labels");
	const sql = readFileSync(new URL("../src/state/migrations/043_decision_labels.sql", import.meta.url), "utf8");
	db.exec(sql.slice(sql.indexOf("INSERT INTO decision_labels")));
	assert.deepEqual(
		db.prepare("SELECT decision_id, question, value, via FROM decision_labels ORDER BY decision_id, question").all(),
		[
			{ decision_id: a, question: "worth_remembering", value: 1, via: "direct" },
			{ decision_id: b, question: "contradicts", value: 1, via: "direct" },
			{ decision_id: b, question: "refines", value: 0, via: "direct" },
			{ decision_id: b, question: "same_fact", value: 0, via: "direct" },
		],
	);
	db.close();
});

test("the queue offers only owner and iyye decisions that answered, never Kev's answer, at most the daily allowance", () => {
	const db = openDb(":memory:");
	for (let i = 0; i < 6; i++) salience(db);
	salience(db, { scope: "contact:c1" });
	salience(db, { scope: "owner-console" });
	salience(db, { status: "error" });
	decision(db, { role: "observation_importance", scope: "iyye", questions: ["worth_telling"] });
	decision(db, { role: "voice_meaning", questions: ["same_meaning"] });
	const q = labelQueue(db, { n: 20, daily: 5, now: NOW });
	assert.equal(q.items.length, 5);
	assert.equal(q.offeredToday, 5);
	for (const it of q.items) {
		const scope = (db.prepare("SELECT scope FROM decisions WHERE id = ?").get(it.id) as { scope: string }).scope;
		assert.ok(["owner", "iyye"].includes(scope));
	}
	assert.ok(
		q.items.some((it) => it.role === "observation_importance"),
		"roles take turns: the small one is not crowded out",
	);
	const shown = queueReport(db, 20, 5, NOW);
	assert.doesNotMatch(shown, /p=|0\.\d\d/, "Kev's answer is never shown");
	assert.match(shown, /question: Does it worth_remembering\?/);
	assert.match(shown, /answer: \/decisions label [0-9a-f]{8} yes\|no\|skip/);
	// Asked again the same day: the same questions, nothing new beyond the allowance.
	assert.deepEqual(
		labelQueue(db, { n: 20, daily: 5, now: LATER }).items.map((i) => i.id),
		q.items.map((i) => i.id),
	);
	assert.match(queueReport(db, 20, 5, LATER), /0 of 5 offered today answered/);
	db.close();
});

test("tiers: unsure first, then disagreement with the weak label, and always a random share; the label keeps its tier", () => {
	const db = openDb(":memory:");
	const unsure = [1, 2, 3, 4].map(() => salience(db, { verdicts: { worth_remembering: "abstain" } }));
	const disagree = salience(db, { verdicts: { worth_remembering: "yes" }, outcome: { worth_remembering: false } });
	const agree = salience(db, { verdicts: { worth_remembering: "yes" }, outcome: { worth_remembering: true } });
	const plain = [1, 2, 3].map(() => salience(db));
	const items = labelQueue(db, { n: 6, daily: 6, now: NOW }).items;
	const via = Object.fromEntries(items.map((i) => [i.id, i.via]));
	assert.equal(items.length, 6);
	assert.equal(items.filter((i) => i.via === "random").length, 2, "a third at random");
	assert.equal(items.filter((i) => i.via === "uncertain").length, 4);
	assert.ok(unsure.every((id) => via[id] === "uncertain" || via[id] === "random"));
	assert.ok(!(disagree in via) || via[disagree] === "random", "all four unsure come first");
	void agree;
	void plain;
	const id = items.find((i) => i.via === "uncertain")!.id;
	assert.match(labelDecision(db, [id.slice(0, 8), "yes"], "owner_web", NOW.toISOString()), /worth remembering/);
	assert.deepEqual(db.prepare("SELECT value, via FROM decision_labels WHERE decision_id = ?").get(id), {
		value: 1,
		via: "uncertain",
	});
	// A label given outside the queue is `direct`.
	const other = plain.find((p) => !(p in via)) ?? agree;
	labelDecision(db, [other.slice(0, 8), "no"], "owner_web", NOW.toISOString());
	assert.equal(
		(db.prepare("SELECT via FROM decision_labels WHERE decision_id = ?").get(other) as { via: string }).via,
		"direct",
	);

	// The next day: the disagreement leads among what is left.
	const db2 = openDb(":memory:");
	salience(db2);
	salience(db2);
	const d2 = salience(db2, { verdicts: { worth_remembering: "no" }, outcome: { worth_remembering: true } });
	const tomorrow = labelQueue(db2, { n: 3, daily: 3, now: TOMORROW }).items;
	assert.equal(tomorrow.find((i) => i.id === d2)?.via, "disagree");
	db.close();
	db2.close();
});

test("an unused toolkit is not a 'no': only Kev's no for a used toolkit is a disagreement", () => {
	const db = openDb(":memory:");
	const used = decision(db, {
		role: "toolkit_selection",
		schema: 2,
		state: { message: "what's on the disk?" },
		questions: ["machine", "web"],
		verdicts: { machine: "no", web: "no" },
		outcome: { used: ["machine"] },
	});
	const items = labelQueue(db, { n: 3, daily: 3, now: NOW }).items;
	assert.deepEqual(items.map((i) => [i.id, i.question, i.via]).sort(), [
		[used, "machine", "disagree"],
		[used, "web", "random"],
	]);
	// Per toolkit: the question must be named when there is more than one.
	assert.match(labelDecision(db, [used.slice(0, 8), "yes"], "owner_web", "t"), /which toolkit\?/);
	assert.match(
		labelDecision(db, [used.slice(0, 8), "machine", "yes"], "owner_web", "t"),
		/needed the machine toolkit/,
	);
	assert.match(labelDecision(db, [used.slice(0, 8), "web", "no"], "owner_web", "t"), /did not need the web toolkit/);
	const row = db.prepare("SELECT outcome_json, label_strength FROM decisions WHERE id = ?").get(used) as {
		outcome_json: string;
		label_strength: string;
	};
	assert.deepEqual(
		[row.outcome_json, row.label_strength],
		['{"used":["machine"]}', "weak"],
		"the weak record of the tools used stays: the reports read it",
	);
	assert.match(queueReport(db, 5, 3, NOW), /0 of 0|That is all|Nothing left/);
	db.close();
});

test("reply review: claims by default, promises by name, both kept; skip leaves the queue but is no label", () => {
	const db = openDb(":memory:");
	const r = decision(db, {
		role: "reply_review",
		schema: 3,
		state: { message: "remind me", reply: "I will" },
		questions: ["promises_future_action", "claims_arranged", "admits_unknown"],
		outcome: { commitment_created: false, commitments: [] },
	});
	const shown = queueReport(db, 5, 5, NOW);
	assert.match(shown, /reply_review · claims_arranged/);
	assert.match(shown, /label [0-9a-f]{8} promises yes\|no\|skip/);
	assert.doesNotMatch(shown, /admits_unknown/, "only the owner questions");
	assert.match(labelDecision(db, [r.slice(0, 8), "yes"], "owner_web", "t"), /claimed something was set up/);
	assert.match(labelDecision(db, [r.slice(0, 8), "promises", "no"], "owner_web", "t"), /promised no future action/);
	assert.deepEqual(
		JSON.parse((db.prepare("SELECT outcome_json FROM decisions").get() as { outcome_json: string }).outcome_json),
		{ claims_arranged: true, promises_future_action: false },
		"a second label does not replace the first",
	);
	assert.match(labelDecision(db, [r.slice(0, 8), "claims", "skip"], "owner_web", "t"), /already labelled yes/);
	assert.match(labelDecision(db, [r.slice(0, 8), "dated_event", "yes"], "owner_web", "t"), /was not asked/);
	assert.match(labelDecision(db, [r.slice(0, 8), "maybe"], "owner_web", "t"), /usage/);

	const s = salience(db);
	assert.match(labelDecision(db, [s.slice(0, 8), "skip"], "owner_web", "t"), /skipped/);
	assert.equal(
		(db.prepare("SELECT label_strength FROM decisions WHERE id = ?").get(s) as { label_strength: null })
			.label_strength,
		null,
		"a skip is not an outcome",
	);
	assert.deepEqual(labelCountLines(db), [
		"your labels (yes · no · skipped; owner and iyye decisions train, contacts' do not):",
		"  memory_salience worth_remembering: 0 · 0 · 1",
		"  reply_review claims_arranged: 1 · 0 · 0",
		"  reply_review promises_future_action: 0 · 1 · 0",
	]);
	assert.match(decisionsReport(db, { state: "up", detail: "kev" }), /reply_review claims_arranged: 1 · 0 · 0/);
	db.close();
});

test("one message asked twice is offered once; a forgotten person's name keeps a row out; labels go with their decision", () => {
	const db = openDb(":memory:");
	const a = salience(db, { state: "lunch with Julia tomorrow" });
	salience(db, { state: "lunch with Julia tomorrow" });
	const b = salience(db, { state: "the boiler needs a check" });
	db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')").run();
	assert.deepEqual(new Set(labelQueue(db, { n: 5, daily: 5, now: NOW }).items.map((i) => i.id)), new Set([a, b]));
	addTombstone(db, "contact:c1", "2026-10-27T00:00:00Z", "owner");
	const db2 = openDb(":memory:");
	salience(db2, { state: "lunch with Julia tomorrow" });
	const kept = salience(db2, { state: "the boiler needs a check" });
	db2.prepare(
		"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')",
	).run();
	addTombstone(db2, "contact:c1", "2026-10-27T00:00:00Z", "owner");
	assert.deepEqual(
		labelQueue(db2, { n: 5, daily: 5, now: NOW }).items.map((i) => i.id),
		[kept],
	);
	labelDecision(db, [b.slice(0, 8), "no"], "owner_web", "t");
	db.prepare("DELETE FROM decisions WHERE id IN (?, ?)").run(a, b);
	assert.deepEqual(
		[
			db.prepare("SELECT count(*) AS n FROM decision_labels").get(),
			db.prepare("SELECT count(*) AS n FROM decision_label_offers").get(),
		],
		[{ n: 0 }, { n: 0 }],
	);
	db.close();
	db2.close();
});

test("the allowance's day is the local calendar day", () => {
	assert.equal(localDay(new Date(2026, 0, 2, 23, 59)), "2026-01-02");
	const db = openDb(":memory:");
	for (let i = 0; i < 4; i++) salience(db);
	assert.equal(labelQueue(db, { n: 9, daily: 2, now: NOW }).items.length, 2);
	assert.equal(labelQueue(db, { n: 9, daily: 2, now: TOMORROW }).offeredToday, 2, "a new day, a new allowance");
	assert.match(queueReport(db, 5, 0, NOW), /off/);
	db.close();
});
