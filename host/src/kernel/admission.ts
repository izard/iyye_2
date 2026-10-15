// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable, deterministic admission of inbound messages (plan M1, HLD §3).
 *
 * Every message becomes exactly one `events` row. Admitted events also get a
 * queued job; dropped ones are recorded with a reason and no job, so the
 * channel can confirm them and they are never re-delivered.
 *
 * The principal always comes from the authenticated transport — the web
 * channel is the owner, a Telegram message is whoever `from.id` is bound to.
 * Message text is stored as payload and never consulted for identity, scope
 * or trust: a Telegram user typing "I am the owner" is still that user.
 */

import type { InboundMail } from "../channels/email/inbound.ts";
import type { Channel, TelegramInbound, WebOwnerMessage } from "../channels/types.ts";
import {
	type Contact,
	createContactWithBinding,
	findContactByBinding,
	getContact,
	OWNER_CONTACT_ID,
	resolvePerson,
	scopeFor,
} from "../state/contacts.ts";
import { advanceCursor } from "../state/cursors.ts";
import type { Db } from "../state/db.ts";
import { contactByEmail } from "../state/emails.ts";
import { getEventByDedupKey, insertEventIfNew } from "../state/events.ts";
import { insertQueuedJob } from "../state/jobs.ts";

export interface AdmissionDeps {
	db: Db;
	now: () => Date;
	newId: () => string;
	/** Telegram user ids allowed to talk to Iyye; undefined or empty = any private chat. */
	telegramAllowedUserIds?: ReadonlySet<number>;
	/**
	 * Telegram messages sent before this time are recorded as dropped, never
	 * answered: the bot was 1.x's, and Telegram may still hold updates 1.x never
	 * confirmed (HLD §16). Set to the host's first Telegram start.
	 */
	telegramAcceptAfter?: Date;
}

export type AdmissionResult =
	| {
			outcome: "admitted";
			eventId: string;
			jobId: string;
			contactId: string;
			scope: string;
			/** The Telegram account was seen for the first time and created now (plan 0.005 Stage 2: the owner is told). */
			newContactId?: string;
	  }
	| { outcome: "dropped"; eventId: string; reason: DropReason }
	| { outcome: "duplicate"; eventId: string };

export type DropReason =
	| "empty_text"
	| "not_a_message"
	| "non_private_chat"
	| "no_sender"
	| "bot_sender"
	| "sender_not_allowed"
	| "no_text"
	| "before_first_start"
	| EmailDropReason;

/** Why a mail was read but not admitted (plan 0.015). */
export type EmailDropReason =
	| "own_address"
	| NonNullable<InboundMail["machine"]>
	| "too_large"
	| "unauthenticated"
	| "duplicate_message"
	| "daily_cap"
	| "sender_daily_cap";

export const TELEGRAM_CURSOR = "telegram";

/**
 * Admit a message from the local web chat as the owner.
 *
 * Only the web channel adapter may call this, and only after it has
 * authenticated the request (plan M4). There is deliberately no principal
 * parameter: the caller cannot choose who the message is from.
 */
export function admitOwnerWebMessage(deps: AdmissionDeps, msg: WebOwnerMessage): AdmissionResult {
	const { db } = deps;
	return db.transaction((): AdmissionResult => {
		const dedupKey = `web:${msg.clientMsgId}`;
		const seen = getEventByDedupKey(db, dedupKey);
		if (seen) return { outcome: "duplicate", eventId: seen.id };
		const owner = getContact(db, OWNER_CONTACT_ID);
		if (!owner) throw new Error("owner contact missing: database not migrated");
		const dropReason: DropReason | null = msg.text.trim() === "" ? "empty_text" : null;
		return record(deps, {
			channel: "web",
			dedupKey,
			externalRef: msg.clientMsgId,
			observedAt: msg.observedAt ?? null,
			payload: msg,
			principal: dropReason ? null : owner,
			dropReason,
		});
	})();
}

/**
 * Admit one Telegram update and advance the Telegram cursor past it, in one
 * transaction. The cursor moves for admitted, dropped and duplicate updates
 * alike, so nothing is re-delivered forever; if the transaction fails, neither
 * the event nor the cursor change, and Telegram re-delivers the update.
 *
 * Callers admitting a getUpdates batch must stop at the first error and poll
 * again: admitting a later update would move the cursor past the failed one,
 * and Telegram drops every update below the next offset.
 */
export function admitTelegramUpdate(deps: AdmissionDeps, update: TelegramInbound): AdmissionResult {
	const { db } = deps;
	return db.transaction((): AdmissionResult => {
		const at = deps.now().toISOString();
		const dedupKey = `telegram:${update.updateId}`;
		const seen = getEventByDedupKey(db, dedupKey);
		if (seen) {
			advanceCursor(db, TELEGRAM_CURSOR, update.updateId, at);
			return { outcome: "duplicate", eventId: seen.id };
		}
		const dropReason = telegramDropReason(update, deps.telegramAllowedUserIds, deps.telegramAcceptAfter);
		// The account that wrote, then the person it belongs to (plan 0.005): an owner link makes it the owner.
		const account = dropReason ? null : resolveTelegramContact(deps, update);
		const principal = account ? resolvePerson(db, account.contact) : null;
		const result = record(deps, {
			channel: "telegram",
			dedupKey,
			externalRef: String(update.updateId),
			observedAt: update.message?.dateUnix != null ? new Date(update.message.dateUnix * 1000).toISOString() : null,
			payload: update,
			principal,
			dropReason,
		});
		advanceCursor(db, TELEGRAM_CURSOR, update.updateId, at);
		return result.outcome === "admitted" && account?.created
			? { ...result, newContactId: account.contact.id }
			: result;
	})();
}

function telegramDropReason(
	update: TelegramInbound,
	allowed: ReadonlySet<number> | undefined,
	acceptAfter: Date | undefined,
): DropReason | null {
	const m = update.message;
	if (!m) return "not_a_message";
	// Telegram dates are whole seconds: compare at that granularity so a message sent in the start second counts.
	if (acceptAfter && m.dateUnix != null && m.dateUnix < Math.floor(acceptAfter.getTime() / 1000)) {
		return "before_first_start";
	}
	if (m.chatType !== "private") return "non_private_chat";
	if (m.fromUserId == null) return "no_sender";
	if (m.fromIsBot) return "bot_sender";
	if (allowed && allowed.size > 0 && !allowed.has(m.fromUserId)) return "sender_not_allowed";
	if (m.text.trim() === "" && !m.image) return "no_text";
	return null;
}

/**
 * The contact bound to this Telegram user id, created on first contact as an
 * ordinary untrusted contact. Display names are never used to match: two
 * users both called "Alex" are two contacts.
 */
function resolveTelegramContact(deps: AdmissionDeps, update: TelegramInbound): { contact: Contact; created: boolean } {
	const m = update.message!;
	const externalId = String(m.fromUserId);
	const existing = findContactByBinding(deps.db, "telegram", externalId);
	if (existing) return { contact: existing, created: false };
	const contact = createContactWithBinding(deps.db, {
		id: deps.newId(),
		displayName: m.firstName || (m.username ? `@${m.username}` : `telegram:${externalId}`),
		channel: "telegram",
		externalId,
		verifiedBy: "first_contact",
		at: deps.now().toISOString(),
	});
	return { contact, created: true };
}

/**
 * Insert the event (and its job when admitted). Callers check for duplicates
 * first; the ON CONFLICT guard here is the backstop for a concurrent writer.
 */
function record(
	deps: AdmissionDeps,
	e: {
		channel: Channel;
		dedupKey: string;
		externalRef: string;
		observedAt: string | null;
		payload: unknown;
		principal: Contact | null;
		dropReason: DropReason | null;
	},
): AdmissionResult {
	const { db } = deps;
	const at = deps.now().toISOString();
	const eventId = deps.newId();
	const scope = e.principal ? scopeFor(e.principal) : null;
	const inserted = insertEventIfNew(db, {
		id: eventId,
		dedupKey: e.dedupKey,
		channel: e.channel,
		externalRef: e.externalRef,
		principalContactId: e.principal?.id ?? null,
		scope,
		observedAt: e.observedAt,
		receivedAt: at,
		payload: e.payload,
		status: e.dropReason ? "dropped" : "admitted",
		dropReason: e.dropReason,
	});
	if (!inserted) {
		return { outcome: "duplicate", eventId: getEventByDedupKey(db, e.dedupKey)!.id };
	}
	if (e.dropReason) {
		return { outcome: "dropped", eventId, reason: e.dropReason };
	}
	const jobId = deps.newId();
	insertQueuedJob(db, {
		id: jobId,
		triggerEventId: eventId,
		scope: scope!,
		// Bound when the job starts (M7), so a /use takes effect at the next job boundary
		// and a queued job never waits on a model that was unloaded after admission.
		modelName: null,
		at,
	});
	return { outcome: "admitted", eventId, jobId, contactId: e.principal!.id, scope: scope! };
}

// ---------------------------------------------------------------- email (plan 0.015)

/** The contact that stands for the owner's own address: a trusted contact, never the owner (owner decision 3). */
export const OWNER_EMAIL_CONTACT_ID = "owner-email";

export interface EmailAdmissionInput {
	mail: InboundMail;
	mailbox: string;
	uidvalidity: number;
	uid: number;
	/** Too large to read: only its headers were fetched. */
	tooLarge?: boolean;
}

export interface EmailAdmissionOptions {
	/** Iyye's own address: mail from it is never admitted. */
	ownAddress: string;
	/** Mails a day admitted from senders who are not trusted, all together (spam must not flood contacts or model time). */
	untrustedDailyMax: number;
	/** Mails a day admitted from one untrusted sender. */
	senderDailyMax: number;
	/** Mails a day admitted from one trusted sender. */
	trustedSenderDailyMax: number;
}

export type EmailAdmission = AdmissionResult & {
	/** The `email_inbox` row (absent for a mail already read). */
	inboxId?: string;
	/** An unauthenticated mail claiming the address of someone Iyye knows: the owner is told. */
	spoofed?: string;
};

/**
 * Admit one mail and move the mailbox cursor past it, in one transaction (as Telegram's updates). Every mail
 * read gets an `email_inbox` row with what was decided. Admitted only when the receiving server vouches for
 * the From address (a forged sender is never answered: the reply would reach an innocent third party), no
 * machine sent it, and the daily caps allow. The sender is, in order: the person whose address the owner
 * stored (`/person email`; the owner's own address is the trusted `owner-email` contact, never the owner),
 * the account an earlier mail from the address created, or a new untrusted contact. Nothing in a mail can
 * link an address to anyone or change trust.
 */
export function admitEmail(
	deps: AdmissionDeps,
	opts: EmailAdmissionOptions,
	input: EmailAdmissionInput,
): EmailAdmission {
	const { db } = deps;
	return db.transaction((): EmailAdmission => {
		const at = deps.now().toISOString();
		const { mail } = input;
		const seen = db
			.prepare("SELECT id, event_id FROM email_inbox WHERE uidvalidity = ? AND uid = ?")
			.get(input.uidvalidity, input.uid) as { id: string; event_id: string | null } | undefined;
		db.prepare(
			`INSERT INTO email_cursor (mailbox, uidvalidity, last_uid, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (mailbox) DO UPDATE SET
				last_uid = CASE WHEN uidvalidity = excluded.uidvalidity THEN MAX(last_uid, excluded.last_uid) ELSE excluded.last_uid END,
				uidvalidity = excluded.uidvalidity, updated_at = excluded.updated_at`,
		).run(input.mailbox, input.uidvalidity, input.uid, at);
		if (seen) return { outcome: "duplicate", eventId: seen.event_id ?? "" };

		const address = mail.from?.address ?? "";
		const dedupKey = mail.messageId ? `email:${mail.messageId}` : `email:${input.uidvalidity}:${input.uid}`;
		const known = address ? knownEmailSender(db, address) : null;
		let reason: DropReason | null = null;
		let spoofed: string | undefined;
		if (!address) reason = "no_sender";
		else if (address === opts.ownAddress.toLowerCase()) reason = "own_address";
		else if (mail.machine) reason = mail.machine;
		else if (input.tooLarge) reason = "too_large";
		else if (!mail.text.trim() && !mail.subject) reason = "no_text";
		else if (!mail.authenticated) {
			reason = "unauthenticated";
			if (known) spoofed = address;
		} else if (getEventByDedupKey(db, dedupKey)) reason = "duplicate_message";
		else {
			const since = startOfLocalDay(deps.now());
			const fromSender = (contactId: string) =>
				(
					db
						.prepare(
							"SELECT count(*) AS n FROM email_inbox WHERE contact_id = ? AND verdict <> 'dropped' AND received_at >= ?",
						)
						.get(contactId, since) as { n: number }
				).n;
			const untrusted = (
				db
					.prepare(
						`SELECT count(*) AS n FROM email_inbox m JOIN contacts c ON c.id = m.contact_id
						 WHERE m.verdict <> 'dropped' AND m.received_at >= ? AND c.trusted = 0`,
					)
					.get(since) as { n: number }
			).n;
			if (known?.trusted === 1) {
				if (fromSender(known.id) >= opts.trustedSenderDailyMax) reason = "sender_daily_cap";
			} else if (untrusted >= opts.untrustedDailyMax) reason = "daily_cap";
			else if (known && fromSender(known.id) >= opts.senderDailyMax) reason = "sender_daily_cap";
		}

		const inboxId = deps.newId();
		const name = mail.from?.name ?? "";
		const payload = reason
			? { from: mail.from, subject: mail.subject }
			: {
					from: mail.from,
					subject: mail.subject,
					text: mail.text,
					truncated: mail.truncated,
					messageId: mail.messageId,
					inReplyTo: mail.inReplyTo,
					references: mail.references,
					mailbox: input.mailbox,
					uidvalidity: input.uidvalidity,
					uid: input.uid,
					auth: mail.authSummary,
					attachments: mail.attachments,
				};
		let principal: Contact | null = null;
		let created = false;
		if (!reason) {
			const sender = known ?? createEmailContact(deps, address, name, at);
			principal = sender;
			created = !known && sender.id !== OWNER_EMAIL_CONTACT_ID;
		}
		const result = record(deps, {
			channel: "email",
			dedupKey: reason ? `email:${input.uidvalidity}:${input.uid}` : dedupKey,
			externalRef: `${input.uidvalidity}:${input.uid}`,
			observedAt: mail.date,
			payload,
			principal,
			dropReason: reason,
		});
		db.prepare(
			`INSERT INTO email_inbox (id, uidvalidity, uid, message_id, from_address, from_name, subject, authenticated,
				auth_summary, event_id, contact_id, verdict, reason, received_at, decided_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			inboxId,
			input.uidvalidity,
			input.uid,
			mail.messageId,
			address || "(none)",
			name || null,
			mail.subject,
			mail.authenticated ? 1 : 0,
			mail.authSummary.slice(0, 300),
			result.outcome === "duplicate" ? null : result.eventId,
			principal?.id ?? null,
			reason ? "dropped" : "queued",
			reason,
			at,
			reason ? at : null,
		);
		if (result.outcome === "admitted" && created) return { ...result, newContactId: principal!.id, inboxId };
		return { ...result, inboxId, ...(spoofed ? { spoofed } : {}) };
	})();
}

/**
 * Who an address belongs to, without creating anyone: the person the owner stored it for (the owner's own
 * address: the `owner-email` contact), else the account an earlier mail created (its linked person, if the
 * owner linked it). A binding to `owner-email` counts only while it is still the owner's stored address.
 */
export function knownEmailSender(db: Db, address: string): Contact | null {
	const stored = contactByEmail(db, address);
	if (stored === OWNER_CONTACT_ID) return getContact(db, OWNER_EMAIL_CONTACT_ID) ?? null;
	if (stored) return getContact(db, stored) ?? null;
	const account = findContactByBinding(db, "email", address);
	if (!account) return null;
	if (account.id === OWNER_EMAIL_CONTACT_ID) return null;
	const person = resolvePerson(db, account);
	// An address the owner linked to themselves is still only a trusted contact by email.
	return person.kind === "owner" ? (getContact(db, OWNER_EMAIL_CONTACT_ID) ?? null) : person;
}

function createEmailContact(deps: AdmissionDeps, address: string, name: string, at: string): Contact {
	const { db } = deps;
	if (contactByEmail(db, address) === OWNER_CONTACT_ID || isOwnerLinkedAddress(db, address)) {
		// The owner's own address (owner decision 3): a trusted contact, created on its first mail.
		if (!getContact(db, OWNER_EMAIL_CONTACT_ID)) {
			db.prepare(
				"INSERT INTO contacts (id, display_name, kind, created_at, trusted, trust_changed_by, trust_changed_at) VALUES (?, 'The owner (email)', 'contact', ?, 1, 'owner_email_address', ?)",
			).run(OWNER_EMAIL_CONTACT_ID, at, at);
		}
		return getContact(db, OWNER_EMAIL_CONTACT_ID)!;
	}
	// A stale binding to `owner-email` (the owner's address changed since) is let go.
	db.prepare("DELETE FROM channel_bindings WHERE channel = 'email' AND external_id = ? AND contact_id = ?").run(
		address,
		OWNER_EMAIL_CONTACT_ID,
	);
	return createContactWithBinding(db, {
		id: deps.newId(),
		displayName: (name || address).slice(0, 64),
		channel: "email",
		externalId: address,
		verifiedBy: "first_contact",
		at,
	});
}

function isOwnerLinkedAddress(db: Db, address: string): boolean {
	const account = findContactByBinding(db, "email", address);
	return !!account && account.id !== OWNER_EMAIL_CONTACT_ID && resolvePerson(db, account).kind === "owner";
}

function startOfLocalDay(d: Date): string {
	const s = new Date(d);
	s.setHours(0, 0, 0, 0);
	return s.toISOString();
}
