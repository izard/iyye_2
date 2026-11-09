# Spike 0.018 W0 — what is normal, on Iyye's own records (2026-11-09)

Plan: `iyye_2_0_018_plan.md` §6 W0. Measured on the Spark beside the live host (777d1af), and the probes also on the Mac.

- Everything ran in `~/w0-spike` (0700, deleted afterwards): a copy of the host's code with `node_modules` linked, and a backup of the database (`sqlite3 -readonly ~/.iyye2/iyye.db ".backup <copy>"`). The live database was read once, read-only. Nothing of the host was stopped, restarted or reconfigured. No model was called.
- The rules are pure functions in `src/self/normal.ts` (`test/self-normal.test.ts`). Nothing in the host calls them yet.
- `node scripts/world-spike.ts <db copy> [--tz <zone>] [--out <dir>]` replays them over the records and prints figures and word stems only. `node scripts/world-probes.ts [--du <dir>]` runs each candidate probe once.
- The records cover 36 days (2026-10-04 to 11-09): the Mac until 10-10, the Spark since.

## 1. The main finding: Iyye is not running at night

The spike was meant to find the nightly network gap. It found that, and behind it something larger.

- **The host has not run through a single night on the Spark.** On all 30 nights since 2026-10-10 there is a stretch with no awake charge, no motivation sample, no observation, no decision and no model operation at all: from between 23:01 and 00:37 until between 07:09 and 12:50 local, a median of 8.2 hours (one of 35 hours across 10-31).
- **The cause is how the host is started.** It runs in the foreground of an SSH session from the owner's Mac, with its output on that session's terminal.
  1. The router's Wi-Fi goes off at night. NetworkManager on the Spark, 2026-11-08: `23:12:14 link timed out … ssid-not-found`, and `07:11:01` the network is back. The Spark's Ethernet port has no link, so Wi-Fi is its only network.
  2. About 15 minutes later the SSH session times out and closes (`23:28:13 session closed … session-6365.scope: Deactivated successfully`: no process of it was left). The host's last awake charge that night is 23:28.
  3. The next morning's first charge comes 5 minutes after the owner's next login (07:39:46 → 07:45), the first motivation sample 10 minutes after: a fresh start, not a process that was paused.
  - The session's end and the last charge match to within one 5-minute tick on each of the six nights compared (11-02 to 11-08).
- **The machine itself does not sleep**: 0 seconds suspended in 30.5 days of uptime. So the self model's sleep facet is right to say "no sleeps", and it has nothing that says "I was not running".
- **No night has run in the rest window on the Spark.**

  | Nights completed | on the Mac (9) | on the Spark (29) |
  | --- | --- | --- |
  | ended between 01:00 and 07:00 | 5 | **0** |
  | ended by day (07:00–20:00) | 3 | 22 |
  | ended in the evening | 1 | 7 |

  Every Spark night is a catch-up ("short-term memory is more than a day old"), lately at 09:30 or 11:45, while the owner is active.
- **What it costs:** nothing is answered or delivered between about 23:30 and the morning start (a reminder due at 07:00 waits); the night's memory work runs in working hours; and the adenosine calibration assumes Iyye is awake about 24 hours a day (it is awake about 15).
- **What Iyye reported of this:** "Telegram is retrying", as a new finding each time (five times on the Spark).

This is the owner's setup and the owner's decision (plan §7, decision 10). It is also the best example of what the plan is for: every record needed to see it was already there.

## 2. Regularities (`findRegularity`: 5 of the last 14 days, starts within 90 minutes)

Replayed at noon of each day once 14 days of records existed (24 evaluation days).

| Series (events) | Found | Held | Now |
| --- | --- | --- | --- |
| the network away (21) | first day possible, 10-18 | 24/24 | starts 23:39, back by 08:02, 5 of 14 days |
| no awake charge for over 1 h (39) | 10-18 | 24/24 | 23:34 to 08:30, 12 of 14 days |
| the owner's first message of the day (38) | 10-18 | 23/24 | 08:51, 6 of 14 days within 50 minutes |
| the night's unload and waking's load of gemma-4-26B (39 each) | 10-18 | 24/24 | 11:44 and 11:45, 6 of 14 days |
| the same for qwen35-4b-tak, gemma-4-E4B (memory, waking) | 10-19 to 11-07 | 4 to 10 of 24 | |
| Telegram not fine, from the 2-hourly machine observation (10) | not at 5 days / 90 min; found at 4 days, or at 120 min | | |
| the decision service not fine (3), a turn failed (9), models the owner loaded by hand | never | | |

- **The rule works as set.** It found the network gap and the stretch of not running on the first day it could, across the end of summer time (the gap's start moved from 21:3x to 22:xx UTC and stayed at 23:xx local).
- **The network gap is seen on fewer days than it happens** (5 of 14): the self model probes the network every 30 minutes and the host is usually gone within 15 minutes of the Wi-Fi. W2 must record the link's changes when they happen, not at the next probe.
- **Most of what it finds is Iyye's own doing.** Seven of the ten series that ever gave a regularity are model operations of Iyye's own start, night and waking. A regularity must not be raised about an event the host itself caused. `model_ops.requested_by` already says who asked.
- **Service states have no history.** `service_status` keeps only the current state, and the 2-hourly observation places a start to within two hours, too coarse for a 90-minute rule. W2 must journal each change of state.
- Settings: 4 days instead of 5 adds only Telegram; 7 days keeps the network, the not-running stretch, the night's model operations and the owner's first message. **5 of 14 within 90 minutes stays.**

## 3. Baselines (`surpriseEpisodes`, low side, on the machine observations)

304 readings, one every 2 hours.

| Field | Setting | Episodes in 36 days |
| --- | --- | --- |
| memory available (6.3 to 76.2 GB, median 55.2) | 3 spreads, 1 reading, no floor | 17 |
| | 4 spreads, 3 readings, no floor | 1 (10-22: 50.9 GB against a usual 63.7) |
| | 4 spreads, 1 reading, floor below 16 GB | 2 (10-26: 14.5 GB; 10-27: 6.3 GB, the day of the N0 training runs) |
| | 4 spreads, 3 readings, floor below 16 GB | 0 |
| free disk | any setting, no floor | 8 to 16 |
| | any setting, floor below 200 GB | 0 |

- **The floor is what keeps it quiet**, and the two episodes it leaves are the two lowest readings of the period (6.3 GB on the day of plan 0.017's N0 training runs; what took it to 14.5 GB the day before is not recorded).
- **Three readings in a row cannot work at 2 hours**: both real episodes were shorter than 6 hours. At the 10-minute vitals probe three readings are half an hour. **4 spreads, 3 readings, a floor per field** is the starting setting for W3, to be confirmed on a week of 10-minute readings (W3 runs journal-only first).
- **A baseline suits a level, not a stock.** Free disk only falls, so "lower than usual for this hour" fires for ever. Fields are of two kinds: levels (memory, load, temperature, pressure) get a baseline; stocks (free disk, directory sizes) get a forecast.
- **A change of machine must reset it.** The series holds the Mac's readings (325 GB free disk) and the Spark's (3,300 GB). Readings are keyed by the machine, and a new machine starts a new baseline.
- **A lasting shift is one episode.** At 3 spreads a step down around 10-21 (its cause is not recorded) counted as six daily episodes until the baseline caught up. An episode stays open until a reading is back in the band; a reading the rule cannot judge does not close it.

## 4. Forecasts

- Free disk on the Spark: −15.1 GB a day over the last 14 days, 3,098 GB free: full in about 202 days. Far from the 30-day limit, and the rule gives a sensible figure.
- The night's length cannot be forecast from these records: nights are not recorded as spans. W1 records each night's start, end and parts (the rhythm facet).

## 5. Recurring requests

313 owner turns; 78 used a tool, 42 only read-only tools.

| Rule | Requests found |
| --- | --- |
| alike on 4 days of 14, any turn | 3: the news request, and two groups of the owner trying the thinking model |
| the same, only turns answered with read-only tools | **1: the news request** |

- **The one request:** 13 turns on 12 days of the last 14, all on Telegram, all answered with `web_search` and `web_fetch`, first asked between 08:45 and 17:06, usually in the morning. The rule would have proposed it on 2026-10-22, nine days after the first.
- **The tools filter is what makes it precise.** Trying a tool (`ask_thinking_model` has an effect) is not a routine, and neither is a greeting that needed no tool.
- **Likeness must chain.** Matching every turn against one seed split the request into three groups ("morning … news" and "good morning … today"). Linked groups (a chain of alike turns is one request) give one.
- The texts are in the spike's output file only; nothing here quotes them.

## 6. The probes

Each run once; cost in milliseconds.

| Probe | Spark | Mac | Notes |
| --- | --- | --- | --- |
| load, pressure (`/proc`) | 0 | 0 (load only) | no pressure figures on macOS |
| GPU: utilisation, temperature, power (`nvidia-smi`) | 32 | — | **memory is "N/A" on the GB10** (unified memory) |
| GPU memory per program (`nvidia-smi` + `ps`) | 82 | — | 22 with one `ps` for all |
| thermal zones, hwmon sensors | 15 | — | 7 zones, 11 sensors |
| memory, swap | 0 | 7 | the Spark has 16 GB of swap, never recorded |
| Iyye's own processes by role (`ps`) | 12 | 73 | |
| filesystems (`statfs`) | 0 | 8 | macOS lists one volume three times: keep `/` and `/Volumes/*` |
| interfaces, Wi-Fi signal (`ip`, `iw`) | 6 | 8 | `/proc/net/wireless` is empty; `iw dev … link` gives −59 dBm, 865 Mbit/s |
| default route, the gateway's link-layer state | 7 | 2 | |
| neighbour table | 3 | 4 | 3 hosts on the Spark, 13 on the Mac, all private addresses |
| displays, cameras, sound | 0 | 378 | `system_profiler`: daily, not periodic |
| what the process runs under | 36 | 13 | parents by program name: `bash, sshd` |
| sizes under `~/.iyye2` (`du`) | 149 | | 32.3 GB: voice 19.6, decisions 10.6, memory 1.4 |
| **all periodic ones together** | **193** | **106** | about 130 with one `ps`; under the 200 ms limit |

- **What uses the memory, answered for the first time.** On the Spark a process's resident size leaves out its GPU share: the three model instances show 11.5 GB resident and 39.5 GB on the GPU; the decision service 2.6 GB and **15.6 GB**; long-term memory 1.9 GB and 0.8 GB. Both figures are needed, joined by process.
- Nothing printed a hardware address, a host name or a network name.

## 7. What changes in the plan

1. **A lifecycle facet** (new, W1): when the host started, what it runs under (a terminal, an SSH session, a service manager), a heartbeat, and at each start how long it was not running and whether the last run ended with a shutdown. Two self-preservation signals come from it: "I was not running for N hours" and "the night ran outside its window on N of the last 7 days".
2. **Changes are recorded when they happen** (W2): the link's state and each service's state, as events with a time.
3. **No regularity about Iyye's own doing** (W3): events the host caused are left out.
4. **Levels and stocks** (W3): a baseline for the first, a forecast for the second; readings keyed by machine; a lasting shift is one episode.
5. **GPU memory per process** joins the memory facet (W1); the GPU's own memory figure does not exist on this machine.
6. **Requests chain, and need read-only tools** (W6).
7. **Decision 10** (new): how the host is run.

Thresholds kept: 5 of 14 days within 90 minutes; 4 spreads, 3 readings and a floor per field; 4 days of 14 for a request.
