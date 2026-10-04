// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * HTML to readable text for `web_fetch` (plan 0.004 §3.3), dependency-free:
 * the page's title and its main content as plain lines. Scripts, styles,
 * navigation, headers, footers, forms and other boilerplate are dropped; if
 * the page marks its main content (`<main>`, `<article>`), only that is kept.
 * Headings, paragraphs and list items become their own lines; links keep
 * their text. The result is data for the model, never markup.
 */

const DROP = ["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "head"];
const BOILERPLATE = ["nav", "header", "footer", "aside", "form", "button", "select", "dialog", "menu"];
const BLOCK =
	/<\/?(p|div|section|article|main|br|hr|h[1-6]|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|tfoot|blockquote|pre|figure|figcaption|caption|address|details|summary)\b[^>]*>/gi;

export interface PageText {
	title: string;
	text: string;
}

export function htmlToText(html: string): PageText {
	const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
		.replace(/\s+/g, " ")
		.trim();
	let body = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
	for (const tag of DROP) body = dropElement(body, tag);
	const main = largest(body, "main") ?? largest(body, "article");
	if (main) body = main;
	for (const tag of BOILERPLATE) body = dropElement(body, tag);
	body = body
		.replace(/<h([1-6])\b[^>]*>/gi, "\n\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<(td|th)\b[^>]*>/gi, " | ")
		.replace(BLOCK, "\n")
		.replace(/<[^>]+>/g, " ");
	const text = decodeEntities(body)
		.split("\n")
		.map((l) =>
			l
				.replace(/[ \t ]+/g, " ")
				.replace(/ ([.,;:!?)])/g, "$1")
				.replace(/([(«]) /g, "$1")
				.trim(),
		)
		.filter(
			(l, i, all) =>
				l !== "" &&
				l !== "-" &&
				!(l.startsWith("| ") && l.replace(/[|\s]/g, "") === "") &&
				(i === 0 || l !== all[i - 1]),
		)
		.join("\n");
	return { title, text };
}

/** Remove every `<tag …>…</tag>` (and unclosed opening tags). */
function dropElement(html: string, tag: string): string {
	return html
		.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ")
		.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
}

/** The inner HTML of the largest `<tag>` element, if any. */
function largest(html: string, tag: string): string | null {
	let best: string | null = null;
	for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi"))) {
		if (!best || m[1]!.length > best.length) best = m[1]!;
	}
	return best && best.replace(/<[^>]+>/g, "").trim().length > 200 ? best : null;
}

const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	laquo: "«",
	raquo: "»",
	ldquo: "“",
	rdquo: "”",
	lsquo: "‘",
	rsquo: "’",
	bull: "•",
	middot: "·",
	copy: "©",
	reg: "®",
	trade: "™",
	deg: "°",
	times: "×",
	minus: "−",
	euro: "€",
	pound: "£",
	shy: "",
	zwj: "",
	zwnj: "",
};

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, e: string) => {
		if (e[0] === "#") {
			const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
			return code > 0 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
		}
		return NAMED[e.toLowerCase()] ?? all;
	});
}
