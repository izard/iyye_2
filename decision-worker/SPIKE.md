# K0 spike — Kev on the owner's Mac (2026-10-03)

## Setup
- **Install** (owner approval 2026-10-03): `uv sync --frozen --extra serve --python 3.13` in `kev/` (clone @ `84847f0`, lockfile untouched, `git status` clean). Python 3.13.15, mlx-lm 0.31.3, transformers 5.17.0, torch 2.8.0.
- **Checkpoint:** `jaredpalmer/kev-4b` @ `6cfce5c2fa4b4bd64026336ab649c5ca78857d52` (LoRA r16, temperature 2.41) on `Qwen/Qwen3.5-4B-Base` @ `1001bb4d826a52d1f399e183466143f4da7b741b`. Downloaded once into `~/.iyye2/decisions/hf` (8.8 GB); every later start runs with `HF_HUB_OFFLINE=1`.
- **Serving:** `kev/.venv/bin/python -m kev.serve --run jaredpalmer/kev-4b --host 127.0.0.1 --port 8188` with `KEV_API_KEY` from `~/.iyye2/decisions/secrets/kev_api_key` (0600) and `HF_HOME` above. It serves on `mps via mlx (bfloat16)`.
- **Isolation:** the owner's host was running (5100, 8180, 8185–8187) and was not touched. The contention test used its own llama-server on 8183. Records were read with `sqlite3 -readonly`. No Modal, no Hub push.

## Results

| # | Question | Result |
| --- | --- | --- |
| 1 | Load | **7 s** from the local cache, offline. Peak RSS **15.9 GB** during load (the LoRA merge), **8.7 GB** steady after load, **10.1 GB** after use (prefix cache, 4 states). Matches Kev's notes (15.87 GB merge peak). |
| 2 | Latency, idle | First call after load 2.9 s (warm-up). Then **110–480 ms** per call (one question on a short state). Two questions on a 536-token state: **713 ms new, 190 ms cached**. |
| 3 | Latency during a llama.cpp generation (gemma-4-E4B, 600 tokens, same GPU) | Kev **330–420 ms** (vs 110–230 ms idle; first call 873 ms). The generation's speed was unchanged: 22.8 tok/s with Kev calls, 22.7 alone. Small Kev calls barely disturb generation, and roughly double in latency themselves. |
| 4 | Role "worth remembering?" (`noul`), 15 turns: 6 night-smoke turns with Hindsight outcomes, 6 hand labels, 3 live episodes | **Discriminates, but the 0.5 cut-off is wrong for it.** Small talk 0.03–0.22 ("Thanks!" 0.03, "What's 2+2?" 0.09, "Hello Iyye, this is Alex." 0.22); facts 0.32–0.74 (peanut allergy 0.74, Russian turns 0.52 and 0.55, the family note 0.43). At 0.5: 9/15 agree. At a cut-off of about 0.27 all 15 separate. The facts cluster near 0.5, so a calibrated threshold and abstention band are needed, fitted on more data than this. |
| 5 | Role "promises a future action?" (`noul`), 6 labelled replies | **6/6.** "I'll remind you tomorrow" 0.90, "I'll keep an eye on the disk space" 0.79, the 2026-10-02 "I'll flag" reply 0.68; non-promises 0.06–0.13, including "I can't set reminders yet" 0.13. |
| 6 | Reply review on the 8 live delivered replies (message + reply as a JSON state) | The incident reply scored **promise 0.83**; the other seven 0.03–0.20. The "how well does it answer" `score` (0–2) ranged 1.16–1.79: little spread, not useful yet. |

## Go / no-go (plan §3.2)
- **Reply review, "promises a future action": go** for shadow mode. Clean separation on every example, including the real incident.
- **Memory salience: go for shadow, not yet for acting.** It ranks small talk below facts, but its scale needs a fitted threshold; shadow mode against Hindsight's `completed`/`completed_empty` outcomes is exactly how to collect that data.
- **"How well does it answer": drop** for now (no useful spread).
- **Checkpoint:** kev-4b fits (about 9–10 GB resident next to the day's ~55 GB of chat models; 16 GB peak only while loading). kev-0.8b not needed.
- **Resident by day:** yes. Loading takes 7 s, but resident costs little and avoids a 16 GB load spike per call. At night the chat models are unloaded anyway.
- Not done: the local training round trip. The owner deferred training to the nightly learning phase (plan 0.003 §8.3).

The probe script is `decision-worker/kev-probe.mjs`. It reads `~/.iyye2/iyye.db` read-only and calls Kev on 8188.
