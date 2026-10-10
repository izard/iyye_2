#!/usr/bin/env bash
# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
#
# The decision-training environment on the DGX Spark (Stage 4 infrastructure,
# decision-worker/TRAINING.md): `iyye_2/kev-train/.venv`, separate from the
# serving one (`kev-cuda/.venv`), which it never touches. Kev's serving turns
# its fused kernels on whenever flash-linear-attention is importable, so
# training packages in the serving venv would change live answers.
#
# Everything the two share is pinned identically: torch 2.8.0+cu129 from the
# PyTorch index and the rest from the serving lock (constraints); training adds
# only flash-linear-attention (the DeltaNet kernels of Qwen3.5's training path).
# One declared exception, `OVERRIDES`: Triton 3.7.1 instead of torch 2.8's
# 3.4.0, whose bundled ptxas does not know the GB10 (sm_121a) and which cannot
# use the system's CUDA 13 ptxas; only fla's kernels use Triton here, and the
# serving venv has no fla (Kev's own training images make the same swap).
# Kev itself is the clone, installed editable without its dependencies.
#
#   decision-worker/train-env.sh            # install exactly from the training lock
#   decision-worker/train-env.sh --resolve  # first time: resolve, then write the lock
#   decision-worker/train-env.sh --check    # compare the two locks' shared pins only
#
# Needs uv and network access for the install only; training itself runs offline.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/kev-train/.venv"
SERVE_LOCK="$ROOT/decision-worker/kev-cuda-linux-aarch64.lock"
LOCK="$ROOT/decision-worker/kev-train-linux-aarch64.lock"
TORCH_INDEX="https://download.pytorch.org/whl/cu129"
FLA="flash-linear-attention==0.5.2" # kev.fused_qwen35.FLA_VERSION
OVERRIDES=("triton==3.7.1")           # installed without dependencies; the only shared packages allowed to differ

check() {
	# Every package both locks name must have the same version: a trained artifact must load in the serving venv
	# exactly as it was evaluated in this one.
	local pins="s/==/ /" shared diff
	shared="$(join -j1 <(sed "$pins" "$SERVE_LOCK" | sort) <(sed "$pins" "$LOCK" | sort))"
	diff="$(awk -v allowed=" ${OVERRIDES[*]%%==*} " '$2 != $3 && index(allowed, " " $1 " ") == 0 { print $1 ": serving " $2 ", training " $3 }' <<<"$shared")"
	if [[ -n "$diff" ]]; then
		echo "the training lock differs from the serving lock:" >&2
		echo "$diff" >&2
		exit 1
	fi
	echo "shared pins identical ($(wc -l <<<"$shared") packages) except ${OVERRIDES[*]}; training adds: $(join -v2 -j1 <(sed "$pins" "$SERVE_LOCK" | sort) <(sed "$pins" "$LOCK" | sort) | tr '\n' ' ')"
}

[[ -f "$SERVE_LOCK" ]] || { echo "missing $SERVE_LOCK (the serving venv's lock)" >&2; exit 2; }
case "${1:-}" in
--check)
	check
	exit 0
	;;
--resolve) mode=resolve ;;
"") mode=frozen ;;
*)
	echo "usage: $0 [--resolve|--check]" >&2
	exit 2
	;;
esac
[[ "$mode" == frozen && ! -f "$LOCK" ]] && { echo "no $LOCK yet: run with --resolve once" >&2; exit 2; }

mkdir -p "$ROOT/kev-train"
[[ -x "$VENV/bin/python" ]] || uv venv -q --python 3.13 "$VENV"
export VIRTUAL_ENV="$VENV"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if [[ "$mode" == resolve ]]; then
	grep -v '^torch==' "$SERVE_LOCK" >"$tmp/shared.txt"
	uv pip install -q "torch==$(sed -n 's/^torch==//p' "$SERVE_LOCK" | cut -d+ -f1)" --index-url "$TORCH_INDEX"
	uv pip install -q -r "$tmp/shared.txt"
	# Training's own additions, never moving a shared pin.
	uv pip install -q "$FLA" -c "$SERVE_LOCK"
	uv pip install -q --no-deps "${OVERRIDES[@]}"
	uv pip freeze --exclude-editable | grep -v '^kev @' >"$LOCK"
else
	grep '^torch==' "$LOCK" >"$tmp/torch.txt"
	grep -v '^torch==' "$LOCK" >"$tmp/rest.txt"
	uv pip install -q -r "$tmp/torch.txt" --index-url "$TORCH_INDEX"
	uv pip install -q --no-deps -r "$tmp/rest.txt"
fi
uv pip install -q --no-deps -e "$ROOT/kev"
check
"$VENV/bin/python" - <<'PY'
import importlib.metadata as md, torch
from kev.checkpoint import fused_available
print(f"torch {torch.__version__}, CUDA {torch.version.cuda}, device {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none'}")
print(f"flash-linear-attention {md.version('flash-linear-attention')}, Kev fused kernels usable: {fused_available()}")
PY
