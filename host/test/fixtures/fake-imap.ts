// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-process fake IMAP server for tests (plan 0.015), never a real
 * mailbox: TLS with the test-only certificate (127.0.0.1), and only the
 * commands Iyye's client sends (AUTHENTICATE PLAIN, SELECT, UID SEARCH,
 * UID FETCH of RFC822.SIZE / BODY.PEEK[] / BODY.PEEK[HEADER], UID STORE,
 * IDLE/DONE, LOGOUT). `add()` delivers a mail, and an idling client hears
 * of it at once.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server, type TLSSocket } from "node:tls";

const cert = readFileSync(new URL("./remote-cert.pem", import.meta.url));
const key = readFileSync(new URL("./remote-key.pem", import.meta.url));
export const FAKE_IMAP_CA = cert;

export interface FakeImap {
	port: number;
	uidvalidity: number;
	messages: { uid: number; raw: Buffer; seen: boolean }[];
	commands: string[];
	logins: number;
	add(raw: string | Buffer): number;
	/** Close every client connection (the server stays up). */
	dropClients(): void;
	close(): Promise<void>;
}

export async function startFakeImap(
	o: { user?: string; password?: string; uidvalidity?: number } = {},
): Promise<FakeImap> {
	const user = o.user ?? "iyye@example.org";
	const password = o.password ?? "app-password-123";
	const idlers = new Set<() => void>();
	const sockets = new Set<TLSSocket>();
	let nextUid = 1;
	const state: FakeImap = {
		port: 0,
		uidvalidity: o.uidvalidity ?? 1792076851,
		messages: [],
		commands: [],
		logins: 0,
		add(raw) {
			const uid = nextUid++;
			state.messages.push({
				uid,
				raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.replace(/\r?\n/g, "\r\n")),
				seen: false,
			});
			for (const notify of idlers) notify();
			return uid;
		},
		dropClients() {
			for (const s of sockets) s.destroy();
		},
		close: async () => undefined,
	};

	const server: Server = createServer({ cert, key }, (sock) => {
		sockets.add(sock);
		sock.on("close", () => sockets.delete(sock));
		sock.on("error", () => undefined);
		let buf = "";
		let authTag: string | null = null;
		let idleTag: string | null = null;
		let authed = false;
		const send = (l: string | Buffer) => sock.write(typeof l === "string" ? `${l}\r\n` : l);
		const notify = () => send(`* ${state.messages.length} EXISTS`);
		const seq = (uid: number) => state.messages.findIndex((m) => m.uid === uid) + 1;
		send("* OK [CAPABILITY IMAP4rev1 SASL-IR IDLE AUTH=PLAIN] fake ready");
		sock.on("data", (d: Buffer) => {
			buf += d.toString("utf8");
			for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (authTag) {
					const [, u, p] = Buffer.from(line, "base64").toString("utf8").split("\0");
					authed = u === user && p === password;
					if (authed) state.logins++;
					send(authed ? `${authTag} OK logged in` : `${authTag} NO [AUTHENTICATIONFAILED] bad credentials`);
					authTag = null;
					continue;
				}
				if (idleTag) {
					if (line.toUpperCase() === "DONE") {
						idlers.delete(notify);
						send(`${idleTag} OK IDLE done`);
						idleTag = null;
					}
					continue;
				}
				state.commands.push(line);
				const m = /^(\S+) (.+)$/.exec(line);
				if (!m) continue;
				const [, tag, cmd] = m as unknown as [string, string, string];
				const up = cmd.toUpperCase();
				if (up === "AUTHENTICATE PLAIN") {
					authTag = tag;
					send("+ ");
				} else if (up === "LOGOUT") {
					send("* BYE");
					send(`${tag} OK bye`);
					sock.end();
				} else if (!authed) send(`${tag} NO not logged in`);
				else if (up.startsWith("SELECT ")) {
					send(`* ${state.messages.length} EXISTS`);
					send(`* OK [UIDVALIDITY ${state.uidvalidity}] UIDs valid`);
					send(`* OK [UIDNEXT ${nextUid}] next`);
					send(`${tag} OK [READ-WRITE] selected`);
				} else if (up.startsWith("UID SEARCH UID ")) {
					const from = Number(/UID (\d+):\*/i.exec(cmd)?.[1] ?? 1);
					const max = state.messages.at(-1)?.uid;
					// RFC 3501: n:* includes the highest UID even when it is below n.
					const hits = state.messages.filter((x) => x.uid >= from).map((x) => x.uid);
					if (hits.length === 0 && max !== undefined) hits.push(max);
					send(`* SEARCH${hits.map((u) => ` ${u}`).join("")}`);
					send(`${tag} OK search done`);
				} else if (up.startsWith("UID FETCH ")) {
					const uid = Number(/^UID FETCH (\d+)/i.exec(cmd)?.[1]);
					const msg = state.messages.find((x) => x.uid === uid);
					if (msg) {
						if (/RFC822\.SIZE/i.test(cmd)) send(`* ${seq(uid)} FETCH (UID ${uid} RFC822.SIZE ${msg.raw.length})`);
						else {
							const header = /BODY\.PEEK\[HEADER\]/i.test(cmd);
							const end = msg.raw.indexOf("\r\n\r\n");
							const body = header ? msg.raw.subarray(0, end < 0 ? msg.raw.length : end + 4) : msg.raw;
							send(
								Buffer.concat([
									Buffer.from(
										`* ${seq(uid)} FETCH (UID ${uid} BODY[${header ? "HEADER" : ""}] {${body.length}}\r\n`,
									),
									body,
									Buffer.from(")\r\n"),
								]),
							);
						}
					}
					send(`${tag} OK fetch done`);
				} else if (up.startsWith("UID STORE ")) {
					const uid = Number(/^UID STORE (\d+)/i.exec(cmd)?.[1]);
					const msg = state.messages.find((x) => x.uid === uid);
					if (msg && /\\Seen/i.test(cmd)) msg.seen = true;
					send(`${tag} OK store done`);
				} else if (up === "IDLE") {
					idleTag = tag;
					idlers.add(notify);
					sock.once("close", () => idlers.delete(notify));
					send("+ idling");
				} else send(`${tag} BAD unknown command`);
			}
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	state.port = (server.address() as { port: number }).port;
	state.close = () =>
		new Promise<void>((r) => {
			for (const s of sockets) s.destroy();
			server.close(() => r());
		});
	return state;
}
