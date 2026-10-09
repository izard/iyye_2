// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * One streamed chat completion, for the host's direct calls that may run long
 * (the thinking and vision tools): tokens keep arriving, so no idle timeout
 * fires during a long think, and there is no time limit (owner directive).
 * Only the answer (`content`) is kept; reasoning is dropped.
 */
export async function streamChat(
	url: string,
	body: Record<string, unknown>,
	signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
	const res = await fetch(`${url}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...body, stream: true }),
		signal,
	});
	if (!res.ok || !res.body) throw new Error(`the model answered HTTP ${res.status}`);
	let text = "";
	let truncated = false;
	let buf = "";
	const decoder = new TextDecoder();
	for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
		buf += decoder.decode(chunk, { stream: true });
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			nl = buf.indexOf("\n");
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (data === "[DONE]") return { text, truncated };
			const ev = JSON.parse(data) as {
				choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
			};
			const c = ev.choices?.[0];
			if (c?.delta?.content) text += c.delta.content;
			if (c?.finish_reason === "length") truncated = true;
		}
	}
	return { text, truncated };
}
