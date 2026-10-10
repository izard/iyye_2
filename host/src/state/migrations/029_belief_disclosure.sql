-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.011 F4: beliefs in recall, and who may be told them (owner
-- decision 1, revised 2026-10-07).
--
-- A fact is private when the host's rules say so (the speaker asked;
-- credentials; health; money; addresses): private facts reach only their
-- speaker and the owner. The flag is set at extraction and copied onto the
-- evidence row, so a belief is private when any of its evidence is. The
-- owner overrides a belief either way (`/facts private|share`).
--
-- `beliefs_fts` is the lexical index recall searches, kept by triggers.
-- `recalled_at` marks a belief offered in a turn (a curiosity signal counts
-- a used, uncertain belief as important).

ALTER TABLE stm_facts ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE belief_evidence ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE beliefs ADD COLUMN disclosure TEXT CHECK (disclosure IN ('private', 'share'));
ALTER TABLE beliefs ADD COLUMN recalled_at TEXT;

CREATE VIRTUAL TABLE beliefs_fts USING fts5 (
	belief_id UNINDEXED,
	body,
	tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO beliefs_fts (belief_id, body)
	SELECT id, subject || ' ' || replace(predicate, '_', ' ') || ' ' || object || ' ' || coalesce(details, '') FROM beliefs;

CREATE TRIGGER beliefs_fts_insert AFTER INSERT ON beliefs BEGIN
	INSERT INTO beliefs_fts (belief_id, body)
		VALUES (NEW.id, NEW.subject || ' ' || replace(NEW.predicate, '_', ' ') || ' ' || NEW.object || ' ' || coalesce(NEW.details, ''));
END;

CREATE TRIGGER beliefs_fts_delete AFTER DELETE ON beliefs BEGIN
	DELETE FROM beliefs_fts WHERE belief_id = OLD.id;
END;
