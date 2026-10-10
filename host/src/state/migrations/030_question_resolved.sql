-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.010 M2: a question to the owner can be `resolved` — its condition
-- cleared another way (the owner set the place with /self set, a belief
-- moved out of doubt) — so it no longer holds the one-at-a-time slot. The
-- field may now also be a belief ("belief:<id>"). SQLite cannot change a
-- CHECK constraint in place, so the table is rebuilt.

CREATE TABLE self_questions_new (
	id TEXT PRIMARY KEY,
	-- "place:stated", "social:relation:<id>", "place:estimate", "belief:<id>".
	field TEXT NOT NULL,
	question TEXT NOT NULL,
	opportunity_id TEXT,
	asked_at TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('asked', 'answered', 'accepted', 'dismissed', 'expired', 'resolved')),
	answer_text TEXT,
	answer_event_id TEXT,
	answered_at TEXT,
	settled_at TEXT
);

INSERT INTO self_questions_new SELECT * FROM self_questions;
DROP TABLE self_questions;
ALTER TABLE self_questions_new RENAME TO self_questions;
CREATE INDEX self_questions_field ON self_questions (field, asked_at);
