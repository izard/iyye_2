// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.007 S3: Iyye's own messages to the owner (web chat only, idempotent,
 * held while asleep), the day summary (a digest from records, a model's note
 * only when it adds nothing), and the wake check.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WebChatAdapter } from "../src/channels/web/adapter.ts";
import { buildDigest, composeDaySummary, type DayWindow, summaryProblem } from "../src/kernel/day-summary.ts";
import { recover } from "../src/kernel/recovery.ts";
import { parseWindow, Rhythm } from "../src/kernel/rhythm.ts";
import { wakeMessage, wakeProblems } from "../src/kernel/wake-check.ts";
import { silentLogger } from "../src/log.ts";
import type { NightOutcome } from "../src/memory/night.ts";
import { type ChannelAdapter, Outbox } from "../src/outbox/outbox.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { recordEpisode, recordRemember } from "../src/state/stm.ts";
import { waitFor } from "./model-helpers.ts";

let seq = 0;
function freshDb(): Db {
	const db = openDb(":memory:");
	db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')").run();
	return db;
}

function answered(db: Db, scope: "owner" | "contact:c1", at: string): string {
	const id = `e${++seq}`;
	const web = scope === "owner";
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'answered')",
	).run(
		id,
		id,
		web ? "web" : "telegram",
		web ? "owner" : "c1",
		scope,
		at,
		JSON.stringify(web ? { text: "hi" } : { message: { text: "hi", chatId: 1 } }),
	);
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, 'ok')",
	).run(`a-${id}`, id, `k-${id}`, at);
	recordEpisode(db, getEvent(db, id)!, { id: `a-${id}`, content: "ok" }, at);
	return id;
}

const FROM = "2026-10-03T00:10:00.000Z";
const TO = "2026-10-03T23:50:00.000Z";
const done: NightOutcome = { kind: "done", completed: 3, empty: 2, failed: 0, consolidated: [] };

function dayDb(): Db {
	const db = freshDb();
	for (const at of ["2026-10-03T09:00:00.000Z", "2026-10-03T10:00:00.000Z", "2026-10-03T11:00:00.000Z"])
		answered(db, "owner", at);
	for (const at of ["2026-10-03T12:00:00.000Z", "2026-10-03T13:00:00.000Z"]) answered(db, "contact:c1", at);
	answered(db, "owner", "2026-10-02T12:00:00.000Z"); // yesterday: not today's
	recordRemember(db, { id: "r1", text: "the boiler code", at: "2026-10-03T14:00:00.000Z" });
	db.prepare(
		"INSERT INTO tool_calls (id, scope, principal, tool, args_json, outcome, started_at, finished_at) VALUES ('t1', 'owner', 'owner', 'web_search', '{}', 'ok', '2026-10-03T10:00:01.000Z', '2026-10-03T10:00:02.000Z'), ('t2', 'iyye:bg:x', 'iyye', 'system_status', '{}', 'ok', '2026-10-03T15:00:00.000Z', '2026-10-03T15:00:01.000Z')",
	).run();
	db.prepare(
		"INSERT INTO energy_ledger (at, kind, amount, level_after, ref) VALUES ('2026-10-03T20:00:00.000Z', 'awake', -0.1, 0.42, NULL)",
	).run();
	return db;
}

describe("the day summary", () => {
	test("the digest is built from the day's records only", () => {
		const db = dayDb();
		const digest = buildDigest(db, { day: 4, from: FROM, to: TO, outcome: done });
		assert.match(digest, /^Day 4\.$/m, "no dates or times: a model would rewrite them unverifiably");
		assert.match(
			digest,
			/Messages answered: 5 in all, 3 from the owner, 2 from Julia\./,
			"yesterday's message and /remember are not counted; the total is stated",
		);
		assert.match(digest, /The owner asked Iyye to remember 1 thing\(s\)\./);
		assert.match(
			digest,
			/Tonight Iyye stored 3 conversation\(s\) in long-term memory\.\nAnother 2 conversation\(s\) were checked and had nothing worth keeping\./,
		);
		assert.match(
			digest,
			/Tools used in conversations: web_search 1 time\(s\)\./,
			"background tool calls are not conversation tools",
		);
		assert.match(digest, /Lowest energy \(adenosine\) during the day: 0\.42\./);
		assert.match(digest, /No messages failed\./);
		db.close();
	});

	test("a model's note replaces the digest only if every number and name is from the record, it is shorter, and it promises nothing", async () => {
		const db = dayDb();
		const w: DayWindow = { day: 4, from: FROM, to: TO, outcome: done };
		const digest = buildDigest(db, w);
		const run = (note: string | null) => composeDaySummary(db, w, { complete: async () => note });
		const good = await run(
			"Today I answered 3 messages from you and 2 from Julia, and stored 3 conversations tonight.",
		);
		assert.equal(good.source, "model", String(good.problem));
		for (const [note, why] of [
			["I answered 17 messages today.", /the number 17 is not in the record/],
			["I answered three messages from you, and seven from Julia.", /the number "seven" is not in the record/],
			["Julia and Bob wrote to me today.", /the name Bob is not in the record/],
			["Your friend Anna wrote too.", /the name Anna is not in the record/],
			["A quiet day. I will remind you about the boiler tomorrow.", /promises something/],
			[`${digest} ${"And more. ".repeat(60)}`, /longer than the record/],
			["", /empty/],
		] as const) {
			const r = await run(note);
			assert.equal(r.source, "digest", note);
			assert.equal(r.text, digest);
			if (why) assert.match(r.problem!, why);
		}
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c2', 'Bob', 'contact', 't')",
		).run();
		assert.match((await run("Julia and Bob wrote to me today."))!.problem!, /the name Bob is not in the record/);
		assert.equal((await run(null)).problem, "the model did not answer");
		assert.equal((await composeDaySummary(db, w, null)).source, "digest");
		assert.equal(summaryProblem("Nothing much.", "Day 1.\nNo messages failed.", []), null);
		const blocked = "Day 2.\nThe night's memory work stopped early: long-term memory is unreachable.";
		assert.match(summaryProblem("A good day, everything went smoothly.", blocked, [])!, /leaves out a problem/);
		assert.equal(summaryProblem("The night's memory work stopped early.", blocked, []), null);
		db.close();
	});
});

describe("Iyye's own messages to the owner", () => {
	function rig(held: () => boolean) {
		const db = freshDb();
		const telegramSends: string[] = [];
		const telegram: ChannelAdapter = {
			channel: "telegram",
			maxChunkChars: 4096,
			sendChunk: async (a) => {
				telegramSends.push(a.content);
				return { ok: true, level: "accepted" };
			},
		};
		const outbox = new Outbox({
			db,
			log: silentLogger,
			adapters: [new WebChatAdapter({ db, log: silentLogger }), telegram],
			held,
		});
		return { db, outbox, telegramSends };
	}

	test("go to the owner's web chat only, as Iyye speaking, once per key", async () => {
		const { db, outbox, telegramSends } = rig(() => false);
		const a = await outbox.notifyOwner({ key: "day-summary:4", content: "A quiet day." });
		assert.equal(a.state, "delivered");
		assert.deepEqual(JSON.parse(a.route_json), { channel: "web", contact: "owner" });
		const again = await outbox.notifyOwner({ key: "day-summary:4", content: "A different text." });
		assert.equal(again.id, a.id, "the same key is the same message");
		assert.deepEqual(db.prepare("SELECT kind, event_id, text FROM web_feed").all(), [
			{ kind: "reply", event_id: null, text: "A quiet day." },
		]);
		assert.deepEqual(telegramSends, []);
		db.close();
	});

	test("a restart while asleep does not send a held message; waking does", async () => {
		let asleep = true;
		const { db, outbox } = rig(() => asleep);
		const a = await outbox.notifyOwner({ key: "finding:1", content: "Disk is low." });
		const report = await recover(db, outbox, { fail: async () => {} }, silentLogger);
		assert.equal(report.resent, 0);
		assert.equal(
			(db.prepare("SELECT state FROM actions WHERE id = ?").get(a.id) as { state: string }).state,
			"queued",
		);
		asleep = false;
		await outbox.dispatchDue();
		assert.equal(
			(db.prepare("SELECT state FROM actions WHERE id = ?").get(a.id) as { state: string }).state,
			"delivered",
		);
		db.close();
	});

	test("while asleep a message waits, queued, and goes out after waking (HLD §15 #11)", async () => {
		let asleep = true;
		const { db, outbox } = rig(() => asleep);
		const a = await outbox.notifyOwner({ key: "wake-check:5", content: "Something needs attention." });
		assert.equal(a.state, "queued");
		await outbox.dispatchDue();
		assert.equal(
			(db.prepare("SELECT count(*) AS n FROM web_feed").get() as { n: number }).n,
			0,
			"nothing while asleep",
		);
		asleep = false;
		await outbox.dispatchDue();
		assert.equal(
			(db.prepare("SELECT state FROM actions WHERE id = ?").get(a.id) as { state: string }).state,
			"delivered",
		);
		db.close();
	});
});

describe("the end of a completed day in the rhythm", () => {
	function rig(night: (stop: () => boolean) => Promise<NightOutcome>) {
		const db = freshDb();
		const calls: string[] = [];
		const clock = { now: new Date(2026, 9, 4, 2, 30) };
		const rhythm = new Rhythm({
			db,
			window: parseWindow("02:00-06:00"),
			night: { run: night },
			turnRunning: () => false,
			notify: () => {},
			log: silentLogger,
			now: () => clock.now,
			tickMs: 3_600_000,
			models: {
				restForNight: async () => ({ ok: true, message: "rest" }),
				wakeFromNight: async () => {
					calls.push("models back");
					return { ok: true, message: "back" };
				},
			},
			dayEnd: {
				compose: async (w) => {
					calls.push(
						`compose day ${w.day} ${w.outcome?.kind} to ${w.to === (db.prepare("SELECT value FROM kv WHERE key = 'rhythm.slept_at'").get() as { value: string }).value}`,
					);
					return "summary text";
				},
				afterWake: async (day, summary) => {
					calls.push(`afterWake day ${day}: ${summary}`);
				},
			},
		});
		return { db, calls, rhythm };
	}

	test("compose runs at the end of the night, afterWake once the models are back; an interrupted night does neither", async () => {
		const { db, calls, rhythm } = rig(async () => done);
		rhythm.tick();
		await waitFor(() => calls.length === 3);
		assert.deepEqual(calls, ["compose day 1 done to true", "models back", "afterWake day 2: summary text"]);
		db.close();

		const r2 = rig(async (stop) => {
			while (!stop()) await new Promise((r) => setTimeout(r, 10));
			return { kind: "stopped", completed: 0, empty: 0, failed: 0 };
		});
		r2.rhythm.tick();
		await waitFor(() => r2.rhythm.mode() === "asleep");
		r2.rhythm.wakeForOwner("the owner wrote");
		await waitFor(() => r2.calls.includes("models back"));
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(r2.calls, ["models back"], "the night is still owed: no summary, no wake check");
		await r2.rhythm.stop();
		r2.db.close();
	});
});

test("the owner writing while the summary is composed leaves the night owed: no completed day, one waking notice", async () => {
	const db = freshDb();
	const notices: string[] = [];
	const calls: string[] = [];
	let release: (() => void) | null = null;
	const rhythm = new Rhythm({
		db,
		window: parseWindow("02:00-06:00"),
		night: { run: async () => done },
		turnRunning: () => false,
		notify: (t) => notices.push(t),
		log: silentLogger,
		now: () => new Date(2026, 9, 4, 2, 30),
		tickMs: 3_600_000,
		onNightEnd: async () => {
			calls.push("onNightEnd");
		},
		dayEnd: {
			compose: async () => {
				calls.push("compose");
				await new Promise<void>((r) => {
					release = r;
				});
				return "summary";
			},
			afterWake: async () => {
				calls.push("afterWake");
			},
		},
	});
	rhythm.tick();
	await waitFor(() => release !== null);
	rhythm.wakeForOwner("the owner wrote");
	release!();
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(rhythm.day(), 1, "the day did not advance");
	assert.deepEqual(calls, ["compose"], "no onNightEnd, no afterWake");
	assert.equal(notices.filter((n) => n.startsWith("waking up")).length, 1);
	await rhythm.stop();
	db.close();
});

test("the wake check reports only problems", () => {
	const db = freshDb();
	const healthy = { "the model router": "up", Telegram: "connected", "web search": "disabled" };
	assert.deepEqual(wakeProblems({ db, services: healthy, missingModels: [] }), [], "nothing to say: no message");
	db.prepare(
		"INSERT INTO actions (id, kind, route_json, content_hash, idempotency_key, state, created_at) VALUES ('u1', 'reply', '{}', 'h', 'k-u1', 'unknown', 't')",
	).run();
	db.prepare(
		"INSERT INTO background_jobs (id, origin, session, prompt, status, created_at, settled_at) VALUES ('b1', 'x', 's', 'p', 'suspended', 't', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
	).run();
	const problems = wakeProblems({
		db,
		services: { ...healthy, "long-term memory": "retrying" },
		missingModels: ["gemma-4-E4B"],
	});
	assert.deepEqual(problems, [
		"long-term memory is retrying",
		"not loaded after waking: gemma-4-E4B",
		"1 message(s) may or may not have been delivered and need your review",
		"1 background step(s) were suspended after too many interruptions (/focus)",
	]);
	assert.match(
		wakeMessage(5, problems),
		/^Waking up on day 5, a few things need attention:\n- long-term memory is retrying/,
	);
	db.close();
});
