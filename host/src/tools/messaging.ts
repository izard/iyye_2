// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The `messaging` toolkit (plan 0.008), effect `reach`: the owner (web chat
 * and linked Telegram accounts), contacts the owner marked trusted, and
 * Iyye's own background work (owner change, 2026-10-04). Untrusted contacts
 * never get it. One tool, `telegram_send`:
 *
 * - **Sent at once** (owner decision 1), through `Outbox.sendOwn` on the
 *   recipient's own Telegram chat: delivered only by its receipt, `unknown`
 *   never resent, a definite failure retried by the outbox and reported.
 * - **Iyye composes the words** (owner decision 3); the recipient sees them
 *   under a label naming who asked ("on behalf of Alex", "on behalf of
 *   Julia", or just "From Iyye" when Iyye wrote on its own).
 * - **Anyone Iyye knows** with a Telegram chat, the owner included (on a
 *   linked account): the host resolves the name. The model never passes a
 *   chat id, so it cannot reach anyone who never wrote to Iyye.
 * - **Bounds:** one message per person per request (a retried turn never
 *   sends twice); per day `maxPerDay` in all, `contactMaxPerDay` per trusted
 *   contact, `iyyeMaxPerDay` on Iyye's own and at most one of those per
 *   person. Trust is checked again when the tool runs.
 * - **The owner sees what others caused:** every message a trusted contact
 *   asked for, or Iyye sent on its own, is also a web notice to the owner.
 */

import { Type } from "typebox";
import type { Outbox, Route } from "../outbox/outbox.ts";
import {
	accountsOf,
	type Contact,
	findContacts,
	getContact,
	OWNER_CONTACT_ID,
	resolvePerson,
	scopeFor,
} from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { insertSentMessage, type SentMessage, sendKey, sentByKey, setSentAction } from "../state/sent.ts";
import { type IyyeTool, PLAN_STEP_SCOPE, type ToolContext, type Toolkit } from "./broker.ts";

export interface MessagingDeps {
	db: Db;
	outbox: Pick<Outbox, "sendOwn" | "notifyOwner">;
	now?: () => Date;
	newId?: () => string;
	maxPerDay?: number;
	contactMaxPerDay?: number;
	iyyeMaxPerDay?: number;
}

export const MESSAGING_TOOLKIT = "messaging";

interface Requester {
	kind: SentMessage["requested_by"];
	contactId: string | null;
	/** As the label and the owner's notice name them. */
	name: string;
	scope: string;
	via: string;
	eventId: string | null;
}

/** What a send did: the text for the model (or the caller), and the record when one was made. */
export interface SendOutcome {
	text: string;
	sentId: string | null;
	/** The action's state, when it was sent. */
	state: string | null;
}

type Resolved = Required<MessagingDeps>;

function withDefaults(deps: MessagingDeps): Resolved {
	return {
		now: () => new Date(),
		newId: () => crypto.randomUUID(),
		maxPerDay: 20,
		contactMaxPerDay: 10,
		iyyeMaxPerDay: 5,
		...deps,
	};
}

/**
 * Iyye writes to a person on its own, outside any session (plan 0.010 M3: a
 * social follow-up). Exactly what `telegram_send` does in Iyye's own work:
 * the same label, the same caps (one message per person per day on Iyye's
 * own), the same notice to the owner.
 */
export function iyyeMessenger(
	deps: MessagingDeps,
): (personId: string, text: string, via: string) => Promise<SendOutcome> {
	const d = withDefaults(deps);
	return async (personId, text, via) => {
		const person = getContact(d.db, personId);
		if (!person) return { text: "Not sent: that person is gone.", sentId: null, state: null };
		const who: Requester = {
			kind: "iyye",
			contactId: null,
			name: "Iyye",
			scope: via,
			via: "background",
			eventId: null,
		};
		return sendTo(d, who, resolvePerson(d.db, person), text);
	};
}

export function messagingToolkit(deps: MessagingDeps): Toolkit {
	const d = withDefaults(deps);

	const send: IyyeTool = {
		name: "telegram_send",
		label: "Send a Telegram message",
		description:
			"Send a Telegram message now to a person Iyye knows. Use it when the person you are talking with asks you to write to someone, or, in your own work, when someone clearly needs to know what you found. Write the message yourself; the recipient sees who it is from. Returns whether it was delivered; say exactly that.",
		summary: "send a Telegram message now to a person Iyye knows",
		parameters: Type.Object({
			to: Type.String({ minLength: 1, maxLength: 80, description: "The person's name as Iyye knows them" }),
			text: Type.String({ minLength: 1, maxLength: 2000, description: "The message, written by you" }),
		}),
		run: async (p: { to: string; text: string }, ctx: ToolContext) => {
			const who = requester(d.db, ctx);
			if (typeof who === "string") return who;
			if (!p.text.trim()) return "Not sent: the message is empty.";
			const person = resolveRecipient(d.db, p.to);
			if (typeof person === "string") return person;
			if (who.kind === "contact" && person.id === who.contactId)
				return "Not sent: that is the person you are talking with; answer them here.";
			return (await sendTo(d, who, person, p.text)).text;
		},
	};

	return {
		name: MESSAGING_TOOLKIT,
		description: "messages to people Iyye knows",
		effect: "reach",
		tools: [send] as IyyeTool[],
	};
}

/** Send `text` to `person` for `who`: the caps, the record, the outbox, the owner's notice. */
async function sendTo(d: Resolved, who: Requester, person: Contact, raw: string): Promise<SendOutcome> {
	const no = (text: string): SendOutcome => ({ text, sentId: null, state: null });
	const text = raw.trim();
	if (!text) return no("Not sent: the message is empty.");
	const route = telegramRoute(d.db, person);
	if (!route)
		return no(
			`Not sent: ${person.kind === "owner" ? "the owner" : person.display_name} has no Telegram chat with Iyye (they must write to Iyye first).`,
		);
	const recipient = person.kind === "owner" ? "the owner" : person.display_name;
	const now = d.now();
	const day = localDay(now);
	// Iyye on its own: at most one message per person per day; a person's request: one per person.
	const dedupKey = who.kind === "iyye" ? `iyye:${person.id}:${day}` : `${who.eventId ?? d.newId()}:${person.id}`;
	const earlier = sentByKey(d.db, dedupKey);
	if (earlier) {
		const action = d.db
			.prepare("SELECT state FROM actions WHERE idempotency_key = ?")
			.get(`notice:${sendKey(earlier.id)}`) as { state: string } | undefined;
		return no(
			who.kind === "iyye"
				? `Not sent: Iyye already wrote to ${recipient} on its own today (${action?.state ?? "not sent"}).`
				: `Already sent to ${recipient} for this request (${action?.state ?? "not sent"}); one message per person per request.`,
		);
	}
	const since = startOfDay(now);
	const count = (where: string, ...args: unknown[]) =>
		(
			d.db.prepare(`SELECT count(*) AS n FROM sent_messages WHERE created_at >= ?${where}`).get(since, ...args) as {
				n: number;
			}
		).n;
	if (count("") >= d.maxPerDay)
		return no(`Not sent: ${d.maxPerDay} messages were already sent today, the daily limit.`);
	if (who.kind === "contact" && count(" AND requester_contact_id = ?", who.contactId) >= d.contactMaxPerDay)
		return no(`Not sent: ${who.name} already asked for ${d.contactMaxPerDay} messages today, the limit.`);
	if (who.kind === "iyye" && count(" AND requested_by = 'iyye'") >= d.iyyeMaxPerDay)
		return no(`Not sent: Iyye already sent ${d.iyyeMaxPerDay} messages on its own today, the limit.`);
	const id = d.newId();
	insertSentMessage(d.db, {
		id,
		dedup_key: dedupKey,
		recipient_contact_id: person.id,
		scope: scopeFor(person),
		route_json: JSON.stringify(route),
		text,
		requested_event_id: who.eventId,
		requested_via: who.via,
		requested_by: who.kind,
		requester_contact_id: who.contactId,
		requester_scope: who.scope,
		created_at: now.toISOString(),
	});
	const header = who.kind === "iyye" ? "✉️ From Iyye:" : `✉️ From Iyye, on behalf of ${who.name.slice(0, 64)}:`;
	const content = `${header}\n\n${text}`;
	const row = await d.outbox.sendOwn({ key: sendKey(id), route, content });
	setSentAction(d.db, id, row.id);
	const outcome =
		row.state === "delivered"
			? "delivered"
			: row.state === "unknown"
				? "may not have arrived"
				: row.state === "terminal_failure"
					? "could not be delivered"
					: "not delivered yet";
	// What others caused, the owner sees (the owner's own requests they see in their chat).
	if (who.kind !== "owner" && person.kind !== "owner") {
		const by =
			who.kind === "iyye"
				? `Iyye wrote to ${JSON.stringify(recipient.slice(0, 64))} on its own`
				: `${JSON.stringify(who.name.slice(0, 64))} asked Iyye to write to ${JSON.stringify(recipient.slice(0, 64))}`;
		void d.outbox
			.notifyOwner({
				key: `sent-by:${id}`,
				content: `${by} (${outcome}): ${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 300))}`,
			})
			.catch(() => undefined);
	}
	const said = (text: string): SendOutcome => ({ text, sentId: id, state: row.state });
	switch (row.state) {
		case "delivered":
			return said(`Sent to ${recipient} on Telegram and delivered: ${JSON.stringify(content)}`);
		case "unknown":
			return said(
				`Sent to ${recipient}, but Telegram did not confirm it: it may or may not have arrived, and it will not be sent again. Say exactly that.`,
			);
		case "terminal_failure":
			return said(`Could not be delivered to ${recipient}: ${row.last_error ?? "failed"}. Say it was not sent.`);
		case "failed":
			return said(
				`Not delivered yet (${row.last_error ?? "failed"}); it will be retried, and the owner is told if it fails for good. Say it is not delivered yet.`,
			);
		default:
			return said(`Queued for ${recipient}; it goes out when Iyye is awake. Say it is not delivered yet.`);
	}
}

/** Who is asking, from the kernel's context; trust is read again now (it may have been revoked mid-turn). */
function requester(db: Db, ctx: ToolContext): Requester | string {
	if (ctx.principal === "iyye" && ctx.scope.startsWith(PLAN_STEP_SCOPE))
		return "Not sent: a plan step only looks; it does not write to anyone.";
	if (ctx.principal === "iyye")
		return { kind: "iyye", contactId: null, name: "Iyye", scope: ctx.scope, via: "background", eventId: null };
	if (!ctx.turn) return "Messages can only be sent when someone asks in a conversation.";
	const via = ctx.turn.route.channel === "web" ? "web chat" : "Telegram";
	if (ctx.principal === "owner")
		return {
			kind: "owner",
			contactId: OWNER_CONTACT_ID,
			name: ownerName(db),
			scope: ctx.scope,
			via,
			eventId: ctx.turn.eventId,
		};
	const c = getContact(db, ctx.turn.contactId);
	if (!c || c.trusted !== 1)
		return "Not sent: only the owner and people the owner trusts can ask Iyye to write to someone.";
	return { kind: "contact", contactId: c.id, name: c.display_name, scope: ctx.scope, via, eventId: ctx.turn.eventId };
}

function localDay(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(d: Date): string {
	const s = new Date(d);
	s.setHours(0, 0, 0, 0);
	return s.toISOString();
}

/** The one person a name means, or why not. Linked accounts are their person, so the owner's linked account is the owner. */
export function resolveRecipient(db: Db, ref: string): Contact | string {
	const people = new Map<string, Contact>();
	for (const c of findContacts(db, ref)) {
		const person = resolvePerson(db, c);
		people.set(person.id, person);
	}
	const found = [...people.values()];
	if (found.length === 0)
		return `Not sent: Iyye knows nobody called ${JSON.stringify(ref.slice(0, 80))}. Ask who they mean.`;
	if (found.length > 1)
		return `Not sent: ${found.length} people match ${JSON.stringify(ref.slice(0, 80))} (${found.map((p) => `${p.kind === "owner" ? "the owner" : p.display_name} ${p.id.slice(0, 8)}`).join(", ")}). Ask which one.`;
	return found[0]!;
}

/** The person's Telegram chat: of their accounts, the one that wrote most recently (private chat id = user id). */
function telegramRoute(db: Db, person: Contact): Route | null {
	const ids = [person.id, ...accountsOf(db, person.id).map((a) => a.id)];
	const row = db
		.prepare(
			`SELECT b.external_id FROM channel_bindings b
			 WHERE b.channel = 'telegram' AND b.contact_id IN (${ids.map(() => "?").join(", ")})
			 ORDER BY (SELECT max(e.received_at) FROM events e WHERE e.channel = 'telegram'
				AND CAST(json_extract(e.payload_json, '$.message.chatId') AS TEXT) = b.external_id) DESC LIMIT 1`,
		)
		.get(...ids) as { external_id: string } | undefined;
	const chatId = Number(row?.external_id);
	return row && Number.isSafeInteger(chatId) ? { channel: "telegram", chatId } : null;
}

/** The owner's name from their linked Telegram account, if any. */
function ownerName(db: Db): string {
	const owner = getContact(db, OWNER_CONTACT_ID);
	const linked = accountsOf(db, OWNER_CONTACT_ID)[0]?.display_name;
	return linked ?? (owner && owner.display_name !== "Owner" ? owner.display_name : "the owner");
}
