# Iyye 2.0 — Stage 2 (Resident Life): Options for the Owner

- Status (2026-10-03): **decided.** The owner's choices are recorded in [plan 0.007](iyye_2_0_007_plan.md) §7, with commitments first in [plan 0.006](iyye_2_0_006_plan.md). Kept for the options and reasoning. Each area lists options, a recommendation, and the owner decisions it needs (collected in §12). Once chosen, the areas become numbered implementation plans (§11).
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §14 Stage 2, §5 (attention and motivations), §8 (sleep, energy, dreaming), §6.4 (relationship context), §11 (a recognizable day, damping), §15 #9, #10, #11, #16.
- **Stage 2 exit gate (HLD §14):** foreground work preempts maintenance, due work wakes Iyye, quiet hours hold, and idle curiosity terminates when evidence is settled or attempts are exhausted.

## 1. Where Stage 2 starts from

What exists (0.001–0.005):
- One device slot shared by chat, memory work and Kev; a fair chat scheduler.
- Day and night (`Rhythm`): STM → LTM at night, sessions retired at night.
- Read-only toolkits (`core`, `machine`, `web`) for everyone.
- Kev in shadow: toolkit selection, memory salience, reply review.
- Identity links; `/forget`, `/remember`.

What Stage 2 needs that does not exist:
- **No work starts without a person.** A job requires a triggering message (`jobs.trigger_event_id` is required and unique). Iyye cannot do anything on its own initiative.
- **No unsolicited message path.** Outbox routes come from the triggering event, so there is no rule yet for whom Iyye may tell something it found, or when.
- **No commitments or timers** (proposed plan 0.006). "Due work wakes Iyye" in the exit gate depends on them.

Measured usage (live database, 2026-10-02..03):
- 5–11 messages a day; the average job took about 3 minutes (mostly the earlier thinking model).
- The device is idle well over 95% of the day, and the last night took 3 minutes.
- So capacity is not the constraint; **discipline is** (1.x lessons below).

## 2. Lessons from 1.x that shape every option

1.x had all of Stage 2 in some form (attention stream, adenosine, observation domains, proactive plans), and spent weeks damping it. The recurring failures, each with the guardrail it implies here:

| 1.x failure | Guardrail in 2.0 |
| --- | --- |
| Iyye's own narration ("…critical failure…") counted as evidence and spawned plans about plans | Evidence is only records: probe results, people's messages, receipts. Never Iyye's text (HLD §11.2) |
| Evidence never settled, so the same curiosity re-fired forever | Every opportunity names its evidence ids; a finding settles them; a settled id never re-qualifies |
| Fruitless investigations looped (a 2-hour weather comparison loop) | At most 3 fruitless attempts per evidence cluster, then suspended until new evidence; counters persisted |
| Counters reset on restart and defeated the damping | All counters, cooldowns and budgets live in SQLite |
| Keyword/heuristic scoring was gamed by log text | Deterministic eligibility first; Kev scores only among eligible candidates, shadow first |
| Generated findings flooded long-term memory with mechanics | Findings are retained as Iyye's observations with their probe source; bookkeeping is never retained |
| "Delivered" recorded when nothing reached the person | Unchanged 2.0 rule: only the outbox with a receipt delivers (already built) |

## 3. Area A — Background work and focus (the foundation)

Everything else in Stage 2 is a background job, so this comes first.

**A.1 Job kinds.** Add a job `kind`: `reply` (today's jobs) and `background` (an investigation step, a review, a summary). A background job has no triggering message. It has an `origin` (the opportunity or night phase that created it), a scope (`iyye`, a new internal scope, never a person's), a cost limit and a stop condition.

**A.2 Precedence** (HLD §5.1). The order is fixed and deterministic:

1. Owner input.
2. A person waiting for a reply, and due commitments (0.006).
3. Owner-requested work.
4. Background work: investigation, review, maintenance.

A background job runs only when nothing above it is queued, as memory work and Kev already do.

**A.3 Preemption: what happens when a message arrives mid-step.** A background step is one Pi turn with read-only tools, which can take 30–120 s.

| Option | Behaviour | Cost |
| --- | --- | --- |
| A3a. Run to completion | The person waits for the rest of the step (up to ~2 min) | Simplest; fails §15 #10 in spirit |
| **A3b. Abort and redo (recommended)** | Abort the Pi turn at once (Pi supports cancellation); discard the partial step; it re-runs later from its last checkpoint. Steps are read-only, so redoing is safe. A step aborted 3 times is suspended | Some wasted device time; simple and honest |
| A3c. Checkpoint inside the step | Save Pi's partial transcript and resume mid-turn | Complex; Pi has no supported mid-turn resume |

**A.4 Which model runs background work.**
- **A4a (recommended):** the web chat model, already loaded. Nothing extra is loaded, and its prompt cache stays separate per scope.
- A4b: a dedicated small model (e.g. gemma-4-E4B) selected with `/use <model> background`. Cheaper per step, but it costs RAM and loading.
- Either way background work never loads or unloads a model on its own.

**A.5 Owner view.** `/focus` shows what Iyye is doing now and why (the precedence rule that chose it), the background queue, and recent suspended work. `/pause initiative` and `/resume initiative` stop and restart all background work (HLD §13 owner controls).

## 4. Area B — Energy (the honest budget, HLD §8.2)

Background work needs a ceiling; chat never does.

| Option | Measure | Notes |
| --- | --- | --- |
| **B1. Device time (recommended)** | Seconds of device time used by background jobs per day | Measured directly from the device slot; model-independent; easy to explain |
| B2. Tokens | Prompt + output tokens from Pi usage | Model-dependent; a thinking model burns budget faster |
| B3. B1 plus fatigue-driven sleep | Exhausting the budget also starts the night early | Closest to 1.x "adenosine"; adds a second sleep trigger to reason about |

Recommendation: **B1** with a default allowance of 20 minutes of device time a day (`IYYE2_DAILY_INITIATIVE_S`), shown as energy in `/day` ("energy 65%: 7 of 20 min of initiative used"). It is renewed by a completed night, and never charged for owner chat or memory work. Sleep stays on the rest window (B3 later, if wanted).

## 5. Area C — Waking review and day summary (HLD §8.3 phases 1, 7; §11.1)

Cheap, visible, and independent of the rest.

- **C.1 Wake check:** a deterministic check on waking: service health, the night's outcome, backlog and failed transfers, anything delivered as `unknown`, and suspended work. Problems become one web chat notice. No model call.
- **C.2 Day summary** at the end of the night, as a web chat notice ("Day 4: 11 conversations (5 you, 6 contacts), 5 stored in memory, 2 with nothing to keep; 2 web searches; nothing failed").
  - **C2a (recommended first):** deterministic, built from records only. No model call, so nothing is invented.
  - C2b: model-written short narrative from the same records, at night with the memory model. It reads better but needs a check that it cites only record ids. Later.
- **Where it goes:** the web chat only. Never Telegram unless you ask (see area G).

## 6. Area D — Observation domains (curiosity through measurement)

An observation domain is something Iyye is allowed to look at on its own:
- a **typed read-only probe** (never Python or shell; HLD invariant);
- a **staleness window** ("nobody has looked at this for N hours");
- a definition of a **change worth noting**;
- your **approval** (domains are owner-approved, `/domains`).

Candidate domains:

| Domain | Probe | Network | Change worth noting | Notes |
| --- | --- | --- | --- | --- |
| **machine** | `system_status` (exists) plus memory pressure, model RAM, service health | no | disk below a threshold, a service restarting repeatedly, RAM pressure | The self-preservation motivation; cheapest start |
| **project** | git log / status of a repository you name, read-only | no | new commits, a failing test file, a stale TODO | Which repository is your choice (iyye_2 itself has no git) |
| **weather** | a weather API for your location, through `GuardedHttp` | yes | a large change against yesterday, a warning | Uses the web budget |
| **topics** | `web_search` on topics you name ("llama.cpp releases", "Chuvash language news") | yes | new items since the last look | Closest to "interests"; needs dedup against what it already found |

**Where findings live.**
- **D-store-a (recommended):** an `observations` table in SQLite (domain, probe, time, structured result, hash). Nightly, a changed observation is retained into the owner's bank as an Iyye observation, tagged `speaker:probe` with its source. It is distinct from a person's statement and from Iyye's words, and recall labels it "observed by Iyye on <date> via <probe>".
- D-store-b: only in SQLite, never in long-term memory. Safer but forgettable: Iyye could not later recall what it saw.

Recommendation: start with **machine + project** (no network, no budget questions), then add weather/topics once A–E have run for a week.

## 7. Area E — Opportunity sweep and initiative (HLD §5.3)

**E.1 The sweep.** A periodic deterministic sweep (e.g. every 30 minutes while awake and idle) collects candidates, each with its evidence ids:
- a stale approved domain;
- a **recurring question**: you asked about the same thing on two or more distinct days (from STM and recall), and it was not answered by a tool result;
- a question Iyye could not answer (the reply said it did not know; Kev can classify this later);
- an open commitment (after 0.006).

**E.2 Eligibility** (kernel rules, never a model):
- at most one investigation at a time;
- energy left;
- one open proposal per evidence cluster;
- the cluster is not settled;
- fewer than 3 fruitless attempts;
- the cooldown has passed;
- initiative is not paused.

**E.3 The investigation:** one or more background steps (area A). Each is a Pi turn in the `iyye` scope with read-only toolkits and a fixed prompt: the evidence, the expected new information, the acceptance test and the cost limit. Its result is judged by a record, not by Iyye's opinion of it:
- a probe returned data;
- a web page was fetched and quoted;
- for a recurring question, the found answer is stored with its source.
A step that ends with only narration is fruitless.

**E.4 The initiative role (Kev):** for each eligible candidate, Kev answers "investigate / ask the owner / defer / no work" (a `choice` question). It starts **shadow-only**, with the deterministic baseline deciding (investigate stale domains; defer everything else). The outcome label is whether the investigation produced a finding (weak), plus your reaction to it (owner).

**E.5 How findings reach you:**

| Option | What you see | Unsolicited messages |
| --- | --- | --- |
| **E5a. Memory only** | Iyye mentions a finding when it is relevant to something you ask (recall) | none |
| **E5b. Plus a digest (recommended with E5a)** | One web chat notice a day (with the day summary): "While you were busy: …", each finding with its source | one local notice a day |
| E5c. Immediate notice | A web chat notice per finding | a few a day |
| E5d. Telegram | Findings sent to your Telegram | needs quiet hours and limits (area G) |

## 8. Area F — Relationship context (HLD §6.4, §8.3 phase 3)

Overlaps plan 0.005 stage 2. What Iyye knows *about* a person, shown in their conversations.

| Option | Source | Notes |
| --- | --- | --- |
| **F1. Owner notes first (recommended)** | `/note <person> <text>` with visibility `private` (only you see it) or `shared` (shown in that person's own prompt) | Stated evidence, cheapest, no model judgement; 0.005 stage 2 already planned it |
| F2. Hindsight mental models | Hindsight's per-bank mental models ("what do we know about this person"), refreshed at night under the gate | Built into Hindsight; needs a short spike on quality with the local memory model, like L0 |
| F3. Iyye-written summary | A nightly model summary per person, stored in SQLite with the source ids it used | Most control, most code; risk of invented traits |

Recommendation: **F1 now, F2 spike next.** Summaries are hypotheses, labelled as such, never diagnoses, and the owner can view, correct or delete them (`/person <name>`).

## 9. Area G — Quiet hours and unsolicited contact

Needed only for E5d (findings to Telegram) or for reminders (0.006). A quiet window (default 22:00–08:00) in which nothing unsolicited is sent; a cap on unsolicited messages per person per day (default 1 for contacts, 3 for you). The rest window for sleep stays separate. If you choose E5a/E5b, G can wait for 0.006.

## 10. Classifiers inside the boundaries

Stage 2 lets typed decisions act **only inside deterministic eligibility and abstention** (HLD §14). Candidates, in the order the evidence will exist:

1. **Memory salience** (built, shadow): skip extraction for clear small talk to shorten the night. Promote when `/decisions` shows a stable threshold over a few weeks of nights.
2. **Initiative** (E.4): shadow from the start, acting later.
3. **Attention** (which eligible background job first): only worth it once there are several kinds of background work.

Each promotion is your decision per role, from its figures.

## 11. Suggested order

| Increment | Contents | Depends on |
| --- | --- | --- |
| 0.006 | Commitments, reminders, plans (Stage 1 gap) | — |
| **R1** | Area A (background job kind, precedence, abort-and-redo, `/focus`, `/pause initiative`) + area B (energy) + area C (wake check, deterministic day summary) | — |
| **R2** | Area D (observations table, machine + project domains, `/domains`) + area E (sweep, eligibility, investigation, digest; initiative role in shadow) | R1 |
| **R3** | Area F (owner notes; Hindsight mental-model spike) | — (can run in parallel) |
| **R4** | Area G (quiet hours, limits), network domains, model-written summary | 0.006, R2 |

R1 and R3 do not depend on 0.006; "due work wakes Iyye" in the exit gate does. A reasonable path is 0.006 → R1 → R2, with R3 whenever you want people context.

**Acceptance targets for R1–R2** (HLD §15):
- **#10:** a message during a background step aborts it within a second; the step re-runs later; nothing stale commits.
- **#9:** a stale domain creates at most one investigation; a finding settles it; three fruitless attempts suspend it across restarts.
- **#11:** nothing background runs or sends while asleep.
- **#16:** Kev's initiative answers change nothing while shadow.

## 12. Owner decisions (to choose)

1. **Preemption:** abort-and-redo (A3b, recommended), run-to-completion (A3a), or checkpointing (A3c).
2. **Background model:** the web chat model (A4a, recommended) or a dedicated small one (A4b).
3. **Energy:** device time (B1, recommended) with what daily allowance (default 20 minutes), or tokens (B2), or fatigue-driven sleep (B3).
4. **Day summary:** deterministic (C2a, recommended) or model-written (C2b).
5. **First observation domains:** machine + project (recommended), and **which repository** is "project"; weather and topics later or now (with your location and topics).
6. **Findings in long-term memory** as labelled Iyye observations (D-store-a, recommended) or SQLite only (D-store-b).
7. **How findings reach you:** memory + daily web digest (E5a+E5b, recommended), per-finding notices (E5c), or Telegram (E5d, needs area G).
8. **Relationship context:** owner notes first (F1, recommended), Hindsight mental-model spike (F2), Iyye summaries (F3).
9. **Order:** 0.006 first, then R1 (recommended), or R1 first.
