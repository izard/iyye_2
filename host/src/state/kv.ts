// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "./db.ts";

export function getKv(db: Db, key: string): string | null {
	const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
	return row?.value ?? null;
}

/** Set the value only if the key has none yet; returns the stored value either way. */
export function initKv(db: Db, key: string, value: string, at: string): string {
	db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING").run(
		key,
		value,
		at,
	);
	return getKv(db, key)!;
}

export function setKv(db: Db, key: string, value: string, at: string): void {
	db.prepare(
		"INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
	).run(key, value, at);
}
