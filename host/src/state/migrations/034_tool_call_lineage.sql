-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Plan 0.013 E3: citations bound to the turn's own tool results.
--
-- A tool call records the event of the turn that made it (set by the host
-- from the scheduled turn, never by the model) and a hash of the result the
-- model saw. A structured fact read from one of those results keeps its id
-- (`stm_facts.tool_call_id`): where the claim came from, not proof of it.

ALTER TABLE tool_calls ADD COLUMN event_id TEXT;
ALTER TABLE tool_calls ADD COLUMN result_hash TEXT;
CREATE INDEX tool_calls_event ON tool_calls (event_id);

ALTER TABLE stm_facts ADD COLUMN tool_call_id TEXT;
