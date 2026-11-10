-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.018 W3: what is normal.
--
-- `self_surprises`: a reading that stayed outside its usual band (and past
-- its field's floor); open until a reading is back inside.
--
-- `self_regularities`: something that starts in the same stretch of the
-- local day on most days. `answer` is the owner's ("expected" or "problem");
-- without one it is a candidate Iyye asks about. `last_found` is the last
-- day the rule still found it: a regularity not found for some days is no
-- longer in force, and its answer is kept for when it returns.

CREATE TABLE self_surprises (
	id TEXT PRIMARY KEY,
	facet TEXT NOT NULL,
	field TEXT NOT NULL,
	machine TEXT NOT NULL,
	started_at TEXT NOT NULL,
	ended_at TEXT,
	side TEXT NOT NULL CHECK (side IN ('low', 'high')),
	-- The reading furthest from its band, and that band's median.
	peak REAL NOT NULL,
	usual REAL NOT NULL
);

CREATE INDEX self_surprises_open ON self_surprises (ended_at, facet, field);

CREATE TABLE self_regularities (
	id TEXT PRIMARY KEY,
	subject TEXT NOT NULL UNIQUE,
	-- Minutes of the local day; `end_minute` NULL when no occurrence has ended.
	start_minute INTEGER NOT NULL,
	end_minute INTEGER,
	days INTEGER NOT NULL,
	of_days INTEGER NOT NULL,
	spread_minutes INTEGER NOT NULL,
	first_found TEXT NOT NULL,
	last_found TEXT NOT NULL,
	-- The local day of its latest occurrence.
	last_on TEXT,
	answer TEXT CHECK (answer IN ('expected', 'problem')),
	answered_at TEXT,
	answered_by TEXT
);
