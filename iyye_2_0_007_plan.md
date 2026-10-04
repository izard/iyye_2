# Iyye 2.0.007 — Resident Life (Stage 2, R1–R2): Implementation Plan

- Status (2026-10-04): **accepted; S0 (spike) done** (`host/SPIKE-0.007.md`: gemma-4-E4B, abort-and-host-note resume, importance wording v1 with band 0.30/0.45). **S1 (background jobs, pause, throttle), S2 (adenosine) and S3 (Iyye's messages, wake check, day summary) S4 (workspace repository, observation domains, importance check, findings) and S5 (opportunities and investigations) done: 0.007 is built.** What remains is live use (the first days of findings and investigations) and tuning from `/energy`, `/decisions` and `/opportunities`. Built on the owner's Stage 2 decisions (§7), chosen from [`iyye_2_0_stage2_options.md`](iyye_2_0_stage2_options.md). The owner moved 0.007 ahead of 0.006 (2026-10-04); 0.006's plans (C4) use this plan's background jobs (S1).
- Scope: Iyye acts without being asked, within bounds:
  - background jobs on a small model that pause for people;
  - adenosine as the energy budget;
  - a waking check and a day summary;
  - Iyye's own git repository;
  - observation domains whose findings Kev checks for importance before they enter memory and reach the owner;
  - an opportunity sweep with bounded investigations.
- Out of scope: relationship context (owner decision 8: later), web-based domains, quiet hours (needed only for Telegram, which findings never use).
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §5 (attention, motivations, initiative), §8 (modes, adenosine, dreaming), §9.1 (probes), §11 (a recognizable day, damping), §14 Stage 2, §15 #9, #10, #11, #16.

## 1. Lessons from 1.x carried as rules

Iyye 1.x had all of this and spent weeks damping it. These are rules of this plan, each with a test:

1. **Only records are evidence:** probe results, people's messages, receipts. Never Iyye's own text, a summary or a reflection.
2. **Evidence settles:** a finding closes its evidence ids; a closed id never qualifies again.
3. **Fruitless work is bounded:** 3 fruitless attempts per evidence cluster, then suspended until new evidence.
4. **Damping state survives restarts:** every counter, cooldown and budget lives in SQLite.
5. **Charges are centralized:** one ledger writer; nothing is charged twice for passing through two subsystems.
6. **Bookkeeping never becomes memory:** only findings are retained, never "the investigation completed".

## 2. Design

### 2.1 Background jobs (owner decisions 1, 2)

**Job kind.** `jobs.kind` gains `background`. A background job has:
- no triggering message (`trigger_event_id` becomes nullable for this kind only, by check constraint);
- an `origin` (an opportunity id, a night phase, or a plan step from 0.006);
- the internal scope `iyye`;
- a checkpoint (its Pi session) and a cost limit.

**Precedence** (HLD §5.1). The order is fixed in the scheduler:
1. owner input;
2. a person waiting, or a due commitment;
3. owner-requested work;
4. background work.

**The background model.**
- A new selection key `background`, set with `/use <model> background` and seeded from `IYYE2_BACKGROUND_MODEL`.
- Candidates are `gemma-4-E4B` and `qwen35-4b-tak`. The second shares Kev's Qwen3.5-4B base, which keeps later fine-tuning in one family; the S0 spike picks one.
- It stays loaded by day, alongside the chat model, and is unloaded at night like every model but the memory model.
- Background work never loads or unloads a model itself. If the model is missing, background work waits and `/focus` says why.

**Pause and throttle, as in 1.x.** Background work is stopped only at **safe checkpoints**, the 2.0 form of 1.x's cooperative streams.
- A checkpoint is the end of a completed message in the step's Pi transcript: the prompt, or a tool result.
- When a reply job, a due commitment or owner input is admitted, the scheduler asks the running background step to **pause**:
  - a generation in flight on the 4B model is aborted, discarding only that partial generation;
  - the transcript ends at the last checkpoint, and the device slot is released.
- The person therefore waits at most about one second, not a whole step.
- The paused job keeps its session and **resumes** later from that checkpoint: Pi's agent continues a transcript that ends in a user or tool-result message. The S0 spike confirms that the session API supports this without a Pi core patch; if not, a pause redoes the current step from its start (steps are read-only).
- A tool call is never interrupted mid-execution: probes are short, so the pause waits for the result.

**Throttle:**
- no background step starts while a conversation is active (any chat activity in the last `IYYE2_BACKGROUND_QUIET_S`, 180 s);
- at least `IYYE2_BACKGROUND_GAP_S` (30 s) between steps;
- a step paused 5 times is suspended for the day.

**Owner controls:**
- `/focus`: what Iyye is doing now and the rule that chose it, the background queue, and paused or suspended work;
- `/pause initiative` and `/resume initiative`, persisted.

### 2.2 Adenosine (owner decision 3, HLD §8.2)

The 1.x model kept as a level, with honest charges.

- **Level** 0–1, persisted (`kv` plus an `energy_ledger` table: time, kind, amount, reference). One writer: `Adenosine.charge(kind, ref)`.
- **Depletion while awake.** Starting values are 1.x's, rescaled from its 1 s tick to time:

| Charge | 1.x | 2.0 starting value |
| --- | --- | --- |
| time awake | 0.0002 per tick | 0.04 per hour (a quiet 16 h day uses 0.64) |
| an STM write (an answered turn) | 0.005 | 0.005 |
| a focus switch (background paused or resumed for a person) | 0.015 | 0.01 |
| a model load or unload | 0.025 / 0.020 | 0.025 / 0.02 |
| device time | — | 0.02 per minute of background device time, 0.005 per minute of chat |
| an investigation step, a tool call | 0.01 / 0.015 | 0.01 per step |

- **Thresholds:**
  - below `0.35`, no new background work starts (the reserve);
  - below `0.15`, Iyye winds down to sleep at the next quiet moment (the owner has been silent for the existing quiet interval), as well as in the rest window.
- **Owner chat is never refused** for low adenosine (HLD §8.2); it is charged but always served.
- **Refill:**
  - a completed night restores 1.0;
  - a night interrupted by the owner restores in proportion to the night's work done (1.x's proportional refill);
  - a restart restores nothing.
- **Visible:** `/day` shows energy ("adenosine 0.62: background work allowed; sleep due near 23:40 at this rate"), and the memory chip shows it.
- **Tuning:** the charges are config values. After a week of use, the ledger shows where energy went (`/energy`), and the owner adjusts.

### 2.3 Waking check and day summary (owner decisions 4, 7)

**Wake check:**
- on waking, a deterministic check: services, the night's outcome, backlog and failed transfers, `unknown` actions, due-today commitments (0.006), and suspended background work;
- problems become one web chat message.

**Day summary.** At the end of the night:
1. A **digest** is built from records only:
   - conversations per person;
   - what was stored and what was not;
   - tool use;
   - findings and their sources;
   - commitments fulfilled or failed;
   - energy use;
   - failures.
2. The **memory model post-processes it** into a short readable message, under the memory gate with thinking off.
3. The output is **validated deterministically:**
   - every number and every name in it must appear in the digest;
   - it is shorter than the digest;
   - it contains no promise.
   On failure, the digest itself is sent.
4. It is delivered on waking as a web chat message.

**Messages to the owner.** A new outbox action kind `notice`:
- the route is always the owner's web chat;
- no Telegram, by owner decision 7;
- there is no triggering event; the action records its origin;
- it goes through `Outbox.deliver` like every outward message.

### 2.4 Iyye's git repository (owner decision 5)

Owner decision (2026-10-04): one repository, **Iyye's own workspace**. `iyye_2/` itself stays without git; the optional `project` domain (§2.5) can observe a repository the owner names, and is off by default.

- **Iyye's workspace repository** `~/.iyye2/workspace` (git), for code and artifacts Iyye itself produces.
  - This is where 1.x's generated streams lived; in 2.0, Stage 3 skills and plan artifacts go here.
  - Commits are made only by the host's broker (author "Iyye", message naming the job and evidence), never by a model holding a shell.
  - The host creates it on first start (`git init`, its own repository, nothing else touched).
  - In 0.007 it is observed (the `workspace` domain); nothing writes code to it yet.

### 2.5 Observation domains, importance check, findings (owner decisions 6, 7)

**Domains.** Approved by the owner (`/domains`, `/domain enable|disable <name>`). Each has a typed read-only probe, never Python or shell, a staleness window, and a deterministic change rule.

| Domain | Probe | Staleness | A change |
| --- | --- | --- | --- |
| `machine` | disk, memory pressure, loaded models and their RAM, service states (extends `system_status`) | 2 h | disk below 10% or −5 points, a service restarted more than twice, swap growing |
| `project` (optional, off unless `IYYE2_PROJECT_REPO` is set) | `git log`, `git status`, diff stats of that repository, run by the host with fixed arguments | 6 h | new commits, uncommitted changes older than a day, a test file changed |
| `workspace` | the same for `~/.iyye2/workspace` | 12 h | any new commit |

**Observations** (`observations` table): domain, probe, time, structured result, its hash, and the diff against the previous one. A probe run with no change is recorded and settles the staleness, but is never a finding.

**The importance check: Kev acting, by owner decision 6.** A new role `observation_importance`, a `noul` question: "Is this change worth remembering and telling the owner about?". The state is the domain plus the change, with no Iyye text.
- p ≥ 0.45: a **finding** (band from S0);
- p ≤ 0.30: recorded only;
- unsure, or Kev unavailable: the deterministic fallback, i.e. the change rule's severity (a threshold crossing is a finding; a minor change is not).

The answer is journaled with its revision. The owner labels it with `/decisions label`; "worth it" or "not" on a finding becomes an owner label. This is the first acting role. It decides only whether Iyye's own observation is kept and mentioned, never permissions, routes or anything about a person.

**A finding:**
- is posted as a **web chat message** (outbox `notice`), at most `IYYE2_FINDINGS_PER_DAY` (5) a day, never during an active conversation (held until quiet), never while asleep;
- enters the owner's **STM** as kind `observation` in a new owner-readable scope `iyye`, so the owner can ask about it the same day;
- moves at night into long-term memory in the bank `iyye-self`:
  - readable by the owner, never by contacts;
  - tagged `speaker:probe` with its domain and observation id;
  - recall labels it "observed by Iyye on <date> via <probe>", distinct from a person's statement and from Iyye's words.

### 2.6 Opportunity sweep and investigations (HLD §5.3)

**The sweep.** Every 30 minutes while awake and idle, a deterministic sweep collects candidates with evidence ids. In 0.007:
- a **stale** enabled domain: run its probe, with no model;
- a **finding that raises a question** the probe alone cannot answer, by the change rule: the `project` diff touched files the last investigation did not explain, or the `machine` disk dropped fast. This becomes an **investigation**.

Recurring questions from conversations come later, with relationship context.

**Eligibility** (kernel rules, never a model):
- initiative not paused;
- adenosine at or above the reserve;
- awake;
- no other investigation running;
- one open opportunity per evidence cluster;
- the cluster not settled;
- fewer than 3 fruitless attempts;
- the cooldown passed (1 h after a fruitless attempt).

**An investigation** is up to 3 background steps on the 4B model, in the `iyye` scope, with read-only toolkits: `machine`, a `project` toolkit (`git_log`, `git_show_stat`, `read_file` limited to the workspace and the optional project repository, no secrets paths) and `core`. Its fixed prompt states the evidence, the question, the acceptance test and the cost limit.
- It is **fruitful** only if its answer cites tool results from this investigation (checked by the host: the cited commit hashes, file paths and figures appear in the tool results).
- A fruitful answer becomes a finding (it goes through the importance check) and settles the cluster.
- Narration alone is fruitless.

**The initiative role (Kev, shadow).** For each eligible candidate: investigate, defer or no work (a `choice` question). It is journaled; the deterministic baseline decides. Its outcome label is whether the investigation was fruitful (weak) and the owner's label of the finding (owner).

### 2.7 Day and night integration

Asleep:
- no background work, sweeps or findings;
- probes do not run, and staleness waits for waking;
- the night stores the day's observations and findings (§2.5).

Waking: wake check, day summary, then the first sweep after the background model has loaded.

## 3. Milestones

### S0 — Spike
- **The 4B model:** `gemma-4-E4B` vs `qwen35-4b-tak`, through the router with the investigation toolkits:
  - tool-call validity on 20 investigation prompts;
  - whether the answer cites tool results;
  - decode speed, RAM next to gemma-4-26B and Kev, and time to first token.
- **Pi pause and resume:** abort a generation mid-stream and check what the transcript keeps; continue from a tool result through the session API, without a core patch; then a pause/resume round trip under a fake router.
- **Importance role:** Kev on 15 hand-made `machine`/`project` changes; check its spread against the 0.3/0.6 band.

Exit: the background model, the pause mechanism (resume vs redo-step), the importance band. Recorded in `host/SPIKE-0.007.md`.

*(Done, 2026-10-04.)* **gemma-4-E4B**: 19/20 correct, always measured first, 0 invented figures, median step 3.8 s, 8.9 GB; qwen35-4b-tak answered 4/20 without tools. **Pause:** abort through the turn's signal settles in 2–10 ms (a running tool finishes first, and its result is kept); Pi drops aborted messages from later requests, so resume is a host-note turn in the same session, with no Pi patch. **Importance:** wording v1 ranks 15/15 hand cases correctly; band **0.30/0.45** gives 12 right, 3 unsure, 0 wrong.

### S1 — Background jobs, pause and throttle
- Migration: job `kind`, `origin`, nullable trigger for background jobs, step checkpoint.
- Scheduler precedence; the pause request at checkpoints; resume; throttle.
- The `background` selection key; `/focus`, `/pause initiative`, `/resume initiative`.

Exit:
- **#10:** a message during a background step gets the device within a second; the step resumes later from its checkpoint and its result is not lost or duplicated; no stale result commits after a pause.
- Background work never runs while asleep, never loads a model, and never starves chat.

*(S1 as built, 2026-10-04)*
- **Deviation from §2.1:** background steps have their own table, `background_jobs` (migration 016), not a `kind` on `jobs`. Reply jobs carry invariants that background steps do not have: a triggering message, its route, outbox actions, "answered". Many places (recovery, `/forget`, the scheduler's ordering) rely on them. One row is one step: `origin`, `session` (its Pi conversation, the checkpoint), `prompt`, status `queued → running → paused | settled | failed | suspended`, attempts, pauses.
- **The device slot is preemptible** (`kernel/device.ts`): `tryAcquire(label, { onPreempt })`. The first `acquire` that has to wait calls the holder's `onPreempt` once. Chat turns and console turns already use `acquire`, so a person's turn pauses background work without the scheduler knowing about it. Memory work and Kev keep plain `tryAcquire` and never preempt.
- **`BackgroundWorker`** (`kernel/background.ts`, on the shared `IdleLoop`):
  - **Starts a step only when:** awake, initiative not paused, nobody waiting (`scheduler.hasRunnableJobs() || scheduler.busy`), no chat job started or settled in the last `IYYE2_BACKGROUND_QUIET_S` (180), and the last step ended more than `IYYE2_BACKGROUND_GAP_S` (30) ago.
  - It leases the background model and never loads it. If the model is not loaded, it waits and `/focus` says why.
  - **While a step runs,** a 250 ms watch and the device's `onPreempt` abort its turn when a person needs the device or starts waiting, when Iyye winds down, or when the owner pauses initiative. The step becomes `paused` (counted), and nothing produced after the pause is used. A shutdown pauses without counting. A step paused `maxPauses` (5) times is `suspended`.
  - **Resume:** a paused step continues in its session with `RESUME_NOTE` (a host note). If its session is gone or was never written, it starts again from its prompt. Steps left `running` by a crash are paused at start.
  - **The night:** chat's `resetAll` retires every session row, background ones included, so `onNightEnd` also closes the background conversations. Without that, a paused step re-sent its prompt into its old in-memory conversation (caught in review; a test pauses a live step and checks the next morning's request is a fresh conversation).
  - **Not in S1** (plan-vs-code):
    - there is no per-step cost limit yet, so a looping step holds the device until a person arrives (chat preempts it; Kev's shadow roles cannot). The adenosine charge (S2) and the 3-step investigation cap (S5) bound it.
    - `suspended` is permanent, not "for the day": the origin (S5) decides whether to queue a new step.
  - `onSettled(job)` hands the result to its origin (nothing uses it yet; S4/S5 will).
- **Background conversations** are a second `PiConversations` (state under `<state>/background`) with the view `{ kind: "background" }`. Its prompt note: "This is your own background work: no person is in this conversation…".
  - Its tools are a separate `ToolBroker` with the `machine` toolkit only. The session's principal is the new **`iyye`**, which `ToolBroker.allowed` gives `read` toolkits only. Tool calls are logged with principal `iyye` (migration 016 rebuilds `tool_calls`).
  - `memory_search` refuses `iyye` until S4 gives it a reader. Recall and the after-turn shadow role are skipped for background turns.
- **Background model:** the selection key `background` (migration 016), seeded from `IYYE2_BACKGROUND_MODEL` (`gemma-4-E4B`), set with `/use <model> background`. `DAY_KEYS` (web, telegram, background) are loaded at start and on waking, and unloaded at night.
  - **Note:** `IYYE2_MODELS_MAX` defaults to 2. That fits one chat model plus E4B; selecting different models for web and Telegram needs it raised.
- **Owner commands:** `/focus` (`kernel/focus.ts`: what holds the device now, the precedence order, people waiting, initiative, the background model and whether it is loaded, the queue, recent steps), `/pause initiative`, `/resume initiative` (persisted in kv).
- **Fixed on the way:** `IdleLoop` could hang on `stop()` when it arrived during a drain (it then waited on an unref'd timer). It now re-checks after each drain. This also affected toolkit selection and reply review on shutdown.
- **Tests** (`test/background.test.ts`, 9): preemption semantics; a step with read-only tools as `iyye` and its result to the origin; every waiting reason, with the model never loaded; **#10** (a chat turn gets the device in well under a second, the step pauses with its tool result kept, resumes from the checkpoint, the tool is not re-run, nothing stale commits); winding down and `/pause initiative` pause a step, and suspension after `maxPauses`; crash recovery and a lost session; a step paused before the night starts afresh next morning; `/focus`; with the real scheduler, an owner message during a step is answered first and the step settles after the quiet period, and night/waking unloads and reloads the background model. The fake router gained `[[slow-always]]`. The suite has 275 tests.

### S2 — Adenosine
- `energy_ledger`; `Adenosine` (one writer); charges at the existing sites (STM write, model load and unload, device time from the slot, focus switches, steps).
- Reserve and wind-down thresholds in `Rhythm`; refill rules; `/day`, `/energy`, and the chip.

Exit:
- a charged action is charged once;
- the level survives a restart;
- low adenosine stops background work but never refuses the owner;
- below the wind-down threshold Iyye sleeps at the next quiet moment;
- an interrupted night refills proportionally.

*(S2 as built, 2026-10-04)*
- **`kernel/adenosine.ts`** (`Adenosine`):
  - The level (kv `adenosine.level`, default 1) and the ledger `energy_ledger` (migration 017) have one writer: `charge(kind, amount, ref)` and `refill(to, kind)`.
  - `(kind, ref)` is unique, so a referenced charge is written at most once, even if a sweep or hook runs again after a restart.
- **Where charges come from:**
  - **A sweep every 5 min:**
    - time awake, only while awake, at most 15 min per tick, so the host being off is not being awake;
    - each answered turn (`stm_episodes.answered_at`, ref the event);
    - each completed model load or unload (`model_ops`, ref the operation).
    History before the first start is never charged.
  - **Device time** is reported by the two places that know it:
    - the scheduler's new `onDeviceTime(jobId, ms)` (main charges `device_chat`, ref `job:attempt`);
    - the background worker: `device_background` per attempt, `background_step` per settled step, and `focus_switch` when a step paused for a person (not for the owner's pause or for sleep).
  - Starting charges are 1.x's rescaled (§2.2), **except the time drain, now 0.02 per hour, not 0.04**. §2.2 assumed a 16-hour day, but a rest-window night ends when its work is done (the last took 3 minutes), so Iyye is awake about 24 hours. At 0.04 a typical day here reached the wind-down level in the evening and took a tired nap every day, which is a full night: the day advances, conversations restart, and the 02:00 window then runs a second night. A simulated 24 h day with 0.02 (`test/adenosine.test.ts`, kept as a calibration test):

    | Day | Tired nap | Level at the 02:00 window |
    | --- | --- | --- |
    | typical, 10 turns | never | 0.25 |
    | busy, 20 turns | about 22:25 | — |
    | heavy, 40 turns | about 17:15 | — |

    `IYYE2_ADENOSINE_PER_HOUR` (0.02), `IYYE2_ADENOSINE_RESERVE` (0.35) and `IYYE2_ADENOSINE_WIND_DOWN` (0.15) are config; the rest are `DEFAULT_CHARGES`.
- **Effects:**
  - Below the reserve, `BackgroundWorker` starts no step ("energy is low (adenosine 0.30): background work waits for the night"); a running step finishes.
  - Below the wind-down level, `Rhythm` has a third reason to sleep, "tired: adenosine is low", taken at the next quiet moment (`quietMs`) outside the window too.
  - A tired nap lasts at least `IYYE2_TIRED_MIN_REST_MIN` (60) minutes, even when the night has no work, so it is not an instant full refill.
  - **The owner is never refused:** nothing in the scheduler reads the level.
- **Refills:**
  - `finishNight` refills to 1 (`refill_night`).
  - `wakeForOwner` during a night refills by the larger of the share of the night's work done (conversations waiting at sleep vs left) and the share of a full rest window slept (`refill_partial`).
  - A refill moves the sweep's watermark, so the night's own model unloads are absorbed rather than charged to the next day; waking's model loads are charged.
  - A restart restores nothing.
  - A refill first sweeps the answered turns and model operations since the last sweep, so nothing done just before it goes uncharged (caught in review). The sweep compares with `>=`; the unique reference stops double charges.
  - **A tired nap is a full night**, as in 1.x: the night's memory work runs, the day advances, conversations start afresh, contacts wait until it ends. Owner decision (2026-10-04): **a full night, no lighter naps.**
- **Visible:**
  - `/day` has an `energy:` line ("adenosine 0.62: background work allowed (reserve 0.35); tired (below 0.15) near 23:40 at this rate", projected from the last two hours' charges, at least the time drain).
  - The memory chip shows `energy N%`.
  - `/energy` shows the level, the thresholds, the last refill, and the last 24 h spent by kind, which is the evidence for tuning the charges.
- **Tests** (`test/adenosine.test.ts`, 9):
  - once-per-reference, clamping and persistence;
  - the sweep (turns and model operations once, never history; awake time only while awake, never the downtime);
  - background work below the reserve, its device time, step and focus-switch charges;
  - at adenosine 0 the owner's message is answered and its device time charged once;
  - tired sleep only after the owner is quiet, a nap of at least `minRestMs`, and a full refill;
  - an interrupted night's proportional refill (2 of 4 conversations stored → 0.10 + 0.90 × 0.5);
  - `/energy`.
  - the calibration day and the refill sweep (2 more).
  - The suite has 284 tests.

### S3 — Notices, wake check, day summary
- The outbox `notice` kind (owner web route only); the wake check; the digest, the model post-processing and the validator.

Exit:
- the summary never contains a number or name absent from the digest (a scripted fake model that invents one falls back to the digest);
- notices never reach Telegram;
- nothing is sent while asleep (#11).

*(S3 as built, 2026-10-04)*
- **Iyye's messages to the owner:** `Outbox.notifyOwner({ key, content })` uses the existing, until now unused, action kind `status`; no table change.
  - The route is always `{ web, owner }`, never Telegram (owner decision 7). The idempotency key `notice:<key>` makes one message per key (`day-summary:<day>`, `wake-check:<day>`), even across restarts.
  - While asleep it is created `queued` and not sent; `dispatchDue` sends queued `status` actions once awake (#11).
  - The web adapter records them as Iyye speaking (feed kind `reply`, no event; an empty event id had broken `web_feed`'s foreign key), and the UI shows no "not answered" on an event-less notice.
- **The day summary** (`kernel/day-summary.ts`):
  - `buildDigest` builds plain English lines from records only:
    - answered messages per person, with the total stated;
    - `/remember` count;
    - what the night stored, and separately what had nothing worth keeping;
    - whether the night stopped early;
    - conversation tool use (background tool calls excluded);
    - background steps;
    - the day's lowest adenosine;
    - failed or possibly undelivered messages, or "No messages failed".
    It deliberately has no dates or times (a model rewrites them unverifiably).
  - `composeDaySummary` asks the memory model, through `MemoryGate.run` with thinking off and a 10-minute hang detector, for a two-to-five-sentence first-person note.
  - `summaryProblem` rejects the note when:
    - a number, in digits or as a word up to twelve, is not in the digest;
    - a contact name, or any capitalised word that does not start a sentence, is not in the digest;
    - it is longer than the digest or 500 characters;
    - it promises something;
    - **it leaves out a problem the digest contains** (negated forms like "no messages failed" are not problems).
    A rejected or missing note means the digest itself is sent.
  - It cannot catch a misreading that keeps the record's numbers, so the digest is worded to leave little to misread.
- **Measured on gemma-4-E4B** (the owner's memory model; `scripts/spike-0007-summary.ts`, real router on a scratch port, 4 synthetic days × 3):
  - the first version of the digest was mostly rejected, for good reasons: invented dates, totals not stated in the record, times converted, quiet-day notes longer than the record;
  - two accepted notes misread the night ("all 4 had nothing worth keeping").
  - After the fixes above, 8 of 12 notes are used. The other 4 (the stopped-early night and one busy day) left out a problem and fall back to the digest.
- **Rhythm:** `dayEnd.compose(window)` runs at the end of the night, while the memory model is still loaded and only while still asleep (window: the previous night's end to this night's start). `dayEnd.afterWake(day, summary)` runs once the day's models are back. An interrupted night does neither: it is still owed.
  - **Race fixed in review:** compose awaits a model (about 16 s on E4B), so it runs before the completion check. An owner message during compose therefore leaves the night owed, with one waking notice. Before the fix it completed the day behind the owner's back: the day advanced, conversations were retired, and a second "waking up" notice went out.
  - **Recovery:** a restart mid-night boots asleep, and startup recovery no longer sends queued `status` actions while held; `dispatchDue` sends them after waking.
  - **Known limits:**
    - the composed summary is lost if the host restarts in the window between the night's end and the day's models being back (about 30 s);
    - the summary appears in the web chat as Iyye speaking; owner decision (2026-10-04): **the day summary also goes into short-term memory** (built in S4, with findings).
- **The wake check** (`kernel/wake-check.ts`) is deterministic, with no model, and reports only problems, so nothing to report means no message. It covers:
  - services not up (the model router, long-term memory, decisions, web search, Telegram's `connected`);
  - day models not loaded after waking;
  - the transfer backlog;
  - `unknown` actions;
  - background steps suspended in the last day;
  - forgotten banks not yet deleted.
  It is sent as one message after the summary.
- **Tests** (`test/day-summary.test.ts`, 8): the digest from records only (yesterday and `/remember` excluded); every rejection rule including word numbers, unknown names, promises and a dropped problem; owner-only, once-per-key messages shown as Iyye speaking; held while asleep and sent after waking; not sent by recovery while asleep; compose and afterWake order in the rhythm (and neither for an interrupted night); the owner waking Iyye during compose; the wake check. The suite has 292 tests.

### S4 — Git, domains, importance, findings
- The workspace repository (created by the host); `observations`; the `machine`, `workspace` and optional `project` probes; `/domains`.
- The `observation_importance` role (acting, with fallback); findings as notices, STM kind `observation`, the `iyye` scope, the `iyye-self` bank, recall labelling.

Exit:
- a disk drop becomes one finding and one web message;
- a repeat probe with no change is no finding;
- Kev answering always 1.0 cannot raise more than the daily cap, or post while a conversation is active or Iyye is asleep;
- Kev down falls back to the change rule;
- contacts never recall `iyye-self`.

*(S4 as built, 2026-10-04)*
- **Workspace** (`observe/workspace.ts`): `ensureWorkspace` creates `IYYE2_WORKSPACE` (default `~/.iyye2/workspace`) once at startup: `git init` and a first commit by "Iyye", with a fixed environment. Nothing writes code to it yet.
- **Domains** (`observe/domains.ts`): typed read-only probes (fixed git arguments, `statfs`, `sysctl vm.swapusage`; no shell, no model) and change rules that fire on a **crossing**, not on a state.
  - `machine` (2 h):
    - disk low: under 10% **and** under 100 GB. On the live machine, 8.5% free was 157 GB, which is not low;
    - a fall of 5 points;
    - memory under 4 GB;
    - swap growing 4 GB;
    - a service moving from fine (`up`/`connected`) to broken (a threshold change; back again is minor). The first look at a service is a baseline, and `starting`/`restarting` are neither fine nor broken. Without that, every restart raised a "long-term memory is starting" finding (caught in review);
    - loaded models changing (minor).
  - `workspace` (12 h): new commits; uncommitted changes older than a day, once.
  - Optional `project` (6 h, `IYYE2_PROJECT_REPO`).
  - Default enabled: `machine`, `workspace`; `/domains`, `/domain enable|disable <name>` (kv `observe.enabled`).
- **The observer** (`observe/observer.ts`, every minute, awake only):
  - probes stale enabled domains;
  - records every run in `observations` (migration 018), with its severity and change text;
  - sends changes to the importance check. A busy device defers the decision to the next tick, so Kev decides whenever it can.
  - A finding becomes an STM entry and a message, `I noticed (machine): …`, through `notifyOwner`. Messages are capped at `IYYE2_FINDINGS_PER_DAY` (5; over the cap a finding is kept but not sent), never sent while asleep, and held while a conversation is active.
- **`observation_importance`** (`decisions/observation-importance.ts`), the first acting role (owner decision 6):
  - wording v1, band 0.30/0.45;
  - Kev's yes or no decides; unsure, error or Kev down falls back to the change rule (a threshold crossing is a finding);
  - the state is only `{domain, change}`; it is journaled with scope `iyye` and labellable with `/decisions label`.
- **STM for Iyye's own entries** (migration 018 rebuilds `stm_episodes`):
  - kinds `observation` and `summary` in scope `iyye`, with no event, contact or channel (still required for turns and `/remember`); `recordIyyeEntry` is idempotent by id.
  - The entry id no longer references `events`, since Iyye's own entries have no event; turns still use their event id.
  - **The day summary goes into STM** as kind `summary` (owner decision 2026-10-04), and the digest lists the day's findings.
- **Memory:**
  - scope `iyye` ↔ bank `iyye-self`; only the owner reads it (`readableScopes`), labelled "your own records".
  - STM recall text: "Your own probe observed: …" and "Your day summary: …".
  - At night findings are stored verbatim (no extraction) tagged `speaker:probe`, and summaries verbatim tagged `speaker:iyye`.
  - Per-turn recall includes `speaker:probe` (a measurement is evidence, labelled "measured by your own probe") but not `speaker:iyye`. Memory salience skips both kinds.
- **Tests** (`test/observe.test.ts`, 8):
  - the change rules;
  - the workspace and the git domain on a real scratch repository;
  - the observer: awake-only probing, staleness, a finding in STM plus one message, Kev's "no", deferral, held during a conversation, the cap holding even when every change is called important (#16), enable and disable;
  - the importance check on the fake Kev, including fallback, deferral, journaling and labelling;
  - recall labelling, contacts never reading `iyye-self`, and verbatim storage at night.
  - The suite has 300 tests.
- **Review fixes:**
  - `/forget` also drops unstored day summaries (`summary`, in `day` or `backlog`) that name the person or a linked account, since a summary like "2 from Julia" would otherwise carry them into `iyye-self` (HLD §15 #15; tested in `memory-acceptance`). Summaries already stored are a known limit (plan 0.002 L6).
  - `/energy` labels STM charges "short-term memory entries (conversations, findings, summaries)": findings and summaries pay like every STM writer, as in 1.x.
  - Migrations 017 and 018 were run on a copy of the live database: all 11 STM rows identical before and after, foreign-key and integrity checks clean.
- **For S5:** evidence comes only from STM kinds `turn`, `remember` and `observation`, and LTM `speaker:person`/`speaker:probe`; never a `summary` or `speaker:iyye` (rule 1).

### S5 — Sweep and investigations
- The sweep, eligibility, investigations on the 4B model, the citation check, settlement and the fruitless bound; the initiative role in shadow.

Exit:
- **#9:** a stale domain creates at most one investigation; a fruitful one settles it; three fruitless ones suspend it, across restarts.
- **#16:** the initiative role answering always "investigate" changes nothing while shadow.
- Iyye's own text never qualifies as evidence (a test feeds it a narrated "critical failure").

*(S5 as built, 2026-10-04)*
- **Opportunities** (`observe/investigations.ts`, `opportunities`, migration 019): a finding of a repository domain (`workspace`, `project`) whose change raises a question (`questionFor`: new commits → "what do they change?"; day-old uncommitted changes → "what are they, and do they look finished? open each file first") becomes one opportunity. Its cluster is the finding (`observation:<id>`, unique), so a settled cluster never qualifies again.
  - **Machine findings are not investigated:** no read-only tool can yet say what uses the disk or why a service fails. Rather than ask a question it cannot answer, Iyye leaves those as findings.
  - **Evidence is records only:** opportunities come only from `observations` findings of repository domains, never from STM summaries, step answers, or investigation results (domain `investigation`). A test feeds all three.
- **Eligibility** (kernel rules) is checked by a sweep every `IYYE2_SWEEP_S` (1800):
  - awake;
  - initiative not paused;
  - adenosine at or above the reserve;
  - no other investigation running;
  - fewer than 3 fruitless attempts;
  - the 1 h cooldown passed.
  The counters live in SQLite and survive restarts.
- **An attempt** is up to 3 background steps in one Pi session (`iyye:inv:<id>:<n>`), on the background model, with the read-only `machine` and new **`project`** toolkits. `project` is `tools/project.ts`:
  - `git_log`, `git_show`, `git_status` and `read_file`;
  - the repository is an enum of configured names, never a path;
  - `read_file` resolves inside the repository, symlinks included, refuses `.git` and likely secrets, and returns at most 4000 characters.
- **Fruitful = grounded** (`observe/citations.ts`, host-checked): the answer must name at least one concrete thing (a commit hash, file name or figure, after Markdown/LaTeX normalisation), every one of which appears in this attempt's tool arguments or results (or the evidence and question), and a tool must have run.
  - An ungrounded answer gets a host note saying why (no tool; names X, which the tools did not return; cites nothing) in the same session.
  - After 3 steps the attempt is fruitless: cooldown; suspended after 3.
  - A fruitful answer becomes an `observations` row (domain `investigation`, severity threshold, "evidence → answer"), which the observer sends through the importance check like any change; the opportunity is settled.
  - **Rule 1, fixed in review:** an investigation's answer is the background model's text. The citation check confirms that the names it uses came from tools, not that its interpretation is a measurement. So it is **Iyye's own words**:
    - stored at night with `speaker:iyye` plus an `investigation` tag (never `speaker:probe`);
    - recalled the same day as "Your own investigation found: …";
    - kept out of per-turn evidence; it appears only through `memory_search`, labelled as Iyye's own words;
    - announced as "I looked into it: …";
    - left out of the digest's "probes found" line.
    `state/observations.ts` tells investigation entries apart by their observation's domain; no migration was needed.
  - A follow-up step repeats the original question and evidence after the host note, so a step restarted without its session (a crash, the night's session reset) is still self-contained.
  - **Known limit:** the check cannot tell a shallow answer from a good one when everything it cites was already in the evidence (the first `draft.py` run cited only the file the finding named). The questions are worded to make the model look; the check does not enforce depth.
- **Robustness:** the sweep reconciles running attempts: a failed or suspended step ends the attempt fruitless, and a step that settled but was never evaluated (a restart in between) is evaluated then.
- **The initiative role** (`decisions/initiative.ts`, shadow): before each attempt Kev is asked "worth investigating now?". Its outcome is the attempt's fruitfulness (weak), and it is labellable with `/decisions label`.
  - **Deviation:** plan §2.6 asked for a choice (investigate / defer / no work), but the decision client speaks yes/no only, so it is one yes/no question.
  - The baseline investigates every eligible opportunity.
- **Owner view:** `/opportunities` (status, attempts, fruitless count, next attempt, evidence, what was found); `/focus` shows the steps; the day summary counts investigations answered and not.
- **Measured on gemma-4-E4B** (`scripts/spike-0007-investigation.ts`: real router on a scratch port, real worker, Pi and `project` toolkit on a scratch repository):
  - "3 new commits": settled on the first attempt in 11 s (git_log, then git_show on each commit; the answer cites the real hashes and the 50 → 80 GB change).
  - "uncommitted draft.py": the first version of the question let the model judge from `git_status` alone ("cannot determine whether finished"). With the question telling it to open each file, it read `draft.py` and found the TODO, in 5 s.
- **Tests** (`test/investigations.test.ts`, 10): the project toolkit and its refusals (.., absolute paths, .git, .env, a symlink escape); the citation check; which findings raise questions; **#9** (one opportunity per finding, one investigation at a time, a grounded answer settles it for good; ungrounded answers asked again in the same session, fruitless after 3 steps, cooldown, suspension after 3 across restarts); waiting on paused initiative, low energy and sleep; reconciling failed and unevaluated steps; rule 1; **#16** (Kev always yes or always no changes nothing); end to end through the real `BackgroundWorker`. The suite has 311 tests. Migration 019 was run on a copy of the live database (already at 018, 32 STM rows): rows identical, integrity clean.

## 4. Risks

- **RAM by day:** gemma-4-26B (~30 GB) + the 4B model (~6–8 GB) + Kev (~10 GB) + Hindsight and PostgreSQL. This fits 128 GB, but S0 measures it.
- **Pause correctness:** an aborted generation must leave no partial message that a resume treats as Iyye's answer. S0 settles it, and S1 tests it.
- **Notice fatigue:** findings are capped, held during conversations, and checked by Kev. If they still annoy, owner labels ("not worth it") are the signal, and the cap is a dial.
- **Adenosine mis-tuning:** sleeping too early only delays background work. The owner is never refused, and the rest window still holds. The ledger makes the cause visible.
- **The project probe reads private code:** it is used only in the owner-readable `iyye` scope and bank, never in a contact's.

## 5. Configuration (planned)

| Name | Default | Meaning |
| --- | --- | --- |
| `IYYE2_BACKGROUND_MODEL` | `gemma-4-E4B` (S0) | the 4B model for background work |
| `IYYE2_BACKGROUND_QUIET_S` | `180` | no background step starts this soon after chat activity |
| `IYYE2_BACKGROUND_GAP_S` | `30` | minimum gap between background steps |
| `IYYE2_ADENOSINE_*` | §2.2 | charges and thresholds |
| `IYYE2_FINDINGS_PER_DAY` | `5` | most finding messages a day |
| `IYYE2_SWEEP_S` | `1800` | the opportunity sweep interval |
| `IYYE2_PROJECT_REPO` | unset | an optional repository the `project` domain observes |
| `IYYE2_WORKSPACE` | `~/.iyye2/workspace` | Iyye's own repository |

## 6. Coordination with 0.006

- **Migrations:** 0.006 C1 and 0.007 S1 both change `jobs`/`actions`. They take the next free numbers in the order they land, and neither edits the other's.
- **Precedence:** a due commitment ranks with "a person waiting", above background work.
- **Plans:** 0.006 C4 runs plan steps as background jobs from S1.

## 7. Owner decisions (2026-10-03)

1. **A message pauses and throttles background steps, as in Iyye 1.0:** pause at safe checkpoints, then resume; no background work during an active conversation.
2. **Background work runs on a 4B model,** perhaps fine-tuned later.
3. **Energy is Iyye 1.0's adenosine model.**
4. **The day summary is built from records and post-processed by a model.**
5. **Iyye 2 has git for the code it produces, like Iyye 1.0:** a separate repository `~/.iyye2/workspace` (2026-10-04); `iyye_2/` stays without git.
6. **Findings enter long-term memory, gated by a Kev importance check.**
7. **Findings reach the owner as messages in the web UI only.**
8. **Relationship context: later.**
9. **0.006 first; R1 follows concurrently** — changed 2026-10-04: **0.007 first.**

## 8. Open questions

- The background model is chosen by the S0 spike, unless the owner prefers one now.
