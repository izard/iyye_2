-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0

-- Plan 0.018 W7: maintenance. Each run of an action, by the owner's command
-- or by Iyye at the end of a night, with what it removed (names relative to
-- the state directory, and sizes); and the actions the owner allowed Iyye to
-- run on its own.

CREATE TABLE maintenance_runs (
	id TEXT PRIMARY KEY,
	action TEXT NOT NULL,
	by TEXT NOT NULL CHECK (by IN ('owner', 'iyye')),
	reason TEXT NOT NULL,
	at TEXT NOT NULL,
	freed_bytes INTEGER NOT NULL,
	removed_json TEXT NOT NULL,
	error TEXT
);

CREATE INDEX maintenance_runs_at ON maintenance_runs (at);

CREATE TABLE maintenance_allowed (
	action TEXT PRIMARY KEY,
	at TEXT NOT NULL
);
