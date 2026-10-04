-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Per-contact trust (plan M7). Changed only by an owner command from the
-- local web chat or the host terminal; nothing arriving over Telegram can
-- write it. Who changed it and when is kept with it.

ALTER TABLE contacts ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0 CHECK (trusted IN (0, 1));
ALTER TABLE contacts ADD COLUMN trust_changed_by TEXT;
ALTER TABLE contacts ADD COLUMN trust_changed_at TEXT;
