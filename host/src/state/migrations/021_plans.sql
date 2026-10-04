-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plans (plan 0.006 C4, HLD §7.1): a durable intention with typed steps.
--
-- Lifecycle: proposed → authorized → active → completed, or failed,
-- abandoned (cancelled), or suspended (a step is blocked or a delivery is
-- unconfirmed). Only the owner, from a local owner surface, authorizes a plan
-- whose steps reach beyond the owner's web chat; nothing from Telegram can
-- authorize or change one (it can at most propose it).
--
-- Steps (JSON, in order): investigate (a read-only question, done by a
-- grounded answer), remind (a reminder on the proposer's route, done by its
-- receipt), other (no typed tool: blocked). A plan completes only when every
-- step has its evidence.

CREATE TABLE plans (
	id TEXT PRIMARY KEY,
	intent TEXT NOT NULL,
	-- Who proposed it, in which conversation, and where its outward steps go.
	proposer_contact_id TEXT NOT NULL REFERENCES contacts (id),
	scope TEXT NOT NULL,
	route_json TEXT NOT NULL,
	proposed_via TEXT NOT NULL,
	created_event_id TEXT,
	steps_json TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('proposed', 'authorized', 'active', 'suspended', 'completed', 'failed', 'abandoned')),
	-- "auto: …" (internal or owner-web-chat only, proposed by the owner there) or "owner:<who>".
	authorization TEXT,
	version INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	authorized_at TEXT,
	settled_at TEXT,
	reason TEXT
);

CREATE INDEX plans_state ON plans (state, created_at);
