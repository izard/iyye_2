// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrate, openDb } from "../src/state/db.ts";

test("migrations apply once, in order, and re-running is a no-op", () => {
	const db = openDb(":memory:");
	assert.deepEqual(migrate(db), []);
	const files = readdirSync(new URL("../src/state/migrations/", import.meta.url))
		.filter((f) => f.endsWith(".sql"))
		.sort();
	assert.ok(files[0] === "001_init.sql" && files.length >= 4);
	const names = (db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[]).map(
		(r) => r.name,
	);
	assert.deepEqual(names, files);
});

test("owner contact and its web binding are seeded", () => {
	const db = openDb(":memory:");
	assert.deepEqual(db.prepare("SELECT id, kind FROM contacts").all(), [{ id: "owner", kind: "owner" }]);
	assert.deepEqual(db.prepare("SELECT contact_id, channel, external_id, verified_by FROM channel_bindings").all(), [
		{ contact_id: "owner", channel: "web", external_id: "owner", verified_by: "owner_local" },
	]);
});

test("a second owner cannot exist", () => {
	const db = openDb(":memory:");
	assert.throws(() =>
		db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('x', 'X', 'owner', 'now')").run(),
	);
});

test("enum columns reject unknown values", () => {
	const db = openDb(":memory:");
	assert.throws(() =>
		db
			.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('x', 'X', 'administrator', 'now')")
			.run(),
	);
});

test("a file database survives reopening without re-migrating", () => {
	const dir = mkdtempSync(join(tmpdir(), "iyye-db-"));
	try {
		const path = join(dir, "iyye.db");
		openDb(path).close();
		const db = openDb(path);
		assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n, 1);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
