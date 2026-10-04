-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- The decision journal (plan 0.003 §3.3, HLD §3.1): every typed question Iyye
-- asked its local decision model, with the exact input, the model revision,
-- the answers, and the outcome joined later. In 0.003 every role is shadow:
-- nothing reads these rows to decide. They are shaped to become training
-- examples later (nightly learning): the input is the pre-decision state, and
-- the outcome is recorded separately with its source.

CREATE TABLE decisions (
	id TEXT PRIMARY KEY,
	role TEXT NOT NULL,
	schema_version INTEGER NOT NULL,
	mode TEXT NOT NULL CHECK (mode IN ('shadow')),
	scope TEXT,
	-- What the decision was about (e.g. a turn's start time, an event id).
	subject_ref TEXT,
	-- The exact state sent to the model (JSON), and its hash.
	state_json TEXT NOT NULL,
	state_hash TEXT NOT NULL,
	questions_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
	error TEXT,
	-- The checkpoint that answered, as the server reported it.
	checkpoint TEXT,
	base_model TEXT,
	temperature REAL,
	backend TEXT,
	answers_json TEXT,
	-- Per question: yes / no / abstain, from the role's abstention band.
	verdicts_json TEXT,
	latency_ms INTEGER,
	created_at TEXT NOT NULL,
	-- What actually happened, joined later, and where that came from.
	outcome_json TEXT,
	outcome_source TEXT,
	outcome_at TEXT
);

CREATE INDEX decisions_role_time ON decisions (role, created_at);
