// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Request-local trimming of earlier tool results (plan 0.004 follow-up, the
 * 2026-10-03 Telegram incident). Pi keeps every tool result in the
 * conversation, so a web page read once (up to 8,000 characters) was re-sent
 * with every later message: slower each turn, and the context filled up.
 *
 * In the request only (Pi restores the messages afterwards; the transcript
 * stays complete), a large tool result from an *earlier* turn becomes a
 * one-line stub that keeps its first line: the search query or page URL. The
 * current turn's results are never touched, including during a recovery step
 * (whose host note is not a turn boundary).
 *
 * Caching: the first request after a turn with large results changes its
 * tail once (the results become stubs), then stays stable.
 */

/** Tool results longer than this, from earlier turns, are replaced by a stub. */
export const TRIM_ABOVE_CHARS = 1000;

/** The host's own recovery note: a user-role message that is not a new turn. */
export const HOST_NOTE_PREFIX = "[Note from Iyye's host, not from the person]";

interface Msg {
	role: string;
	content?: unknown;
	toolName?: string;
}

function text(m: Msg): string {
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return m.content.map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

/** The index of the message that starts the current turn: the latest person-written user message. */
export function currentTurnStart(messages: readonly Msg[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "user" && !text(m).startsWith(HOST_NOTE_PREFIX) && !text(m).startsWith("<memory>")) return i;
	}
	return -1;
}

/** A copy of `messages` with large tool results before the current turn replaced by stubs. */
export function trimEarlierToolResults<T extends Msg>(messages: readonly T[]): T[] {
	const start = currentTurnStart(messages);
	return messages.map((m, i) => {
		if (i >= start || m.role !== "toolResult") return m;
		const body = text(m);
		if (body.length <= TRIM_ABOVE_CHARS) return m;
		const first = body.split("\n", 1)[0]!.slice(0, 300);
		return {
			...m,
			content: [
				{
					type: "text",
					text: `[Earlier ${m.toolName ?? "tool"} result, ${body.length} characters, not repeated here. It began: ${first} — call the tool again if you need its content.]`,
				},
			],
		};
	});
}
