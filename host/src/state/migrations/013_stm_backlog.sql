-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Short-term memory is today only (owner, 2026-10-03). At the end of every
-- completed night, whatever the night could not store leaves STM for a
-- bounded transfer backlog: retried by later nights, never recalled.
-- `failed` now means dropped from the backlog (attempts or age exhausted).
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt.

CREATE TABLE stm_episodes_new (
	event_id TEXT PRIMARY KEY REFERENCES events (id),
	scope TEXT NOT NULL,
	channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
	contact_id TEXT NOT NULL REFERENCES contacts (id),
	action_id TEXT NOT NULL REFERENCES actions (id),
	user_text TEXT NOT NULL,
	reply_text TEXT NOT NULL,
	said_at TEXT NOT NULL,
	answered_at TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'day' CHECK (state IN ('day', 'backlog', 'completed', 'completed_empty', 'failed')),
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	transferred_at TEXT
);
INSERT INTO stm_episodes_new SELECT * FROM stm_episodes;
DROP TABLE stm_episodes;
ALTER TABLE stm_episodes_new RENAME TO stm_episodes;
CREATE INDEX stm_episodes_state_scope ON stm_episodes (state, scope, said_at);

-- Only today's episodes are searchable.
DELETE FROM stm_fts WHERE event_id IN (SELECT event_id FROM stm_episodes WHERE state != 'day');
