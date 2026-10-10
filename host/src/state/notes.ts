// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-stated notes about a person (plan 0.005 Stage 2). Only owner commands
 * write them. A note is about a person (a contact that is not itself a linked
 * account); its visibility decides whose turns may see it.
 */

import type { Db } from "./db.ts";

export type NoteVisibility = "owner" | "person";

export interface PersonNote {
	id: string;
	person_id: string;
	text: string;
	visibility: NoteVisibility;
	created_by: string;
	created_at: string;
	changed_at: string;
}

export const NOTE_MAX_CHARS = 1000;

export function addNote(
	db: Db,
	n: { id: string; personId: string; text: string; visibility: NoteVisibility; by: string; at: string },
): PersonNote {
	db.prepare(
		"INSERT INTO person_notes (id, person_id, text, visibility, created_by, created_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(n.id, n.personId, n.text.trim().slice(0, NOTE_MAX_CHARS), n.visibility, n.by, n.at, n.at);
	return db.prepare("SELECT * FROM person_notes WHERE id = ?").get(n.id) as PersonNote;
}

/**
 * A person's notes, oldest first: those written about them and about their linked accounts (a note written
 * before a link stays with whoever the account belongs to now); only those of `visibility` when given.
 */
export function notesAbout(db: Db, personId: string, visibility?: NoteVisibility): PersonNote[] {
	const ids = [personId, ...accountIds(db, personId)];
	return db
		.prepare(
			`SELECT * FROM person_notes WHERE person_id IN (${ids.map(() => "?").join(", ")}) ${visibility ? "AND visibility = ?" : ""} ORDER BY created_at, rowid`,
		)
		.all(...ids, ...(visibility ? [visibility] : [])) as PersonNote[];
}

function accountIds(db: Db, personId: string): string[] {
	return (
		db.prepare("SELECT account_id FROM contact_links WHERE person_id = ?").all(personId) as { account_id: string }[]
	).map((r) => r.account_id);
}

/** Notes whose id starts with this prefix (at least 6 characters). */
export function findNotes(db: Db, ref: string): PersonNote[] {
	const r = ref.trim();
	if (r.length < 6) return [];
	return db.prepare("SELECT * FROM person_notes WHERE substr(id, 1, ?) = ?").all(r.length, r) as PersonNote[];
}

export function setNoteVisibility(db: Db, id: string, visibility: NoteVisibility, at: string): void {
	db.prepare("UPDATE person_notes SET visibility = ?, changed_at = ? WHERE id = ?").run(visibility, at, id);
}

export function deleteNote(db: Db, id: string): void {
	db.prepare("DELETE FROM person_notes WHERE id = ?").run(id);
}

/** `/forget`: every note about these people and their linked accounts. */
export function forgetNotes(db: Db, personIds: readonly string[]): number {
	let n = 0;
	for (const id of personIds.flatMap((p) => [p, ...accountIds(db, p)]))
		n += db.prepare("DELETE FROM person_notes WHERE person_id = ?").run(id).changes;
	return n;
}
