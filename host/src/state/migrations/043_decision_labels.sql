-- Copyright 2026 Alexander Komarov
-- SPDX-License-Identifier: Apache-2.0
--
-- Owner labels per question (plan 0.017 N1). A decision row can carry more
-- than one owner question (toolkit selection: one per toolkit; reply review:
-- claims_arranged and promises_future_action), and its `outcome_json` holds
-- the weak outcome the reports read, so owner labels get their own rows.
-- `value` NULL: the owner looked and could not tell (`skip`); never a label.
-- `via`: how the question reached the owner, so a test set can be checked
-- for being made only of hard cases (the queue's tiers, or `direct`).
--
-- The daily labelling queue's offers are kept, so a day's picks stay the same
-- however often `/decisions queue` is asked, and each label knows its tier.
-- Both go with their decision (`/forget` deletes decisions by scope).

CREATE TABLE decision_labels (
	decision_id TEXT NOT NULL REFERENCES decisions (id) ON DELETE CASCADE,
	question TEXT NOT NULL,
	value INTEGER CHECK (value IN (0, 1)),
	labelled_by TEXT NOT NULL,
	labelled_at TEXT NOT NULL,
	via TEXT NOT NULL CHECK (via IN ('uncertain', 'disagree', 'random', 'direct')),
	PRIMARY KEY (decision_id, question)
);

CREATE TABLE decision_label_offers (
	decision_id TEXT NOT NULL REFERENCES decisions (id) ON DELETE CASCADE,
	question TEXT NOT NULL,
	-- The host's local date the question was offered on: the daily allowance counts these.
	offered_day TEXT NOT NULL,
	offered_at TEXT NOT NULL,
	via TEXT NOT NULL CHECK (via IN ('uncertain', 'disagree', 'random')),
	PRIMARY KEY (decision_id, question)
);

CREATE INDEX decision_label_offers_day ON decision_label_offers (offered_day);

-- The owner labels given so far (`/decisions label`, `/facts correct`), one row per answered question.
INSERT INTO decision_labels (decision_id, question, value, labelled_by, labelled_at, via)
SELECT d.id, j.key, CASE j.type WHEN 'true' THEN 1 ELSE 0 END, coalesce(d.outcome_source, 'owner'),
	coalesce(d.outcome_at, d.created_at), 'direct'
FROM decisions d, json_each(d.outcome_json) j
WHERE d.label_strength = 'owner' AND j.type IN ('true', 'false');
