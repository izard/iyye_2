#!/usr/bin/env bash
# Print JSON array of status for all models in llm-registry.json.
# Each entry: {name, port, pid, running, healthy, size_gb, roles}
# Also prints a summary: {active_count, loaded_gb, ram_total_gb, ram_available_gb}
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

python3 - "$SCRIPT_DIR" <<'PYEOF'
import json, os, sys, urllib.request
import psutil

script_dir = sys.argv[1]
registry_path = os.path.join(script_dir, "llm-registry.json")

try:
    with open(registry_path) as f:
        registry = json.load(f)
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)

results = []
loaded_gb = 0.0

for model in registry:
    port  = model.get("port", 8080)
    pid_file = os.path.join(script_dir, f"llama-server-{port}.pid")

    pid     = 0
    running = False
    if os.path.exists(pid_file):
        try:
            pid = int(open(pid_file).read().strip())
            os.kill(pid, 0)   # raises OSError if not running
            running = True
        except (ValueError, OSError):
            pid = 0
            running = False

    healthy = False
    if running:
        try:
            r = urllib.request.urlopen(
                f"http://127.0.0.1:{port}/health", timeout=2
            )
            healthy = r.status == 200
        except Exception:
            pass

    size_gb = model.get("size_gb", 0.0)
    if healthy:
        loaded_gb += size_gb

    results.append({
        "name":     model["name"],
        "family":   model.get("family", ""),
        "port":     port,
        "pid":      pid,
        "running":  running,
        "healthy":  healthy,
        "size_gb":  size_gb,
        "roles":    model.get("roles", []),
        "default_for": model.get("default_for", []),
        "vision":   model.get("vision", False),
        "description": model.get("description", ""),
    })

vm = psutil.virtual_memory()
ram_total_gb     = round(vm.total     / 1024**3, 1)
ram_available_gb = round(vm.available / 1024**3, 1)

output = {
    "models":           results,
    "active_count":     sum(1 for m in results if m["healthy"]),
    "loaded_gb":        round(loaded_gb, 1),
    "ram_total_gb":     ram_total_gb,
    "ram_available_gb": ram_available_gb,
    "headroom_gb":      round(ram_available_gb - loaded_gb, 1),
}
print(json.dumps(output, indent=2))
PYEOF
