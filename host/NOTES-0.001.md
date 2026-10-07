# Plan 0.001 M8 — notes from real use

- Period: 2026-10-02 to 2026-10-07, six days of the owner's real use (closed by the owner on 2026-10-07), on the owner's Mac (128 GB), with the real llama.cpp router and the Telegram bot. Figures are from the live database (read through a copy).
- Later increments (0.002–0.011) were built and restarted into during these days, so this is a record of the live system, not of 0.001 alone.

## Traffic

- 85 admitted messages: 34 from the web chat and 51 from Telegram, from the owner, the owner's two linked Telegram accounts and Jacob. No message was dropped.
- 110 actions delivered. **No `unknown` actions** and no terminal failures.
- 77 reply jobs settled and 8 failed: 4 on 2026-10-03 and 4 on 2026-10-05. The 2026-10-05 failures are the incidents below; both are fixed.

## Models

| Operation | Model | Done | Mean time |
| --- | --- | --- | --- |
| load | gemma-4-26B | 13 | 8.3 s (registry `startup_s` 30) |
| load | qwen38-27b-tak | 7 | 4.7 s (registry 10) |
| load | gemma-4-E4B | 5 | 3.4 s (registry 10) |
| unload | any | 14 | 0.5–0.8 s |
| router start / stop | — | 8 / 5 | 0.2–0.3 s |

- `/use` switches and load/unload were used many times (26B, 31B and qwen38-27b-tak tried as chat models; 26B kept for web and Telegram, E4B for memory and background).
- Failed operations: one 26B load that "did not finish loading within 90 s", which was the Mac sleeping during a wake-time load (2026-10-05). Two router stops interrupted by a host stop.

## What broke, and what it led to

- **The chat model not loaded after a night on battery** (2026-10-05): a wake-time load failed while the Mac slept, and Telegram turns failed all morning. Fixed by model self-healing (a selected model is reloaded by day; jobs wait instead of failing) and by `AwakeStopwatch`: Node's monotonic clock counts system sleep on macOS, so load deadlines now count awake time only.
- **A runaway turn** (2026-10-05): 125 validation-rejected `web_search` calls in 1.5 h. Fixed by the turn guard (12 results, or the same failure 3 times, then one recovery step), shortened tool arguments instead of schema limits, and a per-turn energy cap.
- **Meaningless long-term memories** (2026-10-06): Iyye's verbatim replies and its narration became "facts" and observations. Fixed: replies are extracted as dated "Iyye told …" facts, no observations from Iyye's or its probes' words, machine findings and day summaries stay in STM. This led to plan 0.011 (the fact ledger).
- **Recall misses** (2026-10-06): "Where do we live?" scored 0.01 against "The user resides in …". Fixed by rewriting the question for the reader and merging banks by relevance.
- **Telegram "retrying" for eight hours** (2026-10-06/07) with the cause only in the console. It led to `service_status` (0.010 M1), which now records each service's state, since when, and its last error.

## Not measured

- RAM per model and turn latency were not recorded systematically. The router logs have per-request timings, and plan 0.011's F0 measured E4B at ~4 s per extraction with the 26B loaded alongside.
- Prompt-cache reprocessing for hybrid models (`--ctx-checkpoints`) and the per-scope Pi session cost did not show up as problems.
