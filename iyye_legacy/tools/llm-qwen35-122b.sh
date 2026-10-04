#!/usr/bin/env bash
# Start llama-server with Qwen3.5 122B MoE (78G).
# Uses reduced context (32768) to fit in RAM alongside model weights.
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"
LLM_CONTEXT="${LLM_CONTEXT:-32768}" llm_start "Qwen3.5-122B-A10B-Q5_K_S-00001-of-00003.gguf"
