// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.006 C4: plans with typed steps, each done only with its evidence
 * (HLD §7.1, §15 #7), authorized only by the owner unless they stay inside
 * the owner's web chat, and never by anything from Telegram.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WebChatAdapter } from "../src/channels/web/adapter.ts";
import { commitmentsOfReply } from "../src/decisions/reply-review.ts";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { CommitmentClock } from "../src/kernel/commitments.ts";
import { PLAN_ORIGIN, PlanRunner } from "../src/kernel/plans.ts";
import { silentLogger } from "../src/log.ts";
import { MemoryControl } from "../src/memory/control.ts";
import { forgetBusy, forgetTarget, planSessions } from "../src/memory/forget.ts";
import { Outbox, type Route } from "../src/outbox/outbox.ts";
import { type BackgroundJob, finishBackgroundJob, insertBackgroundJob } from "../src/state/background.ts";
import { type Commitment, getCommitment } from "../src/state/commitments.ts";
import { getContact, OWNER_CONTACT_ID } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getPlan, type PlanRow, type PlanStep, steps } from "../src/state/plans.ts";
import { ToolBroker, type ToolContext } from "../src/tools/broker.ts";
import { plansToolkit } from "../src/tools/plans.ts";

const OWNER_WEB: Route = { channel: "web", contact: "owner" };
const JULIA_TG: Route = { channel: "telegram", chatId: 9101 };

interface Harness {
	db: Db;
	runner: PlanRunner;
	outbox: Outbox;
	jobs: BackgroundJob[];
	setNow(d: Date): void;
	now(): Date;
	notices(): string[];
	plan(id: string): PlanRow;
	steps(id: string): PlanStep[];
	/** The background step of a session answers, after the tools returned `toolResult` (or none). */
	answer(session: string, text: string, toolResult?: string): Promise<void>;
	cleanup(): Promise<void>;
}

function harness(): Harness {
	const db = openDb(":memory:");
	db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')").run();
	let now = new Date(2026, 9, 4, 12, 0);
	const outbox = new Outbox({ db, log: silentLogger, adapters: [new WebChatAdapter({ db, log: silentLogger })] });
	const jobs: BackgroundJob[] = [];
	const worker = {
		enqueue(step: { origin: string; prompt: string; session?: string }) {
			const id = crypto.randomUUID();
			insertBackgroundJob(db, {
				id,
				origin: step.origin,
				session: step.session ?? `iyye:bg:${id}`,
				prompt: step.prompt,
				at: now.toISOString(),
			});
			jobs.push(db.prepare("SELECT * FROM background_jobs WHERE id = ?").get(id) as BackgroundJob);
			return id;
		},
	};
	const runner = new PlanRunner({ db, worker, outbox, log: silentLogger, now: () => now });
	let n = 0;
	return {
		db,
		runner,
		outbox,
		jobs,
		setNow: (d) => {
			now = d;
		},
		now: () => now,
		notices: () =>
			(
				db.prepare("SELECT content FROM actions WHERE kind = 'status' ORDER BY created_at, rowid").all() as {
					content: string;
				}[]
			).map((r) => r.content),
		plan: (id) => getPlan(db, id)!,
		steps: (id) => steps(getPlan(db, id)!),
		answer: async (session, text, toolResult) => {
			const job = [...jobs].reverse().find((j) => j.session === session && j.status === "queued")!;
			assert.ok(job, `a queued step in ${session}`);
			job.status = "settled";
			if (toolResult !== undefined)
				db.prepare(
					"INSERT INTO tool_calls (id, scope, principal, tool, args_json, outcome, result, started_at, finished_at) VALUES (?, ?, 'iyye', 'git_status', '{}', 'ok', ?, ?, ?)",
				).run(`tc${n++}`, session, toolResult, now.toISOString(), now.toISOString());
			finishBackgroundJob(db, job.id, "settled", now.toISOString(), { result: text });
			runner.onStepSettled({ ...job, result: text });
			await runner.tick();
		},
		cleanup: async () => {
			await new Promise((r) => setImmediate(r)); // ticks a proposal or approval queued
			await runner.stop();
			db.close();
		},
	};
}

const planId = (toolResult: string) => {
	const m = /^Plan ([0-9a-f]{8})/.exec(toolResult);
	assert.ok(m, toolResult);
	return m[1]!;
};

const ownerWeb = { proposer: OWNER_CONTACT_ID, principal: "owner" as const, scope: "owner", route: OWNER_WEB };
const juliaTg = { proposer: "c1", principal: "contact" as const, scope: "contact:c1", route: JULIA_TG };

function full(h: Harness, short: string): string {
	return (h.db.prepare("SELECT id FROM plans WHERE id LIKE ?").get(`${short}%`) as { id: string }).id;
}

describe("plans (plan 0.006 C4)", () => {
	test("#7: an owner's web plan runs its steps in order and completes only after the reminder's receipt", async () => {
		const h = harness();
		try {
			const r = h.runner.propose({
				...ownerWeb,
				intent: "check the workspace, then remind me to review it",
				steps: [
					{ kind: "investigate", question: "What is uncommitted in the workspace?" },
					{ kind: "remind", text: "review the workspace", when: "in 2 hours" },
				],
				eventId: null,
				via: "web chat",
			});
			assert.match(r, /is authorized and starts now/);
			assert.match(r, /remind at .* 14:00: "review the workspace"/, "the exact time the host resolved");
			const id = full(h, planId(r));
			await h.runner.tick();
			assert.equal(h.plan(id).state, "active");
			const s0 = h.steps(id)[0]!;
			assert.equal(s0.status, "running");
			assert.equal(h.jobs.length, 1);
			assert.equal(h.jobs[0]!.origin, `${PLAN_ORIGIN}${id}:0`);
			assert.equal(h.jobs[0]!.session, `iyye:plan:${id}:0`);
			// The reminder is scheduled at once, at the time the person was told.
			const rs = h.steps(id)[1] as Extract<PlanStep, { kind: "remind" }>;
			assert.equal(rs.status, "running");
			const c = getCommitment(h.db, rs.commitment_id!)!;
			assert.deepEqual(
				[c.state, c.scope, JSON.parse(c.route_json), c.created_by, c.due_at],
				["scheduled", "owner", OWNER_WEB, `plan:${id}`, rs.due_at],
			);

			// An answer that cites nothing the tools returned is not evidence: the step is asked again.
			await h.answer(`iyye:plan:${id}:0`, "Everything looks fine, all committed.");
			assert.equal(h.steps(id)[0]!.status, "running");
			assert.equal(h.jobs.length, 2);
			assert.match(h.jobs[1]!.prompt, /not accepted: it used no tool/);
			// A grounded one is.
			await h.answer(`iyye:plan:${id}:0`, "notes.md is modified and not committed.", " M notes.md\n?? draft.txt");
			const done = h.steps(id)[0]!;
			assert.equal(done.status, "done");
			assert.match((done as { evidence: string }).evidence, /notes\.md.*\[cites: notes\.md\]/);

			await h.runner.tick();
			assert.equal(h.plan(id).state, "active", "not done while the reminder is only scheduled");

			const clock = new CommitmentClock({
				db: h.db,
				outbox: h.outbox,
				mode: () => "awake",
				log: silentLogger,
				now: () => h.now(),
			});
			h.setNow(new Date(2026, 9, 4, 14, 1));
			await clock.tick();
			assert.equal(getCommitment(h.db, c.id)!.state, "fulfilled", "the web chat's own receipt");
			await h.runner.tick();
			assert.equal(h.plan(id).state, "completed");
			const evidence = (h.steps(id)[1] as { evidence: string }).evidence;
			assert.match(evidence, /delivered: action [0-9a-f]{8}, receipt ui_enqueued/);
			assert.ok(h.plan(id).settled_at);
			assert.match(h.notices().at(-1)!, /^Plan done: "check the workspace/);
		} finally {
			await h.cleanup();
		}
	});

	test("an unconfirmed reminder suspends the plan until a receipt; a failed or cancelled one fails it", async () => {
		const h = harness();
		try {
			const make = () =>
				full(
					h,
					planId(
						h.runner.propose({
							...ownerWeb,
							intent: "remind",
							steps: [{ kind: "remind", text: "x", when: "in 1 hour" }],
							eventId: null,
							via: "web chat",
						}),
					),
				);
			const commitment = (id: string) => (h.steps(id)[0] as Extract<PlanStep, { kind: "remind" }>).commitment_id!;
			const set = (cid: string, state: Commitment["state"]) =>
				h.db.prepare("UPDATE commitments SET state = ? WHERE id = ?").run(state, cid);

			const a = make();
			await h.runner.tick();
			set(commitment(a), "unknown");
			await h.runner.tick();
			assert.equal(h.plan(a).state, "suspended");
			assert.match(h.plan(a).reason!, /no receipt confirms it/);
			assert.match(h.notices().at(-1)!, /may or may not have arrived/);
			set(commitment(a), "fulfilled");
			await h.runner.tick();
			assert.equal(h.plan(a).state, "completed");

			const b = make();
			await h.runner.tick();
			set(commitment(b), "failed");
			await h.runner.tick();
			assert.equal(h.plan(b).state, "failed");
			assert.match(h.notices().at(-1)!, /^Plan failed: "remind" — step 1: the reminder failed/);

			const c = make();
			await h.runner.tick();
			set(commitment(c), "cancelled");
			await h.runner.tick();
			assert.equal(h.plan(c).state, "failed", "a reminder cancelled by /cancel is not a delivered one");
		} finally {
			await h.cleanup();
		}
	});

	test("an investigate step that never grounds its answer fails the plan, and its later steps never happen", async () => {
		const h = harness();
		try {
			const id = full(
				h,
				planId(
					h.runner.propose({
						...ownerWeb,
						intent: "look and remind",
						steps: [
							{ kind: "investigate", question: "What changed?" },
							{ kind: "remind", text: "later", when: "in 3 hours" },
						],
						eventId: null,
						via: "web chat",
					}),
				),
			);
			await h.runner.tick();
			const session = `iyye:plan:${id}:0`;
			await h.answer(session, "Nothing.");
			await h.answer(session, "It changed config.yaml.", "M notes.md"); // a file the tools never returned
			await h.answer(session, "Still nothing.", "M notes.md");
			assert.equal(h.plan(id).state, "failed");
			assert.match(h.steps(id)[0]!.reason!, /3 answers without grounding/);
			const cid = (h.steps(id)[1] as { commitment_id: string }).commitment_id;
			assert.equal(getCommitment(h.db, cid)!.state, "cancelled", "a failed plan sends nothing more");
		} finally {
			await h.cleanup();
		}
	});

	test("a file named only in the question is not evidence: something cited must come from the tools", async () => {
		const h = harness();
		try {
			const id = full(
				h,
				planId(
					h.runner.propose({
						...ownerWeb,
						intent: "check",
						steps: [{ kind: "investigate", question: "Is secret.md present in the workspace?" }],
						eventId: null,
						via: "web chat",
					}),
				),
			);
			await h.runner.tick();
			const session = `iyye:plan:${id}:0`;
			await h.answer(session, "Yes, secret.md is present.", "nothing to commit, working tree clean");
			assert.equal(h.steps(id)[0]!.status, "running", "asked again");
			assert.match(h.jobs.at(-1)!.prompt, /it cites nothing the tools returned/);
			// Naming the question's file is fine once the tools returned something it cites.
			await h.answer(session, "secret.md is not there; only notes.md is.", "notes.md");
			assert.equal(h.plan(id).state, "completed");
			assert.match((h.steps(id)[0] as { evidence: string }).evidence, /\[cites: notes\.md\]$/);
		} finally {
			await h.cleanup();
		}
	});

	test("what Iyye itself sent is never evidence: a file named only in its own message does not ground an answer", async () => {
		const h = harness();
		try {
			const id = full(
				h,
				planId(
					h.runner.propose({
						...ownerWeb,
						intent: "check",
						steps: [{ kind: "investigate", question: "What changed?" }],
						eventId: null,
						via: "web chat",
					}),
				),
			);
			await h.runner.tick();
			const session = `iyye:plan:${id}:0`;
			h.db
				.prepare(
					"INSERT INTO tool_calls (id, scope, principal, tool, args_json, outcome, result, started_at, finished_at) VALUES ('s1', ?, 'iyye', 'telegram_send', '{\"text\":\"see notes.md\"}', 'ok', 'Sent: see notes.md', ?, ?)",
				)
				.run(session, h.now().toISOString(), h.now().toISOString());
			await h.answer(session, "notes.md changed.");
			assert.equal(h.steps(id)[0]!.status, "running", "asked again: its own message is not a tool result");
			assert.match(h.jobs.at(-1)!.prompt, /it used no tool/);
		} finally {
			await h.cleanup();
		}
	});

	test("a reminder keeps the time the person was told, even while an earlier step has not run yet", async () => {
		const h = harness();
		try {
			const id = full(
				h,
				planId(
					h.runner.propose({
						...ownerWeb,
						intent: "look, and remind me soon",
						steps: [
							{ kind: "investigate", question: "What changed?" },
							{ kind: "remind", text: "stretch", when: "in 20 minutes" },
						],
						eventId: null,
						via: "web chat",
					}),
				),
			);
			await h.runner.tick();
			// The investigation waits (the device is busy, say); the reminder's time comes.
			const clock = new CommitmentClock({
				db: h.db,
				outbox: h.outbox,
				mode: () => "awake",
				log: silentLogger,
				now: () => h.now(),
			});
			h.setNow(new Date(2026, 9, 4, 12, 21));
			await clock.tick();
			await h.runner.tick();
			assert.equal(h.steps(id)[1]!.status, "done", "sent at 12:20 and confirmed");
			assert.equal(h.steps(id)[0]!.status, "running");
			assert.equal(h.plan(id).state, "active", "not complete until the investigation has its evidence");
			await h.answer(`iyye:plan:${id}:0`, "notes.md changed.", " M notes.md");
			assert.equal(h.plan(id).state, "completed");
		} finally {
			await h.cleanup();
		}
	});

	test("a step no tool can do: never authorized by itself; approved, it blocks and the plan never completes; cancel drops what is left", async () => {
		const h = harness();
		try {
			const r = h.runner.propose({
				...ownerWeb,
				intent: "remind me, then book a table",
				steps: [
					{ kind: "remind", text: "book a table", when: "in 1 hour" },
					{ kind: "other", description: "book a table at the restaurant" },
				],
				eventId: null,
				via: "web chat",
			});
			assert.match(r, /only proposed: it waits for the owner's approval because a step has no tool/);
			assert.match(r, /Nothing is arranged yet/);
			const id = full(h, planId(r));
			await h.runner.tick();
			assert.equal(h.plan(id).state, "proposed", "nothing runs before approval");
			assert.equal((h.db.prepare("SELECT count(*) AS n FROM commitments").get() as { n: number }).n, 0);
			assert.match(h.notices().at(-1)!, /^you proposed a plan \(web chat\)/);

			const ctx = { models: {} as never, db: h.db, issuer: "owner_web", plans: h.runner };
			const cmd = async (t: string) => (await handleOwnerCommand(t, ctx)).reply;
			assert.match(await cmd(`/plan approve ${id.slice(0, 8)}`), /approved: .* it will stop there, suspended/);
			assert.equal(h.plan(id).authorization, "owner:owner_web");
			assert.match(
				await cmd(`/plan approve ${id.slice(0, 8)}`),
				/is (authorized|active|suspended), not waiting for approval/,
			);
			await h.runner.tick();
			const cid = (h.steps(id)[0] as { commitment_id: string }).commitment_id;
			h.db.prepare("UPDATE commitments SET state = 'fulfilled' WHERE id = ?").run(cid);
			await h.runner.tick();
			await h.runner.tick();
			assert.equal(h.plan(id).state, "suspended");
			assert.equal(h.steps(id)[1]!.status, "blocked");
			assert.match(h.notices().at(-1)!, /nothing can do/);
			await h.runner.tick();
			assert.equal(h.plan(id).state, "suspended", "it stays blocked");

			assert.match(await cmd("/plans"), new RegExp(`${id.slice(0, 8)} suspended · 1/2 steps`));
			assert.match(await cmd(`/plan ${id.slice(0, 8)}`), /1\. \[done\] remind at .*\n {5}evidence: reminder/);
			assert.match(await cmd(`/plan cancel ${id.slice(0, 8)}`), /^cancelled: /);
			assert.equal(h.plan(id).state, "abandoned");
			assert.match(await cmd(`/plan cancel ${id.slice(0, 8)}`), /already abandoned/);
			assert.match(await cmd("/plan approve"), /usage/);

			// Cancelling while a reminder waits cancels the reminder, and a queued step is dropped.
			const other = full(
				h,
				planId(
					h.runner.propose({
						...ownerWeb,
						intent: "remind twice",
						steps: [
							{ kind: "remind", text: "a", when: "in 1 hour" },
							{ kind: "remind", text: "b", when: "in 2 hours" },
						],
						eventId: null,
						via: "web chat",
					}),
				),
			);
			await h.runner.tick();
			const waiting = (h.steps(other)[0] as { commitment_id: string }).commitment_id;
			await cmd(`/plan cancel ${other.slice(0, 8)}`);
			assert.equal(getCommitment(h.db, waiting)!.state, "cancelled");
			const second = (h.steps(other)[1] as { commitment_id: string }).commitment_id;
			assert.equal(getCommitment(h.db, second)!.state, "cancelled", "every coming reminder of the plan");
			await h.runner.tick();
			assert.equal(
				(h.db.prepare("SELECT count(*) AS n FROM commitments").get() as { n: number }).n,
				3,
				"no new reminder",
			);
		} finally {
			await h.cleanup();
		}
	});

	test("Telegram can at most propose: a contact's plan and the owner's linked Telegram account's both wait for approval", async () => {
		const h = harness();
		try {
			const toolkit = plansToolkit(h.runner);
			const tool = toolkit.tools[0]!;
			const juliaCtx: ToolContext = {
				scope: "contact:c1",
				principal: "contact",
				turn: { route: JULIA_TG, contactId: "c1", eventId: null },
			};
			const r = await tool.run(
				{
					intent: "remind me to call mom",
					steps: [{ kind: "remind", text: "call mom", when: "in 2 hours" }],
				},
				juliaCtx,
				undefined,
			);
			assert.match(
				r,
				/only proposed: it waits for the owner's approval because it reaches beyond the owner's web chat/,
			);
			const id = full(h, planId(r));
			const p = h.plan(id);
			assert.deepEqual(
				[p.state, p.scope, p.proposer_contact_id, JSON.parse(p.route_json), p.proposed_via, p.authorization],
				["proposed", "contact:c1", "c1", JULIA_TG, "Telegram", null],
			);
			assert.match(h.notices().at(-1)!, /^"Julia" proposed a plan \(Telegram\): "remind me to call mom"/);
			await h.runner.tick();
			assert.equal(h.plan(id).state, "proposed");

			// The owner, but from Telegram (a linked account): still only proposed.
			const linked = await tool.run(
				{ intent: "x", steps: [{ kind: "investigate", text: "What is in notes.md?" }] },
				{
					scope: "owner",
					principal: "owner",
					turn: { route: { channel: "telegram", chatId: 1 }, contactId: OWNER_CONTACT_ID, eventId: null },
				},
				undefined,
			);
			assert.match(linked, /only proposed/);

			// The tool cannot name a route, a person or an approval; it only proposes.
			assert.deepEqual(
				toolkit.tools.map((t) => t.name),
				["plan_propose"],
			);
			assert.deepEqual(Object.keys((tool.parameters as { properties: object }).properties).sort(), [
				"intent",
				"steps",
			]);
			// A reminder without a time is refused, not guessed.
			assert.match(
				await tool.run({ intent: "x", steps: [{ kind: "remind", text: "y" }] }, juliaCtx, undefined),
				/without a time\. Ask the person/,
			);
			// Background work never gets it; outside a turn it refuses.
			const broker = new ToolBroker({ db: h.db, log: silentLogger, toolkits: [toolkit] });
			assert.deepEqual(broker.forSession({ scope: "iyye:bg:x", principal: "iyye" }).names, []);
			assert.deepEqual(broker.forSession({ scope: "contact:c1", principal: "contact" }).names, ["plan_propose"]);
			assert.match(
				await tool.run(
					{ intent: "x", steps: [{ kind: "other", text: "y" }] },
					{ scope: "owner", principal: "owner" },
					undefined,
				),
				/only be proposed in a conversation/,
			);
			// The cap on a contact's open plans.
			for (let i = 0; i < 4; i++)
				await tool.run({ intent: `p${i}`, steps: [{ kind: "other", text: "y" }] }, juliaCtx, undefined);
			assert.match(
				await tool.run({ intent: "p5", steps: [{ kind: "other", text: "y" }] }, juliaCtx, undefined),
				/already has 5 open plans/,
			);

			// Approved by the owner, the contact's reminder goes to her own Telegram chat.
			const ctx = { models: {} as never, db: h.db, issuer: "owner_web", plans: h.runner };
			await handleOwnerCommand(`/plan approve ${id.slice(0, 8)}`, ctx);
			await h.runner.tick();
			const cid = (h.steps(id)[0] as { commitment_id: string }).commitment_id;
			const c = getCommitment(h.db, cid)!;
			assert.deepEqual([c.scope, c.recipient_contact_id, JSON.parse(c.route_json)], ["contact:c1", "c1", JULIA_TG]);
		} finally {
			await h.cleanup();
		}
	});

	test("/forget abandons the person's plans and removes their words, the steps' prompts and the owner's notices", async () => {
		const h = harness();
		try {
			const id = full(
				h,
				planId(
					h.runner.propose({
						...juliaTg,
						intent: "secret plan words",
						steps: [{ kind: "investigate", question: "secret question words" }],
						eventId: null,
						via: "Telegram",
					}),
				),
			);
			const ctx = { models: {} as never, db: h.db, issuer: "owner_web", plans: h.runner };
			await handleOwnerCommand(`/plan approve ${id.slice(0, 8)}`, ctx);
			await h.runner.tick();
			assert.equal(h.jobs.length, 1);
			const t = forgetTarget(h.db, getContact(h.db, "c1")!);
			assert.ok(typeof t !== "string");
			h.db.prepare("UPDATE background_jobs SET status = 'running'").run();
			assert.equal(forgetBusy(h.db, t.scopes), "a step of their plan is running");
			h.db.prepare("UPDATE background_jobs SET status = 'queued'").run();
			assert.equal(forgetBusy(h.db, t.scopes), null);
			assert.deepEqual(planSessions(h.db, t.scopes), [`iyye:plan:${id}:0`]);
			// The steps' background transcripts go with the person's own (they quote them).
			const forgotten: string[][] = [];
			const control = new MemoryControl({
				db: h.db,
				ltm: null,
				log: silentLogger,
				mode: () => "awake",
				forgetConversations: async () => 0,
				forgetBackground: async (scopes) => {
					forgotten.push([...scopes]);
					return scopes.length;
				},
			});
			assert.match(await control.forget(getContact(h.db, "c1")!, "owner_web"), /^Forgotten: Julia/);
			assert.deepEqual(forgotten, [[`iyye:plan:${id}:0`]]);
			const p = h.plan(id);
			assert.deepEqual([p.state, p.intent, p.steps_json, p.reason], ["abandoned", "[forgotten]", "[]", "forgotten"]);
			const job = h.db.prepare("SELECT status, prompt FROM background_jobs").get() as {
				status: string;
				prompt: string;
			};
			assert.deepEqual([job.status, job.prompt], ["failed", "[forgotten]"]);
			const dump = JSON.stringify([
				h.db.prepare("SELECT * FROM actions").all(),
				h.db.prepare("SELECT * FROM web_feed").all(),
				h.db.prepare("SELECT * FROM plans").all(),
				h.db.prepare("SELECT * FROM background_jobs").all(),
			]);
			assert.ok(!dump.includes("secret"), "nothing of their words is left");
		} finally {
			await h.cleanup();
		}
	});

	test("the reply-review ledger counts a plan the turn authorized, not one it only proposed", async () => {
		const h = harness();
		try {
			const at = h.now().toISOString();
			for (const e of ["e1", "e2"]) {
				h.db
					.prepare(
						"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'web', ?, 'owner', ?, '{}', 'answered')",
					)
					.run(e, e, OWNER_CONTACT_ID, at);
				h.db
					.prepare(
						"INSERT INTO actions (id, job_id, event_id, kind, route_json, content_hash, content, idempotency_key, state, created_at) VALUES (?, NULL, ?, 'reply', '{}', 'h', 'c', ?, 'delivered', ?)",
					)
					.run(`a-${e}`, e, `k-${e}`, at);
			}
			const auto = h.runner.propose({
				...ownerWeb,
				intent: "a",
				steps: [{ kind: "remind", text: "x", when: "in 1 hour" }],
				eventId: "e1",
				via: "web chat",
			});
			h.runner.propose({
				...ownerWeb,
				intent: "b",
				steps: [{ kind: "other", description: "y" }],
				eventId: "e2",
				via: "web chat",
			});
			assert.deepEqual(commitmentsOfReply(h.db, "a-e1"), [`plan:${full(h, planId(auto))}`]);
			assert.deepEqual(commitmentsOfReply(h.db, "a-e2"), []);
		} finally {
			await h.cleanup();
		}
	});
});
