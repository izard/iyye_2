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
  - The host's single-instance lock (`~/.iyye2/host.lock`), which the offline training session takes so the two never run together (§3.3).
  - `/forget`, which deletes a person's decisions by scope, and `memory/mentions.ts`, which finds stored text naming a person.
- **What the live records hold (Spark, 2026-10-27):**
  - About 850 decisions; 85 % are in owner or `iyye` scope.
  - Owner labels: 12 memory salience, 5 reply review, 2 observation importance, none for toolkit selection.
  - About 650 weak labels: memory salience from Hindsight's transfer, reply review from the commitments ledger, toolkit selection from the tools a turn used.
  - **Labels, not code, are the bottleneck.** No candidate can be judged on 19 owner labels (HLD §10.4: small datasets cannot establish an improvement). Labelling starts first and runs while everything else is built.
- **Not built (TRAINING.md, "Known gaps"):** dataset export and splits, calibration, the replay suite, the offline training session, evaluation gates, the registry, activation, rollback and the forgetting rules for weights.

## 2. Scope

**In:**
- One multitask Kev adapter (LoRA + pointer head) over the roles the owner labels, trained in an offline session while Iyye is stopped, mostly at night (§3.3).
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
- **The manifest:** each session's dataset is frozen with:
  - the row ids, their split, and their label sources and strengths;
  - the exclusions with their reasons (names never written into it);
  - the policy;
  - a hash.

  It is stored in `decision_datasets` (migration 044; 043 is N1's `decision_labels`). Content stays in SQLite; the JSONL is written to the training directory for the run and deleted after it.

### 3.3 The offline training session (N3)

Owner decision 2026-10-27, revising decision 4: training runs **while Iyye is stopped**, not as a phase inside the running host. There are two reasons:
- **RAM:** N0's replay runs needed 50–54 GB of device memory and took the Spark past its 121 GB beside the day models.
- **Data races:** with the host down, nothing writes the database, the decision journal or the labels while a dataset is cut, trained on and registered.

The owner stops Iyye for the night's training (mostly at night), by hand or with their own scheduler. Iyye never stops or restarts itself for training.

- **The session:** `scripts/decisions-train.ts`, run by the owner, or by the owner's scheduler, while the host is stopped.
  1. **It takes the host's lock** (`~/.iyye2/host.lock`, the host's own `acquireHostLock` rule):
     - it refuses while a host holds it;
     - while it holds the lock, a host started by mistake refuses to start and names the training run;
     - it also refuses while anything still listens on Iyye's own ports: the router on 8180, Kev on 8188, Hindsight, or the router's model servers.
  2. **Eligibility:**
     - the policy is on (`IYYE2_DECISION_TRAINING`, default `off`);
     - at least `IYYE2_TRAIN_MIN_NEW_LABELS` (default 30) owner labels arrived since the last candidate;
     - every trained role has at least `IYYE2_TRAIN_MIN_PER_CLASS` (20) of each class in training.

     Otherwise it records "skipped: …" and exits 0. No update is better than a noisy one.
  3. **The dataset (N2) is cut and frozen first,** in one transaction, as a `decision_datasets` row and its manifest. Training reads only the JSONL exported from it; nothing in the run holds the database open.
  4. **The memory check:** available memory against the measured peak plus a margin, measured with the host stopped (N0's 54 GB peak is the starting point). It refuses below that.
  5. **Training** (`train_candidate.py`):
     - bounded by `IYYE2_TRAIN_MAX_MIN` (30);
     - SIGTERM or Ctrl-C (the owner, or the scheduler before it starts Iyye again) stops it in under a second (measured 0.68 s) and discards the candidate. Kev's LoRA runs cannot resume, so a stopped session trains again next time.
  6. **Evaluation (N4) in the same session,** while the device is free: the candidate, the active bundle and the fallback are scored on the validation and sealed test splits, and the regression suite is run.
  7. **Registration:** one short transaction writes the candidate, its metrics and its verdict to the registry. A session that dies before that leaves the registry as it was. A candidate directory with no registry row is never loaded, and the next session deletes it.
  8. **It releases the lock** and prints a summary for the owner, also kept for `/decisions learning`. Then Iyye can be started again.
- **What stopping Iyye means for the night:**
  - The memory night (retain, consolidation, the fact ledger) runs inside the host. The owner runs the session after a completed night, or accepts that the night's memory work waits for the next one.
  - While Iyye is stopped:
    - Telegram keeps updates for Iyye to fetch on start;
    - mail stays in the mailbox;
    - reminders and anything else due wait until it starts again.

  The owner picks the window.
- **By-hand experiments follow the same rule:** the owner is asked to stop Iyye first.
- **From the clean base (decision 5):**
  - Every candidate is trained from the released `kev-4b` pin on the session's full, current, clean dataset, never from the active candidate.
  - This keeps no lineage of forgotten data in the weights and makes forgetting a rebuild (HLD §10.5).
  - It is affordable while datasets are hundreds of rows.
- **Replay:** Kev's frozen suite (decision 6) mixes `--replay` records in, so a small personal set does not erase the released recipe.
  - The suite is the released model's own, decision-v7. It is provisioned at `~/.iyye2/decisions/suites` by `decision-worker/provision_suite.py`.
  - The mix is sized to Iyye's own data (start at 2–4 replay records per own example). The released recipe's 4000 would drown a few hundred labels (N0).
  - What drives the replay peak (most likely the suite's many-option questions) is found and bounded before N3 trains on a schedule.
- **Calibration:** a temperature fitted on validation only, with `kev.metrics.fit_temperature` at Kev's release settings (116 ms; the cost is scoring the rows).
  - It is recorded in the bundle's registry entry. How the serving instance is given it (a load-time override) is to be verified in N4.
  - Never written into `head.pt`: `scripts/calibrate_checkpoint.py` does that, which would void the manifest (N0).

### 3.4 Evaluation and the registry (N4)

- **The registry:** `decision_artifacts` (migration 045) holds:
  - id, parent pin, dataset id and hash, manifest hash, roles;
  - state `candidate → evaluated → shadow → active → retired | quarantined`;
  - metrics, verdict and reasons, timestamps.

  Only the registry code changes a state: the offline session registers candidates and verdicts, and the host moves them through shadow and activation by day. The trainer only writes candidate directories.
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
  - The next eligible training session rebuilds from the clean dataset. The owner is told which bundles went, never what they held.

### 3.6 What the owner sees

- `/decisions learning`:
  - the last session's dataset (counts per role, class and split; exclusions by reason);
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

- `decisions/dataset.ts`, migration 044 (`decision_datasets`), grouped time splits, the sealed test with look counting, exclusions (scope, tombstones, mentions), the frozen manifest, `scripts/decisions-dataset.ts`.
- Tests:
  - no future evidence in an input;
  - a day never split;
  - test rows never in training, calibration or replay;
  - a forgotten person's rows and mentions excluded;
  - weak and owner labels kept apart.

### N3 — The offline training session (~2 days)

- `scripts/decisions-train.ts`, behind `IYYE2_DECISION_TRAINING`:
  - the host lock both ways, and the refusal when Iyye's ports are in use;
  - eligibility and skip reasons;
  - the frozen dataset, the memory check and the time budget;
  - SIGTERM, training from the clean pin with replay, and calibration;
  - registration in one transaction, and cleanup of unregistered candidate directories.
- Before it trains on a schedule: the replay memory peak found, bounded and measured with the host stopped.
- Tests with a fake trainer:
  - refuses while a host holds the lock, and a host refuses to start while a session holds it;
  - a stop within the bound leaves nothing registered (§15 #19);
  - a failed or killed run leaves the registry and the active bundle untouched.
- One real session on the Spark with Iyye stopped, the policy on, candidates only.

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

At least 7 training sessions with the policy on after N5. The HLD §14 exit gate: useful held-out improvement, or weak candidates correctly rejected; owner interruption within its bound; bad or missing artifacts never activate; a forgotten source deactivates its bundles; the previous bundle survives a crash or failed training. Only after that may the owner enable bounded automatic promotion as a separate policy.

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
- **Iyye unavailable while it trains.** Training needs the host stopped (owner decision 2026-10-27). Messages wait, and reminders due in the window are late. The owner picks the window; the session is bounded (30 min plus evaluation) and stops in under a second on SIGTERM.
- **A host started during training.** The session holds the host's lock, so the host refuses to start and names the run. Nothing is half-registered: registration is one transaction at the end.
- **A worse bundle by day.** Shadow before activation, owner activation, a health check at switch, two earlier bundles for revert, and the generic fallback always available.

## 6. Owner decisions (accepted as recommended, 2026-10-27)

1. **Whose decisions train the personal adapter:** owner and `iyye` scope only, served only to them, with contacts always on the released model (recommended). Or contacts' decisions too, in one adapter served to all (breaks HLD §10.2's pooling rule unless each contact gets their own).
2. **Weak labels in training:** none at first (recommended, test and verdict owner-only either way). Or toolkit selection's used-toolkit positives and memory salience's transfer results at reduced weight.
3. **Daily labelling:** `IYYE2_LABELS_DAILY` 15 (recommended) or another number, and the minimums (30 new labels, 20 per class).
4. **Night budget:** 30 minutes. Revised 2026-10-27: training runs in an offline session while Iyye is stopped, not as a phase in the running host (RAM and data races, §3.3). The owner stops Iyye, preferably after a completed night.
5. **Each candidate from the released pin** (recommended: forgetting is a rebuild) or continued from the active bundle (cheaper later, but contaminated lineage on `/forget`).
6. **Provision Kev's frozen replay suite** (`evals/v7/decision-v7`, from the `jaredpalmer/kev-suites` Hub mirror, checked against its manifest's hashes; one download, offline after): yes (recommended) or train without replay (riskier forgetting of the released recipe).
7. **Activation:** the owner activates each bundle after at least 3 days of shadow (recommended). Automatic promotion is not offered before N6.
8. **Roles in the first adapter:** memory salience, observation importance, reply review and toolkit selection (recommended; `fact_relation` and `voice_meaning` stay shadow and unlabelled for now).
9. **Order:** N0 and N1 now, N2–N5 while labels accumulate (recommended).
