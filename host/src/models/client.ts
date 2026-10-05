// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP client for the llama.cpp router's model API, as observed on builds 9542 and 11362
 * (see host/PINS.md): `GET /health`, `GET /models`, `POST /models/load`,
 * `POST /models/unload`. Load and unload are asynchronous: the POST returns
 * at once and `GET /models` reports progress. Callers decide outcomes from the
 * reported status, never from error message text.
 */

export type RouterStatusValue = "loaded" | "loading" | "unloaded" | "sleeping";

export interface RouterModelStatus {
	value: RouterStatusValue | string;
	/** Set when the last load attempt's process exited with an error. */
	failed: boolean;
	exitCode: number | null;
}

export interface RouterReply {
	ok: boolean;
	httpStatus: number;
	message: string;
}

export class RouterUnreachable extends Error {}

export class RouterClient {
	readonly baseUrl: string;
	readonly timeoutMs: number;

	constructor(baseUrl: string, timeoutMs = 5000) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.timeoutMs = timeoutMs;
	}

	async health(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(this.timeoutMs) });
			await res.body?.cancel();
			return res.ok;
		} catch {
			return false;
		}
	}

	/** Every model id the router knows, with its status. Throws RouterUnreachable if the router does not answer. */
	async listModels(): Promise<Map<string, RouterModelStatus>> {
		const body = (await this.request("GET", "/models")) as { data?: unknown };
		const out = new Map<string, RouterModelStatus>();
		if (!Array.isArray(body?.data)) throw new RouterUnreachable("GET /models returned no data array");
		for (const entry of body.data as { id?: unknown; status?: Record<string, unknown> }[]) {
			if (typeof entry?.id !== "string") continue;
			const s = entry.status ?? {};
			out.set(entry.id, {
				value: typeof s.value === "string" ? s.value : "unknown",
				failed: s.failed === true,
				exitCode: typeof s.exit_code === "number" ? s.exit_code : null,
			});
		}
		return out;
	}

	load(model: string): Promise<RouterReply> {
		return this.post("/models/load", { model });
	}

	unload(model: string): Promise<RouterReply> {
		return this.post("/models/unload", { model });
	}

	/**
	 * Ask the model for one token. Success is HTTP 200 with a `choices` entry;
	 * the content may be empty, because reasoning models spend the first
	 * tokens in `reasoning_content`.
	 */
	async probeCompletion(model: string, timeoutMs = 60_000): Promise<RouterReply> {
		try {
			const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 1 }),
				signal: AbortSignal.timeout(timeoutMs),
			});
			const body = (await res.json().catch(() => ({}))) as { choices?: unknown[]; error?: { message?: string } };
			const ok = res.ok && Array.isArray(body.choices) && body.choices.length > 0;
			return { ok, httpStatus: res.status, message: ok ? "ok" : (body.error?.message ?? "no choices in response") };
		} catch (err) {
			return { ok: false, httpStatus: 0, message: (err as Error).message };
		}
	}

	private async post(path: string, payload: unknown): Promise<RouterReply> {
		let res: Response;
		try {
			res = await fetch(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			throw new RouterUnreachable(`POST ${path}: ${(err as Error).message}`);
		}
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		return { ok: res.ok, httpStatus: res.status, message: body.error?.message ?? (res.ok ? "ok" : res.statusText) };
	}

	private async request(method: string, path: string): Promise<unknown> {
		try {
			const res = await fetch(`${this.baseUrl}${path}`, { method, signal: AbortSignal.timeout(this.timeoutMs) });
			if (!res.ok) throw new RouterUnreachable(`${method} ${path}: HTTP ${res.status}`);
			return await res.json();
		} catch (err) {
			if (err instanceof RouterUnreachable) throw err;
			throw new RouterUnreachable(`${method} ${path}: ${(err as Error).message}`);
		}
	}
}
