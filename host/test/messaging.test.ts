// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.008: Iyye sends a Telegram message to a person it knows when the
 * owner asks (web chat or a linked Telegram account), composing the words
 * itself, at once, through the outbox, delivered only by its receipt.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { TelegramSender } from "../src/channels/telegram/sender.ts";
import { WebChatAdapter } from "../src/channels/web/adapter.ts";
import { commitmentsOfReply } from "../src/decisions/reply-review.ts";
import { ALWAYS_ON } from "../src/decisions/toolkit-selection.ts";
import { operatingNote } from "../src/integration/pi/prompt.ts";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { buildDigest } from "../src/kernel/day-summary.ts";
import { silentLogger } from "../src/log.ts";
import { forgetBusy, forgetRecords, forgetTarget } from "../src/memory/forget.ts";
import { Outbox } from "../src/outbox/outbox.ts";
import { getContact, linkAccount, OWNER_CONTACT_ID } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { insertSentMessage, recentSentNote, sentReport } from "../src/state/sent.ts";
import { ToolBroker, type ToolContext } from "../src/tools/broker.ts";
import { messagingToolkit } from "../src/tools/messaging.ts";
import { FakeTelegram } from "./fixtures/fake-telegram.ts";

const JACOB = 8601;

function people(db: Db): void {
	const add = (id: string, name: string, tg: number | null) => {
		db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', 't')").run(
			id,
			name,
		);
		if (tg !== null)
			db.prepare(
				"INSERT INTO channel_bindings (contact_id, channel, external_id, verified_by, created_at) VALUES (?, 'telegram', ?, 'first_contact', 't')",
			).run(id, String(tg));
	};
	add("jacob-1", "Jacob", JACOB);
	add("alex-tg", "Alex", 5001);
	linkAccount(db, "alex-tg", OWNER_CONTACT_ID, "owner_web", "t");
	add("sam-1", "Sam", 7001);
	add("sam-2", "Sam", 7002);
	add("nochat-1", "Nina", null);
}

describe("telegram_send (plan 0.008)", () => {
	const fake = new FakeTelegram();
	before(() => fake.start());
	after(() => fake.stop());

	const setupOutbox = (db: Db) =>
		new Outbox({
			db,
			log: silentLogger,
			adapters: [
				new WebChatAdapter({ db, log: silentLogger }),
				new TelegramSender({ token: "1:fake", log: silentLogger, apiBase: fake.apiBase }),
			],
			backoffMs: [10],
			maxAttempts: 1,
		});
	const setup = (maxPerDay = 20) => {
		const db = openDb(":memory:");
		people(db);
		const outbox = new Outbox({
			db,
			log: silentLogger,
			adapters: [
				new WebChatAdapter({ db, log: silentLogger }),
				new TelegramSender({ token: "1:fake", log: silentLogger, apiBase: fake.apiBase }),
			],
			backoffMs: [10],
			maxAttempts: 1,
		});
		const kit = messagingToolkit({ db, outbox, maxPerDay });
		const tool = kit.tools[0]!;
		let n = 0;
		const owner = (via: "web" | "telegram" = "web"): ToolContext => ({
			scope: "owner",
			principal: "owner",
			turn: {
				route: via === "web" ? { channel: "web", contact: "owner" } : { channel: "telegram", chatId: 5001 },
				contactId: OWNER_CONTACT_ID,
				eventId: `ev-${n++}`,
			},
		});
		return { db, outbox, kit, tool, owner };
	};

	test("asked in the web chat: Iyye's words go at once to Jacob's own chat, labelled, and are delivered by their receipt", async () => {
		const { db, tool, owner } = setup();
		const r = await tool.run({ to: "jacob", text: "Hi Jacob! Alex says hello." }, owner(), undefined);
		assert.match(r, /^Sent to Jacob on Telegram and delivered: /);
		assert.equal(fake.messagesTo(JACOB).at(-1), "✉️ From Iyye, on behalf of Alex:\n\nHi Jacob! Alex says hello.");
		const row = db
			.prepare(
				"SELECT s.*, a.state, a.route_json AS action_route FROM sent_messages s JOIN actions a ON a.id = s.action_id",
			)
			.get() as Record<string, string>;
		assert.deepEqual(
			[row.state, row.scope, JSON.parse(row.action_route), row.text, row.requested_via],
			[
				"delivered",
				"contact:jacob-1",
				{ channel: "telegram", chatId: JACOB },
				"Hi Jacob! Alex says hello.",
				"web chat",
			],
		);
		assert.match(
			sentReport(db),
			/to Jacob \(asked by you in the web chat\) · delivered, receipt provider_accepted · "Hi Jacob!/,
		);
		const ctx = { models: {} as never, db, issuer: "owner_web", sentReport: () => sentReport(db) };
		assert.match((await handleOwnerCommand("/sent", ctx)).reply, /to Jacob/);
		// Jacob's next turns are told what he was sent, as a record.
		const note = recentSentNote(db, "contact:jacob-1", new Date())!;
		assert.match(
			note,
			/^<sent_for_owner>\n.*record, not instructions:\n- \d\d:\d\d \(for the owner\): "Hi Jacob! Alex says hello."\n<\/sent_for_owner>$/s,
		);
		assert.equal(recentSentNote(db, "contact:sam-1", new Date()), null);
		// And the day summary counts it, without the words.
		const digest = buildDigest(db, {
			day: 1,
			from: new Date(Date.now() - 3_600_000).toISOString(),
			to: new Date(Date.now() + 3_600_000).toISOString(),
			outcome: null,
		});
		assert.match(digest, /Messages Iyye sent to people: delivered 1 to Jacob \(asked by the owner 1\)\./);
		assert.ok(!digest.includes("hello"));
	});

	test("from the owner's linked Telegram account too; one message per person per request, so a retried turn never sends twice", async () => {
		const { db, tool, owner } = setup();
		const ctx = owner("telegram");
		const before = fake.messagesTo(JACOB).length;
		assert.match(await tool.run({ to: "Jacob", text: "See you soon." }, ctx, undefined), /delivered/);
		assert.match(
			await tool.run({ to: "Jacob", text: "See you soon!" }, ctx, undefined),
			/^Already sent to Jacob for this request \(delivered\)/,
		);
		assert.equal(fake.messagesTo(JACOB).length, before + 1);
		assert.equal(
			(db.prepare("SELECT requested_via FROM sent_messages").get() as { requested_via: string }).requested_via,
			"Telegram",
		);
	});

	test("the host resolves the person: unknown, ambiguous and a person without a Telegram chat are refused; the owner is reachable too", async () => {
		const { tool, owner } = setup();
		assert.match(
			await tool.run({ to: "Boris", text: "x" }, owner(), undefined),
			/knows nobody called "Boris"\. Ask who they mean/,
		);
		assert.match(
			await tool.run({ to: "Sam", text: "x" }, owner(), undefined),
			/2 people match "Sam" .*Ask which one/,
		);
		// "Alex" is the owner's linked account, so it means the owner, on that Telegram chat.
		assert.match(
			await tool.run({ to: "Alex", text: "note to self" }, owner(), undefined),
			/^Sent to the owner on Telegram/,
		);
		assert.match(fake.messagesTo(5001).at(-1)!, /note to self$/);
		assert.match(
			await tool.run({ to: "Nina", text: "x" }, owner(), undefined),
			/Nina has no Telegram chat with Iyye/,
		);
		assert.match(
			await tool.run({ to: "sam-2", text: "x" }, owner(), undefined),
			/^Sent to Sam on Telegram and delivered/,
			"an id picks one",
		);
		// No parameter can name a chat or a route: only a person and the words.
		const keys = Object.keys((tool.parameters as { properties: object }).properties).sort();
		assert.deepEqual(keys, ["text", "to"]);
	});

	test("who may send: the owner, trusted contacts and Iyye itself; never an untrusted contact, and trust is checked again when it runs", async () => {
		const { db, kit, tool } = setup();
		const broker = new ToolBroker({ db, log: silentLogger, toolkits: [kit] });
		assert.deepEqual(broker.forSession({ scope: "owner", principal: "owner" }).names, ["telegram_send"]);
		assert.deepEqual(broker.forSession({ scope: "contact:jacob-1", principal: "contact" }).names, []);
		assert.deepEqual(broker.forSession({ scope: "contact:sam-1", principal: "contact", trusted: true }).names, [
			"telegram_send",
		]);
		assert.deepEqual(broker.forSession({ scope: "iyye:bg:1", principal: "iyye" }).names, ["telegram_send"]);
		// A plan step only looks (its question may be a contact's words, approved as a read-only look).
		assert.deepEqual(broker.forSession({ scope: "iyye:plan:p1:0", principal: "iyye" }).names, []);
		assert.match(
			await tool.run({ to: "Jacob", text: "x" }, { scope: "iyye:plan:p1:0", principal: "iyye" }, undefined),
			/a plan step only looks/,
		);
		const contact = (id: string, chat: number): ToolContext => ({
			scope: `contact:${id}`,
			principal: "contact",
			trusted: true,
			turn: { route: { channel: "telegram", chatId: chat }, contactId: id, eventId: `e-${id}` },
		});
		// Jacob is not trusted: even a context that claims trust is refused, from the record.
		assert.match(
			await tool.run({ to: "Sam", text: "x" }, contact("jacob-1", JACOB), undefined),
			/only the owner and people the owner trusts/,
		);
		assert.match(
			await tool.run({ to: "Sam", text: "x" }, { scope: "owner", principal: "owner" }, undefined),
			/only be sent when someone asks in a conversation/,
		);
		// Always declared (never hidden by toolkit selection), and the prompt says how to report it.
		assert.ok(ALWAYS_ON.includes("messaging"));
		assert.match(
			operatingNote([
				{ name: "messaging", description: "messages", effect: "reach", tools: ["telegram_send: send"] },
			]),
			/never say a message was sent unless the tool said so/,
		);
	});

	test("a trusted contact asks: labelled with their name, the owner is told, their own cap holds; revoked trust stops it", async () => {
		const { db, tool } = setup();
		db.prepare("UPDATE contacts SET trusted = 1 WHERE id = 'sam-1'").run();
		let n = 0;
		const sam = (): ToolContext => ({
			scope: "contact:sam-1",
			principal: "contact",
			trusted: true,
			turn: { route: { channel: "telegram", chatId: 7001 }, contactId: "sam-1", eventId: `sam-ev-${n++}` },
		});
		assert.match(await tool.run({ to: "Jacob", text: "Sam says hi" }, sam(), undefined), /delivered/);
		assert.equal(fake.messagesTo(JACOB).at(-1), "✉️ From Iyye, on behalf of Sam:\n\nSam says hi");
		await new Promise((x) => setTimeout(x, 30));
		const notice = db.prepare("SELECT content FROM actions WHERE idempotency_key LIKE 'notice:sent-by:%'").get() as {
			content: string;
		};
		assert.equal(notice.content, '"Sam" asked Iyye to write to "Jacob" (delivered): "Sam says hi"');
		assert.match(sentReport(db), /to Jacob \(asked by "Sam" on Telegram\)/);
		assert.match(recentSentNote(db, "contact:jacob-1", new Date())!, /\(for "Sam"\): "Sam says hi"/);
		// Writing to the owner is fine and needs no notice (the owner receives it).
		assert.match(await tool.run({ to: "Alex", text: "for Alex" }, sam(), undefined), /^Sent to the owner/);
		assert.equal(
			(
				db.prepare("SELECT count(*) AS n FROM actions WHERE idempotency_key LIKE 'notice:sent-by:%'").get() as {
					n: number;
				}
			).n,
			1,
		);
		assert.match(
			await tool.run({ to: "sam-1", text: "x" }, sam(), undefined),
			/that is the person you are talking with/,
		);
		// The owner revokes trust: the next call is refused, whatever the session still declares.
		db.prepare("UPDATE contacts SET trusted = 0 WHERE id = 'sam-1'").run();
		assert.match(
			await tool.run({ to: "Jacob", text: "again" }, sam(), undefined),
			/only the owner and people the owner trusts/,
		);
		// The cap per trusted contact.
		db.prepare("UPDATE contacts SET trusted = 1 WHERE id = 'sam-1'").run();
		const capped = messagingToolkit({ db, outbox: setupOutbox(db), contactMaxPerDay: 2 }).tools[0]!;
		assert.match(
			await capped.run({ to: "Jacob", text: "third" }, sam(), undefined),
			/Sam already asked for 2 messages today/,
		);
	});

	test("Iyye on its own: labelled 'From Iyye', the owner told, one message per person per day and its own daily cap", async () => {
		const { db, tool } = setup();
		const bg: ToolContext = { scope: "iyye:inv:1:1", principal: "iyye" };
		assert.match(await tool.run({ to: "Jacob", text: "Your build finished." }, bg, undefined), /delivered/);
		assert.equal(fake.messagesTo(JACOB).at(-1), "✉️ From Iyye:\n\nYour build finished.");
		await new Promise((x) => setTimeout(x, 30));
		const notice = db.prepare("SELECT content FROM actions WHERE idempotency_key LIKE 'notice:sent-by:%'").get() as {
			content: string;
		};
		assert.equal(notice.content, 'Iyye wrote to "Jacob" on its own (delivered): "Your build finished."');
		assert.match(
			await tool.run({ to: "Jacob", text: "And another thing" }, bg, undefined),
			/already wrote to Jacob on its own today/,
		);
		assert.match(sentReport(db), /to Jacob \(by Iyye on its own\)/);
		assert.match(recentSentNote(db, "contact:jacob-1", new Date())!, /\(on your own\): "Your build finished\."/);
		const capped = messagingToolkit({ db, outbox: setupOutbox(db), iyyeMaxPerDay: 1 }).tools[0]!;
		assert.match(
			await capped.run({ to: "sam-1", text: "x" }, bg, undefined),
			/already sent 1 messages on its own today/,
		);
		const digest = buildDigest(db, {
			day: 1,
			from: new Date(Date.now() - 3_600_000).toISOString(),
			to: new Date(Date.now() + 3_600_000).toISOString(),
			outcome: null,
		});
		assert.match(digest, /Messages Iyye sent to people: delivered 1 to Jacob \(asked by Iyye on its own 1\)\./);
	});

	test("/forget of a person who asked for a message removes their words from the record and the owner's notice", async () => {
		const { db, tool } = setup();
		db.prepare("UPDATE contacts SET trusted = 1 WHERE id = 'sam-1'").run();
		await tool.run(
			{ to: "Jacob", text: "sams secret words" },
			{
				scope: "contact:sam-1",
				principal: "contact",
				trusted: true,
				turn: { route: { channel: "telegram", chatId: 7001 }, contactId: "sam-1", eventId: "s-ev" },
			},
			undefined,
		);
		await new Promise((x) => setTimeout(x, 30));
		const t = forgetTarget(db, getContact(db, "sam-1")!);
		assert.ok(typeof t !== "string");
		forgetRecords(db, t, "owner_web", new Date().toISOString());
		const dump = JSON.stringify([
			db.prepare("SELECT * FROM sent_messages").all(),
			db.prepare("SELECT * FROM actions").all(),
			db.prepare("SELECT * FROM web_feed").all(),
		]);
		assert.ok(!dump.includes("secret"));
	});

	test("a failure is reported truthfully, to the owner too; the daily limit holds", async () => {
		const { db, tool, owner } = setup(2);
		fake.script(JACOB, "403");
		const r = await tool.run({ to: "Jacob", text: "hello?" }, owner(), undefined);
		assert.match(r, /^Could not be delivered to Jacob: .*blocked.*Say it was not sent\./);
		await new Promise((x) => setTimeout(x, 50));
		const notice = db
			.prepare("SELECT content FROM actions WHERE idempotency_key LIKE 'notice:send-failed:%'")
			.get() as { content: string };
		assert.match(notice.content, /^Your message to "Jacob" could not be delivered: /);
		assert.match(
			await tool.run({ to: "Sam", text: "x" }, owner(), undefined),
			/^Not sent: .*more than one|2 people match/,
		);
		assert.match(await tool.run({ to: "sam-1", text: "x" }, owner(), undefined), /delivered/);
		assert.match(
			await tool.run({ to: "sam-2", text: "x" }, owner(), undefined),
			/^Not sent: 2 messages were already sent today/,
		);
	});

	test("/forget removes the words sent to the person, and waits while one is on its way", async () => {
		const { db, tool, owner } = setup();
		await tool.run({ to: "Jacob", text: "secret words for Jacob" }, owner(), undefined);
		const t = forgetTarget(db, getContact(db, "jacob-1")!);
		assert.ok(typeof t !== "string");
		db.prepare("UPDATE actions SET state = 'queued' WHERE idempotency_key LIKE 'notice:send:%'").run();
		assert.equal(forgetBusy(db, t.scopes), "1 message(s) to them are still being delivered");
		db.prepare("UPDATE actions SET state = 'delivered' WHERE idempotency_key LIKE 'notice:send:%'").run();
		forgetRecords(db, t, "owner_web", new Date().toISOString());
		const dump = JSON.stringify([
			db.prepare("SELECT * FROM sent_messages").all(),
			db.prepare("SELECT * FROM actions").all(),
		]);
		assert.ok(!dump.includes("secret"));
		assert.equal(recentSentNote(db, "contact:jacob-1", new Date()), null);
	});

	test("a message whose send was cut by a crash still counts: /sent, the day summary and /forget find it by its key", async () => {
		const { db } = setup();
		const at = new Date().toISOString();
		insertSentMessage(db, {
			id: "crash-1",
			dedup_key: "ev-x:jacob-1",
			recipient_contact_id: "jacob-1",
			scope: "contact:jacob-1",
			route_json: JSON.stringify({ channel: "telegram", chatId: JACOB }),
			text: "cut short",
			requested_event_id: null,
			requested_via: "web chat",
			requested_by: "owner",
			requester_contact_id: "owner",
			requester_scope: "owner",
			created_at: at,
		});
		// The action was created and claimed, then the host died before `action_id` was written back.
		db.prepare(
			`INSERT INTO actions (id, job_id, event_id, kind, route_json, content_hash, content, idempotency_key, state, created_at)
			 VALUES ('act-crash', NULL, NULL, 'status', ?, 'h', 'cut short', 'notice:send:crash-1', 'unknown', ?)`,
		).run(JSON.stringify({ channel: "telegram", chatId: JACOB }), at);
		assert.equal((db.prepare("SELECT action_id FROM sent_messages").get() as { action_id: null }).action_id, null);
		assert.match(sentReport(db), /to Jacob .* · unknown · "cut short"/);
		const digest = buildDigest(db, {
			day: 1,
			from: new Date(Date.now() - 3_600_000).toISOString(),
			to: new Date(Date.now() + 3_600_000).toISOString(),
			outcome: null,
		});
		assert.match(digest, /Messages Iyye sent to people: may not have arrived 1 to Jacob \(asked by the owner 1\)\./);
		db.prepare("UPDATE actions SET state = 'sending' WHERE id = 'act-crash'").run();
		const t = forgetTarget(db, getContact(db, "jacob-1")!);
		assert.ok(typeof t !== "string");
		assert.match(forgetBusy(db, t.scopes) ?? "", /still being delivered/);
	});

	test("sent through the broker as in a real turn: the owner's tool call is recorded, and /forget removes its words too", async () => {
		const { db, kit } = setup();
		const broker = new ToolBroker({ db, log: silentLogger, toolkits: [kit] });
		const session = broker.forSession({ scope: "owner", principal: "owner" });
		session.beginTurn({
			route: { channel: "web", contact: "owner" },
			contactId: OWNER_CONTACT_ID,
			eventId: "ev-broker",
		});
		const def = session.definitions.find((x) => x.name === "telegram_send")!;
		const out = (await def.execute(
			"call-1",
			{ to: "Jacob", text: "  private words for Jacob " },
			undefined,
			undefined as never,
			undefined as never,
		)) as {
			content: { text: string }[];
		};
		assert.match(out.content[0]!.text, /delivered/);
		const call = () =>
			db.prepare("SELECT scope, args_json, result FROM tool_calls WHERE tool = 'telegram_send'").get() as Record<
				string,
				string | null
			>;
		assert.equal(call().scope, "owner");
		assert.match(String(call().result), /private words/);
		const t = forgetTarget(db, getContact(db, "jacob-1")!);
		assert.ok(typeof t !== "string");
		forgetRecords(db, t, "owner_web", new Date().toISOString());
		assert.ok(!JSON.stringify(call()).includes("private"));
	});

	test('the reply-review ledger counts a message the turn sent: "I sent Jacob a greeting" is a supported claim', async () => {
		const { db, tool } = setup();
		const at = new Date().toISOString();
		db.prepare(
			"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('ev-ledger', 'ev-ledger', 'web', ?, 'owner', ?, '{}', 'answered')",
		).run(OWNER_CONTACT_ID, at);
		db.prepare(
			"INSERT INTO actions (id, job_id, event_id, kind, route_json, content_hash, content, idempotency_key, state, created_at) VALUES ('reply-1', NULL, 'ev-ledger', 'reply', '{}', 'h', 'c', 'k-ledger', 'delivered', ?)",
		).run(at);
		assert.deepEqual(commitmentsOfReply(db, "reply-1"), []);
		await tool.run(
			{ to: "Jacob", text: "hi" },
			{
				scope: "owner",
				principal: "owner",
				turn: { route: { channel: "web", contact: "owner" }, contactId: OWNER_CONTACT_ID, eventId: "ev-ledger" },
			},
			undefined,
		);
		assert.equal(commitmentsOfReply(db, "reply-1").length, 1);
		assert.match(commitmentsOfReply(db, "reply-1")[0]!, /^send:/);
	});
});
