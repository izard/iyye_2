-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Observation domains and findings (plan 0.007 S4).
--
-- `observations`: every probe run of an owner-approved domain, its structured
-- result, the change against the previous run, and what was decided about it
-- (the Kev importance check, acting, with a deterministic fallback).
--
-- STM gains Iyye's own entries in the owner-readable scope `iyye`:
-- `observation` (a finding) and `summary` (the day summary, owner decision
-- 2026-10-04). They have no triggering message, no speaker contact and no
-- channel, so those become nullable for these kinds only (table rebuilt; a
-- turn and a /remember entry still require them, and a turn its action).

CREATE TABLE observations (
	id TEXT PRIMARY KEY,
	domain TEXT NOT NULL,
	at TEXT NOT NULL,
	result_json TEXT NOT NULL,
	result_hash TEXT NOT NULL,
	-- none | minor | threshold, and a one-line description of the change.
	severity TEXT NOT NULL CHECK (severity IN ('none', 'minor', 'threshold')),
	change_text TEXT,
	decision_id TEXT,
	-- How the finding was decided: kev | fallback | none.
	decided_by TEXT,
	finding INTEGER NOT NULL DEFAULT 0,
	notified_at TEXT
);
CREATE INDEX observations_domain_at ON observations (domain, at);

CREATE TABLE stm_episodes_new (
	event_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL DEFAULT 'turn' CHECK (kind IN ('turn', 'remember', 'observation', 'summary')),
	scope TEXT NOT NULL,
	channel TEXT CHECK (channel IN ('web', 'telegram')),
	contact_id TEXT REFERENCES contacts (id),
	action_id TEXT REFERENCES actions (id),
	user_text TEXT NOT NULL,
	reply_text TEXT NOT NULL,
	said_at TEXT NOT NULL,
	answered_at TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'day' CHECK (state IN ('day', 'backlog', 'completed', 'completed_empty', 'failed')),
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	transferred_at TEXT,
	CHECK ((kind = 'turn') = (action_id IS NOT NULL)),
	CHECK (kind IN ('observation', 'summary') OR (channel IS NOT NULL AND contact_id IS NOT NULL)),
	CHECK (kind NOT IN ('observation', 'summary') OR scope = 'iyye')
);
INSERT INTO stm_episodes_new
	SELECT event_id, kind, scope, channel, contact_id, action_id, user_text, reply_text, said_at, answered_at, state, attempts, last_error, transferred_at
	FROM stm_episodes;
DROP TABLE stm_episodes;
ALTER TABLE stm_episodes_new RENAME TO stm_episodes;
CREATE INDEX stm_episodes_state_scope ON stm_episodes (state, scope, said_at);
