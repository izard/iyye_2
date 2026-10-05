-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.010 M0 and M0b.
--
-- The extended self model: one row per field of a facet (hardware, power,
-- versions, place, social), each with where it came from (a typed probe,
-- the owner's statement, a network estimate) and when. Only stable fields
-- keep a history in `self_changes`; volatile ones (battery level) just
-- update. Social-circle relations come only from the owner and are keyed by
-- contact id, so `/forget` removes them.
--
-- Motivations in shadow: every sweep's need per motivation (raw, smoothed,
-- how many sweeps it stayed high) and the signals behind it. Nothing acts
-- on these rows yet; the last row of each motivation restores the smoothed
-- need and the sustain count after a restart.

CREATE TABLE self_facts (
	facet TEXT NOT NULL,
	field TEXT NOT NULL,
	value_json TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('probe', 'owner', 'estimate')),
	source_ref TEXT,
	observed_at TEXT NOT NULL,
	PRIMARY KEY (facet, field)
);

CREATE TABLE self_changes (
	id TEXT PRIMARY KEY,
	facet TEXT NOT NULL,
	field TEXT NOT NULL,
	old_json TEXT,
	new_json TEXT,
	source TEXT NOT NULL,
	at TEXT NOT NULL
);

CREATE INDEX self_changes_time ON self_changes (at);

CREATE TABLE motivation_samples (
	id TEXT PRIMARY KEY,
	at TEXT NOT NULL,
	motivation TEXT NOT NULL CHECK (motivation IN ('self_preservation', 'curiosity', 'agency', 'social')),
	raw REAL NOT NULL,
	smoothed REAL NOT NULL,
	sustained INTEGER NOT NULL,
	signals_json TEXT NOT NULL,
	-- The evidence cluster an opportunity would be opened for (shadow: nothing is opened).
	would_open TEXT
);

CREATE INDEX motivation_samples_time ON motivation_samples (motivation, at);
