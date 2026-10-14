#!/usr/bin/env python3
# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
"""Train one candidate voice LoRA (plan 0.009 CH6 infrastructure; decision-worker/TRAINING.md).

    kev-train/.venv/bin/python decision-worker/voice_train.py --model minicpm5-2b --data <pairs.jsonl> \
        [--steps 20] [--max-minutes 20] [--lr 1e-4] [--rank 8] [--out-root <dir>]

The same guarantees as train_candidate.py (worker_env): offline in a scrubbed environment, the one training lock,
stoppable, an atomic candidate in `<state>/voice/training/candidates/<id>` with a hashed manifest, nothing
activated. The base is the provisioned Hugging Face checkpoint of a registry model (voice_provision.py), the one
its GGUF was converted from, so the adapter converts (voice_convert.py) and applies to that GGUF.
"""

import sys
from pathlib import Path

import worker_env as w

VOICE = w.STATE / "voice"
w.scrub(VOICE / "hf")

import argparse  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402


def provisioned(model: str) -> dict:
    p = VOICE / "provisioned.json"
    entries = json.loads(p.read_text()) if p.exists() else {}
    if model not in entries:
        raise SystemExit(f"voice_train: {model} is not provisioned (voice_provision.py {model})")
    return entries[model]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--model", required=True, help="the registry model whose voice this is (its provisioned base)")
    ap.add_argument("--data", required=True, help='{"system", "input", "output"} per line')
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=8)
    ap.add_argument("--alpha", type=int, default=16)
    ap.add_argument("--targets", default="q_proj,k_proj,v_proj,o_proj")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max-minutes", type=float, default=20.0)
    ap.add_argument("--out-root", default=str(VOICE / "training" / "candidates"))
    ap.add_argument("--label", default="")
    a = ap.parse_args()
    if not 1 <= a.steps <= 2000 or not 0 < a.lr <= 1e-3 or not 1 <= a.rank <= 64:
        ap.error("--steps 1..2000, --lr up to 1e-3, --rank 1..64")
    data = Path(a.data).resolve()
    if not data.is_file():
        ap.error(f"no data file {data}")
    base_entry = provisioned(a.model)
    out_root = Path(a.out_root).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    lock = w.take_lock()
    if lock is None:
        print("voice_train: another training run holds the lock", file=sys.stderr)
        return 3
    cid = w.new_id()
    partial = out_root / f".partial-{cid}"
    partial.mkdir()
    stats_path = partial / "trainer-stats.json"
    args = [
        "--base", base_entry["path"], "--data", str(data), "--out", str(partial / "run"), "--stats", str(stats_path),
        "--steps", str(a.steps), "--accum", str(a.accum), "--lr", str(a.lr), "--rank", str(a.rank), "--alpha", str(a.alpha),
        "--targets", a.targets, "--seed", str(a.seed),
    ]
    cmd = [sys.executable, str(Path(__file__).with_name("voice_lora.py")), *args]
    base = {"id": cid, "kind": "voice-lora", "model": a.model, "data_sha256": w.sha256_file(data), "steps": a.steps}
    w.journal({**base, "event": "started"})
    started = time.monotonic()
    outcome, code = w.run_supervised(cmd, partial, a.max_minutes, base)
    if outcome == "stopped":
        return 143
    if outcome != "ok" or not (partial / "run" / "adapter_model.safetensors").exists():
        w.keep_failed(partial, out_root, cid, base, code)
        return 1
    stats = json.loads(stats_path.read_text())
    records = sum(1 for line in data.read_text(encoding="utf-8").splitlines() if line.strip())
    final = w.publish(partial, out_root, cid, {
        "label": a.label,
        "kind": "voice-lora",
        "model": a.model,
        "base": base_entry,
        "data": {"path": str(data), "sha256": base["data_sha256"], "records": records},
        "training": {k: getattr(a, k) for k in ("steps", "accum", "lr", "rank", "alpha", "targets", "seed")},
        "environment": {**w.package_versions(), "lock_sha256": w.training_lock_sha256()},
        "resources": {**stats, "total_wall_s": round(time.monotonic() - started, 2)},
    }, base)
    print(json.dumps({"id": cid, "dir": str(final), "resources": stats}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
