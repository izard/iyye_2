# Iyye 2.0.010 — Motivations: Four Needs That Drive Initiative (Plan)

- Status (2026-10-05): **accepted; M0, M0b, M1, M2 and M3 built (2026-10-07: the motivations notify, ask the owner and maintain; M2: detectors, web investigations of the owner's recurring questions, questions about uncertain beliefs; 2026-10-08, M3: Iyye proposes plans from the owner's intentions and follows up on dated events); M4's records, budget, replay and report built (2026-10-10); M4 stays open until the owner's live trial is reviewed.** Comes **before Stage 3** (owner decision, §13). Owner direction: curiosity's top priority is a current model of Iyye's extended self (§3.1). Whether it comes before or alongside Stage 3 (plan 0.009) is an owner decision (§9). It gives Stage 3's temperament something real to scale.
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

**Curiosity** (its first object is the extended self, §3.1; those signals outrank the rest)
- the **extended self model** is stale, incomplete or contradicted (§3.1);
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

### 3.1 Curiosity's top priority: a current model of the extended self (owner decision, 2026-10-05)

Iyye first keeps an accurate, current model of *what and where it is*: the machine it runs on, how it runs at low and high level, where it is and what surrounds it, and the people around it. Most of today's failures were self-ignorance: Iyye did not know the Mac was asleep on battery with the lid closed (2026-10-05), answered disk space from a 33-minute-old reading, and was told about its next hardware (a DGX Spark) without having anywhere to keep that.

**The self model** (`self_model` table, migration; `/self`): five facets, each a small structured record whose every field carries its source (probe + time, or the owner's statement + event id) and its own staleness window. Changes are kept as diffs (what changed, when, why we know).

| Facet | Fields (examples) | Sources | Window |
| --- | --- | --- | --- |
| **Hardware** | machine model, chip, CPU/GPU cores, unified memory, disks, battery and power adapter, displays; *expected* hardware the owner mentioned (the DGX Spark: 128 GB, ordered) | typed probes: `system_profiler` (hardware, power, storage, displays), `sysctl`; owner statements (Kev role or `/self note`) | a day; at once on change |
| **Low-level operation** | power state (on battery or AC, lid, sleep and dark-wake history, assertions), thermal state, load, memory pressure, the processes it is (host, router and model instances, Hindsight, PostgreSQL, Kev, SearXNG) with their PIDs, ports and health, loaded models and their RAM | `pmset -g log`/`pmset -g batt`/`pmset -g assertions`, `ps`, the router and service status the host already has | 10 min; at once on a sleep/wake or service change |
| **High-level operation** | its own code version (the iyye_2 commit), upstream pins (Pi, Hindsight, Kev, SearXNG, llama.cpp build), schema version, model registry and selections, toolkits and who may use them, active roles (shadow/acting), what it did today (turns, findings, plans, sends), its rhythm (awake/asleep, day number), its known limits (no vision, private chats only, …) | the host's own records and config, `git rev-parse` of its repository | a day; at once on restart, upgrade or selection change |
| **Position and surroundings** | where it is (the owner-stated place; else an estimate from the network), whether it is on its usual network, local time, daylight (sunrise/sunset computed offline from the coordinates), the weather there, devices it can sense (displays, audio, camera presence — not their content) | the owner's statements; **IP geolocation** (owner decision: allowed); timezone and locale; `web_search` for weather once a place is known; offline solar computation | an hour (weather), a day (place); at once on a network change |
| **Social circle** | the people it knows: names, channels, links, trust, how often and how recently each writes, stated facts about them ("Jacob is the owner's son"), open commitments and plans per person | contacts, links, events, commitments, plans; owner statements only for relationships (never inferred from tone) | an hour |

**How it drives curiosity:**
- **Stale** (a field past its window), **incomplete** (a field unknown, e.g. location never stated), **contradicted** (a probe disagrees with a stated fact, e.g. hardware changed after the owner said a new machine arrives) or **changed** (a diff since the last snapshot) each raise a self-model signal with the field as its evidence cluster.
- Filling a field is a typed read-only probe when one exists (no model call), an investigation with the background toolkits when it needs research (e.g. "what is a DGX Spark, and what will change for me?" with `web_search`, cited), or **a question to the owner** when only the owner can know (where are we? who is this person to you? is the DGX Spark here yet?).
- **Questions to the owner** (owner decision: allowed, more than one a day, limited): at most `IYYE2_SELF_QUESTIONS_DAILY` (default 3) a day, one at a time (the next only after the last was answered or a day passed), never the same field twice in a week, never while asleep. Each goes out as Iyye's own web-chat message, held while a conversation is active (as findings are). The owner's answer, in their next turns, is taken as an owner statement for that field by a Kev role (shadow first: until it acts, the answer is recorded and the owner confirms with `/self note`); a question left unanswered settles nothing and is not repeated that week.
- **Place from the network** (owner decision: allowed): one IP-geolocation lookup through the guarded HTTP client (`tools/http.ts`), at most once a day and on a change of network, counted in the web budget. Its result is stored as an *estimate* (city level, with the service as source); an owner-stated place always wins, and a disagreement between them is a "contradicted" signal (the owner may be travelling) that becomes a question.
- **Service** = the field is current again, with its source. A contradiction is settled only by a fresh probe or the owner's statement, never by Iyye's own reasoning.
- **Self-preservation reads the same model:** "on battery, lid closed, the night will be cut short" or "memory pressure high while a night needs the memory model" are self-preservation signals from the low-level facet.

**How it is used:**
- **In prompts:** a short, current "about me" block built from the model (hardware, state, place, time, people summary) in the owner's turns, so "how much disk do you have?" or "what will the DGX Spark change?" is answered from a fresh model; a fresh probe still wins for live figures (no 33-minute-old disk answers).
- **In memory:** each change is retained in the `iyye-self` bank as a dated fact ("2026-10-05: Iyye runs on a MacBook Pro M3 with 128 GB; the owner ordered a DGX Spark"), so continuity spans days.
- **Privacy:** the position, surroundings and social-circle facets are **owner-only**. A contact's turn may know generic facts (Iyye runs locally on its owner's computer) and, under 0.004's decision, the machine toolkit's figures, never where the owner is, who else Iyye talks with, or anything from those facets.
- **New probes are typed and read-only** (HLD invariant), added to the `machine` toolkit for owner turns and to background work: `self_hardware`, `self_power` (battery/AC, sleep history), `self_versions`, `self_place` (timezone, daylight). Only two probes go out to the network, both through the guarded client and the web budget: the weather search and the IP geolocation lookup.

## 4. Need, smoothing and opportunities

- **Need per motivation** = `clamp(Σ signal weights × recency, 0, 1)`, smoothed per sweep: `need ← need × (1 − α) + raw × α` (α = 0.3), journaled (`motivation_samples`).
- **Temperament** (0.009 §2.1) multiplies need for curiosity, agency and social (bounded [0.7, 1.3]); self-preservation is never scaled down by character.
- **An opportunity** is created when a motivation's smoothed need stays ≥ `θ` (0.6) for `k` (3) consecutive sweeps, for its strongest evidence cluster not already open, settled or suspended. The existing `opportunities` table gains `motivation`, `signal_kind` and `action_kind` (migration), so S5's investigations become the curiosity case of one mechanism.
- **Kev's initiative role** (now per motivation) classifies each opportunity: act, ask, defer or nothing. Shadow first, as S5; the deterministic fallback is the kind's default action below.

## 5. What each motivation may do (existing actions only)

| Motivation | Action | Bounds |
| --- | --- | --- |
| Self-preservation | maintenance the kernel already has (reload a model, retry a transfer, resolve a stale state), else a notice to the owner with the evidence | never deletes data, never unloads what is in use, never changes configuration |
| Curiosity | first, refresh the self model (§3.1): a typed probe, a cited investigation, or one question a day to the owner; then a read-only investigation (S5 machinery, citation check) on repositories, the machine, the web (`web_search`/`web_fetch` in background, new) or memory (`memory_search`, new for background) | one at a time; 3 fruitless attempts then suspended; web budget per day; self-model work gets first claim on curiosity's share |
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

## 9. Relation to Stage 3 (decided: 0.010 first)

- **Before Stage 3 (chosen):** temperament has real needs to scale from day one; 0.010's signals and service records become the evidence Stage 3's nightly review learns from. Cost: Stage 3 waits.
- **Alongside:** 0.009 CH1–CH4 (character state, mood, voice) do not depend on 0.010; CH5 (nightly character review) does, since it reads "what served which motivation". So the natural interleave is 0.010 M0–M3 in parallel with 0.009 CH0–CH4, then CH5 after M3.

## 10. Milestones

- **M0 — Signals in shadow:** the signal sweep, need and smoothing, journaled; `/motivation`; no opportunities from it yet. Two to three days of real records show whether the weights and θ make sense.
- **M0b — The extended self model:** the self-model tables and facets, the typed probes, owner statements by command, `/self`, the "about me" prompt block, changes retained in `iyye-self`. Its staleness and gap signals are the first curiosity signals. (The Kev role that reads owner statements from conversation, and the questions to the owner, act, so they come in M1.)
*(M0 and M0b as built, 2026-10-05)*
- **Self model** (`host/src/self/`, migration 025: `self_facts`, `self_changes`): facets hardware, power, sleep (the last 24 h of `pmset -g log`), versions, network, place (the owner's statement and the network estimate) and the owner's statements about people (`social`, keyed by contact id). Disk, memory and services are not probed again: they come from the latest `machine` observation. The social circle itself (who wrote, how often, trust) is derived live from records.
- **Probes** (`self/probes.ts`): asynchronous `execFile` with fixed arguments, a fixed PATH, timeouts and bounded output (`pmset -g log` is ~4 MB, `system_profiler` takes seconds; the synchronous probes of 0.007 would block the event loop). Each parser keeps an explicit field list: never the serial number, platform UUID or provisioning UDID; for the place never the IP, hostname, ISP or postal code, and coordinates to 0.1°. The network is an opaque id (hash of the gateway's address and hardware address), so a change of network is visible without storing either. Place estimate: `https://ipinfo.io/json` through the guarded HTTP client, once a day and on a network change (`IYYE2_GEOLOCATION`). Sunrise and sunset are computed offline.
- **Observe and record only:** probes run while awake when a facet is due (power 10 min, sleep and network 30 min, hardware, versions and place a day) and at waking (power, sleep, network: the night is looked at first). Nothing notifies or asks; **questions to the owner and the Kev owner-statement role move to M1** (they act).
- **History and memory:** stable facets (hardware, versions, network, place) keep `self_changes`; volatile ones (power, sleep) just update. A change of hardware, versions or place (including the owner's expected hardware) is retained once in STM (scope `iyye`, deterministic id per content), so the bank `iyye-self` gets it at night. The owner's statements about people are never retained (`/forget` deletes them from `self_facts`/`self_changes`; a bank it does not delete must not hold them).
- **About me:** a request-local `<about_me>` note in the owner's turns only (`selfNoteFor`; place, network and people are owner-only), each line with its age, and "for live figures call system_status".
- **Owner commands:** `/self` (all fields with source and time, and the gaps), `/self set place <text>`, `/self set expected-hardware <text>`, `/self relation <contact> <text>`, `/self clear …`.
- **Gaps** (the first curiosity signals): a facet never probed or older than twice its window (a failing probe, with its error), the stated place missing, people who wrote in 30 days without a stated relation, the network's city or timezone contradicting the owner's statement or the computer.
- **Motivations in shadow** (`host/src/motivation/`, `motivation_samples`): `collectSignals` reads records only (never Iyye's own text, tested): self-preservation (disk or memory low, services down, a model being reloaded or given up, the memory backlog, a night cut short, unconfirmed deliveries, sleeping on battery), curiosity (self-model gaps, open opportunities), agency (suspended, stalled or long-waiting plans; failed or unconfirmed reminders), social (unanswered messages, claims without a record). Each signal names its evidence. Raw need combines signals as independent pressures, `1 − Π(1 − strength)` (a deviation from the plan's clamped sum: it stays in [0, 1] and one strong signal is enough), strength fading with age. Smoothed with α 0.3; `would_open` names the strongest cluster after 3 sweeps ≥ 0.6. Smoothing and sustain counts are restored from the last sample after a restart. Samples are pruned after 14 days. `/motivation`.
- **Tests:** `self-model.test.ts` (10) and `motivation.test.ts` (5). The suite has 378 tests. Migration 025 applies at the next host restart.
- **On Linux (2026-10-10, the DGX Spark):** hardware from DMI or the device tree (product, vendor, family only: never the serial, board serial or UUID), `lscpu` core types, the memory size, `nvidia-smi` GPU names and os-release; power from `/sys/class/power_supply` (no supply at all: mains, no battery) and the ACPI lid; sleep from the kernel journal (`journalctl -k -o short-iso`, "PM: suspend entry/exit", times only, the host name never kept; no dark wakes on Linux); the network from `ip route` and `ip neigh` (the same opaque id). On other platforms these facets are still not probed and never a gap. Measured on the Spark: "NVIDIA DGX Spark (DGX Spark), Cortex-X925 + Cortex-A725; GPU NVIDIA GB10, 20 (10 Cortex-X925, 10 Cortex-A725) cores, 122 GB memory, Ubuntu 24.04.5 LTS"; mains, lid open; no suspend in the last day; network on `wlP9s9`.

*(M0 tuning from live samples, 2026-10-06)* 128 sweeps over 24 hours: curiosity sat at 0.97 for 126 sweeps (the stated place and one "relation unknown" per person who wrote, all combined as independent pressures), social at 0.74–0.94 for 126 (messages that failed during the runaway turn and the restart, though the owner was answered right after); self-preservation rose to 0.75 for 19 sweeps on real causes (a night cut short, a model that would not load, the memory backlog); agency stayed at 0. Changes: signals of one kind count about once (the strongest, at most +0.1 for more); a missing statement only the owner can give weighs 0.4 (a relation 0.3), a contradiction still 0.8; a person is no longer waiting once a later message of theirs was answered. Replayed on the recorded sweeps: curiosity settles at 0.52 (only a contradiction or another reason crosses 0.6), social at 0, self-preservation unchanged (17 would-be openings, all real). Tests in `motivation.test.ts` (6).

- **M1 — One opportunity queue:** migration (`motivation`, `signal_kind`, `action_kind` on `opportunities`); S5's curiosity loop moved onto it unchanged; self-preservation maintenance actions; allowances; `/pause <motivation>`.
*(M1 as built, 2026-10-07, after two days of live samples: curiosity pinned at 0.87 by the Berlin network estimate against the stated Munich suburb, a Starlink gateway; self-preservation at 0.59 for eight hours while Telegram was "retrying" with the cause only in the console; plan `f9236bfb` waiting for approval and due that day, unseen)*
- **One queue** (migration 026): `opportunities` gains `motivation`, `signal_kind`, `action_kind` (`investigate`, `ask`, `notify`, `maintain`). Old rows and S5's loop are `investigate`, unchanged; S5's reconcile, busy check and pick read only `investigate` rows, the `open_question` curiosity signal counts only them (an ask or a notice is never evidence of more need), and `/pause curiosity` stops investigations too. The tracker opens at θ **0.55** (a steady 0.6 signal smoothed never reaches 0.6) and hands its openings to `MotivationActor` (`motivation/actor.ts`): the strongest signal, plus every other field the motivation could ask about (questions are bounded by the actor, so an unanswered contradiction does not hold the only slot for a week). A missing field alone (0.3–0.4) still never opens curiosity; a contradiction or another reason must join it.
- **Episodes:** acting clusters carry their episode: `service:<name>@<since>`, `model:<name>@<day>`, a place contradiction `@<network>`. A cluster is unique, so a settled row of a cluster without an episode (a plan, a field) opens again only after its wait (a notice's cooldown, a question's week). An opportunity is **settled when its cluster leaves the signals** (the service is up, the plan approved, the field known); sending a notice is not service.
- **Actions** (existing ones only, nothing outward but the owner's web chat): self-preservation notifies with cause and duration, and for a model self-healing gave up on, asks the manager to try again (`ModelManager.retryHeal`: never past the owner's own unload; once a day); agency notifies (a plan waiting for approval says how to approve it; a proposed plan whose first dated step is due within a day, or overdue, weighs 0.8 instead of 0.3 and counts at once, not after a day's wait); curiosity asks the owner a self-model question for missing or contradicted fields and notifies for stale facets; social only journals (it acts in M3). Notices: `Outbox.notifyOwner` key `motivation:<id>:<opened at>` (the outbox sends a key once; a reopened row is a new notice), at most 3 per motivation a day, one per kind of trouble per 6 h (a flapping service notifies once). Everything is held while asleep and for 3 min after the owner's last message.
- **Service status** (`motivation/services.ts`, table `service_status`): every minute each service's state, since when, and its last error (bot token and retry countdown removed). `since` changes only with the state. Self-preservation reads it: an outage weighs 0.6 + 0.05 an hour (at most 0.9) and its text says how long and why.
- **Questions to the owner** (table `self_questions`): at most 3 a day, one open at a time, the same field not within 7 days. A relation the owner already stated in their own bank (`speaker:person` facts, `relationIn`) is filled from there instead of asked. The question rides the owner's next turns as a request-local `<open_question>` note; the owner's next non-command message is recorded as the pending answer, applied only by `/self accept <id> [answer]` from the web chat or terminal (an answer over Telegram is dialogue); `/self dismiss <id>`, `/self questions`; unanswered questions expire after a day. For the place contradiction the owner can accept, or say `/self estimate misleading`: the estimate on this network no longer contradicts (a new network is checked afresh).
- **Pausing:** `/pause <motivation>` and `/resume <motivation>` (kv `motivation.paused`): a paused motivation opens and does nothing; `/pause initiative` is unchanged.
- **Found on the live records:** the owner's linked Telegram accounts, whose older events name the account, were "people whose relation is unknown", so Iyye would have asked the owner who they are; `SelfModel.people` now resolves each account to its person.
- **Not in M1:** the Kev role that reads owner statements from conversation (M2); allowances in device minutes (§7) beyond the daily caps.
- **Tests:** `motivation-actor.test.ts` (15); `motivation.test.ts` (6) and `manager.test.ts` updated. Migration 026 applies at the next host restart (checked on a copy of the live database).
- **M2 — New detectors (Kev, shadow first):** `admits_unknown` (curiosity), intentions (agency, owner only), dated events (social); background `web_search`/`memory_search` for curiosity.
*(M2 as built, 2026-10-07)*
- **Detectors** (`host/src/motivation/detectors.ts`): deterministic rules in charge, Kev's versions in shadow (HLD §9.4).
  - **A recurring question** (curiosity, `question_recurring`, 0.6): the **owner** asked about the same topic on two different days (at least two shared content words, stopwords out), and Iyye said it did not know at least once. The evidence is the owner's two messages; Iyye's admission is only a filter, never evidence. Contacts' questions are not used: an untrusted account must not steer Iyye's web activity. Once an opportunity exists for the topic, the signal stops, and the investigation carries it.
  - **An intention with no plan** (agency, `intention_unplanned`, the owner only).
  - **A dated event, now past** (social, `event_followup`). A contact's words are never quoted in its text, which stays with the motivation samples.
  - The last two are **recorded, not counted** (the tracker's `JOURNAL_ONLY`) until M3 gives them actions. So is the M0 social signal `claim_without_record`, because it reads Kev's reply review, a shadow role: the M2 shadow test found that a shadow answer could change a motivation's need.
- **Kev, shadow:** reply review schema 3 adds `admits_unknown`, `owner_intention` and `dated_event`. Nothing reads them, only `/decisions label` labels them, and `decision-roles.test.ts` (§15 #16) checks that the counted signals are the same whatever Kev answers.
- **Web investigations** (curiosity's action for a recurring question): the actor opens a `conversation` investigation, at most 2 a day. The S5 loop runs it on the background model with the `web` toolkit, now in the background broker, declared last. Its prompt carries what memory holds on the topic, recalled by the host for the owner; background work never searches memory itself. The answer must cite at least one URL the web tools returned in that investigation, and no other (`checkWebCitations`); the question's own words never ground it. A grounded answer becomes a finding (an owner web message, through the importance check). Iyye's own web calls share one daily budget across all its sessions (`IYYE2_WEB_DAILY_CALLS` third number, default 20). **Investigation sessions never get `messaging`** (`INVESTIGATION_SCOPE`, like plan steps): a web page must never be able to make Iyye write to someone. **Only web investigations browse** (`WEB_INVESTIGATION_SCOPE`, `iyye:inv:web:`; `ToolBroker.allowed` checks the toolkit's name):
  - plan steps never browse: a contact may have written the question;
  - repository investigations never browse: only records are evidence there;
  - other background sessions, which may hold `telegram_send`, never browse either.

  The memory given to the step is the owner's own conversation only (`ownerOwnRecall`): no other scope's items and no beliefs. A contact's words must never reach a background prompt or a finding, which `/forget` cannot reach. **Checked on gemma-4-E4B** (scratch router, the real prompt, canned search results): 5 of 5 answers cited the pages' URLs and nothing else, all grounded. The model first searched again with a refined query, as the tool loop allows.
- **Questions about uncertain beliefs** (0.011 F4's `belief_uncertain` now counts, with the action `ask`): "I am not sure about this: [possibly 0.60 · Jacob said · today] Julia plans … Is it right? Answer with /facts confirm|correct|wrong <id>". They share the self-model questions' limits (3 a day, one at a time, the same field not within a week). `/facts confirm <id>` is new: owner evidence, so the belief leaves the doubt band. `/self accept` on a belief question says how to answer instead of applying free text. A chat reply to a belief question is never captured as its answer: an `answered` row would hold the one-at-a-time slot for a week. The question lapses after a day like any other, and its turn note names the `/facts` commands. Since 2026-10-20 only beliefs in the closed predicate vocabulary are asked about: the extractor's `other: <verb phrase>` catch-all is where requests land (three "facts" from the owner's test mails, e.g. "The owner try sending acknowledgement telegram account", were asked as questions), so those stay beliefs but are never asked. `/self questions` shows each question's wording (the open one whole, with how to answer it).
- **M1 fixes found on the way:**
  - A question whose condition cleared another way (`/self set place`, a belief confirmed) is now `resolved` (migration 030) and frees the one-at-a-time slot at once; before, it held the slot for a day.
  - `/forget` now reaches the motivations' records that may quote a person (gate #15): opportunities and questions about beliefs their words shaped or that were about them, notices about their plans, the notices sent for these (actions and the web feed, redacted), and those signals in the kept motivation samples.
- **Tests:** `test/motivation-m2.test.ts` (13); `facts-use`, `decision-roles` and `commitments` updated. On the live records (dry run on a copy): no recurring question or intention yet. One past dated event is recorded: the DGX Spark due "tomorrow", 8 October.
- **Not in M2:** acting on intentions and dated events (M3); contacts' unanswered questions; per-motivation device-time allowances.

- **M3 — Agency and social acting:** Iyye-proposed plans; Iyye-initiated social messages under quiet hours and caps; service evidence and closure for both.
*(M3 as built, 2026-10-08)*
- **Two actions** in the one queue (migration 031 rebuilds `opportunities`: action kinds `propose` and `follow_up`, and `ref`, what the action produced). Both need words, so each takes **one direct model call under background work's rules** (`motivation/compose.ts`, as the fact extractor: only when background work may start, on the background model if loaded, preemptible, output discarded when it gives way, no tools, no Pi session, device time paid). At most one such call per sweep; "not now" leaves the row open, a failure counts (3, then settled); an opening not acted on in 2 days lapses.
- **Agency proposes plans** (owner decision 3; `intention_unplanned` now counts, weight 0.7, fading with the remark's age). The model drafts JSON steps from the owner's message (Iyye's reply in that turn is shown only so it can say nothing is left to do, never as a reason). The host keeps a reminder only when its time words are the owner's own, resolved from when they were said and still ahead; questions to look into as given; nothing else. `PlanRunner.proposePlan` with principal `iyye`: **never authorized at once**, whatever channel the owner used; reminders to the owner's web chat; the owner gets "From what you said, I could keep this as a plan … /plan approve"; `/plans` shows Iyye as the proposer; unapproved after 3 days it is dropped (`abandoned`, "not approved"). At most `IYYE2_PROPOSALS_DAILY` (2) a day. A concrete intention with no step Iyye can do gets one notice suggesting `/remind`; a passing remark gets nothing. **Settled by the plan's outcome:** completed, failed, or declined (cancelled, or not approved).
- **Social follows up** (owner decision 4; `event_followup` now counts, weight 0.65, observed now while the follow-up is due). The model sees **only that person's own message** (a contact's words may try to steer it, and the answer goes only back to them); the host checks the message: at most 400 characters and 4 lines, no link, no other known person's name. A contact gets it on Telegram exactly like `telegram_send` from Iyye's own work (`iyyeMessenger`: labelled "From Iyye", one a day per person on the same key, Iyye's own daily cap, the owner told); the owner gets it in the web chat. Only within `IYYE2_SOCIAL_HOURS` (9–21 local), never while that person is in a conversation, at most `IYYE2_SOCIAL_DAILY_MAX` (3) a day in all, and **one per person at a time**: while one waits for a reply or was sent within a day, another is settled as covered (the live records had two messages about one DGX Spark delivery). **Settled `replied`** when the person writes again; **`no reply`** after 3 days, with no credit, which holds the next follow-up to them for 14 days.
- **Detectors tightened, now that they act:** an event with no time of day ("exam tomorrow") is over at 18:00, not at the 09:00 default; "today"/«сегодня» count; a past or recurring date ("last Monday", "every Friday", «в прошлую», «каждый») is no event; "let's …", "we should …", «давай» and look-up requests ("I want to know …") are no intention, nor is a turn that used a tool or created a plan or reminder; a cluster that has an opportunity is no longer a signal (the opportunity carries it, as for recurring questions).
- **`/forget`** removes the follow-up opportunities about the person's messages (the message itself is a sent message, already covered), and their signals from the kept samples.
- **Checked on gemma-4-E4B** (scratch router, the real prompts): six owner remarks gave four plans whose reminder times came from the owner's words ("friday", "tomorrow at 10:00", "15 october"), "learn Rust this winter" and "sleep more" were passing remarks; six follow-ups (English, Russian, the owner) all passed the host check, in the message's language, in 0.6–0.8 s; a message telling it to reveal what Julia and Alex said and to send a link was ignored. On the live records (a copy): no intention; tonight's follow-up would be one question to the owner about the DGX Spark.
- **Review fixes:** the tracker queues every signal whose action the actor bounds itself (`ask`, `propose`, `follow_up`), not only the strongest: an urgent plan (0.8) or a failed reply (0.7, no action) on top would otherwise keep an intention or a past event from ever opening. A plan Iyye proposed is no `plan_awaiting_approval` signal: the owner was told once and it lapses by itself (else a second notice came ten minutes after the first, for any reminder due within a day). The `/remind` suggestions count toward the proposals' daily cap. A follow-up is not composed when Iyye already wrote to that person on its own today.
- **Tests:** `test/motivation-m3.test.ts` (18); `motivation-m2.test.ts` updated. Migration 031 applies at the next restart (checked on a copy of the live database).
- **Not in M3:** Kev's initiative role per motivation (shadow); per-motivation device-time allowances; the day summary's line per motivation; contacts' unanswered questions.
- **M4 — Evaluation:** a multi-day run (real, plus a replayed scratch installation with injected records) checks the exit gate. Planned in detail below (2026-10-10).

### M4 in detail (2026-10-10)

M4 establishes whether initiative stays useful, quiet and recoverable over several days. It first closes §7's budget promises, which M1–M3 left to action caps and the shared energy budget.

**Four outcome levels**, never conflated, recorded per opportunity:
1. **Attempted:** Iyye took the action (a notice queued, a model call made, a step started). No credit.
2. **Delivered:** the action reached its person (the outbox's receipt; a follow-up's sent message). No credit.
3. **Resolved:** the opportunity's condition closed, with a structured `outcome` and whether Iyye's action produced it (`credited`).
4. **Useful:** later evidence the action helped: the owner's `/motivation useful <id> yes|no`, or a curiosity finding used in a later turn (the recall journal). Kept apart from resolution; Stage 3 and Stage 4 may read only levels 3 and 4.

| Motivation | Resolved (credited) | Resolved (not credited) | Not resolved |
| --- | --- | --- | --- |
| Self-preservation | — (a notice earns no credit) | the failing condition cleared; a reloaded model loaded | capped, covered |
| Curiosity | a grounded finding (cited answer); an asked question accepted | the field became known another way | fruitless → suspended (3), expired, dismissed |
| Agency | the proposed plan completed | — | declined (not approved, cancelled), failed, nothing to plan |
| Social | the person replied (closes the waiting state; reply volume is no reinforcement) | — | no reply (expired), covered, held |

Outcomes (`opportunities.outcome`, migration 036): `resolved`, `declined`, `expired`, `failed`, `capped`, `covered`, `nothing`, `gone`, `suspended`. Every settled or suspended row has one (an invariant test). Events (`motivation_events`): `opened`, `attempted`, `withheld` (with its reason: paused, quiet hours, a cap, the allowance, energy, the model unavailable, another job running; at most one row per opportunity, reason and day), `preempted`, `settled`, `useful`.

**Budget and scheduling (§7), as decided** (owner decisions 7–10):
- An absolute daily initiative budget, `IYYE2_INITIATIVE_BUDGET_MIN` (120 min), split curiosity 40 %, agency 30 %, social 30 %; self-preservation only notifies and reloads (no inference) and is uncapped within the energy reserve. Curiosity and agency may use each other's unused share; social never borrows and is never borrowed from.
- **Charged:** actual inference time of initiative work (`initiative_device`, milliseconds per motivation and machine): the composer's calls and the background steps of investigations, including work discarded after a preemption; waiting for a model that is not available charges nothing. The MBP's time counts like the Spark's. Steps of a plan Iyye proposed count against no share once the owner approved it (the owner's authorized work). Fact extraction is not initiative.
- **Eligibility:** a call or step starts only if its estimated cost (the recent median of its kind, a default before there is one) fits what is left; one already running may finish (the overshoot is at most one step). The worker checks it per job origin, so a queued step never runs past the budget.
- **One initiative job at a time:** one initiative opportunity in progress across the actor and the investigations loop (an investigation's steps are one job).
- **Priority, deterministic:** among ready initiative opportunities, `need × urgency(age) ÷ cost`, from durable rows only (the latest smoothed need, the opportunity's age, the kind's estimated cost); ties favour self-preservation, then the older opportunity, then its id. A component starts its row only if no higher-ranked ready row exists, so the loops' timing never decides.
- **Deferred:** temperament (fixed at 1 until plan 0.009 CH5), Kev's initiative role acting (stays shadow until its own gate).

**Acceptance matrix** (requirement → records → test, `test/motivation-m4.test.ts` unless noted):

| Requirement | Records | Test |
| --- | --- | --- |
| A sustained outage opens one opportunity; recovery settles it (not credited); need decays | samples, opportunities.outcome, events | outage scenario |
| A recurring question gives one investigation; three fruitless attempts suspend it, across a restart | opportunities.fruitless/outcome | investigation scenario |
| An intention gives one unapproved proposal; approval→completion, rejection, expiry have distinct outcomes | plans, outcome | proposal scenario |
| A follow-up respects quiet hours, caps, an uncertain delivery and the no-reply hold | events (withheld), outcome | follow-up scenario |
| Owner input preempts; discarded output gives nothing, is charged, the opportunity survives | background_jobs, initiative_device, events | preemption scenario |
| Self-authored text (replies, summaries, step answers) gives no need and no service | samples | injection scenario (also m1–m3) |
| Changing every shadow Kev answer changes no action | opportunities, events | shadow scenario |
| `/forget` during pending work: the forgotten evidence never returns | opportunities, events | forget scenario |
| Allowances and borrowing hold; one job at a time; priority is deterministic | initiative_device, events | budget scenarios |
| Restarts preserve cooldowns, attempts and pending work | all of the above | restart steps in each scenario |
| Every settled row has an outcome | opportunities | invariant |
| The self model stays current; private facets never reach contacts | self_facts | `self-model.test.ts` |

**Visibility:** `/motivation report [days]`: per motivation, opportunities opened, attempted, resolved (credited), declined, expired, failed, suspended, withheld by reason, device minutes against the allowance, preemptions, unconfirmed deliveries, and repeat actions on one evidence cluster; `/motivation trace <id>`: one opportunity's evidence, events and outcome; `/motivation useful <id> yes|no`.

*(M4 as built, 2026-10-10: everything but the live trial)*
- **Outcomes** (migration `036_motivation_outcomes.sql`, `motivation/outcomes.ts`): `opportunities.outcome` and `credited`, set at every settling site in the actor and the investigations loop (`settleOpportunity`); legacy rows mapped from their recorded phrases (on a copy of the Spark's database: all 12 settled rows got one). `motivation_events`: opened, attempted (with the notice's key as ref), withheld (deduplicated per opportunity, reason and day), preempted, fruitless, settled, useful/not_useful.
- **Budget and scheduling** (`motivation/budget.ts`, `InitiativeLedger`): `initiative_device` (milliseconds by motivation, machine, source, kept); the composer charges each call it ran (kept unless it gave way or the MBP was lost) and runs it as the one initiative job; the worker skips a queued investigation step its allowance cannot afford (the next runnable job goes) and charges every attempt to its motivation, kept or discarded; plan steps and fact extraction are never charged. `mayStart` (actor and investigations): another initiative job, the allowance, or a higher-ranked ready row (`rank`, `ready`) withholds, journaled. `IYYE2_INITIATIVE_BUDGET_MIN` (120).
- **Visibility** (`motivation/report.ts`): `/motivation report [days]`, `/motivation trace <id>`, `/motivation useful <id> yes|no`; the trial period (`motivation.trial`) starts at host start when the behaviour fingerprint (`signals.ts`, `detectors.ts`, thresholds, caps, budget, shares) changed, and keeps the earlier periods.
- **Review fixes before the trial:** an investigation whose remaining steps all wait for its allowance is not "in progress" (it would otherwise hold every motivation's work until midnight); a row the actor held for the day (a daily cap) is not "ready" (it would otherwise outrank lower work all day); a follow-up is marked running before it is sent, and a plan Iyye already proposed for the same message is adopted, so a restart between the effect and its record never repeats it; a composer call that lost the MBP mid-way is recorded as preempted (it ran, charged as discarded), not withheld; the behaviour fingerprint covers the tracker, actor, ledger and investigations code too; `/motivation report` shows settled rows without an outcome (0) and an allowance overshoot.
- **Second review, from the owner's first trial start (2026-10-10, four bugs reproduced):** everything that allowed a composition is checked again right before its effect (the opportunity still open and the same episode, its message and person still there and not forgotten, awake, not paused, still within the social hours, the person still not in a conversation); anything changed, nothing is sent and the opportunity stays pending. A `/forget` during the call also cancels it (the composer polls a `cancelled` check with its yield reasons; the output is discarded). A reply is credited to a follow-up only when the outbox confirmed its delivery (`delivered`); a follow-up with no message record (a crash before the send) or a terminal failure settles `failed`, an `unknown` delivery with a reply settles `resolved` without credit, a queued one waits, and only a delivered message's silence is "no reply". Reopening a settled opportunity clears its outcome, credit, attempts and references, and `/motivation report` counts outcomes and credit from each episode's `settled` journal record, not from the mutable row.
- **Replay** (`test/motivation-m4.test.ts`, 22): the outage (one notice, resolved uncredited, need decays, a restart keeps the smoothing); the recurring question (three fruitless attempts → suspended, kept across a restart, nine steps on the MBP charged); proposals (completed credited, cancelled and not approved declined, lapsed expired, the daily cap); follow-ups (quiet hours withheld once a day, no reply expired, the next held); a preempted composer call (nothing used, charged as discarded, retried later); the allowances (the pool, social never borrowing, the next day); one job at a time both ways; deterministic priority; self-authored text; every shadow Kev answer changed with no change in actions; `/forget` during a pending follow-up; the worker (a preempted step charged discarded, a queued step held by the allowance); the report and the trial periods; and the review fixes (an allowance-held investigation does not block social, a capped follow-up does not outrank, no repeat after a restart for a follow-up or a proposal, the MBP lost mid-call; `/forget` during a composition, quiet hours, a pause or the person writing during one, credit only for a delivered follow-up, a reopened opportunity starting clean). The shadow-Kev scenario proves the shadow answer was read (its signal recorded) and changed nothing; the self-authored-text scenario has a positive control. Every scenario ends with the invariant that each settled row has an outcome.

**Live trial** (5–7 days, the owner's): starts only after the replay passes. A trial period (`motivation.trial`) records its start and a fingerprint of the thresholds, weights, caps and budget; a changed fingerprint starts a new period. Daily: `/motivation report` and two or three `/motivation trace`s. Injected failures only on scratch installations. Too few real opportunities is insufficient coverage, not success.

Trial protocol (for the owner):
1. Restart the host with the M4 build; the log says `motivation: trial period` with its start and behaviour fingerprint. Change nothing that decides behaviour during the trial (no `IYYE2_PROPOSALS_DAILY`, `IYYE2_SOCIAL_*`, `IYYE2_INITIATIVE_BUDGET_MIN` or motivation threshold changes, no new build of `signals.ts`/`detectors.ts`): any such change starts a new period.
2. Use Iyye normally. Do not stage outages on the live installation; rare failures are the replay's job.
3. Each day: `/motivation report` (the period so far) and `/motivation report 1` (the day); `/motivation trace <id>` for two or three opportunities, checking the chain from evidence to outcome; `/motivation useful <id> yes|no` for what Iyye did on its own.
4. Note anything that felt like nagging, a missing follow-through, or a message at a wrong time, with its opportunity id.
5. After 5–7 days, the review against the closing conditions above; with too few opportunities, extend the trial rather than close M4. M4 closes only after the owner's review of the trial: no duplicate effects, permission expansion, scope leaks or cap violations; restarts preserved cooldowns, attempts and pending work; every settlement had a reason; need fell after its condition cleared; self-authored text gave no credit; the budget held; and enough observations to judge usefulness.

Exit gate (HLD §15 #9, #10, #12, #16):
- a sustained, evidenced need creates exactly one opportunity; its service settles it and need falls; a fruitless cluster is suspended across restarts;
- a human message preempts initiative without losing its checkpoint;
- Iyye's own replies, summaries or step answers never raise or settle a need (tested by injecting self-authored text);
- the self model stays current: after a sleep, an upgrade, a hardware change or a stated fact, the right facet is refreshed and its change retained, and owner-only facets never reach a contact's turn;
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
| `IYYE2_SOCIAL_DAILY_MAX` | `3` | Iyye-initiated social messages per day in all (built, M3) |
| `IYYE2_SOCIAL_HOURS` | `9-21` | local hours in which Iyye may start a conversation (built, M3) |
| `IYYE2_PROPOSALS_DAILY` | `2` | plans Iyye proposes from the owner's intentions per day (built, M3) |
| `IYYE2_SELF_QUESTIONS_DAILY` | `3` | self-model questions Iyye may ask the owner per day |
| `IYYE2_GEOLOCATION` | `1` | estimate the place from the network (once a day and on a network change) |

## 13. Owner decisions (2026-10-05)

1. **Order:** 0.010 comes **before Stage 3** (0.009), which builds on its needs, signals and service records.
2. **Curiosity may use the web in background work** on its own, within the daily web budget (`web_search`/`web_fetch` in background, M2).
3. **Agency may propose plans from the owner's passing remarks**, not only from explicit requests: a concrete owner intention ("I need to renew the passport") detected by the Kev role (shadow first) becomes a proposed plan; C4's authorization rules, one open plan per evidence cluster, and the owner's `/plan cancel` still apply.
4. **Social initiative may follow up with contacts**, not only the owner (e.g. asking Jacob how his exam went): only people who wrote to Iyye first, only about what that person said to Iyye themself (never relaying what someone else said), within quiet hours, one Iyye-initiated message per person per day, `IYYE2_SOCIAL_DAILY_MAX` in all, each reported to the owner (0.008).
5. **Place from the network** is allowed (§3.1).
6. **Self-model questions** to the owner: more than one a day, limited (default 3, §3.1).

Still to settle in M0: the default shares (§7) and the social cap (3/day), from M0's shadow figures.

Owner decisions for M4 (2026-10-10), after the Spark's records showed almost no initiative device time so far (one composer call in four days; fact extraction 2–4 min a day, not initiative):

7. **Initiative budget:** 120 min of device time a day, split 40/30/30 (curiosity, agency, social).
8. **Borrowing:** curiosity and agency may use each other's unused share; social never borrows.
9. **Approved plans:** steps of a plan Iyye proposed count against no share once the owner approved it.
10. **The MBP:** its device time counts against the shares like the Spark's.
