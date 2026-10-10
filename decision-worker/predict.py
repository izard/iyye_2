#!/usr/bin/env python3
# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
"""Score requests with a checkpoint, offline, in whichever venv runs it (decision-worker/TRAINING.md).

    <venv>/bin/python decision-worker/predict.py --run <candidate dir | repo@sha> --records <jsonl> --out <json> [--dtype bf16|fp32]

Run with the serving venv (`kev-cuda`) it answers what the live Kev would load; with the training venv (`kev-train`) it
answers what training evaluated. A candidate is checked against its manifest first: a file missing, added or changed
refuses it (exit 4), so an artifact that is not exactly what training wrote is never scored, let alone activated.
Labels in the records are ignored (Kev's LocalPredictor reads the request part only).
"""

import os
import sys
from pathlib import Path

STATE = Path(os.environ.get("IYYE2_STATE_DIR") or Path.home() / ".iyye2").expanduser()
os.environ.clear()
os.environ.update({
    "PATH": f"{Path(sys.executable).parent}:/usr/bin:/bin",
    "HOME": str(STATE / "decisions" / "training" / "home"),
    "HF_HOME": str(STATE / "decisions" / "hf"),
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "TOKENIZERS_PARALLELISM": "false",
    "TRITON_CACHE_DIR": str(STATE / "decisions" / "training" / "triton-cache"),
})

import argparse  # noqa: E402
import hashlib  # noqa: E402
import importlib.util  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402


def verify(candidate: Path) -> Path:
    """The candidate's run directory, if every file is exactly the one its manifest names (and nothing else)."""
    manifest = json.loads((candidate / "manifest.json").read_text(encoding="utf-8"))
    run = candidate / "run"
    present = {str(p.relative_to(run)) for p in run.rglob("*") if p.is_file()}
    if present != set(manifest["files"]):
        raise SystemExit(f"predict: {candidate} does not match its manifest (files {sorted(present ^ set(manifest['files']))[:3]})")
    for rel, digest in manifest["files"].items():
        if hashlib.sha256((run / rel).read_bytes()).hexdigest() != digest:
            raise SystemExit(f"predict: {candidate}/run/{rel} does not match its manifest")
    return run


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--records", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--dtype", choices=["bf16", "fp32"], default="bf16", help="bf16: as kev.serve loads on CUDA; fp32: Kev's exact path")
    ap.add_argument("--raw", action="store_true", help="temperature 1 (raw logits): compares weights, not calibrations")
    a = ap.parse_args()
    import torch
    from kev.checkpoint import LoadOptions, resolve_run
    from kev.data import load_records
    from kev.predictors import LocalPredictor

    run = Path(a.run)
    if (run / "manifest.json").exists():
        try:
            run = verify(run)
        except SystemExit as e:
            print(e, file=sys.stderr)
            return 4
    path = resolve_run(str(run))
    t0 = time.monotonic()
    predictor = LocalPredictor(path, "cuda", LoadOptions(dtype=torch.bfloat16 if a.dtype == "bf16" else torch.float32, temperature=1.0 if a.raw else None))
    load_s = time.monotonic() - t0
    rows = []
    for r in load_records(a.records):
        p = predictor(r)
        rows.append({"id": r["_meta"]["id"], "probabilities": p["probabilities"], "latency_ms": round(p["latency_ms"], 1)})
    out = {
        "run": path,
        "venv": str(Path(sys.executable).parent.parent),
        "dtype": a.dtype,
        "fla": importlib.util.find_spec("fla") is not None,
        "kernels": predictor.environment,
        "temperature": predictor.temperature,
        "load_s": round(load_s, 2),
        "peak_cuda_bytes": torch.cuda.max_memory_allocated(),
        "predictions": rows,
    }
    Path(a.out).write_text(json.dumps(out, indent=1, default=str) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
