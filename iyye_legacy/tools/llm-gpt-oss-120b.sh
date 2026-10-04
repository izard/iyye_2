#!/usr/bin/env bash
# Start llama-server with GPT OSS 120B (59G).
# Uses reduced context (32768) to fit in RAM alongside model weights.
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"
LLM_CONTEXT="${LLM_CONTEXT:-32768}" llm_start "gpt-oss-120b-Q8_0-00001-of-00002.gguf"
