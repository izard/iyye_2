// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.010 M4: a deterministic replay across days with a controllable
 * clock, synthetic records, scripted completions and fake delivery, through
 * the real tracker, actor, composer, investigations loop and ledger.
 * Assertions read records (outcomes, events, device charges), never prose.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BackgroundWorker } from "../src/kernel/background.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { PlanRunner } from "../src/kernel/plans.ts";
import { silentLogger } from "../src/log.ts";
import { forgetRecords, forgetTarget } from "../src/memory/forget.ts";
import { MotivationActor } from "../src/motivation/actor.ts";
import { InitiativeLedger } from "../src/motivation/budget.ts";
import { makeComposer } from "../src/motivation/compose.ts";
import { countsFor, ensureTrial, markUseful, motivationReport, traceOpportunity } from "../src/motivation/report.ts";
import { recordServices } from "../src/motivation/services.ts";
import { collectSignals } from "../src/motivation/signals.ts";
import { MotivationTracker } from "../src/motivation/tracker.ts";
import { Investigations } from "../src/observe/investigations.ts";
import { getBackgroundJob, insertBackgroundJob } from "../src/state/background.ts";
import { getContact, linkAccount, OWNER_CONTACT_ID } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { getPlan } from "../src/state/plans.ts";
import { recordEpisode } from "../src/state/stm.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Local noon, Thursday 8 October 2026 (social hours, evenings and days are local). */
const NOON = new Date(2026, 9, 8, 12, 0);
let seq = 0;
const newId = () => `${(++seq).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

function freshDb(): Db {
	const db = openDb(":memory:");
	for (const [id, name, tg] of [
		["jacob", "Jacob", 8601],
		["alex-tg", "Alex", 5001],
	] as const) {
		db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', 't')").run(
			id,
			name,
		);
		db.prepare(
			"INSERT INTO channel_bindings (contact_id, channel, external_id, verified_by, created_at) VALUES (?, 'telegram', ?, 'first_contact', 't')",
		).run(id, String(tg));
	}
	linkAccount(db, "alex-tg", OWNER_CONTACT_ID, "owner_web", "t");
	return db;
}

function turn(db: Db, o: { id: string; who: "owner" | "jacob"; text: string; reply?: string; at: Date }) {
	const at = o.at.toISOString();
	const scope = o.who === "owner" ? "owner" : `contact:${o.who}`;
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'answered')",
	).run(
		o.id,
		o.id,
		o.who === "owner" ? "web" : "telegram",
		o.who,
		scope,
		at,
		JSON.stringify(o.who === "owner" ? { text: o.text } : { message: { text: o.text, chatId: 8601 } }),
	);
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, ?)",
	).run(`a-${o.id}`, o.id, `k-${o.id}`, at, o.reply ?? "OK.");
	recordEpisode(db, getEvent(db, o.id)!, { id: `a-${o.id}`, content: o.reply ?? "OK." }, at);
}

/** A sent message as the messenger records it: its row, then its outbox action in `state`. */
function recordSend(db: Db, o: { opportunityId: string; text: string; at: Date; state?: string | null }): string {
	const id = `sent-${crypto.randomUUID().slice(0, 8)}`;
	db.prepare(
		"INSERT INTO sent_messages (id, dedup_key, recipient_contact_id, scope, route_json, text, requested_via, requested_by, requester_scope, created_at) VALUES (?, ?, 'jacob', 'contact:jacob', '{}', ?, 'background', 'iyye', ?, ?)",
	).run(id, `iyye:jacob:${id}`, o.text, `iyye:social:${o.opportunityId}`, o.at.toISOString());
	if (o.state === null) return id;
	db.prepare(
		"INSERT INTO actions (id, kind, route_json, content_hash, idempotency_key, state, created_at) VALUES (?, 'status', '{}', 'h', ?, ?, ?)",
	).run(`act-${id}`, `notice:send:${id}`, o.state ?? "delivered", o.at.toISOString());
	db.prepare("UPDATE sent_messages SET action_id = ? WHERE id = ?").run(`act-${id}`, id);
	return id;
}

/** The full chain on one database: ledger, composer (real), actor, tracker, plans, investigations. */
function stack(
	db: Db,
	clock: { t: Date },
	o: {
		answers?: string[];
		budgetMin?: number;
		yieldAfter?: () => string | null;
		composeMs?: number;
		/** Runs while the model call is pending (a person writes, the owner forgets someone). */
		during?: () => void;
		/** The outbox state a sent follow-up ends in. */
		delivery?: string;
	} = {},
) {
	const answers = [...(o.answers ?? [])];
	const sent = { notices: [] as { key: string; content: string }[], messages: [] as string[] };
	const ledger = new InitiativeLedger({ db, budgetMin: o.budgetMin ?? 120, now: () => clock.t });
	const local = new DeviceSlot();
	const composer = makeComposer({
		device: local,
		models: { selected: () => "bg", acquire: async () => ({ model: "bg", valid: () => true, release: () => {} }) },
		background: { blockedReason: () => null, yieldReason: () => o.yieldAfter?.() ?? null },
		complete: async (_m, _s, _u, signal) => {
			clock.t = new Date(clock.t.getTime() + (o.composeMs ?? 30_000)); // the call takes device time
			o.during?.();
			await new Promise((r) => setTimeout(r, 5));
			if (signal.aborted) throw new Error("aborted");
			return answers.shift() ?? "{}";
		},
		ledger,
		now: () => clock.t,
		watchMs: 1,
	});
	const plans = new PlanRunner({
		db,
		worker: { enqueue: () => "job" },
		outbox: { notifyOwner: async (r) => void sent.notices.push(r) },
		log: silentLogger,
		now: () => clock.t,
		newId,
	});
	const actor = new MotivationActor({
		db,
		log: silentLogger,
		mode: () => "awake",
		notifyOwner: async (r) => void sent.notices.push(r),
		self: { value: () => null, setFacet: () => undefined } as never,
		now: () => clock.t,
		newId,
		compose: composer,
		proposePlan: (p) => plans.proposePlan(p),
		sendMessage: async (_p, text, via) => {
			sent.messages.push(text);
			const id = recordSend(db, { opportunityId: via.split(":").at(-1)!, text, at: clock.t, state: o.delivery });
			return { text: "sent", sentId: id, state: o.delivery ?? "delivered" };
		},
		ledger,
	});
	const tracker = new MotivationTracker({
		db,
		log: silentLogger,
		mode: () => "awake",
		sources: { selfGaps: () => [], healing: () => [], sleep: () => null },
		now: () => clock.t,
		newId,
		actor,
	});
	const jobs: { origin: string; session?: string; prompt: string }[] = [];
	const investigations = new Investigations({
		db,
		worker: {
			enqueue: (step) => {
				jobs.push(step);
				return `job-${jobs.length}`;
			},
			initiativePaused: () => false,
		},
		mode: () => "awake",
		log: silentLogger,
		now: () => clock.t,
		newId,
		ledger,
	});
	return { ledger, actor, tracker, plans, investigations, jobs, sent };
}

const opp = (db: Db, cluster: string) =>
	db.prepare("SELECT * FROM opportunities WHERE cluster = ?").get(cluster) as
		| { id: string; status: string; outcome: string | null; credited: number; ref: string | null; attempts: number }
		| undefined;
const events = (db: Db, id: string) =>
	(
		db.prepare("SELECT kind, reason FROM motivation_events WHERE opportunity_id = ? ORDER BY at, rowid").all(id) as {
			kind: string;
			reason: string | null;
		}[]
	).map((e) => `${e.kind}${e.reason ? `:${e.reason}` : ""}`);

/** Exit gate: every settled or suspended opportunity has an identifiable outcome. */
function everySettlementHasAReason(db: Db): void {
	const bad = db
		.prepare(
			"SELECT id, status, answer FROM opportunities WHERE status IN ('settled', 'suspended') AND outcome IS NULL",
		)
		.all();
	assert.deepEqual(bad, [], "settled rows without an outcome");
}

describe("M4: one need, one opportunity, settled by its condition", () => {
	test("a sustained outage opens one notice; recovery settles it, uncredited; need decays, across a restart", async () => {
		const db = freshDb();
		const clock = { t: NOON };
		const state = { s: "retrying" };
		const probe = () => ({ Telegram: { state: state.s, detail: "getUpdates failed: socket hang up" } });
		recordServices(db, probe, clock.t);
		let s = stack(db, clock);
		for (let i = 0; i < 15; i++) {
			clock.t = new Date(clock.t.getTime() + 10 * MIN);
			recordServices(db, probe, clock.t);
			await s.tracker.sweep();
		}
		const rows = db.prepare("SELECT * FROM opportunities WHERE motivation = 'self_preservation'").all() as {
			id: string;
			status: string;
		}[];
		assert.equal(rows.length, 1, "one opportunity for one outage");
		assert.equal(s.sent.notices.length, 1, "one notice");
		const id = rows[0]!.id;
		// A restart: a new stack on the same database keeps the smoothing, and opens nothing new.
		s = stack(db, clock);
		const before = (
			db
				.prepare(
					"SELECT smoothed FROM motivation_samples WHERE motivation = 'self_preservation' ORDER BY at DESC LIMIT 1",
				)
				.get() as { smoothed: number }
		).smoothed;
		state.s = "connected";
		for (let i = 0; i < 6; i++) {
			clock.t = new Date(clock.t.getTime() + 10 * MIN);
			recordServices(db, probe, clock.t);
			await s.tracker.sweep();
		}
		const after = (
			db
				.prepare(
					"SELECT smoothed FROM motivation_samples WHERE motivation = 'self_preservation' ORDER BY at DESC LIMIT 1",
				)
				.get() as { smoothed: number }
		).smoothed;
		assert.ok(after < before / 2, `need decays after the condition cleared (${before} → ${after})`);
		const o = db.prepare("SELECT status, outcome, credited FROM opportunities WHERE id = ?").get(id);
		assert.deepEqual(o, { status: "settled", outcome: "resolved", credited: 0 }, "a notice earns no credit");
		assert.equal(s.sent.notices.length, 0, "nothing more after the restart");
		assert.deepEqual(
			events(db, id).map((e) => e.split(":")[0]),
			["opened", "attempted", "settled"],
		);
		everySettlementHasAReason(db);
	});

	test("a recurring question gives one investigation; three fruitless attempts suspend it, and a restart keeps it so", async () => {
		const db = freshDb();
		const clock = { t: NOON };
		let s = stack(db, clock);
		db.prepare(
			`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, signal_kind, action_kind)
			 VALUES ('q1', 'question:o1', 'conversation', '[]', 'asked twice', 'Which model fits?', 'open', ?, ?, 'curiosity', 'question_recurring', 'investigate')`,
		).run(clock.t.toISOString(), clock.t.toISOString());
		for (let attempt = 1; attempt <= 3; attempt++) {
			await s.investigations.tick();
			for (let step = 1; step <= 3; step++) {
				const job = s.jobs.at(-1)!;
				const id = `done-${attempt}-${step}`;
				insertBackgroundJob(db, {
					id,
					origin: job.origin,
					session: job.session!,
					prompt: job.prompt,
					at: clock.t.toISOString(),
				});
				db.prepare(
					"UPDATE background_jobs SET status = 'settled', result = 'I think the big one.' WHERE id = ?",
				).run(id);
				s.ledger.chargeStep({ id, origin: job.origin }, 1, 4 * MIN, true, true);
				s.investigations.onStepSettled(getBackgroundJob(db, id)!);
			}
			clock.t = new Date(clock.t.getTime() + 2 * HOUR); // past the cooldown
		}
		assert.deepEqual(db.prepare("SELECT status, outcome, fruitless FROM opportunities WHERE id = 'q1'").get(), {
			status: "suspended",
			outcome: "suspended",
			fruitless: 3,
		});
		s = stack(db, clock); // a restart
		const before = s.jobs.length;
		await s.investigations.tick();
		assert.equal(s.jobs.length, before, "suspended across the restart");
		assert.deepEqual(
			events(db, "q1").filter((e) => e.startsWith("attempted") || e.startsWith("fruitless")).length,
			6,
		);
		assert.equal(s.ledger.usedMs("curiosity"), 36 * MIN, "nine steps of 4 min, on the MBP, counted the same");
		everySettlementHasAReason(db);
	});
});

describe("M4: proposals and follow-ups have distinct outcomes", () => {
	const draft = JSON.stringify({
		concrete: true,
		intent: "Renew the passport",
		steps: [{ kind: "investigate", text: "Is there a scan of the passport?" }],
	});

	test("an intention gives one unapproved proposal; completed, cancelled, not approved and lapsed differ", async () => {
		const db = freshDb();
		for (const [i, text] of [
			"I need to renew my passport.",
			"I need to sell the old bike.",
			"I need to fix the gate.",
			"I need to call the notary.",
		].entries())
			turn(db, { id: `o${i}`, who: "owner", text, at: new Date(NOON.getTime() + i * MIN) });
		const clock = { t: new Date(NOON.getTime() + HOUR) };
		const s = stack(db, clock, { answers: [draft, draft, draft] });
		const sweepAll = async () => {
			const sigs = collectSignals({ db, now: clock.t, selfGaps: () => [], healing: () => [], sleep: () => null });
			await s.actor.act(
				sigs.filter((x) => x.kind === "intention_unplanned").map((x) => ({ motivation: x.motivation, signal: x })),
				new Set(sigs.map((x) => x.cluster)),
			);
		};
		await sweepAll();
		await sweepAll();
		const proposed = ["intention:o0", "intention:o1"].map((c) => opp(db, c)!);
		assert.ok(
			proposed.every((p) => p.status === "running" && getPlan(db, p.ref!)!.state === "proposed"),
			"never authorized at once",
		);
		assert.equal(opp(db, "intention:o2")!.status, "open", "two proposals a day");
		// Completed (the owner approved it and its step finished), cancelled, not approved in time.
		db.prepare("UPDATE plans SET state = 'completed' WHERE id = ?").run(proposed[0]!.ref);
		s.plans.cancel(proposed[1]!.ref!.slice(0, 8), "owner");
		await s.actor.act([], new Set());
		assert.deepEqual(
			[opp(db, "intention:o0")!.outcome, opp(db, "intention:o0")!.credited, opp(db, "intention:o1")!.outcome],
			["resolved", 1, "declined"],
		);
		// The next day: o2 is proposed and never approved; o3 waits past its time and lapses.
		clock.t = new Date(NOON.getTime() + DAY + HOUR);
		await sweepAll();
		const third = opp(db, "intention:o2")!;
		clock.t = new Date(NOON.getTime() + 5 * DAY);
		await s.plans.tick();
		await s.actor.act([], new Set());
		assert.equal(opp(db, "intention:o2")!.outcome, "declined", `not approved (${getPlan(db, third.ref!)?.reason})`);
		assert.equal(opp(db, "intention:o3")!.outcome, "expired", "the moment passed");
		assert.match(
			traceOpportunity(db, proposed[0]!.id.slice(0, 8)),
			/resolved \(credited\)[\s\S]*attempted: compose[\s\S]*device compose on local: 30 s/,
		);
		everySettlementHasAReason(db);
	});

	test("a follow-up: quiet hours withhold it (noted once a day), no reply expires it, and the next one is held", async () => {
		const db = freshDb();
		turn(db, { id: "j1", who: "jacob", text: "I have my maths test tomorrow", at: new Date(NOON.getTime() - DAY) });
		const clock = { t: new Date(2026, 9, 8, 22, 0) }; // after the test's evening, but outside social hours
		const s = stack(db, clock, { answers: ["How did your maths test go?"] });
		const sweep = async () => {
			const sigs = collectSignals({ db, now: clock.t, selfGaps: () => [], healing: () => [], sleep: () => null });
			await s.actor.act(
				sigs.filter((x) => x.kind === "event_followup").map((x) => ({ motivation: x.motivation, signal: x })),
				new Set(sigs.map((x) => x.cluster)),
			);
		};
		await sweep();
		clock.t = new Date(clock.t.getTime() + 10 * MIN);
		await sweep();
		const id = opp(db, "event:j1")!.id;
		assert.deepEqual(
			events(db, id),
			["opened:event_followup", "withheld:quiet hours"],
			"once a day, not every sweep",
		);
		clock.t = new Date(2026, 9, 9, 10, 0);
		await sweep();
		assert.equal(s.sent.messages.length, 1);
		clock.t = new Date(2026, 9, 12, 11, 0); // three days, no reply
		await s.actor.act([], new Set());
		assert.deepEqual([opp(db, "event:j1")!.outcome, opp(db, "event:j1")!.credited], ["expired", 0]);
		turn(db, { id: "j2", who: "jacob", text: "My driving exam is tomorrow", at: new Date(2026, 9, 12, 11, 30) });
		clock.t = new Date(2026, 9, 13, 20, 0);
		await sweep();
		assert.equal(opp(db, "event:j2")!.outcome, "covered", "held: the last one had no reply");
		assert.equal(s.sent.messages.length, 1);
		everySettlementHasAReason(db);
	});
});

describe("M4: interruption and budget", () => {
	test("a person preempts a composer call: nothing is used, the time is charged as discarded, the opportunity waits", async () => {
		const db = freshDb();
		turn(db, { id: "o1", who: "owner", text: "I need to renew my passport.", at: NOON });
		const clock = { t: new Date(NOON.getTime() + HOUR) };
		let person: string | null = "a person is waiting";
		const draft = JSON.stringify({
			concrete: true,
			intent: "Renew",
			steps: [{ kind: "investigate", text: "Scan?" }],
		});
		const s = stack(db, clock, { answers: [draft, draft], yieldAfter: () => person });
		const sigs = collectSignals({ db, now: clock.t, selfGaps: () => [], healing: () => [], sleep: () => null });
		const open = sigs
			.filter((x) => x.kind === "intention_unplanned")
			.map((x) => ({ motivation: x.motivation, signal: x }));
		await s.actor.act(open, new Set(sigs.map((x) => x.cluster)));
		const o = opp(db, "intention:o1")!;
		assert.deepEqual([o.status, o.attempts], ["open", 0], "not counted as an attempt");
		assert.equal(
			(db.prepare("SELECT count(*) AS n FROM plans").get() as { n: number }).n,
			0,
			"no proposal from discarded output",
		);
		assert.deepEqual(db.prepare("SELECT kept, source FROM initiative_device").all(), [
			{ kept: 0, source: "compose" },
		]);
		assert.ok(events(db, o.id).includes("preempted:owner busy"));
		person = null;
		await s.actor.act([], new Set());
		assert.equal(opp(db, "intention:o1")!.status, "running", "retried later, the opportunity preserved");
	});

	test("allowances: curiosity and agency share a pool, social never borrows; a new day starts afresh", () => {
		const db = freshDb();
		const clock = { t: NOON };
		const s = stack(db, clock, { budgetMin: 10 }); // curiosity 4, agency 3, social 3 min
		const charge = (m: "curiosity" | "agency" | "social", ms: number) =>
			// Discarded work counts against the allowance but not toward the estimates (kept calls are ~1 min).
			s.ledger.charge({
				motivation: m,
				opportunityId: null,
				source: "compose",
				machine: "local",
				ms,
				kept: false,
				ref: newId(),
			});
		charge("curiosity", 5 * MIN); // past its own 4: it borrowed from agency's unused share
		assert.equal(s.ledger.remainingMs("agency"), 2 * MIN);
		assert.ok(!s.ledger.affords("curiosity", "step"), "a 5-minute step does not fit the pool's 2");
		assert.ok(s.ledger.affords("agency", "compose"));
		charge("social", 3 * MIN);
		assert.ok(!s.ledger.affords("social", "compose"), "social never borrows, though the pool has room");
		assert.ok(!s.ledger.stepAllowed("investigation:any"), "the worker holds a queued investigation step");
		assert.ok(s.ledger.stepAllowed("plan:p1:0"), "an approved plan's step is the owner's work: no share");
		clock.t = new Date(2026, 9, 9, 0, 1); // past midnight
		assert.ok(s.ledger.affords("social", "compose"));
		assert.equal(s.ledger.remainingMs("curiosity"), 7 * MIN);
	});

	test("one initiative job at a time across the actor and the investigations loop", async () => {
		const db = freshDb();
		turn(db, { id: "o1", who: "owner", text: "I need to renew my passport.", at: NOON });
		const clock = { t: new Date(NOON.getTime() + HOUR) };
		const s = stack(db, clock, { answers: [JSON.stringify({ concrete: false, intent: "", steps: [] })] });
		db.prepare(
			`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, signal_kind, action_kind)
			 VALUES ('q1', 'question:x', 'conversation', '[]', 'e', 'q', 'running', ?, ?, 'curiosity', 'question_recurring', 'investigate')`,
		).run(NOON.toISOString(), NOON.toISOString());
		const sigs = collectSignals({ db, now: clock.t, selfGaps: () => [], healing: () => [], sleep: () => null });
		await s.actor.act(
			sigs.filter((x) => x.kind === "intention_unplanned").map((x) => ({ motivation: x.motivation, signal: x })),
			new Set(sigs.map((x) => x.cluster)),
		);
		const o = opp(db, "intention:o1")!;
		assert.ok(events(db, o.id).includes("withheld:another initiative job"));
		assert.equal(
			(db.prepare("SELECT count(*) AS n FROM initiative_device").get() as { n: number }).n,
			0,
			"no model call",
		);
		// The other way: while a composer call is in flight, an investigation does not start.
		db.prepare("UPDATE opportunities SET status = 'open' WHERE id = 'q1'").run();
		let release!: () => void;
		const inFlight = s.ledger.whileComposing(
			o.id,
			() =>
				new Promise<void>((r) => {
					release = r;
				}),
		);
		await s.investigations.tick();
		assert.equal(s.jobs.length, 0);
		assert.ok(events(db, "q1").includes("withheld:another initiative job"));
		release();
		await inFlight;
	});

	test("priority is decided from records, not by which loop asks first", () => {
		const db = freshDb();
		const clock = { t: new Date(2026, 9, 8, 15, 0) };
		const s = stack(db, clock);
		const at = NOON.toISOString();
		db.prepare(
			`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, signal_kind, action_kind)
			 VALUES ('f1', 'event:x', 'social', '[]', 'e', 'q', 'open', ?, ?, 'social', 'event_followup', 'follow_up'),
			        ('q1', 'question:y', 'conversation', '[]', 'e', 'q', 'open', ?, ?, 'curiosity', 'question_recurring', 'investigate')`,
		).run(at, at, at, at);
		for (const [m, need] of [
			["social", 0.6],
			["curiosity", 0.6],
		] as const)
			db.prepare(
				"INSERT INTO motivation_samples (id, at, motivation, raw, smoothed, sustained, signals_json) VALUES (?, ?, ?, 0, ?, 3, '[]')",
			).run(newId(), at, m, need);
		// The same need: the follow-up's one-minute call ranks above a five-minute investigation step.
		assert.equal(s.ledger.mayStart("q1"), "higher priority");
		assert.equal(s.ledger.mayStart("f1"), null);
		assert.equal(s.ledger.mayStart("q1"), "higher priority", "asking again changes nothing");
		// Outside social hours the follow-up is not ready, so the investigation may go.
		clock.t = new Date(2026, 9, 8, 22, 0);
		assert.equal(s.ledger.mayStart("q1"), null);
	});
});

describe("M4: what never counts", () => {
	test("self-authored text (replies, summaries, step answers) raises no need and serves none", async () => {
		const db = freshDb();
		const at = new Date(NOON.getTime() - DAY);
		// Iyye's reply states an intention and a dated event; a day summary and a step answer say the same.
		turn(db, {
			id: "o1",
			who: "owner",
			text: "Thanks.",
			reply: "I need to renew your passport tomorrow; you have an exam tomorrow.",
			at,
		});
		db.prepare(
			"INSERT INTO stm_episodes (event_id, kind, scope, channel, contact_id, user_text, reply_text, said_at, answered_at) VALUES ('sum1', 'summary', 'iyye', 'web', 'owner', 'I need to fix the server tomorrow.', '', ?, ?)",
		).run(at.toISOString(), at.toISOString());
		const sigs = collectSignals({ db, now: NOON, selfGaps: () => [], healing: () => [], sleep: () => null });
		assert.deepEqual(
			sigs.filter((x) => x.motivation === "agency" || x.motivation === "social"),
			[],
		);
		// The control: the same words from the owner do open one.
		turn(db, { id: "o2", who: "owner", text: "I need to renew my passport tomorrow.", at });
		const control = collectSignals({ db, now: NOON, selfGaps: () => [], healing: () => [], sleep: () => null });
		assert.deepEqual(
			control.filter((x) => x.kind === "intention_unplanned").map((x) => x.cluster),
			["intention:o2"],
		);
	});

	test("changing every shadow Kev answer changes no action", async () => {
		const run = async (claims: boolean) => {
			const db = freshDb();
			turn(db, {
				id: "o1",
				who: "owner",
				text: "I need to renew my passport.",
				reply: "I will remind you.",
				at: NOON,
			});
			if (claims)
				db.prepare(
					`INSERT INTO decisions (id, role, schema_version, mode, scope, subject_ref, state_json, state_hash, questions_json, status, answers_json, verdicts_json, created_at)
					 VALUES ('d1', 'reply_review', 3, 'shadow', 'owner', 'a-o1', '{}', 'h', '[]', 'ok', '{}', '{"claims_arranged":"yes"}', ?)`,
				).run(NOON.toISOString());
			const clock = { t: new Date(NOON.getTime() + HOUR) };
			const s = stack(db, clock, { answers: [JSON.stringify({ concrete: false, intent: "", steps: [] })] });
			for (let i = 0; i < 4; i++) {
				clock.t = new Date(clock.t.getTime() + 10 * MIN);
				await s.tracker.sweep();
			}
			const seen = (
				db.prepare("SELECT signals_json FROM motivation_samples WHERE motivation = 'social'").all() as {
					signals_json: string;
				}[]
			).some((r) => r.signals_json.includes("claim_without_record"));
			return {
				seen,
				opportunities: db.prepare("SELECT cluster, action_kind, outcome FROM opportunities ORDER BY cluster").all(),
			};
		};
		const withClaims = await run(true);
		const without = await run(false);
		assert.ok(withClaims.seen, "the shadow answer was read (recorded as a signal)");
		assert.ok(!without.seen);
		assert.deepEqual(withClaims.opportunities, without.opportunities, "and changed no action");
	});

	test("/forget during a pending follow-up: the forgotten evidence never returns", async () => {
		const db = freshDb();
		turn(db, { id: "j1", who: "jacob", text: "I have my maths test tomorrow", at: new Date(NOON.getTime() - DAY) });
		const clock = { t: new Date(2026, 9, 8, 22, 0) }; // outside social hours: it waits
		const s = stack(db, clock, { answers: ["How did it go?"] });
		const sweep = async () => {
			const sigs = collectSignals({ db, now: clock.t, selfGaps: () => [], healing: () => [], sleep: () => null });
			await s.actor.act(
				sigs.filter((x) => x.kind === "event_followup").map((x) => ({ motivation: x.motivation, signal: x })),
				new Set(sigs.map((x) => x.cluster)),
			);
		};
		await sweep();
		assert.ok(opp(db, "event:j1"));
		forgetRecords(db, forgetTarget(db, getContact(db, "jacob")!) as never, "owner", clock.t.toISOString());
		clock.t = new Date(2026, 9, 9, 10, 0);
		await sweep();
		assert.equal(s.sent.messages.length, 0);
		assert.ok(!opp(db, "event:j1") || opp(db, "event:j1")!.status !== "open");
	});
});

test("the report and the trial period read records only", () => {
	const db = freshDb();
	const clock = { t: NOON };
	const s = stack(db, clock);
	const t1 = ensureTrial(db, "aaaa", NOON);
	assert.equal(
		ensureTrial(db, "aaaa", new Date(NOON.getTime() + HOUR)).start,
		t1.start,
		"the same behaviour: one period",
	);
	const t2 = ensureTrial(db, "bbbb", new Date(NOON.getTime() + 2 * HOUR));
	assert.notEqual(t2.start, t1.start);
	assert.equal(t2.earlier[0]!.fingerprint, "aaaa");
	clock.t = new Date(NOON.getTime() + 3 * HOUR);
	s.ledger.charge({
		motivation: "social",
		opportunityId: null,
		source: "compose",
		machine: "remote",
		ms: 90_000,
		kept: false,
		ref: "r1",
	});
	const c = countsFor(db, "social", "");
	assert.deepEqual([c.deviceMs, c.discardedMs], [90_000, 90_000]);
	// A notice the outbox could not confirm counts as unconfirmed (the notice's key is its action's key).
	db.prepare(
		"INSERT INTO actions (id, kind, route_json, content_hash, idempotency_key, state, created_at) VALUES ('n1', 'status', '{}', 'h', 'notice:motivation:o9:t', 'unknown', ?)",
	).run(clock.t.toISOString());
	db.prepare(
		"INSERT INTO motivation_events (id, at, opportunity_id, motivation, kind, reason, ref) VALUES ('e9', ?, 'o9', 'social', 'attempted', 'notice', 'notice:motivation:o9:t')",
	).run(clock.t.toISOString());
	db.prepare(
		`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, action_kind)
		 VALUES ('c0ffee99', 'c9', 'conversation', '[]', 'the owner   said: a talk tomorrow', 'q', 'running', ?, ?, 'social', 'follow_up')`,
	).run(clock.t.toISOString(), clock.t.toISOString());
	db.prepare("UPDATE motivation_events SET opportunity_id = 'c0ffee99' WHERE id = 'e9'").run();
	db.prepare("UPDATE actions SET idempotency_key = 'notice:motivation:c0ffee99:t' WHERE id = 'n1'").run();
	db.prepare("UPDATE motivation_events SET ref = 'notice:motivation:c0ffee99:t' WHERE id = 'e9'").run();
	const report = motivationReport(db, s.ledger, { now: clock.t });
	assert.match(report, /social: opened 0, attempted 1[\s\S]*unconfirmed deliveries 1/);
	// What Iyye did is listed with the id that trace and useful take, and whether the owner judged it.
	assert.match(
		report,
		/what Iyye did on its own \(1 without your judgement\):\n {2}c0ffee99 \S+ \S+ social · follow_up — running · not judged yet\n {4}the owner said: a talk tomorrow/,
	);
	assert.match(markUseful(db, "c0ffee99", "yes", clock.t), /noted: c0ffee99 was useful/);
	assert.match(
		motivationReport(db, s.ledger, { now: clock.t }),
		/\(0 without your judgement\)[\s\S]*running · useful/,
	);
	assert.match(report, /trial period since .* \(behaviour bbbb\)/);
	assert.match(
		report,
		/social: opened 0, attempted 1[\s\S]*device: 1\.5 min in the period \(1\.5 discarded\); today 1\.5 of 36\.0 min/,
	);
});

test("the worker: a queued investigation step waits once curiosity's allowance is used; a preempted step is charged as discarded", async () => {
	const db = freshDb();
	const clock = { t: NOON };
	const ledger = new InitiativeLedger({ db, budgetMin: 30, now: () => clock.t }); // curiosity+agency pool: 21 min
	db.prepare(
		`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, signal_kind, action_kind)
		 VALUES ('q1', 'question:z', 'conversation', '[]', 'e', 'q', 'running', ?, ?, 'curiosity', 'question_recurring', 'investigate')`,
	).run(NOON.toISOString(), NOON.toISOString());
	let waiting = false;
	const worker = new BackgroundWorker({
		db,
		device: new DeviceSlot(),
		models: { selected: () => "bg", acquire: async () => ({ model: "bg", valid: () => true, release: () => {} }) },
		conversations: {
			turn: async (req) => {
				clock.t = new Date(clock.t.getTime() + 3 * MIN);
				waiting = true; // a person arrives mid-step
				await new Promise((r) => setTimeout(r, 20));
				return req.signal?.aborted
					? { ok: false, reason: "aborted", message: "aborted" }
					: { ok: true, text: "done", model: "bg" };
			},
			sessionFile: () => null,
		},
		chatPending: () => waiting,
		log: silentLogger,
		now: () => clock.t,
		newId,
		quietMs: 0,
		gapMs: 0,
		watchMs: 1,
		initiative: ledger,
	});
	worker.enqueue({ origin: "investigation:q1", prompt: "look", session: "iyye:inv:web:q1:1" });
	assert.equal(await worker.drainOnce(), true);
	assert.deepEqual(db.prepare("SELECT source, ms, kept, motivation FROM initiative_device").all(), [
		{ source: "step", ms: 3 * MIN, kept: 0, motivation: "curiosity" },
	]);
	assert.equal(
		getBackgroundJob(db, (db.prepare("SELECT id FROM background_jobs").get() as { id: string }).id)!.status,
		"paused",
	);
	// Curiosity's pool runs out: the paused step waits, and the worker says why.
	waiting = false;
	ledger.charge({
		motivation: "agency",
		opportunityId: null,
		source: "compose",
		machine: "local",
		ms: 17 * MIN,
		kept: false,
		ref: "x",
	});
	assert.equal(await worker.drainOnce(), false);
	assert.match(worker.status().waiting, /allowance is used up/);
	// The next day it may run again.
	clock.t = new Date(2026, 9, 9, 9, 0);
	assert.equal(await worker.drainOnce(), true);
});

describe("M4 review: nothing blocks what it should not, nothing happens twice", () => {
	const followUpSetup = (db: Db) => {
		turn(db, { id: "j1", who: "jacob", text: "I have my maths test tomorrow", at: new Date(NOON.getTime() - DAY) });
		db.prepare(
			`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, signal_kind, action_kind)
			 VALUES ('f1', 'event:j1', 'social', '[]', 'e', 'q', 'open', ?, ?, 'social', 'event_followup', 'follow_up')`,
		).run(NOON.toISOString(), NOON.toISOString());
	};

	test("an investigation waiting for its allowance holds nothing: social's follow-up still goes", async () => {
		const db = freshDb();
		followUpSetup(db);
		const clock = { t: new Date(2026, 9, 8, 19, 0) };
		const s = stack(db, clock, { budgetMin: 10, answers: ["How did your maths test go?"] });
		db.prepare(
			`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, signal_kind, action_kind)
			 VALUES ('q1', 'question:y', 'conversation', '[]', 'e', 'q', 'running', ?, ?, 'curiosity', 'question_recurring', 'investigate')`,
		).run(NOON.toISOString(), NOON.toISOString());
		insertBackgroundJob(db, {
			id: "step2",
			origin: "investigation:q1",
			session: "s",
			prompt: "p",
			at: NOON.toISOString(),
		});
		s.ledger.charge({
			motivation: "curiosity",
			opportunityId: "q1",
			source: "step",
			machine: "local",
			ms: 6 * MIN,
			kept: false,
			ref: "x",
		});
		assert.ok(!s.ledger.stepAllowed("investigation:q1"), "curiosity's pool is dry: its next step waits");
		assert.equal(s.ledger.inProgress("f1"), null, "so the investigation holds nothing");
		await s.actor.act([], new Set(["event:j1"]));
		assert.equal(s.sent.messages.length, 1);
	});

	test("a follow-up held by a daily cap does not hold an investigation behind it", async () => {
		const db = freshDb();
		followUpSetup(db);
		const clock = { t: new Date(2026, 9, 8, 19, 0) };
		const s = stack(db, clock);
		db.prepare(
			`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, signal_kind, action_kind)
			 VALUES ('q1', 'question:y', 'conversation', '[]', 'e', 'q', 'open', ?, ?, 'curiosity', 'question_recurring', 'investigate')`,
		).run(NOON.toISOString(), NOON.toISOString());
		for (const [m, need] of [
			["social", 0.6],
			["curiosity", 0.6],
		] as const)
			db.prepare(
				"INSERT INTO motivation_samples (id, at, motivation, raw, smoothed, sustained, signals_json) VALUES (?, ?, ?, 0, ?, 3, '[]')",
			).run(newId(), NOON.toISOString(), m, need);
		assert.equal(s.ledger.mayStart("q1", clock.t), "higher priority");
		// Iyye already wrote to Jacob on its own today: the actor holds the follow-up for the day.
		db.prepare(
			"INSERT INTO sent_messages (id, dedup_key, recipient_contact_id, scope, route_json, text, requested_via, created_at) VALUES ('m1', ?, 'jacob', 'contact:jacob', '{}', 'hi', 'iyye', ?)",
		).run(`iyye:jacob:2026-10-08`, clock.t.toISOString());
		await s.actor.act([], new Set(["event:j1"]));
		assert.ok(events(db, "f1").includes("withheld:daily cap"));
		assert.equal(s.ledger.mayStart("q1", clock.t), null, "the held follow-up no longer outranks it");
	});

	test("a restart right after a follow-up was sent never sends it again", async () => {
		const db = freshDb();
		followUpSetup(db);
		const clock = { t: new Date(2026, 9, 8, 19, 0) };
		const s = stack(db, clock, { answers: ["How did your maths test go?", "How did your maths test go?"] });
		const sent: string[] = [];
		const crashing = new MotivationActor({
			db,
			log: silentLogger,
			mode: () => "awake",
			notifyOwner: async () => {},
			self: { value: () => null, setFacet: () => undefined } as never,
			now: () => clock.t,
			newId,
			compose: async () => ({ ok: true, text: "How did your maths test go?" }),
			sendMessage: async (_p, text, via) => {
				sent.push(text);
				recordSend(db, { opportunityId: via.split(":").at(-1)!, text, at: clock.t });
				throw new Error("the process died here"); // after the message went out
			},
		});
		await crashing.act([], new Set(["event:j1"]));
		assert.equal(sent.length, 1);
		// The next day, a fresh stack on the same database.
		clock.t = new Date(2026, 9, 9, 11, 0);
		await s.actor.act([], new Set(["event:j1"]));
		assert.equal(s.sent.messages.length, 0, "never sent twice");
		assert.equal(opp(db, "event:j1")!.status, "running");
		assert.ok(opp(db, "event:j1")!.ref, "its message's record adopted");
	});

	test("a restart right after a plan was proposed adopts it instead of proposing another", async () => {
		const db = freshDb();
		turn(db, { id: "o1", who: "owner", text: "I need to renew my passport.", at: NOON });
		const clock = { t: new Date(NOON.getTime() + HOUR) };
		const draft = JSON.stringify({
			concrete: true,
			intent: "Renew",
			steps: [{ kind: "investigate", text: "Scan?" }],
		});
		const s = stack(db, clock, { answers: [draft, draft] });
		let crash = true;
		const crashing = new MotivationActor({
			db,
			log: silentLogger,
			mode: () => "awake",
			notifyOwner: async () => {},
			self: { value: () => null, setFacet: () => undefined } as never,
			now: () => clock.t,
			newId,
			compose: async () => ({ ok: true, text: draft }),
			proposePlan: (p) => {
				const r = s.plans.proposePlan(p);
				if (crash) throw new Error("the process died here");
				return r;
			},
		});
		const sigs = collectSignals({ db, now: clock.t, selfGaps: () => [], healing: () => [], sleep: () => null });
		await crashing.act(
			sigs.filter((x) => x.kind === "intention_unplanned").map((x) => ({ motivation: x.motivation, signal: x })),
			new Set(sigs.map((x) => x.cluster)),
		);
		crash = false;
		await s.actor.act([], new Set(sigs.map((x) => x.cluster)));
		assert.equal((db.prepare("SELECT count(*) AS n FROM plans").get() as { n: number }).n, 1, "one plan");
		assert.equal(opp(db, "intention:o1")!.status, "running");
	});

	test("the other machine lost mid-call: the call ran (preempted, charged as discarded), not withheld", async () => {
		const db = freshDb();
		turn(db, { id: "o1", who: "owner", text: "I need to renew my passport.", at: NOON });
		const clock = { t: new Date(NOON.getTime() + HOUR) };
		const ledger = new InitiativeLedger({ db, budgetMin: 120, now: () => clock.t });
		let valid = true;
		const composer = makeComposer({
			device: new DeviceSlot(),
			deviceFor: () => new DeviceSlot(),
			models: {
				selected: () => "m@mbp",
				acquire: async () => ({ model: "m@mbp", valid: () => valid, release: () => {} }),
				isRemote: () => true,
			},
			background: { blockedReason: () => null, yieldReason: () => null },
			complete: async () => {
				clock.t = new Date(clock.t.getTime() + 40_000);
				valid = false; // Wi-Fi drops
				throw new Error("socket hang up");
			},
			ledger,
			now: () => clock.t,
			watchMs: 1,
		});
		const actor = new MotivationActor({
			db,
			log: silentLogger,
			mode: () => "awake",
			notifyOwner: async () => {},
			self: { value: () => null, setFacet: () => undefined } as never,
			now: () => clock.t,
			newId,
			compose: composer,
			proposePlan: () => ({ id: null, text: "no" }),
			ledger,
		});
		const sigs = collectSignals({ db, now: clock.t, selfGaps: () => [], healing: () => [], sleep: () => null });
		await actor.act(
			sigs.filter((x) => x.kind === "intention_unplanned").map((x) => ({ motivation: x.motivation, signal: x })),
			new Set(sigs.map((x) => x.cluster)),
		);
		const o = opp(db, "intention:o1")!;
		assert.ok(events(db, o.id).includes("preempted:model lost"));
		assert.deepEqual(db.prepare("SELECT machine, ms, kept FROM initiative_device").all(), [
			{ machine: "remote", ms: 40_000, kept: 0 },
		]);
		assert.deepEqual([o.status, o.attempts], ["open", 0], "not counted: it waits for the machine");
	});
});

describe("M4 review 2: between the model call and the effect, and what earns credit", () => {
	const followUpSetup = (db: Db) => {
		turn(db, { id: "j1", who: "jacob", text: "I have my maths test tomorrow", at: new Date(NOON.getTime() - DAY) });
		db.prepare(
			`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, signal_kind, action_kind)
			 VALUES ('f1', 'event:j1', 'social', '[]', 'e', 'q', 'open', ?, ?, 'social', 'event_followup', 'follow_up')`,
		).run(NOON.toISOString(), NOON.toISOString());
	};

	test("/forget while the follow-up is being composed: the call is cancelled and nothing is sent", async () => {
		const db = freshDb();
		followUpSetup(db);
		const clock = { t: new Date(2026, 9, 8, 19, 0) };
		const s = stack(db, clock, {
			answers: ["How did your maths test go?"],
			during: () =>
				forgetRecords(db, forgetTarget(db, getContact(db, "jacob")!) as never, "owner", clock.t.toISOString()),
		});
		await s.actor.act([], new Set(["event:j1"]));
		assert.equal(opp(db, "event:j1"), undefined, "the opportunity was forgotten");
		assert.equal(s.sent.messages.length, 0, "and nothing was sent after it");
		assert.equal((db.prepare("SELECT count(*) AS n FROM sent_messages").get() as { n: number }).n, 0);
		assert.deepEqual(db.prepare("SELECT kept FROM initiative_device").all(), [{ kept: 0 }], "its output discarded");
		assert.deepEqual(events(db, "f1"), [], "nothing recorded against what was forgotten");
	});

	test("quiet hours, a pause or the person writing during the call: nothing is sent, it stays pending", async () => {
		const db = freshDb();
		followUpSetup(db);
		// Started at 20:59, finished at 21:01.
		const clock = { t: new Date(2026, 9, 8, 20, 59) };
		let during: (() => void) | undefined;
		const s = stack(db, clock, {
			answers: ["How did it go?", "How did it go?", "How did it go?", "How did it go?"],
			composeMs: 2 * MIN,
			during: () => during?.(),
		});
		await s.actor.act([], new Set(["event:j1"]));
		assert.equal(s.sent.messages.length, 0, "21:01 is outside the social hours");
		assert.equal(opp(db, "event:j1")!.status, "open");
		assert.ok(events(db, "f1").includes("withheld:quiet hours"));
		// The next morning: the motivation is paused while the call runs.
		clock.t = new Date(2026, 9, 9, 10, 0);
		during = () => void s.actor.pause("social", "owner");
		await s.actor.act([], new Set(["event:j1"]));
		assert.equal(s.sent.messages.length, 0);
		assert.ok(events(db, "f1").includes("withheld:paused"));
		s.actor.resume("social");
		// Jacob writes while the call runs.
		clock.t = new Date(2026, 9, 9, 11, 0);
		during = () => turn(db, { id: "j-mid", who: "jacob", text: "hi", at: clock.t });
		await s.actor.act([], new Set(["event:j1"]));
		assert.equal(s.sent.messages.length, 0);
		assert.ok(events(db, "f1").includes("withheld:person busy"));
		assert.deepEqual([opp(db, "event:j1")!.status, opp(db, "event:j1")!.attempts], ["open", 0]);
		// Later, nothing in the way: it goes.
		clock.t = new Date(2026, 9, 9, 12, 0);
		during = undefined;
		await s.actor.act([], new Set(["event:j1"]));
		assert.equal(s.sent.messages.length, 1);
	});

	test("a reply credits only a delivered follow-up; never sent, failed or unconfirmed earn none", async () => {
		const at = new Date(2026, 9, 8, 19, 0);
		const run = async (setup: (db: Db) => void) => {
			const db = freshDb();
			followUpSetup(db);
			setup(db);
			const clock = { t: new Date(at.getTime() + HOUR) };
			const s = stack(db, clock);
			turn(db, { id: "j-reply", who: "jacob", text: "It went fine", at: new Date(at.getTime() + 30 * MIN) });
			await s.actor.act([], new Set());
			const o = opp(db, "event:j1")!;
			return [o.status, o.outcome, o.credited];
		};
		const running = (db: Db, ref: string | null, answer: string) =>
			db
				.prepare(
					"UPDATE opportunities SET status = 'running', ref = ?, answer = ?, attempt_started_at = ? WHERE id = 'f1'",
				)
				.run(ref, answer, at.toISOString());
		// The crash state: running, "sending", and no record that a message was ever made.
		assert.deepEqual(await run((db) => running(db, null, "sending")), ["settled", "failed", 0]);
		// Delivered, its record found by its label after a restart: credited.
		assert.deepEqual(
			await run((db) => {
				running(db, null, "sending");
				recordSend(db, { opportunityId: "f1", text: "How did it go?", at });
			}),
			["settled", "resolved", 1],
		);
		assert.deepEqual(
			await run((db) =>
				running(db, recordSend(db, { opportunityId: "f1", text: "x", at, state: "terminal_failure" }), "sent"),
			),
			["settled", "failed", 0],
		);
		assert.deepEqual(
			await run((db) =>
				running(db, recordSend(db, { opportunityId: "f1", text: "x", at, state: "unknown" }), "sent"),
			),
			["settled", "resolved", 0],
		);
		// Still queued: a reply is not yet its doing.
		assert.deepEqual(
			await run((db) =>
				running(db, recordSend(db, { opportunityId: "f1", text: "x", at, state: "queued" }), "sent"),
			),
			["running", null, 0],
		);
	});

	test("a reopened opportunity starts clean, and the report counts each episode's own settlement", async () => {
		const db = freshDb();
		const clock = { t: NOON };
		const s = stack(db, clock);
		ensureTrial(db, "t", new Date(NOON.getTime() - HOUR));
		const signal = {
			motivation: "agency" as const,
			kind: "plan_awaiting_approval",
			cluster: "plan:p1",
			evidence: ["plan:p1"],
			weight: 0.6,
			observedAt: NOON.toISOString(),
			text: "a plan waits for approval",
		};
		const opening = [{ motivation: signal.motivation, signal }];
		await s.actor.act(opening, new Set(["plan:p1"]));
		clock.t = new Date(NOON.getTime() + HOUR);
		await s.actor.act([], new Set()); // approved: resolved
		assert.equal(opp(db, "plan:p1")!.outcome, "resolved");
		db.prepare("UPDATE opportunities SET credited = 1 WHERE cluster = 'plan:p1'").run(); // as if credited
		clock.t = new Date(NOON.getTime() + 8 * HOUR); // past the notice cooldown: the same plan waits again
		await s.actor.act(opening, new Set(["plan:p1"]));
		const o = opp(db, "plan:p1")!;
		assert.equal(o.status, "running");
		assert.deepEqual([o.outcome, o.credited, o.ref], [null, 0, null], "the last episode's outcome is not carried");
		const report = motivationReport(db, s.ledger, { now: clock.t });
		assert.match(report, /agency: opened 1, attempted 1; outcomes: resolved 1 \(credited 0\)/);
		clock.t = new Date(NOON.getTime() + 9 * HOUR);
		await s.actor.act([], new Set());
		assert.match(
			motivationReport(db, s.ledger, { now: clock.t }),
			/agency: opened 1, attempted 1; outcomes: resolved 2/,
		);
		everySettlementHasAReason(db);
	});
});
