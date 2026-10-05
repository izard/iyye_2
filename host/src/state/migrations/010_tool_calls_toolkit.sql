-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Toolkits (plan 0.004 T1): each recorded tool call names the toolkit it
-- belongs to, for /tools and as the outcome of the toolkit-selection role
-- ("which toolkits were actually used in this turn"). Earlier rows stay NULL.

ALTER TABLE tool_calls ADD COLUMN toolkit TEXT;
