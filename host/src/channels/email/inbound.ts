// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * One received mail, read (plan 0.015): who it claims to be from, whether the
 * receiving server vouches for that, whether a machine sent it, and its text.
 * Pure: no database, no network.
 *
 * - **Authentication** is the receiving server's verdict, never the sender's:
 *   only an `Authentication-Results` header whose authserv-id is the host the
 *   topmost `Received` header names (`by <host>`), that host one of the
 *   provider's (`authservSuffix`, e.g. `hostinger.io`), and nothing below the
 *   second `Received` (headers the sender wrote are further down). The From
 *   address is genuine when DMARC passed for its domain, or DKIM passed for a
 *   domain aligned with it. SPF alone is not enough: it vouches for the
 *   envelope sender, not the From a person reads.
 * - **Machines** (auto-replies, mailing lists, bulk mail, bounces) are named,
 *   so admission drops them before any model sees them.
 * - **Text:** the plain part, else the HTML as text; quoted earlier messages
 *   are cut; at most `TEXT_MAX` characters.
 */

import PostalMime, { type Email } from "postal-mime";
import { htmlToText } from "../../tools/html-text.ts";

export const TEXT_MAX = 20_000;
export const SUBJECT_MAX = 300;

export interface InboundMail {
	/** With angle brackets, sanitized; null when the mail has none usable. */
	messageId: string | null;
	from: { address: string; name: string } | null;
	subject: string;
	text: string;
	/** The text was longer than TEXT_MAX. */
	truncated: boolean;
	inReplyTo: string | null;
	/** Up to the last 10 ids, space-separated. */
	references: string | null;
	/** ISO date the sender claims, if it parses. */
	date: string | null;
	authenticated: boolean;
	/** e.g. "dmarc=pass(gmail.com) dkim=pass(gmail.com) spf=pass", or why there is no verdict. */
	authSummary: string;
	/** A machine sent it: never answered. */
	machine: "auto_reply" | "mailing_list" | "bulk" | "bounce" | "no_reply_sender" | null;
	attachments: number;
}

export async function readMail(raw: Uint8Array | string, authservSuffix: string): Promise<InboundMail> {
	const email = await PostalMime.parse(raw, { maxNestingDepth: 50, maxPartCount: 500 });
	const from = email.from && "address" in email.from && email.from.address ? email.from : null;
	const address = from?.address?.trim().toLowerCase() ?? "";
	const auth = authentication(email, address, authservSuffix);
	const body = email.text?.trim() ? email.text : email.html ? htmlToText(email.html).text : "";
	const cut = withoutQuotes(body);
	return {
		messageId: msgId(email.messageId),
		from:
			from && address
				? {
						address,
						name: (from.name ?? "")
							.replace(/[\r\n<>"]/g, "")
							.trim()
							.slice(0, 80),
					}
				: null,
		subject: (email.subject ?? "").replace(/\s+/g, " ").trim().slice(0, SUBJECT_MAX),
		text: cut.slice(0, TEXT_MAX),
		truncated: cut.length > TEXT_MAX,
		inReplyTo: msgId(email.inReplyTo),
		references:
			(email.references ?? "")
				.split(/\s+/)
				.map(msgId)
				.filter((x): x is string => x !== null)
				.slice(-10)
				.join(" ") || null,
		date: email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : null,
		authenticated: auth.ok,
		authSummary: auth.summary,
		machine: machine(email, address),
		attachments: email.attachments.length,
	};
}

/** A message id as `<…>`, or null: no spaces, quotes, brackets or line breaks inside, at most 250 characters. */
export function msgId(v: string | undefined | null): string | null {
	const t = (v ?? "").trim();
	const inner = t.startsWith("<") && t.endsWith(">") ? t.slice(1, -1) : t;
	return /^[^<>\s"\\]{3,250}$/.test(inner) && inner.includes("@") ? `<${inner}>` : null;
}

function header(email: Email, key: string): string | null {
	return email.headers.find((h) => h.key === key)?.value ?? null;
}

function machine(email: Email, address: string): InboundMail["machine"] {
	const auto = header(email, "auto-submitted");
	if ((auto && auto.trim().toLowerCase() !== "no") || header(email, "x-autoreply") || header(email, "x-autorespond"))
		return "auto_reply";
	const local = address.split("@")[0] ?? "";
	const ct = header(email, "content-type") ?? "";
	if (
		/^(mailer-daemon|postmaster)$/i.test(local) ||
		/multipart\/report/i.test(ct) ||
		(header(email, "return-path") ?? "").trim() === "<>"
	)
		return "bounce";
	if (header(email, "list-id") || header(email, "list-unsubscribe") || header(email, "list-post"))
		return "mailing_list";
	if (/^(bulk|list|junk|auto_reply)$/i.test((header(email, "precedence") ?? "").trim())) return "bulk";
	// An address that says nobody reads replies (notifications, receipts): a reply would only bounce.
	if (/^(no-?reply|do-?not-?reply|notifications?|mailer|bounces?)([+._-].*)?$/i.test(local)) return "no_reply_sender";
	return null;
}

/** The receiving server's verdict on the From address (see the module comment). */
export function authentication(
	email: Pick<Email, "headers">,
	fromAddress: string,
	authservSuffix: string,
): { ok: boolean; summary: string } {
	const fromDomain = fromAddress.split("@")[1] ?? "";
	if (!fromDomain) return { ok: false, summary: "no From address" };
	const received = email.headers.map((h, i) => ({ h, i })).filter((x) => x.h.key === "received");
	const first = received[0];
	const by = first ? /\bby\s+([A-Za-z0-9.-]+)/i.exec(first.h.value)?.[1]?.toLowerCase() : undefined;
	const suffix = authservSuffix.toLowerCase().replace(/^\./, "");
	if (!first || !by || !(by === suffix || by.endsWith(`.${suffix}`)))
		return { ok: false, summary: `not received by ${suffix}` };
	const end = received[1]?.i ?? email.headers.length;
	const ar = email.headers
		.slice(first.i + 1, end)
		.find(
			(h) =>
				h.key === "authentication-results" && h.value.split(";")[0]?.trim().split(/\s+/)[0]?.toLowerCase() === by,
		);
	if (!ar) return { ok: false, summary: `no authentication results from ${by}` };
	const results = ar.value
		.split(";")
		.slice(1)
		.map((part) => {
			const m = /^\s*(dkim|dmarc|spf|arc)\s*=\s*([a-z]+)/i.exec(part);
			if (!m) return null;
			const prop = (k: string) =>
				new RegExp(`\\b${k.replace(".", "\\.")}=([^\\s;]+)`, "i").exec(part)?.[1]?.toLowerCase() ?? null;
			return {
				method: m[1]!.toLowerCase(),
				result: m[2]!.toLowerCase(),
				d: prop("header.d"),
				from: prop("header.from"),
			};
		})
		.filter((r): r is NonNullable<typeof r> => r !== null);
	const aligned = (d: string | null) =>
		!!d && (d === fromDomain || fromDomain.endsWith(`.${d}`) || d.endsWith(`.${fromDomain}`));
	const dmarc = results.find((r) => r.method === "dmarc" && r.result === "pass" && aligned(r.from));
	const dkim = results.find((r) => r.method === "dkim" && r.result === "pass" && aligned(r.d));
	const summary = results
		.filter((r) => r.method !== "arc")
		.map(
			(r) =>
				`${r.method}=${r.result}${r.method === "dkim" && r.d ? `(${r.d})` : r.method === "dmarc" && r.from ? `(${r.from})` : ""}`,
		)
		.join(" ");
	return { ok: !!(dmarc || dkim), summary: summary || "no results" };
}

/** The writer's own words: quoted earlier messages and the lines introducing them are cut. */
export function withoutQuotes(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]!;
		const next = lines[i + 1] ?? "";
		// "On Thu, 15 Oct 2026 at 18:08, Alex <a@b> wrote:" (sometimes wrapped over two lines)
		if (/^\s*On .{4,300}wrote:\s*$/.test(l) || (/^\s*On .{4,200}$/.test(l) && /^.{0,200}wrote:\s*$/.test(next)))
			break;
		if (/^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(l)) break;
		// Outlook: a rule line or a "From:" block with "Sent:" just after
		if (/^\s*_{10,}\s*$/.test(l) && /^\s*From:/i.test(next)) break;
		if (/^\s*From:\s.+/i.test(l) && /^\s*(Sent|Date):\s.+/i.test(next)) break;
		if (/^\s*>/.test(l)) continue;
		out.push(l);
	}
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
