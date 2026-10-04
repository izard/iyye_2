#!/usr/bin/env bash
# Start llama-server with Gemma-4 31B (QAT UD-Q4_K_XL, ~16G).
# Google's quantization-aware-training Q4 matches the previous Q8 quality at
# roughly half the RAM.
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"
llm_start "gemma-4-31B-it-qat-UD-Q4_K_XL.gguf"
