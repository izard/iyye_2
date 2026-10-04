#!/usr/bin/env bash
# Start llama-server with GLM-4.7 REAP 40p (88G).
# Uses reduced context (16384) due to very large model size.
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"
LLM_CONTEXT="${LLM_CONTEXT:-16384}" llm_start "GLM-4.7-REAP-40p-IQ3_S.gguf"
