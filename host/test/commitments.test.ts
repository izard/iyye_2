// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.006 C1: commitments and reminders, end to end through admission,
 * the scheduler, Pi (the fake router calling `reminder_create`), the
 * commitment clock, the outbox and the fake Telegram Bot API (HLD §15 #4,
 * #5, #6, #8).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { TelegramSender } from "../src/channels/telegram/sender.ts";
import type { TelegramMessage } from "../src/channels/types.ts";
import { WebChatAdapter } from "../src/channels/web/adapter.ts";
import { DecisionClient } from "../src/decisions/client.ts";
import { ReplyReviewShadow } from "../src/decisions/reply-review.ts";
import { decisionsReport, labelDecision } from "../src/decisions/report.ts";
import { admitOwnerWebMessage, admitTelegramUpdate } from "../src/kernel/admission.ts";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { CommitmentClock } from "../src/kernel/commitments.ts";
import { buildDigest } from "../src/kernel/day-summary.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { recover } from "../src/kernel/recovery.ts";
import { ReminderCommands } from "../src/kernel/reminder-commands.ts";
import { parseWindow } from "../src/kernel/rhythm.ts";
import { silentLogger } from "../src/log.ts";
import { forgetBusy, forgetRecords, forgetTarget } from "../src/memory/forget.ts";
import { Outbox } from "../src/outbox/outbox.ts";
import {
	type Commitment,
	insertCommitment,
	recentReminderNote,
	remindersChip,
	remindersToday,
} from "../src/state/commitments.ts";
import { getContact, linkAccount, OWNER_CONTACT_ID } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { setKv } from "../src/state/kv.ts";
import { ToolBroker } from "../src/tools/broker.ts";
import { remindersToolkit } from "../src/tools/reminders.ts";
import { FakeKev } from "./fixtures/fake-kev-http.ts";
import { FakeTelegram } from "./fixtures/fake-telegram.ts";
import { type Sandbox, sandbox, waitFor } from "./model-helpers.ts";
import { http, loginAs, type Stack, startStack } from "./web-helpers.ts";

let updateId = 20_000;
const deps = (db: Db) => ({ db, now: () => new Date(), newId: () => crypto.randomUUID() });

function fromTelegram(db: Db, userId: number, firstName: string, text: string) {
	const message: TelegramMessage = {
		messageId: updateId,
		chatId: userId,
		chatType: "private",
		fromUserId: userId,
		fromIsBot: false,
		username: null,
		firstName,
		text,
		dateUnix: null,
	};
	const r = admitTelegramUpdate(deps(db), { updateId: updateId++, message });
	assert.ok(r.outcome === "admitted");
	return r;
}

const call = (args: object) => `[[call:reminder_create|${JSON.stringify(args)}]]`;
const commitments = (db: Db) =>
	db.prepare("SELECT * FROM commitments ORDER BY created_at, rowid").all() as Commitment[];

describe("reminders end to end", () => {
	const fake = new FakeTelegram();
	let sb: Sandbox;
	let s: Stack | null = null;
	before(() => fake.start());
	after(() => fake.stop());
	afterEach(async () => {
		await s?.stop();
		s = null;
		sb?.cleanup();
	});
	const answered = async (eventId: string) => {
		s!.scheduler.wake();
		await waitFor(() => getEvent(s!.db, eventId)!.status === "answered", 10_000);
	};
	const stack = (dbPath?: string) =>
		startStack(
			sb,
			{},
			{
				telegramApiBase: fake.apiBase,
				dbPath,
				toolkits: (db) => [remindersToolkit({ db })],
				turnNotes: (db) => (scope) => recentReminderNote(db, scope, new Date()),
			},
		);
	const lastRequest = () =>
		readFileSync(join(sb.stateDir, "fake-router-requests.jsonl"), "utf8").trim().split("\n").at(-1)!;

	test("#4: a contact's reminder made on Telegram survives a restart, is sent to that exact chat when due, and is fulfilled only by its receipt", async () => {
		sb = sandbox();
		const dbPath = join(sb.dir, "iyye.db");
		s = await stack(dbPath);
		const julia = fromTelegram(
			s.db,
			7101,
			"Julia",
			`remind me in 2 hours to call mom ${call({ text: "call mom", when: "in 2 hours" })}`,
		);
		await answered(julia.eventId);
		assert.match(
			fake.messagesTo(7101).at(-1)!,
			/^tool result: Reminder [0-9a-f]{8} set for .* \d\d:\d\d, once \(it does not repeat\)/,
		);
		let [c] = commitments(s.db);
		assert.deepEqual(
			[c!.state, c!.scope, c!.recipient_contact_id, JSON.parse(c!.route_json), c!.text, c!.created_event_id],
			[
				"scheduled",
				`contact:${julia.contactId}`,
				julia.contactId,
				{ channel: "telegram", chatId: 7101 },
				"call mom",
				julia.eventId,
			],
		);
		await s.stop();

		s = await stack(dbPath); // a restart before it is due
		const due = new Date(Date.parse(c!.due_at) + 30_000);
		const clock = new CommitmentClock({
			db: s.db,
			outbox: s.outbox,
			mode: () => "awake",
			log: silentLogger,
			now: () => due,
		});
		const before = fake.messagesTo(7101).length;
		await clock.tick();
		await waitFor(() => fake.messagesTo(7101).length === before + 1);
		assert.equal(fake.messagesTo(7101).at(-1), "⏰ call mom");
		await waitFor(() => commitments(s!.db)[0]!.state === "fulfilled");
		c = commitments(s.db)[0];
		const action = s.db
			.prepare("SELECT kind, state, route_json, commitment_id FROM actions WHERE id = ?")
			.get(c!.action_id) as Record<string, unknown>;
		assert.deepEqual(action, {
			kind: "status",
			state: "delivered",
			route_json: JSON.stringify({ channel: "telegram", chatId: 7101 }),
			commitment_id: c!.id,
		});
		await clock.tick();
		assert.equal(fake.messagesTo(7101).length, before + 1, "sent once");
		// Owner choice (option 1): the next turn in that chat knows the reminder was sent, request-locally.
		const thanks = fromTelegram(s.db, 7101, "Julia", "done, thanks!");
		await answered(thanks.eventId);
		assert.match(
			lastRequest(),
			/<reminders>.*Reminders you sent to this person on your own.*\d\d:\d\d \(Telegram\): \\"call mom\\"/,
		);
		const transcript = readFileSync(s.conversations.sessionFile(`contact:${julia.contactId}`)!, "utf8");
		assert.ok(!transcript.includes("<reminders>"), "never stored in the transcript");
	});

	test("an owner-linked Telegram account's reminder goes to that Telegram chat, in the owner's scope", async () => {
		sb = sandbox();
		s = await stack();
		const me = fromTelegram(s.db, 7201, "Alex", "hello");
		await answered(me.eventId);
		linkAccount(s.db, me.contactId, OWNER_CONTACT_ID, "owner_web", new Date().toISOString());
		const r = fromTelegram(
			s.db,
			7201,
			"Alex",
			`remind me tomorrow ${call({ text: "dentist", when: "tomorrow 09:00" })}`,
		);
		await answered(r.eventId);
		const [c] = commitments(s.db);
		assert.deepEqual(
			[c!.scope, c!.recipient_contact_id, JSON.parse(c!.route_json)],
			["owner", OWNER_CONTACT_ID, { channel: "telegram", chatId: 7201 }],
		);
	});

	test("#5: an unrelated later message, a failed send and a cross-channel fallback never fulfil a reminder", async () => {
		sb = sandbox();
		s = await stack();
		const bob = fromTelegram(
			s.db,
			7301,
			"Bob",
			`remind me in 1 hour ${call({ text: "stretch", when: "in 1 hour" })}`,
		);
		await answered(bob.eventId);
		const [c] = commitments(s.db);
		// An ordinary reply to Bob later is not the reminder.
		const later = fromTelegram(s.db, 7301, "Bob", "I stretched, did you remind me?");
		await answered(later.eventId);
		assert.equal(commitments(s.db)[0]!.state, "scheduled");
		// The chat is gone: a definite failure. Failed for good, one notice to the owner, nothing on the web chat as a fallback.
		fake.script(7301, "403");
		const clock = new CommitmentClock({
			db: s.db,
			outbox: s.outbox,
			mode: () => "awake",
			log: silentLogger,
			now: () => new Date(Date.parse(c!.due_at) + 1000),
		});
		await clock.tick();
		await waitFor(() => commitments(s!.db)[0]!.state === "failed");
		assert.match(commitments(s.db)[0]!.reason!, /blocked/);
		await waitFor(() =>
			(s!.db.prepare("SELECT text FROM web_feed").all() as { text: string }[]).some((r) =>
				/^"Bob"'s reminder "stretch" \(to their Telegram chat\) could not be delivered: .*blocked/.test(r.text),
			),
		);
		const web = (s.db.prepare("SELECT text FROM web_feed").all() as { text: string }[]).map((r) => r.text);
		assert.ok(!web.some((t) => t === "⏰ stretch"), "no fallback to another channel");
	});

	test("#8: a contact sees and cancels only their own reminders; a Telegram '/cancel' is dialogue; the cap holds", async () => {
		sb = sandbox();
		s = await stack();
		const julia = fromTelegram(
			s.db,
			7401,
			"Julia",
			`remind me ${call({ text: "julia's thing", when: "in 3 hours" })}`,
		);
		await answered(julia.eventId);
		const julias = commitments(s.db)[0]!;
		const toolkit = remindersToolkit({ db: s.db, contactMax: 2 });
		const bob = fromTelegram(s.db, 7402, "Bob", "hi");
		await answered(bob.eventId);
		const bobCtx = {
			scope: `contact:${bob.contactId}`,
			principal: "contact" as const,
			turn: {
				route: { channel: "telegram" as const, chatId: 7402 },
				contactId: bob.contactId,
				eventId: bob.eventId,
			},
		};
		const tool = (name: string) => toolkit.tools.find((t) => t.name === name)!;
		assert.equal(
			await tool("reminder_list").run({}, bobCtx, undefined),
			"No reminders are set.",
			"Bob does not see Julia's",
		);
		assert.match(
			await tool("reminder_cancel").run({ id: julias.id.slice(0, 8) }, bobCtx, undefined),
			/No coming reminder/,
		);
		assert.equal(commitments(s.db)[0]!.state, "scheduled");
		// Telegram text that looks like a command is dialogue.
		const attempt = fromTelegram(s.db, 7402, "Bob", `/cancel ${julias.id.slice(0, 8)}`);
		await answered(attempt.eventId);
		assert.equal(commitments(s.db)[0]!.state, "scheduled");
		// The route is the turn's: the tool has no parameter that could name another chat.
		assert.deepEqual(Object.keys((tool("reminder_create").parameters as { properties: object }).properties).sort(), [
			"recurrence",
			"text",
			"when",
		]);
		for (const n of [1, 2])
			await tool("reminder_create").run({ text: `b${n}`, when: `in ${n} hours` }, bobCtx, undefined);
		assert.match(
			await tool("reminder_create").run({ text: "b3", when: "in 3 hours" }, bobCtx, undefined),
			/already has 2 open reminders/,
		);
		// Iyye's background work never gets the toolkit; outside a turn it refuses.
		const broker = new ToolBroker({ db: s.db, log: silentLogger, toolkits: [toolkit] });
		assert.deepEqual(broker.forSession({ scope: "iyye:bg:x", principal: "iyye" }).names, []);
		assert.equal(broker.forSession({ scope: "contact:x", principal: "contact" }).names.length, 3);
		assert.match(
			await tool("reminder_create").run(
				{ text: "x", when: "in 1 hour" },
				{ scope: "owner", principal: "owner" },
				undefined,
			),
			/only be set in a conversation/,
		);
	});
});

describe("C2: the ledger labels Kev's reply review", () => {
	const fake = new FakeTelegram();
	const kev = new FakeKev();
	let sb: Sandbox;
	let s: Stack | null = null;
	before(async () => {
		await fake.start();
		await kev.start();
	});
	after(async () => {
		await fake.stop();
		await kev.stop();
	});
	afterEach(async () => {
		await s?.stop();
		s = null;
		sb?.cleanup();
	});

	test("a claim from a turn that made a reminder is supported, one without is unsupported; an owner label is never replaced", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { telegramApiBase: fake.apiBase, toolkits: (db) => [remindersToolkit({ db })] });
		setKv(s.db, "decisions.reply_review.since", "2000-01-01T00:00:00.000Z", "t");
		const answered = async (eventId: string) => {
			s!.scheduler.wake();
			await waitFor(() => getEvent(s!.db, eventId)!.status === "answered", 10_000);
		};
		const made = fromTelegram(s.db, 7501, "Julia", `remind me at noon ${call({ text: "lunch", when: "noon" })}`);
		await answered(made.eventId);
		const claimed = fromTelegram(s.db, 7501, "Julia", "and remind me about the meeting too, ok?");
		await answered(claimed.eventId);

		kev.answer = () => 0.9; // Kev says both replies claim something is set up
		const client = new DecisionClient({ db: s.db, service: kev.service });
		const review = new ReplyReviewShadow({
			db: s.db,
			client,
			device: new DeviceSlot(),
			chatPending: () => false,
			log: silentLogger,
		});
		assert.equal(await review.drainOnce(), 2);
		const rows = s.db
			.prepare(
				"SELECT d.id, a.event_id, d.outcome_json, d.outcome_source, d.schema_version FROM decisions d JOIN actions a ON a.id = d.subject_ref WHERE d.role = 'reply_review'",
			)
			.all() as {
			id: string;
			event_id: string;
			outcome_json: string;
			outcome_source: string;
			schema_version: number;
		}[];
		const byEvent = new Map(rows.map((r) => [r.event_id, r]));
		assert.deepEqual(JSON.parse(byEvent.get(made.eventId)!.outcome_json).commitment_created, true);
		assert.deepEqual(JSON.parse(byEvent.get(claimed.eventId)!.outcome_json), {
			commitment_created: false,
			commitments: [],
		});
		assert.ok(rows.every((r) => r.outcome_source === "commitments_ledger" && r.schema_version === 2));

		const report = decisionsReport(s.db, { state: "up", detail: "kev" });
		assert.match(report, /claims something is set up: 2 yes/);
		assert.match(report, /of the yes: 1 with a reminder made in that turn · 1 WITHOUT one \(unsupported\)/);
		const unsupported = byEvent.get(claimed.eventId)!.id;
		assert.match(report, new RegExp(`    ${unsupported.slice(0, 8)} p=0\\.90: `));

		assert.match(
			labelDecision(s.db, unsupported.slice(0, 8), "no", "owner_web", "t"),
			/did not claim anything was set up/,
		);
		assert.equal(
			client.recordOutcome(unsupported, { commitment_created: false }, "commitments_ledger", "weak"),
			false,
		);
		assert.deepEqual(
			s.db.prepare("SELECT outcome_json, label_strength FROM decisions WHERE id = ?").get(unsupported),
			{ outcome_json: '{"claims_arranged":false}', label_strength: "owner" },
		);
		assert.match(decisionsReport(s.db, { state: "up", detail: "kev" }), /your labels: 1, Kev agrees on 0/);
	});
});

test("labelling a reply review from before schema 2 answers the question it was asked", () => {
	const db = openDb(":memory:");
	db.prepare(
		"INSERT INTO decisions (id, role, schema_version, mode, state_json, state_hash, questions_json, status, created_at, verdicts_json) VALUES ('0001abcd', 'reply_review', 1, 'shadow', '{}', 'h', '[]', 'ok', 't', '{\"promises_future_action\":\"yes\"}')",
	).run();
	assert.match(labelDecision(db, "0001abcd", "yes", "owner_web", "t"), /the reply promised a future action/);
	assert.equal(
		(db.prepare("SELECT outcome_json FROM decisions").get() as { outcome_json: string }).outcome_json,
		'{"promises_future_action":true}',
	);
	assert.match(
		decisionsReport(db, { state: "up", detail: "kev" }),
		/\(and 1 earlier schema-1 review\(s\), not pooled\)/,
	);
	db.close();
});

describe("C3: the owner's view", () => {
	let sb: Sandbox;
	let s: Stack | null = null;
	afterEach(async () => {
		await s?.stop();
		s = null;
		sb?.cleanup();
	});

	test("the chip counts today's reminders, red when one failed or is unconfirmed; /commitments shows the evidence; the day summary counts them by person", async () => {
		sb = sandbox();
		const now = new Date();
		now.setHours(12, 0, 0, 0); // noon: "later today" never runs past midnight
		s = await startStack(sb, {}, { remindersStatus: (db) => () => remindersChip(remindersToday(db, now)) });
		const db = s.db;
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')",
		).run();
		const status = async () => {
			const auth = await loginAs(s!.port);
			return (await http(s!.port, "GET", "/api/status", { cookie: auth.cookie })).body as { reminders: string };
		};
		assert.equal((await status()).reminders, "", "nothing today: no chip");
		const add = (id: string, who: string, due: Date, state = "scheduled") => {
			insertCommitment(db, {
				id,
				scope: who === "owner" ? "owner" : `contact:${who}`,
				recipient_contact_id: who,
				route_json: JSON.stringify(
					who === "owner" ? { channel: "web", contact: "owner" } : { channel: "telegram", chatId: 1 },
				),
				text: `secret words ${id}`,
				due_at: due.toISOString(),
				timezone: "x",
				recurrence: "none",
				series_id: id,
				created_by: "t",
				created_event_id: null,
				created_at: "t",
			});
			if (state !== "scheduled")
				db.prepare("UPDATE commitments SET state = ?, settled_at = ? WHERE id = ?").run(
					state,
					state === "unknown" ? null : now.toISOString(),
					id,
				);
		};
		const later = new Date(now.getTime() + 60 * 60_000);
		add("aaaaaa01", "owner", later);
		add("aaaaaa02", "owner", now, "fulfilled");
		add("aaaaaa03", "c1", now, "fulfilled");
		add("aaaaaa04", "c1", now, "failed");
		assert.match((await status()).reminders, /^1 due later today · 2 delivered · 1 failed$/);
		add("aaaaaa05", "c1", now, "unknown");
		assert.match((await status()).reminders, /1 unconfirmed/);

		// The evidence behind a state: the action and its receipt.
		const outbox = new Outbox({ db, log: silentLogger, adapters: [new WebChatAdapter({ db, log: silentLogger })] });
		const sent = await outbox.sendOwn({
			key: "reminder:aaaaaa01",
			route: { channel: "web", contact: "owner" },
			content: "⏰ x",
			commitmentId: "aaaaaa01",
		});
		const all = new ReminderCommands({ db }).all();
		assert.match(
			all,
			new RegExp(
				`aaaaaa01 .* · for you on the web chat · fulfilled · action ${sent.id.slice(0, 8)} delivered, receipt ui_enqueued at \\d\\d:\\d\\d`,
			),
		);

		const digest = buildDigest(db, {
			day: 7,
			from: new Date(now.getTime() - 86_400_000).toISOString(),
			to: new Date(now.getTime() + 86_400_000).toISOString(),
			outcome: null,
		});
		assert.match(
			digest,
			/Reminders: delivered 2 to the owner, 1 to Julia; could not be delivered 1 to Julia; may not have arrived 1 to Julia\./,
		);
		assert.ok(!digest.includes("secret words"), "never the reminder's text");
	});
});

describe("the commitment clock", () => {
	function rig() {
		const db = openDb(":memory:");
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')",
		).run();
		const fake = {
			sent: [] as { key: string; route: unknown; content: string; commitmentId?: string }[],
			notices: [] as string[],
		};
		const outbox = {
			sendOwn: async (req: { key: string; route: unknown; content: string; commitmentId?: string }) => {
				fake.sent.push(req);
				db.prepare("UPDATE commitments SET state = 'due' WHERE id = ?").run(req.commitmentId);
			},
			notifyOwner: async (req: { content: string }) => {
				fake.notices.push(req.content);
			},
		};
		const add = (due: Date, recurrence: "none" | "daily" | "weekly" = "none") => {
			const id = crypto.randomUUID();
			insertCommitment(db, {
				id,
				scope: "contact:c1",
				recipient_contact_id: "c1",
				route_json: JSON.stringify({ channel: "telegram", chatId: 1 }),
				text: "water the plants",
				due_at: due.toISOString(),
				timezone: "Europe/Berlin",
				recurrence,
				series_id: id,
				created_by: "test",
				created_event_id: null,
				created_at: "t",
			});
			return id;
		};
		return { db, fake, outbox, add };
	}

	test("asleep nothing is sent; at waking it goes out saying when it was due (owner decision 3, #11)", async () => {
		const { db, fake, outbox, add } = rig();
		add(new Date(2026, 9, 5, 3, 0));
		let mode: "awake" | "asleep" = "asleep";
		let now = new Date(2026, 9, 5, 3, 1);
		const clock = new CommitmentClock({ db, outbox, mode: () => mode, log: silentLogger, now: () => now });
		await clock.tick();
		assert.equal(fake.sent.length, 0, "nothing while asleep");
		mode = "awake";
		now = new Date(2026, 9, 5, 6, 30);
		await clock.tick();
		assert.equal(fake.sent[0]!.content, "⏰ water the plants (due at 03:00)");
	});

	test("on time it has no note; over 6 h late it says late; over 7 days it fails and the owner is told", async () => {
		const { db, fake, outbox, add } = rig();
		add(new Date(2026, 9, 5, 9, 0));
		const late = add(new Date(2026, 9, 4, 9, 0));
		const lost = add(new Date(2026, 8, 20, 9, 0));
		const clock = new CommitmentClock({
			db,
			outbox,
			mode: () => "awake",
			log: silentLogger,
			now: () => new Date(2026, 9, 5, 9, 0, 30),
		});
		await clock.tick();
		assert.deepEqual(
			fake.sent.map((s) => s.content).sort(),
			["⏰ water the plants", "⏰ water the plants (late: due at Sunday, 4 October 2026 09:00)"].sort(),
		);
		assert.equal(fake.sent.find((s) => s.commitmentId === late)!.content.includes("late"), true);
		assert.equal(
			(db.prepare("SELECT state, reason FROM commitments WHERE id = ?").get(lost) as { state: string }).state,
			"failed",
		);
		assert.match(
			fake.notices[0]!,
			/^"Julia"'s reminder "water the plants" \(to their Telegram chat\), due .*, was missed: Iyye was not running for more than 7 days\./,
		);
	});

	test("a repeating reminder creates its next occurrence once, skipping ones missed; cancelling stops the series", async () => {
		const { db, fake, outbox, add } = rig();
		const first = add(new Date(2026, 9, 1, 8, 0), "daily");
		const clock = new CommitmentClock({
			db,
			outbox,
			mode: () => "awake",
			log: silentLogger,
			now: () => new Date(2026, 9, 4, 8, 0, 10),
		});
		await clock.tick();
		const rows = db.prepare("SELECT due_at, state, series_id FROM commitments ORDER BY due_at").all() as {
			due_at: string;
			state: string;
			series_id: string;
		}[];
		assert.deepEqual(
			rows.map((r) => [new Date(r.due_at).toString().slice(0, 21), r.state, r.series_id === first]),
			[
				["Thu Oct 01 2026 08:00", "due", true],
				["Mon Oct 05 2026 08:00", "scheduled", true],
			],
			"the missed 2nd–4th are skipped; the next is tomorrow",
		);
		assert.equal(fake.sent.length, 1);
		const cmds = new ReminderCommands({ db, now: () => new Date(2026, 9, 4, 9, 0) });
		const next = (db.prepare("SELECT id FROM commitments WHERE state = 'scheduled'").get() as { id: string }).id;
		assert.match(cmds.cancel(next.slice(0, 8), "owner_web"), /cancelled: water the plants/);
		assert.equal(
			(db.prepare("SELECT count(*) AS n FROM commitments WHERE state = 'scheduled'").get() as { n: number }).n,
			0,
		);
	});
});

test("#6: a crash after the provider accepted, before the receipt: the reminder is unknown, never sent again; the owner resolves it", async () => {
	const fake = new FakeTelegram();
	await fake.start();
	const db = openDb(":memory:");
	try {
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')",
		).run();
		insertCommitment(db, {
			id: "rem-1",
			scope: "contact:c1",
			recipient_contact_id: "c1",
			route_json: JSON.stringify({ channel: "telegram", chatId: 9001 }),
			text: "the call",
			due_at: new Date(Date.now() - 1000).toISOString(),
			timezone: "Europe/Berlin",
			recurrence: "none",
			series_id: "rem-1",
			created_by: "test",
			created_event_id: null,
			created_at: "t",
		});
		const adapters = [
			new WebChatAdapter({ db, log: silentLogger }),
			new TelegramSender({ token: "1:fake", log: silentLogger, apiBase: fake.apiBase }),
		];
		const crashing = new Outbox({
			db,
			log: silentLogger,
			adapters,
			hooks: {
				afterAdapter: () => {
					throw new Error("crash");
				},
			},
		});
		await new CommitmentClock({ db, outbox: crashing, mode: () => "awake", log: silentLogger })
			.tick()
			.catch(() => undefined);
		assert.equal(fake.messagesTo(9001).length, 1, "the provider accepted it");
		// Restart: recovery cannot prove delivery on Telegram, so the action and the reminder are unknown.
		const outbox = new Outbox({ db, log: silentLogger, adapters });
		await recover(db, outbox, { fail: async () => {} }, silentLogger);
		const c = () =>
			db.prepare("SELECT state, action_id FROM commitments WHERE id = 'rem-1'").get() as {
				state: string;
				action_id: string;
			};
		assert.equal(c().state, "unknown");
		await new CommitmentClock({ db, outbox, mode: () => "awake", log: silentLogger }).tick();
		assert.equal(fake.messagesTo(9001).length, 1, "never sent again blindly");
		await outbox.resolve(c().action_id, "delivered", "owner_web");
		assert.equal(c().state, "fulfilled");
	} finally {
		db.close();
		await fake.stop();
	}
});

test("owner commands: /remind, /reminders, /commitments, /cancel; a reminder inside the rest window says it arrives at waking", async () => {
	const db = openDb(":memory:");
	const now = new Date(2026, 9, 4, 14, 0);
	const cmds = new ReminderCommands({ db, now: () => now });
	const ctx = { models: {} as never, db, issuer: "owner_web", commitments: cmds };
	const cmd = async (t: string) => (await handleOwnerCommand(t, ctx)).reply;
	assert.match(
		await cmd("/remind tomorrow 9:00 call Julia"),
		/^Reminder [0-9a-f]{8} set for Monday, 5 October 2026 09:00 \(.+\), to this chat: call Julia$/,
	);
	assert.match(await cmd("/remind in 2 hours check the oven"), /Sunday, 4 October 2026 16:00 .*check the oven/);
	assert.match(await cmd("/remind sometime soon"), /^usage: \/remind <when> <text>/);
	assert.match(
		await cmd("/reminders"),
		/your reminders:\n {2}[0-9a-f]{8} Sunday, 4 October 2026 16:00 — check the oven\n {2}[0-9a-f]{8} Monday, 5 October 2026 09:00 — call Julia/,
	);
	assert.match(await cmd("/commitments"), /for you on the web chat · scheduled/);
	const id = (db.prepare("SELECT id FROM commitments WHERE text = 'call Julia'").get() as { id: string }).id;
	assert.match(await cmd(`/cancel ${id.slice(0, 8)}`), /cancelled: call Julia/);
	assert.match(await cmd("/cancel xyz"), /usage: \/cancel/);

	const toolkit = remindersToolkit({ db, now: () => now, restWindow: parseWindow("02:00-06:00") });
	const owner = {
		scope: "owner",
		principal: "owner" as const,
		turn: { route: { channel: "web" as const, contact: "owner" as const }, contactId: "owner", eventId: null },
	};
	const create = toolkit.tools.find((t) => t.name === "reminder_create")!;
	assert.match(
		await create.run({ text: "x", when: "tomorrow 03:00" }, owner, undefined),
		/Iyye rests at that time, so it will arrive when Iyye wakes up\./,
	);
	assert.match(
		await create.run({ text: "x", when: "yesterday" }, owner, undefined),
		/Not set: .*Ask the person what they meant; do not choose another time yourself\./,
	);
	db.close();
});

test("/forget waits for a reminder still on its way, then redacts delivered reminders and the owner's notices about them", async () => {
	const db = openDb(":memory:");
	db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')").run();
	const add = (id: string) =>
		insertCommitment(db, {
			id,
			scope: "contact:c1",
			recipient_contact_id: "c1",
			route_json: JSON.stringify({ channel: "telegram", chatId: 5 }),
			text: `secret ${id}`,
			due_at: new Date(Date.now() - 1000).toISOString(),
			timezone: "x",
			recurrence: "none",
			series_id: id,
			created_by: "t",
			created_event_id: null,
			created_at: "t",
		});
	add("delivered");
	add("retrying");
	const outbox = new Outbox({
		db,
		log: silentLogger,
		adapters: [new WebChatAdapter({ db, log: silentLogger })],
		held: () => true,
	});
	await outbox.sendOwn({
		key: "reminder:delivered",
		route: { channel: "telegram", chatId: 5 },
		content: "⏰ secret delivered",
		commitmentId: "delivered",
	});
	await outbox.sendOwn({
		key: "reminder:retrying",
		route: { channel: "telegram", chatId: 5 },
		content: "⏰ secret retrying",
		commitmentId: "retrying",
	});
	db.prepare("UPDATE actions SET state = 'delivered' WHERE commitment_id = 'delivered'").run();
	db.prepare("UPDATE actions SET state = 'failed', next_attempt_at = 'x' WHERE commitment_id = 'retrying'").run();
	await outbox.notifyOwner({
		key: "commitment-failed:delivered",
		content: '"Julia"\'s reminder "secret delivered" could not be delivered',
	});
	const t = forgetTarget(db, getContact(db, "c1")!);
	assert.ok(typeof t !== "string");
	assert.equal(forgetBusy(db, t.scopes), "1 reminder(s) to them are still being delivered");
	db.prepare("UPDATE actions SET state = 'terminal_failure' WHERE commitment_id = 'retrying'").run();
	assert.equal(forgetBusy(db, t.scopes), null);
	forgetRecords(db, t, "owner_web", new Date().toISOString());
	const all = JSON.stringify([
		db.prepare("SELECT content FROM actions").all(),
		db.prepare("SELECT text FROM commitments").all(),
	]);
	assert.ok(!all.includes("secret"), all);
	db.close();
});

test("/forget cancels a person's reminders and removes their words", () => {
	const db = openDb(":memory:");
	db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')").run();
	insertCommitment(db, {
		id: "r1",
		scope: "contact:c1",
		recipient_contact_id: "c1",
		route_json: "{}",
		text: "my secret plan",
		due_at: new Date(Date.now() + 3_600_000).toISOString(),
		timezone: "x",
		recurrence: "none",
		series_id: "r1",
		created_by: "t",
		created_event_id: null,
		created_at: "t",
	});
	const t = forgetTarget(db, getContact(db, "c1")!);
	assert.ok(typeof t !== "string");
	forgetRecords(db, t, "owner_web", new Date().toISOString());
	assert.deepEqual(db.prepare("SELECT state, text FROM commitments").get(), {
		state: "cancelled",
		text: "[forgotten]",
	});
	db.close();
});

// The owner web route's own reply, for completeness of #5: a reply action never carries a commitment.
test("a reply action never carries a commitment", async () => {
	const db = openDb(":memory:");
	const r = admitOwnerWebMessage(deps(db), { clientMsgId: "c-1", text: "hi" });
	assert.ok(r.outcome === "admitted");
	assert.equal(
		(db.prepare("SELECT count(*) AS n FROM actions WHERE commitment_id IS NOT NULL").get() as { n: number }).n,
		0,
	);
	db.close();
});
