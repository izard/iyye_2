// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Email addresses the owner stored and mails Iyye sent (plan 0.014, migration 041). */

import type { Db } from "./db.ts";

export interface SentEmail {
	id: string;
	dedup_key: string;
	recipient_contact_id: string | null;
	recipient_scope: string | null;
	address: string;
	subject: string;
	text: string;
	requested_event_id: string | null;
	requested_via: string;
	requested_by: "owner" | "contact";
	requester_contact_id: string | null;
	requester_scope: string;
	created_at: string;
}

/** The idempotency key of a mail's outbox action, without the `notice:` prefix `Outbox.sendOwn` adds. */
export const emailKey = (id: string) => `email:${id}`;
/** The SQL join from `sent_emails m` to its action `a` (by key: the action exists before `sendOwn` returns). */
export const EMAIL_ACTION_JOIN = "actions a ON a.idempotency_key = 'notice:email:' || m.id";

/**
 * One address, nothing else: a local part and a domain with a dot, no spaces,
 * quotes, angle brackets, commas or line breaks (a mail header must never be
 * able to carry a second recipient or header).
 */
const ADDRESS_RE =
	/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

export function validAddress(s: string): boolean {
	return s.length <= 254 && ADDRESS_RE.test(s) && !s.includes("..");
}

/** Every address written in a text (as a person types it: "mail it to bob@example.com, please"). */
export function addressesIn(text: string): string[] {
	const found = text.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
	return [...new Set(found.map((a) => a.replace(/\.+$/, "")).filter(validAddress))];
}

export function emailOf(db: Db, contactId: string): string | null {
	return (
		(
			(db.prepare("SELECT address FROM contact_emails WHERE contact_id = ?").get(contactId) as
				| { address: string }
				| undefined) ?? null
		)?.address ?? null
	);
}

/** The person whose stored address this is, if any. */
export function contactByEmail(db: Db, address: string): string | null {
	return (
		(
			(db.prepare("SELECT contact_id FROM contact_emails WHERE lower(address) = lower(?)").get(address) as
				| { contact_id: string }
				| undefined) ?? null
		)?.contact_id ?? null
	);
}

export function setEmail(db: Db, contactId: string, address: string, by: string, at: string): void {
	db.prepare(
		`INSERT INTO contact_emails (contact_id, address, set_by, set_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (contact_id) DO UPDATE SET address = excluded.address, set_by = excluded.set_by, set_at = excluded.set_at`,
	).run(contactId, address, by, at);
}

export function clearEmail(db: Db, contactId: string): boolean {
	return db.prepare("DELETE FROM contact_emails WHERE contact_id = ?").run(contactId).changes > 0;
}

export function insertSentEmail(db: Db, m: SentEmail): boolean {
	return (
		db
			.prepare(
				`INSERT OR IGNORE INTO sent_emails (id, dedup_key, recipient_contact_id, recipient_scope, address, subject, text,
					requested_event_id, requested_via, requested_by, requester_contact_id, requester_scope, created_at)
				 VALUES (@id, @dedup_key, @recipient_contact_id, @recipient_scope, @address, @subject, @text,
					@requested_event_id, @requested_via, @requested_by, @requester_contact_id, @requester_scope, @created_at)`,
			)
			.run(m).changes > 0
	);
}

export function sentEmailByKey(db: Db, dedupKey: string): SentEmail | undefined {
	return db.prepare("SELECT * FROM sent_emails WHERE dedup_key = ?").get(dedupKey) as SentEmail | undefined;
}

/** `/sent`'s email part: the latest mails, with the state their action rests on. */
export function emailReportLines(db: Db, limit = 20): string[] {
	const rows = db
		.prepare(
			`SELECT m.*, a.id AS action_id, a.state, c.display_name, r.display_name AS requester FROM sent_emails m
			 LEFT JOIN ${EMAIL_ACTION_JOIN} LEFT JOIN contacts c ON c.id = m.recipient_contact_id
			 LEFT JOIN contacts r ON r.id = m.requester_contact_id
			 ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
		)
		.all(limit) as (SentEmail & {
		action_id: string | null;
		state: string | null;
		display_name: string | null;
		requester: string | null;
	})[];
	if (rows.length === 0) return [];
	return [
		"",
		`emails Iyye sent (latest ${limit}; delivered = accepted by the mail server, not read):`,
		...rows.map((r) => {
			const to =
				r.recipient_contact_id === "owner"
					? "you"
					: r.display_name
						? `${r.display_name} <${r.address}>`
						: r.address;
			const asked =
				r.requested_by === "owner"
					? `asked by you in the ${r.requested_via}`
					: `asked by ${JSON.stringify((r.requester ?? "a contact").slice(0, 64))} on ${r.requested_via}`;
			return `  ${r.created_at.slice(0, 16).replace("T", " ")} to ${to} (${asked}) · ${r.state ?? "not sent"} · ${JSON.stringify(r.subject.slice(0, 80))}`;
		}),
	];
}
