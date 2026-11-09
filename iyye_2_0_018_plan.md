# Iyye 2.0.018 — A Coherent Model of Itself and Its Surroundings, and More Initiative: Implementation Plan

2026-11-09. Proposed; nothing here is built. It waits for the owner's decisions in §7.

Owner's direction (2026-11-09): Iyye should do more work on its own. The top priority is to build and keep a coherent model of itself and its surroundings: CPU, GPU, memory, disk, hardware, the LAN, and the people it talks with.

## 1. Where it starts

**Built and reused:**
- The self model (plan 0.010 M0b): `self/probes.ts`, `self/model.ts`, tables `self_facts` and `self_changes`, `/self`, the owner's `<about_me>` note, gaps as curiosity signals.
- Observation domains (plan 0.007 S4): `machine` every 2 h (free disk of one filesystem, available memory, loaded models, service states), `workspace`, optional `project`; findings through the acting `observation_importance` role.
- The `monitor` toolkit (2026-10-12): `gpu_status`, `temperatures`, `pressure`, `top_processes`, `io_rates`, `system_errors`. On demand only; Iyye's own work may call it (`IYYE2_MONITOR_BACKGROUND=1`).
- The motivations (plan 0.010 M0–M4): signals, the tracker, one opportunity queue, the actor (notify, ask, maintain, propose, follow up), investigations with host-checked citations, the initiative ledger (120 min a day).
- People (plan 0.005 stage 2), the fact ledger and its disclosure rules (plan 0.011), plans and reminders (plan 0.006), the sandbox.

**What the live records show (Spark, 2026-11-09, read-only):**

| | Figure |
| --- | --- |
| Initiative model time, last 30 days | 0.6 min in all, against 120 min a day |
| Tool calls by Iyye's own sessions, 30 days | 2 (`web_search`); none of `monitor` or `sandbox_run` |
| Investigations, ever | 1 |
| Opportunities opened, 30 days | 23 (8 social, 9 curiosity, 4 agency, 2 self-preservation) |
| Self model | 34 fields: hardware 6 (the GPU only as a name), power 5, sleep 7, versions 4, network 2 (interface name, hashed network id), place 8, 2 stated relations |
| People | 5 contacts, 221 current beliefs (127 about the owner, 22 about contacts), no notes |

**What Iyye does not know, though its records hold it:**
- **Its network goes away most nights.** Since 2026-10-12 the default route disappeared on 15 evenings between 23:03 and 23:50 local time, and was seen again the next morning (between 07:00 and 10:30, by the first probe after waking). Telegram's "retrying" findings fall in the same minutes. Each one is reported as news. The Ethernet port has no link; Iyye is on Wi-Fi only. The cause is not known.
- **A machine it depends on has been away for 15 days.** The thinking model on the MBP is unreachable since 2026-10-25. Iyye cannot tell "the MBP is not on the LAN" from "the MBP is there and its server is not answering".
- **A request repeats.** The owner asked for AI news and r/LocalLLaMA 17 times on 14 days since 2026-10-13. The recurring-question detector does not see it, because Iyye answers it each time.
- **What uses its memory and disk.** 73 GB of 121 GB were in use; no record says by what. Swap is never recorded on Linux (the probe is macOS only).

**Gaps against plan 0.010 §3.1** (planned, not built): disks, thermal state, load and memory pressure, Iyye's own processes with their memory, loaded models' memory, weather, devices it can sense, per-person commitments and plans. Nothing covers the LAN, history, or what is normal.

**Fixed on 2026-11-09, before this plan:** a removed service's row no longer counts as an outage for ever, and a strong signal opens its own opportunity even under a stronger one (plan 0.010 §4).

## 2. Scope

**In:**
- More of the machine and its surroundings in the self model, by typed probes.
- History of numeric readings, and what is normal for each: baselines, regularities, forecasts.
- A declared dependency map, so one cause gives one finding.
- A card per person, derived from records.
- New reasons to act that come from the model: surprises, forecasts, regularities to confirm, recurring requests.
- Two new kinds of action: routines (a recurring task the owner approved once) and typed maintenance.

**Out:**
- Any shell, interpreter or free-form command for Iyye's own work. Every probe is a fixed command with fixed arguments, and every action is typed (HLD invariant).
- Active network scanning (§7 decision 2).
- Reading other machines. Iyye observes that they exist and answer, nothing more.
- Psychological descriptions of people (HLD §6.4). A card holds what records show.
- Learned weights for the motivations (Stage 4), camera and microphone content.

## 3. The model

### 3.1 Facets

One store (`self_facts`, as now), more facets. Every field keeps its source and time. A probe that does not exist on a platform is not run there.

| Facet | Fields | Source (Linux / macOS) | Window |
| --- | --- | --- | --- |
| **compute** | CPU load (1, 5, 15 min) and core count; CPU, memory and I/O pressure; GPU utilisation, temperature, power; the hottest sensor | `/proc/loadavg`, `/proc/pressure/*`, `nvidia-smi`, `/sys/class/thermal` / `sysctl` (what it gives without privilege) | 10 min |
| **memory** | total, available, swap used; memory of each of Iyye's own processes (host, router, each model instance, Hindsight, PostgreSQL, Kev, SearXNG), by role, never by command line | `/proc/meminfo`, `/proc/<pid>/status` for the PIDs the host supervises / `vm_stat`, `ps -o rss` | 10 min |
| **storage** | each real filesystem: size, free; the size of Iyye's own directories (state, models, model caches, logs, memory database, sandbox) | `statfs` on the mount list; a bounded directory walk of a fixed list, at night | 1 h; sizes daily |
| **network** | each interface: kind (Wi-Fi, Ethernet), link up or down, signal; whether a default route exists; whether the gateway answers at the link layer | `ip -j link`, `/proc/net/wireless`, `ip route`, `ip neigh` / `route`, `ifconfig`, `arp` | 10 min |
| **lan** | hosts in the kernel's neighbour table: an id (hashed hardware address), private address, first and last seen, the owner's label | `ip neigh` / `arp -an`; passive only | 30 min |
| **peers** | each machine Iyye is configured to use (the MBP's endpoints): on the LAN or not, answering or not, since when | the neighbour table, and the status the host already has | 10 min |
| **devices** | displays, cameras, microphones, audio outputs: present or not, never their content | `/sys/class/drm`, `/dev/video*`, `/proc/asound` / `system_profiler` | daily |
| **models** | each registry model: file size, memory when loaded, load time, measured speed (prompt and generation tokens per second from its own requests) | the registry, `model_ops`, the router's timings | on load; daily |
| **rhythm** | how long each night took and its parts, when the owner is usually active | `energy_ledger`, the night report, `events` | daily |

- **One source of truth.** The `machine` observation domain and `system_status` read these facets; they stop probing on their own.
- **Privacy** (as plan 0.010): hardware addresses are hashed before they are stored. Public addresses, serial numbers, host names of other machines and SSIDs are never kept. Private (RFC 1918) addresses are kept, owner-only (§7 decision 2). The lan, peers, place and people facets never reach a contact's turn.

### 3.2 History

- `self_readings` (migration): `(facet, field, at, value)` for numeric fields, one row per probe. Kept 7 days, then folded into hourly rows (min, mean, max, count) kept 90 days. About 40 fields at 10 minutes is 40,000 rows a week.
- **Recorded asleep too** (§7 decision 1): the vitals probe is cheap and uses no model. Asleep it only writes rows. It raises nothing until Iyye is awake.
- State changes that are not numbers (link down, service state, peer away, model loaded) are already events with a time: `self_changes`, `service_status`, `model_ops`. Regularities read them there.

### 3.3 What is normal

All deterministic, computed at the end of each night from the records, and inspectable (`/self normal`):

- **Baselines.** For each numeric field: the median and spread of its hourly values over the last 28 days, by hour of the local day, weekdays and weekends apart. A reading is **surprising** when it stays outside the usual band for three probes and also passes the field's own floor (for example memory available below the band *and* below 16 GB), so ordinary noise raises nothing.
- **Regularities.** An event of one kind (the network away, a service down, a peer away, the owner active) whose start falls within the same 90 minutes of the local day on at least 5 of the last 14 days is a candidate regularity with its usual start, usual end and support. Local time, not UTC: the nightly gap moved by an hour in UTC when summer time ended.
- **Expected or a problem is the owner's call** (§7 decision 4). Iyye asks once: "My network goes away around 23:15 most nights and is back by about 07:30. Is that intended?" The answer is stored as an owner statement:
  - *expected*: it stops being a finding and a notice; work is planned around it; a night it does **not** happen is the surprise.
  - *not intended*: it stays a problem, reported once as a pattern with its count, not once a night.
- **Forecasts.** A line through the daily values of a few fields: days until the disk is full, the night's length against the rest window, memory left for the night's model. A forecast becomes a self-preservation signal when it crosses its limit (the disk full within 30 days; the night longer than its window on 3 of 5 nights).

### 3.4 Dependencies

A small map declared in the host, not learned:

```
Telegram, web search, place estimate  → the internet → the default route → the link
the thinking tool                     → its server on the MBP → the MBP on the LAN → the link
the night                             → the memory model, memory for it, long-term memory
```

- A failing thing whose dependency is also failing is attributed to that dependency. One signal, one finding, one notice: "Telegram and web search cannot be reached because the network is away (as most nights)".
- "The internet" is inferred from what Iyye already runs (the Telegram poller, web search). No new outbound check (§7 decision 3).

### 3.5 People

A card per person, derived from records each time it is read. Nothing new is stored, so `/forget` needs no new path.

| Field | From |
| --- | --- |
| Accounts, channels, trust, linked person | `contacts`, `contact_links` |
| Relation to the owner | the owner's statement; else the ledger's `relation_of` belief, shown as a hypothesis |
| How often, how recently, usual hours and days | `events` |
| Languages they write in | the scripts of their own messages (counts) |
| What Iyye knows about them | their current beliefs, under the ledger's disclosure rules |
| Open reminders, plans and follow-ups; how the last follow-up ended | `commitments`, `plans`, `opportunities` |
| The owner's notes | `person_notes` |
| What is missing | no relation, no stored email, a name in one script only |

- **Use:** `/person <person>` shows the card; the owner's about-me note gets one line per active person; follow-ups go out in the person's usual hours (still inside `IYYE2_SOCIAL_HOURS`); gaps are questions to the owner, under the existing limits.
- **Never:** a guess about character or mood, a relation taken from tone, anything from one person's words on another person's card beyond what disclosure already allows.

### 3.6 Reading the model

- **`/self`** by facet, each line with its age and a mark when it is unusual now; `/self history <field>`, `/self normal`, `/self hosts`, `/self host <id> <label>`, `/self host <id> forget`.
- **`<about_me>`** stays short: what is unusual now, what is expected today, and the stable lines. Live figures still come from tools.
- **A read tool**, `self_model(facet)`, in the `monitor` toolkit (effect `private`: the owner and Iyye's own work, never contacts). It returns one facet with ages, the baseline and the last changes.
- **Iyye's own work gets an about-me note too** (today only the owner's turns do). In sessions that can search the web it carries no place, no people and no LAN: their queries leave the machine (§7 decision 7).
- **Memory:** a stable change, and a regularity the owner confirmed, is retained once in `iyye-self`, as stable facets are today.

## 4. More work from the model

Every new reason is a record with evidence; Iyye's own text is never one (HLD §11.2). Every action stays inside the existing caps, holds and the initiative ledger.

| Reason (signal) | Motivation | Action |
| --- | --- | --- |
| A surprising reading (§3.3) | curiosity | An investigation with `monitor`, `machine` and a new typed `disk_usage` probe (sizes of Iyye's own directories). Fruitful only when the answer cites what the tools returned. The comment "machine findings are not investigated yet" in `investigations.ts` goes. |
| A candidate regularity | curiosity | One question to the owner; the answer becomes an expectation. |
| An unknown LAN host seen on 3 days; a peer away longer than usual | curiosity | A question: "What is the device that appeared on 2026-11-03?", "The MBP has been away 15 days. Is that expected?" |
| A forecast past its limit | self-preservation | A notice with the figures and the date; a maintenance proposal when one applies. |
| A failed dependency | self-preservation | One notice naming the cause. |
| A recurring request | agency | A proposed routine (§4.1). |
| An expected event that did not happen; a routine that failed | self-preservation or agency | A notice. |

Knowledge also changes behaviour that exists, with no new permission: background work is scheduled for hours the owner is usually away, nothing notifies about an expected event, and Iyye says in the evening when the night is not expected to fit.

### 4.1 Routines

- **Detector:** the owner made the same request (the content-stem match the recurring-question detector uses) on at least 4 different days of the last 14, and each time the turn answered it with read-only tools. The owner's messages are the evidence.
- **Proposal:** Iyye proposes a plan with one step of a new kind, `routine`: the owner's own words as the task, a local time taken from when they usually ask, the days, and the channel they usually ask on. It always waits for `/plan approve` (a plan Iyye proposes is never authorized at once).
- **A run** is a background job like a web investigation: read-only toolkits and `web`, no `messaging`, its answer grounded in the URLs the tools returned. The host delivers it with `Outbox.sendOwn` to the approved route, labelled as the routine's. It counts against the daily web budget. A run that cannot happen (asleep, the network away) is skipped and said so in the next one.
- **Bounds:** at most `IYYE2_ROUTINES_MAX` (3) active; only the owner's requests; only to the owner. After 7 runs with no reaction Iyye asks whether to keep it; `/plan cancel` ends it.

### 4.2 Maintenance

- A fixed list of typed actions inside `~/.iyye2` only: delete Iyye's own logs older than N days, sandbox and spike leftovers, model-cache entries no configured model uses; compact the SQLite database at night.
- **Report first** (§7 decision 6): each action measures what it would free and does nothing. `/maintain` shows the list; `/maintain allow <action>` lets Iyye run that one on its own when a forecast asks for it. Each run is an `actions` row with what it removed.
- Never: anything outside `~/.iyye2`, anything in a repository, a restart of the host itself, a package install.

## 5. Rules kept

- Typed read-only probes; no shell for Iyye's own work; the sandbox's output is never evidence.
- A self-authored text never opens work, and a notice is not service: an opportunity settles when its condition clears.
- One initiative job at a time; the ledger's shares; quiet hours; the owner busy; daily caps. No cap is raised by this plan.
- Every outward message goes through the outbox on an exact route.
- A shadow role never changes what Iyye declares or does.
- `/forget` reaches everything that names a person.

## 6. Milestones

Each one changes the files the M4 trial fingerprints, so each starts a new trial period. The M4 trial review (open since 2026-10-20) is best closed first.

| | What | Exit check |
| --- | --- | --- |
| **W0** | Spike, no behaviour. `scripts/world-spike.ts <db copy>` replays the last five weeks through the baseline, regularity and recurring-request rules. Each probe is run on the Spark and the Mac for what it returns and what it costs. | It finds the nightly network gap and the news request, and lists every other regularity it would have raised, for the owner to judge. Thresholds are set from that. Notes in `host/SPIKE-0.018.md`. |
| **W1** | The compute, memory, storage, devices, models and rhythm facets; `self_readings`; the vitals probe; `/self` views; `machine` and `system_status` read the facets. Swap on Linux. | `/self` answers "what uses the memory" and "what uses the disk" from records. No new signal. |
| **W2** | The network, lan (passive) and peers facets; the dependency map; causes in service signals and notices. | A simulated network loss gives one finding that names it. The MBP's state says which of the two cases it is. |
| **W3** | Baselines, regularities and forecasts; their signals journal-only for a week, then acting; the confirming question. | The week's journal against the owner's judgement: no more than one unwanted signal a day. |
| **W4** | Investigations of surprises; `disk_usage`; `self_model`; the about-me note for Iyye's own work. | A staged memory drop is explained with cited readings. |
| **W5** | People cards; follow-ups in a person's usual hours. | `/person` shows the card; `/forget` leaves nothing of it. |
| **W6** | Routines. | The news request is proposed, approved, run and delivered; a skipped run is reported. |
| **W7** | Maintenance, report-only, then allowed actions. | `/maintain` figures match the disk; an allowed action is recorded with what it removed. |

**Exit gate for the plan:** over two weeks, every surprise in the records has a cited explanation or a question to the owner; the three cases in §1 are handled; notices stay under their caps; the owner marks more of Iyye's own work useful than not (`/motivation useful`).

## 7. Owner decisions

| # | Decision | Recommended |
| --- | --- | --- |
| 1 | Record vitals while asleep (rows only, nothing raised until awake)? | Yes. The night is when memory is tightest and when the network goes away. |
| 2 | The LAN: read the kernel's neighbour table and keep private addresses (owner-only) with hashed hardware addresses? Active discovery (ping, mDNS)? | Passive: yes. Active: no for now. |
| 3 | Infer "the internet" from the Telegram poller and web search, with no new outbound check? | Yes. |
| 4 | A regularity counts as expected only after the owner confirms it? | Yes. The alternative (automatic after some weeks) would teach Iyye to ignore a real fault. |
| 5 | Routines: always approved by the owner once, then run unattended; at most 3; the owner's requests only? | Yes. |
| 6 | Maintenance: report-only first; which actions may later run on their own? | Report-only first; decide per action from W7's figures. |
| 7 | Iyye's own web sessions get an about-me note without place, people and LAN? | Yes. |
| 8 | A plan a person proposed whose dated first step passed more than 3 days ago: ask the owner once, then let it lapse? Today such a plan keeps agency's need at 0.89 (four plans wait for approval). | Yes. |
| 9 | Order: this plan before CH1b (plan 0.009) and N2 (plan 0.017)? | The owner's call. W0–W2 touch neither. |

## 8. Risks

- **Noise.** More readings mean more candidate findings. W3 runs journal-only for a week first, floors are per field, and the daily caps do not move.
- **A wrong "expected".** Confirmed by the owner only, shown in `/self normal`, removable; a missing expected event is itself a signal.
- **Privacy creep.** The LAN facet is new information about a home network. Passive, hashed, owner-only, and a host can be removed with `/self host <id> forget`.
- **Web-derived text reaching Telegram** through a routine. The host delivers it to the owner only; the session has no `messaging`; answers are grounded by the URL check.
- **Probe cost.** Measured in W0; the vitals probe must stay under 200 ms and never block the event loop (asynchronous, as `self/probes.ts`).
- **The M4 trial.** Every milestone is a boundary; figures before and after are not comparable.

## 9. Configuration (planned)

| Variable | Default | Meaning |
| --- | --- | --- |
| `IYYE2_SELF_VITALS_S` | `600` | the vitals probe's period |
| `IYYE2_SELF_LAN` | `passive` | `off`, `passive` |
| `IYYE2_SELF_BASELINE_DAYS` | `28` | the baseline's window |
| `IYYE2_ROUTINES_MAX` | `3` | active routines |
| `IYYE2_MAINTAIN` | `report` | `off`, `report`, `allowed` |
