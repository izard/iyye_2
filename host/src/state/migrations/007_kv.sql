-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Small durable host facts that are not records of their own, such as when
-- Telegram receiving first started (plan M5).

CREATE TABLE kv (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
