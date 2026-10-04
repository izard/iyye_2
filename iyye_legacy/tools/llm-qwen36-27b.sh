#!/usr/bin/env bash
# Start llama-server with Qwen3.6 27B dense (33G).
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail
export LLM_PORT=8090
source "$(dirname "$0")/_llm-common.sh"
llm_start "Qwen3.6-27B-UD-Q8_K_XL.gguf"
