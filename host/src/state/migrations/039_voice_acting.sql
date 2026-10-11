-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0

-- Plan 0.009 CH4: the voice acting on the turn path. A sample made there records whether its candidate
-- was sent instead of the original (`delivered` 1), and why not when it was not (`problem`).
ALTER TABLE voice_samples ADD COLUMN acting INTEGER NOT NULL DEFAULT 0;
ALTER TABLE voice_samples ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0;
