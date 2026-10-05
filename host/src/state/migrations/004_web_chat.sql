-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Owner web chat (plan M4) and the outbox content it delivers.

-- The approved content of an action, kept so a later increment can resend
-- exactly what was approved (content_hash is its sha256).
ALTER TABLE actions ADD COLUMN content TEXT;

-- The owner's web-chat transcript as the UI shows it. Writing a reply here is
-- the web adapter's "send" (receipt level ui_enqueued). client_msg_id is
-- unique so a retried POST adds nothing twice; action_id is unique so a
-- reply appears once and recovery can reconcile an interrupted send.
CREATE TABLE web_feed (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL CHECK (kind IN ('user', 'reply', 'notice', 'command', 'command_result')),
	client_msg_id TEXT UNIQUE,
	event_id TEXT REFERENCES events (id),
	action_id TEXT UNIQUE REFERENCES actions (id),
	text TEXT NOT NULL,
	created_at TEXT NOT NULL
);

-- Logged-in owner browser sessions. Only a hash of the session id is stored.
CREATE TABLE web_sessions (
	id_hash TEXT PRIMARY KEY,
	csrf TEXT NOT NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
