#!/usr/bin/env python3
# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
"""Greedy voice rephrasings from the Hugging Face model, with or without a trained adapter (plan 0.009 CH6
infrastructure): the reference that the GGUF LoRA served by llama.cpp is compared with.

    kev-train/.venv/bin/python decision-worker/voice_generate.py --model minicpm5-2b --data <pairs.jsonl> --out <json>
        [--adapter <candidate dir>] [--max-new 200]

A candidate is checked against its manifest first (exit 4 on any mismatch), like predict.py.
"""

import sys
from pathlib import Path

import worker_env as w

w.scrub(w.STATE / "voice" / "hf")

import argparse  # noqa: E402
import json  # noqa: E402

from voice_lora import voice_messages  # noqa: E402


def verify(candidate: Path) -> Path:
    manifest = json.loads((candidate / "manifest.json").read_text(encoding="utf-8"))
    run = candidate / "run"
    present = {str(p.relative_to(run)) for p in run.rglob("*") if p.is_file()}
    if present != set(manifest["files"]) or any(w.sha256_file(run / r) != d for r, d in manifest["files"].items()):
        raise SystemExit(f"voice_generate: {candidate} does not match its manifest")
    return run


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--adapter")
    ap.add_argument("--max-new", type=int, default=200)
    a = ap.parse_args()
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    base = json.loads((w.STATE / "voice" / "provisioned.json").read_text())[a.model]["path"]
    tok = AutoTokenizer.from_pretrained(base)
    model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.bfloat16).to("cuda")
    if a.adapter:
        try:
            run = verify(Path(a.adapter))
        except SystemExit as e:
            print(e, file=sys.stderr)
            return 4
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, str(run))
    model.eval()
    rows = []
    for line in Path(a.data).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        ex = json.loads(line)
        prompt = tok.apply_chat_template(voice_messages(ex), tokenize=False, add_generation_prompt=True, enable_thinking=False)
        ids = tok(prompt, return_tensors="pt", add_special_tokens=False).input_ids.to("cuda")
        with torch.no_grad():
            gen = model.generate(ids, max_new_tokens=a.max_new, do_sample=False)
        rows.append({"input": ex["input"], "text": tok.decode(gen[0, ids.shape[1]:], skip_special_tokens=True).strip()})
    Path(a.out).write_text(json.dumps({"adapter": a.adapter, "rows": rows}, ensure_ascii=False, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
