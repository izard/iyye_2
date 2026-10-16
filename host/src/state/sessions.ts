// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "./db.ts";

export function getSessionFile(db: Db, scope: string): string | null {
	const row = db.prepare("SELECT session_file FROM pi_sessions WHERE scope = ?").get(scope) as
		| { session_file: string }
		| undefined;
	return row?.session_file ?? null;
}

export function recordSessionFile(db: Db, scope: string, file: string, at: string): void {
	db.prepare(
		`INSERT INTO pi_sessions (scope, session_file, created_at, last_used_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (scope) DO UPDATE SET session_file = excluded.session_file, last_used_at = excluded.last_used_at`,
	).run(scope, file, at, at);
}

/**
 * Retire every conversation's transcript (owner decision, 2026-10-03: chat
 * history does not survive the night). The next turn of each scope opens a
 * fresh Pi session; the old transcript files stay on disk for audit.
 */
export function retireSessions(db: Db): number {
	return db.prepare("DELETE FROM pi_sessions").run().changes;
}

export function forgetSession(db: Db, scope: string): void {
	db.prepare("DELETE FROM pi_sessions WHERE scope = ?").run(scope);
}

export function touchSession(db: Db, scope: string, at: string): void {
	db.prepare("UPDATE pi_sessions SET last_used_at = ? WHERE scope = ?").run(at, scope);
}

/** The conversation key of a person's mail (plan 0.016): the same person (scope), a separate transcript. */
export function emailSession(scope: string): string {
	return `${scope}#email`;
}
