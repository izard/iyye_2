// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.018 W3: what is normal for Iyye (baselines and surprises,
 * regularities and the owner's answer, forecasts), and the reasons that come
 * of it. Everything from records put there by the test.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { silentLogger } from "../src/log.ts";
import { MotivationActor } from "../src/motivation/actor.ts";
import { recordServices } from "../src/motivation/services.ts";
import { collectSignals } from "../src/motivation/signals.ts";
import { MotivationTracker } from "../src/motivation/tracker.ts";
import { machineDomain, type ProbeResult } from "../src/observe/domains.ts";
import { SelfExpectations } from "../src/self/expectations.ts";
import { SelfModel } from "../src/self/model.ts";
import { recordReadings } from "../src/self/readings.ts";
import { type Db, openDb } from "../src/state/db.ts";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** A Monday noon, UTC; the tests' time zone is UTC. */
const NOW = new Date("2026-11-23T12:00:00Z");
const at = (day: number, hhmm: string) => new Date(Date.parse(`2026-11-${String(day).padStart(2, "0")}T${hhmm}:00Z`));

function rig() {
	const db = openDb(":memory:");
	const clock = { now: NOW };
	const mode = { m: "awake" as "awake" | "asleep" };
	const self = new SelfModel({
		db,
		log: silentLogger,
		mode: () => mode.m,
		repoDir: ".",
		hostDir: ".",
		llamaServer: "x",
		geoHttp: null,
		now: () => clock.now,
	});
	self.setFacet("hardware", { machine: "NVIDIA DGX Spark", chip: "GB10", memoryGb: 122 }, "probe", null, NOW);
	self.setFacet("compute", { cores: 20 }, "probe", null, NOW);
	let seq = 0;
	const exp = new SelfExpectations({
		db,
		log: silentLogger,
		self,
		mode: () => mode.m,
		needs: { Telegram: "internet", "web search": "internet", "the thinking model on mbp": { peer: "mbp" } },
		restWindowMinutes: 240,
		timezone: "UTC",
		now: () => clock.now,
		newId: () => `${String(++seq).padStart(6, "0")}aa-0000-0000-0000-000000000000`,
	});
	self.attach(exp);
	const machine = exp["machine" as keyof SelfExpectations] as unknown as string;
	/** A change record as the upkeep, the surroundings and the service watcher write them. */
	const change = (facet: string, field: string, value: unknown, when: Date) =>
		db
			.prepare(
				"INSERT INTO self_changes (id, facet, field, old_json, new_json, source, at) VALUES (?, ?, ?, 'null', ?, 'probe', ?)",
			)
			.run(crypto.randomUUID(), facet, field, JSON.stringify(value), when.toISOString());
	return { db, clock, mode, self, exp, machine, change };
}

/** The network goes at about 23:15 and is back at about 07:10 the next morning, on the nights starting these days. */
function nightlyGap(r: ReturnType<typeof rig>, days: number[]): void {
	for (const [i, d] of days.entries()) {
		r.change("link", "online", false, at(d, `23:${10 + i * 3}`));
		r.change("link", "online", true, at(d + 1, `07:${10 + i}`));
	}
}

describe("baselines and surprises", () => {
	/** Ten days of readings every hour: about 50 GB available, a little different each day. */
	function history(r: ReturnType<typeof rig>, value = (day: number) => 50 + (day % 3)) {
		for (let d = 1; d <= 10; d++)
			for (let h = 0; h < 24; h++)
				recordReadings(
					r.db,
					r.machine,
					"memory",
					{ availableGb: value(d) },
					new Date(NOW.getTime() - d * DAY - 12 * H + h * H),
				);
	}
	const read = async (r: ReturnType<typeof rig>, minutes: number, value: number) => {
		r.clock.now = new Date(NOW.getTime() + minutes * MIN);
		recordReadings(r.db, r.machine, "memory", { availableGb: value }, r.clock.now);
		await r.exp.tick();
	};
	const open = (db: Db) =>
		db.prepare("SELECT * FROM self_surprises WHERE ended_at IS NULL").all() as {
			peak: number;
			usual: number;
			started_at: string;
		}[];

	test("three readings far below the usual band and below the floor are one surprise, until a reading is back", async () => {
		const r = rig();
		history(r);
		await read(r, 0, 12);
		await read(r, 10, 9);
		assert.deepEqual(open(r.db), [], "two readings are not yet a surprise");
		assert.deepEqual(r.exp.signals(), []);
		await read(r, 20, 11);
		assert.equal(open(r.db).length, 1);
		assert.equal(open(r.db)[0]!.peak, 9, "the reading furthest from the band");
		assert.equal(open(r.db)[0]!.usual, 51);
		assert.equal(open(r.db)[0]!.started_at, NOW.toISOString(), "since the first of the run");
		const [sig] = r.exp.signals();
		assert.equal(sig!.kind, "self_surprise");
		assert.equal(sig!.motivation, "curiosity");
		assert.equal(
			sig!.text,
			"memory available has been unusual since 2026-11-23 12:00: 9 GB, usually about 51 at that hour",
		);
		// It lasts: still one. A tick with no new reading changes nothing.
		await read(r, 30, 10);
		await r.exp.tick();
		assert.equal((r.db.prepare("SELECT count(*) AS n FROM self_surprises").get() as { n: number }).n, 1);
		assert.match(
			r.self.command(["normal"], "owner_web"),
			/unusual now:\n {2}memory available since 2026-11-23 12:00: 9, usually about 51/,
		);
		assert.match(
			r.self.aboutMe(null),
			/- Unusual now: memory available 9 GB \(usually about 51\), since 2026-11-23 12:00\./,
		);
		// Back inside: closed.
		await read(r, 40, 49);
		assert.deepEqual(open(r.db), []);
		assert.deepEqual(r.exp.signals(), []);
		assert.match(
			r.self.command(["normal"], "owner_web"),
			/memory available — now 49 GB, usually 51 ± 2 at this hour; counts only below 16 GB\n/,
		);
		assert.match(r.self.command(["normal"], "owner_web"), /unusual now: nothing/);
	});

	test("one low reading, a drop that stays above the floor, or too little history raise nothing", async () => {
		const r = rig();
		history(r);
		await read(r, 0, 12);
		await read(r, 10, 50);
		await read(r, 20, 12);
		await read(r, 30, 50);
		// Far below the band (30 against 51 ± 2), but 30 GB free is not trouble.
		for (const m of [40, 50, 60, 70]) await read(r, m, 30);
		assert.deepEqual(open(r.db), []);
		// Four days of history are no baseline.
		const young = rig();
		for (let d = 1; d <= 4; d++)
			recordReadings(young.db, young.machine, "memory", { availableGb: 50 }, new Date(NOW.getTime() - d * DAY));
		for (const m of [0, 10, 20, 30]) await read(young, m, 5);
		assert.deepEqual(open(young.db), []);
		assert.match(
			young.self.command(["normal"], "owner_web"),
			/memory available — now 5 GB, no baseline yet \(5 days of this hour are needed\); counts only below 16 GB \(it is, now\)/,
		);
	});
});

describe("regularities and the owner's answer", () => {
	test("a nightly gap is found, asked about once, and with an answer it is usual in its hours only", async () => {
		const r = rig();
		nightlyGap(r, [13, 14, 16, 17, 19, 21, 22]);
		// Telegram gives up a few minutes into each gap: that is the network's, not Telegram's own.
		for (const d of [13, 14, 16, 17, 19, 21]) {
			r.change("services", "Telegram", "retrying", at(d, "23:25"));
			r.change("services", "Telegram", "connected", at(d + 1, "07:20"));
		}
		// The decision service has troubles of its own most afternoons.
		for (const d of [14, 15, 17, 18, 20, 22]) {
			r.change("services", "the decision service", "retrying", at(d, "15:05"));
			r.change("services", "the decision service", "up", at(d, "15:20"));
		}
		// The thinking model's outages are its machine's.
		for (const d of [14, 15, 17, 18, 20, 22])
			r.change("services", "the thinking model on mbp", "unreachable", at(d, "09:00"));
		await r.exp.tick();
		const rows = r.db
			.prepare(
				"SELECT subject, start_minute, end_minute, days, of_days, answer FROM self_regularities ORDER BY subject",
			)
			.all();
		assert.deepEqual(rows, [
			{
				subject: "network",
				start_minute: 23 * 60 + 19,
				end_minute: 7 * 60 + 13,
				days: 7,
				of_days: 14,
				answer: null,
			},
			{
				subject: "service:the decision service",
				start_minute: 15 * 60 + 5,
				end_minute: 15 * 60 + 20,
				days: 6,
				of_days: 14,
				answer: null,
			},
		]);
		const sig = r.exp.signals().filter((s) => s.kind === "regularity_unconfirmed");
		assert.equal(sig.length, 2);
		assert.equal(
			sig[0]!.text,
			"the network goes away around 23:19 and is back by about 07:13 (7 of the last 14 days); the owner has not said whether that is intended",
		);
		const id = sig[0]!.cluster.slice("regularity:".length);
		assert.match(
			r.exp.question(id)!,
			/^Something I noticed about my days: the network goes away around 23:19 and is back by about 07:13 \(7 of the last 14 days\)\. Is that intended\? Answer here in the web chat with \/self expected 000001 /,
		);
		assert.equal(r.exp.usual("network", at(23, "23:30")), false, "not before the owner has answered");
		assert.match(
			r.self.command(["normal"], "owner_web"),
			/000001 {2}the network goes away around 23:19 .* — not answered: \/self expected 000001 · \/self unexpected 000001/,
		);

		assert.match(
			r.self.command(["expected", "000001"], "owner_web"),
			/^noted: the network goes away around 23:19 .* is expected\. I will not report it in those hours any more/,
		);
		assert.equal(r.exp.question(id), null);
		assert.equal(r.exp.usual("network", at(23, "23:30")), true);
		assert.equal(r.exp.usual("network", at(23, "22:30")), true, "an hour early is still the usual one");
		assert.equal(r.exp.usual("network", at(24, "03:00")), true);
		assert.equal(r.exp.usual("network", at(24, "09:00")), true, "back two hours late is still the usual one");
		assert.equal(r.exp.usual("network", at(23, "15:00")), false, "in the afternoon it is not");
		assert.equal(
			r.exp.usual("service:the decision service", at(23, "15:10")),
			false,
			"another regularity is not answered by this",
		);
		assert.deepEqual(
			r.exp.signals().map((s) => s.kind),
			["regularity_unconfirmed"],
		);
		assert.match(
			r.self.aboutMe(null),
			/- Usual for you: the network goes away around 23:19 and is back by about 07:13 \(7 of the last 14 days\) — your owner said that is intended\./,
		);
		assert.match(r.self.command(["expected", "zzz"], "owner_web"), /usage/);
		assert.match(r.self.command(["expected", "abcdef"], "owner_web"), /no regularity abcdef/);

		// "Not intended": one standing reason with its count, and still no notice a night.
		assert.match(
			r.self.command(["unexpected", "000002"], "owner_web"),
			/is not intended\. I keep it as one open problem/,
		);
		const problem = r.exp.signals();
		assert.deepEqual(
			problem.map((s) => [s.motivation, s.kind]),
			[["self_preservation", "problem_pattern"]],
		);
		assert.match(
			problem[0]!.text,
			/the decision service stops working around 15:05 and is back by about 15:20 \(6 of the last 14 days\), and the owner said that is not intended/,
		);
		assert.equal(r.exp.usual("service:the decision service", at(23, "15:10")), true);
	});

	test("an expected one that does not happen is noticed; one that stops happening lapses, and its answer is kept", async () => {
		const r = rig();
		nightlyGap(r, [13, 14, 16, 17, 19, 21, 22]);
		await r.exp.tick();
		r.self.command(["expected", "000001"], "owner_web");
		// The night of the 23rd the network stays. Three hours after its usual start that is known.
		r.clock.now = at(24, "01:00");
		assert.deepEqual(r.exp.signals(), [], "too early to say");
		r.clock.now = at(24, "02:30");
		const [missing] = r.exp.signals();
		assert.equal(missing!.kind, "expected_missing");
		assert.match(missing!.text, /^usually the network goes away around 23:19 .*; this time it did not happen$/);
		// It never happens again. The rule still finds it for a while (5 of 14 days); then it lapses.
		for (let d = 24; d <= 30; d++) {
			r.clock.now = at(d, "12:00");
			await r.exp.tick();
		}
		assert.equal(r.exp.inForce(at(30, "12:00")).length, 1, "found until the 26th: in force for four days more");
		r.clock.now = new Date("2026-12-05T12:00:00Z");
		await r.exp.tick();
		assert.deepEqual(r.exp.inForce(r.clock.now), []);
		assert.equal(r.exp.usual("network", new Date("2026-12-05T23:30:00Z")), false);
		assert.deepEqual(r.exp.signals(), []);
		assert.equal(
			(r.db.prepare("SELECT answer FROM self_regularities").get() as { answer: string }).answer,
			"expected",
		);
		assert.match(r.self.command(["normal"], "owner_web"), /regularities: none found/);
	});

	test("the host that stops every night is a regularity of its own", async () => {
		const r = rig();
		const run = r.db.prepare(
			"INSERT INTO host_runs (id, started_at, last_seen_at, under) VALUES (?, ?, ?, 'an SSH session')",
		);
		for (const d of [12, 13, 14, 15, 16, 17, 18])
			run.run(`run-${d}`, at(d, "07:40").toISOString(), at(d, "23:28").toISOString());
		await r.exp.tick();
		const [row] = r.db.prepare("SELECT subject, start_minute, end_minute, days FROM self_regularities").all();
		assert.deepEqual(row, { subject: "host", start_minute: 23 * 60 + 28, end_minute: 7 * 60 + 40, days: 6 });
		assert.match(
			r.exp.signals()[0]!.text,
			/^the host stops running around 23:28 and is back by about 07:40 \(6 of the last 14 days\)/,
		);
	});

	test("asleep the regularities are not worked out", async () => {
		const r = rig();
		nightlyGap(r, [13, 14, 16, 17, 19, 21, 22]);
		r.mode.m = "asleep";
		await r.exp.tick();
		assert.equal((r.db.prepare("SELECT count(*) AS n FROM self_regularities").get() as { n: number }).n, 0);
		r.mode.m = "awake";
		await r.exp.tick();
		assert.equal((r.db.prepare("SELECT count(*) AS n FROM self_regularities").get() as { n: number }).n, 1);
	});
});

describe("forecasts and the host's own record", () => {
	test("free disk falling towards zero within 30 days is a reason; rising, slow, or young readings are none", () => {
		const r = rig();
		const fill = (perDay: number, days: number, from = 400) => {
			r.db.prepare("DELETE FROM self_readings").run();
			for (let d = days; d >= 0; d--)
				recordReadings(
					r.db,
					r.machine,
					"storage",
					{ "free:home, state": from - (days - d) * perDay },
					new Date(NOW.getTime() - d * DAY),
				);
		};
		fill(20, 10); // 200 GB left, 20 GB a day
		const [sig] = r.exp.signals();
		assert.equal(sig!.kind, "disk_filling");
		assert.equal(sig!.motivation, "self_preservation");
		assert.equal(sig!.text, "free disk falls by 20 GB a day: about 10 days until it is full (200 GB free)");
		assert.equal(sig!.weight, 0.6);
		assert.match(
			r.self.command(["normal"], "owner_web"),
			/forecast: free disk falls by 20 GB a day, about 10 days until it is full/,
		);
		fill(40, 10, 600); // 200 GB left, 40 GB a day: five days
		assert.equal(r.exp.signals()[0]!.weight, 0.8);
		fill(2, 10); // 190 days
		assert.deepEqual(r.exp.signals(), []);
		fill(-5, 10);
		assert.deepEqual(r.exp.signals(), []);
		assert.match(r.self.command(["normal"], "owner_web"), /forecast: free disk grows by 5 GB a day/);
		fill(100, 2); // two days of readings are no trend
		assert.deepEqual(r.exp.signals(), []);
		assert.match(r.self.command(["normal"], "owner_web"), /less than three days of readings/);
	});

	test("nights outside the rest window, nights that outlast it, and a run that was killed", () => {
		const r = rig();
		const night = r.db.prepare(
			"INSERT INTO nights (slept_at, woke_at, reason, in_window, completed) VALUES (?, ?, 'x', ?, 1)",
		);
		night.run(at(19, "10:46").toISOString(), at(19, "10:47").toISOString(), 0);
		night.run(at(20, "10:46").toISOString(), at(20, "10:47").toISOString(), 0);
		night.run(at(21, "02:00").toISOString(), at(21, "02:05").toISOString(), 1);
		assert.deepEqual(
			r.exp.signals().map((s) => [s.kind, s.text]),
			[["nights_outside_window", "2 of the last 3 nights ran outside the rest window"]],
		);
		night.run(at(22, "02:00").toISOString(), at(22, "02:05").toISOString(), 1);
		assert.deepEqual(r.exp.signals(), [], "half of them is not most of them");
		// Three long nights of the last five.
		r.db.prepare("DELETE FROM nights").run();
		for (const d of [19, 20, 21]) night.run(at(d, "02:00").toISOString(), at(d, "07:30").toISOString(), 1);
		night.run(at(22, "02:00").toISOString(), at(22, "02:30").toISOString(), 1);
		assert.deepEqual(
			r.exp.signals().map((s) => [s.kind, s.text]),
			[["nights_too_long", "3 of the last 4 nights took longer than the rest window (4 h)"]],
		);
		r.db.prepare("DELETE FROM nights").run();
		// The run before this one was killed, and nothing ran for eight hours.
		const start = at(23, "07:45");
		r.self.setFacet(
			"lifecycle",
			{ startedAt: start.toISOString(), previousRunEnded: "without a shutdown", notRunningHoursBefore: 8.3 },
			"probe",
			null,
			start,
		);
		const [sig] = r.exp.signals();
		assert.equal(sig!.kind, "not_running");
		assert.equal(
			sig!.text,
			"I was not running for 8.3 h before 2026-11-23 07:45, and the run before ended without a shutdown",
		);
		assert.equal(sig!.observedAt, start.toISOString());
		r.self.setFacet("lifecycle", { previousRunEnded: "with a shutdown" }, "probe", null, start);
		assert.deepEqual(r.exp.signals(), [], "a shutdown and a later start is the owner's doing");
	});
});

describe("what is usual is not reported again", () => {
	test("signals: no network signal in the hours of an answered regularity; one at any other time", async () => {
		const r = rig();
		nightlyGap(r, [13, 14, 16, 17, 19, 21, 22]);
		await r.exp.tick();
		r.self.command(["expected", "000001"], "owner_web");
		recordServices(r.db, () => ({ Telegram: { state: "retrying", detail: "EAI_AGAIN" } }), at(23, "23:20"));
		const signalsAt = (now: Date) =>
			collectSignals({
				db: r.db,
				now,
				selfGaps: () => [],
				healing: () => [],
				sleep: () => null,
				network: () => ({
					online: false,
					since: new Date(now.getTime() - 10 * MIN).toISOString(),
					dependents: ["Telegram"],
				}),
				usual: (subject) => r.exp.usual(subject, now),
				expectations: () => r.exp.signals(now),
			}).map((s) => s.kind);
		assert.deepEqual(
			signalsAt(at(23, "23:30")),
			[],
			"as every night: nothing, and Telegram's outage is the network's",
		);
		assert.deepEqual(signalsAt(at(23, "15:00")), ["network_away"]);
	});

	test("the machine observation: the usual loss and return are no change", () => {
		const machine = machineDomain({ memoryGb: () => 50, loadedModels: async () => [], services: () => ({}) });
		const m = (o: Partial<Record<string, unknown>>): ProbeResult => ({
			diskFreeGb: 200,
			diskTotalGb: 1000,
			diskFreePct: 20,
			memAvailableGb: 50,
			swapUsedGb: 0,
			loadedModels: [],
			services: { Telegram: "connected" },
			online: true,
			needOnline: ["Telegram"],
			...o,
		});
		const away = m({ online: false, asUsual: true, services: { Telegram: "retrying" } });
		assert.equal(machine.compare(m({}), away, NOW).severity, "none");
		assert.equal(machine.compare(away, m({}), NOW).severity, "none");
		// The same loss at an unusual hour is a change, as before.
		assert.equal(machine.compare(m({}), m({ online: false }), NOW).severity, "threshold");
	});

	test("the question reaches the owner through the motivations' own limits, and a command answers it", async () => {
		const r = rig();
		nightlyGap(r, [13, 14, 16, 17, 19, 21, 22]);
		await r.exp.tick();
		const sent: string[] = [];
		const actor = new MotivationActor({
			db: r.db,
			log: silentLogger,
			mode: () => "awake",
			notifyOwner: async (q) => {
				sent.push(q.content);
			},
			self: r.self,
			byCommand: (cluster) => {
				const question = r.exp.question(cluster.slice("regularity:".length));
				return question ? { question, answer: "/self expected 000001 or /self unexpected 000001" } : null;
			},
			now: () => r.clock.now,
		});
		const tracker = new MotivationTracker({
			db: r.db,
			log: silentLogger,
			actor,
			mode: () => "awake",
			sources: { selfGaps: () => [], healing: () => [], sleep: () => null, expectations: () => r.exp.signals() },
			// The other new reasons are only journaled until the owner lets them act.
			journalOnly: new Set(["not_running"]),
			now: () => r.clock.now,
			alpha: 0.5,
			threshold: 0.55,
			sustain: 2,
		});
		r.self.setFacet(
			"lifecycle",
			{ startedAt: NOW.toISOString(), previousRunEnded: "without a shutdown", notRunningHoursBefore: 8.3 },
			"probe",
			null,
			NOW,
		);
		const sweep = async (minutes: number) => {
			r.clock.now = new Date(NOW.getTime() + minutes * MIN);
			await tracker.sweep();
		};
		for (let i = 0; i < 6; i++) await sweep(i * 10);
		assert.equal(sent.length, 1);
		assert.match(
			sent[0]!,
			/^Something I noticed about my days: the network goes away around 23:19 .* \/self expected 000001 .* \/self unexpected 000001/,
		);
		const sp = r.db
			.prepare(
				"SELECT raw, signals_json FROM motivation_samples WHERE motivation = 'self_preservation' ORDER BY at DESC LIMIT 1",
			)
			.get() as { raw: number; signals_json: string };
		assert.equal(sp.raw, 0, "journaled, not counted");
		assert.match(sp.signals_json, /not_running/);
		assert.equal(
			(r.db.prepare("SELECT count(*) AS n FROM opportunities").get() as { n: number }).n,
			1,
			"and nothing opened for it",
		);
		// The owner chats about something else: that is not the answer.
		r.db
			.prepare(
				"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('e1', 'e1', 'web', 'owner', 'owner', ?, ?, 'answered')",
			)
			.run(new Date(NOW.getTime() + 61 * MIN).toISOString(), JSON.stringify({ text: "what is the weather?" }));
		await sweep(70);
		assert.equal((r.db.prepare("SELECT status FROM self_questions").get() as { status: string }).status, "asked");
		assert.match(
			actor.noteFor("owner")!,
			/answer in the web chat with \/self expected 000001 or \/self unexpected 000001/,
		);
		assert.match(
			actor.accept((r.db.prepare("SELECT id FROM self_questions").get() as { id: string }).id, "", "owner_web"),
			/answered with \/self expected 000001 or \/self unexpected 000001/,
		);
		// The command answers it: the question closes, and nothing is asked again.
		r.self.command(["expected", "000001"], "owner_web");
		await sweep(80);
		assert.equal((r.db.prepare("SELECT status FROM self_questions").get() as { status: string }).status, "resolved");
		assert.equal((r.db.prepare("SELECT status FROM opportunities").get() as { status: string }).status, "settled");
		for (let i = 9; i < 14; i++) await sweep(i * 10);
		assert.equal(sent.length, 1);
	});
});
