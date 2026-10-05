// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { TelegramSender } from "../src/channels/telegram/sender.ts";
import type { TelegramMessage } from "../src/channels/types.ts";
import { WebChatAdapter } from "../src/channels/web/adapter.ts";
import { admitTelegramUpdate } from "../src/kernel/admission.ts";
import { recover } from "../src/kernel/recovery.ts";
import { Scheduler } from "../src/kernel/scheduler.ts";
import type { Logger } from "../src/log.ts";
import { type ChannelAdapter, Outbox, type OutboxHooks } from "../src/outbox/outbox.ts";
import { splitOffsets } from "../src/outbox/split.ts";
import { openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { getJob } from "../src/state/jobs.ts";
import { FakeTelegram } from "./fixtures/fake-telegram.ts";
import { freePort, waitFor } from "./model-helpers.ts";

const TOKEN = "123456:SECRET-test-token-abcdef";

describe("message splitting", () => {
	const join = (text: string, max: number) => splitOffsets(text, max).map(([a, b]) => text.slice(a, b));

	test("short text is one chunk; web (no limit) is always one chunk", () => {
		assert.deepEqual(splitOffsets("hello", 4096), [[0, 5]]);
		assert.deepEqual(splitOffsets("x".repeat(10_000), Number.POSITIVE_INFINITY), [[0, 10_000]]);
	});

	test("chunks tile the text exactly, never exceed the limit, and prefer paragraph breaks", () => {
		const para = (n: number) => `${"word ".repeat(n).trim()}.`;
		const text = [para(500), para(500), para(500), para(500)].join("\n\n");
		const chunks = join(text, 4096);
		assert.equal(chunks.join(""), text);
		assert.ok(chunks.every((c) => c.length <= 4096));
		assert.ok(
			chunks.slice(0, -1).every((c) => c.endsWith("\n\n")),
			"cuts after a paragraph",
		);
	});

	test("without spaces it cuts hard but never splits a surrogate pair", () => {
		const text = "😀".repeat(3000); // 6000 UTF-16 code units
		const chunks = join(text, 4095);
		assert.equal(chunks.join(""), text);
		for (const c of chunks) assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(c), "no lone surrogate at an edge");
	});
});

describe("outbox delivery to Telegram", () => {
	const fake = new FakeTelegram();
	const logs: string[] = [];
	const log: Logger = {
		info: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
		warn: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
		error: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
	};
	let clock = Date.UTC(2026, 9, 2, 12, 0, 0);
	const now = () => new Date(clock);
	let updateId = 1;

	before(() => fake.start());
	after(() => fake.stop());
	beforeEach(() => {
		logs.length = 0;
	});

	function setup(
		opts: { hooks?: OutboxHooks; apiBase?: string; adapters?: ChannelAdapter[]; timeoutMs?: number } = {},
	) {
		const db = openDb(":memory:");
		const telegram = new TelegramSender({
			token: TOKEN,
			log,
			apiBase: opts.apiBase ?? fake.apiBase,
			timeoutMs: opts.timeoutMs ?? 2000,
		});
		const outbox = new Outbox({
			db,
			log,
			now,
			adapters: opts.adapters ?? [new WebChatAdapter({ db, log }), telegram],
			backoffMs: [1000, 1000],
			maxAttempts: 3,
			hooks: opts.hooks ?? {},
		});
		const admit = (chatId: number) => {
			const message: TelegramMessage = {
				messageId: 1,
				chatId,
				chatType: "private",
				fromUserId: chatId,
				fromIsBot: false,
				username: null,
				firstName: "Julia",
				text: "hi",
				dateUnix: null,
			};
			const r = admitTelegramUpdate(
				{ db, now, newId: () => crypto.randomUUID() },
				{ updateId: updateId++, message },
			);
			assert.ok(r.outcome === "admitted");
			return { event: getEvent(db, r.eventId)!, jobId: r.jobId };
		};
		const reply = (chatId: number, content: string) => {
			const { event, jobId } = admit(chatId);
			return outbox.deliver({ jobId, event, kind: "reply", content });
		};
		return { db, outbox, admit, reply };
	}

	test("a reply goes to exactly the chat it answers, with Telegram's message_id as receipt", async () => {
		const { db, outbox, reply } = setup();
		const a = await reply(1001, "Hello Julia");
		assert.equal(a.state, "delivered");
		assert.deepEqual(fake.messagesTo(1001).slice(-1), ["Hello Julia"]);
		const [r] = outbox.receipts(a.id);
		assert.equal(r!.level, "provider_accepted");
		assert.match(r!.provider_ref!, /^\d+$/);
		assert.equal(getEvent(db, a.event_id!)!.status, "answered");
		assert.equal(getJob(db, a.job_id!)!.status, "settled");
	});

	test("a long reply is split into ≤4096-character parts, each with its own receipt, in order", async () => {
		const { outbox, reply } = setup();
		const content = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: ${"x".repeat(700)}`).join("\n\n");
		const a = await reply(1002, content);
		assert.equal(a.state, "delivered");
		const parts = fake.messagesTo(1002);
		assert.equal(parts.length, outbox.receipts(a.id).length);
		assert.ok(parts.length >= 3 && parts.every((p) => p.length <= 4096));
		assert.equal(parts.join("\n\n"), content);
		assert.ok(outbox.receipts(a.id).every((r) => r.outcome === "delivered" && r.provider_ref));
	});

	test("a rejection (bot blocked) is terminal, fails the job, and is never retried", async () => {
		const { db, outbox, reply } = setup();
		fake.script(1003, "403");
		const a = await reply(1003, "hi");
		assert.equal(a.state, "terminal_failure");
		assert.match(a.last_error!, /bot was blocked/);
		assert.equal(getJob(db, a.job_id!)!.status, "failed");
		clock += 60_000;
		assert.equal(await outbox.dispatchDue(), 0);
		assert.equal(fake.messagesTo(1003).length, 0);
	});

	test("a rate limit waits for retry_after, then the dispatcher delivers it", async () => {
		const { outbox, reply } = setup();
		fake.script(1004, "429");
		const a = await reply(1004, "after the limit");
		assert.equal(a.state, "failed");
		assert.ok(a.next_attempt_at);
		assert.equal(await outbox.dispatchDue(), 0, "not before next_attempt_at");
		clock += 2000;
		await outbox.dispatchDue();
		const done = outbox.get(a.id)!;
		assert.equal(done.state, "delivered");
		assert.equal(done.attempts, 2);
		assert.deepEqual(fake.messagesTo(1004), ["after the limit"]);
	});

	test("a retry resumes at the first undelivered part: earlier parts are not sent twice", async () => {
		const { outbox, reply } = setup();
		fake.script(1005, "ok", "429");
		const content = ["A".repeat(4000), "B".repeat(4000), "C".repeat(100)].join("\n\n");
		const a = await reply(1005, content);
		assert.equal(a.state, "failed");
		assert.deepEqual(
			outbox.receipts(a.id).map((r) => r.outcome),
			["delivered", "failed", "pending"],
		);
		clock += 2000;
		await outbox.dispatchDue();
		assert.equal(outbox.get(a.id)!.state, "delivered");
		assert.deepEqual(
			fake.messagesTo(1005).map((t) => t[0]),
			["A", "B", "C"],
		);
	});

	test("Telegram unreachable is retried, then becomes a terminal failure after the attempt limit", async () => {
		const { outbox, reply } = setup({ apiBase: `http://127.0.0.1:${await freePort()}` });
		const a = await reply(1006, "nobody listening");
		assert.equal(a.state, "failed");
		assert.match(a.last_error!, /Telegram unreachable \(ECONNREFUSED\)/);
		for (let i = 0; i < 3; i++) {
			clock += 5000;
			await outbox.dispatchDue();
		}
		const end = outbox.get(a.id)!;
		assert.equal(end.state, "terminal_failure");
		assert.equal(end.attempts, 3);
	});

	for (const [name, script, timeoutMs] of [
		["a 5xx answer", "500", 2000],
		["a dropped connection after the request was sent", "drop", 2000],
		["no answer before the timeout", "hang", 300],
	] as const) {
		test(`${name} leaves the action unknown and it is never retried automatically`, async () => {
			const { outbox, reply } = setup({ timeoutMs });
			const chat = 2000 + updateId;
			fake.script(chat, script);
			const a = await reply(chat, "maybe sent");
			assert.equal(a.state, "unknown");
			assert.equal(outbox.receipts(a.id)[0]!.outcome, "unknown");
			clock += 600_000;
			assert.equal(await outbox.dispatchDue(), 0);
			assert.equal(outbox.get(a.id)!.state, "unknown");
		});
	}

	test("the bot token never reaches an action, a receipt or a log line", async () => {
		const { db, reply } = setup({ apiBase: `http://127.0.0.1:${await freePort()}` });
		await reply(1007, "x");
		fake.script(1008, "500");
		await setup().reply(1008, "y");
		const stored = JSON.stringify([
			db.prepare("SELECT * FROM actions").all(),
			db.prepare("SELECT * FROM receipts").all(),
		]);
		assert.ok(!stored.includes(TOKEN) && !stored.includes("SECRET"), "token in the database");
		assert.ok(logs.length > 0 && !logs.join("\n").includes("SECRET"), "token in a log line");
	});

	test("A3: with Telegram down or absent, a Telegram reply never appears in the web chat", async () => {
		// Telegram down: the reply fails, and nothing is written to the web transcript.
		fake.script(1009, "403");
		const down = setup();
		const a = await down.reply(1009, "only for Julia");
		assert.equal(a.state, "terminal_failure");
		assert.equal((down.db.prepare("SELECT COUNT(*) AS n FROM web_feed").get() as { n: number }).n, 0);
		// No Telegram adapter at all (no token): the same, with no fallback to the web adapter.
		const db2 = openDb(":memory:");
		const withWebOnly = new Outbox({ db: db2, log, now, adapters: [new WebChatAdapter({ db: db2, log })] });
		const r = admitTelegramUpdate(
			{ db: db2, now, newId: () => crypto.randomUUID() },
			{
				updateId: 1,
				message: {
					messageId: 1,
					chatId: 5,
					chatType: "private",
					fromUserId: 5,
					fromIsBot: false,
					username: null,
					firstName: "J",
					text: "hi",
					dateUnix: null,
				},
			},
		);
		assert.ok(r.outcome === "admitted");
		const b = await withWebOnly.deliver({
			jobId: r.jobId,
			event: getEvent(db2, r.eventId)!,
			kind: "reply",
			content: "only for J",
		});
		assert.equal(b.state, "terminal_failure");
		assert.match(b.last_error!, /no adapter for channel telegram/);
		assert.equal((db2.prepare("SELECT COUNT(*) AS n FROM web_feed").get() as { n: number }).n, 0);
	});

	test("two senders racing for one action: only one claims and sends it", async () => {
		const { db, outbox, admit } = setup();
		const { event, jobId } = admit(1010);
		db.prepare(
			`INSERT INTO actions (id, job_id, event_id, kind, route_json, content_hash, content, idempotency_key, state, created_at)
			 VALUES ('race', ?, ?, 'reply', '{"channel":"telegram","chatId":1010}', 'h', 'once', 'action:race', 'queued', 'now')`,
		).run(jobId, event.id);
		await Promise.all([outbox.send("race"), outbox.send("race"), outbox.send("race")]);
		assert.deepEqual(fake.messagesTo(1010), ["once"]);
	});

	describe("A4: crash at send", () => {
		class Crash extends Error {}
		const crashAt = (point: keyof OutboxHooks): OutboxHooks => ({
			[point]: () => {
				throw new Crash(point);
			},
		});

		test("before the part is marked: recovery sends it, exactly once", async () => {
			const s = setup({ hooks: crashAt("beforeChunkMarked") });
			await assert.rejects(s.reply(1011, "first try crashed"), Crash);
			const restarted = new Outbox({
				db: s.db,
				log,
				now,
				adapters: [new TelegramSender({ token: TOKEN, log, apiBase: fake.apiBase })],
			});
			const report = await recover(s.db, restarted, { fail: async () => {} }, log);
			assert.equal(report.unknown, 0);
			assert.deepEqual(fake.messagesTo(1011), ["first try crashed"]);
			const [a] = restarted.actionsInState("delivered");
			assert.ok(a);
		});

		test("after Telegram accepted it, before the receipt was committed: unknown, no blind resend", async () => {
			const s = setup({ hooks: crashAt("afterAdapter") });
			await assert.rejects(s.reply(1012, "sent, then crashed"), Crash);
			assert.deepEqual(fake.messagesTo(1012), ["sent, then crashed"]);
			const restarted = new Outbox({
				db: s.db,
				log,
				now,
				adapters: [new TelegramSender({ token: TOKEN, log, apiBase: fake.apiBase })],
			});
			const report = await recover(s.db, restarted, { fail: async () => {} }, log);
			assert.equal(report.unknown, 1);
			clock += 600_000;
			await restarted.dispatchDue();
			assert.deepEqual(fake.messagesTo(1012), ["sent, then crashed"], "still exactly one message");
			assert.equal(restarted.actionsInState("unknown").length, 1);
		});

		test("marked as sending but never sent: unknown too (the host cannot tell)", async () => {
			const s = setup({ hooks: crashAt("afterChunkMarked") });
			await assert.rejects(s.reply(1013, "never left"), Crash);
			const restarted = new Outbox({
				db: s.db,
				log,
				now,
				adapters: [new TelegramSender({ token: TOKEN, log, apiBase: fake.apiBase })],
			});
			assert.equal((await recover(s.db, restarted, { fail: async () => {} }, log)).unknown, 1);
			assert.equal(fake.messagesTo(1013).length, 0);
		});
	});

	describe("owner resolution of unknown actions", () => {
		test("'it arrived' marks it delivered at owner_confirmed and answers the event", async () => {
			const { db, outbox, reply } = setup();
			fake.script(1014, "500");
			const a = await reply(1014, "did it arrive?");
			const r = await outbox.resolve(a.id, "delivered", "owner_web");
			assert.equal(r.state, "delivered");
			assert.equal(r.resolved_by, "owner_web");
			assert.equal(outbox.receipts(a.id)[0]!.level, "owner_confirmed");
			assert.equal(getEvent(db, a.event_id!)!.status, "answered");
		});

		test("'send again' resends the undelivered part (the owner accepts a possible duplicate)", async () => {
			const { outbox, reply } = setup();
			fake.script(1015, "500");
			const a = await reply(1015, "again please");
			const r = await outbox.resolve(a.id, "resend", "owner_web");
			assert.equal(r.state, "delivered");
			assert.deepEqual(fake.messagesTo(1015), ["again please", "again please"]);
		});

		test("'dismiss' closes it as a terminal failure", async () => {
			const { db, outbox, reply } = setup();
			fake.script(1016, "500");
			const a = await reply(1016, "forget it");
			const r = await outbox.resolve(a.id, "dismiss", "owner_web");
			assert.equal(r.state, "terminal_failure");
			assert.equal(r.resolution, "dismiss");
			assert.equal(getJob(db, a.job_id!)!.status, "failed");
			assert.equal(fake.messagesTo(1016).length, 1, "dismiss sends nothing more");
		});
	});

	test("while a Telegram turn runs, the scheduler shows 'typing…' through the adapter", async () => {
		const db = openDb(":memory:");
		const outbox = new Outbox({
			db,
			log,
			adapters: [new TelegramSender({ token: TOKEN, log, apiBase: fake.apiBase })],
		});
		const scheduler = new Scheduler({
			db,
			models: {
				selected: () => "m",
				acquire: async () => ({ model: "m", valid: () => true, release: () => {} }),
				onRouterLost: () => {},
			},
			conversations: {
				turn: async () => {
					await new Promise((r) => setTimeout(r, 300));
					return { ok: true, text: "typed", model: "m" };
				},
			},
			outbox,
			log,
			pollMs: 20,
		});
		const r = admitTelegramUpdate(
			{ db, now: () => new Date(), newId: () => crypto.randomUUID() },
			{
				updateId: 1,
				message: {
					messageId: 1,
					chatId: 1017,
					chatType: "private",
					fromUserId: 1017,
					fromIsBot: false,
					username: null,
					firstName: "J",
					text: "hi",
					dateUnix: null,
				},
			},
		);
		assert.ok(r.outcome === "admitted");
		scheduler.start();
		await waitFor(() => getEvent(db, r.eventId)!.status === "answered");
		await scheduler.stop();
		assert.ok(fake.typing.includes(1017));
		assert.deepEqual(fake.messagesTo(1017), ["typed"]);
	});
});
