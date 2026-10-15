// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.014: email from Iyye's own mailbox, for the owner and every trusted
 * contact, sent at once through the outbox, to a person's owner-stored
 * address or to an address written in the asking message. Against the fake
 * SMTP server only (never a real one).
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { EmailSender } from "../src/channels/email/sender.ts";
import { loadEmailSettings } from "../src/channels/email/settings.ts";
import { encodeHeader, type SmtpSettings, SmtpUncertain, sendMail } from "../src/channels/email/smtp.ts";
import { WebChatAdapter } from "../src/channels/web/adapter.ts";
import { commitmentsOfReply } from "../src/decisions/reply-review.ts";
import { ALWAYS_ON } from "../src/decisions/toolkit-selection.ts";
import { operatingNote } from "../src/integration/pi/prompt.ts";
import { buildDigest } from "../src/kernel/day-summary.ts";
import { silentLogger } from "../src/log.ts";
import { forgetBusy, forgetRecords, forgetTarget } from "../src/memory/forget.ts";
import { Outbox } from "../src/outbox/outbox.ts";
import { People } from "../src/people/people.ts";
import { getContact, OWNER_CONTACT_ID } from "../src/state/contacts.ts";
import { openDb } from "../src/state/db.ts";
import { addressesIn, emailOf, setEmail, validAddress } from "../src/state/emails.ts";
import { sentReport } from "../src/state/sent.ts";
import { ToolBroker, type ToolContext } from "../src/tools/broker.ts";
import { emailToolkit } from "../src/tools/email.ts";
import { FAKE_SMTP_CA, type FakeSmtp, startFakeSmtp } from "./fixtures/fake-smtp.ts";

const USER = "iyye@example.org";
const PASSWORD = "app-password-123";

function settings(port: number, over: Partial<SmtpSettings> = {}): SmtpSettings {
	return {
		host: "127.0.0.1",
		port,
		security: "tls",
		user: USER,
		password: PASSWORD,
		from: "iyye@example.org",
		fromName: "Iyye",
		ca: FAKE_SMTP_CA,
		timeoutMs: 2000,
		...over,
	};
}

const mail = (to: string, subject = "Hello", text = "Hi there.\n.\nA line with a dot.") => ({
	to,
	subject,
	text,
	messageId: "m1@example.org",
	date: new Date("2026-10-15T10:00:00Z"),
});

/** The decoded body of a received message. */
function body(data: string): string {
	const [, b64] = data.split("\r\n\r\n");
	return Buffer.from((b64 ?? "").replace(/\r\n/g, ""), "base64").toString("utf8");
}

describe("the SMTP client (plan 0.014)", () => {
	let tls: FakeSmtp;
	let starttls: FakeSmtp;
	before(async () => {
		tls = await startFakeSmtp({ security: "tls" });
		starttls = await startFakeSmtp({ security: "starttls", auth: "LOGIN" });
	});
	after(async () => {
		await tls.close();
		await starttls.close();
	});

	test("implicit TLS with AUTH PLAIN: accepted, and the message is well formed (UTF-8 subject, base64 body)", async () => {
		const r = await sendMail(settings(tls.port), mail("bob@example.com", "Привет, Боб — встреча в пятницу"));
		assert.equal(r.ok, true);
		const got = tls.received.at(-1)!;
		assert.deepEqual([got.from, got.to, got.authUser], ["iyye@example.org", "bob@example.com", USER]);
		assert.match(got.data, /^From: Iyye <iyye@example\.org>\r\nTo: <bob@example\.com>\r\nSubject: =\?UTF-8\?B\?/);
		assert.match(got.data, /Message-ID: <m1@example\.org>/);
		assert.equal(body(got.data), "Hi there.\r\n.\r\nA line with a dot.");
		const subject = /Subject: ((?:.|\r\n )*)\r\n/.exec(got.data)![1]!;
		const decoded = subject
			.split("\r\n ")
			.map((w) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)![1]!, "base64").toString("utf8"))
			.join("");
		assert.equal(decoded, "Привет, Боб — встреча в пятницу");
		assert.equal(encodeHeader("plain ascii"), "plain ascii");
	});

	test("STARTTLS with AUTH LOGIN: the login goes only over TLS", async () => {
		const r = await sendMail(settings(starttls.port, { security: "starttls" }), mail("carol@example.com"));
		assert.equal(r.ok, true);
		assert.equal(starttls.received.at(-1)!.to, "carol@example.com");
		const i = starttls.commands.indexOf("STARTTLS");
		const login = starttls.commands.indexOf("AUTH LOGIN");
		assert.ok(i >= 0 && login > i);
	});

	test("replies sent in the clear right after STARTTLS's 220 are never taken as the server's: refused, nothing sent", async () => {
		const evil = await startFakeSmtp({
			security: "starttls",
			injectAfterStarttls: "250 ok\r\n235 ok\r\n250 ok\r\n250 ok\r\n354 go\r\n250 queued\r\n",
		});
		try {
			const r = await sendMail(settings(evil.port, { security: "starttls" }), mail("bob@example.com"));
			assert.deepEqual(r, {
				ok: false,
				retryable: false,
				error: "the mail server sent data in the clear after STARTTLS (refused)",
			});
			assert.equal(evil.received.length, 0);
			assert.ok(!evil.commands.some((c) => c.startsWith("AUTH")));
		} finally {
			await evil.close();
		}
	});

	test("before the message is complete, every failure is a definite non-delivery; secrets never in errors", async () => {
		const bad = await sendMail(settings(tls.port, { password: "wrong-password" }), mail("bob@example.com"));
		assert.deepEqual(bad.ok ? null : [bad.retryable, bad.error], [false, "the mail server refused the login (535)"]);
		const reject = await sendMail(settings(tls.port), mail("reject-rcpt@example.com"));
		assert.ok(!reject.ok && !reject.retryable && /RCPT TO: 550/.test(reject.error));
		const temp = await sendMail(settings(tls.port), mail("temp-rcpt@example.com"));
		assert.ok(!temp.ok && temp.retryable && /451/.test(temp.error));
		const refusedAfter = await sendMail(settings(tls.port), mail("reject-data@example.com"));
		assert.ok(!refusedAfter.ok && !refusedAfter.retryable && /554/.test(refusedAfter.error));
		const unreachable = await sendMail(settings(1), mail("bob@example.com"));
		assert.ok(!unreachable.ok && unreachable.retryable);
		const wrongCa = await sendMail(settings(tls.port, { ca: undefined }), mail("bob@example.com"));
		assert.ok(!wrongCa.ok && wrongCa.retryable, "an unverified certificate is refused");
		const injected = await sendMail(settings(tls.port), mail("bob@example.com", "Hi\r\nBcc: eve@example.com"));
		assert.ok(!injected.ok && /line break/.test(injected.error));
		for (const r of [bad, reject, temp, unreachable])
			assert.ok(!r.ok && !r.error.includes(PASSWORD) && !r.error.includes("wrong-password"));
	});

	test("no answer after the message: the outcome is unknown (throws), dropped or hung", async () => {
		await assert.rejects(sendMail(settings(tls.port), mail("drop-data@example.com")), SmtpUncertain);
		await assert.rejects(
			sendMail(settings(tls.port, { timeoutMs: 300 }), mail("hang-data@example.com")),
			SmtpUncertain,
		);
	});
});

describe("addresses and settings", () => {
	test("one plain address; addresses as people write them", () => {
		assert.ok(validAddress("bob.smith+x@mail.example.co.uk"));
		for (const a of [
			"bob",
			"bob@localhost",
			"a b@example.com",
			"<bob@example.com>",
			"bob@example.com,eve@x.org",
			"a..b@example.com",
		])
			assert.ok(!validAddress(a), a);
		assert.deepEqual(addressesIn("Mail it to Bob@Example.com, and cc nobody. Or carol@example.org."), [
			"Bob@Example.com",
			"carol@example.org",
		]);
	});

	test("Iyye's mailbox: config and a 0600 password, else a reason", () => {
		const dir = mkdtempSync(join(tmpdir(), "iyye-email-"));
		assert.match(loadEmailSettings(dir) as string, /not configured/);
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({ host: "smtp.example.org", port: 465, security: "tls", user: USER, from: USER }),
		);
		assert.match(loadEmailSettings(dir) as string, /no .*password/);
		writeFileSync(join(dir, "password"), `${PASSWORD}\n`, { mode: 0o644 });
		chmodSync(join(dir, "password"), 0o644);
		assert.match(loadEmailSettings(dir) as string, /readable by others/);
		chmodSync(join(dir, "password"), 0o600);
		const s = loadEmailSettings(dir) as SmtpSettings;
		assert.deepEqual([s.host, s.password, s.fromName], ["smtp.example.org", PASSWORD, "Iyye"]);
		writeFileSync(join(dir, "config.json"), JSON.stringify({ host: "smtp.example.org", port: 465 }));
		assert.match(loadEmailSettings(dir) as string, /needs host, port/);
	});
});

describe("email_send (plan 0.014)", () => {
	let smtp: FakeSmtp;
	before(async () => {
		smtp = await startFakeSmtp({ security: "tls" });
	});
	after(() => smtp.close());

	let n = 0;
	const setup = (o: { maxPerDay?: number; contactMaxPerDay?: number } = {}) => {
		const db = openDb(":memory:");
		const add = (id: string, name: string, trusted: number, tg: number) => {
			db.prepare(
				"INSERT INTO contacts (id, display_name, kind, trusted, created_at) VALUES (?, ?, 'contact', ?, 't')",
			).run(id, name, trusted);
			db.prepare(
				"INSERT INTO channel_bindings (contact_id, channel, external_id, verified_by, created_at) VALUES (?, 'telegram', ?, 'first_contact', 't')",
			).run(id, String(tg));
		};
		add("julia-1", "Julia", 1, 9001);
		add("mark-1", "Mark", 0, 9002);
		add("bob-1", "Bob", 0, 9003);
		setEmail(db, "bob-1", "bob@example.com", "owner_web", "t");
		const outbox = new Outbox({
			db,
			log: silentLogger,
			adapters: [
				new WebChatAdapter({ db, log: silentLogger }),
				new EmailSender({ load: () => settings(smtp.port), log: silentLogger }),
			],
			backoffMs: [10],
			maxAttempts: 1,
		});
		const kit = emailToolkit({ db, outbox, ...o });
		const tool = kit.tools[0]!;
		const event = (channel: "web" | "telegram", contact: string, text: string) => {
			const id = `ev-${n++}`;
			const payload = channel === "web" ? { text } : { message: { text, chatId: 9001 } };
			db.prepare(
				"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'admitted')",
			).run(
				id,
				id,
				channel,
				contact,
				contact === OWNER_CONTACT_ID ? "owner" : `contact:${contact}`,
				new Date().toISOString(),
				JSON.stringify(payload),
			);
			return id;
		};
		const owner = (text: string): ToolContext => ({
			scope: "owner",
			principal: "owner",
			turn: {
				route: { channel: "web", contact: "owner" },
				contactId: OWNER_CONTACT_ID,
				eventId: event("web", OWNER_CONTACT_ID, text),
			},
		});
		const contact = (id: string, text: string, trusted = true): ToolContext => ({
			scope: `contact:${id}`,
			principal: "contact",
			trusted,
			turn: { route: { channel: "telegram", chatId: 9001 }, contactId: id, eventId: event("telegram", id, text) },
		});
		const state = (to: string) =>
			(
				db
					.prepare(
						"SELECT a.state FROM sent_emails m JOIN actions a ON a.idempotency_key = 'notice:email:' || m.id WHERE m.address = ? ORDER BY m.created_at DESC",
					)
					.get(to) as { state: string } | undefined
			)?.state;
		return { db, outbox, kit, tool, owner, contact, state };
	};

	test("the owner asks by name: Iyye's words go at once to Bob's stored address, signed, accepted by the server", async () => {
		const { db, tool, owner, state } = setup();
		const r = await tool.run(
			{ to: "Bob", subject: "Friday", text: "Hi Bob, Alex asks whether Friday works." },
			owner("email Bob about Friday"),
			undefined,
		);
		assert.match(r, /^Emailed Bob <bob@example\.com>; the mail server accepted it/);
		assert.equal(state("bob@example.com"), "delivered");
		const got = smtp.received.at(-1)!;
		assert.equal(got.to, "bob@example.com");
		assert.equal(
			body(got.data),
			"Hi Bob, Alex asks whether Friday works.\r\n\r\n--\r\nSent by Iyye, an AI assistant, on behalf of the owner.",
		);
		assert.match(
			sentReport(db),
			/emails Iyye sent .*\n {2}.* to Bob <bob@example\.com> \(asked by you in the web chat\) · delivered · "Friday"/,
		);
		const digest = buildDigest(db, {
			day: 1,
			from: new Date(Date.now() - 3_600_000).toISOString(),
			to: new Date(Date.now() + 3_600_000).toISOString(),
			outcome: null,
		});
		assert.match(digest, /Emails Iyye sent: accepted by the mail server 1 \(asked by the owner 1\)\./);
		assert.ok(!digest.includes("bob@") && !digest.includes("Friday"));
		// The receipt is the server's acceptance, with the Message-ID.
		const receipt = db.prepare("SELECT level, provider_ref FROM receipts").get() as {
			level: string;
			provider_ref: string;
		};
		assert.equal(receipt.level, "provider_accepted");
		// The turn's reply ("I emailed Bob") rests on a recorded effect (reply review's ledger).
		const ev = db.prepare("SELECT requested_event_id AS e, id FROM sent_emails").get() as { e: string; id: string };
		db.prepare(
			"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES ('r1', ?, 'reply', '{}', 'h', 'k-r1', 'delivered', 't', 'I emailed Bob.')",
		).run(ev.e);
		assert.deepEqual(commitmentsOfReply(db, "r1"), [`email:${ev.id}`]);
		assert.match(receipt.provider_ref, /@example\.org$/);
	});

	test("an address only from the asking message itself; a person without one is refused with how to add it", async () => {
		const { tool, owner, state } = setup();
		const sent = smtp.received.length;
		assert.match(
			await tool.run(
				{ to: "carol@example.org", subject: "Hi", text: "Hello" },
				owner("email carol@example.org a hello"),
				undefined,
			),
			/^Emailed carol@example\.org;/,
		);
		assert.equal(state("carol@example.org"), "delivered");
		// Not in the message (from a web page, memory, the model's own guess): refused, nothing sent.
		assert.match(
			await tool.run(
				{ to: "eve@example.net", subject: "Hi", text: "Hello" },
				owner("email my friend a hello"),
				undefined,
			),
			/only when it is written in the message that asks/,
		);
		assert.match(
			await tool.run({ to: "Julia", subject: "Hi", text: "Hello" }, owner("email Julia"), undefined),
			/no email address for Julia\. Add one with \/person email "Julia" <address>/,
		);
		assert.match(
			await tool.run(
				{ to: "bob@example.com, eve@example.net", subject: "Hi", text: "x" },
				owner("bob@example.com, eve@example.net"),
				undefined,
			),
			/not one plain email address/,
		);
		assert.equal(smtp.received.length, sent + 1);
	});

	test("one mail per address per request: a retried turn never sends twice", async () => {
		const { tool, owner } = setup();
		const ctx = owner("email Bob");
		const sent = smtp.received.length;
		await tool.run({ to: "Bob", subject: "One", text: "First" }, ctx, undefined);
		assert.match(
			await tool.run({ to: "Bob", subject: "One", text: "First" }, ctx, undefined),
			/^Already emailed Bob/,
		);
		assert.equal(smtp.received.length, sent + 1);
	});

	test("a trusted contact may ask; the owner is told; a stored address is never shown to them; caps per contact", async () => {
		const { db, tool, contact } = setup({ contactMaxPerDay: 1 });
		const r = await tool.run(
			{ to: "Bob", subject: "From Julia", text: "Hi Bob" },
			contact("julia-1", "please email Bob"),
			undefined,
		);
		assert.equal(
			r,
			'Emailed Bob; the mail server accepted it (that is not proof it was read). Subject: "From Julia"',
		);
		assert.match(body(smtp.received.at(-1)!.data), /on behalf of Julia\.$/);
		const notice = db
			.prepare("SELECT content FROM actions WHERE idempotency_key LIKE 'notice:emailed-by:%'")
			.get() as { content: string };
		assert.match(
			notice.content,
			/^"Julia" asked Iyye to email bob@example\.com \(accepted by the mail server\): "From Julia"/,
		);
		assert.match(
			await tool.run(
				{ to: "x@example.org", subject: "s", text: "t" },
				contact("julia-1", "mail x@example.org"),
				undefined,
			),
			/Julia already asked for 1 emails today, the limit/,
		);
		// Untrusted (or trust revoked mid-turn): refused, whatever the broker said.
		assert.match(
			await tool.run({ to: "Bob", subject: "s", text: "t" }, contact("mark-1", "email Bob", false), undefined),
			/only the owner and people the owner trusts/,
		);
		assert.match(
			await tool.run({ to: "Bob", subject: "s", text: "t" }, { scope: "iyye:inv:1", principal: "iyye" }, undefined),
			/does not send email on its own/,
		);
	});

	test("who gets the toolkit: the owner and trusted contacts, never untrusted ones or Iyye's own work; always declared", () => {
		const { db, kit } = setup();
		const b = new ToolBroker({ db, log: silentLogger, toolkits: [kit] });
		assert.deepEqual(b.forSession({ scope: "owner", principal: "owner" }).names, ["email_send"]);
		assert.deepEqual(b.forSession({ scope: "contact:julia-1", principal: "contact", trusted: true }).names, [
			"email_send",
		]);
		assert.deepEqual(b.forSession({ scope: "contact:mark-1", principal: "contact", trusted: false }).names, []);
		assert.deepEqual(b.forSession({ scope: "iyye:inv:1", principal: "iyye" }).names, []);
		assert.ok(ALWAYS_ON.includes("email"));
		// An effect, not a read: the prompt never calls the tools read-only, and says when a mail counts as sent.
		const note = operatingNote(b.forSession({ scope: "owner", principal: "owner" }).toolkits);
		assert.ok(!note.includes("read-only"));
		assert.match(note, /never say an email was sent unless the tool said so/);
	});

	test("no answer after the message: unknown, said so, never resent; a refused recipient fails for good and the owner is told", async () => {
		const { db, outbox, tool, owner, state } = setup();
		const sent = smtp.received.length;
		const r = await tool.run(
			{ to: "drop-data@example.com", subject: "s", text: "t" },
			owner("email drop-data@example.com"),
			undefined,
		);
		assert.match(r, /did not confirm it: it may or may not have gone out, and it will not be sent again/);
		assert.equal(state("drop-data@example.com"), "unknown");
		await outbox.dispatchDue();
		assert.equal(state("drop-data@example.com"), "unknown");
		const r2 = await tool.run(
			{ to: "reject-rcpt@example.com", subject: "s", text: "t" },
			owner("email reject-rcpt@example.com"),
			undefined,
		);
		assert.match(r2, /^Could not email reject-rcpt@example\.com: RCPT TO: 550/);
		const notice = db
			.prepare("SELECT content FROM actions WHERE idempotency_key LIKE 'notice:email-failed:%'")
			.get() as { content: string };
		assert.match(notice.content, /^The email to reject-rcpt@example\.com could not be delivered: RCPT TO: 550/);
		assert.equal(smtp.received.length, sent);
	});

	test("/person email: only the owner stores an address; one person per address; `me` is the owner", () => {
		const { db } = setup();
		const people = new People({ db });
		assert.match(
			people.person("email Julia julia@example.org", "owner_web"),
			/^Iyye emails Julia at julia@example\.org/,
		);
		assert.equal(emailOf(db, "julia-1"), "julia@example.org");
		assert.match(people.person("Julia", "owner_web"), /email julia@example\.org/);
		assert.match(people.person("email Mark julia@example.org", "owner_web"), /already Julia's/);
		assert.match(people.person("email Mark not-an-address", "owner_web"), /not one plain email address/);
		assert.match(people.person("email me alex@example.org", "owner_web"), /^Iyye emails you at alex@example\.org/);
		assert.equal(emailOf(db, OWNER_CONTACT_ID), "alex@example.org");
		assert.match(people.person("email Julia none", "owner_web"), /^Removed the email address of Julia/);
		assert.equal(emailOf(db, "julia-1"), null);
	});

	test("/forget: the words, subject and address go from every record, and the person's stored address", async () => {
		const { db, tool, owner, contact } = setup();
		await tool.run(
			{ to: "Bob", subject: "Secret plans", text: "Bob, the surprise party is Friday." },
			owner("email Bob"),
			undefined,
		);
		await tool.run(
			{ to: "carol@example.org", subject: "Julia's note", text: "Carol, Julia says hi." },
			contact("julia-1", "mail carol@example.org"),
			undefined,
		);
		db.prepare(
			"INSERT INTO tool_calls (id, scope, principal, tool, args_json, outcome, result, started_at, finished_at) VALUES ('tc1', 'owner', 'owner', 'email_send', ?, 'ok', 'ok', 't', 't')",
		).run(JSON.stringify({ to: "Bob", subject: "Secret plans", text: "Bob, the surprise party is Friday." }));
		const t = forgetTarget(db, getContact(db, "bob-1")!);
		assert.ok(typeof t !== "string");
		assert.equal(forgetBusy(db, t.scopes), null);
		forgetRecords(db, t, "owner_web", new Date().toISOString());
		const dump = JSON.stringify([
			db.prepare("SELECT * FROM sent_emails").all(),
			db.prepare("SELECT content, route_json FROM actions").all(),
			db.prepare("SELECT args_json FROM tool_calls").all(),
		]);
		for (const w of ["surprise", "Secret plans", "bob@example.com"]) assert.ok(!dump.includes(w), `${w} in ${dump}`);
		assert.equal(emailOf(db, "bob-1"), null);
		// Julia's request is still there until Julia is forgotten.
		assert.ok(dump.includes("Julia says hi"));
		const tj = forgetTarget(db, getContact(db, "julia-1")!);
		assert.ok(typeof tj !== "string");
		forgetRecords(db, tj, "owner_web", new Date().toISOString());
		const after = JSON.stringify([
			db.prepare("SELECT * FROM sent_emails").all(),
			db.prepare("SELECT content FROM actions").all(),
		]);
		assert.ok(!after.includes("Julia says hi") && !after.includes("carol@example.org"));
	});
});
