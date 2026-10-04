-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Owner memory controls (plan 0.002 L6).
--
-- /forget: a tombstone per forgotten scope. Anything that scope said before
-- `forgotten_at` can never enter memory again (late deliveries, the night,
-- restaging); what the person says afterwards is remembered normally.
-- Bank deletions that could not reach Hindsight wait in a queue and are
-- retried before any new memory work for that bank.
--
-- /remember: an STM entry can be an explicit owner fact (kind 'remember'),
-- which has no delivered reply, so action_id becomes nullable (table rebuilt).

CREATE TABLE memory_tombstones (
	scope TEXT NOT NULL,
	forgotten_at TEXT NOT NULL,
	forgotten_by TEXT NOT NULL,
	PRIMARY KEY (scope, forgotten_at)
);

CREATE TABLE bank_deletions_pending (
	bank TEXT PRIMARY KEY,
	scope TEXT NOT NULL,
	requested_at TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT
);

CREATE TABLE stm_episodes_new (
	event_id TEXT PRIMARY KEY REFERENCES events (id),
	kind TEXT NOT NULL DEFAULT 'turn' CHECK (kind IN ('turn', 'remember')),
	scope TEXT NOT NULL,
	channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
	contact_id TEXT NOT NULL REFERENCES contacts (id),
	action_id TEXT REFERENCES actions (id),
	user_text TEXT NOT NULL,
	reply_text TEXT NOT NULL,
	said_at TEXT NOT NULL,
	answered_at TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'day' CHECK (state IN ('day', 'backlog', 'completed', 'completed_empty', 'failed')),
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	transferred_at TEXT,
	CHECK ((kind = 'turn') = (action_id IS NOT NULL))
);
INSERT INTO stm_episodes_new (
	event_id, kind, scope, channel, contact_id, action_id, user_text, reply_text, said_at, answered_at, state, attempts, last_error, transferred_at
)
	SELECT event_id, 'turn', scope, channel, contact_id, action_id, user_text, reply_text, said_at, answered_at, state, attempts, last_error, transferred_at
	FROM stm_episodes;
DROP TABLE stm_episodes;
ALTER TABLE stm_episodes_new RENAME TO stm_episodes;
CREATE INDEX stm_episodes_state_scope ON stm_episodes (state, scope, said_at);
