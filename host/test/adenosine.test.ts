// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.007 S2: adenosine. One ledger writer, each charge at most once,
 * persisted; low energy stops background work but never refuses the owner;
 * below the wind-down level Iyye sleeps at the next quiet moment; a
 * completed night refills fully, an interrupted one in proportion.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { TurnRequest } from "../src/integration/pi/sessions.ts";
import type { TurnResult } from "../src/integration/pi/turn.ts";
import { Adenosine, DEFAULT_CHARGES } from "../src/kernel/adenosine.ts";
import { admitOwnerWebMessage } from "../src/kernel/admission.ts";
import { BackgroundWorker } from "../src/kernel/background.ts";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { parseWindow, Rhythm } from "../src/kernel/rhythm.ts";
import { silentLogger } from "../src/log.ts";
import type { NightOutcome } from "../src/memory/night.ts";
import { getBackgroundJob } from "../src/state/background.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { leaveStm, recordEpisode } from "../src/state/stm.ts";
import { type Sandbox, sandbox, waitFor } from "./model-helpers.ts";
import { type Stack, startStack } from "./web-helpers.ts";

let seq = 0;
/** An answered owner turn, as the outbox records it. */
function turn(db: Db, text: string, at: string): string {
	const id = `e${++seq}`;
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'web', 'owner', 'owner', ?, ?, 'answered')",
	).run(id, id, at, JSON.stringify({ text }));
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, 'ok')",
	).run(`a-${id}`, id, `k-${id}`, at);
	recordEpisode(db, getEvent(db, id)!, { id: `a-${id}`, content: "ok" }, at);
	return id;
}

const ledger = (db: Db) =>
	db.prepare("SELECT kind, round(amount, 4) AS amount, ref FROM energy_ledger ORDER BY id").all() as {
		kind: string;
		amount: number;
		ref: string | null;
	}[];

function energy(
	db: Db,
	clock: { now: Date },
	opts: { maxGapMs?: number; mode?: () => "awake" | "asleep" | "winding_down" } = {},
) {
	return new Adenosine({
		db,
		log: silentLogger,
		mode: opts.mode ?? (() => "awake"),
		now: () => clock.now,
		...(opts.maxGapMs === undefined ? {} : { maxGapMs: opts.maxGapMs }),
	});
}

test("one writer: a referenced charge is written once, the level is clamped, and it survives a restart", () => {
	const db = openDb(":memory:");
	const clock = { now: new Date(2026, 9, 4, 12, 0) };
	const a = energy(db, clock);
	assert.equal(a.level(), 1);
	assert.equal(a.charge("stm_write", 0.005, "e1"), true);
	assert.equal(a.charge("stm_write", 0.005, "e1"), false, "the same turn is never charged twice");
	assert.equal(
		a.charge("model_load", 0.025, "e1"),
		true,
		"a different kind with the same reference is its own charge",
	);
	assert.equal(a.charge("awake", 0), false, "nothing for nothing");
	assert.equal(Math.round(a.level() * 1000), 970);
	assert.equal(Math.round(energy(db, clock).level() * 1000), 970, "persisted");
	a.charge("device_background", 5);
	assert.equal(a.level(), 0, "clamped at 0");
	a.refill(0.4, "refill_partial");
	a.refill(0.2, "refill_partial");
	assert.equal(a.level(), 0.4, "a refill never lowers the level");
	db.close();
});

test("one runaway turn costs at most devicePerTurnMax, however long it ran (2026-10-05: 1.5 h cost 0.48)", () => {
	const db = openDb(":memory:");
	const clock = { now: new Date(2026, 9, 5, 19, 0) };
	const a = energy(db, clock);
	a.deviceTime("chat", 90 * 60_000, "job-runaway:1");
	assert.equal(Math.round((1 - a.level()) * 1000), Math.round(DEFAULT_CHARGES.devicePerTurnMax * 1000));
	assert.ok(a.level() > 0.15 + 0.5, "one turn cannot bring a fresh day near the nap level");
	a.deviceTime("chat", 4 * 60_000, "job-normal:1");
	assert.equal(Math.round((1 - a.level()) * 1000), 150 + 20, "a normal turn is charged as before");
	db.close();
});

test("the sweep charges answered turns and model operations once, never history; awake time only while awake, never the downtime", () => {
	const db = openDb(":memory:");
	const clock = { now: new Date(2026, 9, 4, 12, 0) };
	turn(db, "before Adenosine existed", new Date(2026, 9, 4, 11, 0).toISOString());
	let mode: "awake" | "asleep" = "awake";
	const a = energy(db, clock, { maxGapMs: 2 * 3_600_000, mode: () => mode });
	a.start();
	clock.now = new Date(2026, 9, 4, 12, 30);
	const e2 = turn(db, "hello", clock.now.toISOString());
	db.prepare(
		"INSERT INTO model_ops (id, op, model_name, requested_by, state, started_at, finished_at) VALUES ('op1', 'load', 'small', 'test', 'done', ?, ?), ('op2', 'unload', 'small', 'test', 'failed', ?, ?)",
	).run(clock.now.toISOString(), clock.now.toISOString(), clock.now.toISOString(), clock.now.toISOString());
	clock.now = new Date(2026, 9, 4, 13, 0);
	a.tick();
	a.tick();
	assert.deepEqual(ledger(db), [
		{ kind: "awake", amount: -0.02, ref: null },
		{ kind: "stm_write", amount: -0.005, ref: e2 },
		{ kind: "model_load", amount: -0.025, ref: "op1" },
	]);
	mode = "asleep";
	clock.now = new Date(2026, 9, 4, 14, 0);
	a.tick();
	assert.equal(ledger(db).length, 3, "asleep is not awake time");
	mode = "awake";
	clock.now = new Date(2026, 9, 4, 19, 0); // the host was off for 5 h
	a.tick();
	assert.deepEqual(ledger(db).at(-1), { kind: "awake", amount: -0.04, ref: null }, "at most maxGapMs of a gap");
	a.stop();
	db.close();
});

/**
 * The calibration check (S2 review): a rest-window night ends in minutes, so Iyye is awake about 24 h.
 * A typical day here must not reach the wind-down level before the window; a heavy day may.
 */
function simulateDay(turns: number): { tiredAt: Date | null; levelAtWindow: number } {
	const db = openDb(":memory:");
	const clock = { now: new Date(2026, 9, 4, 2, 5) }; // the night just ended
	const a = energy(db, clock);
	a.start();
	for (const [i, op] of ["chat", "chat-2", "background"].entries()) {
		db.prepare(
			"INSERT INTO model_ops (id, op, model_name, requested_by, state, started_at, finished_at) VALUES (?, 'load', ?, 'waking', 'done', ?, ?)",
		).run(`load-${i}`, op, clock.now.toISOString(), clock.now.toISOString());
	}
	const end = new Date(2026, 9, 5, 2, 0);
	const step = 5 * 60_000;
	const turnEvery = Math.floor((16 * 3_600_000) / turns); // turns spread over 08:00–24:00
	let next = new Date(2026, 9, 4, 8, 0).getTime();
	let tiredAt: Date | null = null;
	while (clock.now < end) {
		clock.now = new Date(clock.now.getTime() + step);
		while (next <= clock.now.getTime() && next < new Date(2026, 9, 5, 0, 0).getTime()) {
			const id = turn(db, "a turn", new Date(next).toISOString());
			a.deviceTime("chat", 3 * 60_000, `${id}:1`); // a few minutes of chat device time per turn
			next += turnEvery;
		}
		a.tick();
		if (!tiredAt && a.tired()) tiredAt = new Date(clock.now);
	}
	const levelAtWindow = a.level();
	a.stop();
	db.close();
	return { tiredAt, levelAtWindow };
}

test("calibration: a typical day (10 turns) never naps before the rest window; a heavy day (40 turns) does", () => {
	const typical = simulateDay(10);
	assert.equal(typical.tiredAt, null, `tired at ${typical.tiredAt}`);
	assert.ok(
		typical.levelAtWindow > 0.15 && typical.levelAtWindow < 0.45,
		`level at the window ${typical.levelAtWindow}`,
	);
	const heavy = simulateDay(40);
	assert.ok(heavy.tiredAt !== null, "a heavy day reaches the wind-down level");
});

test("a refill charges what happened since the last sweep before moving the watermark", () => {
	const db = openDb(":memory:");
	const clock = { now: new Date(2026, 9, 4, 12, 0) };
	const a = energy(db, clock);
	clock.now = new Date(2026, 9, 4, 12, 1);
	const e = turn(db, "just now", clock.now.toISOString());
	a.refill(0.5, "refill_partial");
	assert.deepEqual(
		ledger(db).map((l) => [l.kind, l.ref]),
		[
			["stm_write", e],
			["refill_partial", null],
		],
	);
	db.close();
});

describe("background work and energy", () => {
	const make = (db: Db, clock: { now: Date }, a: Adenosine, turnImpl: (req: TurnRequest) => Promise<TurnResult>) => {
		const device = new DeviceSlot();
		const worker = new BackgroundWorker({
			db,
			device,
			models: {
				selected: () => "m",
				acquire: async () => ({ model: "m", valid: () => true, release: () => {} }),
			},
			conversations: { turn: turnImpl, sessionFile: () => "x" },
			chatPending: () => false,
			log: silentLogger,
			energy: a,
			now: () => clock.now,
			quietMs: 0,
			gapMs: 0,
			pollMs: 60_000,
			watchMs: 10,
		});
		return { device, worker };
	};

	test("below the reserve no step starts; a step pays its device time and its completion; a pause for a person pays one focus switch", async () => {
		const db = openDb(":memory:");
		const clock = { now: new Date(2026, 9, 4, 12, 0) };
		const a = energy(db, clock);
		a.charge("device_background", 0.7); // level 0.30
		let release: (() => void) | null = null;
		const { device, worker } = make(db, clock, a, async (req) => {
			clock.now = new Date(clock.now.getTime() + 2 * 60_000); // 2 minutes of device time
			if (req.text === "wait for a person") {
				await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve()));
				return { ok: false, reason: "aborted", message: "aborted" };
			}
			return { ok: true, text: "done", model: "m" };
		});
		const id = worker.enqueue({ origin: "test", prompt: "measure" });
		assert.equal(await worker.drainOnce(), false);
		assert.match(worker.status().waiting, /energy is low \(adenosine 0\.30\): background work waits for the night/);

		a.refill(1, "refill_night");
		db.prepare("DELETE FROM energy_ledger").run();
		assert.equal(await worker.drainOnce(), true);
		assert.equal(getBackgroundJob(db, id)!.status, "settled");
		assert.deepEqual(ledger(db), [
			{ kind: "device_background", amount: -0.04, ref: `${id}:1` },
			{ kind: "background_step", amount: -0.01, ref: id },
		]);

		db.prepare("DELETE FROM energy_ledger").run();
		const p = worker.enqueue({ origin: "test", prompt: "wait for a person" });
		const run = worker.drainOnce();
		await waitFor(() => device.holder !== null);
		const waiting = device.acquire("chat:x");
		await run;
		release = await waiting;
		release();
		assert.equal(getBackgroundJob(db, p)!.status, "paused");
		assert.deepEqual(ledger(db), [
			{ kind: "device_background", amount: -0.04, ref: `${p}:1` },
			{ kind: "focus_switch", amount: -0.01, ref: `${p}:pause:1` },
		]);
		db.close();
	});
});

describe("the owner is never refused", () => {
	let sb: Sandbox;
	let s: Stack | null = null;
	afterEach(async () => {
		await s?.stop();
		s = null;
		sb?.cleanup();
	});

	test("at adenosine 0 the owner's message is answered, and its device time is charged once", async () => {
		sb = sandbox();
		let a: Adenosine | null = null;
		s = await startStack(sb, {
			onDeviceTime: (jobId, ms) => a?.deviceTime("chat", ms, jobId),
		});
		a = new Adenosine({ db: s.db, log: silentLogger, mode: () => "awake" });
		a.charge("device_background", 5);
		assert.equal(a.level(), 0);
		const r = admitOwnerWebMessage(
			{ db: s.db, now: () => new Date(), newId: () => crypto.randomUUID() },
			{ clientMsgId: "tired-msg-1", text: "are you there?" },
		);
		assert.ok(r.outcome === "admitted");
		s.scheduler.wake();
		await waitFor(() => getEvent(s!.db, r.eventId)!.status === "answered", 5000);
		const chat = ledger(s.db).filter((l) => l.kind === "device_chat");
		assert.equal(chat.length, 1);
	});
});

describe("tired sleep and refills", () => {
	const done: NightOutcome = { kind: "done", completed: 0, empty: 0, failed: 0, consolidated: [] };
	function rig(night: (stop: () => boolean) => Promise<NightOutcome> = async () => done) {
		const db = openDb(":memory:");
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('owner', 'Owner', 'owner', 't') ON CONFLICT DO NOTHING",
		).run();
		const clock = { now: new Date(2026, 9, 4, 15, 0) }; // outside the 02:00–06:00 window
		const notices: string[] = [];
		let rhythm: Rhythm | null = null;
		const a = new Adenosine({ db, log: silentLogger, mode: () => rhythm!.mode(), now: () => clock.now });
		rhythm = new Rhythm({
			db,
			window: parseWindow("02:00-06:00"),
			night: { run: night },
			turnRunning: () => false,
			notify: (t) => notices.push(t),
			log: silentLogger,
			now: () => clock.now,
			tickMs: 20,
			energy: a,
			minRestMs: 30 * 60_000,
		});
		return { db, clock, notices, a, rhythm };
	}

	test("below the wind-down level Iyye sleeps at the next quiet moment, naps at least minRestMs, and a completed night refills to 1", async () => {
		const { db, clock, notices, a, rhythm } = rig();
		a.charge("device_background", 0.9); // 0.10
		turn(db, "still talking", clock.now.toISOString()); // the owner was just active
		rhythm.tick();
		assert.equal(rhythm.mode(), "awake", "not while the owner is active");
		assert.match(
			rhythm.describeDay(0),
			/next sleep: tired \(adenosine is low\), once you have been quiet 15 more min/,
		);
		assert.match(rhythm.describeDay(0), /energy: adenosine 0\.10: tired, sleeps at the next quiet moment/);

		clock.now = new Date(2026, 9, 4, 15, 16);
		rhythm.tick();
		await waitFor(() => rhythm.mode() === "asleep");
		assert.deepEqual(notices, ["starting sleep (tired: adenosine is low)"]);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(rhythm.mode(), "asleep", "the nap lasts at least minRestMs, even with no work");
		clock.now = new Date(2026, 9, 4, 15, 47);
		await waitFor(() => rhythm.mode() === "awake");
		assert.equal(a.level(), 1);
		assert.match(notices[1]!, /^waking up day 2/);
		await rhythm.stop();
		db.close();
	});

	test("a night the owner interrupts refills in proportion to the night it had", async () => {
		const { db, clock, a, rhythm } = rig(async (stop) => {
			// Stores two of the four conversations, then waits until it must stop.
			for (const id of ids.slice(0, 2)) leaveStm(db, id, "completed", clock.now.toISOString());
			while (!stop()) await new Promise((r) => setTimeout(r, 10));
			return { kind: "stopped", completed: 2, empty: 0, failed: 0 };
		});
		const ids = [1, 2, 3, 4].map((i) => turn(db, `fact ${i}`, new Date(2026, 9, 4, 14, i).toISOString()));
		a.charge("device_background", 0.9); // 0.10
		rhythm.sleep("the owner asked");
		await waitFor(() => rhythm.mode() === "asleep");
		await waitFor(
			() =>
				(db.prepare("SELECT count(*) AS n FROM stm_episodes WHERE state = 'day'").get() as { n: number }).n === 2,
		);
		clock.now = new Date(2026, 9, 4, 15, 10); // 10 min of a 4 h window: the work share (2 of 4) is larger
		rhythm.wakeForOwner("the owner wrote");
		assert.equal(Math.round(a.level() * 100), 55, "0.10 + 0.90 × 0.5");
		assert.deepEqual(ledger(db).at(-1)!.kind, "refill_partial");
		await rhythm.stop();
		db.close();
	});
});

test("/energy says where the energy went and what the level allows", async () => {
	const db = openDb(":memory:");
	const clock = { now: new Date(2026, 9, 4, 12, 0) };
	const a = energy(db, clock);
	a.charge("stm_write", DEFAULT_CHARGES.stmWrite, "e1");
	a.charge("device_chat", 0.02, "j1:1");
	a.charge("awake", 0.04);
	const reply = (
		await handleOwnerCommand("/energy", {
			models: {} as never,
			db,
			issuer: "owner_web",
			energyReport: () => a.report(),
		})
	).reply;
	assert.match(
		reply,
		/^adenosine 0\.93: background work allowed \(reserve 0\.35\); tired \(below 0\.15\) near \d\d:\d\d at this rate/,
	);
	assert.match(reply, /owner chat is never refused for low energy/);
	assert.match(
		reply,
		/last 24 h, spent on:\n {2}time awake: 0\.040 \(1×\)\n {2}chat device time: 0\.020 \(1×\)\n {2}short-term memory entries \(conversations, findings, summaries\): 0\.005 \(1×\)/,
	);
	db.close();
});
