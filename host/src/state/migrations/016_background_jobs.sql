-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Background work (plan 0.007 S1): work Iyye does without a person waiting.
--
-- Background jobs have their own table, not a kind of `jobs`: a reply job
-- belongs to a triggering message, its route and its outbox actions; a
-- background step belongs to an origin (an investigation, a night phase, a
-- plan step) and to the Pi conversation that is its checkpoint.
--
-- One row is one step. `paused`: interrupted for a person at a safe
-- checkpoint, resumed later in the same session; `suspended`: paused too
-- often, left for the owner.

CREATE TABLE background_jobs (
	id TEXT PRIMARY KEY,
	origin TEXT NOT NULL,
	-- The Pi conversation the step runs in: its checkpoint.
	session TEXT NOT NULL,
	prompt TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'settled', 'failed', 'suspended')),
	model_name TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	pauses INTEGER NOT NULL DEFAULT 0,
	result TEXT,
	error TEXT,
	created_at TEXT NOT NULL,
	started_at TEXT,
	settled_at TEXT
);

CREATE INDEX background_jobs_status ON background_jobs (status, created_at);

-- The model background work runs on gets its own selection.
CREATE TABLE model_selection_new (
	channel TEXT PRIMARY KEY CHECK (channel IN ('web', 'telegram', 'memory', 'background')),
	model_name TEXT NOT NULL,
	set_by TEXT NOT NULL,
	set_at TEXT NOT NULL
);
INSERT INTO model_selection_new (channel, model_name, set_by, set_at)
	SELECT channel, model_name, set_by, set_at FROM model_selection;
DROP TABLE model_selection;
ALTER TABLE model_selection_new RENAME TO model_selection;

-- Tool calls made by Iyye's own background work have the principal `iyye`.
CREATE TABLE tool_calls_new (
	id TEXT PRIMARY KEY,
	scope TEXT NOT NULL,
	principal TEXT NOT NULL CHECK (principal IN ('owner', 'contact', 'iyye')),
	tool TEXT NOT NULL,
	args_json TEXT NOT NULL,
	outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'error')),
	result TEXT,
	started_at TEXT NOT NULL,
	finished_at TEXT NOT NULL,
	toolkit TEXT
);
INSERT INTO tool_calls_new (id, scope, principal, tool, args_json, outcome, result, started_at, finished_at, toolkit)
	SELECT id, scope, principal, tool, args_json, outcome, result, started_at, finished_at, toolkit FROM tool_calls;
DROP TABLE tool_calls;
ALTER TABLE tool_calls_new RENAME TO tool_calls;
CREATE INDEX tool_calls_scope ON tool_calls (scope, started_at);
