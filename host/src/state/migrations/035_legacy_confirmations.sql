-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.013 E1, a fix to 033's backfill (2026-10-10 review): owner rows
-- merged before 033 (relation 'correction', no structured fact) cannot tell a
-- `/facts confirm` from a `/facts correct`. 033 dated them all, so a legacy
-- confirmation of a historical value reopened it. Only a correction that
-- created its belief (its first evidence) is known to be one; every other such
-- row keeps a confirmation's meaning: no date, marked unknown. The timelines
-- are then rebuilt once more at startup (`ensureBeliefTimelines`).

UPDATE belief_evidence SET effective_at = NULL, effective_known = 0
WHERE relation = 'correction' AND stm_fact_id IS NULL AND sign = 1
	AND at < (SELECT applied_at FROM schema_migrations WHERE name = '033_belief_intervals.sql')
	AND id <> (
		SELECT e.id FROM belief_evidence e WHERE e.belief_id = belief_evidence.belief_id ORDER BY e.at, e.rowid LIMIT 1
	);

DELETE FROM kv WHERE key = 'belief_timelines_v1';
