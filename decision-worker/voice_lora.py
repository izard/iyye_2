#!/usr/bin/env python3
# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
"""The voice LoRA training loop (plan 0.009 CH6 infrastructure; decision-worker/TRAINING.md).

Started only by voice_train.py, inside its scrubbed environment:

    python voice_lora.py --base <hf dir> --data <jsonl> --out <dir> --stats <json> [--steps 20] [--lr 1e-4] ...

A plain peft LoRA on a causal LM's attention projections, supervised on the assistant turn only: each example is
{"system", "input", "output"}, rendered with the model's own chat template (thinking off), exactly as the voice
will be prompted. No trl, no Trainer: one bounded loop whose every step is recorded.
"""

import argparse
import json
import math
import random
import resource
import time
from pathlib import Path

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer


def voice_messages(ex: dict) -> list[dict]:
    """The voice's prompt shape (the spike's): the style as the system message, the message to rewrite as the user's."""
    return [
        {"role": "system", "content": ex["system"]},
        {"role": "user", "content": f"Rewrite this message in Iyye's voice:\n<<<\n{ex['input']}\n>>>"},
    ]


def encode(tok, ex: dict) -> tuple[list[int], list[int]]:
    """Token ids and labels: the prompt is context (-100), only the assistant's answer is learned."""
    prompt = tok.apply_chat_template(voice_messages(ex), tokenize=False, add_generation_prompt=True, enable_thinking=False)
    full = tok.apply_chat_template(
        [*voice_messages(ex), {"role": "assistant", "content": ex["output"]}], tokenize=False, enable_thinking=False
    )
    if not full.startswith(prompt):
        raise SystemExit("voice_lora: the chat template does not extend the prompt with the answer; cannot mask the prompt")
    p = tok(prompt, add_special_tokens=False).input_ids
    a = tok(full[len(prompt):], add_special_tokens=False).input_ids
    return p + a, [-100] * len(p) + a


def text_targets(model, names: list[str]) -> list[str]:
    """The text model's linear layers with these names, by full module name. A multimodal model (Gemma 4) has
    same-named projections in its vision and audio towers, which the voice never uses and llama.cpp's text GGUF
    does not contain; a bare suffix would match them too (and fail on the audio tower's wrapped linears)."""
    found = [
        n for n, m in model.named_modules()
        if isinstance(m, torch.nn.Linear) and n.rsplit(".", 1)[-1] in names and not any(t in n for t in ("vision", "audio"))
    ]
    if not found:
        raise SystemExit(f"voice_lora: no text-model linear layers named {names}")
    return found


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--stats", required=True)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=8)
    ap.add_argument("--alpha", type=int, default=16)
    ap.add_argument("--targets", default="q_proj,k_proj,v_proj,o_proj")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    started = time.monotonic()
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    out = Path(a.out)
    out.mkdir(parents=True)

    tok = AutoTokenizer.from_pretrained(a.base)
    model = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.bfloat16).to("cuda")
    model.config.use_cache = False
    config = LoraConfig(r=a.rank, lora_alpha=a.alpha, lora_dropout=0.0, target_modules=text_targets(model, a.targets.split(",")), task_type="CAUSAL_LM")
    model = get_peft_model(model, config)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    examples = [json.loads(line) for line in Path(a.data).read_text(encoding="utf-8").splitlines() if line.strip()]
    encoded = [encode(tok, ex) for ex in examples]
    load_s = time.monotonic() - started

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr, weight_decay=0.0)
    warmup = max(1, a.steps // 10)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: (s + 1) / warmup if s < warmup else 0.5 * (1 + math.cos(math.pi * (s - warmup) / max(1, a.steps - warmup)))
    )
    order: list[int] = []
    losses, step_seconds, tokens = [], [], 0
    model.train()
    for _ in range(a.steps):
        t0 = time.monotonic()
        total = 0.0
        for _ in range(a.accum):
            if not order:
                order = random.sample(range(len(encoded)), len(encoded))
            ids, labels = encoded[order.pop()]
            x = torch.tensor([ids], device="cuda")
            y = torch.tensor([labels], device="cuda")
            loss = model(input_ids=x, labels=y).loss / a.accum
            loss.backward()
            total += loss.item()
            tokens += len(ids)
        torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
        opt.step()
        sched.step()
        opt.zero_grad(set_to_none=True)
        losses.append(round(total, 4))
        step_seconds.append(round(time.monotonic() - t0, 3))

    model.save_pretrained(out)  # adapter_model.safetensors + adapter_config.json
    (out / "training_config.json").write_text(json.dumps({"args": vars(a), "examples": len(examples)}, indent=2) + "\n")
    (out / "training_metrics.json").write_text(
        json.dumps({"losses": losses, "step_seconds": step_seconds, "tokens": tokens, "trainable_params": trainable, "load_s": round(load_s, 2)}, indent=2) + "\n"
    )
    Path(a.stats).write_text(json.dumps({
        "status": "ok",
        "wall_s": round(time.monotonic() - started, 2),
        "peak_cuda_bytes": torch.cuda.max_memory_allocated(),
        "max_rss_kb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    }))


if __name__ == "__main__":
    main()
