// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Split text into chunks of at most `max` UTF-16 code units (Telegram's 4096
 * limit is measured that way), preferring a paragraph break, then a line
 * break, then a sentence end, then a space, and only then a hard cut. A
 * surrogate pair is never split. Returns [start, end) offsets that tile the
 * whole text, so every character is sent exactly once.
 */
export function splitOffsets(text: string, max: number): [number, number][] {
	if (!Number.isFinite(max) || text.length <= max) return [[0, text.length]];
	if (max < 2) throw new Error("chunk size must be at least 2");
	const out: [number, number][] = [];
	let start = 0;
	while (text.length - start > max) {
		const window = text.slice(start, start + max);
		const min = Math.floor(max / 2); // don't make tiny chunks just to hit a nice boundary
		let cut = lastBoundary(window, ["\n\n"], min);
		if (cut < 0) cut = lastBoundary(window, ["\n"], min);
		if (cut < 0) cut = lastBoundary(window, [". ", "! ", "? ", "。", ".\n"], min);
		if (cut < 0) cut = lastBoundary(window, [" ", "\t"], min);
		if (cut < 0) {
			cut = max;
			const code = text.charCodeAt(start + cut - 1);
			if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // keep the surrogate pair together
		}
		out.push([start, start + cut]);
		start += cut;
	}
	out.push([start, text.length]);
	return out;
}

/** Index just after the last occurrence of any separator, if it lies beyond `min`; else -1. */
function lastBoundary(window: string, separators: string[], min: number): number {
	let best = -1;
	for (const sep of separators) {
		const i = window.lastIndexOf(sep);
		if (i >= 0 && i + sep.length > min) best = Math.max(best, i + sep.length);
	}
	return best;
}
