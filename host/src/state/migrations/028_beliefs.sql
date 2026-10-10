-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.011 F2: beliefs and the nightly merge.
--
-- A belief is one value of a fact key (subject | predicate), with its
-- validity. It is common to every source (owner decision 1: one Iyye-
-- observable world model); what a reader is shown stays scoped by its
-- evidence. Its probability is never stored on its own authority: `p` is a
-- cache of the fold over `belief_evidence` (log-odds, from 0.5), so removing
-- a person's evidence (`/forget`) recomputes it exactly.
--
-- Each evidence row is one structured fact (or an owner correction) with its
-- sign (+1 supports, -1 contradicts) and the weight the merge applied:
-- 0 for a source that already supports the belief, for Iyye's echo of an
-- existing belief, and scaled down by the nightly cap.
--
-- A suppression (`/facts wrong`, owner decision 2) keeps the evidence said
-- before it from re-creating a deleted belief; new evidence may.

CREATE TABLE beliefs (
	id TEXT PRIMARY KEY,
	fact_key TEXT NOT NULL,
	subject_ref TEXT NOT NULL,
	subject TEXT NOT NULL,
	predicate TEXT NOT NULL,
	object TEXT NOT NULL,
	object_norm TEXT NOT NULL,
	negated INTEGER NOT NULL DEFAULT 0,
	details TEXT,
	time_frame TEXT NOT NULL,
	valid_from TEXT NOT NULL,
	-- Set when a later value of a single-valued key replaced it ("lived in Berlin until 2025").
	valid_to TEXT,
	p REAL NOT NULL,
	state TEXT NOT NULL DEFAULT 'current' CHECK (state IN ('current', 'closed')),
	closed_by TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (fact_key, object_norm, negated)
);

CREATE INDEX beliefs_key ON beliefs (fact_key, state);
CREATE INDEX beliefs_subject ON beliefs (subject_ref);

CREATE TABLE belief_evidence (
	id TEXT PRIMARY KEY,
	belief_id TEXT NOT NULL REFERENCES beliefs (id) ON DELETE CASCADE,
	-- The structured fact, or null for an owner correction (`/facts correct`).
	stm_fact_id TEXT,
	-- "owner", a contact id, "iyye" or "probe".
	source TEXT NOT NULL,
	scope TEXT NOT NULL,
	event_id TEXT,
	modality TEXT NOT NULL,
	sign INTEGER NOT NULL CHECK (sign IN (-1, 1)),
	source_p REAL NOT NULL,
	weight REAL NOT NULL,
	relation TEXT NOT NULL CHECK (relation IN ('new', 'corroborates', 'contradicts', 'changes', 'correction')),
	night TEXT NOT NULL,
	at TEXT NOT NULL
);

CREATE INDEX belief_evidence_belief ON belief_evidence (belief_id);
CREATE INDEX belief_evidence_source ON belief_evidence (source, scope);

CREATE TABLE belief_suppressions (
	fact_key TEXT NOT NULL,
	object_norm TEXT NOT NULL,
	negated INTEGER NOT NULL,
	-- Facts said up to this time never re-create the belief.
	until_at TEXT NOT NULL,
	by TEXT NOT NULL,
	PRIMARY KEY (fact_key, object_norm, negated)
);

-- When a merged fact's text was stored in long-term memory (document `fact:<id>`); null until then, so a
-- night that could not store it retries on the next one.
ALTER TABLE stm_facts ADD COLUMN stored_at TEXT;
