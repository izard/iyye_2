-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Decision datasets (plan 0.017 N2): what a training session trains and judges on, frozen before it starts.
--
-- A sealed test set is a range of days. While it is active, no example of those days is trained on, used for
-- calibration or looked at outside an evaluation, and every look is a row here. It never changes its days and,
-- once retired (looked at too often, or replaced by a fresh one from later days), stays retired: only then do
-- its days join the training period.
CREATE TABLE decision_test_sets (
	id TEXT PRIMARY KEY,
	from_day TEXT NOT NULL,
	to_day TEXT NOT NULL,
	created_at TEXT NOT NULL,
	retired_at TEXT,
	retired_reason TEXT CHECK (retired_reason IN ('looks', 'superseded')),
	CHECK (from_day <= to_day),
	CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);
CREATE UNIQUE INDEX decision_test_sets_one_active ON decision_test_sets ((retired_at IS NULL)) WHERE retired_at IS NULL;
CREATE TRIGGER decision_test_sets_days_sealed BEFORE UPDATE OF id, from_day, to_day, created_at ON decision_test_sets
BEGIN
	SELECT RAISE(ABORT, 'a sealed test set never changes its days');
END;
CREATE TRIGGER decision_test_sets_stay_retired BEFORE UPDATE OF retired_at, retired_reason ON decision_test_sets
WHEN OLD.retired_at IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'a retired test set stays retired');
END;
CREATE TRIGGER decision_test_sets_no_delete BEFORE DELETE ON decision_test_sets
BEGIN
	SELECT RAISE(ABORT, 'a test set is never deleted: later ones must start after it');
END;

-- One frozen dataset: the policy it was cut under and its manifest (row ids, their split, each label's source
-- and strength, the exclusions by reason; ids and hashes only, never what anyone said and never a name).
CREATE TABLE decision_datasets (
	id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	created_by TEXT NOT NULL,
	test_set_id TEXT NOT NULL REFERENCES decision_test_sets (id),
	policy_json TEXT NOT NULL,
	manifest_json TEXT NOT NULL,
	manifest_hash TEXT NOT NULL
);
CREATE TRIGGER decision_datasets_frozen BEFORE UPDATE ON decision_datasets
BEGIN
	SELECT RAISE(ABORT, 'a dataset is frozen');
END;

-- Every time a test set's rows left the database (an evaluation, an inspection the owner asked for).
CREATE TABLE decision_test_looks (
	id INTEGER PRIMARY KEY,
	test_set_id TEXT NOT NULL REFERENCES decision_test_sets (id),
	dataset_id TEXT REFERENCES decision_datasets (id) ON DELETE SET NULL,
	at TEXT NOT NULL,
	by TEXT NOT NULL,
	purpose TEXT NOT NULL
);
CREATE INDEX decision_test_looks_set ON decision_test_looks (test_set_id);
CREATE TRIGGER decision_test_looks_kept BEFORE DELETE ON decision_test_looks
BEGIN
	SELECT RAISE(ABORT, 'looks at a test set are never forgotten');
END;
