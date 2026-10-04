-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Acting decisions (plan 0.004 §3.4, as built): a role whose answer changes
-- what Iyye does is journaled `acting`, a role that is only compared with what
-- happened stays `shadow`. SQLite cannot change a CHECK, so the table is
-- rebuilt with every column and index; rows keep their mode.

CREATE TABLE decisions_new (
	id TEXT PRIMARY KEY,
	role TEXT NOT NULL,
	schema_version INTEGER NOT NULL,
	mode TEXT NOT NULL CHECK (mode IN ('shadow', 'acting')),
	scope TEXT,
	subject_ref TEXT,
	state_json TEXT NOT NULL,
	state_hash TEXT NOT NULL,
	questions_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
	error TEXT,
	checkpoint TEXT,
	base_model TEXT,
	temperature REAL,
	backend TEXT,
	answers_json TEXT,
	verdicts_json TEXT,
	latency_ms INTEGER,
	created_at TEXT NOT NULL,
	outcome_json TEXT,
	outcome_source TEXT,
	outcome_at TEXT,
	lora INTEGER,
	dtype TEXT,
	label_strength TEXT CHECK (label_strength IN ('weak', 'owner'))
);

INSERT INTO decisions_new (id, role, schema_version, mode, scope, subject_ref, state_json, state_hash, questions_json,
	status, error, checkpoint, base_model, temperature, backend, answers_json, verdicts_json, latency_ms, created_at,
	outcome_json, outcome_source, outcome_at, lora, dtype, label_strength)
SELECT id, role, schema_version, mode, scope, subject_ref, state_json, state_hash, questions_json,
	status, error, checkpoint, base_model, temperature, backend, answers_json, verdicts_json, latency_ms, created_at,
	outcome_json, outcome_source, outcome_at, lora, dtype, label_strength
FROM decisions;

DROP TABLE decisions;
ALTER TABLE decisions_new RENAME TO decisions;
CREATE INDEX decisions_role_time ON decisions (role, created_at);
CREATE INDEX decisions_role_subject ON decisions (role, subject_ref);
