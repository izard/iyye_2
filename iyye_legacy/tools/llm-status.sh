#!/usr/bin/env bash
# Print JSON status of the llama-server.
# Outputs: {"status":"running"|"stopped", "pid":N, "model":"...", "healthy":true|false}
set -euo pipefail
source "$(dirname "$0")/_llm-common.sh"

pid=0
running=false
healthy=false
model="unknown"

if [[ -f "$PID_FILE" ]]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
        running=true
        # Try to find model from process args
        model=$(ps -p "$pid" -o args= 2>/dev/null | grep -oE '\-m [^ ]+' | awk '{print $2}' | xargs basename 2>/dev/null || echo "unknown")
    fi
fi

if $running; then
    if curl -sf "$LLM_HEALTH" > /dev/null 2>&1; then
        healthy=true
    fi
    printf '{"status":"running","pid":%s,"model":"%s","healthy":%s,"url":"http://%s:%s"}\n' \
        "$pid" "$model" "$healthy" "$LLM_HOST" "$LLM_PORT"
else
    printf '{"status":"stopped","pid":0,"model":null,"healthy":false}\n'
fi
