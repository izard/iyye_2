#!/usr/bin/env python3
# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
"""Run `kev.train` in this process and record what it used (decision-worker/TRAINING.md).

    python kev_train_launcher.py <stats.json> <kev.train arguments...>

Started only by train_candidate.py, inside its scrubbed environment. Kev's trainer runs unchanged (runpy, as
`python -m kev.train` would); afterwards this writes its status, wall time, the peak CUDA memory torch allocated (the
GB10 shares memory with the CPU, so nvidia-smi reports none) and the peak resident memory.
"""

import json
import resource
import runpy
import sys
import time

import torch


def main() -> None:
    stats_path, args = sys.argv[1], sys.argv[2:]
    sys.argv = ["kev.train", *args]
    started, status = time.monotonic(), "error"
    try:
        runpy.run_module("kev.train", run_name="__main__", alter_sys=True)
        status = "ok"
    except SystemExit as e:
        status = "ok" if e.code in (0, None) else f"exit {e.code}"
        raise
    finally:
        stats = {
            "status": status,
            "wall_s": round(time.monotonic() - started, 2),
            "peak_cuda_bytes": torch.cuda.max_memory_allocated() if torch.cuda.is_available() else None,
            "max_rss_kb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        }
        with open(stats_path, "w", encoding="utf-8") as f:
            json.dump(stats, f)


if __name__ == "__main__":
    main()
