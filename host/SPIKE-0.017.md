# Spike 0.017 N0 — nightly decision learning (2026-10-27)

Plan: `iyye_2_0_017_plan.md` §4 N0. Measured on the Spark beside the live host (459e143, day models gemma-4-26B and gemma-4-E4B loaded, the live Kev on 8188), by hand, between 16:23Z and 16:47Z.

- Everything ran in `~/.iyye2/spikes/n0` (0700): a copy of `decision-worker/` with the Kev clone and venvs linked in, so the checkout stayed untouched. Nothing of the host was restarted or reconfigured.
- **It did affect the live machine:** it used the shared GPU and memory, the replay runs evicted the page cache, and swap grew from 6 to 13 GB and was still 13 GB afterwards (§3).
- No message arrived on any channel in that window. One owner-console turn, at 16:25Z, came before the training.

## 1. The baseline from the journal (no model call)

`node scripts/decisions-baseline.ts <copy of iyye.db>` opens a copy read-only (`sqlite3 -readonly ~/.iyye2/iyye.db ".backup <copy>"`).

- **One revision answered everything:** all 647 answered owner and `iyye` decisions are `jaredpalmer/kev-4b@6cfce5c2` at T 2.406. Two early rows lack the LoRA rank (written before migration 015); it is the same revision.
- **Owner labels in owner and `iyye` scope (decision 1): 11.** A further 8 are on contacts' decisions, which never train.

| Role, question | Labels | Kev at its band | Brier | Majority class |
| --- | --- | --- | --- | --- |
| memory_salience worth_remembering | 6 (2 yes · 4 no) | 2/3 agree, 3 unsure | 0.170 | 67 % |
| observation_importance worth_telling | 2 (0 · 2), 1 answered | 0/1, 1 unsure | 0.245 | 100 % |
| reply_review claims_arranged | 3 (0 · 3) | 3/3 | 0.042 | 100 % |

**No baseline can be stated on these:** too few labels, and one class or nearly one class each. The queue (N1) exists for this.

**The weak labels, for orientation only.** They can never be a test set or a verdict.
- memory_salience against "Hindsight kept something": 206 labels, 79 % yes. Kev agrees on 114 of 144 at the band, 62 are unsure, Brier 0.304.
- reply review claims_arranged against the ledger: 191 of 197, Brier 0.042. The ledger fact is not a claims label (plan 0.006 C2).
- toolkit selection, used toolkits only (positives only): web 15/15, machine 1/4.

## 2. A second Kev beside the live one (measured with `predict.py`)

The released checkpoint was scored again in the serving venv on the 11 owner-labelled rows, exported by `decisions-baseline.ts --export`.

| What | Result |
| --- | --- |
| Reproduces the journal | max \|Δp\| **0.0035** over 10 journaled answers. The journal can be re-scored offline. |
| Load | 61 s |
| Memory | peak CUDA **8.8 GB**; resident 9.1 GB; system memory used rose by about 14 GB at peak, including load transients |
| Latency | median **73 ms** per one-question decision (first call 1.27 s). Not comparable with the live journal's figures (memory salience median 159 ms, reply review 715 ms for its 5 questions), which include HTTP and five-question states. |

**Decision for N5:** a second, personal instance fits. It costs about 9 GB for as long as it is loaded.

## 3. Training with Kev's replay suite

**Provisioning (decision 6):**
- `decision-worker/provision_suite.py` copied the manifest and the calibration and development partitions from the clone.
- It fetched the 12,576-record training partition from `jaredpalmer/kev-suites@cc4bac80` through Kev's own `load_split`, which checks the sha256 and the record count. That took 9 s; no token was used.
- The result is in `~/.iyye2/decisions/suites/evals/v7/decision-v7`, read-only, with `provisioned.json`.
- **It is the released model's own suite:** its manifest sha256 `a8f50e48…` equals kev-4b's `suite_sha256`. kev-4b itself was a delta trained with `--suite evals/v7/decision-v7 --replay 4000`.

**`train_candidate.py`** gained `--suite <dir> --replay N`, which kev.train draws from offline and the manifest records with the suite's hash, and `--max-state`.

**Three 20-step candidates from kev-4b** were trained on the 24-record synthetic fixture (batch 2 × accum 4, so 160 records seen each).

| Candidate | Wall | Peak CUDA | System memory used, peak |
| --- | --- | --- | --- |
| fixture only | 58 s (66 s with the wrapper) | 29.8 GB | 101 GB of 121 |
| fixture + `--replay 4000` | 167 s (202 s) | **53.5 GB** | **122.8 GB**: the page cache was evicted and swap grew from 6 to 13 GB |
| fixture + `--replay 96 --max-state 1024` | 76 s (100 s) | **50.4 GB** | 115.7 GB |

**The live host survived both peaks.** The kernel log has no OOM entry since the runs, and every live process (host, router, both llama-servers, Kev, Hindsight) has been running since before them. The second replay run was made after the first had already reached the ceiling, which it should not have been. No further replay runs were made.

**The cause is not state length:** no replay record exceeded 1,024 tokens, so nothing was dropped. The suspect is the suite's many-option questions: banking77 has 77 options, dbpedia14 has 14, against the fixture's 6 at most.

**Scored raw (T 1) by the serving venv**, on a quarter of decision-v7's development partition (301 records, 367 questions) and on the fixture (72 questions):

| Candidate | Development: acc · Brier · ECE | Moved vs parent (development) | Fixture acc | Moved vs parent (fixture) |
| --- | --- | --- | --- | --- |
| kev-4b (parent) | 0.883 · 0.178 · 0.067 | | 0.778 | |
| fixture only | 0.883 · 0.183 · 0.074 | max \|Δp\| 0.37, 7 flips | **0.972** (memorized) | 0.94, 14 flips |
| + replay 4000 | 0.886 · 0.182 · 0.077 | max \|Δp\| 0.46, 9 flips | 0.778 (unchanged) | 0.12, 0 flips |

## 4. Calibration

**Fitting a temperature costs nothing:** `kev.metrics.fit_temperature` with Kev's release settings (`TEMPERATURE_FIT`: micro mean NLL, 121-point grid) took 116 ms on 367 rows. The parent's fit on this in-distribution subset was 2.24; the released value is 2.41. The cost is scoring the validation rows: about 60 s to load plus about 0.1 s a decision.

**`scripts/calibrate_checkpoint.py` is the wrong tool here.** It is the same fit, plus three properties that rule it out:
- It **writes the temperature into `head.pt`**, which voids a candidate's manifest. Run against the cached pin, it would silently change the live Kev's temperature at its next restart.
- It refuses rows it cannot place in a Kev suite, so Iyye's rows would need `--allow-in-distribution`.
- It reads `kev.benchmark` rows.

**For N4:** fit with `kev.metrics.fit_temperature` on the validation split and record the temperature in the bundle's registry entry, never in `head.pt`. To verify in N4: how one Kev instance is served at a given temperature. `predict.py` passes `LoadOptions(temperature=…)`; whether `kev.serve` takes a per-instance override (Kev documents `KEV_TEMPERATURE`) is not yet checked.

## 5. What this changes in the plan

1. **The memory gate is the first constraint, not a formality.**
   - A replay run reached 50–54 GB of device memory, and with the day models loaded the machine ran out of headroom.
   - N3 trains only at night, after `restForNight` has unloaded the chat models.
   - It must check available memory against a measured peak plus a margin before starting, and must not start otherwise.
   - Before N3: find what drives the peak. If it is option count, filter replay records by option count or branch tokens, or use kev.train's `--pass_tokens_max` (Qwen3.5 is hybrid). Then measure again, with the day models unloaded.
2. **Size the replay mix to Iyye's own data, not to the released recipe's 4000.** With 4000 replay records, a 20-step run saw about one of Iyye's examples and learned nothing from them. Start at about 2–4 replay records per own example, then tune on validation.
3. **Movement needs a noise floor before it can be a gate.** Replay alone moved development answers up to 0.46 with 9 flips in 20 steps, with accuracy unchanged. Each run differs slightly, and 367 questions give about ±3 pp. A regression gate compares against intervals from repeated runs, as plan §3.4 says (bootstrap), never against a single parent read.
4. **Labels:** see §1. N1's queue is built (owner labels per question, `decision_labels`, migration 043), so the plan's `decision_datasets` becomes migration 044.

## 6. Artifacts

- `~/.iyye2/spikes/n0/`, 0700, contains:
  - the three candidates (149 MB each, never pointed at);
  - the exported labels (owner text);
  - the predictions;
  - `analyze.py`.

  Delete it when N2 no longer needs it.
- `~/.iyye2/decisions/suites/evals/v7/decision-v7/` is provisioned and kept.
- The training journal `~/.iyye2/decisions/training/journal.jsonl` records the three runs.
