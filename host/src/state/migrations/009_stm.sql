-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Short-term memory (plan 0.002 §3.4, HLD §6.1): today's episodes awaiting
-- their nightly transfer into long-term memory. One row per answered event,
-- written in the transaction that marks the event answered. STM is the
-- transfer outbox itself: an episode leaves STM (state no longer 'day') only
-- once its transfer is confirmed.

CREATE TABLE stm_episodes (
	event_id TEXT PRIMARY KEY REFERENCES events (id),
	scope TEXT NOT NULL,
	channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
	contact_id TEXT NOT NULL REFERENCES contacts (id),
	action_id TEXT NOT NULL REFERENCES actions (id),
	user_text TEXT NOT NULL,
	reply_text TEXT NOT NULL,
	said_at TEXT NOT NULL,
	answered_at TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'day' CHECK (state IN ('day', 'completed', 'completed_empty', 'failed')),
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	transferred_at TEXT
);

CREATE INDEX stm_episodes_state_scope ON stm_episodes (state, scope, said_at);

-- Lexical index over episodes still in STM. Rows are removed when an episode leaves STM.
CREATE VIRTUAL TABLE stm_fts USING fts5 (
	event_id UNINDEXED,
	scope UNINDEXED,
	body,
	tokenize = 'unicode61 remove_diacritics 2'
);
