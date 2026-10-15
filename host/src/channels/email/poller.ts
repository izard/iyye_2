// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Reads Iyye's mailbox (plan 0.015), the email counterpart of the Telegram
 * poller: one IMAP connection, IDLE between mails (a new mail arrives within
 * seconds; at most `idleMs` without a look), every mail after the cursor read
 * in UID order and admitted in one transaction with the cursor (`admitEmail`),
 * then marked seen. Nothing is deleted or moved.
 *
 * - **First start:** the cursor starts at the mailbox's newest mail, so mail
 *   that arrived before receiving was switched on is never answered.
 *   A changed UIDVALIDITY (the mailbox was rebuilt) does the same, with a
 *   warning: UIDs no longer mean what they did.
 * - **Too large** (over `maxBytes`): only the headers are read, and admission
 *   drops it.
 * - **Failures** (connection, login, a mail that cannot be parsed): logged,
 *   then retried after a growing wait; a mail that cannot be parsed is
 *   recorded as dropped and passed, never retried forever.
 */

import type { Logger } from "../../log.ts";
import type { Db } from "../../state/db.ts";
import { ImapSession } from "./imap.ts";
import { type InboundMail, readMail } from "./inbound.ts";
import type { InboundSettings } from "./settings.ts";

export const MAILBOX = "INBOX";

export interface EmailPollerDeps {
	db: Db;
	log: Logger;
	/** The settings, read at each connection, or why receiving is off. */
	load: () => InboundSettings | string;
	/** Admission of one mail (and the cursor past it), in one transaction. */
	admit: (input: { mail: InboundMail; mailbox: string; uidvalidity: number; uid: number; tooLarge?: boolean }) => void;
	idleMs?: number;
	maxBytes?: number;
	retryMs?: number[];
	open?: typeof ImapSession.open;
}

export class EmailPoller {
	private readonly d: Required<EmailPollerDeps>;
	private running = false;
	private loopDone: Promise<void> = Promise.resolve();
	private abort = new AbortController();
	private session: ImapSession | null = null;
	private state: { status: "starting" | "up" | "down" | "off"; since: string; error?: string } = {
		status: "starting",
		since: new Date().toISOString(),
	};

	constructor(deps: EmailPollerDeps) {
		this.d = {
			idleMs: 10 * 60_000,
			maxBytes: 5_000_000,
			retryMs: [5_000, 30_000, 120_000, 600_000],
			open: (s) => ImapSession.open(s),
			...deps,
		};
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.abort = new AbortController();
		this.loopDone = this.loop();
	}

	async stop(): Promise<void> {
		this.running = false;
		this.abort.abort();
		this.session?.close();
		await this.loopDone;
	}

	/** For service status and /email. */
	status(): string {
		const s = this.state;
		return `${s.status} since ${s.since}${s.error ? ` (${s.error})` : ""}`;
	}

	private set(status: "up" | "down" | "off", error?: string): void {
		if (this.state.status !== status || this.state.error !== error)
			this.state = { status, since: new Date().toISOString(), ...(error ? { error } : {}) };
	}

	private async loop(): Promise<void> {
		let failures = 0;
		while (this.running) {
			const s = this.d.load();
			if (typeof s === "string") {
				this.set("off", s);
				await this.wait(this.d.retryMs.at(-1)!);
				continue;
			}
			try {
				await this.session_(s);
				failures = 0;
			} catch (err) {
				if (!this.running) break;
				const error = (err as Error).message.slice(0, 200);
				this.set("down", error);
				this.d.log.warn("email: mailbox unavailable", { error });
				const wait = this.d.retryMs[Math.min(failures, this.d.retryMs.length - 1)]!;
				failures++;
				await this.wait(wait);
			}
		}
	}

	/** One connection: catch up, then idle and catch up again until it fails or the poller stops. */
	private async session_(s: InboundSettings): Promise<void> {
		const imap = await this.d.open(s.imap);
		this.session = imap;
		try {
			await imap.login();
			const box = await imap.select(MAILBOX);
			const cursor = this.d.db
				.prepare("SELECT uidvalidity, last_uid FROM email_cursor WHERE mailbox = ?")
				.get(MAILBOX) as { uidvalidity: number; last_uid: number } | undefined;
			if (!cursor || cursor.uidvalidity !== box.uidvalidity) {
				const start = Math.max(0, box.uidnext - 1);
				if (cursor)
					this.d.log.warn("email: the mailbox was rebuilt (UIDVALIDITY changed); reading only new mail", {});
				else this.d.log.info("email: receiving starts with the next mail", { skipped: box.exists });
				this.d.db
					.prepare(
						`INSERT INTO email_cursor (mailbox, uidvalidity, last_uid, updated_at) VALUES (?, ?, ?, ?)
						 ON CONFLICT (mailbox) DO UPDATE SET uidvalidity = excluded.uidvalidity, last_uid = excluded.last_uid, updated_at = excluded.updated_at`,
					)
					.run(MAILBOX, box.uidvalidity, start, new Date().toISOString());
			}
			this.set("up");
			while (this.running) {
				await this.catchUp(imap, s, box.uidvalidity);
				if (!this.running) break;
				await imap.idle(this.d.idleMs, this.abort.signal);
			}
		} finally {
			this.session = null;
			await imap.logout();
		}
	}

	private async catchUp(imap: ImapSession, s: InboundSettings, uidvalidity: number): Promise<void> {
		const last = (
			this.d.db.prepare("SELECT last_uid FROM email_cursor WHERE mailbox = ?").get(MAILBOX) as { last_uid: number }
		).last_uid;
		for (const uid of await imap.uidsAfter(last)) {
			if (!this.running) return;
			const size = await imap.size(uid);
			const tooLarge = size > this.d.maxBytes;
			const raw = await imap.fetch(uid, tooLarge ? "header" : "whole");
			if (!raw) continue;
			let mail: InboundMail;
			try {
				mail = await readMail(raw, s.authserv ?? "");
			} catch (err) {
				this.d.log.warn("email: a mail could not be read; recorded as dropped", {
					uid,
					error: (err as Error).message,
				});
				mail = unreadable();
			}
			this.d.admit({ mail, mailbox: MAILBOX, uidvalidity, uid, tooLarge });
			try {
				await imap.markSeen(uid);
			} catch (err) {
				this.d.log.warn("email: could not mark a mail seen", { uid, error: (err as Error).message });
			}
		}
	}

	private wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const t = setTimeout(resolve, ms);
			this.abort.signal.addEventListener(
				"abort",
				() => {
					clearTimeout(t);
					resolve();
				},
				{ once: true },
			);
		});
	}
}

/** A mail the parser refused: admitted as nothing (no sender), so it is recorded and passed. */
function unreadable(): InboundMail {
	return {
		messageId: null,
		from: null,
		subject: "(could not be read)",
		text: "",
		truncated: false,
		inReplyTo: null,
		references: null,
		date: null,
		authenticated: false,
		authSummary: "not read",
		machine: null,
		attachments: 0,
	};
}
