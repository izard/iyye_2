# Decision training on the DGX Spark — infrastructure (2026-10-10)

The groundwork for Stage 4 (HLD §10.3–10.5, §14): a training environment, a bounded candidate trainer, an artifact check and a round-trip smoke, measured on the Spark. **Nothing here trains on Iyye's own records, runs on a schedule, or activates anything.** The dataset policy, splits, calibration, evaluation gates, the registry, NightWork/DeviceSlot admission and promotion are still to be planned (Stage 4); plan 0.009 and Stage 4 start only after the 0.013 integrity gate.

## Pieces

| File | Runs in | What it does |
| --- | --- | --- |
| `train-env.sh` | the shell | Builds `iyye_2/kev-train/.venv` (untracked) from `kev-train-linux-aarch64.lock`; `--resolve` re-resolves and rewrites the lock; `--check` compares the shared pins with the serving lock. |
| `kev-train-linux-aarch64.lock` | | The training venv: the serving lock's 76 packages at the same versions, plus `flash-linear-attention`, `fla-core` 0.5.2 and `einops`; one declared exception, `triton` 3.7.1. |
| `kev-cuda-linux-aarch64.lock` | | The serving venv (`kev-cuda/.venv`, plan 0.003 on the Spark); now tracked as well. |
| `train_candidate.py` | training venv | One candidate (LoRA + pointer head) from a parent checkpoint, offline, under a lock, written atomically with a manifest (below). |
| `kev_train_launcher.py` | training venv | Runs `kev.train` unchanged in-process and records status, wall time, peak CUDA and resident memory. |
| `predict.py` | either venv | Verifies a candidate against its manifest (exit 4 on any missing, extra or changed file), then scores labelled requests with Kev's `LocalPredictor` (bf16 as `kev.serve` loads on CUDA; `--raw` for temperature 1). |
| `fixtures/train-fixture.jsonl` | | 24 synthetic, non-private requests (a message to an assistant; `needs_web` noul, `topic` choice, `urgency` score). |
| `host/scripts/training-smoke.ts` | node | The round trip: train a few steps, score the candidate in both venvs and the parent, report parity, movement, time and memory. |

## Why a second venv

`kev.serve` turns its fused CUDA kernels on whenever `flash-linear-attention` 0.5.2 is importable (`fused_available()`). Installing training packages into `kev-cuda/.venv` would silently change the live Kev's numbers at its next restart (and void the 268-decision parity of 2026-10-10). The training venv shares every pin with it (torch 2.8.0+cu129, transformers 5.17.0, peft 0.21.0, …), so a candidate is trained and checked on the same library versions it will be served with; `train-env.sh --check` enforces that.

**Triton:** torch 2.8 pins Triton 3.4.0, whose bundled `ptxas` does not know the GB10 (`sm_121a`) and which refuses the system's CUDA 13 `ptxas` ("Triton only support CUDA 10.0 or higher, but got 13.0"). Triton 3.7.1, installed without dependencies, compiles fla's kernels for sm_121. Only fla uses Triton in this venv; the serving venv has no fla. Kev's own Modal training image makes the same swap (`triton>=3.7.1`, for fla#640 on Hopper).

**fla on the GB10**, checked against transformers' pure-torch reference (bf16, T=200, 4 heads): `chunk_gated_delta_rule` forward and every gradient within 0.39–0.47 % relative error. **Not installed:** `causal-conv1d` (no aarch64 wheel; building it needs CUDA 12.x `nvcc`, the Spark has 13.0); transformers uses its PyTorch convolution, which is slower but exact.

## The candidate trainer

```
kev-train/.venv/bin/python decision-worker/train_candidate.py --data <labelled.jsonl> \
    [--parent jaredpalmer/kev-4b@<sha> | <candidate dir>] [--steps 50] [--max-minutes 30] [--lr 2e-5] [--seed 0] [--out-root <dir>]
```

- **Scrubbed environment**, replaced before any import: PATH of the venv and `/usr/bin:/bin`, HOME `~/.iyye2/decisions/training/home`, the provisioned `~/.iyye2/decisions/hf`, `HF_HUB_OFFLINE=1`, no token, nothing inherited (no `TELEGRAM_*`, no `IYYE2_*`, no Modal). Nothing can be downloaded or pushed; a parent that is not in the cache is refused.
- **One run at a time:** `flock` on `~/.iyye2/decisions/training/lock`; a second run exits 3.
- **The parent's architecture** (LoRA rank, head size, option isolation, special embeddings, backbone dtype, LoRA targets) is passed to `kev.train --init_from`, so Kev's warm start compares every field before loading. Only LoRA + head parents; full-weight checkpoints are refused.
- **Atomic candidates:** `candidates/.partial-<id>` is renamed to `candidates/<id>` only when `kev.train` finished and saved its head; `manifest.json` holds state `candidate`, the parent (requested id, path, base and revision, LoRA rank, adapter and head sha256, its temperature), the data's path, sha256 and record count, every argument, the Kev commit, the environment (Python, torch, CUDA, device, transformers, peft, Triton, fla, the lock's sha256), the resources and the sha256 of every file. A failed run is kept as `.failed-<id>` (its log; no manifest, so never loadable). Nothing points at a candidate.
- **Stopping:** SIGTERM/SIGINT or the time budget sends SIGTERM to the trainer's process group (SIGKILL after 20 s), deletes the partial directory and journals `stopped` with the time it took. A LoRA run has no resume point in Kev (`--resume` is full-weight only), so a stopped night is discarded, not resumed.
- **Journal:** `~/.iyye2/decisions/training/journal.jsonl` (started, candidate, failed, stopped), records only.

## Measured on the Spark (2026-10-10, live host running beside it)

| What | Result |
| --- | --- |
| Venv build | `train-env.sh --resolve`: 79 packages; `--check`: 76 shared pins identical except Triton. |
| Smoke, 3 steps, kev-4b parent, 24 fixture records (batch 2 × accum 4) | First run 100 s for the trainer (≈48 s model load, first step 47 s: Triton compiling fla's kernels); with the Triton cache warm 19 s (steps 5.2, 2.9, 2.3 s). |
| Peak memory, training | 27.7 GB CUDA (fp32 backbone as the parent was trained, bf16 autocast), 25 GB resident. The machine had ~66 GB available. |
| Artifact reload | Every file verified against the manifest in both venvs. |
| Parity, training venv (fla) vs serving venv (torch path), same candidate, bf16 | max \|Δp\| **0.0121**, **0 argmax flips** in 72 questions (tolerance 0.02). |
| Moved from the parent, both at temperature 1 | max \|Δp\| 0.44, 7 flips in 3 steps on 24 records: a tiny fixture moves the model a lot; the reason Stage 4 needs held-out gates, replay and bounded steps. |
| Serving-venv scoring | load 58 s, median 117 ms per request, peak 8.2 GB CUDA. |
| Stop | SIGTERM a few seconds into training: the trainer was gone in **0.68 s**, the wrapper exited in 1.3 s, the partial candidate deleted, ~32 GB freed, no process left. |

## Known gaps (Stage 4 work, not built)

- **Calibration:** a candidate carries no fitted temperature (1.0); its parent has 2.41. It must be fitted on a validation split (Kev's `scripts/calibrate_checkpoint.py`) before any comparison with the active bundle.
- **Replay:** `kev.train --replay` needs a frozen suite (`--suite`), which is not provisioned on the Spark; without it a delta fine-tune can forget the released recipe.
- **Datasets:** nothing exports Iyye's labelled decisions yet (owner labels, weak labels, `/forget` exclusions, grouped and time-split partitions, sealed test set).
- **Admission:** the trainer does not yet ask `DeviceSlot`/NightWork for the device; run it only by hand, briefly, while nobody needs the GPU.
- **Other models:** the trainer and predictor take any Kev LoRA + head checkpoint on any base Kev supports (provision it first; offline otherwise). Fine-tuning generative models (llama.cpp LoRA → GGUF) is outside the HLD's nightly scope and not set up: llama.cpp's converter pins transformers 4.57.6 and torch 2.11, so it would need a third venv.

## Commands

```
decision-worker/train-env.sh                 # rebuild the training venv from its lock (network for the install only)
decision-worker/train-env.sh --check         # shared pins identical?
cd host && node scripts/training-smoke.ts /tmp/iyye-train-smoke --steps 3
```
