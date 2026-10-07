// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.003 K2–K4: the rest of the decision contract, the two shadow roles
 * (memory salience at night, reply review by day), the owner view, and the
 * decision acceptance scenarios of HLD §15:
 * - #16 decision boundary: whatever Kev answers, nothing Iyye does changes;
 * - #17 revision binding: also `decisions.test.ts` (a swapped checkpoint);
 * - #18 label integrity: outcomes join their own decision, the stored state
 *   holds nothing from after the decision, weak labels never replace owner ones.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { DecisionClient } from "../src/decisions/client.ts";
import { MEMORY_SALIENCE, MemorySalience, SALIENCE_QUESTION } from "../src/decisions/memory-salience.ts";
import {
	forgetReplyReviews,
	PROMISE_QUESTION,
	REPLY_REVIEW,
	ReplyReviewShadow,
} from "../src/decisions/reply-review.ts";
import { bestThreshold, decisionsReport, labelDecision, roleReport } from "../src/decisions/report.ts";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import type { GateResult } from "../src/memory/gate.ts";
import { NightWork } from "../src/memory/night.ts";
import { collectSignals } from "../src/motivation/signals.ts";
import { JOURNAL_ONLY } from "../src/motivation/tracker.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { setKv } from "../src/state/kv.ts";
import { recordEpisode, recordRemember } from "../src/state/stm.ts";
import { addTombstone } from "../src/state/tombstones.ts";
import { CHECKPOINT, FakeKev } from "./fixtures/fake-kev-http.ts";
import { FakeLtm } from "./fixtures/fake-ltm.ts";

let seq = 0;

function freshDb(): Db {
	const db = openDb(":memory:");
	db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')").run();
	return db;
}

/** An answered turn with its delivered reply, as the outbox records it. */
function turn(db: Db, scope: string, text: string, reply: string, at = new Date().toISOString()) {
	const id = `e${++seq}`;
	const contact = scope === "owner" ? "owner" : scope.slice("contact:".length);
	const channel = scope === "owner" ? "web" : "telegram";
	const payload = channel === "web" ? { text } : { message: { text, chatId: 1 } };
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'answered')",
	).run(id, id, channel, contact, scope, at, JSON.stringify(payload));
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, ?)",
	).run(`a-${id}`, id, `k-${id}`, at, reply);
	recordEpisode(db, getEvent(db, id)!, { id: `a-${id}`, content: reply }, at);
	return { eventId: id, actionId: `a-${id}` };
}

const openGate = {
	problem: null as string | null,
	async run<T>(_label: string, fn: (model: string) => Promise<T>): Promise<GateResult<T>> {
		return { ok: true, value: await fn("mem-model"), model: "mem-model" };
	},
};

const decisionRows = (db: Db, role?: string) =>
	(role
		? db.prepare("SELECT * FROM decisions WHERE role = ? ORDER BY created_at, rowid").all(role)
		: db.prepare("SELECT * FROM decisions ORDER BY created_at, rowid").all()) as Record<string, string | null>[];

describe("decisions: contract, roles, owner view (plan 0.003 K2–K4)", () => {
	const kev = new FakeKev();
	const ltm = new FakeLtm();
	before(async () => {
		await kev.start();
		await ltm.start();
	});
	after(async () => {
		await kev.stop();
		await ltm.stop();
	});
	beforeEach(() => {
		kev.answer = () => 0.5;
		kev.status = 200;
		kev.up = true;
		kev.truncated = false;
		kev.during = null;
		kev.checkpointInfo = CHECKPOINT;
		kev.requests.length = 0;
		ltm.reset();
	});

	test("K2: a truncated answer and a checkpoint swapped during the call are errors; the full revision is recorded", async () => {
		const db = freshDb();
		const client = new DecisionClient({ db, service: kev.service });
		const input = { scope: "owner", subjectRef: "x", state: "hello", questions: [SALIENCE_QUESTION] };
		const ok = await client.ask(MEMORY_SALIENCE, input);
		assert.equal(ok.status, "ok");
		const row = decisionRows(db)[0]!;
		assert.deepEqual(
			[row.checkpoint, row.base_model, row.temperature, row.backend, row.lora, row.dtype],
			[
				CHECKPOINT.run,
				CHECKPOINT.base,
				CHECKPOINT.temperature,
				CHECKPOINT.backend,
				CHECKPOINT.lora,
				CHECKPOINT.dtype,
			],
		);

		kev.truncated = true;
		const cut = await client.ask(MEMORY_SALIENCE, input);
		assert.deepEqual([cut.status, cut.error], ["error", "the state was truncated by the server"]);
		assert.deepEqual(cut.verdicts, {}, "no verdict from a cut state");

		kev.truncated = false;
		kev.during = () => {
			kev.checkpointInfo = { ...CHECKPOINT, run: "jaredpalmer/kev-4b@other" };
		};
		const swapped = await client.ask(MEMORY_SALIENCE, input);
		assert.deepEqual([swapped.status, swapped.error], ["error", "the checkpoint changed during the call"]);

		const skipped = client.skip(MEMORY_SALIENCE, input, "the device was busy");
		const s = decisionRows(db).find((r) => r.id === skipped)!;
		assert.deepEqual([s.status, s.error, s.answers_json], ["skipped", "the device was busy", null]);
	});

	test("#18: a weak label never replaces an owner label; an owner label replaces a weak one", async () => {
		const db = freshDb();
		const client = new DecisionClient({ db, service: kev.service });
		const d = await client.ask(REPLY_REVIEW, {
			scope: "owner",
			subjectRef: "a1",
			state: { message: "m", reply: "r" },
			questions: [PROMISE_QUESTION],
		});
		assert.equal(client.recordOutcome(d.id, { promises_future_action: false }, "commitments"), true);
		assert.match(
			labelDecision(db, d.id.slice(0, 8), "yes", "owner_web", "t2"),
			/the reply claimed something was set up/,
		);
		assert.equal(client.recordOutcome(d.id, { promises_future_action: false }, "commitments"), false);
		const row = decisionRows(db)[0]!;
		assert.deepEqual(
			[row.outcome_json, row.outcome_source, row.label_strength],
			['{"claims_arranged":true}', "owner_web", "owner"],
		);
		assert.match(labelDecision(db, d.id.slice(0, 8), "maybe", "owner_web", "t"), /usage/);
		assert.match(labelDecision(db, "ffffff", "yes", "owner_web", "t"), /no decision ffffff/);
	});

	test("K3 memory salience: asked before each retain with the message only; joined to the transfer's result as a weak label", async () => {
		const db = freshDb();
		const client = new DecisionClient({ db, service: kev.service });
		const device = new DeviceSlot();
		const salience = new MemorySalience({ db, client, device, log: silentLogger });
		kev.answer = () => 0.7;
		const fact = turn(db, "contact:c1", "My son Jacob is 12 years old", "Noted, Jacob is 12.");
		const thanks = turn(db, "owner", "thanks!", "You're welcome!");
		recordRemember(db, { id: "r1", text: "The boiler code is 4471", at: new Date().toISOString() });

		const night = new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger, salience });
		assert.equal((await night.run(() => false)).kind, "done");
		const rows = decisionRows(db, MEMORY_SALIENCE.name);
		assert.deepEqual(
			rows.map((r) => [r.subject_ref, r.scope, JSON.parse(r.state_json!), r.status]),
			[
				[fact.eventId, "contact:c1", "My son Jacob is 12 years old", "ok"],
				[thanks.eventId, "owner", "thanks!", "ok"],
			],
			"one per turn; a /remember entry is not asked (the owner decided); Iyye's reply is not in the state",
		);
		assert.deepEqual(
			rows.map((r) => [JSON.parse(r.outcome_json!), r.outcome_source, r.label_strength]),
			[
				[{ worth_remembering: true, transfer: "completed" }, "hindsight_extraction", "weak"],
				[{ worth_remembering: false, transfer: "completed_empty" }, "hindsight_extraction", "weak"],
			],
			"each outcome joins its own episode's decision (#18)",
		);
		assert.equal(device.holder, null);
	});

	test("K3 memory salience: a failed transfer has no outcome, and the retry on a later night reuses the decision; a busy device is a skip", async () => {
		const db = freshDb();
		const client = new DecisionClient({ db, service: kev.service });
		const device = new DeviceSlot();
		const salience = new MemorySalience({ db, client, device, log: silentLogger });
		const t = turn(db, "owner", "We moved to Lisbon in May", "Noted.");
		ltm.failRetain = true;
		await new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger, salience }).run(() => false);
		let rows = decisionRows(db, MEMORY_SALIENCE.name);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.outcome_json, null, "a failed transfer is not an outcome");
		ltm.failRetain = false;
		await new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger, salience }).run(() => false);
		rows = decisionRows(db, MEMORY_SALIENCE.name);
		assert.equal(rows.length, 1, "one message, one decision: never two training examples");
		assert.equal(rows[0]!.subject_ref, t.eventId);
		assert.equal(kev.requests.length, 1);
		assert.deepEqual(JSON.parse(rows[0]!.outcome_json!), { worth_remembering: true, transfer: "completed" });

		const busy = turn(db, "owner", "My dentist is Dr. Weber", "Noted.");
		const release = device.tryAcquire("chat:test")!;
		const id = await salience.ask(
			db.prepare("SELECT * FROM stm_episodes WHERE event_id = ?").get(busy.eventId) as never,
		);
		release();
		assert.deepEqual(
			[decisionRows(db).find((r) => r.id === id)!.status, decisionRows(db).find((r) => r.id === id)!.error],
			["skipped", "the device was busy"],
		);
	});

	test("K3: a night with Kev down journals skips, and the next night asks again; skipped rows get no outcome", async () => {
		const db = freshDb();
		const client = new DecisionClient({ db, service: kev.service });
		const salience = new MemorySalience({ db, client, device: new DeviceSlot(), log: silentLogger });
		const t = turn(db, "owner", "My sister lives in Riga", "Noted.");
		ltm.failRetain = true; // the transfer fails too, so the episode comes back next night
		kev.up = false;
		await new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger, salience }).run(() => false);
		kev.up = true;
		ltm.failRetain = false;
		await new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger, salience }).run(() => false);
		assert.deepEqual(
			decisionRows(db, MEMORY_SALIENCE.name).map((r) => [r.subject_ref, r.status, r.outcome_json]),
			[
				[t.eventId, "skipped", null],
				[t.eventId, "ok", JSON.stringify({ worth_remembering: true, transfer: "completed" })],
			],
		);
	});

	test("K3 reply review waits while Kev is not up: nothing is skipped for good", async () => {
		const db = freshDb();
		const client = new DecisionClient({ db, service: kev.service });
		let ready = false;
		const review = new ReplyReviewShadow({
			db,
			client,
			device: new DeviceSlot(),
			chatPending: () => false,
			ready: () => ready,
			log: silentLogger,
		});
		turn(db, "owner", "hi", "hello");
		assert.equal(await review.drainOnce(), 0);
		assert.equal(decisionRows(db).length, 0);
		ready = true;
		assert.equal(await review.drainOnce(), 1);
		assert.equal(decisionRows(db)[0]!.status, "ok");
	});

	test("/forget during a call in flight: the answer is not written back (tombstone or forgotten-reply marker)", async () => {
		const db = freshDb();
		const client = new DecisionClient({ db, service: kev.service });
		const a = turn(db, "owner", "What is Julia's address?", "Julia lives at Main St 5.");
		kev.during = () => forgetReplyReviews(db, [a.actionId], new Date().toISOString());
		await client.ask(REPLY_REVIEW, {
			scope: "owner",
			subjectRef: a.actionId,
			state: { message: "What is Julia's address?", reply: "Julia lives at Main St 5." },
			questions: [PROMISE_QUESTION],
		});
		assert.deepEqual(
			decisionRows(db).map((r) => [r.status, r.error, r.state_json]),
			[["skipped", "forgotten", '""']],
			"only the marker: the quote never reaches the journal",
		);
		kev.during = () => addTombstone(db, "contact:c1", new Date().toISOString(), "owner_web");
		await client.ask(MEMORY_SALIENCE, {
			scope: "contact:c1",
			subjectRef: "e-x",
			state: "my address is Main St 5",
			questions: [SALIENCE_QUESTION],
		});
		assert.equal(decisionRows(db, MEMORY_SALIENCE.name).length, 0);
	});

	test("K3 reply review: delivered replies since the role started, idle-gated, restart-safe; forgotten ones never", async () => {
		const db = freshDb();
		const client = new DecisionClient({ db, service: kev.service });
		const device = new DeviceSlot();
		turn(db, "owner", "old question", "an old reply, before the role existed", "2026-01-01T00:00:00.000Z");
		let chat = false;
		const review = () => new ReplyReviewShadow({ db, client, device, chatPending: () => chat, log: silentLogger });
		const first = review();
		kev.answer = () => 0.9;
		const a = turn(db, "contact:c1", "Can you remind me tomorrow?", "Sure, I'll remind you tomorrow at 9.");
		const b = turn(db, "owner", "what time is it", "It is 14:02.");
		const gone = turn(db, "contact:c1", "secret", "reply");
		db.prepare("UPDATE actions SET content = '[forgotten]' WHERE id = ?").run(gone.actionId);
		assert.equal(first.pending, 2);

		chat = true;
		assert.equal(await first.drainOnce(), 0, "chat first");
		chat = false;
		const release = device.tryAcquire("chat:test")!;
		assert.equal(await first.drainOnce(), 0, "never waits for the device");
		release();
		kev.answer = () => 0.9;
		assert.equal(await first.drainOnce(), 2);
		const rows = decisionRows(db, REPLY_REVIEW.name);
		assert.deepEqual(
			rows.map((r) => [r.subject_ref, r.scope, JSON.parse(r.state_json!)]),
			[
				[
					a.actionId,
					"contact:c1",
					{ message: "Can you remind me tomorrow?", reply: "Sure, I'll remind you tomorrow at 9." },
				],
				[b.actionId, "owner", { message: "what time is it", reply: "It is 14:02." }],
			],
		);
		assert.equal(review().pending, 0, "after a restart nothing is asked twice");
		assert.equal(await review().drainOnce(), 0);
	});

	test("K4 owner view: /decisions per role, /decisions <role>, /decisions label", async () => {
		const db = freshDb();
		const client = new DecisionClient({ db, service: kev.service });
		const device = new DeviceSlot();
		// Salience: three outcomes, separable at 0.3.
		const ps = new Map([
			["My son Jacob is 12", 0.45],
			["thanks", 0.1],
			["We moved to Lisbon", 0.31],
		]);
		const salience = new MemorySalience({ db, client, device, log: silentLogger });
		for (const text of ps.keys()) turn(db, "owner", text, "ok");
		let current = "";
		kev.answer = () => ps.get(current) ?? 0.5;
		const night = new NightWork({
			db,
			ltm: ltm.client(),
			gate: openGate,
			log: silentLogger,
			salience: {
				ask: (e) => {
					current = e.user_text;
					return salience.ask(e);
				},
				outcome: (id, t) => salience.outcome(id, t),
			},
		});
		await night.run(() => false);
		// Reply review: one promise, one not.
		setKv(db, "decisions.reply_review.since", "2000-01-01T00:00:00.000Z", "t");
		const review = new ReplyReviewShadow({ db, client, device, chatPending: () => false, log: silentLogger });
		kev.answer = () => 0.1;
		await review.drainOnce();
		const promise = turn(db, "owner", "remind me", "I'll remind you at 9.");
		kev.answer = () => 0.85;
		await review.drainOnce();

		const ctx = {
			models: {} as never,
			db,
			issuer: "owner_web",
			decisionsReport: (args: string[] = [], issuer = "owner") => {
				if (args[0] === "label") return labelDecision(db, args[1] ?? "", args[2] ?? "", issuer, "t");
				if (args[0]) return roleReport(db, args[0]);
				return decisionsReport(db, { state: "up", detail: "kev" }, 0, review.pending);
			},
		};
		const cmd = async (t: string) => (await handleOwnerCommand(t, ctx)).reply;
		const report = await cmd("/decisions");
		assert.match(report, /memory_salience: 3 asked · 3 ok/);
		assert.match(
			report,
			/3 with an outcome \(0 labelled by you\): kept 2 \(mean p 0\.38\), nothing kept 1 \(mean p 0\.10\)/,
		);
		assert.match(report, /best single threshold so far: p ≥ 0\.31 → 3\/3 agree/);
		assert.match(report, /reply_review: \d+ asked/);
		assert.match(report, /promises or offers a future action: 1 yes · 0 unsure · \d+ no/);
		assert.match(report, /claims something is set up: 1 yes · 0 unsure · \d+ no/);
		assert.match(report, /of the yes: 0 with a reminder made in that turn · 1 WITHOUT one \(unsupported\)/);
		const id = decisionRows(db, REPLY_REVIEW.name).find((r) => r.subject_ref === promise.actionId)!.id!;
		assert.match(report, new RegExp(`    ${id.slice(0, 8)} p=0\\.85: I'll remind you at 9\\.`));

		assert.match(
			await cmd(`/decisions label ${id.slice(0, 8)} yes`),
			/labelled .*the reply claimed something was set up/,
		);
		assert.match(await cmd("/decisions"), /your labels: 1, Kev agrees on 1/);
		const salienceId = decisionRows(db, MEMORY_SALIENCE.name)[0]!.id!;
		assert.match(await cmd(`/decisions label ${salienceId.slice(0, 8)} no`), /not worth remembering/);
		assert.match(await cmd("/decisions"), /3 with an outcome \(1 labelled by you\)/);
		const toolkitRow = await client.ask(
			{ name: "toolkit_selection", schemaVersion: 1, abstain: { low: 0.3, high: 0.6 } },
			{
				scope: "owner",
				subjectRef: "x",
				state: { message: "m" },
				questions: [{ id: "web", instructions: "?" }],
			},
		);
		assert.match(await cmd(`/decisions label ${toolkitRow.id.slice(0, 8)} yes`), /labelled automatically/);

		const roleView = await cmd("/decisions reply_review");
		assert.match(roleView, /^reply_review \(schema 3, unsure between 0\.35 and 0\.65; shadow — none:/);
		assert.match(
			roleView,
			/promises_future_action=0\.85 yes, claims_arranged=0\.85 yes, admits_unknown=0\.85 yes, owner_intention=0\.85 yes, dated_event=0\.85 yes → \{"claims_arranged":true\} \(owner_web, owner\) · state [0-9a-f]{8}: \{"message":"remind me"/,
		);
		assert.match(
			await cmd("/decisions nonsense"),
			/unknown role "nonsense"; roles: toolkit_selection, memory_salience, reply_review/,
		);
	});

	test("#16 decision boundary: always yes or always no, the night stores the same and replies are untouched", async () => {
		const outcomes: string[] = [];
		for (const p of [1.0, 0.0]) {
			ltm.reset();
			const db = freshDb();
			const client = new DecisionClient({ db, service: kev.service });
			const device = new DeviceSlot();
			kev.answer = () => p;
			for (const t of ["My son Jacob is 12", "thanks", "We moved to Lisbon"])
				turn(db, "contact:c1", t, `noted: ${t}`);
			// Plan 0.010 M2: the reply review's new questions (admits_unknown, owner_intention, dated_event).
			turn(db, "owner", "I want to learn Rust. Which book is best for it?", "I don't know which book is best.");
			turn(db, "contact:c1", "I have an exam tomorrow", "Good luck!");
			setKv(db, "decisions.reply_review.since", "2000-01-01T00:00:00.000Z", "t");
			const before = JSON.stringify(db.prepare("SELECT id, state, content FROM actions ORDER BY id").all());
			await new ReplyReviewShadow({ db, client, device, chatPending: () => false, log: silentLogger }).drainOnce();
			const night = new NightWork({
				db,
				ltm: ltm.client(),
				gate: openGate,
				log: silentLogger,
				salience: new MemorySalience({ db, client, device, log: silentLogger }),
			});
			await night.run(() => false);
			assert.equal(JSON.stringify(db.prepare("SELECT id, state, content FROM actions ORDER BY id").all()), before);
			assert.ok(decisionRows(db).every((r) => r.status === "ok"));
			outcomes.push(
				JSON.stringify({
					retained: ltm.retains.map((id) => id.replace(/^e\d+/, "e")),
					stm: db.prepare("SELECT state FROM stm_episodes ORDER BY said_at, rowid").all(),
					events: db.prepare("SELECT status FROM events ORDER BY id").all(),
					// …and the motivations' signals are the deterministic detectors' alone (§15 #16).
					signals: collectSignals({
						db,
						now: new Date(Date.now() + 2 * 86_400_000),
						selfGaps: () => [],
						healing: () => [],
						sleep: () => null,
					})
						.filter((x) => !JOURNAL_ONLY.has(x.kind)) // recorded-only kinds (some read Kev) are never counted
						.map((x) => `${x.kind}:${x.cluster.replace(/e\d+/, "e")}`),
				}),
			);
		}
		assert.equal(outcomes[0], outcomes[1], "Kev's answers changed nothing");
	});

	test("bestThreshold: the cut that agrees most often", () => {
		assert.deepEqual(
			bestThreshold([
				{ p: 0.1, yes: false },
				{ p: 0.3, yes: true },
				{ p: 0.5, yes: true },
			]),
			{ t: 0.3, correct: 3 },
		);
		assert.deepEqual(bestThreshold([]), { t: 0, correct: 0 });
	});
});
