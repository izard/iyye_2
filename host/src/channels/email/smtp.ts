// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * A small SMTP submission client (plan 0.014): one plain-text mail to one
 * recipient over TLS (implicit, port 465, or STARTTLS, port 587), with
 * AUTH PLAIN or LOGIN. Written here rather than taken from a library because
 * the outbox needs to know exactly which step failed:
 *
 * - **Before the message's closing dot is written** nothing can have been
 *   delivered: a connection, TLS, login or envelope failure is a definite
 *   non-delivery (`ok: false`; retryable for 4xx and network trouble, not for
 *   5xx or a refused login).
 * - **After it**, the server's answer decides: 250 is accepted, 4xx/5xx is a
 *   definite refusal; no answer at all (a lost connection, a hang) means the
 *   mail may have gone out, so `sendMail` throws and the outbox records
 *   `unknown`, never sending it again by itself.
 *
 * Certificates are always verified. Headers are built only by this module: a
 * line break in a subject or address is refused, non-ASCII headers are RFC 2047
 * words, and the body is UTF-8 in base64 (whose alphabet has no dot, so no line
 * can end the message early). The login name and password are scrubbed from
 * every error.
 */

import { connect as netConnect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";

export interface SmtpSettings {
	host: string;
	port: number;
	/** `tls`: TLS from the first byte (465); `starttls`: plain, then upgraded before anything is sent (587). */
	security: "tls" | "starttls";
	user: string;
	password: string;
	/** The sender's address, Iyye's own mailbox. */
	from: string;
	/** The sender's display name. */
	fromName: string;
	/** Extra trusted certificates (tests only; the live host trusts the system's CAs). */
	ca?: string | Buffer;
	/** No byte from the server for this long: a hang (before the message: not sent; after it: unknown). */
	timeoutMs?: number;
}

export interface Mail {
	to: string;
	subject: string;
	text: string;
	/** A reply (plan 0.015): the mail it answers and its thread, as `<id>` values. */
	inReplyTo?: string;
	references?: string;
	/** Without angle brackets. */
	messageId: string;
	date: Date;
}

export type SmtpResult = { ok: true; reply: string } | { ok: false; retryable: boolean; error: string };

/** The mail may or may not have been accepted. */
export class SmtpUncertain extends Error {}

interface Reply {
	code: number;
	lines: string[];
}

/** Reads SMTP replies (one or more `ddd-` lines ending with a `ddd ` line) from whichever socket is current. */
class Replies {
	private buf = "";
	private ready: Reply[] = [];
	private partial: string[] = [];
	private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
	private failure: Error | null = null;
	private socket: Socket | TLSSocket | null = null;
	private readonly onData = (d: Buffer) => this.feed(d.toString("utf8"));
	private readonly onError = (e: Error) => this.fail(e);
	private readonly onClose = () => this.fail(new Error("the mail server closed the connection"));

	/** Bytes or replies received but not yet read: after STARTTLS's 220 there must be none. */
	get pending(): boolean {
		return this.ready.length > 0 || this.partial.length > 0 || this.buf.length > 0;
	}

	attach(s: Socket | TLSSocket, timeoutMs: number): void {
		this.detach();
		// Nothing read on one socket is ever taken as said on the next.
		this.buf = "";
		this.ready = [];
		this.partial = [];
		this.socket = s;
		s.on("data", this.onData);
		s.on("error", this.onError);
		s.on("close", this.onClose);
		s.setTimeout(timeoutMs, () => s.destroy(new Error(`no answer from the mail server for ${timeoutMs / 1000} s`)));
	}

	detach(): void {
		const s = this.socket;
		if (!s) return;
		s.off("data", this.onData);
		s.off("error", this.onError);
		s.off("close", this.onClose);
		s.setTimeout(0);
		this.socket = null;
	}

	next(): Promise<Reply> {
		const r = this.ready.shift();
		if (r) return Promise.resolve(r);
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			this.waiting = { resolve, reject };
		});
	}

	private feed(chunk: string): void {
		this.buf += chunk;
		for (let i = this.buf.indexOf("\r\n"); i >= 0; i = this.buf.indexOf("\r\n")) {
			const line = this.buf.slice(0, i);
			this.buf = this.buf.slice(i + 2);
			this.partial.push(line);
			if (/^\d{3}(?: |$)/.test(line)) {
				const reply = { code: Number(line.slice(0, 3)), lines: this.partial.map((l) => l.slice(4)) };
				this.partial = [];
				const w = this.waiting;
				this.waiting = null;
				if (w) w.resolve(reply);
				else this.ready.push(reply);
			} else if (!/^\d{3}-/.test(line)) {
				this.fail(
					new Error(`the mail server sent something that is not SMTP: ${JSON.stringify(line.slice(0, 80))}`),
				);
			}
		}
	}

	private fail(e: Error): void {
		this.failure ??= e;
		const w = this.waiting;
		this.waiting = null;
		w?.reject(this.failure);
	}
}

/** A reply other than the one expected: a definite answer from the server. */
class Refused extends Error {
	readonly step: string;
	readonly reply: Reply;
	constructor(step: string, reply: Reply) {
		super(`${step}: ${reply.code} ${reply.lines.join(" ").slice(0, 300)}`);
		this.step = step;
		this.reply = reply;
	}
}

export async function sendMail(s: SmtpSettings, mail: Mail): Promise<SmtpResult> {
	const problem = headerProblem(s, mail);
	if (problem) return { ok: false, retryable: false, error: problem };
	const scrub = (t: string) => scrubSecrets(t, s);
	const timeoutMs = s.timeoutMs ?? 120_000;
	const replies = new Replies();
	let socket: Socket | TLSSocket | null = null;
	let dotWritten = false;
	const write = (line: string) => {
		socket!.write(`${line}\r\n`);
	};
	const expect = async (step: string, ...codes: number[]) => {
		const r = await replies.next();
		if (!codes.includes(r.code)) throw new Refused(step, r);
		return r;
	};
	const command = async (line: string, step: string, ...codes: number[]) => {
		write(line);
		return expect(step, ...codes);
	};
	try {
		socket = await open(s, timeoutMs);
		replies.attach(socket, timeoutMs);
		await expect("greeting", 220);
		const helo = heloName(s.from);
		let ehlo = await command(`EHLO ${helo}`, "EHLO", 250);
		if (s.security === "starttls") {
			if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l)))
				return {
					ok: false,
					retryable: false,
					error: "the mail server does not offer STARTTLS (refused to log in in the clear)",
				};
			await command("STARTTLS", "STARTTLS", 220);
			// Anything sent in the clear after the 220 (an injected "250 OK" before TLS) would be read as the
			// encrypted server's answers: refuse, nothing has been sent.
			if (replies.pending)
				return {
					ok: false,
					retryable: false,
					error: "the mail server sent data in the clear after STARTTLS (refused)",
				};
			replies.detach();
			socket = await upgrade(socket as Socket, s, timeoutMs);
			replies.attach(socket, timeoutMs);
			ehlo = await command(`EHLO ${helo}`, "EHLO after STARTTLS", 250);
		}
		const auth = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l))?.toUpperCase() ?? "";
		if (/\bPLAIN\b/.test(auth)) {
			await command(`AUTH PLAIN ${b64(`\0${s.user}\0${s.password}`)}`, "login", 235);
		} else if (/\bLOGIN\b/.test(auth)) {
			await command("AUTH LOGIN", "login", 334);
			await command(b64(s.user), "login", 334);
			await command(b64(s.password), "login", 235);
		} else {
			return { ok: false, retryable: false, error: "the mail server offers no AUTH PLAIN or LOGIN" };
		}
		await command(`MAIL FROM:<${s.from}>`, "MAIL FROM", 250);
		await command(`RCPT TO:<${mail.to}>`, "RCPT TO", 250, 251);
		await command("DATA", "DATA", 354);
		// From here on, an answer that never comes means the mail may have gone out.
		dotWritten = true;
		socket.write(`${buildMessage(s, mail)}\r\n.\r\n`);
		const r = await replies.next();
		if (r.code !== 250) throw new Refused("message", r);
		write("QUIT");
		return { ok: true, reply: scrub(`${r.code} ${r.lines.join(" ")}`.slice(0, 300)) };
	} catch (err) {
		if (err instanceof Refused) {
			const permanent = err.reply.code >= 500;
			const login = err.step === "login";
			if (!dotWritten || err.step === "message") {
				try {
					write("QUIT");
				} catch {
					// closing anyway
				}
				return {
					ok: false,
					retryable: !permanent && !login,
					error: scrub(login ? `the mail server refused the login (${err.reply.code})` : err.message),
				};
			}
		}
		const msg = scrub((err as Error).message);
		if (dotWritten) throw new SmtpUncertain(`the mail server did not confirm the message: ${msg}`);
		return { ok: false, retryable: true, error: msg };
	} finally {
		replies.detach();
		socket?.end();
		socket?.destroy();
	}
}

function open(s: SmtpSettings, timeoutMs: number): Promise<Socket | TLSSocket> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error(`could not reach the mail server ${s.host}:${s.port} within ${timeoutMs / 1000} s`));
		}, timeoutMs);
		const done = (err?: Error) => {
			clearTimeout(timer);
			sock.off("error", done);
			if (err) reject(err);
			else resolve(sock);
		};
		const sock: Socket | TLSSocket =
			s.security === "tls"
				? tlsConnect({ host: s.host, port: s.port, servername: sni(s.host), ca: s.ca }, () => done())
				: netConnect({ host: s.host, port: s.port }, () => done());
		sock.once("error", done);
	});
}

function upgrade(plain: Socket, s: SmtpSettings, timeoutMs: number): Promise<TLSSocket> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error(`TLS with the mail server did not start within ${timeoutMs / 1000} s`));
		}, timeoutMs);
		const sock = tlsConnect({ socket: plain, host: s.host, servername: sni(s.host), ca: s.ca }, () => {
			clearTimeout(timer);
			sock.off("error", onError);
			resolve(sock);
		});
		const onError = (e: Error) => {
			clearTimeout(timer);
			reject(e);
		};
		sock.once("error", onError);
	});
}

/** An IP address is not a server name for SNI. */
function sni(host: string): string | undefined {
	return /^[\d.]+$|:/.test(host) ? undefined : host;
}

function heloName(from: string): string {
	const domain = from.split("@")[1] ?? "localhost";
	return /^[A-Za-z0-9.-]+$/.test(domain) ? domain : "localhost";
}

/** Message ids, one per folded line. */
function foldIds(ids: string): string {
	return ids.trim().split(/\s+/).join("\r\n ");
}

const MSG_IDS = /^<[^<>\s"\\]{3,250}>( <[^<>\s"\\]{3,250}>)*$/;

function headerProblem(s: SmtpSettings, mail: Mail): string | null {
	const lineBreak = /[\r\n\0]/;
	if ([mail.to, s.from, mail.subject, s.fromName, mail.messageId].some((v) => lineBreak.test(v)))
		return "refused: a line break in a mail header";
	for (const ids of [mail.inReplyTo, mail.references])
		if (ids !== undefined && !MSG_IDS.test(ids)) return "refused: not a list of message ids";
	if (/[<>,;\s]/.test(mail.to) || /[<>,;\s]/.test(s.from)) return "refused: not a single plain address";
	return null;
}

const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");

/** RFC 5322 date, `+0000`. */
function mailDate(d: Date): string {
	return d.toUTCString().replace(/GMT$/, "+0000");
}

/** A header value: as is when printable ASCII, else RFC 2047 base64 words of at most 45 bytes each, folded. */
export function encodeHeader(value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	const words: string[] = [];
	let cur = "";
	for (const ch of value) {
		if (Buffer.byteLength(cur + ch, "utf8") > 45) {
			words.push(cur);
			cur = "";
		}
		cur += ch;
	}
	if (cur) words.push(cur);
	return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
}

export function buildMessage(s: SmtpSettings, mail: Mail): string {
	const body = Buffer.from(mail.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
	return [
		`From: ${encodeHeader(s.fromName)} <${s.from}>`,
		`To: <${mail.to}>`,
		`Subject: ${encodeHeader(mail.subject)}`,
		`Date: ${mailDate(mail.date)}`,
		`Message-ID: <${mail.messageId}>`,
		...(mail.inReplyTo ? [`In-Reply-To: ${mail.inReplyTo}`] : []),
		// RFC 3834: an automatic reply, so other machines (vacation responders, agents) do not answer it back.
		...(mail.inReplyTo ? ["Auto-Submitted: auto-replied"] : []),
		...(mail.references ? [`References: ${foldIds(mail.references)}`] : []),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
		"",
		...(body.match(/.{1,76}/g) ?? []),
	].join("\r\n");
}

/** The login name and password never leave this module in an error. */
function scrubSecrets(text: string, s: SmtpSettings): string {
	let t = text;
	for (const secret of [s.password, s.user, b64(s.user), b64(s.password)]) {
		if (secret && secret.length >= 3) t = t.split(secret).join("[hidden]");
	}
	return t;
}
