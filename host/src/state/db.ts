// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";

export type Db = Database.Database;

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

/**
 * Open the Iyye control-state database and bring its schema up to date.
 * `path` is a file path, or ":memory:" for tests.
 */
export function openDb(path: string): Db {
	const db = new Database(path);
	if (path !== ":memory:") {
		db.pragma("journal_mode = WAL");
	}
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	migrate(db);
	return db;
}

/**
 * Apply every migration in `migrations/` not yet recorded, in filename order.
 * Each file and its bookkeeping row commit in one transaction, so a failed
 * migration leaves no partial schema behind. Re-running is a no-op.
 */
export function migrate(db: Db): string[] {
	db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		name TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`);
	const applied = new Set(
		(db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name),
	);
	const pending = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql") && !applied.has(f))
		.sort();
	const record = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
	for (const name of pending) {
		const sql = readFileSync(new URL(name, MIGRATIONS_DIR), "utf8");
		db.transaction(() => {
			db.exec(sql);
			record.run(name, new Date().toISOString());
		})();
	}
	return pending;
}
