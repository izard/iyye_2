-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.010 M4: what happened to each opportunity, in records, never in
-- Iyye's prose.
--
-- `outcome` says how a settled (or suspended) opportunity ended, and
-- `credited` whether Iyye's own action produced it (a notice never does: the
-- condition clearing is not its work). `motivation_events` keeps the steps on
-- the way: opened, attempted, withheld (with its reason, at most once per
-- opportunity, reason and day), preempted, settled, useful (the owner's
-- word). `initiative_device` charges initiative's actual inference time per
-- motivation and machine, the basis of the daily allowances (§7).

ALTER TABLE opportunities ADD COLUMN outcome TEXT CHECK (
	outcome IN ('resolved', 'declined', 'expired', 'failed', 'capped', 'covered', 'nothing', 'gone', 'suspended')
);
ALTER TABLE opportunities ADD COLUMN credited INTEGER NOT NULL DEFAULT 0 CHECK (credited IN (0, 1));

-- Rows settled before this migration: their outcome from the answer the actor recorded (its fixed phrases).
UPDATE opportunities SET
	outcome = CASE
		WHEN status = 'suspended' THEN 'suspended'
		WHEN action_kind IN ('investigate') OR action_kind IS NULL THEN CASE WHEN finding_id IS NOT NULL THEN 'resolved' ELSE 'gone' END
		WHEN answer LIKE 'cleared at%' OR answer = 'question resolved' OR answer LIKE 'filled from%' THEN 'resolved'
		WHEN answer IN ('replied', 'plan completed', 'question accepted') THEN 'resolved'
		WHEN answer = 'over the daily cap' THEN 'capped'
		WHEN answer LIKE 'lapsed%' OR answer IN ('no reply', 'question expired') THEN 'expired'
		WHEN answer LIKE 'declined%' OR answer = 'question dismissed' THEN 'declined'
		WHEN answer LIKE 'covered%' OR answer LIKE 'held%' OR answer = 'asked about recently' THEN 'covered'
		WHEN answer LIKE 'nothing%' OR answer LIKE 'no step%' THEN 'nothing'
		WHEN answer LIKE '%gone' THEN 'gone'
		ELSE 'failed'
	END,
	credited = CASE
		WHEN answer IN ('replied', 'plan completed', 'question accepted') OR answer LIKE 'filled from%' THEN 1
		WHEN (action_kind IN ('investigate') OR action_kind IS NULL) AND finding_id IS NOT NULL THEN 1
		ELSE 0
	END
WHERE status IN ('settled', 'suspended');

CREATE TABLE motivation_events (
	id TEXT PRIMARY KEY,
	at TEXT NOT NULL,
	opportunity_id TEXT,
	motivation TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('opened', 'attempted', 'withheld', 'preempted', 'fruitless', 'settled', 'useful', 'not_useful')),
	reason TEXT,
	ref TEXT,
	-- Withheld events repeat every sweep: one per opportunity, reason and local day.
	dedup TEXT UNIQUE
);
CREATE INDEX motivation_events_opportunity ON motivation_events (opportunity_id, at);
CREATE INDEX motivation_events_at ON motivation_events (at);

CREATE TABLE initiative_device (
	id TEXT PRIMARY KEY,
	at TEXT NOT NULL,
	-- The local day it counts against.
	day TEXT NOT NULL,
	motivation TEXT NOT NULL,
	opportunity_id TEXT,
	source TEXT NOT NULL CHECK (source IN ('compose', 'step')),
	machine TEXT NOT NULL CHECK (machine IN ('local', 'remote')),
	ms INTEGER NOT NULL,
	-- 0 when the work was discarded (preempted, or the other machine was lost).
	kept INTEGER NOT NULL DEFAULT 1,
	ref TEXT UNIQUE
);
CREATE INDEX initiative_device_day ON initiative_device (day, motivation);
