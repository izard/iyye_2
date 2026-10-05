# Iyye 2.0.010 — Motivations: Four Needs That Drive Initiative (Plan)

- Status (2026-10-05): **draft for the owner; nothing built.** Whether it comes before or alongside Stage 3 (plan 0.009) is an owner decision (§9). It gives Stage 3's temperament something real to scale.
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §5.1 (one focus, precedence), §5.2 (the four motivations, need and service evidence), §5.3 (initiative with a reason), §6.4 (relationship context), §8.2 (adenosine), §11.2 (reinforcement with damping), §15 #9, #10, #12, #16.
- Builds on: observation domains and findings (0.007 S4), opportunities and investigations (S5), adenosine (S2), background jobs (S1), plans and commitments (0.006), messaging (0.008), the self-healing model manager, Kev's initiative role (shadow), the decision journal (0.003).
- Lessons from 1.x (its alignment stream and need EMA): keyword-scored "service" saturated and masked real need; narration counted as evidence and spawned plans about plans; completed work re-proposed itself until a fruitless bound existed. Every rule below is shaped against those.

## 1. Today, and the gap

| Motivation | Built | Gap |
| --- | --- | --- |
| Self-preservation | machine observation → findings; adenosine; router recovery; model self-healing; wake check | reactive rules and notices; no need score; no initiative of its own |
| Curiosity | repository findings → opportunities → cited investigations (bounded); Kev initiative role in shadow | the only initiative loop, and only for repositories; nothing from conversations or memory |
| Agency | plans (C4) and reminders, done only by evidence | Iyye never proposes a plan; no need from open or stalled intentions |
| Social | `telegram_send` (Iyye may write on its own, capped, reported) | no reason to write: no waiting-person, follow-up or relationship signal |

Energy is one budget (adenosine gates all background work at 0.35); background jobs run in queue order; there is no priority across motivations.

## 2. Principles

1. **Need comes from records, never from Iyye's text.** Each signal names its record ids (events, actions, receipts, observations, plans, commitments, tool calls, STM entries). A reply, reflection, summary or step answer Iyye wrote is never evidence of need, and never evidence of service.
2. **Service comes from outcomes** (HLD §5.2's right column): a restored service, a grounded answer that closes the question, a verified step or delivered commitment, a person answered or a follow-up the person replied to. Running a job is not service.
3. **Sustained gaps, not blips:** need is smoothed; an opportunity appears only after the gap persists, and once per evidence cluster.
4. **Bounded, damped, reversible** (HLD §11.2): per-motivation daily allowances inside adenosine, one running initiative at a time, fruitless bounds and cooldowns that survive restarts, owner pause per motivation.
5. **No new permissions.** Initiative only uses actions that exist: read-only investigations, plan proposals (authorized under C4's rules), messages under 0.008's caps, and maintenance the kernel already does. A high need never overrides quiet hours, approval, caps or precedence (§5.1: people first).
6. **Silence can serve.** A social need is served by a useful exchange, not by message volume; choosing not to write is a valid outcome (HLD §11.2).

## 3. Need signals (deterministic, per motivation)

Each signal is a typed row: `{motivation, kind, cluster, evidence_ids, weight, observed_at}`. A sweep (every `IYYE2_MOTIVATION_SWEEP_S`, default 10 min, awake only) recomputes them from records. Weights are fixed per kind (tunable by the owner, later by Stage 4), within [0, 1].

**Self-preservation**
- resource pressure: disk below the observation threshold, low reclaimable memory (from `observations`);
- a service down or flapping: the router, Hindsight, Kev, SearXNG, Telegram (status history);
- a selected model failed to load or self-healing gave up (`model_ops`);
- memory backlog: transfers waiting more than one night; a night stopped early (`memory_transfers`, night results);
- unconfirmed deliveries (`actions` in `unknown`, commitments `unknown`);
- the night was cut short by system sleep (the 2026-10-05 lesson).

**Curiosity**
- stale observation domains and repository changes (as today, S4/S5);
- **unanswered questions from conversations:** a turn where Iyye said it could not find or did not know (Kev reply-review role, a new `admits_unknown` question, shadow first) whose topic recurs on another day;
- **weak or conflicting memory:** Hindsight recall returning low-relevance or contradicting results for a topic asked about twice (recall journal);
- a finding whose investigation was fruitless gets no new signal until new evidence (S5's bound).

**Agency**
- a plan stalled: a step running or pending past an expected time, or suspended on an unconfirmed reminder (`plans`);
- a commitment overdue or failed without a follow-up (`commitments`);
- **an intention with no plan:** the owner said "I want to / I need to / let's …" about something concrete (Kev role on the owner's messages, shadow first; owner only, never contacts' intentions);
- an approved plan's next step blocked by nothing but time.

**Social**
- a person waiting: a contact's message unanswered (failed job, `unknown` reply) or answered with a failure notice;
- **a follow-up a person invited:** a contact or the owner mentioned a dated event ("exam tomorrow", "flying Monday") (Kev role, shadow first; the date resolved by `kernel/when.ts`), now past;
- a promise Iyye made in words that has no commitment (reply review's `claims_arranged` without a ledger entry, 0.006 C2);
- **a relationship gone quiet** (later, needs relationship context, 0.005 Stage 2): only for people who asked to hear from Iyye.

## 4. Need, smoothing and opportunities

- **Need per motivation** = `clamp(Σ signal weights × recency, 0, 1)`, smoothed per sweep: `need ← need × (1 − α) + raw × α` (α = 0.3), journaled (`motivation_samples`).
- **Temperament** (0.009 §2.1) multiplies need for curiosity, agency and social (bounded [0.7, 1.3]); self-preservation is never scaled down by character.
- **An opportunity** is created when a motivation's smoothed need stays ≥ `θ` (0.6) for `k` (3) consecutive sweeps, for its strongest evidence cluster not already open, settled or suspended. The existing `opportunities` table gains `motivation`, `signal_kind` and `action_kind` (migration), so S5's investigations become the curiosity case of one mechanism.
- **Kev's initiative role** (now per motivation) classifies each opportunity: act, ask, defer or nothing. Shadow first, as S5; the deterministic fallback is the kind's default action below.

## 5. What each motivation may do (existing actions only)

| Motivation | Action | Bounds |
| --- | --- | --- |
| Self-preservation | maintenance the kernel already has (reload a model, retry a transfer, resolve a stale state), else a notice to the owner with the evidence | never deletes data, never unloads what is in use, never changes configuration |
| Curiosity | a read-only investigation (S5 machinery, citation check), on repositories, the machine, the web (`web_search`/`web_fetch` in background, new) or memory (`memory_search`, new for background) | one at a time; 3 fruitless attempts then suspended; web budget per day |
| Agency | propose a plan for the intention (C4: authorized at once only if internal or reminding the owner's web chat; otherwise waiting for `/plan approve`); nudge a stalled plan's owner | at most one Iyye-proposed plan open per evidence cluster; owner approval rules unchanged |
| Social | write to the person (`telegram_send`, Iyye-initiated, labelled, reported) or mention it to the owner at the next turn | quiet hours; at most one Iyye-initiated message per person per day (0.008) and `IYYE2_SOCIAL_DAILY_MAX`; only to people who wrote to Iyye; never about another person's private matters |

## 6. Service and closure

An opportunity is settled only by its kind's service evidence, with author/action ids:

| Motivation | Service evidence |
| --- | --- |
| Self-preservation | the signal's condition cleared (service up, model loaded, backlog stored, delivery confirmed) |
| Curiosity | a cited answer (S5) that becomes a finding; a later turn on the topic that uses it (recall journal) counts as reinforcement |
| Agency | the plan or commitment reaches its evidence (C4), or the owner declines (then the cluster is settled as declined) |
| Social | the person replied, or the owner said it was welcome; no reply after the message is *not* a failure but adds no credit, and suppresses the next one for that person |

Settled evidence lowers need at the next sweep. Fruitless attempts count against the cluster (3, then suspended until new evidence). Credit goes to the motivation and action that produced the outcome, never to whichever job was running (HLD §11.2).

## 7. Priority and energy

- **Precedence is unchanged:** people and due commitments first (§5.1); initiative runs only as background work, paused for people.
- **Among eligible initiative opportunities:** `priority = need × temperament × urgency(age, deadline) ÷ cost(estimated device time)`. Ties favour self-preservation.
- **Allowances under adenosine:** each motivation has a daily share of background device time (default: self-preservation uncapped within the reserve, curiosity 40 %, agency 30 %, social 30 % of the background budget); unused shares are not borrowed by social.
- **One initiative job at a time** across motivations (S5's rule generalised).

## 8. Owner view and controls

- `/motivation`: each motivation's need (raw and smoothed), its top signals with evidence, the open opportunity, what recently served it, its allowance used today.
- `/pause <motivation>` and `/resume <motivation>` (next to `/pause initiative`).
- `/opportunities` shows the motivation of each.
- The day summary adds one line: what each motivation did and what served it.
- `/forget <person>` removes signals and opportunities whose evidence names them.

## 9. Relation to Stage 3 (owner decision pending)

- **Before Stage 3:** temperament has real needs to scale from day one; 0.010's signals and service records become the evidence Stage 3's nightly review learns from. Cost: Stage 3 waits.
- **Alongside:** 0.009 CH1–CH4 (character state, mood, voice) do not depend on 0.010; CH5 (nightly character review) does, since it reads "what served which motivation". So the natural interleave is 0.010 M0–M3 in parallel with 0.009 CH0–CH4, then CH5 after M3.

## 10. Milestones

- **M0 — Signals in shadow:** the signal sweep, need and smoothing, journaled; `/motivation`; no opportunities from it yet. Two to three days of real records show whether the weights and θ make sense.
- **M1 — One opportunity queue:** migration (`motivation`, `signal_kind`, `action_kind` on `opportunities`); S5's curiosity loop moved onto it unchanged; self-preservation maintenance actions; allowances; `/pause <motivation>`.
- **M2 — New detectors (Kev, shadow first):** `admits_unknown` (curiosity), intentions (agency, owner only), dated events (social); background `web_search`/`memory_search` for curiosity.
- **M3 — Agency and social acting:** Iyye-proposed plans; Iyye-initiated social messages under quiet hours and caps; service evidence and closure for both.
- **M4 — Evaluation:** a multi-day run (real, plus a replayed scratch installation with injected records) checks the exit gate.

Exit gate (HLD §15 #9, #10, #12, #16):
- a sustained, evidenced need creates exactly one opportunity; its service settles it and need falls; a fruitless cluster is suspended across restarts;
- a human message preempts initiative without losing its checkpoint;
- Iyye's own replies, summaries or step answers never raise or settle a need (tested by injecting self-authored text);
- no motivation exceeds its allowance; social initiative respects quiet hours and caps; an overconfident Kev answer cannot create an action outside §5.

## 11. Risks

- **Nagging:** social initiative that feels intrusive. Strict caps, quiet hours, only people who wrote first, a reply-less message suppresses the next, owner notices, `/pause social`.
- **Over-eager agency:** plans for passing remarks. Owner-only intentions, concrete ones, one open per cluster, C4's approval rules.
- **Self-preservation loops:** maintenance that keeps retrying. The same backoff and give-up rules as model self-healing.
- **Signal drift:** weights tuned on too little data. M0 runs shadow-only; weights stay owner-set until Stage 4 can learn them with held-out evidence.

## 12. Configuration (planned)

| Name | Default | Meaning |
| --- | --- | --- |
| `IYYE2_MOTIVATION_SWEEP_S` | `600` | how often signals are recomputed |
| `IYYE2_MOTIVATION_THRESHOLD` | `0.6` | smoothed need that creates an opportunity |
| `IYYE2_MOTIVATION_SUSTAIN` | `3` | consecutive sweeps above the threshold |
| `IYYE2_MOTIVATION_SHARES` | `40,30,30` | curiosity, agency, social shares of background time |
| `IYYE2_SOCIAL_DAILY_MAX` | `3` | Iyye-initiated social messages per day in all |

## 13. Open questions for the owner

1. Before or alongside Stage 3 (§9)?
2. May curiosity use the web in background work (searches it decides on its own, within the daily web budget)?
3. May agency propose plans from your passing remarks, or only when you say something like "plan this"?
4. Social initiative: may Iyye follow up with contacts (e.g. Jacob's exam) on its own, or only with you at first?
5. Default shares (§7) and the social cap (3/day).
