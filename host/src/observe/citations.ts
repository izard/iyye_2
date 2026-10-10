// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether an investigation's answer is grounded (plan 0.007 S5, rule 1: only
 * records are evidence). The host extracts what the answer claims to have
 * found (commit hashes, file names, figures) and checks each one against the
 * text the tools returned in this investigation (and the question's own
 * evidence). An answer that cites nothing is narration: fruitless.
 *
 * From the S0 spike: models write figures in Markdown and LaTeX
 * (`**157.9 GB**`, `$56.4\text{ GB}$`), so the answer is normalised first.
 */

export interface CitationCheck {
	/** Concrete things the answer names. */
	cited: string[];
	/** Of those, the ones found nowhere in the tool results or the prompt. */
	invented: string[];
}

export function checkCitations(answer: string, grounded: string): CitationCheck {
	const text = answer
		.replace(/\$|\\text\{\s*|\}/g, "")
		.replace(/\*\*|`/g, "")
		.replace(/\\_/g, "_");
	const tokens = [
		...(text.match(/\b[0-9a-f]{7,40}\b/g) ?? []).filter((t) => /[a-f]/.test(t) && /\d/.test(t)),
		...(text.match(/\b\d+(?:\.\d+)?\s?(?:GB|MB|%)/g) ?? []).map((t) => t.replace(/\s/g, "")),
		...(text.match(/\b[\w./-]+\.(?:py|ts|js|mjs|md|txt|json|sh|toml|yaml|yml|sql|css|html)\b/g) ?? []),
	];
	const flat = grounded.replace(/\s/g, "");
	// Figures are matched where words stay apart ("56.4 GB of" must not read as the unit "GBof").
	const spaced = grounded.replace(/\$|\\text\{\s*|\}|\*\*|`/g, "").replace(/\s+/g, " ");
	const cited = [...new Set(tokens)];
	return { cited, invented: cited.filter((t) => !found(t, flat, spaced)) };
}

/**
 * A cited token in the grounded text as a whole: a figure only as a whole number ("12GB" is not in "512GB",
 * nor "1.5" in "11.52"; 2026-10-10 review), with its own unit (or its short form, "56.4G") or none; another
 * unit is another figure ("12GB" is not "12MB"). A hash or a file name as itself.
 */
function found(token: string, flat: string, spaced: string): boolean {
	const figure = /^(\d+(?:\.\d+)?)(GB|MB|%)$/.exec(token);
	if (!figure) return flat.includes(token);
	const n = figure[1]!.replace(".", "\\.");
	const unit = figure[2] === "%" ? "%" : `${figure[2]![0]}(?:i?B)?`;
	return new RegExp(`(?<![\\d.])${n} ?(?:${unit}(?![A-Za-z])|(?![\\d]|\\.\\d| ?[KMGTPkmgtp%]))`, "i").test(spaced);
}

/**
 * Whether a web investigation's answer is grounded (plan 0.010 M2): it must
 * cite at least one page by URL, and every URL it cites must be one the web
 * tools returned in this investigation. The question's own text never
 * grounds it (the person's words are what is being checked).
 */
export function checkWebCitations(answer: string, toolResults: string): CitationCheck {
	const norm = (u: string) => u.replace(/[.,;:!?)\]}>"'`*]+$/, "").replace(/\/$/, "");
	const cited = [...new Set((answer.match(/https?:\/\/[^\s<>()[\]"'`]+/g) ?? []).map(norm))];
	return { cited, invented: cited.filter((u) => !toolResults.includes(u)) };
}
