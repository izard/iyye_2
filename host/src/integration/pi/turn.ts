// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * One conversational turn on a Pi session (plan M3).
 *
 * The reply is the text of the last assistant message, taken only after
 * `agent_settled`: Pi will not continue on its own, so no partial or
 * intermediate text is ever treated as the answer. An empty reply, a model
 * error or an abort is a failed turn, never a reply (HLD §7.3).
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type TurnResult =
	| { ok: true; text: string; model: string }
	| { ok: false; reason: "empty" | "truncated" | "error" | "aborted" | "busy"; message: string };

interface AssistantLike {
	role: "assistant";
	content: { type: string; text?: string }[];
	stopReason?: string;
	errorMessage?: string;
	model?: string;
}

export async function runTurn(session: AgentSession, text: string, signal?: AbortSignal): Promise<TurnResult> {
	if (session.isStreaming) return { ok: false, reason: "busy", message: "a turn is already running on this session" };
	if (signal?.aborted) return { ok: false, reason: "aborted", message: "aborted before start" };

	let last: AssistantLike | null = null;
	let settled = false;
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
			last = event.message as unknown as AssistantLike;
		} else if (event.type === "agent_settled") {
			settled = true;
		}
	});
	const onAbort = () => void session.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		// Templates and skill commands are off: message text is data, and "/..." from a
		// contact must never be interpreted by Pi.
		// Pi emits agent_settled before prompt() resolves, so by now the run is over.
		await session.prompt(text, { expandPromptTemplates: false, source: "rpc" });
		if (!settled || session.isStreaming) {
			return { ok: false, reason: "error", message: "Pi returned before the run settled" };
		}
	} catch (err) {
		return signal?.aborted
			? { ok: false, reason: "aborted", message: "aborted" }
			: { ok: false, reason: "error", message: (err as Error).message };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
	}
	return classify(last, signal);
}

function classify(last: AssistantLike | null, signal: AbortSignal | undefined): TurnResult {
	if (signal?.aborted || last?.stopReason === "aborted") return { ok: false, reason: "aborted", message: "aborted" };
	if (!last) return { ok: false, reason: "error", message: "the model produced no message" };
	if (last.stopReason === "error") {
		return { ok: false, reason: "error", message: last.errorMessage ?? "model error" };
	}
	// Only a reply the model finished is a reply; a cut-off one is partial text (HLD §7.3).
	if (last.stopReason === "length") {
		return { ok: false, reason: "truncated", message: "the reply hit the output token limit" };
	}
	if (last.stopReason !== "stop") {
		return { ok: false, reason: "error", message: `unexpected stop reason ${String(last.stopReason)}` };
	}
	const text = last.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("")
		.trim();
	if (!text) return { ok: false, reason: "empty", message: "the model returned an empty reply" };
	return { ok: true, text, model: last.model ?? "unknown" };
}
