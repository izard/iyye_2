// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.009 CH2: mood from records only. Energy is the adenosine level as of
 * the moment asked; ease is the day's good and bad records, decayed, reset by
 * a completed night; engagement belongs to one conversation and no other can
 * move it; the result as of a time never depends on later records.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EASE_HALF_LIFE_H, EASE_PRIOR, moodAt, moodHeader, moodReport, recordMood } from "../src/character/mood.ts";
import { type Db, migrate, openDb } from "../src/state/db.ts";

const T = new Date("2026-10-11T12:00:00.000Z");
const ago = (min: number) => new Date(T.getTime() - min * 60_000).toISOString();
const later = (min: number) => new Date(T.getTime() + min * 60_000).toISOString();

function setup(): Db {
	const db = openDb(":memory:");
	migrate(db);
	for (const id of ["julia", "jacob"])
		db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', ?)").run(
			id,
			id[0]!.toUpperCase() + id.slice(1),
			ago(10_000),
		);
	return db;
}

let n = 0;
function ledger(db: Db, at: string, kind: string, amount: number, level: number) {
	db.prepare("INSERT INTO energy_ledger (at, kind, amount, level_after, ref) VALUES (?, ?, ?, ?, ?)").run(
		at,
		kind,
		amount,
		level,
		`r${n++}`,
	);
}
function action(db: Db, at: string, state: string, kind = "reply") {
	const id = `a${n++}`;
	db.prepare(
		"INSERT INTO actions (id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, '{}', 'h', ?, ?, ?, 'x')",
	).run(id, kind, id, state, at);
	return id;
}
function message(db: Db, scope: string, contact: string, at: string) {
	const id = `e${n++}`;
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'telegram', ?, ?, ?, '{}', 'answered')",
	).run(id, id, contact, scope, at);
	return id;
}

test("energy is the adenosine level after the last ledger entry at or before the moment", () => {
	const db = setup();
	assert.equal(moodAt(db, null, T).energy, null, "no ledger yet: unknown");
	ledger(db, ago(120), "refill_night", 0.6, 1);
	ledger(db, ago(30), "awake", -0.4, 0.6);
	ledger(db, later(5), "awake", -0.4, 0.2);
	const m = moodAt(db, null, T);
	assert.equal(m.energy, 0.6);
	assert.equal(m.sources.energy!.at, ago(30));
	assert.match(moodHeader(m), /^Mood: energy steady, /);
});

test("ease: good and bad records of the day, decayed, against a prior; a completed night starts again at 0", () => {
	const db = setup();
	assert.equal(moodAt(db, null, T).ease, 0, "no records: baseline");
	// Before the night: never counted again.
	action(db, ago(600), "terminal_failure");
	ledger(db, ago(300), "refill_night", 0.7, 1);
	for (let i = 0; i < 4; i++) action(db, ago(10), "delivered");
	const fresh = moodAt(db, null, T);
	assert.ok(fresh.ease > 0.4, `${fresh.ease}`);
	assert.equal(fresh.sources.bad.length, 0, "the failure before the night is not today's");
	// One failed message weighs three delivered ones.
	action(db, ago(10), "terminal_failure");
	const mixed = moodAt(db, null, T);
	assert.ok(
		Math.abs(
			mixed.ease -
				(4 * 0.5 ** (10 / 60 / EASE_HALF_LIFE_H) - 3 * 0.5 ** (10 / 60 / EASE_HALF_LIFE_H)) /
					(7 * 0.5 ** (10 / 60 / EASE_HALF_LIFE_H) + EASE_PRIOR),
		) < 1e-9,
	);
	// Old records weigh less: the same failure six hours ago (two half-lives) is a quarter.
	const db2 = setup();
	ledger(db2, ago(700), "refill_night", 0.7, 1);
	action(db2, ago(360), "terminal_failure");
	assert.ok(Math.abs(moodAt(db2, null, T).ease - -0.75 / (0.75 + EASE_PRIOR)) < 1e-9);
	// A service in trouble, a failed turn and a fruitless attempt are bad; a useful outcome is good.
	db2.prepare(
		"INSERT INTO service_status (name, state, since, updated_at) VALUES ('web search', 'retrying', ?, ?)",
	).run(ago(5), ago(1));
	db2.prepare("INSERT INTO motivation_events (id, at, kind) VALUES ('m1', ?, 'fruitless'), ('m2', ?, 'useful')").run(
		ago(5),
		ago(5),
	);
	const kinds = moodAt(db2, null, T).sources;
	assert.deepEqual(kinds.bad.map((r) => r.kind).sort(), ["fruitless", "not delivered", "web search retrying"]);
	assert.deepEqual(
		kinds.good.map((r) => r.kind),
		["useful"],
	);
});

test("engagement belongs to one conversation: another conversation never moves it", () => {
	const db = setup();
	for (let i = 0; i < 6; i++) message(db, "contact:jacob", "jacob", ago(5 + i));
	const julia = moodAt(db, "contact:julia", T);
	assert.equal(julia.engagement, 0, "Jacob's lively conversation is not Julia's");
	assert.equal(moodAt(db, null, T).engagement, null, "the global part has none");
	const jacob = moodAt(db, "contact:jacob", T);
	assert.ok(jacob.engagement! > 0.6, `${jacob.engagement}`);
	assert.equal(jacob.sources.conversation.length, 6);
	// Messages older than the window or after the moment do not count.
	message(db, "contact:julia", "julia", ago(180));
	message(db, "contact:julia", "julia", later(1));
	assert.equal(moodAt(db, "contact:julia", T).engagement, 0);
});

test("a mood as of a moment never depends on later records; a snapshot is journaled with its sources", () => {
	const db = setup();
	ledger(db, ago(60), "refill_night", 0.5, 1);
	action(db, ago(20), "delivered");
	message(db, "contact:julia", "julia", ago(3));
	const before = moodAt(db, "contact:julia", T);
	action(db, later(1), "terminal_failure");
	ledger(db, later(2), "awake", -0.5, 0.5);
	message(db, "contact:julia", "julia", later(3));
	assert.deepEqual(moodAt(db, "contact:julia", T), before);
	const id = recordMood(db, before, "voice", new Date(later(10)));
	const row = db.prepare("SELECT * FROM mood_samples WHERE id = ?").get(id) as Record<string, unknown>;
	assert.equal(row.as_of, T.toISOString());
	assert.equal(row.scope, "contact:julia");
	assert.equal(row.reason, "voice");
	assert.equal(JSON.parse(row.sources_json as string).good[0].kind, "delivered");
});

test("/mood shows the sources and each active conversation by name", () => {
	const db = setup();
	ledger(db, ago(60), "refill_night", 0.5, 0.9);
	action(db, ago(20), "delivered");
	message(db, "contact:julia", "julia", ago(3));
	const out = moodReport(db, T, (s) => (s === "contact:julia" ? "Julia" : s));
	assert.match(out, /energy: fresh \(0\.90/);
	assert.match(out, /ease: a good day|ease: an even day/);
	assert.match(out, /good: 1 delivered; bad: none/);
	assert.match(out, /Julia: a conversation \(0\.\d\d, 1 message\(s\)\)/);
});
