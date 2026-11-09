-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.018 W1: the history behind the self model.
--
-- `self_readings`: one row per numeric field per probe (every ten minutes,
-- asleep too). Kept a week, then only as `self_readings_hourly` (90 days).
-- `machine` is a short hash of the hardware facet: a reading from one
-- computer is no baseline for another (the Mac's free disk next to the
-- Spark's).
--
-- `host_runs`: one row per start of the host. `last_seen_at` is a heartbeat;
-- `ended` is set only by a shutdown, so a row left without it is a run that
-- was killed (2026-10-10 to 11-09: every night, with the owner's SSH
-- session). `under` is what the host ran under, as program names only.
--
-- `nights`: one row per sleep, with whether it started in the rest window
-- and whether the night completed.

CREATE TABLE self_readings (
	facet TEXT NOT NULL,
	field TEXT NOT NULL,
	machine TEXT NOT NULL,
	at TEXT NOT NULL,
	value REAL NOT NULL
);

CREATE INDEX self_readings_field ON self_readings (facet, field, at);
CREATE INDEX self_readings_at ON self_readings (at);

CREATE TABLE self_readings_hourly (
	facet TEXT NOT NULL,
	field TEXT NOT NULL,
	machine TEXT NOT NULL,
	-- The hour's start, UTC ("2026-11-09T21").
	hour TEXT NOT NULL,
	min REAL NOT NULL,
	mean REAL NOT NULL,
	max REAL NOT NULL,
	n INTEGER NOT NULL,
	PRIMARY KEY (facet, field, machine, hour)
);

CREATE TABLE host_runs (
	id TEXT PRIMARY KEY,
	started_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	ended TEXT CHECK (ended IN ('shutdown')),
	under TEXT NOT NULL,
	-- Program names of the host's parents, nearest first (JSON array).
	parents_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX host_runs_started ON host_runs (started_at);

CREATE TABLE nights (
	slept_at TEXT PRIMARY KEY,
	woke_at TEXT,
	reason TEXT,
	in_window INTEGER NOT NULL CHECK (in_window IN (0, 1)),
	completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
	summary TEXT
);
