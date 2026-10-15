// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-process fake SMTP submission server for tests (plan 0.014), never a
 * real mail server: implicit TLS or STARTTLS with the test-only certificate
 * (`remote-cert.pem`, 127.0.0.1), AUTH PLAIN and LOGIN, and per-recipient
 * scripts by the address's local part:
 *
 *   reject-rcpt  550 at RCPT TO        temp-rcpt   451 at RCPT TO
 *   reject-data  554 after the message drop-data   closes after the message, no answer
 *   hang-data    never answers after the message
 *
 * `injectAfterStarttls`: replies written in the clear right after STARTTLS's 220 (an attacker on the path).
 *
 * Any other recipient is accepted (250) and the message recorded.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { TLSSocket, createServer as tlsServer } from "node:tls";

const cert = readFileSync(new URL("./remote-cert.pem", import.meta.url));
const key = readFileSync(new URL("./remote-key.pem", import.meta.url));
export const FAKE_SMTP_CA = cert;

export interface ReceivedMail {
	from: string;
	to: string;
	data: string;
	authUser: string;
}

export interface FakeSmtp {
	port: number;
	received: ReceivedMail[];
	/** Every command line the server saw (passwords included: tests only). */
	commands: string[];
	connections: number;
	close(): Promise<void>;
}

export async function startFakeSmtp(o: {
	security: "tls" | "starttls";
	user?: string;
	password?: string;
	auth?: "PLAIN" | "LOGIN" | "PLAIN LOGIN";
	injectAfterStarttls?: string;
}): Promise<FakeSmtp> {
	const user = o.user ?? "iyye@example.org";
	const password = o.password ?? "app-password-123";
	const state: FakeSmtp = { port: 0, received: [], commands: [], connections: 0, close: async () => undefined };
	const sockets = new Set<Socket>();

	const session = (raw: Socket, secure: boolean) => {
		let sock: Socket = raw;
		let buf = "";
		let authed = "";
		let from = "";
		let to = "";
		let inData = false;
		let data: string[] = [];
		let login: "user" | "pass" | null = null;
		let loginUser = "";
		const send = (line: string) => sock.write(`${line}\r\n`);
		const ehlo = () => {
			const lines = ["fake.smtp", ...(!secure ? ["STARTTLS"] : []), `AUTH ${o.auth ?? "PLAIN LOGIN"}`, "8BITMIME"];
			for (const [i, l] of lines.entries()) send(`250${i === lines.length - 1 ? " " : "-"}${l}`);
		};
		const onLine = (line: string) => {
			if (inData) {
				if (line === ".") {
					inData = false;
					const script = to.split("@")[0];
					if (script === "drop-data") return sock.destroy();
					if (script === "hang-data") return;
					if (script === "reject-data") return send("554 5.7.1 message rejected");
					state.received.push({ from, to, data: data.join("\r\n"), authUser: authed });
					return send("250 2.0.0 OK queued");
				}
				data.push(line.startsWith("..") ? line.slice(1) : line);
				return;
			}
			state.commands.push(line);
			if (login) {
				const v = Buffer.from(line, "base64").toString("utf8");
				if (login === "user") {
					loginUser = v;
					login = "pass";
					return send("334 UGFzc3dvcmQ6");
				}
				login = null;
				if (loginUser === user && v === password) {
					authed = loginUser;
					return send("235 2.7.0 Accepted");
				}
				return send("535 5.7.8 bad credentials");
			}
			const cmd = line.toUpperCase();
			if (cmd.startsWith("EHLO")) return ehlo();
			if (cmd === "STARTTLS" && !secure) {
				sock.write(`220 2.0.0 Ready to start TLS\r\n${o.injectAfterStarttls ?? ""}`);
				const tls = new TLSSocket(sock, { isServer: true, cert, key });
				sock.removeAllListeners("data");
				secure = true;
				sock = tls;
				buf = "";
				tls.on("data", onData);
				tls.on("error", () => undefined);
				return;
			}
			if (cmd.startsWith("AUTH PLAIN ")) {
				const [, u, p] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\0");
				if (u === user && p === password) {
					authed = u;
					return send("235 2.7.0 Accepted");
				}
				return send("535 5.7.8 bad credentials");
			}
			if (cmd === "AUTH LOGIN") {
				login = "user";
				return send("334 VXNlcm5hbWU6");
			}
			if (cmd.startsWith("MAIL FROM:")) {
				if (!authed) return send("530 5.7.0 authentication required");
				from = line.slice(10).replace(/[<>]/g, "");
				return send("250 2.1.0 OK");
			}
			if (cmd.startsWith("RCPT TO:")) {
				to = line.slice(8).replace(/[<>]/g, "");
				const script = to.split("@")[0];
				if (script === "reject-rcpt") return send("550 5.1.1 no such user");
				if (script === "temp-rcpt") return send("451 4.3.0 try later");
				return send("250 2.1.5 OK");
			}
			if (cmd === "DATA") {
				inData = true;
				data = [];
				return send("354 go ahead");
			}
			if (cmd === "QUIT") {
				send("221 bye");
				return sock.end();
			}
			send("502 5.5.1 unrecognized command");
		};
		const onData = (d: Buffer) => {
			buf += d.toString("utf8");
			for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				onLine(line);
			}
		};
		sock.on("data", onData);
		sock.on("error", () => undefined);
		send("220 fake.smtp ESMTP");
	};

	const server: Server =
		o.security === "tls"
			? tlsServer({ cert, key }, (s) => {
					state.connections++;
					sockets.add(s);
					session(s, true);
				})
			: createServer((s) => {
					state.connections++;
					sockets.add(s);
					session(s, false);
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
