-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Email (plan 0.014): the owner and trusted contacts ask, Iyye composes, the
-- `email` toolkit sends at once through the outbox from Iyye's own mailbox.
--
-- `contact_emails`: a person's address, set only by the owner (`/person email`
-- from the web chat or the terminal); nothing a person writes stores one.
-- `sent_emails`: one row per mail. The recipient is either a person with a
-- stored address or an address the asker typed in the very message that
-- asked (`recipient_contact_id` NULL when it is nobody Iyye knows). Its
-- outbox action has the key `notice:email:<id>` and carries the delivery
-- state and the receipt. At most one mail per recipient per request.

CREATE TABLE contact_emails (
	contact_id TEXT PRIMARY KEY REFERENCES contacts (id),
	address TEXT NOT NULL,
	set_by TEXT NOT NULL,
	set_at TEXT NOT NULL
);

CREATE TABLE sent_emails (
	id TEXT PRIMARY KEY,
	dedup_key TEXT NOT NULL UNIQUE,
	recipient_contact_id TEXT REFERENCES contacts (id),
	-- The recipient person's scope when it is a person, else NULL.
	recipient_scope TEXT,
	address TEXT NOT NULL,
	subject TEXT NOT NULL,
	-- What Iyye composed, without the line naming who asked.
	text TEXT NOT NULL,
	requested_event_id TEXT,
	requested_via TEXT NOT NULL,
	requested_by TEXT NOT NULL CHECK (requested_by IN ('owner', 'contact')),
	requester_contact_id TEXT REFERENCES contacts (id),
	requester_scope TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX sent_emails_time ON sent_emails (created_at);
CREATE INDEX sent_emails_requester ON sent_emails (requester_scope);
CREATE INDEX sent_emails_recipient ON sent_emails (recipient_scope);
