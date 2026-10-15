// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * `IYYE2_REMOTE_MODEL` (plan 0.012) and `IYYE2_THINKING_MODEL`, kept apart from `remote.ts` so the
 * configuration loads nothing else.
 */

/**
 * `IYYE2_REMOTE_MODEL`: `<registry model>@<endpoint>=https://<address>:<port>`, a llama-server serving a
 * registry model. `IYYE2_THINKING_MODEL`: the same shape for any OpenAI-compatible server (rapid-mlx on the
 * MBP, 2026-10-14) that serves the thinking tool only; its model is named by the server, not the registry.
 */
export interface RemoteModelConfig {
	/** `llama`: llama-server with a registry model, checked by `/props`; `openai`: checked by `/v1/models`. */
	kind: "llama" | "openai";
	/** The model the endpoint serves: a registry name (`qwen38-27b-tak`), or the last part of the server's id. */
	model: string;
	/** The machine's short name (`mbp`). */
	endpoint: string;
	/** Its llama-server, `https://192.168.1.177:8190`. */
	url: string;
}

export class RemoteConfigError extends Error {}

export function parseRemoteModel(v: string | undefined): RemoteModelConfig | null {
	return parse(v, "llama", "IYYE2_REMOTE_MODEL", "qwen38-27b-tak@mbp=https://192.168.1.177:8190");
}

export function parseThinkingModel(v: string | undefined): RemoteModelConfig | null {
	return parse(v, "openai", "IYYE2_THINKING_MODEL", "qwen3.8-flash-next-q4@mbp=https://192.168.1.177:8191");
}

function parse(
	v: string | undefined,
	kind: RemoteModelConfig["kind"],
	variable: string,
	example: string,
): RemoteModelConfig | null {
	const s = v?.trim();
	if (!s) return null;
	const m = /^([A-Za-z0-9._-]+)@([a-z0-9-]+)=(https:\/\/[^\s/]+)\/?$/.exec(s);
	if (!m) throw new RemoteConfigError(`${variable} must look like ${example}, got ${JSON.stringify(s)}`);
	return { kind, model: m[1]!, endpoint: m[2]!, url: m[3]! };
}

/** The remote model's registry name: `<model>@<endpoint>`. */
export function remoteName(c: RemoteModelConfig): string {
	return `${c.model}@${c.endpoint}`;
}
