-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.018 W6: one row per day a routine was due. A routine is a plan
-- with a `routine` step the owner approved; `kernel/routines.ts` runs it.
--
-- `state`: running (a background step is at work), delivered (its answer was
-- handed to the outbox: `action_id`), skipped (it could not start in time:
-- asleep, the network away, the host not running), failed (no answer grounded
-- in the pages the tools returned). `told`: a skipped or failed day has been
-- mentioned to the owner in a later delivery.

CREATE TABLE routine_runs (
	id TEXT PRIMARY KEY,
	plan_id TEXT NOT NULL REFERENCES plans (id),
	-- The local day it was due on.
	day TEXT NOT NULL,
	due_at TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('running', 'delivered', 'skipped', 'failed')),
	reason TEXT,
	session TEXT,
	tries INTEGER NOT NULL DEFAULT 1,
	-- What was sent (the answer, without the label).
	text TEXT,
	action_id TEXT,
	started_at TEXT,
	settled_at TEXT,
	told INTEGER NOT NULL DEFAULT 0 CHECK (told IN (0, 1)),
	UNIQUE (plan_id, day)
);

CREATE INDEX routine_runs_plan ON routine_runs (plan_id, day);
