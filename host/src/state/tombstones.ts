// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory tombstones (plan 0.002 L6, HLD §6.4): what a forgotten scope said
 * before it was forgotten never enters memory again. Scope and time, not
 * event ids: what the person says after `/forget` is remembered normally.
 */

import type { Db } from "./db.ts";

/** The latest time this scope was forgotten, or null. */
export function forgottenAt(db: Db, scope: string): string | null {
	const row = db.prepare("SELECT max(forgotten_at) AS t FROM memory_tombstones WHERE scope = ?").get(scope) as {
		t: string | null;
	};
	return row.t;
}

/** True when something said at `at` in `scope` was forgotten afterwards. */
export function isForgotten(db: Db, scope: string, at: string): boolean {
	const t = forgottenAt(db, scope);
	return t !== null && at <= t;
}

export function addTombstone(db: Db, scope: string, at: string, by: string): void {
	db.prepare("INSERT OR IGNORE INTO memory_tombstones (scope, forgotten_at, forgotten_by) VALUES (?, ?, ?)").run(
		scope,
		at,
		by,
	);
}

export interface PendingBankDeletion {
	bank: string;
	scope: string;
	requested_at: string;
	attempts: number;
	last_error: string | null;
}

export function pendingBankDeletions(db: Db): PendingBankDeletion[] {
	return db.prepare("SELECT * FROM bank_deletions_pending ORDER BY requested_at").all() as PendingBankDeletion[];
}

export function queueBankDeletion(db: Db, bank: string, scope: string, at: string): void {
	db.prepare(
		"INSERT INTO bank_deletions_pending (bank, scope, requested_at) VALUES (?, ?, ?) ON CONFLICT (bank) DO NOTHING",
	).run(bank, scope, at);
}

export function bankDeletionDone(db: Db, bank: string): void {
	db.prepare("DELETE FROM bank_deletions_pending WHERE bank = ?").run(bank);
}

export function bankDeletionFailed(db: Db, bank: string, error: string): void {
	db.prepare("UPDATE bank_deletions_pending SET attempts = attempts + 1, last_error = ? WHERE bank = ?").run(
		error.slice(0, 300),
		bank,
	);
}
