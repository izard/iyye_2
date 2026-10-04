-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Messages Iyye sends to a contact for the owner (plan 0.008): the owner asks
-- (web chat or a linked Telegram account), Iyye composes, the `messaging`
-- toolkit sends at once through the outbox on the person's own Telegram chat.
-- One row per message; its action carries the delivery state and receipts.
-- At most one message per person per owner request (`dedup_key`), so a
-- retried turn never sends twice.

CREATE TABLE sent_messages (
	id TEXT PRIMARY KEY,
	dedup_key TEXT NOT NULL UNIQUE,
	recipient_contact_id TEXT NOT NULL REFERENCES contacts (id),
	-- The recipient's scope: their next turns are told what was sent.
	scope TEXT NOT NULL,
	route_json TEXT NOT NULL,
	-- What Iyye composed, without the label the recipient sees.
	text TEXT NOT NULL,
	action_id TEXT REFERENCES actions (id),
	requested_event_id TEXT,
	requested_via TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX sent_messages_scope ON sent_messages (scope, created_at);
CREATE INDEX sent_messages_time ON sent_messages (created_at);
