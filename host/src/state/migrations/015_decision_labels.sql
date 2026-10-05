-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Decision journal, K2/K3 (plan 0.003): the rest of the revision that
-- answered (LoRA rank and precision; the run itself is pinned to a commit),
-- and how strong a joined outcome is. A weak label comes from another model
-- or process (e.g. Hindsight's extraction); an owner label comes from the
-- owner (`/decisions label`). A weak label never replaces an owner label.

ALTER TABLE decisions ADD COLUMN lora INTEGER;
ALTER TABLE decisions ADD COLUMN dtype TEXT;
ALTER TABLE decisions ADD COLUMN label_strength TEXT CHECK (label_strength IN ('weak', 'owner'));

CREATE INDEX decisions_role_subject ON decisions (role, subject_ref);
