#!/usr/bin/env python3
# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
"""Is this GGUF converted from this Hugging Face checkpoint? (plan 0.009 CH6 infrastructure)

    llama-convert/.venv/bin/python decision-worker/gguf_match.py --gguf <model.gguf> --hf <checkpoint dir>

A voice LoRA is trained on the Hugging Face weights and applied to the GGUF, so they must be the same model. Compares
the vocabulary size and, for tensors whose layout conversion does not change (embeddings, MLP down projections,
norms), the cosine similarity of the dequantized GGUF tensor with its safetensors counterpart. Prints JSON; exit 1 if
any compared tensor is below 0.99 or a shape differs.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from gguf import GGUFReader
from gguf.quants import dequantize
from safetensors import safe_open

# GGUF name -> Hugging Face name, for tensors convert_hf_to_gguf.py copies without permuting, by GGUF architecture.
PAIRS = {
    "llama": {
        "token_embd.weight": "model.embed_tokens.weight",
        "blk.0.ffn_down.weight": "model.layers.0.mlp.down_proj.weight",
        "blk.0.attn_norm.weight": "model.layers.0.input_layernorm.weight",
        "output_norm.weight": "model.norm.weight",
    },
    # Gemma 4 (multimodal; the text model under model.language_model). Norms are left out (the converter may store
    # them shifted), and so is the 2.8-billion-parameter per-layer embedding (too large to dequantize here).
    "gemma4": {
        "token_embd.weight": "model.language_model.embed_tokens.weight",
        "blk.0.ffn_down.weight": "model.language_model.layers.0.mlp.down_proj.weight",
        "blk.0.attn_output.weight": "model.language_model.layers.0.self_attn.o_proj.weight",
        "blk.41.attn_q.weight": "model.language_model.layers.41.self_attn.q_proj.weight",
    },
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--hf", required=True)
    a = ap.parse_args()
    reader = GGUFReader(a.gguf)
    tensors = {t.name: t for t in reader.tensors}
    arch = bytes(reader.fields["general.architecture"].parts[-1]).decode()
    if arch not in PAIRS:
        print(json.dumps({"gguf": a.gguf, "hf": a.hf, "arch": arch, "ok": False, "tensors": {}, "error": "no tensor pairs for this architecture"}))
        return 1
    hf_files = sorted(Path(a.hf).glob("*.safetensors"))
    where = {}
    for f in hf_files:
        with safe_open(f, "np") as s:
            for k in s.keys():
                where[k] = f
    out = {"gguf": a.gguf, "hf": a.hf, "arch": arch, "tensors": {}, "ok": True}
    for g, h in PAIRS[arch].items():
        if g not in tensors or h not in where:
            out["tensors"][g] = "missing"
            out["ok"] = False  # a pair that cannot be compared proves nothing
            continue
        t = tensors[g]
        x = dequantize(t.data, t.tensor_type).astype(np.float32).reshape(-1)
        with safe_open(where[h], "pt") as s:
            y = s.get_tensor(h).float().numpy().reshape(-1)
        if x.shape != y.shape:
            out["tensors"][g] = f"shape {x.shape} vs {y.shape}"
            out["ok"] = False
            continue
        cos = float(np.dot(x, y) / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-12))
        out["tensors"][g] = round(cos, 5)
        if cos < 0.99:
            out["ok"] = False
    print(json.dumps(out, indent=1))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
