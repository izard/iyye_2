-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Long-term memory gets its own model selection (plan 0.002 L2): `memory`
-- joins `web` and `telegram`. SQLite cannot alter a CHECK constraint, so the
-- table is rebuilt, keeping every existing selection.

CREATE TABLE model_selection_new (
	channel TEXT PRIMARY KEY CHECK (channel IN ('web', 'telegram', 'memory')),
	model_name TEXT NOT NULL,
	set_by TEXT NOT NULL,
	set_at TEXT NOT NULL
);
INSERT INTO model_selection_new (channel, model_name, set_by, set_at)
	SELECT channel, model_name, set_by, set_at FROM model_selection;
DROP TABLE model_selection;
ALTER TABLE model_selection_new RENAME TO model_selection;
