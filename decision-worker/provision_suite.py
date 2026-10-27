#!/usr/bin/env python3
# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
"""Provision Kev's frozen replay suite once, with network (plan 0.017, owner decision 6).

    kev-train/.venv/bin/python decision-worker/provision_suite.py [--suite v7/decision-v7]

The released kev-4b was trained as a delta with `--suite evals/v7/decision-v7 --replay 4000` (its
training_config.json), so a candidate replays the same suite's training partition to keep the released recipe.

- The manifest and the calibration and development partitions are copied from the Kev clone (they are in git); the
  training partition (over Kev's git limit) is fetched from Kev's public Hub mirror (`kev.suite.SUITES_DATASET` at the
  pinned `SUITES_REVISION`) by Kev's own `load_split`, which checks its sha256 and record count against the manifest.
  The locked test partition is never copied.
- Into `~/.iyye2/decisions/suites/evals/<suite>/`, read-only, with `provisioned.json`. Every file is checked against
  the manifest again, so a second run only verifies.
- Nothing else: no token (none is needed or passed), no model, no upload. The trainers stay offline and read it from
  there (`train_candidate.py --suite <dir> --replay N`).
"""

import os
import sys
from pathlib import Path

STATE = Path(os.environ.get("IYYE2_STATE_DIR") or Path.home() / ".iyye2").expanduser()
ROOT = Path(__file__).resolve().parent.parent  # iyye_2
os.environ.clear()
os.environ.update({
    "PATH": f"{Path(sys.executable).parent}:/usr/bin:/bin",
    "HOME": str(STATE / "decisions" / "training" / "home"),
    "LANG": "C.UTF-8",
    "HF_HOME": str(STATE / "decisions" / "hf"),
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "HF_HUB_DISABLE_PROGRESS_BARS": "1",
})
sys.path.insert(0, str(ROOT / "kev"))

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import shutil  # noqa: E402
from datetime import UTC, datetime  # noqa: E402

COPIED = ("manifest.json", "calibration.jsonl", "development.jsonl")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--suite", default="v7/decision-v7", help="the suite's path under Kev's evals/")
    a = ap.parse_args()
    from kev.suite import SUITES_DATASET, SUITES_REVISION, load_split

    source = ROOT / "kev" / "evals" / a.suite
    dest = STATE / "decisions" / "suites" / "evals" / a.suite
    if not (source / "manifest.json").is_file():
        print(f"provision_suite: no suite {source}", file=sys.stderr)
        return 2
    dest.mkdir(parents=True, exist_ok=True)
    os.chmod(dest, 0o755)
    for name in COPIED:
        target = dest / name
        if not target.exists():
            shutil.copyfile(source / name, target)
    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
    if sha256(dest / "manifest.json") != sha256(source / "manifest.json"):
        print("provision_suite: the provisioned manifest differs from the clone's", file=sys.stderr)
        return 1
    records = load_split(dest, "train")  # fetched from the mirror on first use, then hash- and count-checked
    for name in [*COPIED[1:], "train.jsonl"]:
        if sha256(dest / name) != manifest["files"][name]["sha256"]:
            print(f"provision_suite: {dest / name} does not match the manifest", file=sys.stderr)
            return 1
    for p in dest.iterdir():
        if p.is_file():
            os.chmod(p, 0o444)
    record = {
        "suite": a.suite,
        "dir": str(dest),
        "manifest_sha256": sha256(dest / "manifest.json"),
        "mirror": {"dataset": SUITES_DATASET, "revision": SUITES_REVISION},
        "train_records": len(records),
        "files": {n: manifest["files"][n]["sha256"] for n in [*COPIED[1:], "train.jsonl"]},
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    info = dest / "provisioned.json"
    if info.exists():
        os.chmod(info, 0o644)
    info.write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
    os.chmod(info, 0o444)
    print(json.dumps(record))
    return 0


if __name__ == "__main__":
    sys.exit(main())
