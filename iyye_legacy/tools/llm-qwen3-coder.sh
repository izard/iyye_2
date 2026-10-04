#!/usr/bin/env bash
# Start llama-server with Qwen3-Coder-Next (coding model, multi-shard).
# Requires all shards: Qwen3-Coder-Next-Q8_0-00001..00003-of-00003.gguf
# Uses reduced context (32768).
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"
LLM_CONTEXT="${LLM_CONTEXT:-32768}" llm_start "Qwen3-Coder-Next-Q8_0-00001-of-00003.gguf"
