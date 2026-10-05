-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Commitments (plan 0.006 C1, HLD §7.2): a future obligation is a record,
-- created by a typed tool or an owner command before any reply acknowledges
-- it. In this increment every commitment is a reminder.
--
-- The route is copied exactly from the turn that asked (that web chat or that
-- Telegram chat) and never changes. A commitment is fulfilled only by the
-- receipt of its own action (`actions.commitment_id`), in the same
-- transaction. A reminder is an action of the existing kind `status` (Iyye's
-- own message, answering nothing), so `actions` only gains a column.

CREATE TABLE commitments (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('reminder')),
	-- The conversation and person it belongs to, and the exact route it is sent on.
	scope TEXT NOT NULL,
	recipient_contact_id TEXT NOT NULL REFERENCES contacts (id),
	route_json TEXT NOT NULL,
	text TEXT NOT NULL,
	due_at TEXT NOT NULL,
	timezone TEXT NOT NULL,
	recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'daily', 'weekly')),
	-- The first occurrence of a repeating reminder; each occurrence is its own row.
	series_id TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('scheduled', 'due', 'fulfilled', 'failed', 'cancelled', 'unknown')),
	action_id TEXT,
	-- Who created it: the event of the turn (tool) or the owner's command.
	created_by TEXT NOT NULL,
	created_event_id TEXT,
	created_at TEXT NOT NULL,
	settled_at TEXT,
	reason TEXT
);

CREATE INDEX commitments_state_due ON commitments (state, due_at);
CREATE INDEX commitments_scope ON commitments (scope, state);
-- One occurrence per series and time: creating the next occurrence twice (a retry after a crash) is a no-op.
CREATE UNIQUE INDEX commitments_series_due ON commitments (series_id, due_at);

ALTER TABLE actions ADD COLUMN commitment_id TEXT REFERENCES commitments (id);
