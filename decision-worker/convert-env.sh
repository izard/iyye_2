#!/usr/bin/env bash
# Copyright 2026 Alexander Komarov
# SPDX-License-Identifier: Apache-2.0
#
# The converter environment (plan 0.009 CH6 infrastructure, decision-worker/TRAINING.md):
# `iyye_2/llama-convert/.venv`, for llama.cpp's `convert_lora_to_gguf.py`, which
# turns a trained peft adapter into a GGUF LoRA the router can load. A venv of
# its own: llama.cpp's converter pins transformers 4.57.6 and torch 2.11 (CPU),
# which conflict with the training venv's pins. `gguf` comes from the llama.cpp
# tree itself (`gguf-py`, editable), never from PyPI, so it always knows the
# architectures that build of llama.cpp knows.
#
#   decision-worker/convert-env.sh            # install exactly from the lock
#   decision-worker/convert-env.sh --resolve  # first time: resolve from llama.cpp's requirements, write the lock
#
# LLAMA_CPP (default ~/Downloads/llama.cpp) must be the checkout the host's llama-server was built from; the lock
# records its commit, and a different commit refuses the frozen install.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LLAMA_CPP="${LLAMA_CPP:-$HOME/Downloads/llama.cpp}"
VENV="$ROOT/llama-convert/.venv"
LOCK="$ROOT/decision-worker/llama-convert-linux-aarch64.lock"
CPU_INDEX="https://download.pytorch.org/whl/cpu"

commit="$(git -C "$LLAMA_CPP" rev-parse --short=9 HEAD)"
mkdir -p "$ROOT/llama-convert"
[[ -x "$VENV/bin/python" ]] || uv venv -q --python 3.13 "$VENV"
export VIRTUAL_ENV="$VENV"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
case "${1:-}" in
--resolve)
	req="$LLAMA_CPP/requirements/requirements-convert_lora_to_gguf.txt"
	torch="$(sed -n 's/^torch==//p' "$LLAMA_CPP/requirements/requirements-convert_legacy_llama.txt" "$LLAMA_CPP/requirements/requirements-convert_hf_to_gguf.txt" | head -1)"
	# torch first, from the CPU index (the PyPI aarch64 wheel pulls CUDA libraries a converter never uses).
	uv pip install -q "torch==$torch" --index-url "$CPU_INDEX"
	(cd "$LLAMA_CPP/requirements" && grep -hv -e '^torch' -e '^--extra-index-url' -e '^gguf' requirements-convert_legacy_llama.txt requirements-convert_hf_to_gguf.txt | grep -v '^-r' >"$tmp/rest.txt")
	uv pip install -q -r "$tmp/rest.txt" -c <(echo "torch==$torch")
	{
		echo "# llama.cpp $commit"
		uv pip freeze --exclude-editable | grep -v '^gguf'
	} >"$LOCK"
	;;
"")
	[[ -f "$LOCK" ]] || { echo "no $LOCK yet: run with --resolve once" >&2; exit 2; }
	locked="$(sed -n 's/^# llama.cpp //p' "$LOCK")"
	[[ "$locked" == "$commit" ]] || { echo "the lock is for llama.cpp $locked, $LLAMA_CPP is at $commit: re-resolve" >&2; exit 2; }
	grep '^torch==' "$LOCK" >"$tmp/torch.txt"
	grep -v -e '^torch==' -e '^#' "$LOCK" >"$tmp/rest.txt"
	uv pip install -q -r "$tmp/torch.txt" --index-url "$CPU_INDEX"
	uv pip install -q --no-deps -r "$tmp/rest.txt"
	;;
*)
	echo "usage: $0 [--resolve]" >&2
	exit 2
	;;
esac
uv pip install -q --no-deps -e "$LLAMA_CPP/gguf-py"
"$VENV/bin/python" -c "import torch, transformers, gguf; print(f'converter venv: torch {torch.__version__}, transformers {transformers.__version__}, gguf (llama.cpp $commit)')"
