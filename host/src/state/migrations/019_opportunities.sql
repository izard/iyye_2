-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Opportunities and investigations (plan 0.007 S5, HLD §5.3).
--
-- One opportunity per evidence cluster (`cluster` is unique): in this
-- increment the cluster is the finding (an `observations` row) that raised a
-- question. Its counters live here, so the bounds survive restarts (1.x
-- lesson): at most 3 fruitless attempts, a cooldown after each, and a settled
-- cluster never qualifies again.

CREATE TABLE opportunities (
	id TEXT PRIMARY KEY,
	cluster TEXT NOT NULL UNIQUE,
	domain TEXT NOT NULL,
	-- The evidence: observation ids (JSON), and the question it raises.
	evidence_json TEXT NOT NULL,
	evidence_text TEXT NOT NULL,
	question TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('open', 'running', 'settled', 'suspended')),
	attempts INTEGER NOT NULL DEFAULT 0,
	fruitless INTEGER NOT NULL DEFAULT 0,
	-- The running attempt: its Pi session, its steps so far, and when it started.
	session TEXT,
	steps INTEGER NOT NULL DEFAULT 0,
	attempt_started_at TEXT,
	cooldown_until TEXT,
	-- Kev's shadow initiative answer for the latest attempt.
	decision_id TEXT,
	answer TEXT,
	finding_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX opportunities_status ON opportunities (status, created_at);
