// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import type { Channel } from "../channels/types.ts";
import type { Db } from "./db.ts";

export const OWNER_CONTACT_ID = "owner";

export type ContactKind = "owner" | "contact";
export type VerifiedBy = "owner_local" | "first_contact";

export interface Contact {
	id: string;
	display_name: string;
	kind: ContactKind;
	created_at: string;
	trusted: 0 | 1;
	trust_changed_by: string | null;
	trust_changed_at: string | null;
}

export interface ContactSummary extends Contact {
	bindings: string;
	last_seen: string | null;
}

export function getContact(db: Db, id: string): Contact | undefined {
	return db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Contact | undefined;
}

export function findContactByBinding(db: Db, channel: Channel, externalId: string): Contact | undefined {
	return db
		.prepare(
			`SELECT c.* FROM contacts c
			 JOIN channel_bindings b ON b.contact_id = c.id
			 WHERE b.channel = ? AND b.external_id = ?`,
		)
		.get(channel, externalId) as Contact | undefined;
}

/** Create a non-owner contact together with its first channel binding. */
export function createContactWithBinding(
	db: Db,
	args: { id: string; displayName: string; channel: Channel; externalId: string; verifiedBy: VerifiedBy; at: string },
): Contact {
	db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', ?)").run(
		args.id,
		args.displayName,
		args.at,
	);
	db.prepare(
		"INSERT INTO channel_bindings (contact_id, channel, external_id, verified_by, created_at) VALUES (?, ?, ?, ?, ?)",
	).run(args.id, args.channel, args.externalId, args.verifiedBy, args.at);
	return getContact(db, args.id)!;
}

/**
 * The person an account belongs to (plan 0.005): itself unless the owner
 * linked it to another contact or to the owner. The only way a principal is
 * decided; links are one level, so this never chains.
 */
export function resolvePerson(db: Db, account: Contact): Contact {
	const row = db.prepare("SELECT person_id FROM contact_links WHERE account_id = ?").get(account.id) as
		| { person_id: string }
		| undefined;
	return (row && getContact(db, row.person_id)) || account;
}

/** The accounts linked to a person (not including the person's own row). */
export function accountsOf(db: Db, personId: string): Contact[] {
	return db
		.prepare(
			"SELECT c.* FROM contact_links l JOIN contacts c ON c.id = l.account_id WHERE l.person_id = ? ORDER BY l.linked_at",
		)
		.all(personId) as Contact[];
}

/** The person an account is linked to, if any. */
export function linkOf(
	db: Db,
	accountId: string,
): { person_id: string; linked_by: string; linked_at: string } | undefined {
	return db.prepare("SELECT person_id, linked_by, linked_at FROM contact_links WHERE account_id = ?").get(accountId) as
		| { person_id: string; linked_by: string; linked_at: string }
		| undefined;
}

/**
 * Link an account to a person (or the owner). Owner operation only. Refuses
 * chains: a linked account cannot be a person, and a person with accounts
 * cannot become an account.
 */
export function linkAccount(db: Db, accountId: string, personId: string, by: string, at: string): void {
	db.transaction(() => {
		if (accountId === personId) throw new Error("an account cannot be linked to itself");
		if (accountId === OWNER_CONTACT_ID) throw new Error("the owner is a person, not an account");
		if (linkOf(db, personId)) throw new Error("the target is itself a linked account; link to its person instead");
		if (accountsOf(db, accountId).length > 0)
			throw new Error("this contact has linked accounts of its own; unlink them first");
		db.prepare(
			`INSERT INTO contact_links (account_id, person_id, linked_by, linked_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (account_id) DO UPDATE SET person_id = excluded.person_id, linked_by = excluded.linked_by, linked_at = excluded.linked_at`,
		).run(accountId, personId, by, at);
	})();
}

export function unlinkAccount(db: Db, accountId: string): boolean {
	return db.prepare("DELETE FROM contact_links WHERE account_id = ?").run(accountId).changes > 0;
}

export function scopeFor(contact: Contact): string {
	return contact.kind === "owner" ? "owner" : `contact:${contact.id}`;
}

/** Every non-owner contact with its channel bindings and when it last wrote. */
export function listContacts(db: Db): ContactSummary[] {
	return db
		.prepare(
			`SELECT c.*,
				(SELECT group_concat(b.channel || ':' || b.external_id, ', ') FROM channel_bindings b WHERE b.contact_id = c.id) AS bindings,
				(SELECT max(e.received_at) FROM events e WHERE e.principal_contact_id = c.id) AS last_seen
			 FROM contacts c WHERE c.kind = 'contact' ORDER BY c.created_at`,
		)
		.all() as ContactSummary[];
}

/**
 * Contacts matching an owner's reference: an exact id, an id prefix of at
 * least 6 characters, a Telegram user id, or a display name (case-insensitive).
 */
export function findContacts(db: Db, ref: string): Contact[] {
	const r = ref.trim().replace(/^@/, "");
	if (!r) return [];
	return db
		.prepare(
			`SELECT DISTINCT c.* FROM contacts c
			 LEFT JOIN channel_bindings b ON b.contact_id = c.id
			 WHERE c.kind = 'contact' AND (
				c.id = ? OR (length(?) >= 6 AND substr(c.id, 1, length(?)) = ?)
				OR (b.channel = 'telegram' AND b.external_id = ?)
				OR lower(c.display_name) = lower(?) OR lower(c.display_name) = lower('@' || ?)
			 )`,
		)
		.all(r, r, r, r, r, r, r) as Contact[];
}

export function setTrusted(db: Db, contactId: string, trusted: boolean, by: string, at: string): void {
	db.prepare(
		"UPDATE contacts SET trusted = ?, trust_changed_by = ?, trust_changed_at = ? WHERE id = ? AND kind = 'contact'",
	).run(trusted ? 1 : 0, by, at, contactId);
}
