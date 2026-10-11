-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.009 CH1a: Iyye's character as immutable revisions (HLD §4.2). Each
-- row holds the whole state (temperament multipliers, style dials, interests
-- and habits, each value with its source); the active revision is a pointer
-- in `kv` (`character.active`), mirrored to `~/.iyye2/character.json`. A
-- change is always a new row: undo and reset too. `review` is CH5's nightly
-- review, accepted here so the constraint never needs rebuilding.
--
-- `character_evidence` stays empty until CH5: the records a reviewed revision
-- rests on, with the person they came from, so `/forget` can find them.

CREATE TABLE character_revisions (
	rev INTEGER PRIMARY KEY,
	created_at TEXT NOT NULL,
	parent_rev INTEGER REFERENCES character_revisions (rev),
	kind TEXT NOT NULL CHECK (kind IN ('start', 'owner', 'undo', 'reset', 'review')),
	state_json TEXT NOT NULL,
	by TEXT NOT NULL,
	note TEXT
);

CREATE TRIGGER character_revisions_no_update BEFORE UPDATE ON character_revisions
BEGIN
	SELECT RAISE (ABORT, 'character revisions are immutable');
END;

CREATE TRIGGER character_revisions_no_delete BEFORE DELETE ON character_revisions
BEGIN
	SELECT RAISE (ABORT, 'character revisions are immutable');
END;

CREATE TABLE character_evidence (
	rev INTEGER NOT NULL REFERENCES character_revisions (rev),
	-- expressed (the owner's or a person's stated preference), outcome (a record), hypothesis (Iyye's own guess, no weight).
	kind TEXT NOT NULL CHECK (kind IN ('expressed', 'outcome', 'hypothesis')),
	ref TEXT NOT NULL,
	person_id TEXT,
	at TEXT NOT NULL
);

CREATE INDEX character_evidence_rev ON character_evidence (rev);
CREATE INDEX character_evidence_person ON character_evidence (person_id);
