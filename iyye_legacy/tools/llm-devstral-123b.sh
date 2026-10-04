#!/usr/bin/env bash
# Start llama-server with Devstral 123B coding model (80G).
# Uses reduced context (32768) to fit in RAM alongside model weights.
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"
LLM_CONTEXT="${LLM_CONTEXT:-32768}" llm_start "Devstral-2-123B-Instruct-2512-Q5_K_S-00001-of-00002.gguf"
