#!/usr/bin/env bash
# Start llama-server with Qwen3.6 35B MoE (24G).
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"
llm_start "Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf"
