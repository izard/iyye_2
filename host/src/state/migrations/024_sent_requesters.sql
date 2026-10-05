-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Who asked for a message (plan 0.008, owner change 2026-10-04): the owner,
-- a contact the owner trusts, or Iyye itself in its own work. Rows written
-- before this were all asked by the owner.

ALTER TABLE sent_messages ADD COLUMN requested_by TEXT NOT NULL DEFAULT 'owner' CHECK (requested_by IN ('owner', 'contact', 'iyye'));
ALTER TABLE sent_messages ADD COLUMN requester_contact_id TEXT REFERENCES contacts (id);
-- The requester's scope (`owner`, `contact:<id>`, or the background session), for /forget.
ALTER TABLE sent_messages ADD COLUMN requester_scope TEXT;
