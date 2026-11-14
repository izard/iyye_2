// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Plan 0.017 N2: decision datasets — exclusions, one example per message, whole-day time splits, the sealed test set, the frozen manifest. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	chooseTestSet,
	chooseValidationDays,
	DatasetRefused,
	datasetPolicy,
	datasetRecords,
	deleteDatasetFiles,
	describeDataset,
	freezeDataset,
	getDataset,
	labelCounts,
	manifestHash,
	planDataset,
	staleRows,
	type TestSetRow,
	testLooks,
	writeDataset,
} from "../src/decisions/dataset.ts";
import { localDay } from "../src/decisions/labels.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { addTombstone } from "../src/state/tombstones.ts";

/** A local time in November 2026 (local, so the tests do not depend on the machine's zone). */
const at = (day: number, hour = 12, minute = 0, second = 0) => new Date(2026, 10, day, hour, minute, second);
const day = (d: number) => localDay(at(d));
const POLICY = datasetPolicy({ testFraction: 0.25, testMinLabels: 4, validationFraction: 0.25, testLooks: 2 });

let seq = 0;
function dec(
	db: Db,
	o: {
		at: Date;
		role?: string;
		scope?: string;
		state?: unknown;
		questions?: string[];
		status?: string;
		ref?: string;
		outcome?: unknown;
		schema?: number;
	},
): string {
	seq++;
	const id = `${seq.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
	const state = JSON.stringify(o.state ?? `message number ${seq}`);
	const questions = o.questions ?? ["worth_remembering"];
	db.prepare(
		`INSERT INTO decisions (id, role, schema_version, mode, scope, subject_ref, state_json, state_hash, questions_json,
			status, answers_json, verdicts_json, created_at, outcome_json, outcome_source, label_strength)
		 VALUES (?, ?, ?, 'shadow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		o.role ?? "memory_salience",
		o.schema ?? 1,
		o.scope ?? "owner",
		o.ref ?? `s${seq}`,
		state,
		createHash("sha256").update(state).digest("hex"),
		JSON.stringify(questions.map((q) => ({ id: q, instructions: `Is it ${q}? (as asked in row ${seq})` }))),
		o.status ?? "ok",
		// What Kev answered: must never reach an exported example.
		JSON.stringify(Object.fromEntries(questions.map((q) => [q, { noul: 0.42, note: "KEV-ANSWER-LEAK" }]))),
		JSON.stringify(Object.fromEntries(questions.map((q) => [q, "abstain"]))),
		o.at.toISOString(),
		o.outcome === undefined ? null : JSON.stringify(o.outcome),
		o.outcome === undefined ? null : "test",
		o.outcome === undefined ? null : "weak",
	);
	return id;
}

function label(db: Db, id: string, question: string, value: boolean | null, via = "random"): void {
	db.prepare(
		`INSERT INTO decision_labels (decision_id, question, value, labelled_by, labelled_at, via) VALUES (?, ?, ?, 'owner_web', ?, ?)
		 ON CONFLICT (decision_id, question) DO UPDATE SET value = excluded.value`,
	).run(id, question, value === null ? null : value ? 1 : 0, at(28).toISOString(), via);
}

/** A labelled memory-salience example on a day. */
function labelled(db: Db, d: number, value: boolean, o: Partial<Parameters<typeof dec>[1]> = {}): string {
	const id = dec(db, { at: at(d), ...o });
	label(db, id, (o.questions ?? ["worth_remembering"])[0]!, value);
	return id;
}

/** Days 1..n, two owner labels each (one yes, one no). */
function fill(db: Db, days: number): string[][] {
	const ids: string[][] = [];
	for (let d = 1; d <= days; d++) ids.push([labelled(db, d, true), labelled(db, d, false)]);
	return ids;
}

const splitOf = (m: { rows: { id: string; split: string }[] }, id: string) => m.rows.find((r) => r.id === id)?.split;

test("the cut: owner and iyye decisions only, whole days in time order, the latest days the test set", () => {
	const db = openDb(":memory:");
	fill(db, 10);
	const contact = labelled(db, 10, true, { scope: "contact:c1" });
	labelled(db, 10, true, { scope: "owner-console" });
	labelled(db, 5, true, { role: "voice_meaning", questions: ["same"] }); // not one of the adapter's roles
	const iyye = labelled(db, 3, false, {
		role: "observation_importance",
		scope: "iyye",
		questions: ["worth_telling"],
		state: { domain: "machine", change: "disk fell to 12 GB" },
	});
	dec(db, { at: at(4) }); // answered, nobody labelled it
	const m = planDataset(db, { policy: POLICY, now: at(10, 20) });

	assert.equal(m.problem, null);
	// 21 owner labels; a quarter, at least 4: the latest days that hold 6 → days 8, 9, 10.
	assert.deepEqual(m.test_set, {
		id: "(not created)",
		from_day: day(8),
		to_day: day(10),
		looks: 0,
		origin: "new",
	});
	assert.equal(m.rows.length, 21);
	assert.ok(m.rows.every((r) => ["owner", "iyye"].includes(r.scope)));
	assert.ok(["train", "validation"].includes(splitOf(m, iyye)!));
	assert.equal(splitOf(m, contact), undefined);
	assert.deepEqual(m.excluded_counts, { scope: 2 });
	assert.deepEqual(m.excluded, [], "a contact's row is counted, never listed");
	assert.equal(m.unlabelled, 1);

	// A day is never split, and nothing trained or validated on is as late as the test.
	const byDay = new Map<string, Set<string>>();
	for (const r of m.rows) byDay.set(r.day, (byDay.get(r.day) ?? new Set()).add(r.split));
	assert.ok([...byDay.values()].every((s) => s.size === 1));
	const days = (s: string) => [...byDay].filter(([, v]) => v.has(s)).map(([d]) => d);
	assert.deepEqual(days("test").sort(), [day(8), day(9), day(10)]);
	assert.ok(days("validation").length >= 1 && days("train").length >= 1);
	assert.ok([...days("train"), ...days("validation")].every((d) => d < day(8)));
	assert.deepEqual(
		labelCounts(m).filter((c) => c.role === "memory_salience"),
		[
			{ role: "memory_salience", question: "worth_remembering", split: "train", yes: 5, no: 5, weak: 0 },
			{ role: "memory_salience", question: "worth_remembering", split: "validation", yes: 2, no: 2, weak: 0 },
			{ role: "memory_salience", question: "worth_remembering", split: "test", yes: 3, no: 3, weak: 0 },
		],
	);
	// The same records, the same cut: the hash is of the content.
	assert.equal(manifestHash(m), manifestHash(planDataset(db, { policy: POLICY, now: at(10, 20) })));
	db.close();
});

test("no future evidence in an input: the state as it was sent, the question as it was asked, the owner's label; nothing else", () => {
	const db = openDb(":memory:");
	fill(db, 8);
	const id = dec(db, {
		at: at(2),
		role: "reply_review",
		schema: 3,
		state: { message: "remind me at nine", reply: "I have set it." },
		questions: ["claims_arranged", "promises_future_action", "admits_unknown"],
		outcome: { commitment_created: false, note: "OUTCOME-LEAK" },
	});
	label(db, id, "claims_arranged", true, "disagree");
	const m = planDataset(db, { policy: POLICY, now: at(8, 20) });
	const records = datasetRecords(db, m, ["train", "validation"]);
	const rec = [...records.values()].flat().find((r) => r._meta.id === `iyye/${id}`)!;
	assert.deepEqual(rec, {
		state: { message: "remind me at nine", reply: "I have set it." },
		questions: {
			claims_arranged: {
				type: "noul",
				instructions: `Is it claims_arranged? (as asked in row ${seq})`,
				label: true,
			},
		},
		_meta: { id: `iyye/${id}`, source: "iyye_reply_review", group_id: `iyye/${day(2)}` },
	});
	const text = JSON.stringify([...records.values()]);
	assert.doesNotMatch(text, /LEAK|0\.42|verdict|abstain|outcome|commitment/);
	assert.equal(records.has("test"), false, "only the splits asked for");
	// In time order: every training and validation example is older than every test example.
	const t = m.test_set!;
	assert.ok(m.rows.filter((r) => r.split !== "test").every((r) => r.day < t.from_day));
	// The manifest holds ids, hashes, days and labels: never what anyone said.
	assert.doesNotMatch(JSON.stringify(m), /remind me|I have set it|message number/);
	assert.doesNotMatch(describeDataset(m), /remind me|I have set it|message number/);
	db.close();
});

test("one message is one example, on the day its words were first seen: the same text is never on both sides of a split", () => {
	const db = openDb(":memory:");
	fill(db, 10); // the test set is days 8–10
	// The same state on day 2 (nobody labelled it) and on day 9 (labelled): one example, of day 2.
	dec(db, { at: at(2), state: "what is the capital of Chuvashia?" });
	const again = labelled(db, 9, true, { state: "what is the capital of Chuvashia?" });
	// Labelled twice the same way on two days: merged into the earlier row.
	const first = labelled(db, 3, false, { state: "thanks" });
	const second = labelled(db, 9, false, { state: "thanks" });
	// One message in two roles: toolkit selection's turn began after midnight (day 9), the message itself
	// arrived just before it (day 8)… and the same words had been written on day 4.
	labelled(db, 4, true, { state: "  Compare Mamba   with a transformer " });
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('ev1', 'k1', 'web', 'owner', 'owner', ?, '{}', 'answered')",
	).run(at(8, 23, 59, 50).toISOString());
	const kit = dec(db, {
		at: at(9, 0, 0, 30),
		role: "toolkit_selection",
		schema: 2,
		ref: `turn@${at(9, 0, 0, 5).toISOString()}`,
		state: { message: "compare mamba with a transformer" },
		questions: ["web"],
	});
	label(db, kit, "web", true);
	// A night's salience question about a message of the evening before: the message's day, not the night's.
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('ev2', 'k2', 'web', 'owner', 'owner', ?, '{}', 'answered')",
	).run(at(7, 22).toISOString());
	const night = dec(db, { at: at(8, 0, 30), ref: "ev2", state: "we moved the meeting to Friday" });
	label(db, night, "worth_remembering", true);
	// A reply review goes back through its action to the message.
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at) VALUES ('ac1', 'ev2', 'reply', '{}', 'h', 'i1', 'delivered', ?)",
	).run(at(8, 0, 10).toISOString());
	const review = dec(db, {
		at: at(8, 0, 40),
		role: "reply_review",
		ref: "ac1",
		state: { message: "something else entirely", reply: "Noted." },
		questions: ["claims_arranged"],
	});
	label(db, review, "claims_arranged", false);

	const m = planDataset(db, { policy: POLICY, now: at(10, 20) });
	const row = (id: string) => m.rows.find((r) => r.id === id)!;
	// The night's and the review's examples belong to day 7, which makes day 7 the test set's first day.
	assert.equal(m.test_set!.from_day, day(7));
	assert.deepEqual([row(again).day, row(again).split === "test"], [day(2), false]);
	assert.deepEqual([row(first).day, row(first).merged], [day(3), [second]]);
	assert.equal(splitOf(m, second), undefined, "the repeat is not a second example");
	assert.deepEqual([row(kit).day, row(kit).split === "test"], [day(4), false], "another role, the same words");
	assert.deepEqual([row(night).day, row(review).day], [day(7), day(7)]);
	assert.deepEqual([row(night).split, row(review).split], ["test", "test"]);
	// Whatever the roles, no message text is in the test set and anywhere else.
	const text = (id: string) => {
		const s = JSON.parse(
			(db.prepare("SELECT state_json FROM decisions WHERE id = ?").get(id) as { state_json: string }).state_json,
		) as string | { message: string };
		return (typeof s === "string" ? s : s.message).toLowerCase().replace(/\s+/g, " ").trim();
	};
	const inTest = new Set(m.rows.filter((r) => r.split === "test").map((r) => text(r.id)));
	assert.ok(m.rows.filter((r) => r.split !== "test").every((r) => !inTest.has(text(r.id))));
	db.close();
});

test("a forgotten person's rows and mentions are left out, by id and reason, never by name; a dataset frozen before is refused afterwards", () => {
	const db = openDb(":memory:");
	fill(db, 10);
	db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')").run();
	const theirs = labelled(db, 4, true, { scope: "contact:c1", state: "I passed the exam!" });
	const mention = labelled(db, 4, true, { state: "Julia passed her exam today" });
	const other = labelled(db, 4, false, { state: "the boiler needs a check" });

	const before = freezeDataset(db, { policy: POLICY, now: at(10, 20), by: "test" });
	assert.ok(before.ok);
	assert.equal(splitOf(before.manifest, mention) !== undefined, true);
	assert.equal(splitOf(before.manifest, theirs), undefined, "a contact's own row never trains, forgotten or not");
	const dir = mkdtempSync(join(tmpdir(), "iyye-ds-"));
	assert.equal(writeDataset(db, before.id, dir).counts.train! > 0, true);

	// `/forget Julia`: her rows go, and the owner's rows that name her may no longer be used.
	db.prepare("DELETE FROM decisions WHERE scope = 'contact:c1'").run();
	addTombstone(db, "contact:c1", at(11).toISOString(), "owner");
	assert.deepEqual(staleRows(db, before.manifest), [mention]);
	assert.throws(
		() => writeDataset(db, before.id, dir),
		(e: Error) =>
			e instanceof DatasetRefused &&
			/holds 1 row\(s\) that were since removed or may no longer be used/.test(e.message),
	);

	const after = planDataset(db, { policy: POLICY, now: at(11) });
	assert.equal(splitOf(after, mention), undefined);
	assert.equal(splitOf(after, other) !== undefined, true);
	assert.deepEqual(after.excluded, [{ id: mention, reason: "names_forgotten_person" }]);
	assert.doesNotMatch(JSON.stringify(after), /julia/i);
	assert.match(describeDataset(after), /left out: 1 names a forgotten person/);
	assert.doesNotMatch(describeDataset(after), /julia/i);

	// A row deleted outright (a scope's rows) is stale too.
	db.prepare("DELETE FROM decision_labels WHERE decision_id = ?").run(other);
	db.prepare("DELETE FROM decisions WHERE id = ?").run(other);
	assert.deepEqual(staleRows(db, before.manifest).sort(), [mention, other].sort());
	rmSync(dir, { recursive: true, force: true });
	db.close();
});

test("weak and owner labels are kept apart: none by default; where the policy allows one, only in training, marked, never over the owner's", () => {
	const db = openDb(":memory:");
	fill(db, 10);
	const weakTrain = dec(db, { at: at(2), outcome: { worth_remembering: true, transfer: "completed" } });
	const weakTest = dec(db, { at: at(9), outcome: { worth_remembering: false, transfer: "completed_empty" } });
	const both = dec(db, { at: at(3), outcome: { worth_remembering: true } });
	label(db, both, "worth_remembering", false); // the owner disagrees with Hindsight: the owner's answer is the label
	const unsure = dec(db, { at: at(3), outcome: { worth_remembering: true } });
	label(db, unsure, "worth_remembering", null); // the owner could not tell: nothing decides it
	const kits = dec(db, {
		at: at(2),
		role: "toolkit_selection",
		schema: 2,
		state: { message: "what is the weather in Kazan?" },
		questions: ["machine", "web"],
		outcome: { used: ["web", "project"], kept_out: ["machine"] },
	});
	const review = dec(db, {
		at: at(2),
		role: "reply_review",
		state: { message: "remind me", reply: "Done." },
		questions: ["claims_arranged"],
		outcome: { commitment_created: true },
	});

	// No validation days here, so which days a hash picks cannot decide what this test sees.
	const policy = { ...POLICY, validationFraction: 0 };
	const none = planDataset(db, { policy, now: at(10, 20) });
	assert.ok(none.rows.every((r) => Object.values(r.questions).every((l) => l.strength === "owner")));
	for (const id of [weakTrain, weakTest, kits, review, unsure]) assert.equal(splitOf(none, id), undefined);

	const weak = planDataset(db, {
		policy: { ...policy, weak: ["memory_salience.transfer", "toolkit_selection.used"] },
		now: at(10, 20),
	});
	const row = (id: string) => weak.rows.find((r) => r.id === id);
	assert.deepEqual(row(weakTrain)!.questions, {
		worth_remembering: { label: true, strength: "weak", source: "memory_salience.transfer" },
	});
	assert.equal(row(weakTrain)!.split, "train");
	assert.equal(row(weakTest), undefined, "a weak label on a test day is not used at all");
	assert.deepEqual(row(both)!.questions.worth_remembering, {
		label: false,
		strength: "owner",
		source: "owner_web",
		via: "random",
	});
	assert.equal(row(unsure), undefined);
	// A used toolkit is a positive; an unused one is not a "no"; one that was never asked about is nothing.
	assert.deepEqual(row(kits)!.questions, { web: { label: true, strength: "weak", source: "toolkit_selection.used" } });
	assert.equal(row(review), undefined, "the ledger's fact is never a claims label");
	assert.ok(
		weak.rows
			.filter((r) => r.split !== "train")
			.every((r) => Object.values(r.questions).every((l) => l.strength === "owner")),
		"the test set is the owner's labels only",
	);
	assert.deepEqual(
		weak.excluded.filter((e) => e.reason === "weak_outside_training").map((e) => e.id),
		[weakTest],
	);
	const rec = datasetRecords(db, weak, ["train"])
		.get("train")!
		.find((r) => r._meta.id === `iyye/${kits}`)!;
	assert.deepEqual(rec._meta.weak, ["web"]);
	assert.equal(
		datasetRecords(db, weak, ["train"])
			.get("train")!
			.find((r) => r._meta.id === `iyye/${both}`)!._meta.weak,
		undefined,
	);
	db.close();
});

test("left out with a reason: not answered, clipped, labelled both ways, skipped; a question keeps the wording of the row that asked it", () => {
	const db = openDb(":memory:");
	fill(db, 10);
	const failed = labelled(db, 2, true, { status: "error" });
	const cut = labelled(db, 2, true, {
		role: "toolkit_selection",
		state: { message: "x".repeat(4000) },
		questions: ["web"],
	});
	const yes = labelled(db, 2, true, { state: "is this worth it?" });
	const no = labelled(db, 3, false, { state: "is this worth it?" });
	const skipped = dec(db, { at: at(2) });
	label(db, skipped, "worth_remembering", null);
	// The same message asked about different toolkits at different times: one example with both questions.
	const early = labelled(db, 2, false, {
		role: "toolkit_selection",
		state: { message: "how full is the disk?" },
		questions: ["machine"],
	});
	const late = dec(db, {
		at: at(3),
		role: "toolkit_selection",
		state: { message: "how full is the disk?" },
		questions: ["machine", "web"],
	});
	const lateSeq = seq;
	label(db, late, "web", false);
	const m = planDataset(db, { policy: POLICY, now: at(10, 20) });
	for (const id of [failed, cut, yes, no, skipped]) assert.equal(splitOf(m, id), undefined);
	assert.deepEqual(
		m.excluded.map((e) => [e.id, e.reason, e.question]).sort(),
		[
			[failed, "not_answered", undefined],
			[cut, "clipped", undefined],
			[yes, "conflicting_labels", "worth_remembering"],
			[no, "conflicting_labels", "worth_remembering"],
			[skipped, "owner_skipped", "worth_remembering"],
		].sort(),
	);
	const row = m.rows.find((r) => r.id === early)!;
	assert.deepEqual([row.merged, Object.keys(row.questions).sort()], [[late], ["machine", "web"]]);
	const rec = [...datasetRecords(db, m, ["train", "validation"]).values()]
		.flat()
		.find((r) => r._meta.id === `iyye/${early}`)!;
	assert.equal(rec.questions.web!.instructions, `Is it web? (as asked in row ${lateSeq})`);
	assert.match(
		describeDataset(m),
		/left out: 1 Kev did not answer it; 1 the message was cut at the host's limit; 1 you could not tell \(skipped\); 2 labelled both ways for the same state; 1 repeat\(s\) of a state merged/,
	);
	db.close();
});

test("the test set is sealed: its days stay test while it is active, later days are held, and its rows train only after it is retired", () => {
	const db = openDb(":memory:");
	const ids = fill(db, 10);
	const lateRow = dec(db, { at: at(9) }); // a test-day row nobody has labelled yet
	const a = freezeDataset(db, { policy: POLICY, now: at(10, 20), by: "session-1" });
	assert.ok(a.ok);
	const setA = a.manifest.test_set!;
	assert.deepEqual([setA.from_day, setA.to_day, setA.origin], [day(8), day(10), "new"]);
	const testA = new Set(a.manifest.rows.filter((r) => r.split === "test").map((r) => r.id));
	assert.deepEqual([...testA].sort(), [...ids[7]!, ...ids[8]!, ...ids[9]!].sort());

	// Frozen: the manifest matches its hash, and nothing can change either the dataset or the set's days.
	assert.equal(getDataset(db, a.id)!.hash, a.hash);
	assert.throws(
		() => db.prepare("UPDATE decision_datasets SET manifest_json = '{}' WHERE id = ?").run(a.id),
		/frozen/,
	);
	assert.throws(
		() => db.prepare("UPDATE decision_test_sets SET to_day = '2099-01-01'").run(),
		/never changes its days/,
	);
	assert.throws(() => db.prepare("DELETE FROM decision_test_sets").run(), /never deleted/);

	// Two days later: a late label on a test day joins the test; the new days are later than the test, so held.
	label(db, lateRow, "worth_remembering", true);
	const held = [labelled(db, 11, true), labelled(db, 12, false)];
	const b = freezeDataset(db, { policy: POLICY, now: at(12, 20), by: "session-2" });
	assert.ok(b.ok);
	assert.deepEqual([b.manifest.test_set!.id, b.manifest.test_set!.origin, b.manifest.retires], [setA.id, "kept", []]);
	assert.equal(splitOf(b.manifest, lateRow), "test");
	assert.deepEqual(
		held.map((id) => splitOf(b.manifest, id)),
		["held", "held"],
	);
	for (const id of testA)
		assert.equal(splitOf(b.manifest, id), "test", "test in every dataset while the set is active");
	assert.equal(
		datasetRecords(db, b.manifest, ["train", "validation"])
			.get("train")!
			.some((r) => testA.has(r._meta.id.slice(5))),
		false,
	);
	assert.match(describeDataset(b.manifest, b.hash), /held for the next test set 2 · 2 · 2/);

	// Each time the test rows leave the database is a look, recorded before the file exists.
	const dir = mkdtempSync(join(tmpdir(), "iyye-ds-"));
	const plain = writeDataset(db, b.id, dir);
	assert.deepEqual(Object.keys(plain.files).sort(), ["train", "validation"]);
	assert.equal(existsSync(join(dir, "test.jsonl")), false);
	assert.equal(testLooks(db, setA.id), 0);
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.equal(statSync(plain.files.train!).mode & 0o777, 0o600);
	const train = readFileSync(plain.files.train!, "utf8").trim().split("\n");
	assert.equal(train.length, plain.counts.train);
	assert.ok(train.every((l) => !testA.has((JSON.parse(l) as { _meta: { id: string } })._meta.id.slice(5))));

	const look = { by: "session-2", purpose: "evaluation" };
	assert.equal(writeDataset(db, b.id, dir, { test: look, now: at(12, 21) }).counts.test, 7);
	assert.equal(
		writeDataset(db, a.id, dir, { test: look, now: at(12, 22) }).counts.test,
		6,
		"the older dataset, the same set",
	);
	assert.equal(testLooks(db, setA.id), 2);
	assert.throws(
		() => writeDataset(db, b.id, dir, { test: look }),
		(e: Error) => e instanceof DatasetRefused && /looked at 2 time\(s\), the most allowed/.test(e.message),
	);
	assert.equal(testLooks(db, setA.id), 2, "a refused look is not a look");
	assert.throws(() => db.prepare("DELETE FROM decision_test_looks").run(), /never forgotten/);
	deleteDatasetFiles(dir);
	assert.equal(existsSync(dir), false, "the run's files are deleted; the content stays in SQLite");

	// No looks left and too few labels after it: no dataset, and nothing is written.
	const c = freezeDataset(db, { policy: POLICY, now: at(12, 23), by: "session-3" });
	assert.ok(!c.ok);
	assert.match(
		c.reason,
		new RegExp(`no fresh test set yet: 2 owner label\\(s\\) on days after ${day(10)}, and 4 are needed`),
	);
	assert.equal((db.prepare("SELECT count(*) AS n FROM decision_datasets").get() as { n: number }).n, 2);
	assert.equal(
		(db.prepare("SELECT retired_at FROM decision_test_sets WHERE id = ?").get(setA.id) as { retired_at: null })
			.retired_at,
		null,
	);

	// Enough later labels: the spent set is retired, a fresh one starts strictly after it, and only now do
	// the old test days join the training period.
	for (let d = 13; d <= 15; d++) {
		labelled(db, d, true);
		labelled(db, d, false);
	}
	const e = freezeDataset(db, { policy: POLICY, now: at(15, 20), by: "session-4" });
	assert.ok(e.ok);
	assert.deepEqual(e.manifest.retires, [{ id: setA.id, reason: "looks" }]);
	const setE = e.manifest.test_set!;
	assert.ok(setE.id !== setA.id && setE.origin === "new" && setE.from_day > setA.to_day);
	for (const id of testA) assert.ok(["train", "validation"].includes(splitOf(e.manifest, id)!));
	assert.ok(e.manifest.rows.filter((r) => r.split !== "test").every((r) => r.day < setE.from_day));
	assert.deepEqual(db.prepare("SELECT id, retired_reason FROM decision_test_sets ORDER BY from_day").all(), [
		{ id: setA.id, retired_reason: "looks" },
		{ id: setE.id, retired_reason: null },
	]);
	assert.throws(
		() =>
			db.prepare("UPDATE decision_test_sets SET retired_at = NULL, retired_reason = NULL WHERE id = ?").run(setA.id),
		/stays retired/,
	);
	// The earlier datasets are as they were frozen, and their retired test set gives no more looks.
	assert.equal(getDataset(db, a.id)!.hash, a.hash);
	assert.throws(() => writeDataset(db, a.id, dir, { test: look }), /its test set is retired/);
	db.close();
});

test("choosing the test set: kept while it has looks and no full fresh one exists; otherwise replaced from later days only", () => {
	const policy = datasetPolicy({ testFraction: 0.25, testMinLabels: 4, testLooks: 3 });
	const counts = (o: Record<number, number>) => new Map(Object.entries(o).map(([d, n]) => [day(Number(d)), n]));
	const set = (id: string, from: number, to: number, retired = false): TestSetRow => ({
		id,
		from_day: day(from),
		to_day: day(to),
		created_at: "t",
		retired_at: retired ? "t" : null,
		retired_reason: retired ? "looks" : null,
	});
	// No set yet: too few labels, then enough.
	assert.match(
		chooseTestSet(counts({ 1: 2, 2: 1 }), [], new Map(), policy, day(2)).problem!,
		/too few owner labels for a sealed test set: 3, and 4 are needed/,
	);
	assert.deepEqual(chooseTestSet(counts({ 1: 6, 2: 2, 3: 1, 4: 3 }), [], new Map(), policy, day(6)).range, {
		from_day: day(3),
		to_day: day(6),
	});
	assert.match(
		chooseTestSet(counts({ 1: 4 }), [], new Map(), policy, day(1)).problem!,
		/nothing would be left to train on/,
	);
	// An active set with looks left and not enough after it: kept, whatever was labelled inside it since.
	const a = set("a", 3, 6);
	const kept = chooseTestSet(counts({ 1: 6, 2: 2, 3: 4, 4: 3, 7: 3 }), [a], new Map([["a", 2]]), policy, day(8));
	assert.deepEqual([kept.keep?.id, kept.range, kept.retires], ["a", { from_day: day(3), to_day: day(6) }, []]);
	// Enough later labels for a full fresh set (a quarter of 24 = 6): superseded, although it had looks left.
	const fresh = chooseTestSet(
		counts({ 1: 6, 2: 2, 3: 4, 4: 3, 7: 3, 8: 3, 9: 3 }),
		[a],
		new Map([["a", 1]]),
		policy,
		day(9),
	);
	assert.deepEqual(fresh.retires, [{ id: "a", reason: "superseded" }]);
	assert.deepEqual([fresh.keep, fresh.range], [null, { from_day: day(8), to_day: day(9) }]);
	// No looks left: retired; the fresh one is made of what is after it, even if that is less than the target…
	const spent = chooseTestSet(
		counts({ 1: 6, 2: 2, 3: 4, 4: 3, 7: 2, 8: 2 }),
		[a],
		new Map([["a", 3]]),
		policy,
		day(8),
	);
	assert.deepEqual(
		[spent.retires, spent.range],
		[[{ id: "a", reason: "looks" }], { from_day: day(7), to_day: day(8) }],
	);
	// …and never reaches back into days an earlier set (retired long ago) covered.
	const old = set("old", 1, 2, true);
	const after = chooseTestSet(counts({ 1: 6, 2: 6, 3: 2, 4: 2 }), [old], new Map(), policy, day(4));
	assert.deepEqual(after.range, { from_day: day(3), to_day: day(4) });
	assert.match(
		chooseTestSet(counts({ 1: 6, 2: 6, 3: 2 }), [old], new Map(), policy, day(3)).problem!,
		new RegExp(`no fresh test set yet: 2 owner label\\(s\\) on days after ${day(2)}`),
	);
});

test("validation is whole days of the training period, the same for the same period, never all of it", () => {
	const counts = new Map(Array.from({ length: 12 }, (_, i) => [day(i + 1), 2] as const));
	const v = chooseValidationDays(counts, 0.25);
	assert.equal(v.size, 3);
	assert.deepEqual([...chooseValidationDays(new Map([...counts].reverse()), 0.25)].sort(), [...v].sort());
	assert.equal(chooseValidationDays(new Map([[day(1), 5]]), 0.5).size, 0, "one day: it trains");
	assert.equal(
		chooseValidationDays(
			new Map([
				[day(1), 5],
				[day(2), 5],
			]),
			0.9,
		).size,
		1,
	);
	assert.equal(chooseValidationDays(new Map(), 0.25).size, 0);
});
