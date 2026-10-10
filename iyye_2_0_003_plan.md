# Iyye 2.0.003 — Local Decisions (Kev): Implementation Plan

- Status (2026-10-03): Kev installed (owner approval 2026-10-03). **K0 (spike): go** for shadow mode (`decision-worker/SPIKE.md`). **K1 (supervised service) done. K2 (contract and journal), K3 (memory salience, reply review) and K4 (owner view, §15 #16–#18) done in code and tests**; K3's live exit (a real night and a day of replies journaled) needs the host restarted and a day of use. On the Spark, Kev runs on CUDA (2026-10-10, `IYYE2_DECISIONS_PYTHON`; the CPU build's ~9 s per decision had timed out every call since the move). Every role here is shadow; later, `observation_importance` (0.007 S4) and toolkit selection (0.004 §3.4) became acting.
- Scope: a local typed-decision service (Kev) that answers bounded questions with probabilities. In this increment it runs in **shadow mode only**: every answer is recorded and compared with what actually happened, and nothing it says changes what Iyye does.
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §9.4 (typed decisions), §9.3 (one admission broker), §5.1 (one device task at a time), §10 (decision learning, later), §14 Stage 0 (the decision part of the spike, skipped by the 0.001 ordering note), §15 #16–#18.
- Builds on 0.001 (models, scheduler, Pi, outbox) and 0.002 (STM/LTM, day and night, the device slot and the memory gate).
- Upstream: Kev at `kev/` (jaredpalmer/kev @ `84847f0`), served with its own `kev.serve` (FastAPI, MLX backend on Apple Silicon). Checkpoint `jaredpalmer/kev-4b` (LoRA on Qwen3.5-4B-Base, calibration temperature built in).

## 1. What exists, and the gap

| Need (HLD) | Before 0.003 | 0.003 |
| --- | --- | --- |
| Typed semantic judgments | none: every decision is a deterministic rule | a decision service with versioned roles, schemas, abstention and fallback |
| Decision journal (§3.1) | none | `decisions` table: input refs, role and schema version, model/adapter/head/calibration revision, probabilities, fallback reason, kernel outcome, later feedback |
| Labels for future learning (§10.2) | none | outcome joins on shadow decisions: candidate labels with provenance, not yet training data |
| Device sharing | chat, console and memory share one `DeviceSlot` | Kev calls take the same slot (Metal) |

## 2. Kev facts this plan relies on (from `kev/AGENTS.md` and `kev/README.md`; K0 measures each on this Mac)

- **API:** `POST /v1/systemone` with a `state` (text or JSON) and named `questions` of type `noul` (probability of yes), `choice` (1–255 named options, probabilities and confidence) or `score` (ordered levels). No text generation. `GET /v1/models` reports the checkpoint, device, dtype, temperature and prefix-cache statistics. A bearer key when `KEV_API_KEY` is set; binds 127.0.0.1 by default. A state over 65,536 tokens gets 422, never a silent cut.
- **Apple Silicon:** Qwen3.5 checkpoints serve through MLX (`kev/mlx_model.py`). Reported on an M5 for Kev-4B, 5 questions on a ~270-token state: 721 ms with a new state, 136 ms with a cached state (torch bf16: 3,302 / 847 ms). Kev-4B through the LoRA path peaks at about 15.9 GB at load (the merge), about 8.4 GB as full weights.
- **Calibration** is part of the checkpoint (`head.pt["temperature"]`, 4B: 2.41); `KEV_TEMPERATURE=1.0` returns raw probabilities.
- **Training:** `kev.train` (LoRA + head, `--init_from` for delta training). Its Modal paths run on paid cloud GPUs and some push to the HF Hub; **Iyye never uses them** (CLAUDE.md, owner approval required). Kev's frozen eval suites and held-out data are never modified or trained on.

## 3. Design decisions

### 3.1 Shadow first, by construction

- In 0.003 no decision result reaches a branch that changes Iyye's behaviour. The code path is: build the question from records, call Kev, journal the answer, compare later. The kernel's outcome is always its existing deterministic rule.
- This is enforced structurally, not by convention: shadow roles return `void` to their callers, and the only writer of their results is the journal. A test asserts that a decision service answering "yes, 1.0" to everything changes no job, delivery, transfer or mode (HLD §15 #16).
- Promotion of a role from shadow to acting is a later owner decision per role, gated on measured agreement and calibration (§7).

### 3.2 Roles in this increment

Chosen because each has an automatic, independent outcome to compare against, so shadow mode produces evidence without extra owner effort:

1. **Memory salience (night).** Before each STM episode is retained: "Does this message contain something worth remembering about the person, beyond small talk?" (`noul`). Outcome: `completed` vs `completed_empty` from Hindsight's extraction. If it agrees well, a later increment can skip extraction for clear small talk and shorten the night (each retain costs 12–45 s). The outcome is a weak label: extraction is itself a model judgement.
2. **Reply review (day, after delivery).** For each delivered reply: "Does the reply promise an action Iyye cannot take (a reminder, a follow-up, contacting someone)?" (`noul`). (A "does the reply answer the message?" `score` was dropped after K0: no useful spread.) Outcomes: owner corrections when they come, and later the commitments ledger. Mostly a calibration probe in 0.003; Iyye's tools are read-only, so a promise of a future action is always unsupported (identity prompt rule).

3. **Toolkit selection (day, before each turn; added for plan 0.004 §3.4).** One `noul` per permitted, non-core toolkit: "Does this message need <toolkit description>?". Outcome: the tools the model actually called in that turn, which is free and automatic. Shadow only: the active tools do not change.

Deferred: intent/admission, attention, initiative, contact urgency while asleep. Each needs records or behaviour that do not exist yet.

### 3.3 Decision contract (`host/src/decisions/`)

- A **role** is a versioned record: name, schema version, question type, fixed instructions and criteria text, how to build the state from records (never free text chosen by a model), abstention band (e.g. `noul` between 0.35 and 0.65 is "abstain"), and the deterministic fallback (the existing rule).
- **State building** uses only the records the role names (the STM episode, the delivered action). Contact text is data inside the state; Kev's server escapes delimiter-like input. Display names are quoted as in prompts.
- **Journal** (the next free migration, `decisions`; 010 went to plan 0.004 T1): id, role, schema version, input record ids and a hash of the exact state, checkpoint id and revision, adapter/head hashes and temperature (from `/v1/models`), raw answer JSON, the derived verdict (`yes`/`no`/`abstain`/`error`), latency, the kernel's actual outcome, and the outcome joined later (`outcome`, `outcome_at`, `outcome_source`). Rows are created only for shadow calls; nothing reads them to decide.
- **Failure:** timeout, 4xx/5xx, malformed answer → `error` row, the kernel goes on; never a retry storm, never a hosted fallback.

### 3.4 The service and the device

- **Process:** the host supervises `kev/.venv/bin/python -m kev.serve` like Hindsight (`SupervisedProcess`): 127.0.0.1:`IYYE2_DECISIONS_PORT` (8188), key from `~/.iyye2/decisions/secrets/kev_api_key` (0600), `HF_HOME=~/.iyye2/decisions/hf` with `HF_HUB_OFFLINE=1` after provisioning, minimal environment, pid file, adopt-or-start, health via `GET /v1/models` with the key.
- **Device:** Kev runs on Metal, so every call takes the shared `DeviceSlot` (`decision:<role>`), with a short timeout. Shadow calls never wait in line: like memory work, they run only when no chat job is queued and give up otherwise (a skipped shadow call is journaled as `skipped`, not retried forever).
- **Day and night:** at night the chat models are unloaded and memory work holds the slot between episodes; the salience call runs inside the same night loop, before each retain, under its own slot acquisition. Whether Kev stays resident (RAM) or starts per night is decided by K0's measurements.
- **Status:** a `decisions:` chip in the web UI and `/decisions` (§3.5).

### 3.5 Owner view

- `/decisions` — service state, checkpoint and revision, per role: calls, abstentions, errors, agreement with outcomes so far, and the last few verdicts with their probabilities.
- `/decisions <role>` — the recent rows of one role with their state hash and outcome.

## 4. Milestones

### K0 — Spike (gate)
- Install Kev (`uv sync --frozen --extra serve` in `kev/`) and download `kev-4b` into `~/.iyye2/decisions/hf`.
- Serve it on 127.0.0.1:8188 with a key; measure on this Mac with the owner's chat models loaded: load time, steady and peak RSS, latency for a new state and a cached state, and behaviour while a llama.cpp generation is running (shared Metal).
- Ask the two §3.2 roles over the owner's real records, read-only: the STM episodes with known `completed`/`completed_empty` outcomes, and the delivered replies. Record agreement and the probability spread. Try `kev-0.8b` for comparison if RAM or latency is a problem.
- (Dropped by the owner: no training round trip now; training comes later, nightly; §8.3.)

Exit: go/no-go per role, the checkpoint choice, resident vs per-night, recorded in `decision-worker/SPIKE.md`.

*(Done, 2026-10-03; see `decision-worker/SPIKE.md`.)* kev-4b: 7 s offline load, 15.9 GB peak, about 9–10 GB resident, 110–480 ms per call idle, about 340 ms during a llama.cpp generation, which itself was not slowed. "Promises a future action": 6/6, and 0.83 on the real incident reply. "Worth remembering": separates small talk (0.03–0.22) from facts (0.32–0.74), but needs a fitted threshold. "How well does it answer": no useful spread, so it is dropped. Kev stays resident by day.

### K1 — Supervised decision service
- `host/src/decisions/service.ts`: the supervised `kev.serve`, provisioning check (`scripts/provision-decisions.ts`, explicit like `provision-memory.ts`), status, key, adoption, offline after provisioning.

Exit: tests with a fake Kev server (`test/fixtures/fake-kev.mjs`); the host starts, adopts and stops it; a real smoke on a scratch port.

*(As built, 2026-10-03)*
- **`host/src/decisions/service.ts`** (`DecisionService`) runs `kev/.venv/bin/python -m kev.serve --run <pinned repo@revision> --host 127.0.0.1 --port <port>` through the shared `SupervisedProcess`.
  - The environment is built from scratch: `HF_HOME=~/.iyye2/decisions/hf`, `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `HF_HUB_DISABLE_TELEMETRY`, and `KEV_API_KEY` from a 0600 file. No inherited `HF_TOKEN` or other secret reaches it.
  - States: disabled, not installed, needs provisioning, starting, up, retrying, stopped. Startup runs in the background with a health loop and backoff.
  - **Health** is `GET /v1/models` with the key, and it must report exactly the pinned `run`. A server serving any other checkpoint is never treated as up (HLD §15 #17).
  - **Adoption** after a host crash requires the same check. `SupervisedProcess` gained `healthHeaders`, because Kev's `/v1` routes need the key.
- **Provisioning** is an explicit owner step: `host/scripts/provision-decisions.ts` uses Kev's own `resolve_run`/`read_meta`, so it fetches exactly the checkpoint and the base revision the checkpoint names. It writes `~/.iyye2/decisions/provisioned.json`; the host refuses to start Kev until that file matches `IYYE2_DECISIONS_MODEL`.
- **Wiring:** `main.ts` starts the service in the background and stops it on shutdown. `/api/status` and the web UI have a `decisions` chip. The memory chip now takes its colour from the long-term part of its status: since L4 the status starts with the mode, so it always showed a warning.
- **Config:** `IYYE2_DECISIONS_ENABLED`, `IYYE2_DECISIONS_DIR`, `IYYE2_DECISIONS_PORT` (8188), and `IYYE2_DECISIONS_MODEL` (default `jaredpalmer/kev-4b@6cfce5c2fa4b4bd64026336ab649c5ca78857d52`).
- **Tests:** `test/decisions.test.ts`, with the fake `fixtures/fake-kev.mjs`. Covered:
  - not installed, needs provisioning, and provisioned-for-another-model;
  - the exact environment, with no `HF_TOKEN`;
  - the key file is 0600 and a request without the key gets 401;
  - checkpoint info;
  - a mismatched checkpoint is never up;
  - adoption after a host crash and restart after a kill.
- **Real smoke** (`host/scripts/decisions-smoke.ts <scratch>`, free port, model cache linked, not copied):
  - offline and up in 8.0 s, reporting the pinned run;
  - one decision in 207 ms (p 0.81 for "I'll remind you tomorrow…");
  - 401 without the key;
  - clean stop.

### K2 — Decision contract and journal
- Roles, state builders, abstention bands, the client (device slot, timeout, auth), the `decisions` migration, `decisions` rows with revisions.

Exit: unit tests for schema validation, abstention, malformed and truncated answers, revision recording; the "always yes 1.0" test changes nothing (§15 #16).

### K3 — Shadow roles
- Memory salience inside the night loop; reply review after each delivered reply (day, idle-gated).
- Outcome joins: salience ← the episode's transfer state; reply review ← owner corrections (recorded via an owner command for now) and later commitments.

Exit: a real night with the salience role journaled; a day of replies reviewed; agreement figures in `/decisions`.

### K4 — Owner view and acceptance
- `/decisions`, `/decisions <role>`, the UI chip; HLD §15 #16 (decision boundary), #17 (revision binding: a missing or changed checkpoint is detected and recorded, never silently used), #18 (label integrity: outcomes join the right decision; no future evidence in the stored state).

*(K2–K4 as built, 2026-10-03)*
- **K2, contract and journal** (`decisions/client.ts`, migration `015_decision_labels.sql`):
  - A `Role` is versioned: name, schema version (bumped whenever its questions or state change, so rows of different versions are never pooled), abstention band, and the deterministic `fallback` that stays in charge. Its questions are fixed text in the role's module.
  - The journal also records the LoRA rank and precision (`lora`, `dtype`). The run is pinned to a commit, which fixes the adapter and head; Kev does not expose separate hashes.
  - **Errors, never guessed:** a malformed or missing answer, an HTTP error, a timeout (`IYYE2_DECISIONS_TIMEOUT_MS`, 5000), a `truncated: true` answer, and a checkpoint that changed while the call was running. A service that is not up gives `skipped`. `skip()` journals a call that was not made (the device was busy) with its reason. Nothing is retried.
  - **Outcomes:** `joinOutcome` is the one writer. `label_strength` is `weak` (another model or process) or `owner`. A weak label never replaces an owner label; an owner label replaces a weak one. Kev's own answer is never written as an outcome.
- **K3, the shadow roles:**
  - **Memory salience** (`decisions/memory-salience.ts`). `NightWork` gets an optional `salience` observer.
    - It asks before each retain, with the person's message alone as the state (as in K0), and joins the transfer's result as a weak label (`hindsight_extraction`: `completed` → worth remembering).
    - A failed transfer is no outcome. A backlog episode retried on a later night reuses its *answered* decision, so one message is never two examples; a skipped or failed one (Kev down, device busy) is asked again on a later night, and the night asks at most once per episode per run. Only an answered decision gets an outcome. `/remember` entries are not asked.
    - It takes the device slot with `tryAcquire`; a busy device is journaled as skipped. The night never reads the answer.
    - Band 0.2–0.35, from K0's spread.
  - **Reply review** (`decisions/reply-review.ts`): "does the reply promise a future action?", with K0's wording and `{message, reply}` as the state (K0's live test).
    - The work list is SQLite itself: delivered replies with no review row, since the role first started (`decisions.reply_review.since` in kv). It is restart-safe, never re-asks, and never asks about history before the role existed.
    - It runs one at a time from an idle loop (`decisions/idle.ts`, now shared with toolkit selection), only while the decision service is up (otherwise a reply would be journaled as skipped and never reviewed), no chat waits and the device is free.
    - Forgotten replies (`[forgotten]`) are never reviewed.
  - **`/forget` reaches the journal** (plan 0.002 L6): the person's rows go with their scopes. For the owner's unstored replies (which may quote the person), `forgetReplyReviews` deletes their reviews and leaves a marker row with an empty state, so they are never reviewed. The client's one writer drops an answer that comes back after a `/forget`: when the scope's tombstone is newer than the call's start, or a marker exists for its subject.
    - Labels come from the owner: `/decisions label <id> yes|no`.
- **K4, owner view** (`decisions/report.ts`):
  - `/decisions` per role:
    - salience: outcomes, mean p for kept vs nothing kept, agreement at its band, and the best single threshold so far (the evidence for an owner decision to let it act; weak labels);
    - reply review: yes/unsure/no counts, agreement with your labels, the latest "yes"/"unsure" replies to label with their ids, and how many replies wait;
    - toolkit selection, as before.
  - `/decisions <role>` shows the recent rows: id, time, scope, p and verdict, the outcome with its source and strength, and the state hash with a preview.
  - `/decisions label <id> yes|no` gives an owner label, for salience and reply review only. Toolkit selection is labelled automatically.
  - The UI chip is unchanged (K1).
- **Acceptance** (`test/decision-roles.test.ts`, 11 tests; `test/decisions.test.ts`, 1 more; `test/memory-acceptance.test.ts` #15 checks that no reply review quoting a forgotten person survives):
  - **#16:** with Kev answering always 1.0 and then always 0.0, the night retains the same documents, STM and events end in the same states, and delivered replies are untouched. Toolkit selection's version is in `decision-shadow.test.ts`.
  - **#17:** a checkpoint swapped under a running host (the fake Kev reports another run) takes the service out of `up` at the next health check, `checkpoint` becomes null, and calls are journaled as skipped. A swap during a call is an error. The full revision is recorded on every answered row.
  - **#18:**
    - each outcome joins its own episode's decision;
    - the stored state is exactly the pre-decision input (the message; the message and the delivered reply), never Iyye's reply for salience and never the transfer's result;
    - one decision per message across nights;
    - weak labels never replace owner labels;
    - an answer in flight during `/forget` is not written back.
  - The suite has 266 tests. (A SearXNG supervision test flaked about one run in ten: its wait read the pid file while the supervisor was replacing it. Fixed in the test.)
- **Not done here (later, with nightly learning, §8.3):** the training phase itself; turning salience into an acting role (an owner decision, from its threshold figures); commitment-ledger outcomes for reply review (plan 0.006).

## 5. Risks

- **RAM:** with gemma-4-26B and qwen38-27b-tak loaded by day (about 55 GB), Kev-4B adds about 8–16 GB. Fits 128 GB, but K0 must measure the peak alongside the night's memory model.
- **Metal contention:** Kev and llama.cpp share the GPU. The device slot serialises them; the cost is added latency to whichever waits.
- **Weak labels:** Hindsight's `completed_empty` is one model's judgement, not truth. Agreement with it is a sanity signal, not an accuracy figure.
- **Distribution shift:** Kev is trained on public datasets and generated policy records, not on Iyye's conversations or Russian text.

## 6. Out of scope for 0.003

- Any acting role (all shadow).
- Training, adapters, the model registry and nightly tuning (Stage 4). Per the owner, these will run every night as a phase of the night loop; §8.3 lists what 0.003 leaves ready for them.
- Intent/admission, attention and initiative roles.
- Hosted inference of any kind; Modal; Hub pushes.

## 7. Configuration (planned)

| Name | Default | Meaning |
| --- | --- | --- |
| `IYYE2_DECISIONS_ENABLED` | `1` | supervise the Kev service |
| `IYYE2_DECISIONS_PORT` | `8188` | Kev on 127.0.0.1 |
| `IYYE2_DECISIONS_DIR` | `iyye_2/kev` | the Kev checkout with its `.venv` |
| `IYYE2_DECISIONS_MODEL` | `jaredpalmer/kev-4b` | checkpoint (Hub id, pinned to a revision after K0) |
| `IYYE2_DECISIONS_TIMEOUT_MS` | `5000` | per call; past it the call is journaled as `error` |

## 8. Owner decisions

1. **Install Kev and download the checkpoint: yes** (2026-10-03).
2. Proposed after K0 (open for the owner): kev-4b, resident by day; roles: memory salience and reply-promise review, both shadow. 
3. **Training: not in 0.003; nightly when it comes** (owner, 2026-10-03). No training round trip in K0. Decision learning becomes part of every night (HLD §8.3 phase 6, §10.3), after the memory transfer and consolidation, in the same rhythm and under the same device slot. So 0.003 must leave everything a nightly trainer will need:
   - **Journal rows that can become training examples without rework:** the exact pre-decision state (or a reference that reproduces it byte for byte), role and schema version, checkpoint/adapter/head/calibration revision, and outcome joins with provenance (HLD §10.2: no future evidence in the input, weak labels marked as weak).
   - **A night phase slot:** the night loop runs transfer, then consolidation; training will be a third phase with its own watermark, interruptible like the others.
