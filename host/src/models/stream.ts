// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** A streamed completion's answer. */
export interface StreamedChat {
	text: string;
	/** Cut off by `max_tokens`. */
	truncated: boolean;
	/** Why the stream stopped before finishing; absent when it finished. */
	error?: string;
}

/**
 * One streamed chat completion, for the host's direct calls that may run long
 * (the thinking and vision tools): tokens keep arriving, so no idle timeout
 * fires during a long think, and there is no time limit (owner directive).
 * Only the answer (`content`) is kept; reasoning is dropped.
 *
 * A stream is finished only by a `finish_reason`. A server that fails after
 * the response began (rapid-mlx: an `{"error": …}` frame, then `[DONE]`), or a
 * stream that ends without a finish, sets `error`: `text` is then only what
 * arrived before, never a whole answer. So does a connection that breaks
 * mid-answer (2026-10-19: Wi-Fi dropped a 20-minute think, and fetch's own
 * 300 s rule for a silent body ended it): what arrived is kept, never thrown
 * away with the error. A stop by `signal` still throws.
 */
export async function streamChat(
	url: string,
	body: Record<string, unknown>,
	signal: AbortSignal,
): Promise<StreamedChat> {
	const res = await fetch(`${url}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...body, stream: true }),
		signal,
	});
	if (!res.ok || !res.body) throw new Error(`the model answered HTTP ${res.status}`);
	let text = "";
	let truncated = false;
	let finished = false;
	let error: string | undefined;
	let buf = "";
	const decoder = new TextDecoder();
	const result = (): StreamedChat => {
		if (!error && !finished) error = "the stream ended before the answer was finished";
		return error ? { text, truncated, error } : { text, truncated };
	};
	const chunks = res.body as unknown as AsyncIterable<Uint8Array>;
	const iter = chunks[Symbol.asyncIterator]();
	try {
		return await read();
	} finally {
		await iter.return?.().catch(() => {});
	}

	async function read(): Promise<StreamedChat> {
		for (;;) {
			let next: IteratorResult<Uint8Array>;
			try {
				next = await iter.next();
			} catch (err) {
				if (signal.aborted) throw err;
				error = brokenStream(err);
				return result();
			}
			if (next.done) break;
			buf += decoder.decode(next.value, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "[DONE]") return result();
				const ev = JSON.parse(data) as {
					choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
					error?: { message?: unknown; code?: unknown } | string;
				};
				if (ev.error) {
					const e = ev.error;
					const message = typeof e === "string" ? e : typeof e.message === "string" ? e.message : "";
					const code = typeof e === "object" && typeof e.code === "string" ? ` (${e.code})` : "";
					error = `the server failed: ${message.slice(0, 200) || "no reason given"}${code}`;
					continue;
				}
				const c = ev.choices?.[0];
				if (c?.delta?.content) text += c.delta.content;
				if (c?.finish_reason) finished = true;
				if (c?.finish_reason === "length") truncated = true;
			}
		}
		return result();
	}
}

/** Why a stream's body stopped arriving, in words. */
export function brokenStream(err: unknown): string {
	const e = err as { message?: string; cause?: { code?: string; message?: string } };
	if (e?.cause?.code === "UND_ERR_BODY_TIMEOUT")
		return "nothing arrived from the server for 5 minutes, so the connection probably dropped";
	return `the connection broke (${(e?.cause?.message || e?.message || String(err)).slice(0, 200)})`;
}
