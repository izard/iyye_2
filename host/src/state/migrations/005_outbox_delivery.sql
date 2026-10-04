-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Outbox delivery (plan M6): bounded retries, per-chunk receipts, and owner
-- resolution of sends whose outcome is unknown.

-- When a retryable failure may be tried again, and why the last attempt failed.
ALTER TABLE actions ADD COLUMN next_attempt_at TEXT;
ALTER TABLE actions ADD COLUMN last_error TEXT;
-- Who closed an unknown or failed action, how, and when.
ALTER TABLE actions ADD COLUMN resolution TEXT;
ALTER TABLE actions ADD COLUMN resolved_by TEXT;
ALTER TABLE actions ADD COLUMN resolved_at TEXT;

-- A receipt row per chunk, created when the action is first sent. The chunk is
-- content[chunk_start, chunk_end): the split is persisted, never recomputed, so
-- recovery after a crash names exactly the chunks that were or may have been sent.
-- outcome: pending → sending → delivered | failed | unknown.
ALTER TABLE receipts ADD COLUMN chunk_start INTEGER;
ALTER TABLE receipts ADD COLUMN chunk_end INTEGER;

CREATE INDEX actions_state_next ON actions (state, next_attempt_at);
