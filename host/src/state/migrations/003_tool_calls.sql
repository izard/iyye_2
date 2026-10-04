-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Every tool call the broker handled, including refusals (plan M3b, HLD §3.1:
-- consequential decisions record their inputs, policy and outcome).

CREATE TABLE tool_calls (
	id TEXT PRIMARY KEY,
	scope TEXT NOT NULL,
	principal TEXT NOT NULL CHECK (principal IN ('owner', 'contact')),
	tool TEXT NOT NULL,
	args_json TEXT NOT NULL,
	outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'error')),
	result TEXT,
	started_at TEXT NOT NULL,
	finished_at TEXT NOT NULL
);

CREATE INDEX tool_calls_scope ON tool_calls (scope, started_at);
