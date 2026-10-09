// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** `IYYE2_REMOTE_MODEL` (plan 0.012), kept apart from `remote.ts` so the configuration loads nothing else. */

/** `IYYE2_REMOTE_MODEL`: `<registry model>@<endpoint>=https://<address>:<port>`. */
export interface RemoteModelConfig {
	/** The registry model the endpoint serves (`qwen38-27b-tak`). */
	model: string;
	/** The machine's short name (`mbp`). */
	endpoint: string;
	/** Its llama-server, `https://192.168.1.177:8190`. */
	url: string;
}

export class RemoteConfigError extends Error {}

export function parseRemoteModel(v: string | undefined): RemoteModelConfig | null {
	const s = v?.trim();
	if (!s) return null;
	const m = /^([A-Za-z0-9._-]+)@([a-z0-9-]+)=(https:\/\/[^\s/]+)\/?$/.exec(s);
	if (!m)
		throw new RemoteConfigError(
			`IYYE2_REMOTE_MODEL must look like qwen38-27b-tak@mbp=https://192.168.1.177:8190, got ${JSON.stringify(s)}`,
		);
	return { model: m[1]!, endpoint: m[2]!, url: m[3]! };
}

/** The remote model's registry name: `<model>@<endpoint>`. */
export function remoteName(c: RemoteModelConfig): string {
	return `${c.model}@${c.endpoint}`;
}
