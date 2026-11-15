-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- The offline decision-training session (plan 0.017 N3) and the registry it writes candidates into.
--
-- One row per session that took the lock: what it did and why (records only, nothing anyone said).
-- A row with no `ended_at` is a session that was killed; the next one closes it.
CREATE TABLE decision_training_sessions (
	id TEXT PRIMARY KEY,
	started_at TEXT NOT NULL,
	ended_at TEXT,
	outcome TEXT CHECK (outcome IN ('skipped', 'candidate', 'stopped', 'failed')),
	reason TEXT,
	dataset_id TEXT REFERENCES decision_datasets (id) ON DELETE SET NULL,
	artifact_id TEXT,
	summary_json TEXT,
	CHECK ((ended_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX decision_training_sessions_started ON decision_training_sessions (started_at);

-- The registry (plan 0.017 §3.4): a candidate exists for Iyye only as a row here. A directory with no row is
-- never loaded and is deleted by the next session. N3 writes `candidate` rows; nothing reads them yet.
CREATE TABLE decision_artifacts (
	id TEXT PRIMARY KEY,
	state TEXT NOT NULL CHECK (state IN ('candidate', 'evaluated', 'shadow', 'active', 'retired', 'quarantined')),
	-- The released pin it was trained from: always the clean base, never another candidate (decision 5).
	parent TEXT NOT NULL,
	dataset_id TEXT NOT NULL REFERENCES decision_datasets (id),
	dataset_hash TEXT NOT NULL,
	-- sha256 of the candidate directory's manifest.json, which names every file's hash.
	manifest_sha256 TEXT NOT NULL,
	-- The questions it was trained on, with their class counts.
	trained_json TEXT NOT NULL,
	-- Fitted on the validation split only; NULL when there was nothing to fit it on. Never written into the head.
	temperature REAL,
	calibration_json TEXT,
	training_json TEXT NOT NULL,
	session_id TEXT NOT NULL REFERENCES decision_training_sessions (id),
	created_at TEXT NOT NULL
);
CREATE INDEX decision_artifacts_state ON decision_artifacts (state, created_at);
