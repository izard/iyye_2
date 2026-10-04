#!/usr/bin/env bash
# Start llama-server with Gemma-4 E4B (7.6G, fast default).
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"
llm_start "gemma-4-E4B-it-Q8_0.gguf"
