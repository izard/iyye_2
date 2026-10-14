-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0

-- Plan 0.009, owner decision 13: owner-selected reasoning, perspective and voice preset.

-- The profile each turn was bound to at its start (reasoning provenance, even when no voice ran):
-- the character revision, the selected controls, the definition versions that entered Pi's prompt
-- and that text's digest (the text itself is in the host's definitions, by version).
CREATE TABLE turn_profiles (
	job_id TEXT PRIMARY KEY,
	event_id TEXT NOT NULL,
	scope TEXT NOT NULL,
	character_rev INTEGER NOT NULL,
	controls_json TEXT NOT NULL,
	mind_versions_json TEXT NOT NULL,
	mind_digest TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX turn_profiles_event ON turn_profiles (event_id);

-- A voice sample's profile: the controls it was made under (the delivery's for live and shadow samples)
-- and, for an experiment, the tested override (null otherwise). Its configuration is also in
-- `prompt_version`, which keeps (action_id, model, prompt_version) the sample's identity.
ALTER TABLE voice_samples ADD COLUMN profile_json TEXT;
ALTER TABLE voice_samples ADD COLUMN experiment_json TEXT;
