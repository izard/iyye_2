# Iyye 2.0.017 — Stage 4, Nightly Decision Learning: Implementation Plan

2026-10-27. The owner accepted §6's recommendations the same day ("go with N0 and N1"). N0 and N1 are done; nothing trains or activates until the owner turns it on.

## 1. Where it starts

- **Entry condition met:** plan 0.013 E6 (`test/integrity-gate.test.ts` passes, `/facts report` clean; the night of 2026-10-26 found 570 stored facts and 570 documents, none missing, unknown or stale).
- **Built and reused:**
  - The decision journal: `decisions`, migrations 011, 015 and 022. Each row keeps the exact request (`state_json`, `questions_json`, `state_hash`), the role and schema version, and the checkpoint, temperature, backend, LoRA and dtype it was answered with. Outcomes join only through `joinOutcome` with `label_strength` weak or owner, and a weak label never replaces an owner one.
  - Owner labels through `/decisions label <id> yes|no` for memory salience, observation importance, initiative and reply review (`claims_arranged`).
  - The training groundwork in `decision-worker/TRAINING.md`:
    - the training venv (shared pins with serving);
    - `train_candidate.py`: offline, scrubbed environment, one run at a time, atomic candidates with a hashed manifest, SIGTERM stop in 0.68 s;
    - `predict.py`, which refuses a candidate that does not match its manifest;
    - `scripts/training-smoke.ts`.
  - `NightWork` with `shouldStop`, the memory gate and `DeviceSlot`.
  - `/forget`, which deletes a person's decisions by scope, and `memory/mentions.ts`, which finds stored text naming a person.
- **What the live records hold (Spark, 2026-10-27):**
  - About 850 decisions; 85 % are in owner or `iyye` scope.
  - Owner labels: 12 memory salience, 5 reply review, 2 observation importance, none for toolkit selection.
  - About 650 weak labels: memory salience from Hindsight's transfer, reply review from the commitments ledger, toolkit selection from the tools a turn used.
  - **Labels, not code, are the bottleneck.** No candidate can be judged on 19 owner labels (HLD §10.4: small datasets cannot establish an improvement). Labelling starts first and runs while everything else is built.
- **Not built (TRAINING.md, "Known gaps"):** dataset export and splits, calibration, the replay suite, admission through the night, evaluation gates, the registry, activation, rollback and the forgetting rules for weights.

## 2. Scope

**In:**
- One multitask Kev adapter (LoRA + pointer head) over the roles the owner labels, trained during completed nights.
- Datasets, splits, calibration, evaluation, the registry, shadow and owner-approved activation, rollback, forgetting, and the owner's view.
- The generic part CH6 needs (plan 0.009): registry, held-out sets, promotion, rollback, preemption. The voice LoRA itself joins in a later step.

**Out:**
- Full-backbone fine-tuning, and role-specific adapters (only after a measured benefit and an isolation test, HLD §14).
- Learning motivation weights, character, prompts or permissions.
- Any change to what a decision may do: acting roles keep their deterministic bounds (§15 #16).
- Automatic promotion. It stays off until after this plan's exit gate, and only as an explicit owner policy.

## 3. Design

### 3.1 Labels (N1)

- **Training and test labels:**
  - Owner labels are the only labels a test set or a promotion verdict uses.
  - Weak labels may enter training only where §6 decision 2 allows, marked weak in the manifest, and never in validation or test.
  - The model's own answers are never labels, and an unchosen candidate is not a negative (§15 #18).
- **A daily labelling queue** (`/decisions queue [n]`, owner surfaces only) offers up to `IYYE2_LABELS_DAILY` (default 15) rows a day. It picks first:
  1. rows where Kev abstained or answered within the abstain band;
  2. rows where Kev and the weak label disagree;
  3. a random sample per role, so the test set is not only hard cases.

  Each item shows the state as the role saw it and the one question; `/decisions label` answers it.
- **Questions with more than one answer:**
  - Toolkit selection is labelled per toolkit (`/decisions label <id> web yes`).
  - Reply review's `promises_future_action` gets an owner question too.
  - Labels name their question; a row without that question cannot be labelled with it (as schema 1 reply reviews today).
- **Weak labels stay as they are, but are not equal:**
  - Toolkit selection's `used` is a positive only: an unused toolkit is not a "no".
  - Reply review's `commitment_created` is a ledger fact, never a `claims_arranged` label (plan 0.006 C2).
  - Memory salience's transfer result comes from Hindsight's model, so it is weak and model-created (HLD §10.2).

### 3.2 Datasets and splits (N2)

- **Export** (`decisions/dataset.ts`, also `scripts/decisions-dataset.ts --out <dir>` for inspection), to Kev's labelled JSONL: `state`, then `questions` with type, instructions and label.
  - **Scope (decision 1):** owner and `iyye` scope only. Contacts' decisions never enter a training set.
  - **Exclusions:**
    - rows of forgotten scopes, already deleted by `/forget`;
    - owner-scope rows whose state names a forgotten person, by `mentions.ts` against the tombstones' names;
    - errors, skips and truncated states.
  - **Deduplication:** by `state_hash` and by event lineage (one message asked twice is one example).
- **Splits:**
  - Grouped by conversation day: one person's same-day messages always share a split.
  - Time-ordered: the latest days form the test set.
  - **Test is sealed:** its rows are never used for training, calibration or replay. A test set looked at more than `IYYE2_TEST_LOOKS` (5) times is retired, and later days form a fresh one (HLD §10.4).
  - Validation, for calibration and early stopping, is drawn from the training period's days, grouped the same way.
- **The manifest:** each night's dataset is frozen with:
  - the row ids, their split, and their label sources and strengths;
  - the exclusions with their reasons (names never written into it);
  - the policy;
  - a hash.

  It is stored in `decision_datasets` (migration 044; 043 is N1's `decision_labels`). Content stays in SQLite; the JSONL is written to the training directory for the run and deleted after it.

### 3.3 The night phase (N3)

- **When:**
  - A fourth night phase, after the fact ledger, the transfer and consolidation, with its own watermark.
  - Only on a completed night.
  - Only when the policy is on (`IYYE2_DECISION_TRAINING`, default `off`).
  - Only when at least `IYYE2_TRAIN_MIN_NEW_LABELS` (default 30) owner labels arrived since the last candidate, and every trained role has at least `IYYE2_TRAIN_MIN_PER_CLASS` (20) of each class in training. Otherwise the night logs "skipped: …" and the phase ends. No update is better than a noisy one.
- **Admission and stopping:**
  - The trainer runs as the memory gate's job (`training:<dataset id>`), asleep, when only the memory model is loaded.
  - It refuses to start when available memory is below the measured peak plus a margin. N0 measured 30 GB on short states, but 50–54 GB once Kev's replay suite was mixed in. Beside the day models, that ran the Spark out of headroom (`host/SPIKE-0.017.md` §3). What drives the peak (most likely the suite's many-option questions) is found and bounded before N3 trains anything.
  - Owner input or an urgent wake sends SIGTERM through `shouldStop`, and the candidate is discarded. Kev's LoRA runs cannot resume, so a stopped night trains again next time.
  - Time budget `IYYE2_TRAIN_MAX_MIN` (30).
- **From the clean base (decision 5):**
  - Every candidate is trained from the released `kev-4b` pin on the night's full, current, clean dataset, never from the active candidate.
  - This keeps no lineage of forgotten data in the weights and makes forgetting a rebuild (HLD §10.5).
  - It is affordable while datasets are hundreds of rows.
- **Replay:** Kev's frozen suite (decision 6) mixes `--replay` records in, so a small personal set does not erase the released recipe.
  - The suite is the released model's own, decision-v7. It is provisioned at `~/.iyye2/decisions/suites` by `decision-worker/provision_suite.py`.
  - The mix is sized to Iyye's own data (start at 2–4 replay records per own example). The released recipe's 4000 would drown a few hundred labels (N0).
- **Calibration:** a temperature fitted on validation only, with `kev.metrics.fit_temperature` at Kev's release settings (116 ms; the cost is scoring the rows).
  - It is recorded in the bundle's registry entry. How the serving instance is given it (a load-time override) is to be verified in N4.
  - Never written into `head.pt`: `scripts/calibrate_checkpoint.py` does that, which would void the manifest (N0).

### 3.4 Evaluation and the registry (N4)

- **The registry:** `decision_artifacts` (migration 043) holds:
  - id, parent pin, dataset id and hash, manifest hash, roles;
  - state `candidate → evaluated → shadow → active → retired | quarantined`;
  - metrics, verdict and reasons, timestamps.

  Only the host's registry code changes a state. The trainer only writes candidate directories.
- **Held-out evaluation, per role, on the sealed test.** For each candidate, the active bundle and the deterministic fallback:
  - accuracy on decided rows and abstention coverage;
  - Brier score and calibration error;
  - false-positive and false-negative counts (per role, since their costs differ);
  - option-order stability (Kev's `/permute`);
  - latency and memory.
- **The regression suite (`decision-worker/fixtures/regression-*.jsonl`):** fixed, synthetic and non-private: injections in the state, impersonated owners, contacts asking for others' data, empty and truncated states. Its answers may not move past a tolerance. A critical regression vetoes whatever the averages say (§15 #20).
- **The verdict, frozen before the candidate is scored:**
  - better than the active bundle on Brier per trained role, by a bootstrap interval that excludes zero;
  - no role worse beyond tolerance;
  - suite clean.

  Otherwise the candidate is `evaluated, rejected` with its reasons. A correctly rejected weak candidate is a success of the gate (HLD exit gate).

### 3.5 Shadow, activation, rollback (N5)

- **Two Kev instances:**
  - The released `kev-4b` (generic) answers contacts, always.
  - The personal bundle answers owner and `iyye` scope only (decision 1; §15 #17).
  - Until a bundle is active, both scopes use the generic one, as today.
  - The second instance costs about 8 GB by day. It runs only while something is in shadow or active.
- **Shadow:** an evaluated candidate answers the same owner-scope requests from the idle loop (`decisions/idle.ts`), journaled with its own checkpoint id, never read by any role. `/decisions learning` shows agreement with the active bundle and with labels as they come in.
- **Activation:** at least `IYYE2_SHADOW_DAYS` (3) of shadow, then `/decisions activate <id>` by the owner (decision 7). The steps:
  1. a pointer update in SQLite;
  2. a supervised restart of the personal instance with the new run at the next safe boundary (no decision in flight);
  3. a health check that replays a fixed probe set and compares it with the evaluation's answers;
  4. cache and journal stamps carry the new id.

  A failed check returns the pointer to the previous bundle automatically and says so.
- **Owner controls:** `/decisions pin <id>`, `/decisions revert`, `/decisions reset` (generic only, personal data kept), `/decisions stop` (policy off). Two earlier active bundles are kept for revert; older ones are deleted, manifests kept.
- **Forgetting (§15 #21):**
  - `/forget` checks every candidate, shadow and active bundle whose dataset manifest holds a removed row: in the person's scope, or naming the person.
  - It quarantines them at once (generic fallback) and deletes their directories.
  - The next eligible night rebuilds from the clean dataset. The owner is told which bundles went, never what they held.

### 3.6 What the owner sees

- `/decisions learning`:
  - last night's dataset (counts per role, class and split; exclusions by reason);
  - the candidate's metrics against the active bundle and the fallback, and its verdict with reasons;
  - time and memory used, and what is in shadow or active.
- The day summary gets one line: "Decision learning: trained on N labels; candidate rejected (worse on reply review)."

## 4. Milestones

Sizes are provisional.

### N0 — Spike (~1 day) — done 2026-10-27, `host/SPIKE-0.017.md`

- On a copy of the live database, export the owner and `iyye` rows and measure the released `kev-4b` against today's owner labels: the baseline per role.
- Fit calibration on a toy split; measure `calibrate_checkpoint.py` time.
- Provision Kev's frozen suite (needs network once, decision 6) and run one by-hand candidate with `--replay` on synthetic data: time, memory, how far it moves.
- Measure two Kev instances side by side on the Spark (memory, latency).
- Written up in `host/SPIKE-0.017.md`.

### N1 — Labels (~1 day; then daily owner labelling) — built 2026-10-27

- `/decisions queue`, per-question labels for toolkit selection and `promises_future_action`, `IYYE2_LABELS_DAILY`.
- Label counts per role and class in `/decisions`.
- Starts the label clock: about 15 a day gives 200–300 owner labels in two to three weeks.
- As built:
  - Owner labels per question are in `decision_labels` (migration 043; the 19 earlier labels carried over), with the tier that offered each (`via`).
  - A day's offers are kept in `decision_label_offers`, so asking again shows the same questions.
  - The queue:
    - offers owner and `iyye` scope only, answered rows only, one per state;
    - never offers a row naming a forgotten person;
    - takes roles in turn, at least a third of each day's picks at random;
    - shows the state and the exact question, never Kev's answer.
  - `/decisions label <id> [question] yes|no|skip`: a skip leaves the queue and is not a label.
  - `/decisions` shows the counts per role, question and class.

### N2 — Datasets (~1–2 days)

- `decisions/dataset.ts`, migration 043 (`decision_datasets`), grouped time splits, the sealed test with look counting, exclusions (scope, tombstones, mentions), the frozen manifest, `scripts/decisions-dataset.ts`.
- Tests:
  - no future evidence in an input;
  - a day never split;
  - test rows never in training, calibration or replay;
  - a forgotten person's rows and mentions excluded;
  - weak and owner labels kept apart.

### N3 — The night phase (~2 days)

- The training phase in `NightWork` behind `IYYE2_DECISION_TRAINING`: eligibility and skip reasons, the memory-gate job, the memory check, SIGTERM on `shouldStop`, the time budget, train from the clean pin with replay, calibration, candidate registration.
- Tests with a fake trainer:
  - stop within the bound and nothing registered (§15 #19);
  - a short window skipped;
  - a failed run leaves the active bundle untouched.
- One real night on the Spark with the policy on and candidates only.

### N4 — Evaluation and the registry (~2 days)

- Held-out metrics, baselines, the regression suite, the frozen verdict, the registry states, `/decisions learning`, the day summary line.
- Tests: a candidate with better loss but worse calibration or a suite regression is rejected (§15 #20); a missing or altered artifact cannot register (manifest check).

### N5 — Shadow and activation (~2–3 days)

- The second Kev instance, routing by scope, shadow judgments in the idle loop, `/decisions activate|pin|revert|reset|stop`, the health check and automatic rollback across a restart, quarantine on `/forget`.
- Tests:
  - a contact's request never reaches the personal bundle;
  - a stale or unknown id falls back to generic (§15 #17);
  - activation interrupted by a crash leaves the old pointer (§15 #20);
  - `/forget` quarantines affected bundles and the next rebuild excludes the rows (§15 #21).

### N6 — Evaluation (exit gate, the owner's multi-night trial)

At least 7 nights with the policy on after N5. The HLD §14 exit gate: useful held-out improvement, or weak candidates correctly rejected; owner interruption within its bound; bad or missing artifacts never activate; a forgotten source deactivates its bundles; the previous bundle survives a crash or failed training. Only after that may the owner enable bounded automatic promotion as a separate policy.

**Then CH6** (plan 0.009) adds the voice as a second tunable on the same registry, held-out and preemption machinery.

## 5. Risks

- **Too few labels.**
  - Nothing trains below the minimums, and candidates that cannot beat the active bundle are rejected.
  - The queue keeps the owner's effort to a few minutes a day.
  - If labels stay scarce, the honest outcome is "no update", reported as such.
- **Overfitting the owner's recent days.** Time-ordered sealed tests, replay from Kev's suite, bounded steps, and a fresh test set after repeated looks.
- **Private words in weights.**
  - Owner-scope only.
  - Never served to contacts.
  - Rebuild from the clean pin, and quarantine on `/forget`.
  - Sanitisation is not claimed as protection (HLD §10.2).
- **Device contention at night.** Training runs last, inside the memory gate, under a memory check and a time budget, and gives way to owner input in under a second (measured).
- **A worse bundle by day.** Shadow before activation, owner activation, a health check at switch, two earlier bundles for revert, and the generic fallback always available.

## 6. Owner decisions (accepted as recommended, 2026-10-27)

1. **Whose decisions train the personal adapter:** owner and `iyye` scope only, served only to them, with contacts always on the released model (recommended). Or contacts' decisions too, in one adapter served to all (breaks HLD §10.2's pooling rule unless each contact gets their own).
2. **Weak labels in training:** none at first (recommended, test and verdict owner-only either way). Or toolkit selection's used-toolkit positives and memory salience's transfer results at reduced weight.
3. **Daily labelling:** `IYYE2_LABELS_DAILY` 15 (recommended) or another number, and the minimums (30 new labels, 20 per class).
4. **Night budget:** 30 minutes, completed nights only, after the memory phases (recommended).
5. **Each candidate from the released pin** (recommended: forgetting is a rebuild) or continued from the active bundle (cheaper later, but contaminated lineage on `/forget`).
6. **Provision Kev's frozen replay suite** (`evals/v7/decision-v7`, from the `jaredpalmer/kev-suites` Hub mirror, checked against its manifest's hashes; one download, offline after): yes (recommended) or train without replay (riskier forgetting of the released recipe).
7. **Activation:** the owner activates each bundle after at least 3 days of shadow (recommended). Automatic promotion is not offered before N6.
8. **Roles in the first adapter:** memory salience, observation importance, reply review and toolkit selection (recommended; `fact_relation` and `voice_meaning` stay shadow and unlabelled for now).
9. **Order:** N0 and N1 now, N2–N5 while labels accumulate (recommended).
