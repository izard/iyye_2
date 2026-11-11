// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.018 W6: a request the owner keeps making becomes a routine Iyye
 * proposes; approved, it runs every day as a background step with the web,
 * and the host delivers its answer. Everything from records put there by the
 * test; no model, no web, no Telegram.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { PlanRunner } from "../src/kernel/plans.ts";
import { forgetRoutineTexts, RoutineRunner, routineNote } from "../src/kernel/routines.ts";
import { silentLogger } from "../src/log.ts";
import { MotivationActor } from "../src/motivation/actor.ts";
import { recurringRequests } from "../src/motivation/detectors.ts";
import { collectSignals } from "../src/motivation/signals.ts";
import { Outbox, type Route } from "../src/outbox/outbox.ts";
import { getBackgroundJob, insertBackgroundJob } from "../src/state/background.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { type EventRow, getEvent } from "../src/state/events.ts";
import { getPlan, steps } from "../src/state/plans.ts";
import { recordEpisode } from "../src/state/stm.ts";
import { WEB_INVESTIGATION_SCOPE } from "../src/tools/broker.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A Monday, 12:00 local (the routines' hours are local). */
const NOON = new Date(2026, 10, 23, 12, 0);
const at = (dayOffset: number, hhmm: string) => {
	const [h, m] = hhmm.split(":").map(Number);
	const d = new Date(NOON.getTime() + dayOffset * DAY);
	d.setHours(h!, m!, 0, 0);
	return d;
};
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const OWNER_TG: Route = { channel: "telegram", chatId: 5001 };

/** An owner turn on Telegram, answered, with the tools the turn used. */
function turn(db: Db, id: string, when: Date, text: string, tools: [string, string][] = []) {
	const iso = when.toISOString();
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'telegram', 'owner', 'owner', ?, ?, 'answered')",
	).run(id, id, iso, JSON.stringify({ message: { text, chatId: 5001 } }));
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, 'OK.')",
	).run(`a-${id}`, id, `k-${id}`, iso);
	recordEpisode(db, getEvent(db, id)!, { id: `a-${id}`, content: "OK." }, iso);
	for (const [i, [tool, toolkit]] of tools.entries())
		db.prepare(
			"INSERT INTO tool_calls (id, scope, principal, tool, toolkit, args_json, outcome, result, started_at, finished_at, event_id) VALUES (?, 'owner', 'owner', ?, ?, '{}', 'ok', 'r', ?, ?, ?)",
		).run(`tc-${id}-${i}`, tool, toolkit, iso, iso, id);
}

const WEB: [string, string][] = [
	["web_search", "web"],
	["web_fetch", "web"],
];

/** Six mornings of the news request, in two wordings; a greeting with no tool; trying a tool that has an effect. */
function history(db: Db) {
	for (const [i, d] of [-8, -7, -6, -3, -2, -1].entries()) {
		turn(
			db,
			`news-${i}`,
			at(d, i === 3 ? "17:05" : `09:${10 + i * 5}`),
			i % 2
				? "Good morning Iyye, what are news today? And localllama reddit"
				: "Morning! What are AI news and locallama?",
			WEB,
		);
		turn(db, `hello-${i}`, at(d, "08:00"), "Good morning, how are you today my friend?");
		turn(db, `think-${i}`, at(d, "15:00"), "now try the thinking model again please", [
			["ask_thinking_model", "thinking"],
		]);
	}
}

describe("the detector", () => {
	test("one request recurs: the turns answered with read-only tools; its usual time, days and latest wording", () => {
		const db = openDb(":memory:");
		history(db);
		const found = recurringRequests(db, NOON, TZ);
		assert.equal(found.length, 1);
		const [r] = found;
		assert.equal(r!.task, "Good morning Iyye, what are news today? And localllama reddit");
		assert.deepEqual([r!.turns, r!.days, r!.schedule], [6, 6, "daily"]);
		// First asks: 09:10, 09:15, 09:20, 17:05, 09:30, 09:35: the first quartile is 09:15.
		assert.equal(r!.atMinute, 9 * 60 + 15);
		assert.equal(r!.eventId, "news-5");
		assert.match(r!.cluster, /^routine:[0-9a-f]{12}$/);
		assert.equal(recurringRequests(db, NOON, TZ)[0]!.cluster, r!.cluster, "the same request, the same cluster");
		// Three days are not yet a habit.
		const young = openDb(":memory:");
		for (const d of [-3, -2, -1]) turn(young, `n${d}`, at(d, "09:00"), "What are AI news and locallama today?", WEB);
		assert.deepEqual(recurringRequests(young, NOON, TZ), []);
		// As a signal: agency, with the owner's own turns as evidence.
		const sig = collectSignals({
			db,
			now: NOON,
			timezone: TZ,
			selfGaps: () => [],
			healing: () => [],
			sleep: () => null,
		}).filter((s) => s.kind === "request_recurring");
		assert.equal(sig.length, 1);
		assert.equal(sig[0]!.motivation, "agency");
		assert.match(sig[0]!.text, /^the owner asked for the same thing on 6 of the last 14 days: Good morning Iyye/);
		assert.ok(sig[0]!.evidence.every((e) => e.startsWith("event:news-")));
	});
});

// ---------------------------------------------------------------- proposed, approved, run, delivered

function rig() {
	const db = openDb(":memory:");
	history(db);
	const clock = { now: NOON };
	const mode = { m: "awake" as "awake" | "asleep" };
	const net = { online: true as boolean | null };
	const notices: string[] = [];
	const sent: { key: string; route: Route; content: string }[] = [];
	const queue: { origin: string; prompt: string; session?: string }[] = [];
	let n = 0;
	const worker = {
		// As the real worker: a queued job exists from the moment a step is asked for.
		enqueue: (step: { origin: string; prompt: string; session?: string }) => {
			queue.push(step);
			const id = `q-${queue.length}`;
			insertBackgroundJob(db, {
				id,
				origin: step.origin,
				session: step.session ?? `iyye:bg:${id}`,
				prompt: step.prompt,
				at: clock.now.toISOString(),
			});
			return id;
		},
	};
	const outbox = {
		notifyOwner: async (r: { key: string; content: string }) => {
			if (!notices.includes(r.content)) notices.push(r.content);
		},
		sendOwn: async (r: { key: string; route: Route; content: string }) => {
			sent.push(r);
			return { id: `act-${sent.length}` };
		},
	};
	const plans = new PlanRunner({ db, worker, outbox, log: silentLogger, now: () => clock.now, routinesMax: 1 });
	const routines = new RoutineRunner({
		db,
		worker,
		outbox,
		mode: () => mode.m,
		online: () => net.online,
		log: silentLogger,
		now: () => clock.now,
		timezone: TZ,
		silentRuns: 2,
	});
	const actor = new MotivationActor({
		db,
		log: silentLogger,
		mode: () => "awake",
		notifyOwner: async (r) => {
			notices.push(r.content);
		},
		self: { value: () => null, setFacet: () => undefined } as never,
		now: () => clock.now,
		compose: async () => {
			throw new Error("a routine is proposed without a model call");
		},
		proposePlan: (p) => plans.proposePlan(p),
		routineIdea: (cluster) => {
			const r = recurringRequests(db, clock.now, TZ).find((x) => x.cluster === cluster);
			const event = r ? (db.prepare("SELECT * FROM events WHERE id = ?").get(r.eventId) as EventRow) : null;
			return r && event
				? {
						task: r.task,
						atMinute: r.atMinute,
						schedule: r.schedule,
						days: r.days,
						route: Outbox.chatRouteFor(event),
						eventId: r.eventId,
					}
				: null;
		},
	});
	const propose = async () => {
		const sigs = collectSignals({
			db,
			now: clock.now,
			timezone: TZ,
			selfGaps: () => [],
			healing: () => [],
			sleep: () => null,
		});
		await actor.act(
			sigs.filter((s) => s.kind === "request_recurring").map((s) => ({ motivation: s.motivation, signal: s })),
			new Set(sigs.map((s) => s.cluster)),
		);
		return (
			(db.prepare("SELECT id FROM plans ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined)
				?.id ?? null
		);
	};
	const cmd = async (text: string) =>
		(await handleOwnerCommand(text, { models: {} as never, db, issuer: "owner_web", plans })).reply!;
	/** The background step of the queue's last entry ends with this answer, after the web tools returned `result`. */
	const answer = (text: string, result: string | null) => {
		const step = queue.at(-1)!;
		const job = `job-${++n}`;
		const iso = clock.now.toISOString();
		if (result !== null)
			db.prepare(
				"INSERT INTO tool_calls (id, scope, principal, tool, toolkit, args_json, outcome, result, started_at, finished_at) VALUES (?, ?, 'iyye', 'web_search', 'web', '{}', 'ok', ?, ?, ?)",
			).run(`tc-${job}`, step.session, result, iso, iso);
		insertBackgroundJob(db, { id: job, origin: step.origin, session: step.session!, prompt: step.prompt, at: iso });
		db.prepare("UPDATE background_jobs SET status = 'settled', result = ?, settled_at = ? WHERE id = ?").run(
			text,
			iso,
			job,
		);
		routines.onStepSettled(getBackgroundJob(db, job)!);
		return new Promise((r) => setImmediate(r)); // the delivery is handed to the outbox
	};
	const runs = () =>
		db.prepare("SELECT day, state, reason, tries, told FROM routine_runs ORDER BY day").all() as {
			day: string;
			state: string;
			reason: string | null;
			tries: number;
			told: number;
		}[];
	return { db, clock, mode, net, notices, sent, queue, plans, routines, propose, cmd, answer, runs };
}

const PAGES = "LocalLLaMA — https://www.reddit.com/r/LocalLLaMA/ ... AI news — https://example.org/ai-news";
const DIGEST =
	"Two things today: a new 4B model (https://www.reddit.com/r/LocalLLaMA/) and a paper on agents (https://example.org/ai-news).";

describe("a routine", () => {
	test("exit check: proposed from the owner's words, approved, run at its time and delivered where the owner asks", async () => {
		const r = rig();
		const id = (await r.propose())!;
		const p = getPlan(r.db, id)!;
		assert.equal(p.state, "proposed", "never authorized at once");
		assert.deepEqual(JSON.parse(p.route_json), OWNER_TG);
		assert.deepEqual(steps(p), [
			{
				kind: "routine",
				task: "Good morning Iyye, what are news today? And localllama reddit",
				at_minute: 555,
				days: "daily",
				status: "pending",
			},
		]);
		const ref = id.slice(0, 8);
		assert.equal(
			r.notices.at(-1),
			`You asked me for this on 6 of the last 14 days. I could do it on my own every day at 09:15 and send it to you where you ask\n  1. every day at 09:15, on my own: "Good morning Iyye, what are news today? And localllama reddit"\nShall I? /plan approve ${ref} to let it run, /plan time ${ref} HH:MM for another time, /plan cancel ${ref} if not. Unless you approve it, I drop it in 3 day(s).`,
		);
		// Proposed once: the request is answered by the proposal from now on.
		assert.equal(await r.propose(), id);
		assert.equal((r.db.prepare("SELECT count(*) AS n FROM plans").get() as { n: number }).n, 1);
		assert.deepEqual(recurringRequests(r.db, r.clock.now, TZ), []);
		// Nothing runs before approval.
		r.clock.now = at(1, "09:20");
		await r.routines.tick();
		assert.equal(r.queue.length, 0);
		// The owner moves it to 08:30 and approves it at noon: it starts tomorrow, with no skipped day.
		assert.match(await r.cmd(`/plan time ${ref} 08:30`), /is now at 08:30 \(still waiting for \/plan approve/);
		assert.match(await r.cmd(`/plan time ${ref} 25:00`), /give the time as HH:MM/);
		r.clock.now = at(1, "12:00");
		assert.match(await r.cmd(`/plan approve ${ref}`), /^approved/);
		await r.plans.tick();
		assert.equal(getPlan(r.db, id)!.state, "active");
		await r.routines.tick();
		assert.deepEqual(r.runs(), []);
		// The next morning, at its time.
		r.clock.now = at(2, "08:29");
		await r.routines.tick();
		assert.equal(r.queue.length, 0);
		r.clock.now = at(2, "08:31");
		await r.routines.tick();
		await r.routines.tick();
		assert.equal(r.queue.length, 1, "once a day");
		assert.ok(r.queue[0]!.session!.startsWith(`${WEB_INVESTIGATION_SCOPE}routine:`), "the web, never messaging");
		assert.match(
			r.queue[0]!.prompt,
			/^Routine: your owner asked for this again and again, and approved that you do it every day on your own: "Good morning Iyye, what are news today\? And localllama reddit"\nDo it now with web_search and web_fetch/,
		);
		await r.answer(DIGEST, PAGES);
		assert.equal(r.sent.length, 1);
		assert.deepEqual(r.sent[0]!.route, OWNER_TG, "the chat the owner asks in");
		assert.equal(
			r.sent[0]!.content,
			`Your routine, 08:30 ("Good morning Iyye, what are news today? And localllama reddit"):\n\n${DIGEST}`,
		);
		assert.equal(r.runs()[0]!.state, "delivered");
		// The plan stays active: a routine is never done. Later that day nothing more runs.
		await r.plans.tick();
		assert.equal(getPlan(r.db, id)!.state, "active");
		r.clock.now = at(2, "15:00");
		await r.routines.tick();
		assert.equal(r.queue.length, 1);
		// A reply in that chat finds what was sent.
		assert.match(
			routineNote(r.db, "owner", r.clock.now)!,
			/^<routine>\nAt \d\d:\d\d you sent this here on your own, as the routine your owner approved .*\nTwo things today/,
		);
		assert.equal(routineNote(r.db, "contact:x", r.clock.now), null);
		assert.match(await r.cmd(`/plan ${ref}`), /every day at 08:30, on my own/);
	});

	test("a day that cannot run waits, then is skipped, and the next delivery says so", async () => {
		const r = rig();
		const id = (await r.propose())!;
		await r.cmd(`/plan approve ${id.slice(0, 8)}`);
		await r.plans.tick();
		// Tomorrow at its time the network is away; it comes back within the three hours.
		r.net.online = false;
		r.clock.now = at(1, "09:16");
		await r.routines.tick();
		assert.equal(r.queue.length, 0);
		r.net.online = true;
		r.clock.now = at(1, "10:40");
		await r.routines.tick();
		assert.equal(r.queue.length, 1, "late, but today");
		await r.answer(DIGEST, PAGES);
		// The day after, Iyye is asleep all morning: skipped.
		r.mode.m = "asleep";
		r.clock.now = at(2, "09:20");
		await r.routines.tick();
		r.clock.now = at(2, "12:30");
		await r.routines.tick();
		r.mode.m = "awake";
		await r.routines.tick();
		assert.equal(r.queue.length, 1);
		assert.deepEqual(r.runs()[1], {
			day: r.runs()[1]!.day,
			state: "skipped",
			reason: "I was asleep",
			tries: 1,
			told: 0,
		});
		// The third day the answers cite nothing the tools returned: three tries, then failed.
		r.clock.now = at(3, "09:16");
		await r.routines.tick();
		await r.answer("Nothing much happened, I think.", PAGES);
		assert.match(r.queue.at(-1)!.prompt, /That answer is not accepted: it cites no page the tools returned\./);
		await r.answer("See https://invented.example/news for all of it.", null);
		assert.match(
			r.queue.at(-1)!.prompt,
			/it cites https:\/\/invented\.example\/news, which the tools did not return/,
		);
		await r.answer("Still nothing.", null);
		assert.equal(r.runs()[2]!.state, "failed");
		assert.equal(r.sent.length, 1);
		// The fourth day works, and says what did not happen.
		r.clock.now = at(4, "09:16");
		await r.routines.tick();
		await r.answer(DIGEST, PAGES);
		assert.match(
			r.sent[1]!.content,
			new RegExp(
				`\\(Not done on ${r.runs()[1]!.day}: I was asleep; on ${r.runs()[2]!.day}: I found no answer I could ground\\.\\)$`,
			),
		);
		assert.deepEqual(
			r.runs().map((x) => [x.state, x.told]),
			[
				["delivered", 0],
				["skipped", 1],
				["failed", 1],
				["delivered", 0],
			],
		);
		// Said once: the fifth day's message has no such note.
		r.clock.now = at(5, "09:16");
		await r.routines.tick();
		await r.answer(DIGEST, PAGES);
		assert.doesNotMatch(r.sent[2]!.content, /Not done/);
	});

	test("cancelled, it stops; only so many run at a time; only Iyye proposes one; silence is asked about", async () => {
		const r = rig();
		const id = (await r.propose())!;
		const ref = id.slice(0, 8);
		await r.cmd(`/plan approve ${ref}`);
		await r.plans.tick();
		// A second routine is not approved while the first runs (the rig allows one).
		const second = r.plans.proposePlan({
			intent: "another",
			steps: [{ kind: "routine", task: "the weather in Munich", atMinute: 420, days: "weekdays" }],
			proposer: "owner",
			principal: "iyye",
			scope: "owner",
			route: OWNER_TG,
			eventId: null,
			via: "Iyye, from the owner's words",
		});
		assert.match(
			await r.cmd(`/plan approve ${second.id!.slice(0, 8)}`),
			/not approved: 1 routines run already \(at most 1\)/,
		);
		// A person's tool call cannot make one, and neither can the owner's own proposal.
		const byOwner = r.plans.proposePlan({
			intent: "x",
			steps: [{ kind: "routine", task: "x", atMinute: 1, days: "daily" }],
			proposer: "owner",
			principal: "owner",
			scope: "owner",
			route: { channel: "web", contact: "owner" },
			eventId: null,
			via: "web chat",
		});
		assert.equal(byOwner.id, null);
		assert.match(byOwner.text, /a routine is proposed only by Iyye/);
		// Three deliveries, and no word from the owner in that chat after the first two: asked once.
		for (const d of [1, 2, 3]) {
			r.clock.now = at(d, "09:16");
			await r.routines.tick();
			await r.answer(DIGEST, PAGES);
		}
		const keep = r.notices.filter((x) => /Keep it\?/.test(x));
		assert.equal(keep.length, 1);
		assert.match(
			keep[0]!,
			new RegExp(
				`has gone out 2 times with no word from you after it\\. Keep it\\? It runs until you say /plan cancel ${ref}`,
			),
		);
		// The owner answers the next one in that chat: no further question.
		r.clock.now = at(4, "09:16");
		await r.routines.tick();
		await r.answer(DIGEST, PAGES);
		turn(r.db, "reply-1", at(4, "09:40"), "thanks, tell me more about the first one");
		r.clock.now = at(5, "09:16");
		await r.routines.tick();
		await r.answer(DIGEST, PAGES);
		assert.equal(r.notices.filter((x) => /Keep it\?/.test(x)).length, 1);
		// Cancelled: nothing runs any more, and the same request is not proposed again.
		assert.match(await r.cmd(`/plan cancel ${ref}`), /^cancelled/);
		r.clock.now = at(6, "09:16");
		await r.routines.tick();
		assert.equal(r.queue.length, 5);
		assert.deepEqual(recurringRequests(r.db, r.clock.now, TZ), []);
		// /forget: what a routine sent that names the person goes.
		assert.equal(
			forgetRoutineTexts(r.db, (t) => /4B model/.test(t)),
			5,
		);
		assert.equal(routineNote(r.db, "owner", at(5, "10:00")), null);
	});
});
