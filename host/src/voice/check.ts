// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The voice's meaning check (plan 0.009 §2.3, CH0): deterministic, like
 * `summaryProblem` and the citation checks. A rephrasing may change words,
 * order and tone; it may not add, drop or change what the message says.
 *
 * - **Fixed segments** must survive exactly, as a multiset: numbers (times,
 *   dates and amounts included), URLs, e-mail addresses, @mentions, file names
 *   and paths, hashes, quoted strings, and names (the contacts Iyye knows, and
 *   any capitalized word that does not start a sentence). Nothing of these
 *   kinds may be added either.
 * - **Polarity:** a negation, a failure or a hedge ("may not have arrived") in
 *   the original must still be there, and none may be added.
 * - **Promises and reports:** "I will …" and "it is done / I sent …" (and the
 *   Russian forms) may neither appear nor disappear; a failure may become a
 *   negation ("could not reach" → "did not answer"), never vanish.
 * - **Language** (Latin vs Cyrillic share) and **length** stay close.
 *
 * It errs toward refusing: a refused rephrasing means the original goes out.
 *
 * `maskFixed` / `unmask`: the voice sees fixed segments as placeholders
 * (`⟦1⟧`), so it cannot change them; every placeholder must come back exactly
 * once, then the host puts the segments back.
 */

export type SegmentKind = "url" | "email" | "mention" | "path" | "hash" | "quote" | "number" | "name";

export interface Segment {
	kind: SegmentKind;
	text: string;
	start: number;
	end: number;
}

/** Order matters: earlier kinds claim their characters first. */
const PATTERNS: [SegmentKind, RegExp][] = [
	["url", /\bhttps?:\/\/[^\s<>()"'«»“”]+[^\s<>()"'«»“”.,;:!?]/gu],
	["email", /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gu],
	["mention", /(?<![\w@])@\w{3,}/gu],
	["quote", /"[^"\n]{1,200}"|“[^”\n]{1,200}”|«[^»\n]{1,200}»|`[^`\n]{1,200}`/gu],
	[
		"path",
		/(?<![\p{L}\d])(?:~?\/)?(?:[\w.-]+\/)+[\w.-]*[\w-]|(?<![\p{L}\d.])[\w-]+\.(?:ts|js|mjs|json|md|py|sh|sql|txt|csv|log|yml|yaml|toml|gguf|db|png|jpe?g|pdf)\b/gu,
	],
	["hash", /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/gu],
	["number", /\d+(?:[.,:/-]\d+)*/gu],
];

/** Words that may be capitalized without being a name. */
const NOT_NAMES = new Set(["i", "iyye", "ok", "okay"]);

/** The fixed segments of a text, left to right, never overlapping. */
export function fixedSegments(text: string, names: readonly string[] = []): Segment[] {
	const taken: Segment[] = [];
	const free = (s: number, e: number) => taken.every((t) => e <= t.start || s >= t.end);
	const add = (kind: SegmentKind, s: number, e: number) => {
		if (free(s, e)) taken.push({ kind, text: text.slice(s, e), start: s, end: e });
	};
	for (const [kind, re] of PATTERNS) for (const m of text.matchAll(re)) add(kind, m.index!, m.index! + m[0].length);
	// Known names anywhere (longest first, so "Anna Maria" is one segment).
	for (const name of [...names].filter((n) => n.trim().length >= 2).sort((a, b) => b.length - a.length)) {
		const re = new RegExp(`(?<![\\p{L}\\d])${escapeRe(name.trim())}(?![\\p{L}\\d])`, "giu");
		for (const m of text.matchAll(re)) add("name", m.index!, m.index! + m[0].length);
	}
	// Any other capitalized word that does not start a sentence (or a line, or a list item).
	for (const m of text.matchAll(/\p{Lu}[\p{L}'’-]*/gu)) {
		const w = m[0];
		if (NOT_NAMES.has(w.toLowerCase().split(/['’]/)[0]!) || w.length < 2) continue;
		if (sentenceStart(text, m.index!)) continue;
		add("name", m.index!, m.index! + w.length);
	}
	return taken.sort((a, b) => a.start - b.start);
}

function sentenceStart(text: string, at: number): boolean {
	const before = text.slice(0, at).replace(/[\s*_#>"“«(-]+$/u, "");
	return (
		before === "" || /[.!?:\n•·]$|^\s*\d+[.)]$/u.test(before) || /\n\s*(?:[-*•]|\d+[.)])?$/u.test(text.slice(0, at))
	);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A segment as compared: numbers without grouping spaces, names case-insensitively, the rest exactly. */
function key(s: Pick<Segment, "kind" | "text">): string {
	if (s.kind === "name") return `name:${s.text.toLowerCase()}`;
	if (s.kind === "number") return `number:${s.text.replace(/,(?=\d{3}\b)/g, "")}`;
	if (s.kind === "url") return `url:${s.text.replace(/\/$/, "")}`;
	return `${s.kind}:${s.text}`;
}

const PLACEHOLDER = /⟦(\d{1,3})⟧/gu;

/** The text with every fixed segment replaced by `⟦n⟧` (1-based), and the segments in order. */
export function maskFixed(text: string, names: readonly string[] = []): { masked: string; segments: string[] } {
	const segs = fixedSegments(text, names);
	let out = "";
	let at = 0;
	for (const [i, s] of segs.entries()) {
		out += `${text.slice(at, s.start)}⟦${i + 1}⟧`;
		at = s.end;
	}
	return { masked: out + text.slice(at), segments: segs.map((s) => s.text) };
}

/** The rephrased masked text with its segments put back, or why not (a placeholder lost, repeated or invented). */
export function unmask(masked: string, segments: readonly string[]): string | { why: string } {
	const seen = new Map<number, number>();
	for (const m of masked.matchAll(PLACEHOLDER)) {
		const n = Number(m[1]);
		seen.set(n, (seen.get(n) ?? 0) + 1);
	}
	for (let i = 1; i <= segments.length; i++) {
		const c = seen.get(i) ?? 0;
		if (c === 0) return { why: `placeholder ${i} was dropped` };
		if (c > 1) return { why: `placeholder ${i} was repeated` };
	}
	for (const n of seen.keys()) if (n < 1 || n > segments.length) return { why: `placeholder ${n} was invented` };
	if (/[⟦⟧]/u.test(masked.replace(PLACEHOLDER, ""))) return { why: "a placeholder was damaged" };
	return masked.replace(PLACEHOLDER, (_, n: string) => segments[Number(n) - 1]!);
}

const NEGATION =
	/\b(?:not|no|never|none|nothing|nobody|cannot|without|neither|nor)\b|n['’]t\b|(?<![\p{L}])(?:не|нет|ни|никогда|ничего|никто|нельзя|без)(?![\p{L}])/giu;
const FAILURE =
	/\b(?:fail\w*|error\w*|problem\w*|unable|unreachable|broken|lost|down|could not|couldn['’]t|may not|might not|unknown)\b|(?<![\p{L}])(?:ошибк\p{L}*|сбо\p{L}*|не удалось|не получилось|недоступ\p{L}*|проблем\p{L}*)/giu;
const HEDGE =
	/\b(?:maybe|perhaps|probably|might|may|likely|unsure|not sure|i think|seems?)\b|(?<![\p{L}])(?:возможно|наверное|вероятно|кажется|похоже)(?![\p{L}])/giu;
/** Something Iyye says it will do. */
const PROMISE =
	/\bI(?:['’]ll| will| shall| am going to|['’]m going to| promise)\b|(?<![\p{L}])(?:сделаю|пришлю|напомню|отправлю|напишу|проверю|сохраню|запишу|обещаю)(?![\p{L}])/giu;
/** Something reported as done, active or passive ("I saved it", "it is saved", "готово"). */
const DONE =
	/\b(?:sent|set|scheduled|saved|created|booked|done|written|added|reminded|finished|completed|recorded|noted)\b|(?<![\p{L}])(?:сделал\p{L}*|отправил\p{L}*|напомнил\p{L}*|сохранил\p{L}*|записал\p{L}*|создал\p{L}*|сделано|отправлено|записано|сохранен\p{L}*|создано|готово)(?![\p{L}])/giu;

const count = (re: RegExp, text: string) => (text.match(re) ?? []).length;

function cyrillicShare(text: string): number {
	const letters = text.match(/\p{L}/gu) ?? [];
	if (letters.length === 0) return 0;
	return letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length / letters.length;
}

/** Why `rephrased` does not say what `original` says (null: it does, as far as the host can tell). */
export function voiceProblem(original: string, rephrased: string, names: readonly string[] = []): string | null {
	const a = original.trim();
	const b = rephrased.trim();
	if (!b) return "empty";
	if (/[⟦⟧]/u.test(b)) return "a placeholder was left in";
	if (b.length > Math.max(a.length * 1.6, a.length + 60)) return "too long";
	if (b.length < Math.min(a.length * 0.5, a.length - 20)) return "too short";
	if (Math.abs(cyrillicShare(a) - cyrillicShare(b)) > 0.3) return "the language changed";
	const tally = (segs: Segment[]) => {
		const m = new Map<string, number>();
		for (const s of segs) m.set(key(s), (m.get(key(s)) ?? 0) + 1);
		return m;
	};
	const before = tally(fixedSegments(a, names));
	const after = tally(fixedSegments(b, names));
	for (const [k, n] of before) {
		if ((after.get(k) ?? 0) >= n) continue;
		// A name may move to the start of a sentence, and a Russian one takes case endings ("Лиссабон", "в Лиссабоне").
		if (k.startsWith("name:") && nameOccurrences(b, k.slice(5)) >= n) continue;
		return `dropped ${k}`;
	}
	for (const [k, n] of after) {
		if ((before.get(k) ?? 0) >= n) continue;
		// A name the rephrasing moved to the start of a sentence is not new; a known word that now starts one is fine too.
		if (k.startsWith("name:") && nameOccurrences(a, k.slice(5)) >= n) continue;
		return `added ${k}`;
	}
	const has = (re: RegExp, t: string) => count(re, t) > 0;
	// A problem said as a negation ("could not reach" → "did not answer") is the same problem.
	// (as many negations as before: "I reached it: no rain" is not "I could not reach it, so I don't know").
	if (has(FAILURE, a) && !has(FAILURE, b) && count(NEGATION, b) < Math.max(1, count(NEGATION, a)))
		return "dropped a failure";
	if (!has(FAILURE, a) && !has(NEGATION, a) && has(FAILURE, b)) return "added a failure";
	for (const [label, re] of [
		["a negation", NEGATION],
		["a hedge", HEDGE],
		["a promise", PROMISE],
		["a report of something done", DONE],
	] as const) {
		if (has(re, a) && !has(re, b)) return `dropped ${label}`;
		if (!has(re, a) && has(re, b)) return `added ${label}`;
	}
	return null;
}

/** How often a name occurs as a word, in any position; a Cyrillic name by its stem (case endings). */
function nameOccurrences(text: string, name: string): number {
	const cyrillic = /\p{Script=Cyrillic}/u.test(name);
	const stem = cyrillic && name.length > 3 ? name.slice(0, Math.max(3, name.length - 2)) : name;
	const re = new RegExp(`(?<![\\p{L}\\d])${escapeRe(stem)}${cyrillic ? "\\p{L}{0,3}" : ""}(?![\\p{L}\\d])`, "giu");
	return (text.match(re) ?? []).length;
}
