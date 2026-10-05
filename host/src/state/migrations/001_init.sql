-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- 0.001 control state (HLD §3.1 subset; plan M1). Field names follow the HLD so
-- later increments extend these tables instead of renaming them. Timestamps are
-- UTC ISO-8601 strings. This is control state, not a semantic memory store.

CREATE TABLE contacts (
	id TEXT PRIMARY KEY,
	display_name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('owner', 'contact')),
	created_at TEXT NOT NULL
);

-- Exactly one owner, ever.
CREATE UNIQUE INDEX contacts_single_owner ON contacts (kind) WHERE kind = 'owner';

-- Verified channel identities. Telegram binds on the numeric from.id, never a display name.
CREATE TABLE channel_bindings (
	contact_id TEXT NOT NULL REFERENCES contacts (id),
	channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
	external_id TEXT NOT NULL,
	verified_by TEXT NOT NULL CHECK (verified_by IN ('owner_local', 'first_contact')),
	created_at TEXT NOT NULL,
	PRIMARY KEY (channel, external_id)
);

CREATE INDEX channel_bindings_contact ON channel_bindings (contact_id);

-- Every inbound message that reached admission, including the ones it dropped.
-- Dropped events have no principal or scope and never create a job.
CREATE TABLE events (
	id TEXT PRIMARY KEY,
	dedup_key TEXT NOT NULL UNIQUE,
	channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
	external_ref TEXT,
	principal_contact_id TEXT REFERENCES contacts (id),
	scope TEXT,
	observed_at TEXT,
	received_at TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('admitted', 'answered', 'dropped')),
	drop_reason TEXT,
	CHECK ((status = 'dropped') = (drop_reason IS NOT NULL)),
	CHECK (status = 'dropped' OR (principal_contact_id IS NOT NULL AND scope IS NOT NULL))
);

CREATE TABLE jobs (
	id TEXT PRIMARY KEY,
	trigger_event_id TEXT NOT NULL UNIQUE REFERENCES events (id),
	scope TEXT NOT NULL,
	model_name TEXT,
	status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'settled', 'failed')),
	lease_until TEXT,
	attempt INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	settled_at TEXT
);

CREATE INDEX jobs_status_scope ON jobs (status, scope, created_at);

-- Outbox (plan M6). Created now so the schema matches HLD §3.1; first used in M6.
CREATE TABLE actions (
	id TEXT PRIMARY KEY,
	job_id TEXT REFERENCES jobs (id),
	event_id TEXT REFERENCES events (id),
	kind TEXT NOT NULL CHECK (kind IN ('reply', 'failure_notice', 'status')),
	route_json TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	idempotency_key TEXT NOT NULL UNIQUE,
	state TEXT NOT NULL CHECK (
		state IN ('prepared', 'queued', 'sending', 'delivered', 'failed', 'unknown', 'terminal_failure')
	),
	attempts INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);

CREATE TABLE receipts (
	action_id TEXT NOT NULL REFERENCES actions (id),
	chunk_index INTEGER NOT NULL,
	adapter TEXT NOT NULL,
	level TEXT NOT NULL,
	provider_ref TEXT,
	acknowledged_at TEXT,
	outcome TEXT NOT NULL,
	error TEXT,
	PRIMARY KEY (action_id, chunk_index)
);

-- Durable per-channel resume points (Telegram getUpdates offset base).
CREATE TABLE channel_cursors (
	channel TEXT PRIMARY KEY,
	cursor INTEGER NOT NULL,
	updated_at TEXT NOT NULL
);

-- Model management (plan M2). Created now; first used in M2.
CREATE TABLE model_selection (
	channel TEXT PRIMARY KEY CHECK (channel IN ('web', 'telegram')),
	model_name TEXT NOT NULL,
	set_by TEXT NOT NULL,
	set_at TEXT NOT NULL
);

CREATE TABLE model_ops (
	id TEXT PRIMARY KEY,
	op TEXT NOT NULL CHECK (op IN ('load', 'unload', 'router_start', 'router_stop')),
	model_name TEXT,
	requested_by TEXT NOT NULL,
	state TEXT NOT NULL,
	error TEXT,
	started_at TEXT NOT NULL,
	finished_at TEXT
);

-- The owner exists from the first start and is reachable only through the local web chat.
INSERT INTO contacts (id, display_name, kind, created_at)
VALUES ('owner', 'Owner', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO channel_bindings (contact_id, channel, external_id, verified_by, created_at)
VALUES ('owner', 'web', 'owner', 'owner_local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
