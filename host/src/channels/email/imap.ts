// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * A small IMAP client (plan 0.015), only what the poller needs: TLS from the
 * first byte (port 993; certificates always verified), AUTHENTICATE PLAIN,
 * SELECT, UID SEARCH, UID FETCH (sizes, headers, whole messages, read with
 * BODY.PEEK so reading marks nothing), UID STORE \Seen, IDLE, LOGOUT. One
 * command at a time. The login name and password never appear in an error.
 */

import { connect, type TLSSocket } from "node:tls";

export interface ImapSettings {
	host: string;
	port: number;
	user: string;
	password: string;
	/** Extra trusted certificates (tests only). */
	ca?: string | Buffer;
	/** No answer to a command for this long: the connection is dropped. */
	timeoutMs?: number;
}

/** One untagged response: its text (literals replaced by `{n}`) and the literals in order. */
interface Untagged {
	text: string;
	literals: Buffer[];
}

interface Pending {
	tag: string;
	untagged: Untagged[];
	resolve: (r: { ok: boolean; text: string; untagged: Untagged[] }) => void;
	reject: (e: Error) => void;
	onContinue?: () => void;
}

export class ImapError extends Error {}

export class ImapSession {
	private buf = Buffer.alloc(0);
	private n = 0;
	private pending: Pending | null = null;
	private failure: Error | null = null;
	/** Untagged EXISTS seen while idling. */
	private onExists: (() => void) | null = null;
	readonly capabilities = new Set<string>();
	private doneTimer: NodeJS.Timeout | null = null;

	private readonly socket: TLSSocket;
	private readonly s: ImapSettings;

	private constructor(socket: TLSSocket, s: ImapSettings) {
		this.socket = socket;
		this.s = s;
		// Idle for minutes at a time: keepalive lets the kernel notice a vanished peer.
		socket.setKeepAlive(true, 60_000);
		socket.on("data", (d: Buffer) => {
			this.buf = Buffer.concat([this.buf, d]);
			this.parse();
		});
		const fail = (e: Error) => {
			this.failure ??= new ImapError(this.scrub(e.message));
			const p = this.pending;
			this.pending = null;
			p?.reject(this.failure);
		};
		socket.on("error", fail);
		socket.on("close", () => fail(new Error("the mail server closed the connection")));
	}

	static async open(s: ImapSettings): Promise<ImapSession> {
		const timeoutMs = s.timeoutMs ?? 60_000;
		const socket = await new Promise<TLSSocket>((resolve, reject) => {
			const sock = connect({
				host: s.host,
				port: s.port,
				servername: /^[\d.]+$|:/.test(s.host) ? undefined : s.host,
				ca: s.ca,
			});
			const timer = setTimeout(() => {
				sock.destroy();
				reject(new ImapError(`could not reach ${s.host}:${s.port} within ${timeoutMs / 1000} s`));
			}, timeoutMs);
			sock.once("secureConnect", () => {
				clearTimeout(timer);
				resolve(sock);
			});
			sock.once("error", (e) => {
				clearTimeout(timer);
				reject(new ImapError(e.message));
			});
		});
		const session = new ImapSession(socket, s);
		// The greeting is an untagged OK with no command: wait for it as if it were one.
		const greeting = await session.command(null);
		if (!/^\* (OK|PREAUTH)/i.test(greeting.text))
			throw new ImapError(`unexpected greeting: ${greeting.text.slice(0, 100)}`);
		return session;
	}

	async login(): Promise<void> {
		const plain = Buffer.from(`\0${this.s.user}\0${this.s.password}`, "utf8").toString("base64");
		const r = await this.command("AUTHENTICATE PLAIN", () => this.socket.write(`${plain}\r\n`));
		if (!r.ok)
			throw new ImapError(`the mail server refused the login (${r.text.replace(/^\S+\s+/, "").slice(0, 80)})`);
	}

	/** Select a mailbox read-write (needed to mark mail seen). */
	async select(mailbox: string): Promise<{ uidvalidity: number; uidnext: number; exists: number }> {
		const r = await this.check(`SELECT ${quote(mailbox)}`);
		const find = (re: RegExp) => {
			for (const u of r.untagged) {
				const m = re.exec(u.text);
				if (m) return Number(m[1]);
			}
			return Number.NaN;
		};
		const uidvalidity = find(/\[UIDVALIDITY (\d+)\]/i);
		const uidnext = find(/\[UIDNEXT (\d+)\]/i);
		const exists = find(/^\* (\d+) EXISTS/i);
		if (!Number.isFinite(uidvalidity)) throw new ImapError("the mail server sent no UIDVALIDITY");
		return {
			uidvalidity,
			uidnext: Number.isFinite(uidnext) ? uidnext : 0,
			exists: Number.isFinite(exists) ? exists : 0,
		};
	}

	/** UIDs above `after`, ascending (`n:*` also matches the highest UID when it is lower, so filter). */
	async uidsAfter(after: number): Promise<number[]> {
		const r = await this.check(`UID SEARCH UID ${after + 1}:*`);
		const out = new Set<number>();
		for (const u of r.untagged) {
			const m = /^\* SEARCH\b(.*)$/i.exec(u.text);
			if (m) for (const x of m[1]!.trim().split(/\s+/).filter(Boolean)) if (Number(x) > after) out.add(Number(x));
		}
		return [...out].sort((a, b) => a - b);
	}

	async size(uid: number): Promise<number> {
		const r = await this.check(`UID FETCH ${uid} (RFC822.SIZE)`);
		const m = r.untagged.map((u) => /RFC822\.SIZE (\d+)/i.exec(u.text)).find(Boolean);
		return m ? Number(m[1]) : 0;
	}

	/** The whole message, or only its header; null when the UID is gone. */
	async fetch(uid: number, part: "whole" | "header"): Promise<Buffer | null> {
		const r = await this.check(`UID FETCH ${uid} (UID BODY.PEEK[${part === "header" ? "HEADER" : ""}])`);
		const hit = r.untagged.find((u) => new RegExp(`\\bUID ${uid}\\b`).test(u.text) && u.literals.length > 0);
		return hit ? hit.literals[0]! : null;
	}

	async markSeen(uid: number): Promise<void> {
		await this.check(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`);
	}

	/**
	 * Wait for new mail: IDLE until the server reports a new message, `ms` passes or `signal` aborts.
	 * True when something arrived.
	 */
	async idle(ms: number, signal?: AbortSignal): Promise<boolean> {
		let arrived = false;
		let stop: () => void = () => {};
		const finished = new Promise<void>((r) => {
			stop = r;
		});
		const timer = setTimeout(() => stop(), ms);
		const abort = () => stop();
		signal?.addEventListener("abort", abort, { once: true });
		this.onExists = () => {
			arrived = true;
			stop();
		};
		try {
			// DONE goes only after the server said it is idling, and only once.
			const r = await this.command("IDLE", () => {
				void finished.then(() => {
					this.socket.write("DONE\r\n");
					// A connection that died silently never answers DONE: drop it rather than wait for TCP to give up.
					this.doneTimer = setTimeout(
						() => this.socket.destroy(new Error("no answer to DONE")),
						this.s.timeoutMs ?? 60_000,
					);
				});
			});
			if (!r.ok) throw new ImapError(`IDLE refused: ${r.text.slice(0, 100)}`);
		} finally {
			clearTimeout(timer);
			if (this.doneTimer) clearTimeout(this.doneTimer);
			this.doneTimer = null;
			signal?.removeEventListener("abort", abort);
			this.onExists = null;
		}
		return arrived;
	}

	async logout(): Promise<void> {
		try {
			if (!this.failure) await this.command("LOGOUT");
		} catch {
			// closing anyway
		} finally {
			this.socket.destroy();
		}
	}

	close(): void {
		this.socket.destroy();
	}

	private async check(cmd: string) {
		const r = await this.command(cmd);
		if (!r.ok)
			throw new ImapError(`${cmd.split(" ").slice(0, 2).join(" ")}: ${r.text.replace(/^\S+\s+/, "").slice(0, 150)}`);
		return r;
	}

	/** Send a command (null: only wait for the greeting) and collect its untagged responses until its tagged one. */
	private command(
		cmd: string | null,
		onContinue?: () => void,
	): Promise<{ ok: boolean; text: string; untagged: Untagged[] }> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.pending) return Promise.reject(new ImapError("one command at a time"));
		const tag = cmd === null ? "*greeting" : `i${++this.n}`;
		const timeoutMs = this.s.timeoutMs ?? 60_000;
		return new Promise((resolve, reject) => {
			const timer =
				cmd === "IDLE"
					? null
					: setTimeout(
							() => this.socket.destroy(new Error(`no answer from the mail server for ${timeoutMs / 1000} s`)),
							timeoutMs,
						);
			const clear = () => {
				if (timer) clearTimeout(timer);
			};
			this.pending = {
				tag,
				untagged: [],
				resolve: (r) => {
					clear();
					resolve(r);
				},
				reject: (e) => {
					clear();
					reject(e);
				},
				onContinue,
			};
			if (cmd !== null) this.socket.write(`${tag} ${cmd}\r\n`);
			this.parse();
		});
	}

	/** Split the buffer into complete responses (a line, with any `{n}` literals and their continuations). */
	private parse(): void {
		for (;;) {
			let pos = 0;
			let text = "";
			const literals: Buffer[] = [];
			let complete = false;
			for (;;) {
				const eol = this.buf.indexOf("\r\n", pos);
				if (eol < 0) break;
				const line = this.buf.subarray(pos, eol).toString("utf8");
				const lit = /\{(\d+)\+?\}$/.exec(line);
				if (lit) {
					const len = Number(lit[1]);
					if (this.buf.length < eol + 2 + len) break;
					literals.push(Buffer.from(this.buf.subarray(eol + 2, eol + 2 + len)));
					text += line;
					pos = eol + 2 + len;
					continue;
				}
				text += line;
				pos = eol + 2;
				complete = true;
				break;
			}
			if (!complete) return;
			this.buf = this.buf.subarray(pos);
			this.dispatch({ text, literals });
		}
	}

	private dispatch(r: Untagged): void {
		const p = this.pending;
		if (r.text.startsWith("+")) {
			p?.onContinue?.();
			return;
		}
		if (r.text.startsWith("* ")) {
			for (const cap of [/\[CAPABILITY ([^\]]+)\]/i.exec(r.text)?.[1], /^\* CAPABILITY (.+)$/i.exec(r.text)?.[1]])
				if (cap) for (const c of cap.split(/\s+/)) this.capabilities.add(c.toUpperCase());
			if (/^\* \d+ EXISTS/i.test(r.text)) this.onExists?.();
			if (p?.tag === "*greeting") {
				this.pending = null;
				p.resolve({ ok: true, text: r.text, untagged: [] });
				return;
			}
			p?.untagged.push(r);
			return;
		}
		const m = /^(\S+) (OK|NO|BAD)\b(.*)$/i.exec(r.text);
		if (p && m && m[1] === p.tag) {
			this.pending = null;
			p.resolve({ ok: m[2]!.toUpperCase() === "OK", text: this.scrub(r.text), untagged: p.untagged });
		}
	}

	private scrub(t: string): string {
		let out = t;
		for (const secret of [this.s.password, this.s.user])
			if (secret && secret.length >= 3) out = out.split(secret).join("[hidden]");
		return out;
	}
}

function quote(s: string): string {
	return `"${s.replace(/(["\\])/g, "\\$1")}"`;
}
