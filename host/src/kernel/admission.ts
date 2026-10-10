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
	| "before_first_start";

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
