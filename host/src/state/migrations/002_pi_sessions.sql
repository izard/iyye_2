-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- One persistent Pi session per conversation scope (plan M3). The session
-- file is Pi's transcript; this table only remembers which file a scope uses,
-- so a restart reopens the same conversation.

CREATE TABLE pi_sessions (
	scope TEXT PRIMARY KEY,
	session_file TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_used_at TEXT NOT NULL
);
