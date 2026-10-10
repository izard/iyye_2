#!/usr/bin/env python3
# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
"""Train one candidate decision adapter from a parent checkpoint (Stage 4 infrastructure, decision-worker/TRAINING.md).

    kev-train/.venv/bin/python decision-worker/train_candidate.py --data <labelled.jsonl> \
        [--parent jaredpalmer/kev-4b@<sha> | <candidate dir>] [--steps 50] [--max-minutes 30] [--lr 2e-5] [--seed 0]

What it guarantees, whatever Kev's trainer does:

- **Offline, with no credentials:** it replaces its own environment before importing anything (a minimal PATH, a
  scratch HOME, the provisioned HF cache, HF_HUB_OFFLINE=1, no token, nothing of the host's), and its trainer inherits
  that. Nothing can be pushed or downloaded, and no channel credential is reachable.
- **One run at a time** (Kev's rule, HLD §9.3): an exclusive lock; a second run exits 3 at once.
- **The parent's architecture:** LoRA rank, head size, option isolation, special embeddings, backbone dtype and LoRA
  targets come from the parent, so Kev's warm start (`--init_from`) can never half-load it.
- **Never a half-written candidate:** the run is written into a partial directory and renamed into
  `candidates/<id>` only when it finished, with `manifest.json` (state `candidate`): the parent and its weights' hash,
  the base and its revision, the data's hash and size, every argument, the Kev commit, the environment and its lock's
  hash, the resources used, and the sha256 of every file. Nothing here activates, or points at, a candidate.
- **Stoppable:** SIGTERM or SIGINT (the owner needs the device) or the time budget stops the trainer at once (a LoRA
  run has no resume point, so a stopped run is discarded) and journals how long stopping took.

Exit status: 0 candidate written, 1 training failed, 2 usage, 3 another run holds the lock, 143 stopped.
"""

import sys
from pathlib import Path

import worker_env as w

w.scrub(w.STATE / "decisions" / "hf")  # before any import that reads the environment

import argparse  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402

DEFAULT_PARENT = "jaredpalmer/kev-4b@6cfce5c2fa4b4bd64026336ab649c5ca78857d52"  # IYYE2_DECISIONS_MODEL's default


def parent_architecture(path: str) -> tuple[dict, list[str]]:
    """The parent's identity and the kev.train arguments that must match it (Checkpoint.COMPAT_FIELDS, plus the
    LoRA targets and backbone dtype it was trained with)."""
    from kev.checkpoint import Checkpoint

    ck = Checkpoint(path)
    m = ck.meta
    trained = {}
    config = Path(path) / "training_config.json"
    if config.exists():
        trained = json.loads(config.read_text(encoding="utf-8")).get("args", {})
    if m.weights != "lora":
        raise SystemExit(f"train_candidate: {path} holds full weights; only LoRA + head candidates are trained here")
    args = [
        "--base", m.base,
        "--lora", str(m.lora),
        "--head_dim", str(m.head_dim),
        "--option_isolation", str(int(m.option_isolation)),
        "--special_embeddings", str(int(m.special_embeddings)),
        "--weights_dtype", m.weights_dtype,
        "--lora_targets", trained.get("lora_targets", "all"),
    ]
    if m.base_revision:
        args += ["--base_revision", m.base_revision]
    identity = {
        "path": path,
        "base": m.base,
        "base_revision": m.base_revision,
        "lora": m.lora,
        "weights_sha256": ck.weights_sha256(),
        "head_sha256": w.sha256_file(Path(path) / "head.pt"),
        "temperature": getattr(m, "temperature", None),
    }
    return identity, args


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", required=True, help="labelled requests, one JSON object per line (kev.data.load_records)")
    ap.add_argument("--parent", default=DEFAULT_PARENT, help="the run to start from: a pinned hub id in the cache, or a candidate directory")
    ap.add_argument("--steps", type=int, default=50, help="optimizer steps (bounded: 1..2000)")
    ap.add_argument("--max-minutes", type=float, default=30.0, help="wall-time budget; past it the run is stopped and discarded")
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out-root", default=str(w.TRAINING / "candidates"), help="where candidates go (a smoke uses a scratch directory)")
    ap.add_argument("--label", default="", help="a short note kept in the manifest")
    a = ap.parse_args()
    if not 1 <= a.steps <= 2000 or not 0 < a.max_minutes <= 600 or not 0 < a.lr <= 1e-3:
        ap.error("--steps 1..2000, --max-minutes up to 600, --lr up to 1e-3")
    data = Path(a.data).resolve()
    if not data.is_file():
        ap.error(f"no data file {data}")
    out_root = Path(a.out_root).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    lock = w.take_lock()
    if lock is None:
        print("train_candidate: another training run holds the lock", file=sys.stderr)
        return 3

    from kev.checkpoint import resolve_run
    from kev.data import load_records

    try:
        parent_path = resolve_run(a.parent)  # offline: only what provisioning put in the cache
    except Exception as e:  # noqa: BLE001
        print(f"train_candidate: the parent {a.parent} is not available offline: {e}", file=sys.stderr)
        return 2
    parent, arch = parent_architecture(parent_path)
    records = len(load_records(data))
    cid = w.new_id()
    partial = out_root / f".partial-{cid}"
    partial.mkdir()
    run_dir, stats_path = partial / "run", partial / "launcher-stats.json"
    kev_args = [
        "--data", str(data), "--init_from", parent_path, *arch,
        "--device", "cuda", "--dtype", "bf16",
        "--max_steps", str(a.steps), "--epochs", str(max(1, a.steps)),  # max_steps bounds it; epochs only lets it reach that
        "--lr", str(a.lr), "--accum", str(a.accum), "--batch", str(a.batch), "--seed", str(a.seed),
        "--out", str(run_dir),
    ]
    cmd = [sys.executable, str(Path(__file__).with_name("kev_train_launcher.py")), str(stats_path), *kev_args]
    base = {"id": cid, "kind": "kev-lora-head", "parent": a.parent, "data_sha256": w.sha256_file(data), "steps": a.steps}
    w.journal({**base, "event": "started"})
    started = time.monotonic()
    outcome, code = w.run_supervised(cmd, partial, a.max_minutes, base)
    if outcome == "stopped":
        return 143
    stats = json.loads(stats_path.read_text()) if stats_path.exists() else {}
    if outcome != "ok" or not (run_dir / "head.pt").exists():
        w.keep_failed(partial, out_root, cid, base, code)
        return 1
    final = w.publish(partial, out_root, cid, {
        "label": a.label,
        "kind": "kev-lora-head",
        "parent": {"requested": a.parent, **parent},
        "data": {"path": str(data), "sha256": base["data_sha256"], "records": records},
        "training": {"steps": a.steps, "lr": a.lr, "accum": a.accum, "batch": a.batch, "seed": a.seed, "kev_args": kev_args},
        "kev_commit": w.git_commit(w.ROOT / "kev"),
        "environment": {**w.package_versions(), "lock_sha256": w.training_lock_sha256()},
        "resources": {**stats, "total_wall_s": round(time.monotonic() - started, 2)},
    }, base)
    print(json.dumps({"id": cid, "dir": str(final), "resources": stats}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
