-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.013 E1: belief validity as date ranges.
--
-- Each evidence row carries the date it says its value held from
-- (`effective_at`: the fact's valid_from, or a correction's day) and when it
-- was said (`said_at`). Where neither is recoverable (rows merged before this
-- migration whose structured fact is gone), the day it was received stands
-- in, flagged `effective_known = 0`: shown as approximate, never as known.
--
-- `belief_intervals` holds any number of date ranges per belief, rebuilt from
-- the evidence per single-valued fact key (`rebuildTimeline`), so a value
-- said again keeps its earlier range. The columns state, valid_from,
-- valid_to and closed_by on `beliefs` stay, as a cache of the latest range.

ALTER TABLE belief_evidence ADD COLUMN effective_at TEXT;
ALTER TABLE belief_evidence ADD COLUMN said_at TEXT;
ALTER TABLE belief_evidence ADD COLUMN effective_known INTEGER NOT NULL DEFAULT 1 CHECK (effective_known IN (0, 1));

UPDATE belief_evidence SET
	effective_at = coalesce(
		(SELECT s.valid_from FROM stm_facts s WHERE s.id = belief_evidence.stm_fact_id),
		CASE WHEN relation IN ('new', 'changes') THEN (SELECT b.valid_from FROM beliefs b WHERE b.id = belief_evidence.belief_id) END,
		substr(at, 1, 10)
	),
	effective_known = CASE
		WHEN (SELECT s.valid_from FROM stm_facts s WHERE s.id = belief_evidence.stm_fact_id) IS NOT NULL THEN 1
		WHEN relation IN ('new', 'changes', 'correction') THEN 1
		ELSE 0
	END,
	said_at = coalesce((SELECT s.said_at FROM stm_facts s WHERE s.id = belief_evidence.stm_fact_id), at);

CREATE TABLE belief_intervals (
	belief_id TEXT NOT NULL REFERENCES beliefs (id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	valid_from TEXT NOT NULL,
	-- Null while the range is open: the belief's value holds now.
	valid_to TEXT,
	-- The evidence row whose transition opened it.
	opened_by TEXT,
	-- The belief whose transition closed it.
	closed_by TEXT,
	-- 1 when the opening date is the day it was received, not a date anyone stated.
	approximate INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (belief_id, seq)
);
