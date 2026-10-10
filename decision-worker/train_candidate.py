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

import os
import sys
from pathlib import Path

STATE = Path(os.environ.get("IYYE2_STATE_DIR") or Path.home() / ".iyye2").expanduser()
DECISIONS = STATE / "decisions"
TRAINING = DECISIONS / "training"
ROOT = Path(__file__).resolve().parent.parent  # iyye_2
VENV_BIN = Path(sys.executable).parent


def scrubbed_environment() -> dict[str, str]:
    """Everything the trainer may see: no inherited variable survives (tokens, TELEGRAM_*, IYYE2_*, proxies, Modal)."""
    return {
        "PATH": f"{VENV_BIN}:/usr/bin:/bin",
        "HOME": str(TRAINING / "home"),
        "LANG": "C.UTF-8",
        "HF_HOME": str(DECISIONS / "hf"),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_PROGRESS_BARS": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "PYTHONUNBUFFERED": "1",
        # fla's Triton kernels compile once per shape class; the cache keeps them across nights.
        "TRITON_CACHE_DIR": str(TRAINING / "triton-cache"),
        **({"CUDA_VISIBLE_DEVICES": os.environ["CUDA_VISIBLE_DEVICES"]} if "CUDA_VISIBLE_DEVICES" in os.environ else {}),
    }


# Before any import that reads the environment (huggingface_hub reads HF_* at import).
os.environ.clear()
os.environ.update(scrubbed_environment())

import argparse  # noqa: E402
import fcntl  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import secrets  # noqa: E402
import shutil  # noqa: E402
import signal  # noqa: E402
import subprocess  # noqa: E402
import time  # noqa: E402
from datetime import UTC, datetime  # noqa: E402

DEFAULT_PARENT = "jaredpalmer/kev-4b@6cfce5c2fa4b4bd64026336ab649c5ca78857d52"  # IYYE2_DECISIONS_MODEL's default
STOP_GRACE_S = 20  # SIGTERM, then SIGKILL


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def journal(entry: dict) -> None:
    """One line per run outcome in `training/journal.jsonl` (what the owner and the host read; never prose)."""
    with (TRAINING / "journal.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"at": now_iso(), **entry}, ensure_ascii=False) + "\n")


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
        "head_sha256": sha256_file(Path(path) / "head.pt"),
        "temperature": getattr(m, "temperature", None),
    }
    return identity, args


def package_versions() -> dict:
    import importlib.metadata as md

    import torch

    def version(name: str) -> str | None:
        try:
            return md.version(name)
        except md.PackageNotFoundError:
            return None

    return {
        "python": sys.version.split()[0],
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        **{n: version(n) for n in ("transformers", "peft", "triton", "flash-linear-attention")},
    }


def git_commit(repo: Path) -> str | None:
    r = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    return r.stdout.strip() or None


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
    ap.add_argument("--out-root", default=str(TRAINING / "candidates"), help="where candidates go (a smoke uses a scratch directory)")
    ap.add_argument("--label", default="", help="a short note kept in the manifest")
    a = ap.parse_args()
    if not 1 <= a.steps <= 2000 or not 0 < a.max_minutes <= 600 or not 0 < a.lr <= 1e-3:
        ap.error("--steps 1..2000, --max-minutes up to 600, --lr up to 1e-3")
    data = Path(a.data).resolve()
    if not data.is_file():
        ap.error(f"no data file {data}")
    for d in (TRAINING / "home", TRAINING / "triton-cache"):
        d.mkdir(parents=True, exist_ok=True)
    out_root = Path(a.out_root).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    lock = (TRAINING / "lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
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
    cid = f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(3)}"
    partial = out_root / f".partial-{cid}"
    partial.mkdir()
    run_dir, stats_path, log_path = partial / "run", partial / "launcher-stats.json", partial / "train.log"
    kev_args = [
        "--data", str(data), "--init_from", parent_path, *arch,
        "--device", "cuda", "--dtype", "bf16",
        "--max_steps", str(a.steps), "--epochs", str(max(1, a.steps)),  # max_steps bounds it; epochs only lets it reach that
        "--lr", str(a.lr), "--accum", str(a.accum), "--batch", str(a.batch), "--seed", str(a.seed),
        "--out", str(run_dir),
    ]
    cmd = [sys.executable, str(Path(__file__).with_name("kev_train_launcher.py")), str(stats_path), *kev_args]
    base = {"id": cid, "parent": a.parent, "data_sha256": sha256_file(data), "steps": a.steps}
    journal({**base, "event": "started"})

    stop = {"why": None, "at": None}

    def request_stop(why: str) -> None:
        if stop["why"] is None:
            stop["why"], stop["at"] = why, time.monotonic()

    signal.signal(signal.SIGTERM, lambda *_: request_stop("SIGTERM"))
    signal.signal(signal.SIGINT, lambda *_: request_stop("SIGINT"))
    started = time.monotonic()
    with log_path.open("w", encoding="utf-8") as log:
        child = subprocess.Popen(cmd, cwd=str(partial), env=dict(os.environ), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        while child.poll() is None:
            if stop["why"] is None and time.monotonic() - started > a.max_minutes * 60:
                request_stop("time budget")
            if stop["why"] is not None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=STOP_GRACE_S)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                break
            time.sleep(0.2)
    code = child.returncode
    if stop["why"] is not None:
        stopped_s = round(time.monotonic() - stop["at"], 2)
        shutil.rmtree(partial, ignore_errors=True)
        journal({**base, "event": "stopped", "reason": stop["why"], "stop_s": stopped_s})
        print(f"train_candidate: stopped ({stop['why']}) in {stopped_s} s; nothing kept", file=sys.stderr)
        return 143
    stats = json.loads(stats_path.read_text()) if stats_path.exists() else {}
    if code != 0 or not (run_dir / "head.pt").exists():
        tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:]
        failed = out_root / f".failed-{cid}"
        partial.rename(failed)  # kept for the owner to read; never loadable as a candidate (no manifest)
        journal({**base, "event": "failed", "exit": code, "log": str(failed / "train.log")})
        print(f"train_candidate: kev.train exited {code}; log kept in {failed}\n{tail}", file=sys.stderr)
        return 1

    files = {str(p.relative_to(run_dir)): sha256_file(p) for p in sorted(run_dir.rglob("*")) if p.is_file()}
    lock_file = ROOT / "decision-worker" / "kev-train-linux-aarch64.lock"
    manifest = {
        "id": cid,
        "state": "candidate",
        "created_at": now_iso(),
        "label": a.label,
        "kind": "kev-lora-head",
        "parent": {"requested": a.parent, **parent},
        "data": {"path": str(data), "sha256": base["data_sha256"], "records": records},
        "training": {"steps": a.steps, "lr": a.lr, "accum": a.accum, "batch": a.batch, "seed": a.seed, "kev_args": kev_args},
        "kev_commit": git_commit(ROOT / "kev"),
        "environment": {**package_versions(), "lock_sha256": sha256_file(lock_file) if lock_file.exists() else None},
        "resources": {**stats, "total_wall_s": round(time.monotonic() - started, 2)},
        "files": files,
    }
    (partial / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    final = out_root / cid
    partial.rename(final)  # atomic on one filesystem: a candidate either exists whole or not at all
    journal({**base, "event": "candidate", "dir": str(final), "wall_s": stats.get("wall_s"), "peak_cuda_bytes": stats.get("peak_cuda_bytes")})
    print(json.dumps({"id": cid, "dir": str(final), "resources": manifest["resources"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
