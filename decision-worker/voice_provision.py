#!/usr/bin/env python3
# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
"""One-off, owner-run download of a voice model's Hugging Face base (plan 0.009 CH6 infrastructure).

    kev-train/.venv/bin/python decision-worker/voice_provision.py minicpm5-2b

A LoRA trained for the voice must be trained on exactly the weights its GGUF was converted from. Each registry model
that can carry a voice is pinned here to that source at a revision; it is downloaded once into `<state>/voice/hf` and
recorded in `<state>/voice/provisioned.json`. Training runs offline afterwards. A model whose source is unknown (a
custom build) is refused: an adapter trained on a different checkpoint is not assumed to transfer (HLD §9.5).
"""

import json
import os
import sys
from pathlib import Path

STATE = Path(os.environ.get("IYYE2_STATE_DIR") or Path.home() / ".iyye2").expanduser()
VOICE = STATE / "voice"

# registry name -> its GGUF's Hugging Face source, pinned (checked 2026-10-10 against the GGUF's metadata).
SOURCES = {
    "minicpm5-2b": "openbmb/MiniCPM5-2B@f97400052a43d642bbc6e9975e2397e3ae6a6b52",  # MiniCPM5-2B-Q6_K_L.gguf, arch llama
    "gemma-4-E4B": "google/gemma-4-E4B-it@ee0ef6023621cff504d758262d4e04895a5af4a2",  # gemma-4-E4B-it-Q8_0.gguf (Unsloth), arch gemma4
}
UNKNOWN = {
    "qwen35-4b-tak": "a custom 'tak-reasoning' fine-tune of Qwen/Qwen3.5-4B with no published source; an adapter trained on the base would be applied to other weights",
}


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <{'|'.join(SOURCES)}>", file=sys.stderr)
        return 2
    model = sys.argv[1]
    if model in UNKNOWN:
        print(f"{model} cannot carry a trained voice: {UNKNOWN[model]}", file=sys.stderr)
        return 2
    if model not in SOURCES:
        print(f"{model}: no pinned source", file=sys.stderr)
        return 2
    os.environ.update({"HF_HOME": str(VOICE / "hf"), "HF_HUB_DISABLE_TELEMETRY": "1"})
    os.environ.pop("HF_HUB_OFFLINE", None)
    from huggingface_hub import snapshot_download

    repo, _, revision = SOURCES[model].partition("@")
    path = snapshot_download(repo, revision=revision, allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt", "*.jinja"])  # never remote code
    record_path = VOICE / "provisioned.json"
    entries = json.loads(record_path.read_text()) if record_path.exists() else {}
    entries[model] = {"repo": repo, "revision": revision, "path": path}
    record_path.write_text(json.dumps(entries, indent=2) + "\n")
    print(json.dumps(entries[model]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
