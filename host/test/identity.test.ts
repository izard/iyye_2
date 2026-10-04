// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Plan 0.005 I1: identity links, end to end through admission, the scheduler, Pi, memory and the outbox. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import type { TelegramMessage } from "../src/channels/types.ts";
import { admitOwnerWebMessage, admitTelegramUpdate } from "../src/kernel/admission.ts";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { silentLogger } from "../src/log.ts";
import { MemoryGateway } from "../src/memory/gateway.ts";
import { accountsOf, getContact, linkAccount, OWNER_CONTACT_ID, resolvePerson } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { FakeTelegram } from "./fixtures/fake-telegram.ts";
import { type Sandbox, sandbox, waitFor } from "./model-helpers.ts";
import { type Stack, startStack } from "./web-helpers.ts";

let updateId = 5000;
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

describe("identity links", () => {
	const fake = new FakeTelegram();
	let sb: Sandbox;
	let s: Stack | null = null;
	const requestsFile = () => join(sb.stateDir, "fake-router-requests.jsonl");
	const lastRequest = () =>
		JSON.stringify(
			readFileSync(requestsFile(), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l))
				.at(-1),
		);
	const answered = async (eventId: string) => {
		s!.scheduler.wake();
		await waitFor(() => getEvent(s!.db, eventId)!.status === "answered", 10_000);
	};
	const cmd = async (text: string) =>
		(await handleOwnerCommand(text, { models: s!.models, db: s!.db, issuer: "owner_web" })).reply;

	before(() => fake.start());
	after(() => fake.stop());
	afterEach(async () => {
		await s?.stop();
		s = null;
		sb?.cleanup();
	});

	test("a Telegram account linked to the owner IS the owner: owner scope and view, shared memory, reply on its own chat", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { telegramApiBase: fake.apiBase, memory: { ltm: null } });
		const first = fromTelegram(s.db, 6001, "Alex", "Note: my son Jacob is 12 years old");
		await answered(first.eventId);
		assert.equal(
			getEvent(s.db, first.eventId)!.scope,
			`contact:${first.contactId}`,
			"before the link: an ordinary contact",
		);

		assert.match(await cmd(`/link ${first.contactId.slice(0, 8)} owner`), /is now linked to you, the owner/);
		const second = fromTelegram(s.db, 6001, "Alex", "How old is Jacob?");
		const ev = getEvent(s.db, second.eventId)!;
		assert.equal(ev.scope, "owner");
		assert.equal(ev.principal_contact_id, OWNER_CONTACT_ID);
		await answered(second.eventId);
		const req = lastRequest();
		assert.match(
			req,
			/You are talking with your owner, through the local web chat or one of their own Telegram accounts/,
		);
		assert.match(
			req,
			/\[today[^\]]*from your own account \\"Alex\\"\] Owner said: Note: my son Jacob is 12 years old/,
			"earlier memory of the account, as the owner's",
		);
		assert.deepEqual(
			fake.messagesTo(6001).at(-1),
			"echo: How old is Jacob?",
			"the reply goes to the Telegram chat that wrote",
		);

		// One conversation for the owner across channels: the web chat sees the Telegram turn.
		const web = admitOwnerWebMessage(deps(s.db), { clientMsgId: "id-web-1", text: "what did I ask? [[history]]" });
		assert.ok(web.outcome === "admitted");
		await answered(web.eventId);
		const reply = s.db
			.prepare("SELECT text FROM web_feed WHERE event_id = ? AND kind = 'reply'")
			.get(web.eventId) as { text: string };
		assert.match(reply.text, /How old is Jacob\? \| what did I ask\?/);

		// Commands from Telegram stay dialogue, even from an owner-linked account.
		const before = JSON.stringify(s.db.prepare("SELECT * FROM contact_links").all());
		const julia = fromTelegram(s.db, 6002, "Julia", "hi");
		await answered(julia.eventId);
		const attempt = fromTelegram(s.db, 6001, "Alex", `/trust ${julia.contactId} and /link ${julia.contactId} owner`);
		await answered(attempt.eventId);
		assert.equal(getContact(s.db, julia.contactId)!.trusted, 0);
		assert.equal(JSON.stringify(s.db.prepare("SELECT * FROM contact_links").all()), before);
	});

	test("an account linked to a person speaks as that person, with their trust; replies stay on the account; others stay isolated", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { telegramApiBase: fake.apiBase, memory: { ltm: null } });
		const j1 = fromTelegram(s.db, 7001, "Julia", "I prefer short reminders");
		const j2 = fromTelegram(s.db, 7002, "Julia2", "My cat is called Murka");
		const alex = fromTelegram(s.db, 7003, "Alex", "my bank PIN is 4711");
		for (const r of [j1, j2, alex]) await answered(r.eventId);
		assert.match(await cmd("/trust Julia"), /Julia is now trusted/);

		const reply = await cmd(`/link ${j2.contactId.slice(0, 8)} ${j1.contactId.slice(0, 8)}`);
		assert.match(
			reply,
			/is now an account of Julia .*Trust follows the person: this account is now TRUSTED \(it was not trusted\)/,
		);
		const next = fromTelegram(s.db, 7002, "Julia2", "What is my cat called, and what do I prefer?");
		assert.equal(getEvent(s.db, next.eventId)!.scope, `contact:${j1.contactId}`);
		await answered(next.eventId);
		const req = lastRequest();
		assert.match(req, /Telegram contact whose display name is \\"Julia\\"/);
		assert.match(req, /marked them as trusted/);
		assert.match(req, /My cat is called Murka/, "the account's earlier STM is the person's");
		assert.match(req, /I prefer short reminders/);
		assert.ok(!req.includes("4711"), "nothing of Alex's");
		assert.equal(fake.messagesTo(7002).at(-1), "echo: What is my cat called, and what do I prefer?");

		// Alex's recall never reaches Julia's accounts (§15 #3).
		const gw = new MemoryGateway({ db: s.db, ltm: null, log: silentLogger });
		const asAlex = await gw.recall(
			{ scope: `contact:${alex.contactId}`, principal: "contact" },
			"cat Murka reminders",
		);
		assert.deepEqual(asAlex.items, []);
		// /trust on the account points at the person; unlink restores the account's own scope.
		assert.match(
			await cmd(`/untrust ${j2.contactId.slice(0, 8)}`),
			/is an account of Julia; trust is per person: use \/untrust on Julia/,
		);
		assert.match(
			await cmd(`/unlink ${j2.contactId.slice(0, 8)}`),
			/is its own contact again.*What it said while linked stays with Julia/,
		);
		const after = fromTelegram(s.db, 7002, "Julia2", "hello again");
		assert.equal(getEvent(s.db, after.eventId)!.scope, `contact:${j2.contactId}`);
	});

	test("ambiguous names, chains and self-links change nothing; /contacts groups accounts and hints at same names", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { telegramApiBase: fake.apiBase });
		const a1 = fromTelegram(s.db, 8001, "Alex", "one");
		const a2 = fromTelegram(s.db, 8002, "Alex", "two");
		const b = fromTelegram(s.db, 8003, "Bob", "three");
		for (const r of [a1, a2, b]) await answered(r.eventId);
		assert.match(await cmd("/link Alex owner"), /"Alex" matches 2 contacts; use an id/);
		assert.match(
			await cmd(`/contacts`),
			/same name as id [0-9a-f]{8}: if this is the same person, \/link one to the other/,
		);
		assert.match(
			await cmd(`/link ${a2.contactId.slice(0, 8)} ${a1.contactId.slice(0, 8)}`),
			/is now an account of Alex/,
		);
		assert.match(
			await cmd(`/link ${b.contactId.slice(0, 8)} ${a2.contactId.slice(0, 8)}`),
			/refused: the target is itself a linked account/,
		);
		assert.match(
			await cmd(`/link ${a1.contactId.slice(0, 8)} owner`),
			/refused: this contact has linked accounts of its own/,
		);
		assert.match(
			await cmd(`/link ${b.contactId.slice(0, 8)} ${b.contactId.slice(0, 8)}`),
			/refused: an account cannot be linked to itself/,
		);
		assert.match(await cmd("/link nobody owner"), /no contact matches/);
		assert.deepEqual(
			accountsOf(s.db, a1.contactId).map((c) => c.id),
			[a2.contactId],
		);
		const contacts = await cmd("/contacts");
		assert.match(contacts, /^you \(owner\) — web chat$/m);
		assert.match(
			contacts,
			new RegExp(
				`^Alex — not trusted · telegram:8001 · id ${a1.contactId.slice(0, 8)}.*\\n {4}accounts: Alex \\(telegram:8002 · id ${a2.contactId.slice(0, 8)}`,
				"m",
			),
		);
		assert.doesNotMatch(contacts, /same name as/, "linked: no longer two separate Alexes");
	});
});

test("the resolver follows one link only", () => {
	const db = openDb(":memory:");
	const at = "t";
	for (const id of ["p", "a"]) {
		db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', ?)").run(
			id,
			id,
			at,
		);
	}
	linkAccount(db, "a", "p", "test", at);
	assert.equal(resolvePerson(db, getContact(db, "a")!).id, "p");
	assert.equal(resolvePerson(db, getContact(db, "p")!).id, "p");
	assert.throws(() => linkAccount(db, "owner", "p", "test", at), /the owner is a person, not an account/);
	db.close();
});
