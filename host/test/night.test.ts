// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.002 L4/L5: day and night. Asleep, Iyye moves short-term memory into
 * long-term memory and clears it; awake, no memory work runs.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { admitOwnerWebMessage, admitTelegramUpdate } from "../src/kernel/admission.ts";
import { parseWindow, Rhythm, windowStartFor } from "../src/kernel/rhythm.ts";
import { silentLogger } from "../src/log.ts";
import type { GateResult } from "../src/memory/gate.ts";
import { REPLY_STRATEGY, VERBATIM_STRATEGY } from "../src/memory/hindsight.ts";
import {
	type NightOutcome,
	NightWork,
	OBSERVATIONS_MISSION,
	REPLY_MISSION,
	RETAIN_MISSION,
} from "../src/memory/night.ts";
import type { ModelManager } from "../src/models/manager.ts";
import { createContactWithBinding } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { getKv } from "../src/state/kv.ts";
import { endDay, recordEpisode, searchStm } from "../src/state/stm.ts";
import { FakeLtm } from "./fixtures/fake-ltm.ts";
import { FakeTelegram } from "./fixtures/fake-telegram.ts";
import { managerRig, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";
import { type Stack, startStack } from "./web-helpers.ts";

let seq = 0;

/** An answered turn, as the outbox records it. */
function episode(db: Db, scope: string, text: string, saidAt = new Date().toISOString()): string {
	const id = `e${++seq}`;
	const contact = scope === "owner" ? "owner" : scope.slice("contact:".length);
	const channel = scope === "owner" ? "web" : "telegram";
	const payload = channel === "web" ? { text } : { message: { text, chatId: 1 } };
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'answered')",
	).run(id, id, channel, contact, scope, saidAt, JSON.stringify(payload));
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, ?)",
	).run(`a-${id}`, id, `k-${id}`, saidAt, `noted: ${text}`);
	recordEpisode(db, getEvent(db, id)!, { id: `a-${id}`, content: `noted: ${text}` }, saidAt);
	return id;
}

const states = (db: Db) =>
	Object.fromEntries(
		(db.prepare("SELECT event_id, state FROM stm_episodes").all() as { event_id: string; state: string }[]).map(
			(r) => [r.event_id, r.state],
		),
	);

/** A gate that always admits, recording each operation and its reasoning setting. */
function openGate(log: { label: string; thinking: boolean | undefined }[] = []) {
	return {
		problem: null as string | null,
		async run<T>(
			label: string,
			fn: (model: string) => Promise<T>,
			opts?: { thinking?: boolean },
		): Promise<GateResult<T>> {
			log.push({ label, thinking: opts?.thinking });
			return { ok: true, value: await fn("mem-model"), model: "mem-model" };
		},
	};
}

describe("the night's memory work", () => {
	const ltm = new FakeLtm();
	let db: Db;
	before(() => ltm.start());
	after(() => ltm.stop());
	beforeEach(() => {
		db = openDb(":memory:");
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('owner', 'Owner', 'owner', 't') ON CONFLICT DO NOTHING",
		).run();
	});
	afterEach(() => {
		db.close();
		ltm.reset();
	});

	test("each episode is retained into its scope's bank, then leaves STM; facts get consolidated", async () => {
		const alex = createContactWithBinding(db, {
			id: "alexid",
			displayName: "Alex",
			channel: "telegram",
			externalId: "7",
			verifiedBy: "first_contact",
			at: "t",
		});
		const e1 = episode(db, "owner", "My daughter Julia has violin on Tuesdays");
		const e2 = episode(db, "owner", "What's 2+2?");
		const e3 = episode(db, `contact:${alex.id}`, "I moved to Berlin");
		const gateLog: { label: string; thinking: boolean | undefined }[] = [];
		const night = new NightWork({
			db,
			ltm: ltm.client(),
			gate: openGate(gateLog),
			log: silentLogger,
			thinking: true,
		});
		const r = await night.run(() => false);
		assert.deepEqual(r, {
			kind: "done",
			completed: 2,
			empty: 1,
			failed: 0,
			consolidated: ["iyye-owner", "iyye-contact-alexid"],
		});
		assert.deepEqual(states(db), { [e1]: "completed", [e2]: "completed_empty", [e3]: "completed" });
		assert.deepEqual(searchStm(db, ["owner", "contact:alexid"], "Julia Berlin"), [], "STM is cleared");
		// Provenance by construction: one document per speaker, tagged by the host.
		const said = ltm.docs.get(`iyye-owner/${e1}:said`)!;
		assert.equal(
			said.content,
			"My daughter Julia has violin on Tuesdays",
			"the person's words only, nothing of Iyye's",
		);
		assert.ok(!said.context.includes("noted"), "no Iyye text in the context either");
		assert.match(said.context, /the owner wrote this to Iyye/);
		assert.deepEqual(said.tags, ["scope:owner", "channel:web", "speaker:person"]);
		assert.equal(said.strategy, null, "extracted with the bank's default");
		const replied = ltm.docs.get(`iyye-owner/${e1}:replied`)!;
		assert.equal(replied.content, "noted: My daughter Julia has violin on Tuesdays");
		assert.deepEqual(replied.tags, ["scope:owner", "channel:web", "speaker:iyye"]);
		// Not verbatim (2026-10-06): the important things Iyye told them, extracted under the reply mission,
		// dated and attributed; the context names the date and what they had asked.
		assert.equal(replied.strategy, REPLY_STRATEGY);
		assert.match(
			replied.context,
			/^Iyye's own reply to the owner on \d{4}-\d\d-\d\d \(local web chat\)\. the owner had written: "My daughter Julia has violin on Tuesdays"\. These are Iyye's words: not evidence about the owner\.$/,
		);
		assert.equal(ltm.docs.get(`iyye-contact-alexid/${e3}:said`)!.content, "I moved to Berlin");
		assert.match(ltm.docs.get(`iyye-contact-alexid/${e3}:said`)!.context, /the contact "Alex" wrote this/);
		assert.equal(ltm.banks.get("iyye-owner")!.mission, RETAIN_MISSION);
		const owner = ltm.banks.get("iyye-owner")!;
		assert.deepEqual(owner.strategies, {
			[VERBATIM_STRATEGY]: { retain_extraction_mode: "chunks" },
			[REPLY_STRATEGY]: { retain_mission: REPLY_MISSION },
		});
		// No observations from Iyye's words or its probes, in any bank: by tag, with a cap of 0.
		assert.deepEqual(owner.consolidation, [
			{ scopes: [{ tags: ["speaker:iyye"] }, { tags: ["speaker:probe"] }], max_observations_per_scope: 0 },
		]);
		assert.equal(owner.observations, true);
		assert.equal(owner.observationsMission, OBSERVATIONS_MISSION);
		assert.deepEqual(ltm.consolidations, ["iyye-owner", "iyye-contact-alexid"]);
		assert.deepEqual(
			gateLog.map((g) => `${g.label.split(":")[0]}:${g.thinking}`),
			["retain:true", "retain:true", "retain:true", "consolidate:undefined", "consolidate:undefined"],
			"extraction thinks, consolidation does not",
		);
	});

	test("a crash after retaining but before leaving STM retains the same document again, never a duplicate", async () => {
		const e1 = episode(db, "owner", "The boiler was serviced in May");
		const night = new NightWork({ db, ltm: ltm.client(), gate: openGate(), log: silentLogger });
		await night.run(() => false);
		// Simulate the crash window: the episode is back in STM as if leaveStm never committed.
		db.prepare("UPDATE stm_episodes SET state = 'day', transferred_at = NULL WHERE event_id = ?").run(e1);
		await new NightWork({ db, ltm: ltm.client(), gate: openGate(), log: silentLogger }).run(() => false);
		assert.deepEqual(ltm.retains, [`${e1}:said`, `${e1}:replied`, `${e1}:said`, `${e1}:replied`]);
		assert.deepEqual([...ltm.docs.keys()].filter((k) => k.includes(e1)).sort(), [
			`iyye-owner/${e1}:replied`,
			`iyye-owner/${e1}:said`,
		]);
		assert.equal(states(db)[e1], "completed");
	});

	test("short-term memory is today only: what a night cannot store leaves it for the backlog, retried at most three nights", async () => {
		const e1 = episode(db, "owner", "Julia's recital is on Friday");
		ltm.failRetain = true;
		const r1 = await new NightWork({ db, ltm: ltm.client(), gate: openGate(), log: silentLogger }).run(() => false);
		assert.equal(r1.kind, "done");
		assert.equal(states(db)[e1], "day", "still today's until the night ends");
		assert.deepEqual(endDay(db, new Date(), 7), { toBacklog: 1, dropped: 0 });
		assert.equal(states(db)[e1], "backlog");
		assert.equal(searchStm(db, ["owner"], "recital").length, 0, "not recallable: it left short-term memory");
		const e2 = episode(db, "owner", "The new day's fact");
		for (let night = 2; night <= 3; night++) {
			await new NightWork({ db, ltm: ltm.client(), gate: openGate(), log: silentLogger }).run(() => false);
			endDay(db, new Date(), 7);
		}
		assert.equal(states(db)[e1], "failed", "dropped after three attempts");
		assert.equal(states(db)[e2], "backlog", "the next day's entry has had two attempts");
		ltm.failRetain = false;
		await new NightWork({ db, ltm: ltm.client(), gate: openGate(), log: silentLogger }).run(() => false);
		assert.equal(states(db)[e2], "completed", "the backlog is stored first when it can be");
	});

	test("backlog entries older than the age limit are dropped at the end of a night", () => {
		const old = episode(db, "owner", "ancient", new Date(Date.now() - 9 * 86_400_000).toISOString());
		const recent = episode(db, "owner", "yesterday", new Date(Date.now() - 86_400_000).toISOString());
		assert.deepEqual(endDay(db, new Date(), 7), { toBacklog: 2, dropped: 0 });
		assert.deepEqual(endDay(db, new Date(), 7), { toBacklog: 0, dropped: 1 });
		assert.deepEqual([states(db)[old], states(db)[recent]], ["failed", "backlog"]);
	});

	test("Hindsight unreachable: the night stops, says why, and charges no attempt", async () => {
		const e1 = episode(db, "owner", "Julia's recital is on Friday");
		const client = new FakeLtm().client(); // never started: connection refused
		const r = await new NightWork({ db, ltm: client, gate: openGate(), log: silentLogger }).run(() => false);
		assert.equal(r.kind, "blocked");
		assert.match((r as Extract<NightOutcome, { kind: "blocked" }>).reason, /unreachable/);
		assert.deepEqual(db.prepare("SELECT state, attempts FROM stm_episodes WHERE event_id = ?").get(e1), {
			state: "day",
			attempts: 0,
		});
	});

	test("the memory model cannot load: the night stops with the gate's reason", async () => {
		episode(db, "owner", "something");
		const gate = {
			problem: "memory model x not loaded: at most 2 model(s) may be loaded",
			run: async () => ({
				ok: false as const,
				busy: false,
				message: "memory model x not loaded: at most 2 model(s) may be loaded",
			}),
		};
		const r = await new NightWork({ db, ltm: ltm.client(), gate, log: silentLogger }).run(() => false);
		assert.deepEqual(r, {
			kind: "blocked",
			reason: "memory model x not loaded: at most 2 model(s) may be loaded",
			completed: 0,
			empty: 0,
			failed: 0,
		});
	});

	test("owner input stops the night between episodes; the rest stays in STM", async () => {
		const ids = [
			episode(db, "owner", "fact one"),
			episode(db, "owner", "fact two"),
			episode(db, "owner", "fact three"),
		];
		let stop = false;
		const gate = openGate();
		const run = gate.run.bind(gate);
		gate.run = async (label, fn, opts) => {
			const r = await run(label, fn, opts);
			stop = true; // the owner wrote during the first retain
			return r;
		};
		const r = await new NightWork({ db, ltm: ltm.client(), gate, log: silentLogger }).run(() => stop);
		assert.equal(r.kind, "stopped");
		assert.deepEqual(states(db), { [ids[0]!]: "completed", [ids[1]!]: "day", [ids[2]!]: "day" });
		assert.deepEqual(
			JSON.parse(getKv(db, "memory.banks_to_consolidate")!),
			["iyye-owner"],
			"consolidation is still owed",
		);
	});
});

describe("day and night", () => {
	test("rest windows, including ones that wrap past midnight", () => {
		const w = parseWindow("02:00-06:00");
		assert.deepEqual(w, { startMin: 120, endMin: 360 });
		assert.equal(windowStartFor(new Date(2026, 9, 3, 1, 59), w), null);
		assert.deepEqual(windowStartFor(new Date(2026, 9, 3, 3, 0), w), new Date(2026, 9, 3, 2, 0));
		const wrap = parseWindow("23:00-05:00");
		assert.deepEqual(windowStartFor(new Date(2026, 9, 3, 1, 0), wrap), new Date(2026, 9, 2, 23, 0));
		assert.deepEqual(windowStartFor(new Date(2026, 9, 3, 23, 30), wrap), new Date(2026, 9, 3, 23, 0));
		assert.throws(() => parseWindow("2-6"));
		assert.throws(() => parseWindow("25:00-06:00"));
	});

	function rig(opts: {
		now: Date;
		night?: (stop: () => boolean) => Promise<NightOutcome>;
		turnRunning?: () => boolean;
	}) {
		const db = openDb(":memory:");
		const clock = { now: opts.now };
		const notices: string[] = [];
		const done: NightOutcome = { kind: "done", completed: 1, empty: 0, failed: 0, consolidated: [] };
		const rhythm = new Rhythm({
			db,
			window: parseWindow("02:00-06:00"),
			night: { run: opts.night ?? (async () => done) },
			turnRunning: opts.turnRunning ?? (() => false),
			notify: (t) => notices.push(t),
			log: silentLogger,
			now: () => clock.now,
			tickMs: 3_600_000,
		});
		return { db, clock, notices, rhythm };
	}
	const settle = () => new Promise((r) => setTimeout(r, 30));

	test("falls asleep in the rest window, runs the night, wakes on day 2, and not again in the same window", async () => {
		const { notices, rhythm, db } = rig({ now: new Date(2026, 9, 3, 2, 30) });
		assert.equal(rhythm.mode(), "awake");
		rhythm.tick();
		await settle();
		assert.equal(rhythm.mode(), "awake");
		assert.equal(rhythm.day(), 2);
		assert.deepEqual(notices, [
			"starting sleep (rest window)",
			"waking up day 2 — 1 conversation(s) moved to long-term memory, 0 with nothing worth keeping.",
		]);
		rhythm.tick();
		await settle();
		assert.equal(notices.length, 2, "one night per window");
		db.close();
	});

	test("stays awake in the window while the owner is talking, and outside it", async () => {
		const { rhythm, db } = rig({ now: new Date(2026, 9, 3, 2, 30) });
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('owner', 'Owner', 'owner', 't') ON CONFLICT DO NOTHING",
		).run();
		db.prepare(
			"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('x', 'x', 'web', 'owner', 'owner', ?, '{}', 'answered')",
		).run(new Date(2026, 9, 3, 2, 25).toISOString());
		rhythm.tick();
		await settle();
		assert.equal(rhythm.day(), 1, "the owner wrote 5 minutes ago");
		db.close();
		const outside = rig({ now: new Date(2026, 9, 3, 14, 0) });
		outside.rhythm.tick();
		await settle();
		assert.equal(outside.rhythm.day(), 1);
		outside.db.close();
	});

	test("catch-up: STM older than a day with no night for a day sleeps outside the window", async () => {
		const now = new Date(2026, 9, 3, 14, 0);
		const { rhythm, db, notices } = rig({ now });
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('owner', 'Owner', 'owner', 't') ON CONFLICT DO NOTHING",
		).run();
		episode(db, "owner", "old news", new Date(now.getTime() - 30 * 3600_000).toISOString());
		rhythm.tick();
		await settle();
		assert.match(notices[0]!, /starting sleep \(catch-up/);
		assert.equal(rhythm.day(), 2);
		db.close();
	});

	test("winding down waits for the running turn; owner input wakes Iyye without advancing the day", async () => {
		let turn = true;
		let stopSeen = false;
		let release: () => void = () => {};
		const { rhythm, notices, db } = rig({
			now: new Date(2026, 9, 3, 14, 0),
			turnRunning: () => turn,
			night: async (stop) => {
				await new Promise<void>((r) => {
					release = r;
				});
				stopSeen = stop();
				return { kind: "stopped", completed: 0, empty: 0, failed: 0 };
			},
		});
		assert.equal(rhythm.sleep("the owner asked"), "starting sleep");
		await settle();
		assert.equal(rhythm.mode(), "winding_down", "a chat turn is still running");
		turn = false;
		await new Promise((r) => setTimeout(r, 600));
		assert.equal(rhythm.mode(), "asleep");
		assert.equal(rhythm.wakeForOwner("the owner wrote"), "awake");
		release();
		await settle();
		assert.equal(stopSeen, true);
		assert.equal(rhythm.mode(), "awake");
		assert.equal(rhythm.day(), 1);
		assert.equal(rhythm.lastNight(), null, "the night is still owed");
		assert.match(notices.at(-1)!, /^waking up day 1 \(the owner wrote; the night's work continues later\)/);
		db.close();
	});

	test("/wake in the window holds: the next tick does not fall straight back asleep", async () => {
		const nights: string[] = [];
		let finished = false;
		const { rhythm, db, clock } = rig({
			now: new Date(2026, 9, 3, 3, 0),
			night: async (stop) => {
				nights.push("night");
				while (!stop() && !finished) await new Promise((r) => setTimeout(r, 5));
				return { kind: "stopped", completed: 0, empty: 0, failed: 0 };
			},
		});
		rhythm.tick();
		await settle();
		assert.equal(rhythm.mode(), "asleep");
		assert.equal(rhythm.wakeForOwner("the owner asked"), "awake");
		await settle(); // the interrupted night has returned
		clock.now = new Date(2026, 9, 3, 3, 2);
		rhythm.tick();
		await settle();
		try {
			assert.equal(rhythm.mode(), "awake", "the owner was active 2 minutes ago");
			assert.deepEqual(nights, ["night"]);
		} finally {
			finished = true;
			await settle();
			db.close();
		}
	});

	test("a completed night starts conversations afresh before waking; a night the owner interrupts does not", async () => {
		const resets: string[] = [];
		const make = (night: (stop: () => boolean) => Promise<NightOutcome>) => {
			const db = openDb(":memory:");
			const notices: string[] = [];
			const r = new Rhythm({
				db,
				window: parseWindow("02:00-06:00"),
				night: { run: night },
				turnRunning: () => false,
				notify: (t) => notices.push(t),
				log: silentLogger,
				now: () => new Date(2026, 9, 3, 14, 0),
				tickMs: 3_600_000,
				onNightEnd: async () => {
					resets.push(r.mode()); // still asleep: no turn can run during the reset
				},
			});
			return { db, r, notices };
		};
		const done = make(async () => ({ kind: "done", completed: 1, empty: 0, failed: 0, consolidated: [] }));
		done.r.sleep("the owner asked");
		await waitFor(() => done.r.mode() === "awake");
		assert.deepEqual(resets, ["asleep"]);
		assert.match(
			done.notices.at(-1)!,
			/^waking up day 2 — .* Conversations start afresh; earlier days are in memory\.$/,
		);
		done.db.close();

		const interrupted = make(async (stop) => {
			while (!stop()) await new Promise((x) => setTimeout(x, 5));
			return { kind: "stopped", completed: 0, empty: 0, failed: 0 };
		});
		interrupted.r.sleep("the owner asked");
		await waitFor(() => interrupted.r.mode() === "asleep");
		interrupted.r.wakeForOwner("the owner wrote");
		await new Promise((x) => setTimeout(x, 50));
		assert.deepEqual(resets, ["asleep"], "no reset for an interrupted night");
		interrupted.db.close();
	});

	test("a restart in the middle of the night resumes it", async () => {
		const first = rig({ now: new Date(2026, 9, 3, 14, 0), night: () => new Promise(() => {}) });
		first.rhythm.sleep("the owner asked");
		await settle();
		assert.equal(first.rhythm.mode(), "asleep");
		// A new host on the same database: the night runs to completion.
		const runs: string[] = [];
		const second = new Rhythm({
			db: first.db,
			window: parseWindow("02:00-06:00"),
			night: {
				run: async () => {
					runs.push("night");
					return { kind: "done", completed: 0, empty: 0, failed: 0, consolidated: [] };
				},
			},
			turnRunning: () => false,
			notify: () => {},
			log: silentLogger,
			now: () => new Date(2026, 9, 3, 14, 5),
			tickMs: 3_600_000,
		});
		second.start();
		await settle();
		await second.stop();
		assert.deepEqual(runs, ["night"]);
		assert.equal(second.mode(), "awake");
		assert.equal(second.day(), 2);
		first.db.close();
	});
});

describe("/day and /night", () => {
	function status(now: Date, night?: (stop: () => boolean) => Promise<NightOutcome>) {
		const db = openDb(":memory:");
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('owner', 'Owner', 'owner', 't') ON CONFLICT DO NOTHING",
		).run();
		const clock = { now };
		const rhythm = new Rhythm({
			db,
			window: parseWindow("02:00-06:00"),
			night: {
				run:
					night ??
					(async () => ({ kind: "done", completed: 3, empty: 1, failed: 0, consolidated: ["iyye-owner"] })),
			},
			turnRunning: () => false,
			notify: () => {},
			log: silentLogger,
			now: () => clock.now,
			tickMs: 3_600_000,
			models: {
				restForNight: async () => ({ ok: true, message: "" }),
				wakeFromNight: async () => ({ ok: true, message: "" }),
			},
		});
		return { db, clock, rhythm };
	}
	const live = { deviceHolder: null, stmWaiting: 0, problem: null };

	test("/day: awake in the afternoon, next sleep at the window, no night yet", () => {
		const { db, rhythm } = status(new Date(2026, 9, 3, 14, 0));
		episode(db, "owner", "Julia violin");
		assert.equal(
			rhythm.describeDay(1),
			[
				"awake · day 1 · rest window 02:00–06:00",
				"next sleep: 2026-10-04 02:00 (rest window)",
				"short-term memory (today): 1 conversation(s) waiting for the night",
				"last night: none yet",
			].join("\n"),
		);
		assert.equal(rhythm.describeNight(live), "awake: no night in progress\nlast night: none yet");
		db.close();
	});

	test("/day in the window: the night is due once the owner is quiet; catch-up is explained", () => {
		const { db, rhythm, clock } = status(new Date(2026, 9, 3, 2, 30));
		db.prepare(
			"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('o1', 'o1', 'web', 'owner', 'owner', ?, '{}', 'answered')",
		).run(new Date(2026, 9, 3, 2, 25).toISOString());
		assert.match(rhythm.describeDay(0), /next sleep: tonight's night is due, once you have been quiet 10 more min/);
		clock.now = new Date(2026, 9, 3, 2, 45);
		assert.match(rhythm.describeDay(0), /next sleep: tonight's night is due, now \(within 30 s\)/);
		clock.now = new Date(2026, 9, 3, 15, 0);
		episode(db, "owner", "old", new Date(2026, 9, 2, 9, 0).toISOString());
		assert.match(rhythm.describeDay(1), /next sleep: catch-up \(short-term memory since 2026-10-02 09:00\), now/);
		db.close();
	});

	test("/night while asleep shows what it is doing; afterwards the last night's result", async () => {
		let release: () => void = () => {};
		const { db, rhythm, clock } = status(new Date(2026, 9, 3, 2, 30), async () => {
			await new Promise<void>((r) => {
				release = r;
			});
			return { kind: "done", completed: 3, empty: 1, failed: 0, consolidated: ["iyye-owner"] };
		});
		rhythm.tick();
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(
			rhythm.describeNight({ deviceHolder: "memory:retain:e9", stmWaiting: 4, problem: null }),
			[
				"asleep since 02:30 (rest window)",
				"now: moving a conversation into long-term memory",
				"left to store: 4 conversation(s) (today's and the backlog)",
				"chat models are unloaded until waking; only the memory model may be loaded",
				"last night: none yet",
			].join("\n"),
		);
		assert.match(
			rhythm.describeDay(4),
			/^asleep · day 1 · rest window 02:00–06:00\nsleeping since 02:30 \(rest window\); see \/night/,
		);
		clock.now = new Date(2026, 9, 3, 3, 10);
		release();
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(
			rhythm.describeNight(live),
			[
				"awake: no night in progress",
				"last night: 02:30 – 03:10 (40 min), rest window",
				"  3 conversation(s) moved to long-term memory, 1 with nothing worth keeping; consolidated 1 bank(s).",
			].join("\n"),
		);
		assert.match(rhythm.describeDay(0), /next sleep: 2026-10-04 02:00 \(rest window\)[\s\S]*last night: ended 03:10/);
		db.close();
	});

	test("/day and /night are owner commands", async () => {
		const { handleOwnerCommand, isKnownCommand } = await import("../src/kernel/commands.ts");
		assert.ok(isKnownCommand("/day") && isKnownCommand("/night"));
		const ctx = {
			models: {} as ModelManager,
			db: openDb(":memory:"),
			issuer: "owner_web",
			rhythmReport: { day: () => "D", night: () => "N" },
		};
		assert.equal((await handleOwnerCommand("/day", ctx)).reply, "D");
		assert.equal((await handleOwnerCommand("/night", ctx)).reply, "N");
		assert.match((await handleOwnerCommand("/help", ctx)).reply, /\/day — awake or asleep/);
		ctx.db.close();
	});
});

describe("asleep, end to end", () => {
	const fake = new FakeTelegram();
	let sb: Sandbox;
	let s: Stack | null = null;
	before(() => fake.start());
	after(() => fake.stop());
	afterEach(async () => {
		await s?.stop();
		s = null;
		sb?.cleanup();
	});

	test("contacts wait until waking; the owner's message wakes Iyye and both are answered; retries are held", async () => {
		sb = sandbox();
		let mode: "awake" | "asleep" = "asleep";
		const woken: string[] = [];
		const rhythm = {
			mode: () => mode,
			wakeForOwner: (why: string) => {
				woken.push(why);
				mode = "awake";
				return "awake";
			},
		};
		s = await startStack(sb, { rhythm }, { telegramApiBase: fake.apiBase, outboxHeld: () => mode === "asleep" });
		const deps = { db: s.db, now: () => new Date(), newId: () => crypto.randomUUID() };
		const contact = admitTelegramUpdate(deps, {
			updateId: 9001,
			message: {
				messageId: 1,
				chatId: 8001,
				chatType: "private",
				fromUserId: 8001,
				fromIsBot: false,
				username: null,
				firstName: "Ann",
				text: "hi at 3 am",
				dateUnix: null,
			},
		});
		assert.ok(contact.outcome === "admitted");
		s.scheduler.wake();
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(getEvent(s.db, contact.eventId)!.status, "admitted", "held while asleep");
		assert.equal(s.scheduler.hasRunnableJobs(), false, "a held contact job does not stall the night");
		assert.equal(await s.outbox.dispatchDue(), 0, "no retries while asleep");

		const owner = admitOwnerWebMessage(deps, { clientMsgId: "night-owner-1", text: "are you up?" });
		assert.ok(owner.outcome === "admitted");
		assert.equal(s.scheduler.hasRunnableJobs(), true, "the owner's job counts: it wakes Iyye");
		s.scheduler.wake();
		await waitFor(() => getEvent(s!.db, owner.eventId)!.status === "answered");
		await waitFor(() => getEvent(s!.db, contact.eventId)!.status === "answered");
		assert.deepEqual(woken, ["the owner wrote"]);
		assert.deepEqual(fake.messagesTo(8001), ["echo: hi at 3 am"]);
	});
});

describe("models at night", () => {
	const sb2 = sandbox();
	after(() => sb2.cleanup());
	const loaded = async (m: ModelManager) =>
		(await m.status()).models
			.filter((x) => x.status === "loaded")
			.map((x) => x.name)
			.sort();

	test("asleep only the memory model stays; a router restart reloads nothing else; waking brings the chat models back", async () => {
		const rig = await managerRig(sb2, { defaultMemoryModel: "small-2" });
		try {
			await rig.manager.start(); // loads "small" for web and telegram
			assert.ok((await rig.manager.load("small-2", "memory")).ok);
			assert.deepEqual(await loaded(rig.manager), ["small", "small-2"]);
			const rest = await rig.manager.restForNight(["small-2"], "night");
			assert.ok(rest.ok, rest.message);
			assert.deepEqual(await loaded(rig.manager), ["small-2"]);
			await rig.manager.restartRouter("test");
			assert.deepEqual(await loaded(rig.manager), [], "the chat models are not reloaded at night");
			const wake = await rig.manager.wakeFromNight("waking");
			assert.ok(wake.ok, wake.message);
			assert.deepEqual(await loaded(rig.manager), ["small"]);
		} finally {
			await rig.manager.stop();
			rig.db.close();
		}
	});

	test("a memory model that also serves chat stays loaded at waking", async () => {
		const rig = await managerRig(sb2, { defaultMemoryModel: "small" });
		try {
			await rig.manager.start();
			await rig.manager.restForNight(["small"], "night");
			assert.deepEqual(await loaded(rig.manager), ["small"]);
			await rig.manager.wakeFromNight("waking");
			assert.deepEqual(await loaded(rig.manager), ["small"]);
		} finally {
			await rig.manager.stop();
			rig.db.close();
		}
	});

	test("the rhythm rests the models when asleep and restores them on waking; jobs wait meanwhile", async () => {
		const db = openDb(":memory:");
		const calls: string[] = [];
		let releaseWake: () => void = () => {};
		const rhythm = new Rhythm({
			db,
			window: parseWindow("02:00-06:00"),
			night: {
				run: async () => {
					calls.push("night");
					return { kind: "done", completed: 0, empty: 0, failed: 0, consolidated: [] };
				},
			},
			turnRunning: () => false,
			notify: () => {},
			log: silentLogger,
			now: () => new Date(2026, 9, 3, 14, 0),
			tickMs: 3_600_000,
			models: {
				restForNight: async (keep) => {
					calls.push(`rest:${keep.join(",")}`);
					return { ok: true, message: "" };
				},
				wakeFromNight: async () => {
					calls.push("wake");
					await new Promise<void>((r) => {
						releaseWake = r;
					});
					return { ok: true, message: "" };
				},
			},
			keep: () => ["mem"],
		});
		rhythm.sleep("the owner asked");
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(calls, ["rest:mem", "night", "wake"]);
		assert.equal(rhythm.mode(), "awake");
		assert.equal(rhythm.restoring(), true, "jobs wait while the chat models load");
		releaseWake();
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(rhythm.restoring(), false);
		db.close();
	});

	test("after a restart the night waits until the router and long-term memory are up, and is not lost", async () => {
		const db = openDb(":memory:");
		let ready = false;
		const runs: string[] = [];
		const rhythm = new Rhythm({
			db,
			window: parseWindow("02:00-06:00"),
			night: {
				run: async () => {
					runs.push("night");
					return { kind: "done", completed: 0, empty: 0, failed: 0, consolidated: [] };
				},
			},
			turnRunning: () => false,
			notify: () => {},
			log: silentLogger,
			now: () => new Date(2026, 9, 3, 14, 0),
			tickMs: 3_600_000,
			ready: () => ready,
		});
		rhythm.sleep("the owner asked");
		await new Promise((r) => setTimeout(r, 300));
		assert.deepEqual(runs, [], "not ready: the night waits");
		assert.equal(rhythm.mode(), "asleep");
		assert.equal(rhythm.day(), 1, "nothing was lost or counted");
		ready = true;
		await waitFor(() => runs.length === 1, 3000);
		await waitFor(() => rhythm.mode() === "awake");
		assert.equal(rhythm.day(), 2);
		db.close();
	});

	test("an owner wake with no night running (at boot) still restores the models and clears the wait", async () => {
		const db = openDb(":memory:");
		const calls: string[] = [];
		const make = () =>
			new Rhythm({
				db,
				window: parseWindow("02:00-06:00"),
				night: null,
				turnRunning: () => false,
				notify: () => {},
				log: silentLogger,
				now: () => new Date(2026, 9, 3, 14, 0),
				tickMs: 3_600_000,
				models: {
					restForNight: async () => ({ ok: true, message: "" }),
					wakeFromNight: async () => {
						calls.push("wake");
						return { ok: true, message: "" };
					},
				},
			});
		db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('rhythm.mode', 'asleep', 't')").run();
		const booting = make(); // not started yet: the scheduler sees the owner's message first
		assert.equal(booting.wakeForOwner("the owner wrote"), "awake");
		await waitFor(() => !booting.restoring());
		assert.deepEqual(calls, ["wake"]);
		db.close();
	});

	test("a chat model lost by day is loaded again, and the waiting message is answered instead of failed (2026-10-05)", async () => {
		const sb = sandbox();
		const s = await startStack(sb, { modelWaitMs: 50 });
		try {
			assert.ok((await s.models.unload("small", "system")).ok);
			const ev = admitOwnerWebMessage(
				{ db: s.db, now: () => new Date(), newId: () => crypto.randomUUID() },
				{ clientMsgId: "heal-1", text: "hello" },
			);
			assert.ok(ev.outcome === "admitted");
			s.scheduler.wake();
			await waitFor(
				() =>
					(s.db.prepare("SELECT status FROM jobs WHERE id = ?").get(ev.jobId) as { status: string }).status ===
					"settled",
				8000,
			);
		} finally {
			await s.stop();
			sb.cleanup();
		}
	});

	test("a job whose model is missing waits while models are restored, and fails only after", async () => {
		const sb = sandbox();
		let restoring = true;
		const s = await startStack(sb, {
			modelWaitMs: 50,
			rhythm: { mode: () => "awake", wakeForOwner: () => "awake", restoring: () => restoring },
		});
		try {
			// Unloaded by the owner, so self-healing leaves it alone and only the restore wait applies.
			assert.ok((await s.models.unload("small", "owner_test")).ok);
			const ev = admitOwnerWebMessage(
				{ db: s.db, now: () => new Date(), newId: () => crypto.randomUUID() },
				{ clientMsgId: "restore-1", text: "hello" },
			);
			assert.ok(ev.outcome === "admitted");
			s.scheduler.wake();
			await new Promise((r) => setTimeout(r, 400));
			assert.equal(
				(s.db.prepare("SELECT status FROM jobs WHERE id = ?").get(ev.jobId) as { status: string }).status,
				"queued",
			);
			restoring = false;
			await waitFor(
				() =>
					(s.db.prepare("SELECT status FROM jobs WHERE id = ?").get(ev.jobId) as { status: string }).status ===
					"failed",
			);
		} finally {
			await s.stop();
			sb.cleanup();
		}
	});
});
