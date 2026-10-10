-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.005 Stage 2: what the owner says about a person. Written only by an
-- owner command from the local web chat or the terminal; nothing arriving
-- over Telegram writes here. Visibility (owner decision 2026-10-10):
-- `owner` notes reach only the owner's own turns (when the person is named);
-- `person` notes also reach that person's own turns, so they may be repeated
-- to them. `/forget` deletes a person's notes.

CREATE TABLE person_notes (
	id TEXT PRIMARY KEY,
	person_id TEXT NOT NULL REFERENCES contacts (id),
	text TEXT NOT NULL,
	visibility TEXT NOT NULL CHECK (visibility IN ('owner', 'person')),
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	changed_at TEXT NOT NULL
);

CREATE INDEX person_notes_person ON person_notes (person_id, created_at);
