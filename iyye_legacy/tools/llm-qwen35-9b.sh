#!/usr/bin/env bash
# Start llama-server with Qwen3.5 9B (10G, quick agentic tasks).
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"
llm_start "Qwen3.5-9B-UD-Q8_K_XL.gguf"
