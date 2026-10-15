// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Mail Iyye received (plan 0.015, migration 042): the owner's `/email` view and the day summary's count. */

import type { Db } from "./db.ts";

interface InboxRow {
	id: string;
	from_address: string;
	from_name: string | null;
	subject: string;
	authenticated: number;
	auth_summary: string | null;
	verdict: string;
	reason: string | null;
	received_at: string;
	trusted: number | null;
	display_name: string | null;
	action_state: string | null;
}

const VERDICT: Record<string, string> = {
	queued: "waiting",
	replied: "answered",
	ignored: "read, no reply needed",
	failed: "could not be answered",
	dropped: "not read",
};

const DROP: Record<string, string> = {
	no_sender: "no sender",
	own_address: "from Iyye itself",
	auto_reply: "an automatic reply",
	mailing_list: "a mailing list",
	bulk: "bulk mail",
	bounce: "a bounce",
	no_reply_sender: "a no-reply address",
	too_large: "too large",
	no_text: "empty",
	unauthenticated: "the sender is not verified",
	duplicate_message: "already received",
	daily_cap: "the day's limit for untrusted senders",
	sender_daily_cap: "the sender's limit for the day",
};

/** `/email`: the latest mails with what was decided, and the poller's state. */
export function emailInboxReport(db: Db, status: string, limit = 20): string {
	const rows = db
		.prepare(
			`SELECT m.*, c.trusted, c.display_name,
				(SELECT a.state FROM actions a WHERE a.event_id = m.event_id AND a.kind = 'reply' ORDER BY a.created_at DESC LIMIT 1) AS action_state
			 FROM email_inbox m LEFT JOIN contacts c ON c.id = m.contact_id
			 ORDER BY m.received_at DESC, m.rowid DESC LIMIT ?`,
		)
		.all(limit) as InboxRow[];
	const lines = [`mailbox: ${status}`];
	if (rows.length === 0) return [...lines, "no mail received yet"].join("\n");
	lines.push(`latest ${rows.length} mails (newest first):`);
	for (const r of rows) {
		const who = r.display_name ?? r.from_name ?? "";
		const trust = r.trusted === 1 ? "trusted" : r.trusted === 0 ? "not trusted" : "";
		const verdict =
			r.verdict === "dropped"
				? `not read: ${DROP[r.reason ?? ""] ?? r.reason ?? "?"}`
				: r.verdict === "replied" && r.action_state && r.action_state !== "delivered"
					? `answered, reply ${r.action_state}`
					: `${VERDICT[r.verdict] ?? r.verdict}${r.verdict === "failed" && r.reason ? ` (${r.reason.slice(0, 80)})` : ""}`;
		lines.push(
			`  ${r.received_at.slice(0, 16).replace("T", " ")} ${who ? `${who} ` : ""}<${r.from_address}>${trust ? ` (${trust})` : ""} · ${JSON.stringify(r.subject.slice(0, 60))} · ${verdict}${r.authenticated ? "" : " · unverified sender"}`,
		);
	}
	return lines.join("\n");
}

/** The day summary's line: counts only, never senders or subjects. */
export function emailDayLine(db: Db, from: string, to: string): string | null {
	const rows = db
		.prepare(
			"SELECT verdict, count(*) AS n FROM email_inbox WHERE received_at >= ? AND received_at < ? GROUP BY verdict",
		)
		.all(from, to) as { verdict: string; n: number }[];
	if (rows.length === 0) return null;
	const n = (v: string) => rows.find((r) => r.verdict === v)?.n ?? 0;
	const total = rows.reduce((a, r) => a + r.n, 0);
	const parts = [
		n("replied") ? `answered ${n("replied")}` : "",
		n("ignored") ? `read without a reply ${n("ignored")}` : "",
		n("failed") ? `could not be answered ${n("failed")}` : "",
		n("queued") ? `still waiting ${n("queued")}` : "",
		n("dropped") ? `not read (automatic, unverified or over the limits) ${n("dropped")}` : "",
	].filter(Boolean);
	return `Mail received: ${total} (${parts.join("; ")}).`;
}

/** The owner's notices today about unverified mail claiming a known address (at most a few a day). */
export function spoofNoticesToday(db: Db, now = new Date()): number {
	const since = new Date(now);
	since.setHours(0, 0, 0, 0);
	return (
		db
			.prepare(
				"SELECT count(*) AS n FROM actions WHERE idempotency_key LIKE 'notice:email-unverified:%' AND created_at >= ?",
			)
			.get(since.toISOString()) as { n: number }
	).n;
}
