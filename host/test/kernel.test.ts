// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { WebChatAdapter } from "../src/channels/web/adapter.ts";
import { admitOwnerWebMessage, admitTelegramUpdate } from "../src/kernel/admission.ts";
import { recover } from "../src/kernel/recovery.ts";
import { Scheduler } from "../src/kernel/scheduler.ts";
import { silentLogger } from "../src/log.ts";
import { Outbox } from "../src/outbox/outbox.ts";
import { openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { getJob, getJobForEvent, markJobRunning } from "../src/state/jobs.ts";
import { appendFeed } from "../src/state/web.ts";
import { type Sandbox, sandbox, waitFor } from "./model-helpers.ts";
import { type Stack, startStack } from "./web-helpers.ts";

const admission = (db: ReturnType<typeof openDb>) => ({ db, now: () => new Date(), newId: () => crypto.randomUUID() });
const feedKinds = (db: ReturnType<typeof openDb>, eventId: string) =>
	(
		db.prepare("SELECT kind, text FROM web_feed WHERE event_id = ? ORDER BY seq").all(eventId) as {
			kind: string;
			text: string;
		}[]
	).map((r) => `${r.kind}:${r.text}`);

describe("recovery after a crash", () => {
	test("a web action interrupted in `sending` is settled from the transcript, or sent again if it never landed", async () => {
		const db = openDb(":memory:");
		const outbox = new Outbox({ db, log: silentLogger, adapters: [new WebChatAdapter({ db, log: silentLogger })] });
		// The state a crash leaves: the action claimed, its one part marked `sending`.
		const insert = (id: string, eventId: string, jobId: string) => {
			db.prepare(
				`INSERT INTO actions (id, job_id, event_id, kind, route_json, content_hash, content, idempotency_key, state, created_at)
				 VALUES (?, ?, ?, 'reply', '{"channel":"web","contact":"owner"}', 'h', ?, ?, 'sending', 'now')`,
			).run(id, jobId, eventId, `reply ${id}`, `action:${id}`);
			db.prepare(
				`INSERT INTO receipts (action_id, chunk_index, adapter, level, outcome, chunk_start, chunk_end)
				 VALUES (?, 0, 'web', 'none', 'sending', 0, ?)`,
			).run(id, `reply ${id}`.length);
		};
		const landed = admitOwnerWebMessage(admission(db), { clientMsgId: "landed-01", text: "a" });
		const lost = admitOwnerWebMessage(admission(db), { clientMsgId: "lost-0001", text: "b" });
		assert.ok(landed.outcome === "admitted" && lost.outcome === "admitted");
		insert("act-landed", landed.eventId, landed.jobId);
		insert("act-lost", lost.eventId, lost.jobId);
		// The first send reached the transcript before the crash; the second did not.
		appendFeed(db, {
			kind: "reply",
			text: "reply act-landed",
			at: "now",
			eventId: landed.eventId,
			actionId: "act-landed",
		});

		const report = await recover(db, outbox, { fail: async () => {} }, silentLogger);
		assert.equal(report.reconciled, 2);
		assert.equal(report.resent, 1);
		assert.equal(outbox.get("act-landed")!.state, "delivered");
		assert.equal(outbox.get("act-lost")!.state, "delivered");
		assert.deepEqual(feedKinds(db, landed.eventId), ["reply:reply act-landed"], "no duplicate in the transcript");
		assert.deepEqual(feedKinds(db, lost.eventId), ["reply:reply act-lost"]);
		assert.equal(getEvent(db, lost.eventId)!.status, "answered");
	});

	test("an action on a route with no adapter fails at once: no fallback to another channel", async () => {
		const db = openDb(":memory:");
		const outbox = new Outbox({ db, log: silentLogger, adapters: [new WebChatAdapter({ db, log: silentLogger })] });
		const r = admitTelegramUpdate(admission(db), {
			updateId: 1,
			message: {
				messageId: 1,
				chatId: 42,
				chatType: "private",
				fromUserId: 42,
				fromIsBot: false,
				username: null,
				firstName: "Julia",
				text: "hi",
				dateUnix: null,
			},
		});
		assert.ok(r.outcome === "admitted");
		const a = await outbox.deliver({ jobId: r.jobId, event: getEvent(db, r.eventId)!, kind: "reply", content: "hi" });
		assert.equal(a.state, "terminal_failure");
		assert.deepEqual(JSON.parse(a.route_json), { channel: "telegram", chatId: 42 });
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM web_feed").get() as { n: number }).n, 0);
	});

	test("an adapter that throws leaves the action `unknown`, never retried", async () => {
		const db = openDb(":memory:");
		const outbox = new Outbox({
			db,
			log: silentLogger,
			adapters: [
				{
					channel: "web",
					maxChunkChars: Number.POSITIVE_INFINITY,
					sendChunk: async () => {
						throw new Error("crashed mid-send");
					},
				},
			],
		});
		const r = admitOwnerWebMessage(admission(db), { clientMsgId: "throws-01", text: "a" });
		assert.ok(r.outcome === "admitted");
		const a = await outbox.deliver({ jobId: r.jobId, event: getEvent(db, r.eventId)!, kind: "reply", content: "x" });
		assert.equal(a.state, "unknown");
		assert.equal(a.attempts, 1);
	});
});

describe("scheduler", () => {
	let sb: Sandbox;
	let s: Stack | null = null;
	afterEach(async () => {
		await s?.stop();
		s = null;
		sb.cleanup();
	});

	test("a job interrupted by a restart runs again once; interrupted twice, it fails with a notice", async () => {
		sb = sandbox();
		s = await startStack(sb);
		await s.scheduler.stop();
		const once = admitOwnerWebMessage(admission(s.db), { clientMsgId: "restart-1", text: "again" });
		const twice = admitOwnerWebMessage(admission(s.db), { clientMsgId: "restart-2", text: "never" });
		assert.ok(once.outcome === "admitted" && twice.outcome === "admitted");
		markJobRunning(s.db, once.jobId, "small", "2000-01-01T00:00:00Z");
		markJobRunning(s.db, twice.jobId, "small", "2000-01-01T00:00:00Z");
		markJobRunning(s.db, twice.jobId, "small", "2000-01-01T00:00:00Z"); // attempt 2

		const report = await recover(s.db, s.outbox, s.scheduler, silentLogger);
		assert.deepEqual([report.requeuedJobs, report.failedJobs], [1, 1]);
		s.scheduler.start();
		await waitFor(() => getEvent(s!.db, once.eventId)!.status === "answered");
		assert.deepEqual(feedKinds(s.db, once.eventId), ["reply:echo: again"]);
		assert.deepEqual(feedKinds(s.db, twice.eventId), [
			"notice:I couldn't answer that (interrupted twice by a restart).",
		]);
	});

	test("shutdown mid-turn returns the job to the queue with nothing sent", async () => {
		sb = sandbox();
		s = await startStack(sb);
		const r = admitOwnerWebMessage(admission(s.db), { clientMsgId: "shutdown-1", text: "[[slow]]" });
		assert.ok(r.outcome === "admitted");
		s.scheduler.wake();
		await waitFor(() => getJob(s!.db, r.jobId)!.status === "running");
		await s.scheduler.stop();
		assert.equal(getJob(s.db, r.jobId)!.status, "queued");
		assert.deepEqual(feedKinds(s.db, r.eventId), []);
	});

	test("A13: the router dies mid-turn → the job fails honestly with a notice; the next message is answered", async () => {
		sb = sandbox();
		s = await startStack(sb);
		const r = admitOwnerWebMessage(admission(s.db), { clientMsgId: "routerdie", text: "[[slow]]" });
		assert.ok(r.outcome === "admitted");
		s.scheduler.wake();
		await waitFor(() => getJob(s!.db, r.jobId)!.status === "running");
		process.kill(s.router.pid!, "SIGKILL");
		await waitFor(() => getJob(s!.db, r.jobId)!.status === "failed", 8000);
		// Either the health check or the broken connection notices first; both are honest failures.
		const kinds = feedKinds(s.db, r.eventId);
		assert.equal(kinds.length, 1);
		assert.match(kinds[0]!, /^notice:I couldn't answer that \((the model stopped while answering|error: .*)\)\.$/);
		assert.equal(getEvent(s.db, r.eventId)!.status, "admitted");

		const next = admitOwnerWebMessage(admission(s.db), { clientMsgId: "after-die", text: "back?" });
		assert.ok(next.outcome === "admitted");
		s.scheduler.wake();
		await waitFor(() => getEvent(s!.db, next.eventId)!.status === "answered", 10_000);
	});

	test("a job whose model never becomes available fails after the wait limit; it never uses another model", async () => {
		const db = openDb(":memory:");
		const outbox = new Outbox({ db, log: silentLogger, adapters: [new WebChatAdapter({ db, log: silentLogger })] });
		let turns = 0;
		const scheduler = new Scheduler({
			db,
			models: {
				selected: () => "small",
				acquire: async () => ({ ok: false, message: "small is not loaded" }),
				onRouterLost: () => {},
			},
			conversations: {
				turn: async () => {
					turns++;
					return { ok: true, text: "x", model: "other" };
				},
			},
			outbox,
			log: silentLogger,
			pollMs: 20,
			modelWaitMs: 150,
		});
		sb = sandbox();
		const r = admitOwnerWebMessage(admission(db), { clientMsgId: "nomodel-1", text: "hi" });
		assert.ok(r.outcome === "admitted");
		scheduler.start();
		assert.equal(await scheduler.step(), false, "waits while the wait limit has not passed");
		await waitFor(() => getJobForEvent(db, r.eventId)!.status === "failed", 3000);
		await scheduler.stop();
		assert.equal(turns, 0);
		assert.deepEqual(feedKinds(db, r.eventId), [
			"notice:I couldn't answer that (no model available (small is not loaded)).",
		]);
	});
});

describe("scheduler fairness and leases (M7)", () => {
	const telegramMsg = (chatId: number, text: string) => ({
		messageId: 1,
		chatId,
		chatType: "private",
		fromUserId: chatId,
		fromIsBot: false,
		username: null,
		firstName: "C",
		text,
		dateUnix: null,
	});

	function rig(opts: {
		now: () => Date;
		acquire?: (n: number) => { ok: false; message: string; busy?: boolean } | null;
		turnMs?: number;
		leaseMs?: number;
		modelWaitMs?: number;
	}) {
		const db = openDb(":memory:");
		const outbox = new Outbox({ db, log: silentLogger, adapters: [new WebChatAdapter({ db, log: silentLogger })] });
		const order: string[] = [];
		let calls = 0;
		const scheduler = new Scheduler({
			db,
			now: opts.now,
			models: {
				selected: () => "m",
				acquire: async () => opts.acquire?.(++calls) ?? { model: "m", valid: () => true, release: () => {} },
				onRouterLost: () => {},
			},
			conversations: {
				turn: async (req) => {
					order.push(req.text);
					await new Promise((r) => setTimeout(r, opts.turnMs ?? 0));
					return { ok: true, text: `re: ${req.text}`, model: "m" };
				},
			},
			outbox,
			log: silentLogger,
			pollMs: 20,
			agingMs: 60_000,
			leaseMs: opts.leaseMs ?? 900_000,
			modelWaitMs: opts.modelWaitMs ?? 120_000,
		});
		return { db, scheduler, order };
	}

	test("the owner goes first, but a contact waiting longer than the aging limit goes before the owner", () => {
		let t = Date.UTC(2026, 9, 2, 12, 0, 0);
		const { db, scheduler } = rig({ now: () => new Date(t) });
		const d = { db, now: () => new Date(t), newId: () => crypto.randomUUID() };
		const contact = admitTelegramUpdate(d, { updateId: 1, message: telegramMsg(9, "contact") });
		t += 10_000;
		const owner = admitOwnerWebMessage(d, { clientMsgId: "aging-own", text: "owner" });
		assert.ok(contact.outcome === "admitted" && owner.outcome === "admitted");
		const ids = () => scheduler.ordered(queuedJobsOf(db)).map((j) => j.id);
		assert.deepEqual(ids(), [owner.jobId, contact.jobId], "fresh contact waits behind the owner");
		t += 61_000;
		assert.deepEqual(ids(), [contact.jobId, owner.jobId], "aged contact goes first");
	});

	test("within one scope, a later message never overtakes an earlier one that is waiting", async () => {
		const { db, scheduler, order } = rig({
			now: () => new Date(),
			acquire: (n) => (n === 1 ? { ok: false, message: "not yet" } : null),
		});
		const d = { db, now: () => new Date(), newId: () => crypto.randomUUID() };
		admitOwnerWebMessage(d, { clientMsgId: "fifo-0001", text: "first" });
		admitOwnerWebMessage(d, { clientMsgId: "fifo-0002", text: "second" });
		assert.equal(await scheduler.step(), false, "the first could not start, so neither runs");
		assert.deepEqual(order, []);
		await scheduler.step();
		await scheduler.step();
		assert.deepEqual(order, ["first", "second"]);
	});

	test("a busy refusal (a model is loading) waits past the model-wait limit instead of failing", async () => {
		const { db, scheduler } = rig({
			now: () => new Date(Date.now() + 3_600_000),
			acquire: () => ({ ok: false, busy: true, message: "waiting for big to finish loading" }),
			modelWaitMs: 1,
		});
		const r = admitOwnerWebMessage(
			{ db, now: () => new Date(), newId: () => crypto.randomUUID() },
			{ clientMsgId: "busy-001", text: "hi" },
		);
		assert.ok(r.outcome === "admitted");
		await scheduler.step();
		await scheduler.step();
		assert.equal(getJob(db, r.jobId)!.status, "queued");
	});

	test("a running job's lease is renewed while its turn runs", async () => {
		const { db, scheduler } = rig({ now: () => new Date(), turnMs: 2500, leaseMs: 3000 });
		const r = admitOwnerWebMessage(
			{ db, now: () => new Date(), newId: () => crypto.randomUUID() },
			{ clientMsgId: "lease-001", text: "slow" },
		);
		assert.ok(r.outcome === "admitted");
		const run = scheduler.step();
		await waitFor(() => getJob(db, r.jobId)!.status === "running");
		const first = getJob(db, r.jobId)!.lease_until!;
		await waitFor(() => getJob(db, r.jobId)!.lease_until! > first, 3000);
		await run;
		assert.equal(getJob(db, r.jobId)!.status, "settled");
	});
});

function queuedJobsOf(db: ReturnType<typeof openDb>) {
	return db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at").all() as Parameters<
		Scheduler["ordered"]
	>[0];
}
