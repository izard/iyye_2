// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The `email` toolkit (plan 0.014), effect `send`: the owner and every
 * contact the owner trusts (owner decision 1), never Iyye's own work. One
 * tool, `email_send(to, subject, text)`:
 *
 * - **Sent at once** (owner decision 4) from Iyye's own mailbox (decision 3)
 *   through `Outbox.sendOwn` on an email route: delivered only by the mail
 *   server's acceptance, `unknown` never resent, a definite failure retried
 *   by the outbox when it may pass, and the owner told when it fails for good.
 * - **Two kinds of recipient, never mixed** (decision 2): a person Iyye knows,
 *   at the address the owner stored for them (`/person email`), or an address
 *   the asker wrote in the very message that asked. The model never supplies
 *   an address of its own: one from a web page, a tool result, memory or an
 *   earlier message is refused, so nothing Iyye reads can choose a recipient.
 * - **Iyye composes the words**; the mail ends with a line naming who asked.
 * - **Bounds:** one mail per address per request (a retried turn never sends
 *   twice); per day `maxPerDay` in all and `contactMaxPerDay` per trusted
 *   contact. Trust is read again when the tool runs.
 * - **The owner sees what others caused:** every mail a trusted contact asked
 *   for is also a web notice to the owner.
 */

import { Type } from "typebox";
import { type Outbox, viaOf } from "../outbox/outbox.ts";
import { getContact, OWNER_CONTACT_ID, resolvePerson, scopeFor } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import {
	addressesIn,
	contactByEmail,
	emailKey,
	emailOf,
	insertSentEmail,
	sentEmailByKey,
	validAddress,
} from "../state/emails.ts";
import { getEvent, messageText } from "../state/events.ts";
import type { IyyeTool, ToolContext, Toolkit } from "./broker.ts";
import { ownerName, resolveRecipient } from "./messaging.ts";

export const EMAIL_TOOLKIT = "email";
export const SUBJECT_MAX = 150;
export const EMAIL_TEXT_MAX = 10_000;

export interface EmailDeps {
	db: Db;
	outbox: Pick<Outbox, "sendOwn" | "notifyOwner">;
	now?: () => Date;
	newId?: () => string;
	maxPerDay?: number;
	contactMaxPerDay?: number;
}

interface Asker {
	kind: "owner" | "contact";
	contactId: string;
	name: string;
	scope: string;
	via: string;
	eventId: string | null;
}

export function emailToolkit(deps: EmailDeps): Toolkit {
	const d = { now: () => new Date(), newId: () => crypto.randomUUID(), maxPerDay: 20, contactMaxPerDay: 5, ...deps };

	const send: IyyeTool = {
		name: "email_send",
		label: "Send an email",
		description:
			"Send an email now from Iyye's own mailbox. Use it when the person you are talking with asks you to email someone. `to` is either the name of a person Iyye knows who has an email address on record, or an email address written in the person's current message (never an address from anywhere else). Write the subject and the text yourself; the mail says who asked. Returns whether the mail server accepted it; say exactly that.",
		summary: "send an email now to a person Iyye knows or to an address written in this message",
		parameters: Type.Object({
			to: Type.String({
				minLength: 1,
				maxLength: 254,
				description: "A person's name as Iyye knows them, or an email address from the current message",
			}),
			subject: Type.String({ minLength: 1, maxLength: SUBJECT_MAX, description: "The subject, one line" }),
			text: Type.String({ minLength: 1, maxLength: EMAIL_TEXT_MAX, description: "The mail, written by you" }),
		}),
		run: async (p: { to: string; subject: string; text: string }, ctx: ToolContext) => {
			const who = asker(d.db, ctx);
			if (typeof who === "string") return who;
			const subject = p.subject.replace(/\s+/g, " ").trim().slice(0, SUBJECT_MAX);
			const text = p.text.trim();
			if (!subject) return "Not sent: the subject is empty.";
			if (!text) return "Not sent: the mail is empty.";
			const to = recipient(d.db, p.to.trim(), who);
			if (typeof to === "string") return to;
			const now = d.now();
			const dedupKey = `${who.eventId ?? d.newId()}:${to.address.toLowerCase()}`;
			const earlier = sentEmailByKey(d.db, dedupKey);
			if (earlier) {
				const a = d.db
					.prepare("SELECT state FROM actions WHERE idempotency_key = ?")
					.get(`notice:${emailKey(earlier.id)}`) as { state: string } | undefined;
				return `Already emailed ${to.label} for this request (${a?.state ?? "not sent"}); one mail per address per request.`;
			}
			const since = startOfDay(now);
			const count = (where: string, ...args: unknown[]) =>
				(
					d.db
						.prepare(`SELECT count(*) AS n FROM sent_emails WHERE created_at >= ?${where}`)
						.get(since, ...args) as { n: number }
				).n;
			if (count("") >= d.maxPerDay)
				return `Not sent: ${d.maxPerDay} emails were already sent today, the daily limit.`;
			if (who.kind === "contact" && count(" AND requester_contact_id = ?", who.contactId) >= d.contactMaxPerDay)
				return `Not sent: ${who.name} already asked for ${d.contactMaxPerDay} emails today, the limit.`;
			const id = d.newId();
			insertSentEmail(d.db, {
				id,
				dedup_key: dedupKey,
				recipient_contact_id: to.personId,
				recipient_scope: to.scope,
				address: to.address,
				subject,
				text,
				requested_event_id: who.eventId,
				requested_via: who.via,
				requested_by: who.kind,
				requester_contact_id: who.contactId,
				requester_scope: who.scope,
				created_at: now.toISOString(),
			});
			const content = `${text}\n\n--\nSent by Iyye, an AI assistant, on behalf of ${who.name.slice(0, 64)}.`;
			const row = await d.outbox.sendOwn({
				key: emailKey(id),
				route: { channel: "email", to: to.address, subject },
				content,
			});
			const outcome =
				row.state === "delivered"
					? "accepted by the mail server"
					: row.state === "unknown"
						? "may not have gone out"
						: row.state === "terminal_failure"
							? "could not be sent"
							: "not sent yet";
			if (who.kind === "contact") {
				void d.outbox
					.notifyOwner({
						key: `emailed-by:${id}`,
						content: `${JSON.stringify(who.name.slice(0, 64))} asked Iyye to email ${to.address} (${outcome}): ${JSON.stringify(subject.slice(0, 100))} — ${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 300))}`,
					})
					.catch(() => undefined);
			}
			switch (row.state) {
				case "delivered":
					return `Emailed ${to.label}; the mail server accepted it (that is not proof it was read). Subject: ${JSON.stringify(subject)}`;
				case "unknown":
					return `Emailed ${to.label}, but the mail server did not confirm it: it may or may not have gone out, and it will not be sent again. Say exactly that.`;
				case "terminal_failure":
					return `Could not email ${to.label}: ${row.last_error ?? "failed"}. Say it was not sent.`;
				case "failed":
					return `Not sent yet (${row.last_error ?? "failed"}); it will be retried, and the owner is told if it fails for good. Say it is not sent yet.`;
				default:
					return `Queued for ${to.label}; it goes out when Iyye is awake. Say it is not sent yet.`;
			}
		},
	};

	return {
		name: EMAIL_TOOLKIT,
		description: "email from Iyye's own mailbox",
		effect: "send",
		tools: [send] as IyyeTool[],
	};
}

/** Who is asking: the owner, or a contact the owner trusts right now; never Iyye's own work. */
function asker(db: Db, ctx: ToolContext): Asker | string {
	if (ctx.principal === "iyye") return "Not sent: Iyye does not send email on its own.";
	if (!ctx.turn) return "Email can only be sent when someone asks in a conversation.";
	const via = viaOf(ctx.turn.route);
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
	if (!c || c.trusted !== 1) return "Not sent: only the owner and people the owner trusts can ask Iyye to send email.";
	return { kind: "contact", contactId: c.id, name: c.display_name, scope: ctx.scope, via, eventId: ctx.turn.eventId };
}

interface Recipient {
	address: string;
	personId: string | null;
	scope: string | null;
	/** How the tool's answer names them. */
	label: string;
}

/**
 * An address only from the asking message itself, or a person's stored address. Never both in one: an
 * address written in the message is that address, whoever Iyye thinks it belongs to.
 */
function recipient(db: Db, to: string, who: Asker): Recipient | string {
	if (to.includes("@")) {
		if (!validAddress(to)) return `Not sent: ${JSON.stringify(to.slice(0, 100))} is not one plain email address.`;
		const event = who.eventId ? getEvent(db, who.eventId) : undefined;
		const written = event ? addressesIn(messageText(event)).map((a) => a.toLowerCase()) : [];
		if (!written.includes(to.toLowerCase()))
			return "Not sent: Iyye emails an address only when it is written in the message that asks for the mail, or stored for a person by the owner. Ask for the address, or the person's name.";
		const known = contactByEmail(db, to);
		const person = known ? getContact(db, known) : undefined;
		return {
			address: to,
			personId: person?.id ?? null,
			scope: person ? scopeFor(person) : null,
			label: person ? `${person.kind === "owner" ? "the owner" : person.display_name} <${to}>` : to,
		};
	}
	const person = resolveRecipient(db, to);
	if (typeof person === "string") return person;
	const p = resolvePerson(db, person);
	const name = p.kind === "owner" ? "the owner" : p.display_name;
	const address = emailOf(db, p.id);
	if (!address)
		return `Not sent: Iyye has no email address for ${name}. ${who.kind === "owner" ? `Add one with /person email ${p.kind === "owner" ? "me" : JSON.stringify(p.display_name)} <address>, or write the address in your message.` : "Ask for the address and have them write it in their message."}`;
	// A stored address is the owner's record: a contact's conversation names the person, never the address.
	return { address, personId: p.id, scope: scopeFor(p), label: who.kind === "owner" ? `${name} <${address}>` : name };
}

function startOfDay(d: Date): string {
	const s = new Date(d);
	s.setHours(0, 0, 0, 0);
	return s.toISOString();
}
