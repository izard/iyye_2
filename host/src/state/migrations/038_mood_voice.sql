-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0

-- Plan 0.009 CH2 and CH3: mood from records, and the voice in shadow.

-- The voice model gets its own selection (never loaded by the host on its own).
CREATE TABLE model_selection_new (
	channel TEXT PRIMARY KEY CHECK (channel IN ('web', 'telegram', 'memory', 'background', 'voice')),
	model_name TEXT NOT NULL,
	set_by TEXT NOT NULL,
	set_at TEXT NOT NULL
);
INSERT INTO model_selection_new (channel, model_name, set_by, set_at)
	SELECT channel, model_name, set_by, set_at FROM model_selection;
DROP TABLE model_selection;
ALTER TABLE model_selection_new RENAME TO model_selection;

-- CH2: one mood snapshot, computed from records at or before `as_of`, with the records it used.
-- `scope` NULL: the global part only (energy, ease); otherwise also that conversation's engagement.
CREATE TABLE mood_samples (
	id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	as_of TEXT NOT NULL,
	scope TEXT,
	version INTEGER NOT NULL,
	energy REAL,
	ease REAL NOT NULL,
	engagement REAL,
	sources_json TEXT NOT NULL,
	reason TEXT NOT NULL CHECK (reason IN ('sweep', 'voice', 'command'))
);
CREATE INDEX mood_samples_at ON mood_samples (as_of);
CREATE INDEX mood_samples_scope ON mood_samples (scope, as_of);

-- CH3: which part of the evaluation design an original belongs to, fixed when it is first seen
-- (a salted hash of the action id) and never changed: `eval` is the sealed evaluation set.
CREATE TABLE voice_split (
	action_id TEXT PRIMARY KEY,
	split TEXT NOT NULL CHECK (split IN ('eval', 'dev')),
	assigned_at TEXT NOT NULL
);
CREATE TRIGGER voice_split_no_update BEFORE UPDATE ON voice_split
BEGIN
	SELECT RAISE(ABORT, 'the voice evaluation split is sealed');
END;
CREATE TRIGGER voice_split_no_delete BEFORE DELETE ON voice_split
BEGIN
	SELECT RAISE(ABORT, 'the voice evaluation split is sealed');
END;

-- CH3: one shadow rephrasing of one delivered Telegram message by one model; the original was delivered.
-- `segments_json` (the placeholder mapping) never leaves SQLite: training exports carry masked text only.
CREATE TABLE voice_samples (
	id TEXT PRIMARY KEY,
	action_id TEXT NOT NULL REFERENCES actions (id),
	event_id TEXT,
	scope TEXT,
	person_id TEXT,
	audience TEXT NOT NULL CHECK (audience IN ('owner', 'trusted', 'contact')),
	lang TEXT NOT NULL CHECK (lang IN ('en', 'ru', 'other')),
	original TEXT NOT NULL,
	masked TEXT NOT NULL,
	segments_json TEXT NOT NULL,
	model TEXT NOT NULL,
	prompt_version TEXT NOT NULL,
	-- The instructions as given (the frozen prompt with the character's style and the mood in words).
	system TEXT NOT NULL,
	adapter TEXT,
	character_rev INTEGER,
	mood_sample_id TEXT REFERENCES mood_samples (id),
	output TEXT,
	candidate TEXT,
	status TEXT NOT NULL CHECK (status IN ('accepted', 'refused', 'unchanged', 'error', 'forgotten')),
	problem TEXT,
	ms INTEGER,
	kev_decision_id TEXT,
	kev_same REAL,
	created_at TEXT NOT NULL,
	UNIQUE (action_id, model, prompt_version)
);
CREATE INDEX voice_samples_created ON voice_samples (created_at);
CREATE INDEX voice_samples_person ON voice_samples (person_id);

-- CH3: the owner's labels, two kinds kept apart. `meaning`: same | changed (did it keep every fact,
-- doubt, promise, refusal and problem?). `preference`: better | worse (the Iyye the owner wants), with an
-- optional correction in the owner's own words. One current label of each kind per sample.
CREATE TABLE voice_labels (
	sample_id TEXT NOT NULL REFERENCES voice_samples (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('meaning', 'preference')),
	value TEXT NOT NULL CHECK (value IN ('same', 'changed', 'better', 'worse')),
	correction TEXT,
	by TEXT NOT NULL,
	at TEXT NOT NULL,
	PRIMARY KEY (sample_id, kind),
	CHECK ((kind = 'meaning') = (value IN ('same', 'changed'))),
	CHECK (correction IS NULL OR kind = 'preference')
);

-- CH3: every look at the sealed evaluation set's results, by whom and why.
CREATE TABLE voice_eval_reads (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	by TEXT NOT NULL,
	samples INTEGER NOT NULL,
	labelled INTEGER NOT NULL
);
