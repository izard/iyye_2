#!/usr/bin/env bash
# Start llama-server with Gemma-4 26B (UD-Q8_K_XL).
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"
llm_start "gemma-4-26B-A4B-it-UD-Q8_K_XL.gguf" "--reasoning off"
