# Iyye 2.0.018 — A Coherent Model of Itself and Its Surroundings, and More Initiative: Implementation Plan

2026-11-09. The owner accepted §7 the same day, with one change (decision 2: the LAN may also be probed actively, rarely). W0 (the spike, `host/SPIKE-0.018.md`), W1 and W2 are done. W3 is built; its exit check (a week of its journal against the owner's judgement) is open. W4, W5 and W6 are done, and so is decision 8; W7 is next.

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
- **It is not running at night** (found by W0). On the Spark the host runs in the foreground of the owner's SSH session. The router's Wi-Fi goes off around 23:15, the session closes about 15 minutes later, and the host ends with it; it starts again when the owner logs in and starts it. On all 30 nights since 2026-10-10 it was down for a median of 8.2 hours, and none of the Spark's 29 completed nights ran in the rest window: every one is a catch-up by day. The machine itself never sleeps, and no facet says "I was not running".
- **Its network goes away every night.** The Spark's log shows the access point gone from about 23:12 to 07:11 (`ssid-not-found`: the router's Wi-Fi is off). The self model caught it on only 15 evenings since 2026-10-12, because the host is usually gone before the next 30-minute probe. Telegram's "retrying" findings fall in the same minutes, and each one is reported as news. The Ethernet port has no link; Iyye is on Wi-Fi only.
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
- Frequent or wide network scanning. Rare active probes of the LAN are allowed (§7 decision 2).
- Reading other machines. Iyye observes that they exist and answer, nothing more.
- Psychological descriptions of people (HLD §6.4). A card holds what records show.
- Learned weights for the motivations (Stage 4), camera and microphone content.

## 3. The model

### 3.1 Facets

One store (`self_facts`, as now), more facets. Every field keeps its source and time. A probe that does not exist on a platform is not run there.

| Facet | Fields | Source (Linux / macOS) | Window |
| --- | --- | --- | --- |
| **compute** | CPU load (1, 5, 15 min) and core count; CPU, memory and I/O pressure; GPU utilisation, temperature, power; the hottest sensor | `/proc/loadavg`, `/proc/pressure/*`, `nvidia-smi`, `/sys/class/thermal` / `sysctl` (what it gives without privilege) | 10 min |
| **memory** | total, available, swap used; memory of each of Iyye's own processes (host, router, each model instance, Hindsight, PostgreSQL, Kev, SearXNG), by role, never by command line: resident size and, on the Spark, its GPU share (W0: a resident size leaves the GPU share out, and the GB10 reports no GPU total) | `/proc/meminfo`, `ps` and `nvidia-smi --query-compute-apps` for the PIDs the host supervises / `vm_stat`, `ps -o rss` | 10 min |
| **storage** | each real filesystem: size, free; the size of Iyye's own directories (state, models, model caches, logs, memory database, sandbox) | `statfs` on the mount list; a bounded directory walk of a fixed list, at night | 1 h; sizes daily |
| **network** | each interface: kind (Wi-Fi, Ethernet), link up or down, signal; whether a default route exists; whether the gateway answers at the link layer | `ip -j link`, `/proc/net/wireless`, `ip route`, `ip neigh` / `route`, `ifconfig`, `arp` | 10 min |
| **lan** | hosts on the local network: an id (hashed hardware address), private address, first and last seen, the owner's label | the kernel's neighbour table (`ip neigh` / `arp -an`) every 30 min; a rare active probe of the local subnet (owner decision 2: at most a few a day, one address at a time at a slow pace, never beyond the local subnet, never a port scan) | 30 min; active: a few a day |
| **peers** | each machine Iyye is configured to use (the MBP's endpoints): on the LAN or not, answering or not, since when | the neighbour table, and the status the host already has | 10 min |
| **devices** | displays, cameras, microphones, audio outputs: present or not, never their content | `/sys/class/drm`, `/dev/video*`, `/proc/asound` / `system_profiler` | daily |
| **models** | each registry model: file size, memory when loaded, load time, measured speed (prompt and generation tokens per second from its own requests) | the registry, `model_ops`, the router's timings | on load; daily |
| **rhythm** | each night's start, end and parts, and whether it ran in its window; when the owner is usually active | `energy_ledger`, the night report, `events` | daily |
| **lifecycle** (added by W0) | when the host started; what it runs under (a terminal, an SSH session, a service manager); a heartbeat; at each start, how long it was not running and whether the last run ended with a shutdown | the process's parents by program name, `kv` | at start; 1 min |

- **One source of truth.** The `machine` observation domain and `system_status` read these facets; they stop probing on their own.
- **Privacy** (as plan 0.010): hardware addresses are hashed before they are stored. Public addresses, serial numbers, host names of other machines and SSIDs are never kept. Private (RFC 1918) addresses are kept, owner-only (§7 decision 2). The lan, peers, place and people facets never reach a contact's turn.

### 3.2 History

- `self_readings` (migration): `(facet, field, at, value)` for numeric fields, one row per probe. Kept 7 days, then folded into hourly rows (min, mean, max, count) kept 90 days. About 40 fields at 10 minutes is 40,000 rows a week.
- **Recorded asleep too** (§7 decision 1): the vitals probe is cheap and uses no model. Asleep it only writes rows. It raises nothing until Iyye is awake.
- State changes that are not numbers (link down, service state, peer away, model loaded) are events with a time. `self_changes` and `model_ops` are that already. W0: `service_status` keeps only the current state, and the link is seen only at the next probe, so W2 records each change of a service's state and of the link when it happens.

### 3.3 What is normal

All deterministic, computed at the end of each night from the records, and inspectable (`/self normal`):

- **Levels and stocks** (W0). A level (memory, load, temperature, pressure) gets a baseline. A stock that only moves one way (free disk, directory sizes) gets a forecast instead: "lower than usual for this hour" is always true of it. Readings are keyed by the machine, and a new machine starts afresh.
- **Baselines.** For each numeric level: the median and spread of its hourly values over the last 28 days, by hour of the local day, weekdays and weekends apart. A reading is **surprising** when it stays outside the usual band for three probes and also passes the field's own floor (for example memory available below the band *and* below 16 GB), so ordinary noise raises nothing. A shift that lasts is one episode, open until a reading is back in the band. W0 on five weeks of 2-hourly readings: with the floor, the rule leaves the two lowest readings of the period and nothing else; without it, up to 17 episodes.
- **Regularities.** An event of one kind (the network away, a service down, a peer away, the owner active) whose start falls within the same 90 minutes of the local day on at least 5 of the last 14 days is a candidate regularity with its usual start, usual end and support. Events the host itself caused (its night's and waking's model operations: `model_ops.requested_by`) are left out: W0 found seven of ten regularities were Iyye's own doing. Local time, not UTC: the nightly gap moved by an hour in UTC when summer time ended.
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
- **A read tool**, `self_model(facet)`, in a toolkit of its own, `self` (effect `private`: the owner and Iyye's own work, never contacts; built in W4). It returns one facet as the owner's `/self` view shows it.
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
| The host was not running for hours; the night ran outside its window on most of the last 7 days (W0, the lifecycle and rhythm facets) | self-preservation | One notice with the times and what ended the run, then the pattern, not a notice a day. |
| A recurring request | agency | A proposed routine (§4.1). |
| An expected event that did not happen; a routine that failed | self-preservation or agency | A notice. |

Knowledge also changes behaviour that exists, with no new permission: background work is scheduled for hours the owner is usually away, nothing notifies about an expected event, and Iyye says in the evening when the night is not expected to fit.

### 4.1 Routines

- **Detector:** the owner made the same request (the content-stem match the recurring-question detector uses, chained: a run of alike turns is one request) on at least 4 different days of the last 14, counting only turns answered with read-only tools. The owner's messages are the evidence. W0: on the live records this finds exactly one request, the news one, nine days after it was first made; without the tools condition it also finds the owner trying a tool.
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
| **W0** (done 2026-11-09) | Spike, no behaviour. `scripts/world-spike.ts <db copy>` replays the last five weeks through the baseline, regularity and recurring-request rules. Each probe is run on the Spark and the Mac for what it returns and what it costs. | It finds the nightly network gap and the news request, and lists every other regularity it would have raised, for the owner to judge. Thresholds are set from that. Notes in `host/SPIKE-0.018.md`. |
| **W1** (done 2026-11-09) | The lifecycle, compute, memory, storage, devices, models and rhythm facets; `self_readings`; the vitals probe; `/self` views; `machine` and `system_status` read the facets. Swap on Linux. | `/self` answers "what uses the memory", "what uses the disk" and "when was I not running" from records. No new signal. |
| **W2** (done 2026-11-10) | The link, lan and peers facets; the dependency map; causes in service signals and notices. | A simulated network loss gives one finding that names it. The MBP's state says which of the two cases it is. |
| **W3** (built 2026-11-10; the week's check open) | Baselines, regularities and forecasts; their signals journal-only for a week, then acting; the confirming question. | The week's journal against the owner's judgement: no more than one unwanted signal a day. |
| **W4** (done 2026-11-10) | Investigations of surprises; `disk_usage`; `self_model`; the about-me note for Iyye's own work. | A staged memory drop is explained with cited readings. |
| **W5** (done 2026-11-11) | People cards; follow-ups in a person's usual hours. | `/person` shows the card; `/forget` leaves nothing of it. |
| **W6** (done 2026-11-11; its first live run is the owner's) | Routines. | The news request is proposed, approved, run and delivered; a skipped run is reported. |
| **W7** | Maintenance, report-only, then allowed actions. | `/maintain` figures match the disk; an allowed action is recorded with what it removed. |

**Exit gate for the plan:** over two weeks, every surprise in the records has a cited explanation or a question to the owner; the three cases in §1 are handled; notices stay under their caps; the owner marks more of Iyye's own work useful than not (`/motivation useful`).

### W1 as built (2026-11-09)

- `self/vitals.ts` (the probes), `self/readings.ts` (`self_readings`, hourly after a week, 90 days), `self/runs.ts` (`host_runs`, `nights`), `self/upkeep.ts` (`SelfUpkeep`: what is due, asleep too), migration 044, `IYYE2_SELF_VITALS_S`.
- `/self memory`, `/self disk`, `/self runs`, `/self history [field] [days]`; two more lines in the owner's about-me note (what holds the memory; this run and the week's nights).
- Memory by role follows the host's own process trees (the PIDs its supervisors hold), so no command line is matched or kept; a model instance is named by its `--alias`.
- The `machine` observation and `system_status` read `SelfUpkeep.current()`.
- One pass with every probe on the Spark: 195 ms.
- **Not in W1:** a model's measured speed (no request timings are recorded yet), the night's parts (only its start, end, window and completion), pressure, GPU and temperatures on macOS (no unprivileged source), and staleness of the new facets as a curiosity signal (W3, with the other signals).

### W2 as built (2026-11-10)

- `self/network.ts` (the probes), `self/lan.ts` (`lan_hosts`, migration 045), `self/surroundings.ts` (`SelfSurroundings`), `IYYE2_SELF_LAN` (`active` by default), `IYYE2_SELF_LAN_SWEEPS_DAILY` (3).
- **The link** is read every minute from the kernel's files (`/sys/class/net`, `/proc/net/route`; 6 ms, no process started): a way out or not, Wi-Fi and Ethernet up or down. Its changes are rows in `self_changes` when they happen. Signal, rate and whether the gateway answers: every 10 minutes. It is the facet `link`; the older `network` facet (the opaque network id the place estimate follows) is unchanged.
- **Every change of a service's state** is a row in `self_changes` too (facet `services`), within the minute.
- **The local network:** the neighbour table every 30 minutes, and the active probe (one echo request to each address of the subnet, one at a time: 253 addresses took 312 s on the Spark and found 9 hosts where the table alone had 3). At most 3 a day, 4 hours apart, awake, online, only a private subnet of /22 or smaller. A host is a hash of its hardware address, its private address, first and last seen and the days seen; `/self hosts`, `/self host <id> <name>`, `/self host <id> forget`. The gateway and the machines Iyye uses are named by Iyye itself. `/forget <person>` removes the owner's names for hosts that name the person.
- **Peers:** each machine Iyye uses is `answering`, `on the LAN, not answering`, `not on the LAN`, or unknown while the network is away, from the neighbour table and the last error (a refused connection is an answer from the machine itself). Changes are recorded.
- **Causes** (`needs`, declared in `main.ts`): Telegram, web search, the place estimate and email need a way out; each remote model needs its machine.
  - Signals: no default route is one `network_away` signal, and the services that need the network are not signalled beside it; a failing remote model's signal says which case its machine is in.
  - The `machine` observation: the loss and the return are one change each, naming what needs the network; the link's change asks for a look at once (`Observer.lookNow`) instead of within two hours.
- **Not in W2:**
  - "The internet" is never claimed to be there or gone while a default route exists (decision 3): only the certain case is a cause.
  - On macOS Wi-Fi and Ethernet are not told apart and the signal is not read.
  - A question about an unknown host is W4, and whether the nightly gap is expected is W3. Until then each night gives one finding and one notice about the network, and one finding when it is back.
- `signals.ts` changed: a new M4 trial period starts with this.

### W3 as built (2026-11-10)

- `self/expectations.ts` (`SelfExpectations`, on `self/normal.ts`'s rules), migration 046 (`self_surprises`, `self_regularities`), `IYYE2_SELF_SIGNALS` (`journal` by default).
- **Baselines** for eight levels (memory available, swap, load, memory and disk pressure, the hottest sensor, the GPU's temperature, the Wi-Fi's signal): the band of that hour of the local day from the hourly means of 28 days, weekdays and weekends apart once that bucket has 5 days, together until then, nothing before 5 days. A surprise is 4 spreads off, on the side that matters, past the field's floor, for 3 readings in a row; it is one row, open until a reading is back inside.
- **Regularities**, worked out once a day while awake, from the change records: the network away (the minute-by-minute link; before its first record, the older half-hourly probe), each service not fine (what needs the network and fails inside a network gap is the network's; what needs another machine is that machine's), each machine Iyye uses not answering, and the host not running. Model operations are not looked at at all, so nothing of Iyye's own doing can be found.
- **The owner's answer:** an unanswered regularity is the signal `regularity_unconfirmed`, and the motivations' own question path asks it (three questions a day, one at a time, not the same one twice in a week). The owner answers with `/self expected <id>` or `/self unexpected <id>`; a chat message is never taken as the answer. With either answer, what happens from an hour before its usual start to two hours after its usual end is `usual`: no `network_away` or service signal, no change in the `machine` observation. A regularity not found for four days is no longer in force; its answer is kept.
- **Reasons** (`signals()`), all from records: `self_surprise`, `regularity_unconfirmed`, `problem_pattern` (a regularity the owner called not intended: one standing reason), `expected_missing` (three hours past an expected one's usual start with no occurrence), `disk_filling` (a line through 14 days of free disk reaches zero within 30 days), `nights_outside_window` (most of the week's nights), `nights_too_long` (3 of the last 5 outlast the window), `not_running` (the run before was killed and nothing ran for an hour or more).
- **Journal first:** only the question acts. `self_surprise` and `expected_missing` have no action yet (W4), and the others are recorded with each sample but neither count nor open anything until `IYYE2_SELF_SIGNALS=act` (a new M4 trial period).
- `/self normal` shows the bands, what is unusual now, the regularities with their answers, and the forecast; the owner's about-me note says what is unusual now and what is usual by the owner's own answer.
- On a copy of the live records (2026-11-10): one regularity, "the network goes away around 23:34 and is back by about 08:02 (5 of the last 14 days)"; no baseline yet (W1's readings are a day old); no forecast yet.
- **Not in W3:** the forecast of memory left for the night's model (the baseline of available memory covers it for now).
- `signals.ts`, `tracker.ts` and `actor.ts` changed: a new M4 trial period starts with this.

### W4 as built (2026-11-10)

- **`tools/self.ts`, the `self` toolkit** (effect `private`: the owner and Iyye's own work, never contacts; always declared in the owner's sessions, last): `self_model(facet)` with the facets memory, disk, compute, network, runs, normal and models, and `disk_usage`, which measures Iyye's directories now. It is its own toolkit rather than part of `monitor`, so Iyye's own work has it whether or not `IYYE2_MONITOR_BACKGROUND` is on. The facet is a word that only chooses among the fixed ones; an unknown word gets the list back as the result.
- **For an investigation, `self_model("memory")` compares:** what each of Iyye's processes holds and usually holds (the mean of the last seven days), which one differs most, and what programs that are not Iyye's hold in all.
- **A surprising reading is investigated** (`self_surprise` → an opportunity of domain `machine`, at most 2 a day; the 0.007 S5 loop runs it in a session with `self`, `machine`, and `monitor` and the sandbox when Iyye's own work has them). Its answer must cite at least one figure the tools returned that the reading itself did not hold, and no figure they did not return.
- **Exit check, with the real model** (`scripts/self-investigate-smoke.ts`, gemma-4-E4B on a scratch router on the Spark, staged records: 9 GB available because a model never loaded before holds 63 GB): 8 of 8 investigations were accepted at the first step, about 4 s each, and every answer named the new model with its 63.0 GB. The first run was 1 of 5, and showed three things, now fixed: the model restates the reading in every answer (which the first rule refused), it gave up on the tool after one facet the schema rejected, and it needed the report to say plainly which process differs most.
- **Two more questions the owner answers by command** (through the motivations' question path, like a regularity):
  - a machine Iyye uses that has not answered for 3 days: `/self peer <name> away` (its silence is no trouble until it answers again; `service_down` for what needs it is not signalled) or `/self peer <name> back`;
  - a host that is new to the local network (first seen after the first two days of records) and was there on 3 days: `/self host <id> <name>` or `/self host <id> forget`. The hosts found in the first two days are listed and never asked about.
- **The note for Iyye's own work** (`SelfModel.aboutOwnWork`, `PiConversations.backgroundNotes`): hardware, what its processes hold, this run, what is unusual and usual, the link. No place, no people, no host of the local network, no other machine; not in a plan's steps.
- **Decision 8** (`kernel/plans.ts`): a plan a person proposed that nobody approved, three days past its first dated step, is asked about once ("… /plan approve <id> … otherwise I will drop it in 2 days") and lapses two days later as abandoned, "not approved, and its date passed". Plans with no dated step wait as before.
- `actor.ts` and `investigations.ts` changed: a new M4 trial period starts with this.

### W5 as built (2026-11-11)

- `people/card.ts`: `personCard` works a card out from records each time it is read (13 ms for the three people on a copy of the live records); nothing is stored.
- **On a card:** who they are to the owner (the owner's statement only); messages and days in the last 30, first and last; when they usually write (the hours between the tenth and ninetieth percentile of 60 days of messages, the day counted from 04:00; nothing under 8 messages on 3 days); weekdays or weekends when four fifths fall there; the scripts they write in, by message; reminders waiting, open plans, the last follow-up and how it ended, Iyye's own messages to them; the surest six beliefs the ledger holds about them, as the owner reads them; and what is missing (no stated relation, no email address, a name known only in another script than they write in).
- **`/person <person>`** shows the card above the notes and the relationship hypotheses. The owner's about-me note has one line a person for the six most recent.
- **A follow-up waits for an hour the person usually writes in** (`ActorDeps.usualHour`), inside `IYYE2_SOCIAL_HOURS`. When too little is known of them, or none of their usual hours is a social hour, the social hours alone decide. Checked again right before sending.
- **`/forget`:** a card reads nothing from before the person's last forgetting, so the times of redacted messages do not come back as "usually writes …".
- Hours are the host's local hours: where a person is, Iyye does not know.
- **Not in W5:** gaps on a card are shown, not asked about (the relation is asked already, plan 0.010 M1; nobody is asked for an email address).
- `actor.ts` changed: a new M4 trial period starts with this.

### W6 as built (2026-11-11)

- **The detector** (`motivation/detectors.ts`, `recurringRequests`): the owner's turns of the last 14 days that were answered with read-only tools alone, grouped by likeness (chained), on at least 4 different local days. On a copy of the live records it finds one: 11 days of 14, on Telegram. It is the agency signal `request_recurring`; a routine alike that is proposed, running, or was dropped in the last 30 days silences it.
- **The proposal** (`MotivationActor.proposeRoutine`, no model call): a plan of Iyye's with one `routine` step: the owner's latest wording as the task, the first quartile of the days' first asks rounded down to the quarter hour as the time (08:45 on the live records), daily (weekdays or weekends when every day was one), and the chat the request was last made in as the route. It waits for `/plan approve` like every plan of Iyye's, lapses unapproved after 3 days, and `/plan time <id> HH:MM` moves it. Only Iyye can propose one (`plan_propose` cannot name it), and at most `IYYE2_ROUTINES_MAX` (3) are approved at a time.
- **A run** (`kernel/routines.ts`, `RoutineRunner`; `routine_runs`, migration 047): one background step a day at its time, in a session under the web investigations' scope (the read-only toolkits and the web on Iyye's own daily web budget; never `messaging`). Its answer is accepted only when it cites at least one URL and every URL it cites was returned by the web tools in that session; up to 3 tries, then the day has failed.
- **Delivery** is the host's: `Outbox.sendOwn` on the plan's route, labelled "Your routine, HH:MM (…)". A reply in that chat finds what was sent in a request-local `<routine>` note for 12 hours; the text is not stored in memory.
- **A day that cannot run** (asleep, the network away, the host not running) waits up to 3 hours past its time, then is a `skipped` row with its reason; the next delivery says which days were not done and why, once.
- **Silence:** after 7 deliveries in a row with no message from the owner in that chat within 3 hours of each, Iyye asks once whether to keep it.
- A routine never completes its plan; `/plan cancel` ends it. `/forget <person>` removes what a routine sent that names the person.
- **Not in W6:** a run with the real model and the real web has not been made here; the first one after the owner's approval is the live check. The routine's message is not rephrased by the voice.
- `detectors.ts`, `signals.ts` and `actor.ts` changed: a new M4 trial period starts with this.

## 7. Owner decisions (accepted 2026-11-09)

The owner accepted every recommendation below, except decision 2: the LAN may be probed actively as well, rarely. Decision 9: this plan goes ahead now. Decision 10: the owner moved the host into `tmux` on 2026-11-09.

| # | Decision | Recommended |
| --- | --- | --- |
| 1 | Record vitals while asleep (rows only, nothing raised until awake)? | Yes. The night is when memory is tightest and when the network goes away. |
| 2 | The LAN: read the kernel's neighbour table and keep private addresses (owner-only) with hashed hardware addresses? Active discovery (ping, mDNS)? | Passive: yes. Active: no for now. **Owner: active too, as rare probes.** |
| 3 | Infer "the internet" from the Telegram poller and web search, with no new outbound check? | Yes. |
| 4 | A regularity counts as expected only after the owner confirms it? | Yes. The alternative (automatic after some weeks) would teach Iyye to ignore a real fault. |
| 5 | Routines: always approved by the owner once, then run unattended; at most 3; the owner's requests only? | Yes. |
| 6 | Maintenance: report-only first; which actions may later run on their own? | Report-only first; decide per action from W7's figures. |
| 7 | Iyye's own web sessions get an about-me note without place, people and LAN? | Yes. |
| 8 | A plan a person proposed whose dated first step passed more than 3 days ago: ask the owner once, then let it lapse? Today such a plan keeps agency's need at 0.89 (four plans wait for approval). | Yes. |
| 9 | Order: this plan before CH1b (plan 0.009) and N2 (plan 0.017)? | The owner's call. W0–W2 touch neither. |
| 10 | (From W0.) How the host is run. Today it ends every night with the owner's SSH session, so no night runs in its window and nothing is answered or sent for about 8 hours. | Run it under a service manager that outlives the login (a systemd user service with lingering), or at least in `tmux`. A wired network, or Wi-Fi left on at night, would keep Telegram reachable too. The owner's setup and the owner's call; nothing in this plan changes it. |

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
| `IYYE2_SELF_VITALS_S` | `600` | the vitals probe's period (built, W1) |
| `IYYE2_SELF_LAN` | `active` | `off`, `passive`, `active` (passive plus the rare probes; built, W2) |
| `IYYE2_SELF_LAN_SWEEPS_DAILY` | `3` | active probes of the subnet a day (built, W2) |
| `IYYE2_SELF_SIGNALS` | `journal` | `journal`: W3's new reasons are recorded only; `act`: they count and notify (built, W3) |
| `IYYE2_ROUTINES_MAX` | `3` | routines approved at a time (built, W6) |
| `IYYE2_MAINTAIN` | `report` | `off`, `report`, `allowed` |
