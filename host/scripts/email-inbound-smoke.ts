// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The real receiving smoke (plan 0.015), run by the owner: reads the newest
 * mails in Iyye's mailbox with the host's own IMAP client and parser and
 * prints what admission would see (sender, whether the receiving server
 * vouches for it, whether a machine sent it, the first words). Read-only:
 * BODY.PEEK marks nothing seen, and no Iyye state is touched or answered.
 *
 *   cd host && node scripts/email-inbound-smoke.ts [--last 5] [--dir ~/.iyye2/email]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ImapSession } from "../src/channels/email/imap.ts";
import { readMail } from "../src/channels/email/inbound.ts";
import { loadInboundSettings } from "../src/channels/email/settings.ts";

const args = process.argv.slice(2);
const opt = (k: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1] : undefined;
};
const last = Number(opt("--last") ?? 5);
const dir = opt("--dir") ?? join(process.env.IYYE2_STATE_DIR || join(homedir(), ".iyye2"), "email");
const s = loadInboundSettings(dir);
if (typeof s === "string") {
	console.error(`email is not usable: ${s}`);
	process.exit(1);
}
console.log(
	`reading ${s.imap.user} on ${s.imap.host}:${s.imap.port}; authserv ${s.authserv ?? "(none: no sender would be authenticated)"}`,
);
const imap = await ImapSession.open(s.imap);
try {
	await imap.login();
	const box = await imap.select("INBOX");
	console.log(`INBOX: ${box.exists} messages, UIDVALIDITY ${box.uidvalidity}, UIDNEXT ${box.uidnext}`);
	const uids = (await imap.uidsAfter(0)).slice(-last);
	for (const uid of uids) {
		const size = await imap.size(uid);
		const raw = await imap.fetch(uid, size > 5_000_000 ? "header" : "whole");
		if (!raw) continue;
		const m = await readMail(raw, s.authserv ?? "");
		console.log(
			`\nUID ${uid} (${size} bytes) from ${m.from ? `${m.from.name} <${m.from.address}>` : "(none)"}\n  subject: ${JSON.stringify(m.subject)}\n  authenticated: ${m.authenticated} (${m.authSummary})${m.machine ? `\n  machine: ${m.machine}` : ""}\n  text: ${JSON.stringify(m.text.replace(/\s+/g, " ").slice(0, 120))}${m.truncated ? " (truncated)" : ""}\n  message-id ${m.messageId ?? "(none)"}${m.inReplyTo ? `, in reply to ${m.inReplyTo}` : ""}`,
		);
	}
} finally {
	await imap.logout();
}
