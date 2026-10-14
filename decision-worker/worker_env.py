# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
"""What every trainer here shares (decision-worker/TRAINING.md): the scrubbed environment, the one training lock,
the journal, supervised runs that can be stopped, and atomic candidates with a hashed manifest.

Standard library only: a trainer imports this, calls `scrub()` and only then imports anything that reads the
environment (huggingface_hub reads HF_* at import).
"""

import fcntl
import hashlib
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

STATE = Path(os.environ.get("IYYE2_STATE_DIR") or Path.home() / ".iyye2").expanduser()
TRAINING = STATE / "decisions" / "training"  # the lock, the journal, HOME and the Triton cache of every trainer
ROOT = Path(__file__).resolve().parent.parent  # iyye_2
STOP_GRACE_S = 20  # SIGTERM, then SIGKILL


def scrub(hf_home: Path) -> None:
    """Replace this process's environment (and so its children's) with the minimum: no tokens, no TELEGRAM_*, no
    IYYE2_*, no proxies, no Modal; offline Hugging Face on `hf_home`."""
    keep_gpu = {"CUDA_VISIBLE_DEVICES": os.environ["CUDA_VISIBLE_DEVICES"]} if "CUDA_VISIBLE_DEVICES" in os.environ else {}
    os.environ.clear()
    os.environ.update({
        "PATH": f"{Path(sys.executable).parent}:/usr/bin:/bin",
        "HOME": str(TRAINING / "home"),
        "LANG": "C.UTF-8",
        "HF_HOME": str(hf_home),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_PROGRESS_BARS": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "PYTHONUNBUFFERED": "1",
        # Triton kernels compile once per shape class; the cache keeps them across nights.
        "TRITON_CACHE_DIR": str(TRAINING / "triton-cache"),
        **keep_gpu,
    })
    for d in (TRAINING / "home", TRAINING / "triton-cache"):
        d.mkdir(parents=True, exist_ok=True)


def take_lock():
    """The one training lock (Kev's rule: one training process at a time, whatever it trains). None if held."""
    TRAINING.mkdir(parents=True, exist_ok=True)
    f = (TRAINING / "lock").open("w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        return None
    return f


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_id() -> str:
    return f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(3)}"


def journal(entry: dict) -> None:
    """One line per run outcome in `training/journal.jsonl` (what the owner and the host read; never prose)."""
    with (TRAINING / "journal.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"at": now_iso(), **entry}, ensure_ascii=False) + "\n")


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


def training_lock_sha256() -> str | None:
    lock = ROOT / "decision-worker" / "kev-train-linux-aarch64.lock"
    return sha256_file(lock) if lock.exists() else None


def run_supervised(cmd: list[str], partial: Path, max_minutes: float, base: dict) -> tuple[str, int | None]:
    """Run a trainer in its own process group, its output in `partial/train.log`. SIGTERM/SIGINT to this process or
    the time budget stops it (SIGTERM, SIGKILL after STOP_GRACE_S), deletes `partial` and journals `stopped` with how
    long stopping took. -> ("ok" | "stopped" | "failed", exit code)."""
    stop = {"why": None, "at": None}

    def request_stop(why: str) -> None:
        if stop["why"] is None:
            stop["why"], stop["at"] = why, time.monotonic()

    signal.signal(signal.SIGTERM, lambda *_: request_stop("SIGTERM"))
    signal.signal(signal.SIGINT, lambda *_: request_stop("SIGINT"))
    started = time.monotonic()
    with (partial / "train.log").open("w", encoding="utf-8") as log:
        child = subprocess.Popen(cmd, cwd=str(partial), env=dict(os.environ), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        while child.poll() is None:
            if stop["why"] is None and time.monotonic() - started > max_minutes * 60:
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
    if stop["why"] is not None:
        stopped_s = round(time.monotonic() - stop["at"], 2)
        shutil.rmtree(partial, ignore_errors=True)
        journal({**base, "event": "stopped", "reason": stop["why"], "stop_s": stopped_s})
        print(f"stopped ({stop['why']}) in {stopped_s} s; nothing kept", file=sys.stderr)
        return "stopped", child.returncode
    return ("ok" if child.returncode == 0 else "failed"), child.returncode


def keep_failed(partial: Path, out_root: Path, cid: str, base: dict, code: int | None) -> None:
    """A failed run stays readable as `.failed-<id>` (its log; no manifest, so never loadable as a candidate)."""
    failed = out_root / f".failed-{cid}"
    partial.rename(failed)
    journal({**base, "event": "failed", "exit": code, "log": str(failed / "train.log")})
    tail = (failed / "train.log").read_text(encoding="utf-8", errors="replace")[-2000:]
    print(f"the trainer exited {code}; log kept in {failed}\n{tail}", file=sys.stderr)


def publish(partial: Path, out_root: Path, cid: str, manifest: dict, base: dict) -> Path:
    """Hash every file under `partial/run`, write the manifest (state `candidate`) and rename the directory into place:
    a candidate exists whole or not at all. Nothing points at it."""
    run = partial / "run"
    manifest = {
        "id": cid,
        "state": "candidate",
        "created_at": now_iso(),
        **manifest,
        "files": {str(p.relative_to(run)): sha256_file(p) for p in sorted(run.rglob("*")) if p.is_file()},
    }
    (partial / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    final = out_root / cid
    partial.rename(final)
    res = manifest.get("resources", {})
    journal({**base, "event": "candidate", "dir": str(final), "wall_s": res.get("wall_s"), "peak_cuda_bytes": res.get("peak_cuda_bytes")})
    return final
