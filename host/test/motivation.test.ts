// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Plan 0.010 M0: the four motivations' need signals, from records only, in shadow. */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { silentLogger } from "../src/log.ts";
import { collectSignals, rawNeed, type Signal, strength } from "../src/motivation/signals.ts";
import { MotivationTracker } from "../src/motivation/tracker.ts";
import type { Gap } from "../src/self/model.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { setKv } from "../src/state/kv.ts";

const NOW = new Date("2026-10-05T12:00:00Z");
const iso = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function seed(db: Db): void {
	db.prepare(
		`INSERT INTO observations (id, domain, at, result_json, result_hash, severity, change_text)
		 VALUES ('obs-1', 'machine', ?, ?, 'h', 'none', NULL)`,
	).run(
		iso(0.1),
		JSON.stringify({
			diskFreeGb: 40,
			diskTotalGb: 1858,
			diskFreePct: 2.2,
			memAvailableGb: 44,
			services: { "the model router": "up", "long-term memory": "unreachable", Telegram: "retrying" },
		}),
	);
	setKv(db, "rhythm.last_night_at", iso(10), iso(10));
	setKv(
		db,
		"rhythm.last_summary",
		"0 conversation(s) moved; stopped early: long-term memory is unreachable: The operation was aborted",
		iso(10),
	);
	db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Jacob', 'contact', 't')").run();
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('e1', 'e1', 'telegram', 'c1', 'contact:c1', ?, '{}', 'admitted')",
	).run(iso(3));
	db.prepare(
		"INSERT INTO jobs (id, trigger_event_id, scope, status, created_at, settled_at) VALUES ('j1', 'e1', 'contact:c1', 'failed', ?, ?)",
	).run(iso(3), iso(3));
	db.prepare(
		`INSERT INTO plans (id, intent, proposer_contact_id, scope, route_json, proposed_via, steps_json, state, created_at, updated_at)
		 VALUES ('p1', 'check the workspace', 'owner', 'owner', '{}', 'web chat', '[]', 'suspended', ?, ?)`,
	).run(iso(30), iso(30));
}

const sources = (gaps: Gap[] = []) => ({
	selfGaps: () => gaps,
	healing: () => [{ model: "gemma-4-26B", attempts: 6, gaveUp: true, lastError: "did not finish loading" }],
	sleep: () => ({ sleptOnBattery: true, asleepMinutes: 430 }),
});

describe("need signals", () => {
	test("each motivation's signals come from records, with their evidence", () => {
		const db = openDb(":memory:");
		seed(db);
		const sig = collectSignals({
			db,
			now: NOW,
			...sources([{ facet: "place", field: "stated", kind: "missing", why: "the owner never said where Iyye is" }]),
		});
		const by = (kind: string) => sig.filter((s) => s.kind === kind);
		assert.equal(by("disk_low")[0]!.motivation, "self_preservation");
		assert.deepEqual(by("disk_low")[0]!.evidence, ["observation:obs-1"]);
		assert.deepEqual(
			by("service_down")
				.map((s) => s.cluster)
				.sort(),
			["service:Telegram", "service:long-term memory"],
		);
		assert.equal(by("model_gave_up")[0]!.weight, 0.9);
		assert.match(by("night_cut_short")[0]!.text, /stopped early: long-term memory is unreachable/);
		assert.equal(by("slept_on_battery")[0]!.motivation, "self_preservation");
		assert.deepEqual(
			by("self_missing").map((s) => [s.motivation, s.cluster]),
			[["curiosity", "self:place:stated"]],
		);
		assert.deepEqual(
			by("plan_suspended").map((s) => [s.motivation, s.cluster]),
			[["agency", "plan:p1"]],
		);
		assert.deepEqual(
			by("person_unanswered").map((s) => [s.motivation, s.evidence[0]]),
			[["social", "job:j1"]],
		);
		assert.ok(
			sig.every((s) => s.evidence.length > 0),
			"every signal names its evidence",
		);
	});

	test("Iyye's own text never raises a need: replies, summaries and findings are not read", () => {
		const db = openDb(":memory:");
		// A day summary and a finding full of alarming words, written by Iyye.
		db.prepare(
			"INSERT INTO stm_episodes (event_id, kind, scope, channel, contact_id, action_id, user_text, reply_text, said_at, answered_at) VALUES ('summary:6', 'summary', 'iyye', NULL, NULL, NULL, 'Critical failure: disk full, Telegram down, the plan failed, nobody answered', '', ?, ?)",
		).run(iso(1), iso(1));
		const sig = collectSignals({ db, now: NOW, selfGaps: () => [], healing: () => [], sleep: () => null });
		assert.deepEqual(sig, []);
	});

	test("raw need: independent pressures, in [0, 1], fading with age", () => {
		const s = (weight: number, h: number): Signal => ({
			motivation: "curiosity",
			kind: "k",
			cluster: "c",
			evidence: ["x"],
			weight,
			observedAt: iso(h),
			text: "",
		});
		assert.equal(rawNeed([], NOW), 0);
		assert.equal(rawNeed([s(0.6, 0)], NOW), 0.6);
		assert.ok(Math.abs(rawNeed([s(0.6, 0), s(0.5, 0)], NOW) - 0.8) < 1e-9);
		assert.ok(rawNeed([s(0.9, 0), s(0.9, 0), s(0.9, 0), s(0.9, 0)], NOW) <= 1);
		assert.ok(strength(s(0.8, 36), NOW) < 0.8 * 0.4, "a day and a half old: well under half");
	});
});

describe("the tracker (shadow)", () => {
	const make = (db: Db, now: { t: Date }, mode = { m: "awake" as "awake" | "asleep" }) =>
		new MotivationTracker({
			db,
			log: silentLogger,
			mode: () => mode.m,
			sources: sources(),
			now: () => now.t,
			alpha: 0.5,
			threshold: 0.6,
			sustain: 2,
		});
	const latest = (db: Db, m: string) =>
		db
			.prepare("SELECT * FROM motivation_samples WHERE motivation = ? ORDER BY at DESC, rowid DESC LIMIT 1")
			.get(m) as { raw: number; smoothed: number; sustained: number; would_open: string | null };

	test("smooths, counts sustained sweeps, names what would open, and survives a restart; nothing is opened", async () => {
		const db = openDb(":memory:");
		seed(db);
		const now = { t: NOW };
		await make(db, now).sweep();
		let sp = latest(db, "self_preservation");
		assert.ok(sp.raw > 0.95);
		assert.ok(Math.abs(sp.smoothed - sp.raw * 0.5) < 0.002, "first sample: α · raw");
		assert.equal(sp.sustained, 0);
		// A restart: a new tracker restores the smoothing from the last sample.
		now.t = new Date(NOW.getTime() + 600_000);
		await make(db, now).sweep();
		sp = latest(db, "self_preservation");
		assert.ok(sp.smoothed >= 0.6 && sp.sustained === 1, JSON.stringify(sp));
		now.t = new Date(NOW.getTime() + 1_200_000);
		await make(db, now).sweep();
		sp = latest(db, "self_preservation");
		assert.equal(sp.sustained, 2);
		assert.equal(sp.would_open, "model:gemma-4-26B", "the strongest evidence cluster");
		assert.equal(latest(db, "curiosity").raw, 0);
		assert.equal((db.prepare("SELECT count(*) AS n FROM opportunities").get() as { n: number }).n, 0, "shadow");

		const report = make(db, now).report();
		assert.match(
			report,
			/self_preservation: need [01]\.\d+ \(raw [01]\.\d+, 0 min ago\) · high for 2 sweep\(s\) · would open: model:gemma-4-26B/,
		);
		assert.match(report, /0\.90 model_gave_up: gemma-4-26B could not be loaded/);
		const ctx = { models: {} as never, db, issuer: "owner_web", motivationReport: () => report };
		assert.equal((await handleOwnerCommand("/motivation", ctx)).reply, report);
	});

	test("asleep nothing is sampled; old samples are pruned", async () => {
		const db = openDb(":memory:");
		const now = { t: NOW };
		const mode = { m: "asleep" as "awake" | "asleep" };
		await make(db, now, mode).sweep();
		assert.equal((db.prepare("SELECT count(*) AS n FROM motivation_samples").get() as { n: number }).n, 0);
		mode.m = "awake";
		await make(db, now, mode).sweep();
		now.t = new Date(NOW.getTime() + 15 * 86_400_000);
		await make(db, now, mode).sweep();
		assert.equal(
			(db.prepare("SELECT count(*) AS n FROM motivation_samples").get() as { n: number }).n,
			4,
			"only the latest sweep's four rows",
		);
	});
});
