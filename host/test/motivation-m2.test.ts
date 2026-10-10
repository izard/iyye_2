// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.010 M2: the detectors (deterministic, Kev in shadow), the owner's
 * recurring unanswered questions becoming investigations, questions about
 * uncertain beliefs, the freed question slot, and /forget reaching the
 * motivations' records.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mergeFact } from "../src/facts/beliefs.ts";
import { FactsCommand } from "../src/facts/commands.ts";
import type { StmFact } from "../src/facts/store.ts";
import { silentLogger } from "../src/log.ts";
import { forgetRecords, forgetTarget } from "../src/memory/forget.ts";
import { MemoryGateway, ownerOwnRecall } from "../src/memory/gateway.ts";
import { MotivationActor, type Opening } from "../src/motivation/actor.ts";
import { admitsUnknown, eventDate, recurringQuestions, statesIntention } from "../src/motivation/detectors.ts";
import { collectSignals, type Signal } from "../src/motivation/signals.ts";
import { MotivationTracker } from "../src/motivation/tracker.ts";
import { checkWebCitations } from "../src/observe/citations.ts";
import { Investigations } from "../src/observe/investigations.ts";
import { getBackgroundJob, insertBackgroundJob } from "../src/state/background.ts";
import { getContact } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { recordEpisode } from "../src/state/stm.ts";
import {
	INVESTIGATION_SCOPE,
	type IyyeTool,
	PLAN_STEP_SCOPE,
	ToolBroker,
	type Toolkit,
	WEB_INVESTIGATION_SCOPE,
} from "../src/tools/broker.ts";
import { overBudget } from "../src/tools/web.ts";

const T0 = new Date("2026-10-07T10:00:00Z");
const DAY = 86_400_000;
let seq = 0;
const newId = () => `${(++seq).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

function freshDb(): Db {
	const db = openDb(":memory:");
	for (const [id, name, trusted] of [
		["julia", "Julia", 1],
		["jacob", "Jacob", 0],
	] as const)
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at, trusted) VALUES (?, ?, 'contact', 't', ?)",
		).run(id, name, trusted);
	return db;
}

function turn(db: Db, o: { id: string; who: "owner" | "jacob"; text: string; reply: string; at: Date }) {
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
		JSON.stringify(o.who === "owner" ? { text: o.text } : { message: { text: o.text, chatId: 1 } }),
	);
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, ?)",
	).run(`a-${o.id}`, o.id, `k-${o.id}`, at, o.reply);
	recordEpisode(db, getEvent(db, o.id)!, { id: `a-${o.id}`, content: o.reply }, at);
}

const signals = (db: Db, now = T0) =>
	collectSignals({ db, now, selfGaps: () => [], healing: () => [], sleep: () => null });

function rig(db: Db, now: { t: Date }) {
	const sent: { key: string; content: string }[] = [];
	const actor = new MotivationActor({
		db,
		log: silentLogger,
		mode: () => "awake",
		notifyOwner: async (r) => {
			if (!sent.some((x) => x.key === r.key)) sent.push(r);
		},
		self: { value: () => null, setFacet: () => undefined } as never,
		now: () => now.t,
		newId,
	});
	return { actor, sent };
}

describe("M2 detectors", () => {
	test("the rules: admitting not knowing, an intention, a clear date", () => {
		assert.ok(admitsUnknown("I don't know which year that was."));
		assert.ok(admitsUnknown("I couldn't find anything about it."));
		assert.ok(admitsUnknown("К сожалению, я не знаю."));
		assert.ok(!admitsUnknown("It was 1933."));
		assert.equal(statesIntention("I want to learn Rust this winter."), "I want to learn Rust this winter.");
		assert.equal(statesIntention("Do I want to learn Rust?"), null);
		assert.match(statesIntention("Хочу съездить в Рим.") ?? "", /Рим/);
		const said = new Date("2026-10-05T08:00:00Z"); // a Monday
		assert.equal(eventDate("Jacob has a maths test tomorrow", said)?.phrase, "tomorrow");
		assert.equal(eventDate("My flight is on Friday.", said)?.phrase, "friday");
		assert.equal(eventDate("Remind me tomorrow to call Julia", said), null, "a reminder request is a commitment");
		assert.equal(eventDate("Are you free tomorrow?", said), null);
	});

	test("a recurring question: only the owner's, asked on two days, once Iyye did not know; none once investigated", () => {
		const db = freshDb();
		turn(db, {
			id: "o1",
			who: "owner",
			text: "Which Gemma model fits on the DGX Spark?",
			reply: "I don't know yet.",
			at: new Date(T0.getTime() - 2 * DAY),
		});
		assert.deepEqual(recurringQuestions(db, T0), [], "asked once: no recurrence");
		// Jacob asks the same twice, and Iyye did not know: contacts' questions are never used.
		turn(db, {
			id: "j1",
			who: "jacob",
			text: "How fast is the DGX Spark Gemma model?",
			reply: "I don't know.",
			at: new Date(T0.getTime() - 2 * DAY),
		});
		turn(db, {
			id: "j2",
			who: "jacob",
			text: "DGX Spark Gemma model speed?",
			reply: "I don't know.",
			at: new Date(T0.getTime() - DAY),
		});
		assert.deepEqual(recurringQuestions(db, T0), []);
		turn(db, {
			id: "o2",
			who: "owner",
			text: "Again: which Gemma model would fit the DGX Spark?",
			reply: "Probably the 26B.",
			at: new Date(T0.getTime() - DAY),
		});
		const q = recurringQuestions(db, T0);
		assert.deepEqual(
			q.map((x) => [x.cluster, x.evidence]),
			[["question:o1", ["event:o1", "event:o2"]]],
		);
		assert.deepEqual(
			signals(db)
				.filter((s) => s.kind === "question_recurring")
				.map((s) => s.motivation),
			["curiosity"],
		);
		db.prepare(
			"INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, action_kind) VALUES ('x', 'question:o1', 'conversation', '[]', 'e', 'q', 'suspended', 't', 't', 'investigate')",
		).run();
		assert.deepEqual(recurringQuestions(db, T0), [], "the investigation carries it");
	});

	test("intentions and past dated events are recorded with the samples, and since M3 they open", async () => {
		const db = freshDb();
		turn(db, {
			id: "o1",
			who: "owner",
			text: "I want to learn Rust this winter.",
			reply: "Good idea.",
			at: new Date(T0.getTime() - DAY),
		});
		turn(db, {
			id: "j1",
			who: "jacob",
			text: "I have a maths test tomorrow",
			reply: "Good luck!",
			at: new Date(T0.getTime() - 2 * DAY),
		});
		const s = signals(db);
		assert.deepEqual(s.map((x) => x.kind).sort(), ["event_followup", "intention_unplanned"]);
		assert.ok(
			!s.find((x) => x.kind === "event_followup")!.text.includes("maths"),
			"a contact's words are never quoted",
		);
		const opened: string[] = [];
		const tracker = new MotivationTracker({
			db,
			log: silentLogger,
			mode: () => "awake",
			sources: { selfGaps: () => [], healing: () => [], sleep: () => null },
			now: () => T0,
			alpha: 1,
			threshold: 0.3,
			sustain: 1,
			actor: {
				act: async (o) => {
					opened.push(...o.map((x) => x.signal.cluster));
				},
			},
		});
		await tracker.sweep();
		assert.deepEqual(opened.sort(), ["event:j1", "intention:o1"]);
	});
});

describe("M2 actions", () => {
	const signal = (s: Partial<Signal> & Pick<Signal, "motivation" | "kind" | "cluster">): Signal => ({
		evidence: ["x"],
		weight: 0.6,
		observedAt: T0.toISOString(),
		text: s.kind,
		...s,
	});
	const opening = (s: Signal): Opening => ({ motivation: s.motivation, signal: s });

	test("a recurring question opens a conversation investigation, at most two a day", async () => {
		const db = freshDb();
		const now = { t: T0 };
		const { actor } = rig(db, now);
		for (const id of ["a", "b", "c"]) {
			const s = signal({
				motivation: "curiosity",
				kind: "question_recurring",
				cluster: `question:${id}`,
				text: `the owner asked again, and Iyye did not know: topic ${id}`,
			});
			await actor.act([opening(s)], new Set([s.cluster]));
		}
		const rows = db
			.prepare("SELECT cluster, domain, action_kind, question FROM opportunities ORDER BY created_at")
			.all() as {
			cluster: string;
			domain: string;
			action_kind: string;
			question: string;
		}[];
		assert.deepEqual(
			rows.map((r) => [r.cluster, r.domain, r.action_kind, r.question]),
			[
				["question:a", "conversation", "investigate", "topic a"],
				["question:b", "conversation", "investigate", "topic b"],
			],
		);
	});

	function belief(db: Db, p: number): string {
		const f = {
			id: "f1",
			doc_id: "f1:said",
			event_id: "f1",
			scope: "contact:julia",
			modality: "stated",
			source: "julia",
			subject: "Julia",
			subject_ref: "julia",
			predicate: "plans_to",
			object: "a trip to Rome",
			details: null,
			valid_from: "2026-10-05",
			time_frame: "recent",
			hedged: 0,
			negated: 0,
			quote: "q",
			cited: null,
			fact_key: "julia|plans_to",
			p,
			said_at: T0.toISOString(),
			created_at: T0.toISOString(),
			state: "day",
			merged_at: null,
			belief_id: null,
			private: 0,
		} as StmFact;
		db.prepare(
			`INSERT INTO stm_facts (id, doc_id, event_id, scope, modality, source, subject, subject_ref, predicate, object, details, valid_from,
				time_frame, hedged, negated, quote, cited, fact_key, p, said_at, created_at, private)
			 VALUES (@id, @doc_id, @event_id, @scope, @modality, @source, @subject, @subject_ref, @predicate, @object, @details, @valid_from,
				@time_frame, @hedged, @negated, @quote, @cited, @fact_key, @p, @said_at, @created_at, @private)`,
		).run(f);
		return mergeFact(db, f, { night: "n", maxStep: 2, now: T0, newId }).beliefId!;
	}

	test("an uncertain belief is asked about; /facts confirm answers it, and the slot is free at once for the next question", async () => {
		const db = freshDb();
		const now = { t: T0 };
		const { actor, sent } = rig(db, now);
		const id = belief(db, 0.6);
		const b = signal({ motivation: "curiosity", kind: "belief_uncertain", cluster: `belief:${id}` });
		await actor.act([opening(b)], new Set([b.cluster]));
		assert.equal(sent.length, 1);
		assert.match(
			sent[0]!.content,
			/I am not sure about this: \[possibly 0\.60 · Julia said · today\] Julia plans to a trip to Rome/,
		);
		assert.match(sent[0]!.content, new RegExp(`/facts confirm ${id.slice(0, 8)}`));
		const q = db.prepare("SELECT id FROM self_questions").get() as { id: string };
		assert.match(actor.accept(q.id.slice(0, 8), "yes", "owner_web"), /answer with \/facts confirm/);
		const cmd = new FactsCommand({
			db,
			log: silentLogger,
			ltm: null,
			extractorStatus: () => "",
			now: () => T0,
			newId,
		});
		assert.match(
			await cmd.command(["confirm", id.slice(0, 8)], "owner_web"),
			/confirmed: Julia plans to a trip to Rome \(p 0\.9/,
		);
		// The next sweep no longer sees the doubt: the question is resolved, and another one may go out.
		const place = signal({ motivation: "curiosity", kind: "self_missing", cluster: "self:place:stated" });
		now.t = new Date(T0.getTime() + 60_000);
		await actor.act([opening(place)], new Set([place.cluster]));
		assert.equal(
			(db.prepare("SELECT status FROM self_questions WHERE id = ?").get(q.id) as { status: string }).status,
			"resolved",
		);
		assert.equal(sent.length, 2);
		assert.match(sent[1]!.content, /where am I\?/);
	});

	test("a chat reply to a belief question is not taken as its answer: the slot frees when the question lapses, not in a week", async () => {
		const db = freshDb();
		const now = { t: T0 };
		const { actor, sent } = rig(db, now);
		const id = belief(db, 0.6);
		const b = signal({ motivation: "curiosity", kind: "belief_uncertain", cluster: `belief:${id}` });
		await actor.act([opening(b)], new Set([b.cluster]));
		assert.match(actor.noteFor("owner") ?? "", new RegExp(`/facts confirm ${id.slice(0, 8)}`));
		turn(db, {
			id: "o1",
			who: "owner",
			text: "yes, that's right",
			reply: "Thanks!",
			at: new Date(T0.getTime() + 60_000),
		});
		const place = signal({ motivation: "curiosity", kind: "self_missing", cluster: "self:place:stated" });
		now.t = new Date(T0.getTime() + 25 * 3_600_000);
		await actor.act([opening(place)], new Set([b.cluster, place.cluster]));
		assert.equal(
			(db.prepare("SELECT status FROM self_questions WHERE field LIKE 'belief:%'").get() as { status: string })
				.status,
			"expired",
		);
		assert.equal(sent.length, 2, "the next question went out the next day");
	});

	test("#15: /forget reaches the questions, notices and kept samples that quote the person", async () => {
		const db = freshDb();
		const now = { t: T0 };
		const { actor } = rig(db, now);
		const id = belief(db, 0.6);
		const b = signal({
			motivation: "curiosity",
			kind: "belief_uncertain",
			cluster: `belief:${id}`,
			text: "unsure whether Julia plans to a trip to Rome",
		});
		await actor.act([opening(b)], new Set([b.cluster]));
		db.prepare(
			"INSERT INTO motivation_samples (id, at, motivation, raw, smoothed, sustained, signals_json, would_open) VALUES ('s1', ?, 'curiosity', 0.5, 0.5, 1, ?, NULL)",
		).run(
			T0.toISOString(),
			JSON.stringify([
				{ kind: "belief_uncertain", cluster: `belief:${id}`, text: b.text },
				{ kind: "self_missing", cluster: "self:place:stated", text: "x" },
			]),
		);
		db.prepare(
			"INSERT INTO actions (id, kind, route_json, content_hash, idempotency_key, state, created_at, content) SELECT 'n1', 'status', '{}', 'h', 'notice:question:' || id, 'delivered', 't', question FROM self_questions",
		).run();
		const t = forgetTarget(db, getContact(db, "julia")!);
		assert.ok(typeof t !== "string");
		forgetRecords(db, t, "owner_web", new Date(T0.getTime() + DAY).toISOString());
		const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
		assert.equal(n("SELECT count(*) AS n FROM opportunities WHERE cluster LIKE 'belief:%'"), 0);
		assert.equal(n("SELECT count(*) AS n FROM self_questions"), 0);
		assert.equal(
			(db.prepare("SELECT content FROM actions WHERE id = 'n1'").get() as { content: string }).content,
			"[forgotten]",
		);
		const kept = JSON.parse(
			(db.prepare("SELECT signals_json FROM motivation_samples WHERE id = 's1'").get() as { signals_json: string })
				.signals_json,
		) as { cluster: string }[];
		assert.deepEqual(
			kept.map((k) => k.cluster),
			["self:place:stated"],
		);
	});
});

describe("M2 web investigations", () => {
	test("an investigation session never gets telegram_send; Iyye's other background work still may", () => {
		const reach = { effect: "reach" as const };
		assert.equal(ToolBroker.allowed(reach, "iyye", false, `${INVESTIGATION_SCOPE}x:1`), false);
		assert.equal(ToolBroker.allowed(reach, "iyye", false, `${PLAN_STEP_SCOPE}x:1`), false);
		assert.equal(ToolBroker.allowed(reach, "iyye", false, "iyye:bg:x"), true);
		assert.equal(ToolBroker.allowed({ effect: "read" }, "iyye", false, `${INVESTIGATION_SCOPE}x:1`), true);
	});

	test("only web investigations browse: plan steps, repository investigations and other background work never get the web", () => {
		const tool = (name: string) =>
			({
				name,
				label: name,
				description: name,
				summary: name,
				parameters: {},
				run: async () => "",
			}) as unknown as IyyeTool;
		const kits: Toolkit[] = [
			{ name: "machine", description: "m", effect: "read", tools: [tool("system_status")] },
			{ name: "project", description: "p", effect: "read", tools: [tool("git_log")] },
			{ name: "messaging", description: "s", effect: "reach", tools: [tool("telegram_send")] },
			{ name: "web", description: "w", effect: "read", tools: [tool("web_search")] },
		];
		const broker = new ToolBroker({ db: freshDb(), log: silentLogger, toolkits: kits });
		const names = (scope: string) => broker.forSession({ scope, principal: "iyye" }).names;
		assert.deepEqual(names(`${PLAN_STEP_SCOPE}p:0`), ["system_status", "git_log"]);
		assert.deepEqual(names(`${INVESTIGATION_SCOPE}o:1`), ["system_status", "git_log"]);
		assert.deepEqual(names("iyye:bg:x"), ["system_status", "git_log", "telegram_send"]);
		assert.deepEqual(names(`${WEB_INVESTIGATION_SCOPE}o:1`), ["system_status", "git_log", "web_search"]);
		assert.ok(
			broker.forSession({ scope: "owner", principal: "owner" }).names.includes("web_search"),
			"people keep the web",
		);
	});

	test("#15: the memory handed to a web investigation is the owner's own conversation only, never a contact's words", async () => {
		const db = freshDb();
		turn(db, {
			id: "j1",
			who: "jacob",
			text: "My secret Rust plan is to build a game",
			reply: "Nice.",
			at: new Date(T0.getTime() - DAY),
		});
		turn(db, {
			id: "o1",
			who: "owner",
			text: "Which Rust book is good?",
			reply: "I don't know.",
			at: new Date(T0.getTime() - DAY),
		});
		db.prepare("UPDATE stm_episodes SET state = 'day'").run();
		const gw = new MemoryGateway({ db, ltm: null, log: silentLogger });
		const all = await gw.recall({ scope: "owner", principal: "owner" }, "Rust plan book");
		assert.ok(
			all.items.some((i) => /secret Rust plan/.test(i.text)),
			"the owner's reader would see it",
		);
		const own = await ownerOwnRecall(gw, "Rust plan book");
		assert.ok(own && /Which Rust book/.test(own));
		assert.doesNotMatch(own!, /secret/);
	});

	test("Iyye's own web calls share one daily budget across its sessions", () => {
		const db = freshDb();
		const at = T0.toISOString();
		for (const [i, scope] of ["iyye:inv:a:1", "iyye:inv:b:1", "iyye:bg:c"].entries())
			db.prepare(
				"INSERT INTO tool_calls (id, scope, principal, tool, toolkit, args_json, outcome, result, started_at, finished_at) VALUES (?, ?, 'iyye', 'web_search', 'web', '{}', 'ok', 'r', ?, ?)",
			).run(`t${i}`, scope, at, at);
		const budget = { owner: 200, contact: 50, iyye: 3 };
		assert.match(
			overBudget({ db, budget, now: () => T0 }, { scope: "iyye:inv:new:1", principal: "iyye" }) ?? "",
			/used up/,
		);
		assert.equal(
			overBudget(
				{ db, budget: { ...budget, iyye: 4 }, now: () => T0 },
				{ scope: "iyye:inv:new:1", principal: "iyye" },
			),
			null,
		);
	});

	test("a web answer is grounded only by URLs the tools returned", () => {
		const results = "1. Gemma 4 — https://ai.google.dev/gemma/docs/core (Google)\n2. https://example.org/spark-specs";
		assert.deepEqual(checkWebCitations("It fits (https://ai.google.dev/gemma/docs/core).", results), {
			cited: ["https://ai.google.dev/gemma/docs/core"],
			invented: [],
		});
		assert.deepEqual(checkWebCitations("See https://made-up.example/x.", results).invented, [
			"https://made-up.example/x",
		]);
		assert.deepEqual(checkWebCitations("It fits, I am sure.", results).cited, []);
	});

	test("the owner's recurring question: memory recalled by the host, web results cited, the answer becomes a finding", async () => {
		const db = freshDb();
		const clock = { now: T0 };
		const enqueued: { origin: string; prompt: string; session?: string }[] = [];
		let n = 0;
		const inv = new Investigations({
			db,
			worker: {
				enqueue: (step) => {
					enqueued.push(step);
					const id = `job-${++n}`;
					insertBackgroundJob(db, {
						id,
						origin: step.origin,
						session: step.session!,
						prompt: step.prompt,
						at: clock.now.toISOString(),
					});
					return id;
				},
				initiativePaused: () => false,
			},
			mode: () => "awake",
			log: silentLogger,
			now: () => clock.now,
			recall: async () => "<memory>\n- [today] Owner said: which Gemma fits the DGX Spark?\n</memory>",
		});
		db.prepare(
			`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, signal_kind, action_kind)
			 VALUES ('q1', 'question:o1', 'conversation', '[]', 'the owner asked again', 'Which Gemma model fits the DGX Spark?', 'open', ?, ?, 'curiosity', 'question_recurring', 'investigate')`,
		).run(T0.toISOString(), T0.toISOString());
		await inv.tick();
		assert.equal(enqueued.length, 1);
		assert.ok(enqueued[0]!.session!.startsWith(INVESTIGATION_SCOPE));
		assert.match(enqueued[0]!.prompt, /the owner asked this on two different days/);
		assert.match(enqueued[0]!.prompt, /<memory>/);
		const settle = (answer: string, result: string | null) => {
			const step = enqueued.at(-1)!;
			const job = `done-${++n}`;
			if (result !== null)
				db.prepare(
					"INSERT INTO tool_calls (id, scope, principal, tool, toolkit, args_json, outcome, result, started_at, finished_at) VALUES (?, ?, 'iyye', 'web_search', 'web', '{}', 'ok', ?, ?, ?)",
				).run(`tc-${job}`, step.session, result, clock.now.toISOString(), clock.now.toISOString());
			insertBackgroundJob(db, {
				id: job,
				origin: step.origin,
				session: step.session!,
				prompt: step.prompt,
				at: clock.now.toISOString(),
			});
			db.prepare("UPDATE background_jobs SET status = 'settled', result = ?, settled_at = ? WHERE id = ?").run(
				answer,
				clock.now.toISOString(),
				job,
			);
			inv.onStepSettled(getBackgroundJob(db, job)!);
		};
		settle(
			"The 26B fits, see https://invented.example/spark.",
			"Gemma 4 sizes — https://ai.google.dev/gemma/docs/core",
		);
		assert.equal(enqueued.length, 2, "an invented URL: one more step");
		assert.match(enqueued[1]!.prompt, /citing the URLs of the pages they returned/);
		settle("The 26B fits in 128 GB (https://ai.google.dev/gemma/docs/core).", null);
		const o = db.prepare("SELECT status, finding_id FROM opportunities WHERE id = 'q1'").get() as {
			status: string;
			finding_id: string;
		};
		assert.equal(o.status, "settled");
		assert.ok(db.prepare("SELECT 1 FROM observations WHERE id = ? AND domain = 'investigation'").get(o.finding_id));
	});
});
