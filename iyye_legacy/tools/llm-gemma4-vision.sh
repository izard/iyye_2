#!/usr/bin/env bash
# Start llama-server with Gemma-4 E4B in multimodal/vision mode on port 8081.
# The mmproj (vision projector) is downloaded automatically by llama-server.
# Outputs JSON: {"status":"ok","model":"...","url":"...","pid":N}
set -euo pipefail

# Override port so the vision server runs alongside the chat server.
export LLM_PORT="${LLM_VISION_PORT:-8081}"
export LLM_PARALLEL="${LLM_PARALLEL:-2}"

source "$(dirname "$0")/_llm-common.sh"

# --mmproj-auto tells llama-server to download the projector from HuggingFace
# if not already cached. Works for all gemma-4 models.
llm_start "gemma-4-E4B-it-Q8_0.gguf" "--mmproj-auto"
