// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Iyye's own mailbox (plan 0.014; owner decision: a dedicated account, never
 * the owner's private one), in `<state>/email/`:
 *
 *   config.json   {"host": "smtp.gmail.com", "port": 465, "security": "tls",
 *                  "user": "iyye.assistant@gmail.com", "from": "iyye.assistant@gmail.com", "name": "Iyye"}
 *   password      the account's (app) password, one line, mode 0600
 *
 * Read at each use, so a changed password needs no restart. The password file
 * must not be readable by others; otherwise email is off.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validAddress } from "../../state/emails.ts";
import type { ImapSettings } from "./imap.ts";
import type { SmtpSettings } from "./smtp.ts";

export function emailDir(stateDir: string): string {
	return join(stateDir, "email");
}

/** The settings with the password, or why email cannot be used. */
export function loadEmailSettings(dir: string): SmtpSettings | string {
	const configFile = join(dir, "config.json");
	const passwordFile = join(dir, "password");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configFile, "utf8"));
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT"
			? `not configured (no ${configFile})`
			: `${configFile} is not valid JSON`;
	}
	const c = raw as Record<string, unknown>;
	const host = typeof c.host === "string" && /^[A-Za-z0-9.:-]+$/.test(c.host) ? c.host : null;
	const port = typeof c.port === "number" && Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : null;
	const security = c.security === "tls" || c.security === "starttls" ? c.security : null;
	const user = typeof c.user === "string" && c.user.trim() && !/[\r\n]/.test(c.user) ? c.user.trim() : null;
	const from = typeof c.from === "string" && validAddress(c.from) ? c.from : null;
	const name = c.name === undefined ? "Iyye" : typeof c.name === "string" && !/[\r\n<>"]/.test(c.name) ? c.name : null;
	if (!host || !port || !security || !user || !from || name === null)
		return `${configFile} needs host, port, security ("tls" or "starttls"), user and from (an address); name is optional`;
	try {
		if (process.platform !== "win32" && (statSync(passwordFile).mode & 0o077) !== 0)
			return `${passwordFile} is readable by others (chmod 600 it)`;
	} catch {
		return `no ${passwordFile}`;
	}
	const password = readFileSync(passwordFile, "utf8").replace(/\r?\n$/, "");
	if (!password) return `${passwordFile} is empty`;
	return { host, port, security, user, password, from, fromName: name || "Iyye" };
}

/**
 * Receiving (plan 0.015): the IMAP server (`imapHost`, default the SMTP host with `smtp.` → `imap.`;
 * `imapPort`, default 993, TLS) with the same login, and `authserv`, the receiving server's own domain in
 * the `Authentication-Results` it adds (default `hostinger.io` for Hostinger; without one no sender is
 * authenticated, so nothing is admitted).
 */
export interface InboundSettings {
	imap: ImapSettings;
	authserv: string | null;
	ownAddress: string;
}

export function loadInboundSettings(dir: string): InboundSettings | string {
	const smtp = loadEmailSettings(dir);
	if (typeof smtp === "string") return smtp;
	const c = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
	const imapHost =
		typeof c.imapHost === "string" && /^[A-Za-z0-9.:-]+$/.test(c.imapHost)
			? c.imapHost
			: smtp.host.replace(/^smtp\./, "imap.");
	const imapPort =
		typeof c.imapPort === "number" && Number.isInteger(c.imapPort) && c.imapPort > 0 && c.imapPort < 65536
			? c.imapPort
			: 993;
	const authserv =
		typeof c.authserv === "string" && /^[A-Za-z0-9.-]+$/.test(c.authserv)
			? c.authserv
			: /(^|\.)hostinger\.com$/.test(smtp.host)
				? "hostinger.io"
				: null;
	return {
		imap: { host: imapHost, port: imapPort, user: smtp.user, password: smtp.password },
		authserv,
		ownAddress: smtp.from,
	};
}

/** Why email cannot be used now, or null (the password is read and dropped). */
export function emailSettingsProblem(dir: string): string | null {
	const s = loadEmailSettings(dir);
	return typeof s === "string" ? s : null;
}
