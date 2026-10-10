-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.010 M1: motivations act.
--
-- One opportunity queue: every opportunity has a motivation and an action.
-- Rows from before are the curiosity loop's investigations (0.007 S5). Acting
-- rows (ask, notify, maintain) key their cluster by episode
-- ("service:Telegram@<since>"), so a second outage is a new opportunity;
-- investigation clusters stay one per finding.
--
-- Service status: each service's state, since when, and its last error,
-- recorded by the host (the error text with any bot token redacted), so an
-- outage is evidence with a cause and a duration.
--
-- Self-model questions to the owner (limited, one at a time) and the owner's
-- reply recorded as a pending answer until they confirm it.

ALTER TABLE opportunities ADD COLUMN motivation TEXT NOT NULL DEFAULT 'curiosity'
	CHECK (motivation IN ('self_preservation', 'curiosity', 'agency', 'social'));
ALTER TABLE opportunities ADD COLUMN signal_kind TEXT;
ALTER TABLE opportunities ADD COLUMN action_kind TEXT NOT NULL DEFAULT 'investigate'
	CHECK (action_kind IN ('investigate', 'ask', 'notify', 'maintain'));

CREATE TABLE service_status (
	name TEXT PRIMARY KEY,
	state TEXT NOT NULL,
	-- Since when the service has been in this state.
	since TEXT NOT NULL,
	last_error TEXT,
	last_error_at TEXT,
	updated_at TEXT NOT NULL
);

CREATE TABLE self_questions (
	id TEXT PRIMARY KEY,
	-- The self-model field asked about ("place:stated", "social:relation:<id>", "place:estimate").
	field TEXT NOT NULL,
	question TEXT NOT NULL,
	opportunity_id TEXT,
	asked_at TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('asked', 'answered', 'accepted', 'dismissed', 'expired')),
	answer_text TEXT,
	answer_event_id TEXT,
	answered_at TEXT,
	settled_at TEXT
);

CREATE INDEX self_questions_field ON self_questions (field, asked_at);
