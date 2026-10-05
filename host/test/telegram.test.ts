// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { normalizeUpdate, TelegramPoller } from "../src/channels/telegram/poller.ts";
import { TELEGRAM_CURSOR } from "../src/kernel/admission.ts";
import type { Logger } from "../src/log.ts";
import { getCursor } from "../src/state/cursors.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { FakeTelegram } from "./fixtures/fake-telegram.ts";
import { freePort, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";
import { type Stack, startStack } from "./web-helpers.ts";

const TOKEN = "987654:SECRET-poller-token";
const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe("update normalization", () => {
	const raw = (message: Record<string, unknown>) => ({
		update_id: 5,
		message: { message_id: 1, date: 100, chat: { id: 7, type: "private" }, ...message },
	});

	test("text, falling back to the caption", () => {
		assert.equal(normalizeUpdate(raw({ from: { id: 7 }, text: "hi" })).message!.text, "hi");
		assert.equal(normalizeUpdate(raw({ from: { id: 7 }, caption: "a photo" })).message!.text, "a photo");
		assert.equal(normalizeUpdate(raw({ from: { id: 7 } })).message!.text, "");
	});

	test("identity is from.id; a missing `from` is kept as null, not guessed", () => {
		const m = normalizeUpdate(raw({ from: { id: 42, first_name: "Owner", is_bot: false }, text: "x" })).message!;
		assert.deepEqual(
			[m.fromUserId, m.firstName, m.fromIsBot, m.chatId, m.chatType],
			[42, "Owner", false, 7, "private"],
		);
		assert.equal(normalizeUpdate(raw({ text: "x" })).message!.fromUserId, null);
		assert.equal(normalizeUpdate({ update_id: 9 }).message, null);
	});
});

describe("telegram poller", () => {
	const fake = new FakeTelegram();
	const lines: string[] = [];
	const log: Logger = {
		info: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
		warn: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
		error: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
	};
	let pollers: TelegramPoller[] = [];
	before(() => fake.start());
	after(() => fake.stop());
	afterEach(async () => {
		for (const p of pollers) await p.stop();
		pollers = [];
		fake.pending.length = 0;
	});

	function poller(db: Db, opts: { allowed?: number[]; apiBase?: string; now?: () => Date } = {}) {
		const woke: number[] = [];
		const p = new TelegramPoller({
			token: TOKEN,
			admission: {
				db,
				now: opts.now ?? (() => new Date()),
				newId: () => crypto.randomUUID(),
				telegramAllowedUserIds: new Set(opts.allowed ?? []),
			},
			log,
			wake: () => woke.push(1),
			apiBase: opts.apiBase ?? fake.apiBase,
			longPollS: 1,
			minBackoffMs: 20,
			maxBackoffMs: 100,
			failedRetryMs: 200,
		});
		pollers.push(p);
		return { p, woke };
	}

	test("a message is admitted, the scheduler is woken, and the next poll confirms it with offset = id + 1", async () => {
		const db = openDb(":memory:");
		const { p, woke } = poller(db);
		const id = fake.receive({ fromId: 6001, firstName: "Julia", text: "hello" });
		p.start();
		await waitFor(() => getCursor(db, TELEGRAM_CURSOR) === id);
		await waitFor(() => fake.offsets.includes(id + 1));
		assert.equal(count(db, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'"), 1);
		assert.ok(woke.length >= 1);
		assert.equal(p.status.state, "connected");
		assert.match(p.status.detail, /receiving as @iyye_test_bot/);
	});

	test("a batch stops at the first admission failure; after the fault clears every update is admitted exactly once", async () => {
		const db = openDb(":memory:");
		const { p } = poller(db);
		const ids = [1, 2, 3].map((i) => fake.receive({ fromId: 6100 + i, text: `m${i}` }));
		// The second update's job insert fails, as a crash mid-admission would.
		db.exec(
			`CREATE TEMP TRIGGER fail_second BEFORE INSERT ON jobs
			 WHEN (SELECT external_ref FROM events WHERE id = NEW.trigger_event_id) = '${ids[1]}'
			 BEGIN SELECT RAISE(ABORT, 'boom'); END`,
		);
		assert.equal(await p.pollOnce(), 1);
		assert.equal(getCursor(db, TELEGRAM_CURSOR), ids[0], "the cursor did not move past the failed update");
		assert.equal(count(db, "SELECT COUNT(*) AS n FROM events"), 1);
		db.exec("DROP TRIGGER fail_second");
		assert.equal(await p.pollOnce(), 2);
		assert.equal(await p.pollOnce(), 0);
		assert.equal(getCursor(db, TELEGRAM_CURSOR), ids[2]);
		assert.equal(count(db, "SELECT COUNT(*) AS n FROM events"), 3);
		assert.equal(count(db, "SELECT COUNT(*) AS n FROM jobs"), 3);
	});

	test("after a restart, nothing already admitted is admitted again", async () => {
		const db = openDb(":memory:");
		const first = poller(db).p;
		fake.receive({ fromId: 6201, text: "before restart" });
		assert.equal(await first.pollOnce(), 1);
		const second = poller(db).p;
		fake.receive({ fromId: 6201, text: "after restart" });
		assert.equal(await second.pollOnce(), 1);
		assert.equal(count(db, "SELECT COUNT(*) AS n FROM events"), 2);
	});

	test("group chats, bots, missing senders, empty messages and disallowed users are recorded as dropped and confirmed", async () => {
		const db = openDb(":memory:");
		const { p } = poller(db, { allowed: [6300] });
		fake.receive({ fromId: 6300, chatId: -100, chatType: "group", text: "group" });
		fake.receive({ fromId: 6301, isBot: true, text: "a bot" });
		fake.receive({ fromId: 6300, noFrom: true, text: "channel post" });
		fake.receive({ fromId: 6300 }); // sticker: no text, no caption
		fake.receive({ fromId: 6399, text: "not on the allowlist" });
		const ok = fake.receive({ fromId: 6300, text: "allowed" });
		assert.equal(await p.pollOnce(), 1);
		const reasons = db.prepare("SELECT drop_reason FROM events WHERE status = 'dropped' ORDER BY external_ref").all();
		assert.deepEqual(reasons, [
			{ drop_reason: "non_private_chat" },
			{ drop_reason: "bot_sender" },
			{ drop_reason: "no_sender" },
			{ drop_reason: "no_text" },
			{ drop_reason: "sender_not_allowed" },
		]);
		assert.equal(getCursor(db, TELEGRAM_CURSOR), ok);
		assert.equal(count(db, "SELECT COUNT(*) AS n FROM contacts WHERE kind = 'contact'"), 1);
	});

	test("messages sent before the first Telegram start (left over from 1.x) are recorded, never answered", async () => {
		const db = openDb(":memory:");
		const start = Date.now();
		const { p } = poller(db, { now: () => new Date(start) });
		fake.receive({ fromId: 6401, text: "old message to 1.x", date: Math.floor(start / 1000) - 3600 });
		fake.receive({ fromId: 6401, text: "new", date: Math.floor(start / 1000) + 1 });
		p.start();
		await waitFor(() => count(db, "SELECT COUNT(*) AS n FROM events") === 2);
		assert.deepEqual(db.prepare("SELECT status, drop_reason FROM events ORDER BY external_ref").all(), [
			{ status: "dropped", drop_reason: "before_first_start" },
			{ status: "admitted", drop_reason: null },
		]);
		// The first-start time is kept, so a later restart applies the same boundary.
		const later = poller(db, { now: () => new Date(start + 86_400_000) }).p;
		later.start();
		fake.receive({ fromId: 6401, text: "older still", date: Math.floor(start / 1000) - 7200 });
		await waitFor(() => count(db, "SELECT COUNT(*) AS n FROM events") === 3);
		assert.equal(count(db, "SELECT COUNT(*) AS n FROM events WHERE drop_reason = 'before_first_start'"), 2);
	});

	test("a rejected token shows as failed and is retried slowly, not in a tight loop", async () => {
		const db = openDb(":memory:");
		const { p } = poller(db);
		fake.scriptApi("getMe", "401", "401", "401", "401", "401", "401");
		const before = fake.requests.length + fake.offsets.length;
		p.start();
		await waitFor(() => p.status.state === "failed");
		assert.match(p.status.detail, /rejected the bot token/);
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(fake.offsets.length + fake.requests.length - before <= 2, "no getUpdates while the token is rejected");
		await p.stop();
	});

	test("a competing poller (409) shows as failed; a network failure retries and recovers", async () => {
		const db = openDb(":memory:");
		const { p } = poller(db);
		fake.scriptApi("getUpdates", "409");
		p.start();
		await waitFor(() => p.status.state === "failed" && /another poller/.test(p.status.detail));
		await waitFor(() => p.status.state === "connected", 3000);

		const down = poller(openDb(":memory:"), { apiBase: `http://127.0.0.1:${await freePort()}` }).p;
		down.start();
		await waitFor(() => down.status.state === "retrying");
		assert.match(down.status.detail, /ECONNREFUSED/);
	});

	test("the bot token never appears in a log line or a status", async () => {
		const db = openDb(":memory:");
		const { p } = poller(db);
		fake.scriptApi("getMe", "401");
		lines.length = 0;
		p.start();
		await waitFor(() => p.status.state === "failed");
		assert.ok(lines.length > 0);
		assert.ok(!lines.join("\n").includes("SECRET") && !p.status.detail.includes("SECRET"));
	});
});

describe("telegram end to end", () => {
	const fake = new FakeTelegram();
	let sb: Sandbox;
	let s: Stack | null = null;
	let p: TelegramPoller | null = null;
	before(() => fake.start());
	after(() => fake.stop());
	afterEach(async () => {
		await p?.stop();
		await s?.stop();
		sb.cleanup();
	});

	test("a Telegram message is received, answered by Iyye, and the reply goes back to the same chat", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { telegramApiBase: fake.apiBase });
		p = new TelegramPoller({
			token: "1:fake",
			admission: { db: s.db, now: () => new Date(), newId: () => crypto.randomUUID() },
			log: { info() {}, warn() {}, error() {} },
			wake: () => s!.scheduler.wake(),
			apiBase: fake.apiBase,
			longPollS: 1,
		});
		p.start();
		fake.receive({ fromId: 6501, firstName: "Julia", text: "hello Iyye" });
		await waitFor(() => fake.messagesTo(6501).length === 1, 10_000);
		assert.deepEqual(fake.messagesTo(6501), ["echo: hello Iyye"]);
		assert.ok(fake.typing.includes(6501), "typing… was shown while answering");
		assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM web_feed"), 0, "nothing shown on the web chat");
	});
});
