// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The real email smoke (plan 0.014), run by the owner once Iyye's own mailbox
 * is configured: one test mail through the real SMTP server, with the same
 * client and settings the host uses. Touches no Iyye state.
 *
 *   cd host && node scripts/email-smoke.ts <your address> [--dir ~/.iyye2/email]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { loadEmailSettings } from "../src/channels/email/settings.ts";
import { SmtpUncertain, sendMail } from "../src/channels/email/smtp.ts";
import { validAddress } from "../src/state/emails.ts";

const args = process.argv.slice(2);
const to = args[0];
const i = args.indexOf("--dir");
const dir =
	i >= 0 && args[i + 1] ? args[i + 1]! : join(process.env.IYYE2_STATE_DIR || join(homedir(), ".iyye2"), "email");
if (!to || !validAddress(to)) {
	console.error("usage: node scripts/email-smoke.ts <your address> [--dir <state>/email]");
	process.exit(2);
}
const s = loadEmailSettings(dir);
if (typeof s === "string") {
	console.error(`email is not usable: ${s}`);
	process.exit(1);
}
console.log(`sending from ${s.from} via ${s.host}:${s.port} (${s.security}) to ${to}…`);
const started = Date.now();
try {
	const r = await sendMail(s, {
		to,
		subject: "Iyye email smoke test — проверка",
		text: "This is a test mail from Iyye's own mailbox (scripts/email-smoke.ts).\nЕсли вы это читаете, всё работает.",
		messageId: `smoke-${Date.now()}@${s.from.split("@")[1]}`,
		date: new Date(),
	});
	if (r.ok) console.log(`accepted in ${Date.now() - started} ms: ${r.reply}`);
	else {
		console.error(`not sent (${r.retryable ? "may work later" : "will not work as configured"}): ${r.error}`);
		process.exit(1);
	}
} catch (err) {
	console.error(`${err instanceof SmtpUncertain ? "unknown: " : ""}${(err as Error).message}`);
	process.exit(1);
}
