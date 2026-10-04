-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Adenosine (plan 0.007 S2, HLD §8.2): every change to Iyye's energy level,
-- with what caused it. One writer (kernel/adenosine.ts). A charge that names
-- a reference (an answered turn, a model operation, a background step) is
-- unique per kind and reference, so nothing is charged twice, even if a
-- sweep or a hook runs again after a restart.

CREATE TABLE energy_ledger (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	kind TEXT NOT NULL,
	-- Negative for a charge, positive for a refill.
	amount REAL NOT NULL,
	level_after REAL NOT NULL,
	ref TEXT,
	UNIQUE (kind, ref)
);

CREATE INDEX energy_ledger_at ON energy_ledger (at);
