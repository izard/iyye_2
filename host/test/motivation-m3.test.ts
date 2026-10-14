// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.010 M3: agency proposes plans from the owner's intentions (waiting
 * for approval), social asks people how a dated event went; both settle by
 * what happened, never by having acted.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PlanRunner } from "../src/kernel/plans.ts";
import { silentLogger } from "../src/log.ts";
import { forgetRecords, forgetTarget } from "../src/memory/forget.ts";
import { type ActorDeps, checkFollowUp, MotivationActor, parseDraft } from "../src/motivation/actor.ts";
import type { Composed } from "../src/motivation/compose.ts";
import { EVENING_HOUR, eventDate, statesIntention, unplannedIntentions } from "../src/motivation/detectors.ts";
import { collectSignals } from "../src/motivation/signals.ts";
import { MotivationTracker } from "../src/motivation/tracker.ts";
import { getContact, linkAccount, OWNER_CONTACT_ID } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { getPlan, insertPlan } from "../src/state/plans.ts";
import { recordEpisode } from "../src/state/stm.ts";
import { iyyeMessenger } from "../src/tools/messaging.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Local noon, 8 October 2026 (social hours and evenings are local). */
const NOON = new Date(2026, 9, 8, 12, 0);
let seq = 0;
const newId = () => `${(++seq).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

function freshDb(): Db {
	const db = openDb(":memory:");
	for (const [id, name, tg] of [
		["julia", "Julia", 7001],
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

/** An event in a conversation with no STM entry (a later message, a reply). */
function message(db: Db, id: string, scope: string, at: Date) {
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'telegram', ?, ?, ?, '{}', 'answered')",
	).run(id, id, scope === "owner" ? OWNER_CONTACT_ID : scope.slice(8), scope, at.toISOString());
}

interface Calls {
	compose: { system: string; user: string }[];
	notices: { key: string; content: string }[];
	sends: { personId: string; text: string }[];
}

/** The outbox's record of a delivered message (M4: a reply is credited only to a delivered follow-up). */
function delivered(db: Db, key: string, at: Date): string {
	const id = `act-${crypto.randomUUID().slice(0, 8)}`;
	db.prepare(
		"INSERT OR IGNORE INTO actions (id, kind, route_json, content_hash, idempotency_key, state, created_at) VALUES (?, 'status', '{}', 'h', ?, 'delivered', ?)",
	).run(id, key, at.toISOString());
	return id;
}

function rig(
	db: Db,
	clock: { t: Date },
	o: { answers?: Composed[]; plans?: PlanRunner; extra?: Partial<ActorDeps> } = {},
) {
	const calls: Calls = { compose: [], notices: [], sends: [] };
	const answers = [...(o.answers ?? [])];
	const plans =
		o.plans ??
		new PlanRunner({
			db,
			worker: { enqueue: () => "job" },
			outbox: {
				notifyOwner: async (r) => {
					calls.notices.push(r);
				},
			},
			log: silentLogger,
			now: () => clock.t,
			newId,
		});
	const actor = new MotivationActor({
		db,
		log: silentLogger,
		mode: () => "awake",
		notifyOwner: async (r) => {
			calls.notices.push(r);
			delivered(db, `notice:${r.key}`, clock.t);
		},
		self: { value: () => null, setFacet: () => undefined } as never,
		now: () => clock.t,
		newId,
		compose: async (_label, system, user) => {
			calls.compose.push({ system, user });
			return answers.shift() ?? { ok: false, notNow: "nothing scripted" };
		},
		proposePlan: (p) => plans.proposePlan(p),
		sendMessage: async (personId, text, via) => {
			calls.sends.push({ personId, text });
			const id = `sent-${calls.sends.length}`;
			db.prepare(
				"INSERT INTO sent_messages (id, dedup_key, recipient_contact_id, scope, route_json, text, requested_via, requested_by, requester_scope, created_at, action_id) VALUES (?, ?, ?, ?, '{}', ?, 'background', 'iyye', ?, ?, ?)",
			).run(
				id,
				`k-${id}`,
				personId,
				`contact:${personId}`,
				text,
				via,
				clock.t.toISOString(),
				delivered(db, `notice:send:${id}`, clock.t),
			);
			return { text: "sent", sentId: id, state: "delivered" };
		},
		...o.extra,
	});
	return { actor, calls, plans };
}

const signals = (db: Db, now: Date) =>
	collectSignals({ db, now, selfGaps: () => [], healing: () => [], sleep: () => null });

/** Open what the signals of one motivation name, as the tracker would after a sustained need. */
async function openAll(actor: MotivationActor, db: Db, now: Date, kind: string) {
	const sigs = signals(db, now);
	const mine = sigs.filter((s) => s.kind === kind);
	await actor.act(
		mine.map((s) => ({ motivation: s.motivation, signal: s })),
		new Set(sigs.map((s) => s.cluster)),
	);
}

const opp = (db: Db, cluster: string) =>
	db.prepare("SELECT status, answer, ref, attempts FROM opportunities WHERE cluster = ?").get(cluster) as
		| { status: string; answer: string | null; ref: string | null; attempts: number }
		| undefined;

const ok = (text: string): Composed => ({ ok: true, text });

describe("M3 detectors", () => {
	test("a day with no time is over in the evening; past and recurring dates are not events; today counts", () => {
		const morning = new Date(2026, 9, 8, 8, 0);
		const exam = eventDate("I have my driving exam tomorrow", morning)!;
		assert.equal(exam.at.getDate(), 9);
		assert.equal(exam.at.getHours(), EVENING_HOUR, "not 09:00: the exam may be at two");
		assert.equal(eventDate("I have a meeting tomorrow at 10:00", morning)!.at.getHours(), 10);
		assert.equal(eventDate("Last Monday I had my exam", morning), null);
		assert.equal(eventDate("I play football every Monday", morning), null);
		assert.equal(eventDate("В прошлую пятницу был концерт", morning), null);
		const today = eventDate("The courier brings my parcel today", morning)!;
		assert.equal(today.at.getDate(), 8);
		assert.equal(today.at.getHours(), EVENING_HOUR);
		assert.ok(eventDate("Сегодня у меня собеседование", morning));
	});

	test("suggestions and look-up requests are not intentions; a turn that used a tool did what was asked", () => {
		assert.equal(statesIntention("Let's look at the logs."), null);
		assert.equal(statesIntention("We should check the disk."), null);
		assert.equal(statesIntention("I want to know the weather in Munich."), null);
		assert.equal(statesIntention("Давай посмотрим."), null);
		assert.ok(statesIntention("I need to renew my passport before Friday."));
		assert.ok(statesIntention("Мне надо продлить паспорт."));
		const db = freshDb();
		turn(db, { id: "o1", who: "owner", text: "I need to renew my passport.", at: NOON });
		turn(db, { id: "o2", who: "owner", text: "I need to clean up the disk.", at: new Date(NOON.getTime() + HOUR) });
		db.prepare(
			"INSERT INTO tool_calls (id, scope, principal, tool, args_json, outcome, result, started_at, finished_at) VALUES ('t1', 'owner', 'owner', 'system_status', '{}', 'ok', 'disk', ?, ?)",
		).run(new Date(NOON.getTime() + HOUR).toISOString(), new Date(NOON.getTime() + HOUR).toISOString());
		assert.deepEqual(
			unplannedIntentions(db, new Date(NOON.getTime() + 2 * HOUR)).map((i) => i.cluster),
			["intention:o1"],
		);
	});
});

describe("M3 agency: plans Iyye proposes", () => {
	test("the owner's intention becomes a proposed plan: only the owner's own time words, never authorized at once", async () => {
		const db = freshDb();
		// Thursday 8 October: "before Friday" names Friday 9 October.
		turn(db, {
			id: "o1",
			who: "owner",
			text: "I need to renew my passport, the appointment is friday.",
			reply: "Good luck with it.",
			at: NOON,
		});
		const clock = { t: new Date(NOON.getTime() + 2 * HOUR) };
		const draft = {
			concrete: true,
			intent: "Renew the passport",
			steps: [
				{ kind: "remind", text: "Passport appointment today", when: "friday" },
				{ kind: "remind", text: "Bring photos", when: "tomorrow 10:00" }, // a time the owner did not say
				{ kind: "investigate", text: "Is there a scanned copy of the passport on this computer?" },
				{ kind: "other", text: "Book the appointment" },
			],
		};
		const { actor, calls } = rig(db, clock, { answers: [ok(`Here: ${JSON.stringify(draft)}`)] });
		await openAll(actor, db, clock.t, "intention_unplanned");
		assert.equal(calls.compose.length, 1);
		assert.ok(calls.compose[0]!.user.includes("renew my passport"));
		const o = opp(db, "intention:o1")!;
		assert.equal(o.status, "running");
		const plan = getPlan(db, o.ref!)!;
		assert.equal(plan.state, "proposed", "Iyye's proposal waits for /plan approve, even for the owner's web chat");
		assert.equal(plan.created_event_id, "o1");
		assert.deepEqual(JSON.parse(plan.route_json), { channel: "web", contact: "owner" });
		const steps = JSON.parse(plan.steps_json) as { kind: string; due_at?: string }[];
		assert.deepEqual(
			steps.map((s) => s.kind),
			["remind", "investigate"],
		);
		const due = new Date(steps[0]!.due_at!);
		assert.equal(due.getDate(), 9);
		const notice = calls.notices.find((n) => n.key === `plan-proposed:${plan.id}`)!;
		assert.match(notice.content, /^From what you said/);
		assert.match(notice.content, /\/plan approve/);
		// The intention now has its plan: the signal is gone, and nothing is drafted again. Its reminder is due
		// within a day, but Iyye's own proposal was announced once: no second notice about it waiting.
		assert.deepEqual(
			signals(db, clock.t)
				.filter((s) => s.motivation === "agency")
				.map((s) => s.kind),
			[],
		);
		// Declined: the owner cancels it.
		const { plans } = rig(db, clock);
		plans.cancel(plan.id.slice(0, 8), "owner");
		await actor.act([], new Set());
		assert.deepEqual(
			[opp(db, "intention:o1")!.status, opp(db, "intention:o1")!.answer],
			["settled", "declined: cancelled"],
		);
	});

	test("an unapproved proposal is dropped after its time, and settles as not approved", async () => {
		const db = freshDb();
		turn(db, { id: "o1", who: "owner", text: "I need to change the tyres on 12 october.", at: NOON });
		const clock = { t: new Date(NOON.getTime() + HOUR) };
		const { actor, plans } = rig(db, clock, {
			answers: [
				ok(
					JSON.stringify({
						concrete: true,
						intent: "Check the tyres",
						steps: [{ kind: "remind", text: "Check the tyres", when: "12 october" }],
					}),
				),
			],
		});
		await openAll(actor, db, clock.t, "intention_unplanned");
		const id = opp(db, "intention:o1")!.ref!;
		clock.t = new Date(NOON.getTime() + 2 * DAY);
		await plans.tick();
		assert.equal(getPlan(db, id)!.state, "proposed");
		clock.t = new Date(NOON.getTime() + 3 * DAY + 2 * HOUR);
		await plans.tick();
		assert.deepEqual([getPlan(db, id)!.state, getPlan(db, id)!.reason], ["abandoned", "not approved"]);
		await actor.act([], new Set());
		assert.equal(opp(db, "intention:o1")!.answer, "declined: not approved");
	});

	test("a passing remark proposes nothing; with no step Iyye can do, the owner is told how to set a reminder", async () => {
		const db = freshDb();
		turn(db, { id: "o1", who: "owner", text: "I want to sleep more.", at: NOON });
		turn(db, { id: "o2", who: "owner", text: "I need to call the bank.", at: new Date(NOON.getTime() + 60_000) });
		const clock = { t: new Date(NOON.getTime() + 2 * HOUR) };
		const { actor, calls } = rig(db, clock, {
			answers: [
				ok('{"concrete": false, "intent": "", "steps": []}'),
				ok('{"concrete": true, "intent": "Call the bank", "steps": [{"kind": "other", "text": "Call the bank"}]}'),
			],
		});
		await openAll(actor, db, clock.t, "intention_unplanned");
		await actor.act([], new Set());
		assert.equal(opp(db, "intention:o1")!.status, "settled");
		assert.match(opp(db, "intention:o1")!.answer!, /nothing to plan/);
		assert.equal(opp(db, "intention:o2")!.status, "settled");
		assert.equal((db.prepare("SELECT count(*) AS n FROM plans").get() as { n: number }).n, 0);
		const n = calls.notices.find((x) => x.content.includes("/remind"))!;
		assert.ok(n.content.includes("call the bank"));
	});

	test("an intention opens even when a stronger agency signal with another action is on top", async () => {
		const db = freshDb();
		insertPlan(db, {
			id: "p-urgent",
			intent: "Something Julia proposed",
			proposer_contact_id: "julia",
			scope: "contact:julia",
			route_json: JSON.stringify({ channel: "telegram", chatId: 7001 }),
			proposed_via: "Telegram",
			created_event_id: null,
			steps: [
				{ kind: "remind", text: "x", due_at: new Date(NOON.getTime() + 3 * HOUR).toISOString(), status: "pending" },
			],
			state: "proposed",
			authorization: null,
			created_at: NOON.toISOString(),
		});
		turn(db, { id: "o1", who: "owner", text: "I need to renew my passport.", at: NOON });
		const clock = { t: new Date(NOON.getTime() + HOUR) };
		const { actor } = rig(db, clock, { answers: [ok('{"concrete": false, "intent": "", "steps": []}')] });
		const tracker = new MotivationTracker({
			db,
			log: silentLogger,
			mode: () => "awake",
			sources: { selfGaps: () => [], healing: () => [], sleep: () => null },
			now: () => clock.t,
			newId,
			alpha: 1,
			threshold: 0.5,
			sustain: 1,
			actor,
		});
		await tracker.sweep();
		assert.equal(opp(db, "plan:p-urgent")!.status, "running", "the stronger signal is acted on (a notice)");
		assert.ok(opp(db, "intention:o1"), "and the intention is queued too");
	});

	test("suggestions of /remind count with the proposals", async () => {
		const db = freshDb();
		for (const i of [1, 2, 3])
			turn(db, {
				id: `o${i}`,
				who: "owner",
				text: `I need to call person ${i}.`,
				at: new Date(NOON.getTime() + i * 60_000),
			});
		const clock = { t: new Date(NOON.getTime() + 2 * HOUR) };
		const none = () => ok('{"concrete": true, "intent": "Call", "steps": []}');
		const { actor, calls } = rig(db, clock, { answers: [none(), none(), none()] });
		for (let k = 0; k < 4; k++) await openAll(actor, db, clock.t, "intention_unplanned");
		assert.equal(calls.notices.filter((n) => n.content.includes("/remind")).length, 2);
	});

	test("not now leaves it open; a failing model is tried three times, then settled", async () => {
		const db = freshDb();
		turn(db, { id: "o1", who: "owner", text: "I need to renew my passport.", at: NOON });
		const clock = { t: new Date(NOON.getTime() + 2 * HOUR) };
		const { actor } = rig(db, clock, {
			answers: [
				{ ok: false, notNow: "a conversation was active" },
				{ ok: false, error: "HTTP 500" },
				ok("no json here"),
				{ ok: false, error: "HTTP 500" },
			],
		});
		await openAll(actor, db, clock.t, "intention_unplanned");
		assert.deepEqual([opp(db, "intention:o1")!.status, opp(db, "intention:o1")!.attempts], ["open", 0]);
		await actor.act([], new Set());
		await actor.act([], new Set());
		assert.equal(opp(db, "intention:o1")!.status, "open");
		await actor.act([], new Set());
		assert.deepEqual([opp(db, "intention:o1")!.status, opp(db, "intention:o1")!.attempts], ["settled", 3]);
	});

	test("parseDraft: a time the owner wrote, resolved from when they said it; a time already past is dropped", () => {
		const said = new Date(2026, 9, 8, 9, 0).toISOString();
		const d = parseDraft(
			JSON.stringify({
				concrete: true,
				intent: "x",
				steps: [
					{ kind: "remind", text: "a", when: "at 10:00" },
					{ kind: "remind", text: "b", when: "18:00" },
				],
			}),
			{ user_text: "I have to send it at 10:00, and call at 18:00", said_at: said },
			new Date(2026, 9, 8, 12, 0),
		);
		assert.ok(typeof d !== "string");
		assert.deepEqual(d.steps, [{ kind: "remind", text: "b", when: "2026-10-08 18:00" }]);
	});
});

describe("M3 social: follow-ups", () => {
	const setup = (opts: { answers?: Composed[]; at?: Date } = {}) => {
		const db = freshDb();
		turn(db, {
			id: "j1",
			who: "jacob",
			text: "I have my maths test tomorrow, wish me luck",
			reply: "Good luck!",
			at: new Date(NOON.getTime() - DAY),
		});
		const clock = { t: opts.at ?? new Date(NOON.getTime() + 7 * HOUR) }; // 19:00, the test's evening is over
		return { db, clock, ...rig(db, clock, { answers: opts.answers ?? [ok("How did your maths test go?")] }) };
	};

	test("after the event is over, Iyye asks the person, from their own message only, and a reply settles it", async () => {
		const { db, clock, actor, calls } = setup();
		await openAll(actor, db, new Date(NOON.getTime() + 2 * HOUR), "event_followup");
		assert.equal(calls.compose.length, 0, "the test is not over at 14:00");
		await openAll(actor, db, clock.t, "event_followup");
		assert.equal(calls.compose.length, 1);
		const c = calls.compose[0]!;
		assert.ok(c.user.includes("maths test"));
		assert.ok(!c.user.includes("Good luck"), "nothing but the person's own words");
		assert.match(c.system, /"Jacob"/);
		assert.deepEqual(calls.sends, [{ personId: "jacob", text: "How did your maths test go?" }]);
		assert.equal(opp(db, "event:j1")!.status, "running");
		assert.equal(
			signals(db, clock.t).some((s) => s.kind === "event_followup"),
			false,
			"followed up: the opportunity carries it",
		);
		message(db, "j2", "contact:jacob", new Date(clock.t.getTime() + HOUR));
		await actor.act([], new Set());
		assert.deepEqual([opp(db, "event:j1")!.status, opp(db, "event:j1")!.answer], ["settled", "replied"]);
	});

	test("never outside social hours, nor while the person is in a conversation", async () => {
		const late = setup({ at: new Date(2026, 9, 8, 22, 30) });
		await openAll(late.actor, late.db, late.clock.t, "event_followup");
		assert.equal(late.calls.compose.length, 0);
		const busy = setup();
		message(busy.db, "j2", "contact:jacob", new Date(busy.clock.t.getTime() - 60_000));
		await openAll(busy.actor, busy.db, busy.clock.t, "event_followup");
		assert.equal(busy.calls.compose.length, 0);
		assert.equal(opp(busy.db, "event:j1")!.status, "open");
	});

	test("no reply in three days: settled with no credit, and the next follow-up to them is held", async () => {
		const { db, clock, actor, calls } = setup();
		await openAll(actor, db, clock.t, "event_followup");
		clock.t = new Date(clock.t.getTime() + 3 * DAY + HOUR);
		await actor.act([], new Set());
		assert.equal(opp(db, "event:j1")!.answer, "no reply");
		// A later message of Jacob's names another event (written after the follow-up was settled as unanswered).
		turn(db, { id: "j3", who: "jacob", text: "Concert tomorrow!", at: new Date(2026, 9, 9, 20, 0) });
		clock.t = new Date(2026, 9, 11, 19, 0);
		const sigs = signals(db, clock.t).filter((s) => s.cluster === "event:j3");
		assert.equal(sigs.length, 1);
		await actor.act([{ motivation: "social", signal: sigs[0]! }], new Set());
		assert.equal(calls.sends.length, 1);
		assert.match(opp(db, "event:j3")!.answer!, /held/);
	});

	test("one follow-up per person at a time: two messages about one parcel get one question", async () => {
		const db = freshDb();
		turn(db, { id: "o1", who: "owner", text: "The parcel should arrive tomorrow.", at: new Date(2026, 9, 7, 9, 0) });
		turn(db, {
			id: "o2",
			who: "owner",
			text: "The parcel is with the courier today.",
			at: new Date(2026, 9, 8, 9, 0),
		});
		const clock = { t: new Date(2026, 9, 8, 19, 0) };
		const { actor, calls } = rig(db, clock, { answers: [ok("Did the parcel arrive?"), ok("And the parcel?")] });
		await openAll(actor, db, clock.t, "event_followup");
		await openAll(actor, db, clock.t, "event_followup");
		assert.equal(calls.notices.filter((n) => n.key.startsWith("followup:")).length, 1);
		assert.deepEqual(
			[opp(db, "event:o1")!.status, opp(db, "event:o2")!.answer],
			["running", "covered: Iyye asked them recently"],
		);
	});

	test("the composed message is checked: another person's name or a link is not sent", async () => {
		assert.deepEqual(checkFollowUp("How did it go? Alex asked too.", ["Alex", "Julia"]), {
			why: "names another person",
		});
		assert.deepEqual(checkFollowUp("See https://example.com", []), { why: "a link" });
		assert.equal(checkFollowUp('"How did it go?"', ["Julia"]), "How did it go?");
		const { db, clock, actor, calls } = setup({
			answers: [ok("Julia says hi! How did it go?"), ok("How did it go?")],
		});
		await openAll(actor, db, clock.t, "event_followup");
		assert.equal(calls.sends.length, 0);
		assert.equal(opp(db, "event:j1")!.attempts, 1);
		await actor.act([], new Set());
		assert.equal(calls.sends.length, 1);
	});

	test("the owner is asked in the web chat; the owner's next message settles it", async () => {
		const db = freshDb();
		turn(db, { id: "o1", who: "owner", text: "My DGX Spark arrives today.", at: new Date(2026, 9, 8, 9, 0) });
		const clock = { t: new Date(2026, 9, 8, 19, 30) };
		const { actor, calls } = rig(db, clock, { answers: [ok("Did the DGX Spark arrive?")] });
		await openAll(actor, db, clock.t, "event_followup");
		const n = calls.notices.find((x) => x.key.startsWith("followup:"))!;
		assert.equal(n.content, "Did the DGX Spark arrive?");
		assert.equal(calls.sends.length, 0);
		message(db, "o2", "owner", new Date(clock.t.getTime() + 60_000));
		await actor.act([], new Set());
		assert.equal(opp(db, "event:o1")!.answer, "replied");
	});

	test("at most the daily number of follow-ups, in all", async () => {
		const db = freshDb();
		turn(db, { id: "j1", who: "jacob", text: "Exam tomorrow", at: new Date(NOON.getTime() - DAY) });
		turn(db, { id: "o1", who: "owner", text: "Dentist tomorrow", at: new Date(NOON.getTime() - DAY + 60_000) });
		const clock = { t: new Date(NOON.getTime() + 7 * HOUR) };
		const { actor, calls } = rig(db, clock, {
			answers: [ok("How did it go?"), ok("And the dentist?")],
			extra: { socialPerDay: 1 },
		});
		for (let k = 0; k < 3; k++) await openAll(actor, db, clock.t, "event_followup");
		assert.equal(calls.sends.length + calls.notices.filter((n) => n.key.startsWith("followup:")).length, 1);
		assert.equal(calls.compose.length, 1);
	});

	test("/forget reaches a follow-up about what they said", async () => {
		const { db, clock, actor } = setup();
		await openAll(actor, db, clock.t, "event_followup");
		assert.ok(opp(db, "event:j1"));
		forgetRecords(db, forgetTarget(db, getContact(db, "jacob")!) as never, "owner", clock.t.toISOString());
		assert.equal(opp(db, "event:j1"), undefined);
	});
});

describe("M3 messaging: Iyye writes on its own", () => {
	test("labelled From Iyye, one a day per person, shared with telegram_send's own key, the owner told", async () => {
		const db = freshDb();
		const sent: { key: string; content: string }[] = [];
		const notices: string[] = [];
		const send = iyyeMessenger({
			db,
			outbox: {
				sendOwn: async (r) => {
					sent.push({ key: r.key, content: r.content });
					const id = `act-${sent.length}`;
					db.prepare(
						"INSERT INTO actions (id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, 'reply', '{}', 'h', ?, 'delivered', 't', ?)",
					).run(id, `notice:${r.key}`, r.content);
					return { id, state: "delivered", last_error: null } as never;
				},
				notifyOwner: async (r) => {
					notices.push(r.content);
					return undefined as never;
				},
			},
			now: () => NOON,
		});
		const r = await send("jacob", "How did your test go?", "iyye:social:x");
		assert.ok(r.sentId);
		assert.equal(sent[0]!.content, "✉️ From Iyye:\n\nHow did your test go?");
		assert.match(notices[0]!, /Iyye wrote to "Jacob" on its own/);
		const again = await send("jacob", "And?", "iyye:social:y");
		assert.equal(again.sentId, null);
		assert.match(again.text, /already wrote/);
		assert.equal(
			(db.prepare("SELECT dedup_key FROM sent_messages").get() as { dedup_key: string }).dedup_key,
			"iyye:jacob:2026-10-08",
		);
		assert.ok(getContact(db, "jacob"));
	});
});
