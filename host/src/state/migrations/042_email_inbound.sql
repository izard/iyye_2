-- iyye: foreign_keys off
-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Email arrives (plan 0.015): `email` becomes a channel of events, accounts
-- and short-term memory, and an event can be `ignored` (a mail Iyye read and
-- decided not to answer: neither answered nor a failure). SQLite cannot widen
-- a CHECK in place, so the three tables are rebuilt from their current
-- definitions with foreign keys off (db.ts checks them before committing).
-- `email_inbox`: every mail the poller read, admitted or not, with what was
-- decided (the owner's /email view); the poller's cursor is in `email_cursor`.

CREATE TABLE events_new (
	id TEXT PRIMARY KEY,
	dedup_key TEXT NOT NULL UNIQUE,
	channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'email')),
	external_ref TEXT,
	principal_contact_id TEXT REFERENCES contacts (id),
	scope TEXT,
	observed_at TEXT,
	received_at TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('admitted', 'answered', 'dropped', 'ignored')),
	drop_reason TEXT,
	CHECK ((status = 'dropped') = (drop_reason IS NOT NULL)),
	CHECK (status = 'dropped' OR (principal_contact_id IS NOT NULL AND scope IS NOT NULL))
);
INSERT INTO events_new SELECT * FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE TABLE channel_bindings_new (
	contact_id TEXT NOT NULL REFERENCES contacts (id),
	channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'email')),
	external_id TEXT NOT NULL,
	verified_by TEXT NOT NULL CHECK (verified_by IN ('owner_local', 'first_contact')),
	created_at TEXT NOT NULL,
	PRIMARY KEY (channel, external_id)
);
INSERT INTO channel_bindings_new SELECT * FROM channel_bindings;
DROP TABLE channel_bindings;
ALTER TABLE channel_bindings_new RENAME TO channel_bindings;
CREATE INDEX channel_bindings_contact ON channel_bindings (contact_id);

CREATE TABLE stm_episodes_new (
	event_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL DEFAULT 'turn' CHECK (kind IN ('turn', 'remember', 'observation', 'summary')),
	scope TEXT NOT NULL,
	channel TEXT CHECK (channel IN ('web', 'telegram', 'email')),
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
INSERT INTO stm_episodes_new SELECT * FROM stm_episodes;
DROP TABLE stm_episodes;
ALTER TABLE stm_episodes_new RENAME TO stm_episodes;
CREATE INDEX stm_episodes_state_scope ON stm_episodes (state, scope, said_at);

CREATE TABLE email_inbox (
	id TEXT PRIMARY KEY,
	uidvalidity INTEGER NOT NULL,
	uid INTEGER NOT NULL,
	message_id TEXT,
	from_address TEXT NOT NULL,
	from_name TEXT,
	subject TEXT NOT NULL,
	-- The receiving server's verdict that the From address is genuine (aligned DKIM or DMARC pass).
	authenticated INTEGER NOT NULL CHECK (authenticated IN (0, 1)),
	auth_summary TEXT,
	event_id TEXT REFERENCES events (id),
	contact_id TEXT REFERENCES contacts (id),
	verdict TEXT NOT NULL CHECK (verdict IN ('dropped', 'queued', 'replied', 'ignored', 'failed')),
	reason TEXT,
	received_at TEXT NOT NULL,
	decided_at TEXT,
	UNIQUE (uidvalidity, uid)
);
CREATE INDEX email_inbox_time ON email_inbox (received_at);
CREATE INDEX email_inbox_event ON email_inbox (event_id);
CREATE INDEX email_inbox_contact ON email_inbox (contact_id, received_at);

CREATE TABLE email_cursor (
	mailbox TEXT PRIMARY KEY,
	uidvalidity INTEGER NOT NULL,
	last_uid INTEGER NOT NULL,
	updated_at TEXT NOT NULL
);
