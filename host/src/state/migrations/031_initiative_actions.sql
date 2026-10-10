-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.010 M3: agency and social act. Two more action kinds: `propose`
-- (Iyye proposes a plan from the owner's stated intention; the plan waits for
-- /plan approve) and `follow_up` (Iyye asks a person how a dated event they
-- mentioned went). `ref` is what the action produced: the plan's id, or the
-- sent message's id (the owner's case: the notice key). SQLite cannot change a
-- CHECK constraint in place, so the table is rebuilt, its columns named.

CREATE TABLE opportunities_new (
	id TEXT PRIMARY KEY,
	cluster TEXT NOT NULL UNIQUE,
	domain TEXT NOT NULL,
	evidence_json TEXT NOT NULL,
	evidence_text TEXT NOT NULL,
	question TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('open', 'running', 'settled', 'suspended')),
	attempts INTEGER NOT NULL DEFAULT 0,
	fruitless INTEGER NOT NULL DEFAULT 0,
	session TEXT,
	steps INTEGER NOT NULL DEFAULT 0,
	attempt_started_at TEXT,
	cooldown_until TEXT,
	decision_id TEXT,
	answer TEXT,
	finding_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	motivation TEXT NOT NULL DEFAULT 'curiosity'
		CHECK (motivation IN ('self_preservation', 'curiosity', 'agency', 'social')),
	signal_kind TEXT,
	action_kind TEXT NOT NULL DEFAULT 'investigate'
		CHECK (action_kind IN ('investigate', 'ask', 'notify', 'maintain', 'propose', 'follow_up')),
	ref TEXT
);

INSERT INTO opportunities_new (id, cluster, domain, evidence_json, evidence_text, question, status, attempts, fruitless,
	session, steps, attempt_started_at, cooldown_until, decision_id, answer, finding_id, created_at, updated_at,
	motivation, signal_kind, action_kind)
SELECT id, cluster, domain, evidence_json, evidence_text, question, status, attempts, fruitless,
	session, steps, attempt_started_at, cooldown_until, decision_id, answer, finding_id, created_at, updated_at,
	motivation, signal_kind, action_kind
FROM opportunities;

DROP TABLE opportunities;
ALTER TABLE opportunities_new RENAME TO opportunities;
CREATE INDEX opportunities_status ON opportunities (status, created_at);
