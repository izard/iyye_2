#!/usr/bin/env bash
# Stop the running llama-server instance.
# Outputs JSON: {"status":"ok"} or {"status":"error","message":"..."}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"
llm_stop
printf '{"status":"ok","message":"llama-server stopped"}\n'
