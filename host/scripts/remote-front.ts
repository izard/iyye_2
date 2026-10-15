// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * What the scripts serving a model to Iyye from another of the owner's
 * machines share (`remote-model.ts`: llama-server; `remote-thinking.ts`: any
 * OpenAI-compatible server): the certificate and API key made once in
 * `~/.iyye-remote-model/`, a free port on 127.0.0.1 for the server, and the
 * HTTPS front that is the only thing on the LAN address.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { createServer as netServer } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export interface FrontSecrets {
	keyFile: string;
	certFile: string;
	certKeyFile: string;
}

/**
 * The API key and a self-signed certificate for `listen`, made once in `~/.iyye-remote-model/` (0700; the
 * key and the private key 0600) and shared by every model this machine serves, so the Spark keeps one copy.
 */
export function ensureSecrets(endpoint: string, listen: string): FrontSecrets {
	const dir = join(homedir(), ".iyye-remote-model");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const s = { keyFile: join(dir, "api_key"), certFile: join(dir, "cert.pem"), certKeyFile: join(dir, "cert-key.pem") };
	if (!existsSync(s.keyFile)) writeFileSync(s.keyFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
	if (!existsSync(s.certFile) || !existsSync(s.certKeyFile)) {
		const local = `${hostname().replace(/\.local$/, "")}.local`;
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:prime256v1",
				"-nodes",
				"-days",
				"3650",
				"-subj",
				`/CN=iyye-remote-model ${endpoint}`,
				"-addext",
				`subjectAltName=IP:${listen},DNS:${local}`,
				"-keyout",
				s.certKeyFile,
				"-out",
				s.certFile,
			],
			{ stdio: ["ignore", "ignore", "inherit"] },
		);
		chmodSync(s.certKeyFile, 0o600);
		console.log(`made a certificate for ${listen} and ${local}`);
	}
	return s;
}

/** A free port on 127.0.0.1 for the server behind the front. */
export function freeLocalPort(): Promise<number> {
	return new Promise<number>((resolve) => {
		const s = netServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});
}

/** What to copy to the Spark, once. */
export function copyHint(s: FrontSecrets, endpoint: string): string {
	return `On the Spark (once): copy ${s.certFile} and ${s.keyFile} to ~/.iyye2/remote/${endpoint}/ (mode 0600), e.g.
  ssh <spark> 'mkdir -p -m 700 ~/.iyye2/remote/${endpoint}'
  scp ${s.certFile} ${s.keyFile} <spark>:.iyye2/remote/${endpoint}/`;
}

/**
 * The HTTPS front on the LAN address: each request forwarded to the server on 127.0.0.1 (which checks the
 * key), the answer streamed back, the upstream request aborted when the caller goes away. The Host header is
 * the server's own, so a server that guards its Host (rapid-mlx) needs no LAN name. No time limit: a slow
 * answer beats a timed-out one. `onFail` runs if the address cannot be listened on.
 */
export function startFront(o: {
	secrets: FrontSecrets;
	listen: string;
	port: number;
	innerPort: number;
	onFail: (err: Error) => void;
}): void {
	// Whatever happens to one connection must not take the server down: say what it was, keep serving.
	process.on("uncaughtException", (err) => console.error(`${new Date().toISOString()} front: ${err.stack ?? err}`));
	const front = createServer(
		{ key: readFileSync(o.secrets.certKeyFile), cert: readFileSync(o.secrets.certFile) },
		(req, res) => {
			const up = request(
				{
					host: "127.0.0.1",
					port: o.innerPort,
					method: req.method,
					path: req.url,
					headers: { ...req.headers, host: `127.0.0.1:${o.innerPort}` },
				},
				(upRes) => {
					res.writeHead(upRes.statusCode ?? 502, upRes.headers);
					upRes.pipe(res);
				},
			);
			req.on("error", () => up.destroy());
			up.on("error", () => {
				if (!res.headersSent) res.writeHead(502).end();
				else res.destroy();
			});
			res.on("close", () => {
				if (!res.writableFinished) up.destroy();
			});
			req.pipe(up);
		},
	);
	front.requestTimeout = 0;
	front.headersTimeout = 60_000;
	front.on("clientError", (_err, socket) => socket.destroy());
	// The address is taken (another copy of this script?) or gone: nothing would be served.
	front.once("error", (err) => {
		console.error(`front: cannot listen on ${o.listen}:${o.port}: ${err.message}`);
		o.onFail(err);
	});
	front.listen(o.port, o.listen, () =>
		console.log(`HTTPS front on https://${o.listen}:${o.port} -> 127.0.0.1:${o.innerPort}`),
	);
}
