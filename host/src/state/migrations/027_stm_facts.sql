-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.011 F1: structured facts extracted during the day.
--
-- `fact_extractions` records what was done with each document of a
-- short-term memory entry (a person's words, Iyye's reply, Iyye's finding):
-- its work list is `stm_episodes` itself, and a document without a row here
-- is still to be extracted. One row per document makes extraction
-- idempotent.
--
-- `stm_facts` are the facts the host kept after its grounding check and
-- filters, scoped like the episode they came from (recall reads them with
-- the same scope rules). The model filled only the text fields; source,
-- modality and the prior `p` are set by the host. `state` follows the fact
-- into long-term memory at night (F2).

CREATE TABLE fact_extractions (
	doc_id TEXT PRIMARY KEY,
	event_id TEXT NOT NULL,
	scope TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('person', 'reply', 'finding')),
	status TEXT NOT NULL CHECK (status IN ('done', 'failed', 'skipped')),
	attempts INTEGER NOT NULL DEFAULT 1,
	model TEXT,
	kept INTEGER NOT NULL DEFAULT 0,
	dropped_json TEXT NOT NULL DEFAULT '{}',
	bad_lines INTEGER NOT NULL DEFAULT 0,
	device_ms INTEGER,
	error TEXT,
	at TEXT NOT NULL
);

CREATE INDEX fact_extractions_event ON fact_extractions (event_id);

CREATE TABLE stm_facts (
	id TEXT PRIMARY KEY,
	doc_id TEXT NOT NULL,
	event_id TEXT NOT NULL,
	scope TEXT NOT NULL,
	modality TEXT NOT NULL CHECK (modality IN ('stated', 'measured', 'told_by_iyye', 'inferred')),
	-- "owner", a contact id, "iyye" or "probe": who said or measured it.
	source TEXT NOT NULL,
	subject TEXT NOT NULL,
	subject_ref TEXT NOT NULL,
	predicate TEXT NOT NULL,
	object TEXT NOT NULL,
	details TEXT,
	valid_from TEXT NOT NULL,
	time_frame TEXT NOT NULL,
	hedged INTEGER NOT NULL DEFAULT 0,
	negated INTEGER NOT NULL DEFAULT 0,
	quote TEXT NOT NULL,
	cited TEXT,
	fact_key TEXT NOT NULL,
	p REAL NOT NULL,
	said_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'day' CHECK (state IN ('day', 'merged', 'dropped')),
	merged_at TEXT,
	belief_id TEXT
);

CREATE INDEX stm_facts_state ON stm_facts (state, scope, said_at);
CREATE INDEX stm_facts_event ON stm_facts (event_id);
CREATE INDEX stm_facts_key ON stm_facts (fact_key);

CREATE VIRTUAL TABLE stm_facts_fts USING fts5 (
	fact_id UNINDEXED,
	scope UNINDEXED,
	body,
	tokenize = 'unicode61 remove_diacritics 2'
);
