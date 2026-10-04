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
	const cited = [...new Set(tokens)];
	return {
		cited,
		invented: cited.filter((t) => !flat.includes(t.replace(/GB|MB|%$/, "")) && !flat.includes(t)),
	};
}
