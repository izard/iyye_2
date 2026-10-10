// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.013 E1: belief validity as date ranges, rebuilt from the evidence.
 * Owner decisions: the latest effective date wins; for the same date an
 * explicit owner correction, then the later said_at, then the evidence id;
 * an older report keeps later transitions; conflicts stay visible.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
	conflictsOf,
	correctBelief,
	currentOf,
	ensureBeliefTimelines,
	evidenceOf,
	forgetBeliefs,
	getBelief,
	intervalsOf,
	mergeFact,
	rebuildAllTimelines,
	rebuildTimeline,
} from "../src/facts/beliefs.ts";
import { FactsCommand } from "../src/facts/commands.ts";
import { beliefLine } from "../src/facts/disclosure.ts";
import type { StmFact } from "../src/facts/store.ts";
import { silentLogger } from "../src/log.ts";
import { type Db, openDb } from "../src/state/db.ts";

const KEY = "contact:julia|lives_in";
const NOW = new Date("2026-10-10T12:00:00Z");
let n = 0;
/** Ids that sort in creation order (the tie rule's last step) and resolve by an 8-character prefix. */
const newId = () => `${String(++n).padStart(6, "0")}-${crypto.randomUUID().slice(0, 8)}`;

function say(
	db: Db,
	object: string,
	from: string,
	o: { saidAt?: string; source?: string; scope?: string; modality?: string; cited?: string | null } = {},
) {
	const f = {
		id: newId(),
		doc_id: "d",
		event_id: newId(),
		scope: o.scope ?? "contact:julia",
		modality: o.modality ?? "stated",
		source: o.source ?? "julia",
		subject: "Julia",
		subject_ref: "contact:julia",
		predicate: "lives_in",
		object,
		details: null,
		valid_from: from,
		time_frame: "permanent",
		hedged: 0,
		negated: 0,
		quote: "q",
		cited: o.cited ?? null,
		fact_key: KEY,
		p: 0.85,
		said_at: o.saidAt ?? `${from}T10:00:00.000Z`,
		created_at: NOW.toISOString(),
		state: "day",
		merged_at: null,
		belief_id: null,
		private: 0,
	} as StmFact;
	db.prepare(
		`INSERT INTO stm_facts (id, doc_id, event_id, scope, modality, source, subject, subject_ref, predicate, object, details, valid_from,
			time_frame, hedged, negated, quote, cited, fact_key, p, said_at, created_at, private)
		 VALUES (@id, @doc_id, @event_id, @scope, @modality, @source, @subject, @subject_ref, @predicate, @object, @details, @valid_from,
			@time_frame, @hedged, @negated, @quote, @cited, @fact_key, @p, @said_at, @created_at, @private)`,
	).run(f);
	return mergeFact(db, f, { night: newId(), maxStep: 9, now: NOW, newId });
}

const idOf = (db: Db, object: string) =>
	(db.prepare("SELECT id FROM beliefs WHERE fact_key = ? AND object = ?").get(KEY, object) as { id: string }).id;
/** Every range of the key, as "Value from–to" ("…" while open), in date order. */
const ranges = (db: Db) =>
	(
		db
			.prepare(
				`SELECT b.object, i.valid_from, i.valid_to FROM belief_intervals i JOIN beliefs b ON b.id = i.belief_id
				 WHERE b.fact_key = ? ORDER BY i.valid_from`,
			)
			.all(KEY) as { object: string; valid_from: string; valid_to: string | null }[]
	).map((r) => `${r.object} ${r.valid_from}–${r.valid_to ?? "…"}`);
const now = (db: Db) => currentOf(db, KEY)?.object ?? null;

describe("ranges", () => {
	test("a value said again keeps its earlier range (A → B → A)", () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-01-01");
		say(db, "Munich", "2026-05-01");
		say(db, "Berlin", "2026-09-01");
		assert.deepEqual(ranges(db), [
			"Berlin 2026-01-01–2026-05-01",
			"Munich 2026-05-01–2026-09-01",
			"Berlin 2026-09-01–…",
		]);
		assert.equal(now(db), "Berlin");
		const berlin = getBelief(db, idOf(db, "Berlin"))!;
		assert.deepEqual([berlin.state, berlin.valid_from, berlin.valid_to], ["current", "2026-09-01", null]);
		assert.equal(intervalsOf(db, berlin.id).length, 2);
	});

	test("the same reports arriving out of order give the same ranges", () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-09-01");
		say(db, "Munich", "2026-05-01");
		say(db, "Berlin", "2026-01-01");
		assert.deepEqual(ranges(db), [
			"Berlin 2026-01-01–2026-05-01",
			"Munich 2026-05-01–2026-09-01",
			"Berlin 2026-09-01–…",
		]);
	});

	test("an older report keeps later transitions; the latest date decides what holds now", () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-01-01");
		say(db, "Munich", "2026-05-01");
		say(db, "Paris", "2026-09-01");
		// Said in October, about July: it is history between two changes.
		say(db, "Berlin", "2026-07-01", { saidAt: "2026-10-09T09:00:00.000Z" });
		assert.deepEqual(ranges(db), [
			"Berlin 2026-01-01–2026-05-01",
			"Munich 2026-05-01–2026-07-01",
			"Berlin 2026-07-01–2026-09-01",
			"Paris 2026-09-01–…",
		]);
		assert.equal(now(db), "Paris");
		// Received now with the latest date: it changes what holds.
		const rome = say(db, "Rome", "2026-10-05");
		assert.equal(rome.relation, "changes");
		assert.equal(now(db), "Rome");
	});

	test("the same date: the later-said value holds, then the evidence id; the disagreement stays visible", () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-03-01", { saidAt: "2026-03-01T18:00:00.000Z", source: "owner", scope: "owner" });
		say(db, "Hamburg", "2026-03-01", { saidAt: "2026-03-01T09:00:00.000Z", source: "jacob", scope: "contact:jacob" });
		// An ordinary owner statement follows the normal rule: said later, it holds.
		assert.equal(now(db), "Berlin");
		assert.deepEqual(ranges(db), ["Berlin 2026-03-01–…"]);
		assert.deepEqual(
			conflictsOf(db, getBelief(db, idOf(db, "Berlin"))!).map((c) => c.belief.object),
			["Hamburg"],
		);
		assert.equal(getBelief(db, idOf(db, "Hamburg"))!.state, "closed");
		// The same said_at: the evidence id decides, the same way every time.
		const db2 = openDb(":memory:");
		say(db2, "Kiel", "2026-03-01", { saidAt: "2026-03-01T09:00:00.000Z" });
		say(db2, "Bonn", "2026-03-01", { saidAt: "2026-03-01T09:00:00.000Z", source: "jacob", scope: "contact:jacob" });
		const first = now(db2);
		rebuildTimeline(db2, KEY);
		assert.equal(now(db2), first);
		assert.equal(first, "Bonn", "the later evidence id");
	});
});

describe("late and planned", () => {
	test("a new value reported for an older date is history: the value that holds keeps its p and has no conflict", () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-01-01");
		say(db, "Munich", "2026-05-01");
		const paris = say(db, "Paris", "2026-09-01").beliefId!;
		const p = getBelief(db, paris)!.p;
		say(db, "Rome", "2026-07-01", { saidAt: "2026-10-09T09:00:00.000Z", source: "jacob", scope: "contact:jacob" });
		assert.deepEqual(ranges(db), [
			"Berlin 2026-01-01–2026-05-01",
			"Munich 2026-05-01–2026-07-01",
			"Rome 2026-07-01–2026-09-01",
			"Paris 2026-09-01–…",
		]);
		assert.equal(getBelief(db, paris)!.p, p);
		assert.deepEqual(conflictsOf(db, getBelief(db, paris)!), []);
	});

	test("a date still to come does not hold yet; on its day it does", () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-01-01");
		const munich = say(db, "Munich", "2026-12-01", { saidAt: "2026-10-09T09:00:00.000Z" }).beliefId!;
		assert.equal(now(db), "Berlin");
		const planned = getBelief(db, munich)!;
		assert.deepEqual([planned.state, planned.valid_from, planned.valid_to], ["closed", "2026-12-01", null]);
		const reader = { principal: "owner" as const, personId: "owner", ownScopes: ["owner"], trusted: true };
		assert.match(beliefLine(db, planned, evidenceOf(db, munich), reader, NOW), /\(from 2026-12-01, not yet\)$/);
		rebuildAllTimelines(db, "2026-12-02");
		assert.equal(now(db), "Munich");
	});

	test("in recall, a value that never held is disputed, not past history", () => {
		const db = openDb(":memory:");
		say(db, "Kiel", "2026-03-01", { saidAt: "2026-03-01T09:00:00.000Z" });
		say(db, "Bonn", "2026-03-01", { saidAt: "2026-03-01T18:00:00.000Z", source: "jacob", scope: "contact:jacob" });
		const kiel = getBelief(db, idOf(db, "Kiel"))!;
		const reader = { principal: "owner" as const, personId: "owner", ownScopes: ["owner"], trusted: true };
		assert.match(
			beliefLine(db, kiel, evidenceOf(db, kiel.id), reader, NOW),
			/Julia lives in Kiel \(disputed: another value was given for the same time\)$/,
		);
	});
});

describe("corrections", () => {
	const opts = { night: "c", maxStep: Number.POSITIVE_INFINITY, now: NOW, newId };

	test("a correction to an earlier value holds from today; both its ranges are kept", () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-01-01");
		const munich = say(db, "Munich", "2026-05-01").beliefId!;
		// Someone else says Munich today, later than the correction is made: the correction still wins its date.
		say(db, "Munich", "2026-10-10", { saidAt: "2026-10-10T23:00:00.000Z", source: "jacob", scope: "contact:jacob" });
		const r = correctBelief(db, munich, "Berlin", opts);
		assert.ok(typeof r !== "string" && !r.already);
		assert.equal(now(db), "Berlin");
		assert.deepEqual(ranges(db), [
			"Berlin 2026-01-01–2026-05-01",
			"Munich 2026-05-01–2026-10-10",
			"Berlin 2026-10-10–…",
		]);
	});

	test("a correction to the value already current confirms it and moves nothing", () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-01-01");
		const munich = say(db, "Munich", "2026-05-01").beliefId!;
		const before = ranges(db);
		const r = correctBelief(db, munich, "Munich", opts);
		assert.ok(typeof r !== "string" && r.already);
		assert.deepEqual(ranges(db), before);
		assert.ok(getBelief(db, munich)!.p > 0.85);
	});

	test("/facts shows every range, approximate dates and conflicts; a correction answers what it did", async () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-01-01");
		const munich = say(db, "Munich", "2026-05-01").beliefId!;
		say(db, "Berlin", "2026-09-01");
		say(db, "Hamburg", "2026-09-01", { saidAt: "2026-09-01T01:00:00.000Z", source: "jacob", scope: "contact:jacob" });
		const cmd = new FactsCommand({
			db,
			log: silentLogger,
			ltm: null,
			extractorStatus: () => "idle",
			now: () => NOW,
			newId,
		});
		const out = await cmd.command(["julia", "lives"], "owner_web");
		assert.match(out, /current, 2026-01-01 – 2026-05-01, since 2026-09-01, .*\] Julia lives in Berlin/);
		assert.match(out, /conflict: Hamburg \([\w-]{7,8}, p [\d.]+\) from a contact for 2026-09-01/);
		assert.match(out, /closed, 2026-05-01 – 2026-09-01, .*\] Julia lives in Munich/);
		assert.match(
			await cmd.command(["correct", munich.slice(0, 8), "Berlin"], "owner_web"),
			/^already current: Julia lives in Berlin; your word confirms it/,
		);
		assert.match(
			await cmd.command(["correct", munich.slice(0, 8), "Munich"], "owner_web"),
			/^noted: Julia lives in Munich \(p [\d.]+\), from today; it holds again/,
		);
		assert.equal(now(db), "Munich");
	});
});

describe("Iyye, forgetting, backfill", () => {
	test("Iyye's cited words open a range only when no value holds", () => {
		const db = openDb(":memory:");
		const iyye = { source: "iyye", scope: "owner", modality: "told_by_iyye", cited: "web search" };
		say(db, "Oslo", "2026-02-01", iyye);
		assert.equal(now(db), "Oslo");
		say(db, "Bergen", "2026-03-01");
		assert.equal(now(db), "Bergen");
		say(db, "Tromsø", "2026-04-01", iyye);
		assert.equal(now(db), "Bergen", "Iyye's word never replaces a value someone gave");
	});

	test("/forget removes the evidence that placed a value, and the ranges are rebuilt from what remains", () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-01-01");
		say(db, "Munich", "2026-05-01", { source: "jacob", scope: "contact:jacob" });
		say(db, "Berlin", "2026-09-01");
		forgetBeliefs(db, ["contact:jacob"], ["jacob"], NOW.toISOString());
		assert.deepEqual(ranges(db), ["Berlin 2026-01-01–…"]);
	});

	test("rebuilding twice changes nothing; the backfill runs once", () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-01-01");
		say(db, "Munich", "2026-05-01");
		say(db, "Berlin", "2026-09-01");
		const before = JSON.stringify(db.prepare("SELECT * FROM belief_intervals ORDER BY belief_id, seq").all());
		rebuildTimeline(db, KEY);
		rebuildTimeline(db, KEY);
		assert.equal(JSON.stringify(db.prepare("SELECT * FROM belief_intervals ORDER BY belief_id, seq").all()), before);
		db.prepare("DELETE FROM belief_intervals").run();
		assert.equal(ensureBeliefTimelines(db, NOW.toISOString()), 1);
		assert.equal(JSON.stringify(db.prepare("SELECT * FROM belief_intervals ORDER BY belief_id, seq").all()), before);
		assert.equal(ensureBeliefTimelines(db, NOW.toISOString()), 0, "once");
	});

	test("a legacy /facts confirm of an earlier value keeps a confirmation's meaning after the migration (035)", () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-01-01");
		const munich = say(db, "Munich", "2026-05-01").beliefId!;
		const berlin = idOf(db, "Berlin");
		// What 033's backfill made of an owner confirmation of Berlin merged before it: a dated "correction".
		db.prepare(
			`INSERT INTO belief_evidence (id, belief_id, source, scope, modality, sign, source_p, weight, relation, night, at,
				effective_at, said_at, effective_known)
			 VALUES ('legacy-confirm', ?, 'owner', 'owner', 'stated', 1, 0.9, 1, 'correction', 'n', '2026-10-10T12:30:00.000Z',
				'2026-10-10', '2026-10-10T12:30:00.000Z', 1)`,
		).run(berlin);
		db.prepare(
			"UPDATE schema_migrations SET applied_at = '2026-10-10T12:40:51.980Z' WHERE name = '033_belief_intervals.sql'",
		).run();
		rebuildTimeline(db, KEY, "2026-10-10");
		assert.equal(now(db), "Berlin", "the bug: the dated row reopened Berlin");
		db.exec(readFileSync(new URL("../src/state/migrations/035_legacy_confirmations.sql", import.meta.url), "utf8"));
		assert.equal(ensureBeliefTimelines(db, NOW.toISOString()), 1);
		assert.equal(now(db), "Munich");
		assert.deepEqual(
			db.prepare("SELECT effective_at, effective_known FROM belief_evidence WHERE id = 'legacy-confirm'").get(),
			{ effective_at: null, effective_known: 0 },
		);
		assert.equal(getBelief(db, munich)!.state, "current");
		// A legacy correction that created its belief stays a correction (its first evidence).
		assert.ok(
			db.prepare("SELECT 1 FROM belief_evidence WHERE belief_id = ? AND effective_at IS NOT NULL").get(berlin),
		);
	});

	test("evidence merged before the dates were kept is shown as approximate, never as known", async () => {
		const db = openDb(":memory:");
		say(db, "Berlin", "2026-01-01");
		db.prepare("UPDATE belief_evidence SET effective_known = 0").run();
		rebuildTimeline(db, KEY);
		const cmd = new FactsCommand({
			db,
			log: silentLogger,
			ltm: null,
			extractorStatus: () => "idle",
			now: () => NOW,
			newId,
		});
		assert.match(await cmd.command(["julia", "lives"], "owner_web"), /since ~2026-01-01/);
	});
});
