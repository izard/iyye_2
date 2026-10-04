#!/usr/bin/env bash
# _llm-common.sh — sourced by model scripts; not run directly.
#
# Provides:
#   llm_stop          — kill any running llama-server
#   llm_start MODEL   — start server with given model file, wait until ready
#   llm_json_ok       — print JSON success line to stdout
#   llm_json_err MSG  — print JSON error line to stdout and exit 1
#
# Environment vars honoured by callers:
#   LLM_HOST     (default: 127.0.0.1)
#   LLM_PORT     (default: 8080)
#   LLM_CONTEXT  (default: 65536)
#   LLM_THREADS  (default: auto — llama-server default)
#   LLM_START_TIMEOUT  (default: 180  — seconds to wait for /health;
#                       distinct from the Python client's LLM_TIMEOUT
#                       request read-timeout, deliberately not shared)

LLAMA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/llama.cpp" && pwd)"
LLAMA_BIN="$LLAMA_DIR/build_last6/bin/llama-server"
MODELS_DIR="$LLAMA_DIR/models"
PID_FILE="$(dirname "${BASH_SOURCE[0]}")/llama-server-${LLM_PORT}.pid"
LOG_FILE="$(dirname "${BASH_SOURCE[0]}")/llama-server.log"

LLM_HOST="${LLM_HOST:-127.0.0.1}"
LLM_PORT="${LLM_PORT:-8080}"
LLM_CONTEXT="${LLM_CONTEXT:-65536}"
LLM_START_TIMEOUT="${LLM_START_TIMEOUT:-180}"
LLM_HEALTH="http://${LLM_HOST}:${LLM_PORT}/health"

llm_json_ok() {
    local model="$1"
    printf '{"status":"ok","model":"%s","url":"http://%s:%s","pid":%s}\n' \
        "$model" "$LLM_HOST" "$LLM_PORT" "$(cat "$PID_FILE" 2>/dev/null || echo 0)"
}

llm_json_err() {
    printf '{"status":"error","message":"%s"}\n' "$1"
    exit 1
}

llm_stop() {
    # Kill via PID file first
    if [[ -f "$PID_FILE" ]]; then
        local pid; pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null
            local waited=0
            while kill -0 "$pid" 2>/dev/null && (( waited < 10 )); do
                sleep 1; (( waited++ ))
            done
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
    fi
    # Also kill any stray llama-server still LISTENING on our port.
    #
    # IMPORTANT: match only LISTEN sockets (the server), never client
    # connections.  Plain "lsof -ti TCP:PORT" also lists every process with an
    # ESTABLISHED connection to the port — including the Iyye orchestrator,
    # which holds HTTP keep-alive / health connections to this server.  The old
    # code did `lsof -ti TCP:PORT | head -1 | kill -9`, which could pick and
    # SIGKILL the Iyye process itself.  Belt-and-suspenders: also confirm the
    # PID really is a llama-server before killing it.
    local stray
    for stray in $(lsof -ti "TCP:${LLM_PORT}" -sTCP:LISTEN 2>/dev/null || true); do
        if ps -p "$stray" -o comm= 2>/dev/null | grep -qi 'llama'; then
            kill -9 "$stray" 2>/dev/null || true
        fi
    done
    sleep 0.5
}

llm_start() {
    local model_file="$1"   # relative to MODELS_DIR
    local extra_args="${2:-}"  # optional extra flags
    local model_path="$MODELS_DIR/$model_file"

    [[ -x "$LLAMA_BIN" ]]    || llm_json_err "llama-server binary not found: $LLAMA_BIN"
    [[ -f "$model_path" ]]   || llm_json_err "model file not found: $model_path"

    llm_stop

    # Launch in background; redirect all server output to log
    # shellcheck disable=SC2086
    "$LLAMA_BIN" \
        -m "$model_path" \
        -c "$LLM_CONTEXT" \
        --host "$LLM_HOST" \
        --port "$LLM_PORT" \
        --repeat-penalty 1.2 \
        -np "${LLM_PARALLEL:-4}" \
        $extra_args \
        > "$LOG_FILE" 2>&1 &
    local server_pid=$!
    echo "$server_pid" > "$PID_FILE"

    # Wait until /health returns 200 or timeout
    local elapsed=0
    while (( elapsed < LLM_START_TIMEOUT )); do
        if curl -sf "$LLM_HEALTH" > /dev/null 2>&1; then
            llm_json_ok "$model_file"
            return 0
        fi
        # Bail early if the process died
        kill -0 "$server_pid" 2>/dev/null || llm_json_err "llama-server exited unexpectedly (see $LOG_FILE)"
        sleep 2
        (( elapsed += 2 ))
    done

    llm_json_err "llama-server did not become ready within ${LLM_START_TIMEOUT}s (see $LOG_FILE)"
}
