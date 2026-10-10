// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * A model served by another of the owner's machines (plan 0.012): the MBP
 * serves one model with llama-server over HTTPS with an API key, and Iyye's
 * background work runs on it.
 *
 * - **The only way there is this pass-through** on 127.0.0.1. Pi and the
 *   host's direct completions talk to it like to the router; it forwards to
 *   the endpoint with the endpoint's certificate pinned (on these connections
 *   only, never process-wide trust) and adds the key (from a 0600 file, never
 *   logged, never given to Pi).
 * - It forwards only while Iyye holds a lease on the model, so no other local
 *   process can put work on the other machine, and only
 *   `POST /v1/chat/completions` (streamed straight through; the upstream
 *   request is aborted if the caller goes away). No model-time limit: a slow
 *   answer beats a timed-out one.
 * - **Available** means the endpoint answered its last health check (every
 *   `healthIntervalMs`) and serves what the registry describes: the same GGUF
 *   file name and the same context per slot. It is never loaded, unloaded or
 *   healed by the host; it is the owner's machine.
 * - **A lost connection is not a failure** of the work on it: the leases taken
 *   before it become invalid (`valid()` false), and callers treat that as
 *   "not now", as for a model lost with the router.
 */

import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Agent, request } from "node:https";
import { slotContext } from "../integration/pi/runtime.ts";
import type { Logger } from "../log.ts";
import type { ModelLease, OpResult } from "./manager.ts";
import { findModel, type ModelSpec, type Registry } from "./registry.ts";
import { RemoteConfigError, type RemoteModelConfig, remoteName } from "./remote-config.ts";

export { parseRemoteModel, RemoteConfigError, type RemoteModelConfig, remoteName } from "./remote-config.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Add the remote model to the registry, described by the registry entry of the model it serves (thinking,
 * server arguments, so the same context), reached at the pass-through.
 */
export function addRemoteModel(registry: Registry, c: RemoteModelConfig, proxyUrl: string): ModelSpec {
	const base = findModel(registry, c.model);
	if (!base) throw new RemoteConfigError(`IYYE2_REMOTE_MODEL: ${c.model} is not in the model registry`);
	if (base.remote) throw new RemoteConfigError(`IYYE2_REMOTE_MODEL: ${c.model} is itself remote`);
	const spec: ModelSpec = {
		...base,
		name: remoteName(c),
		description: `${base.description} — served by ${c.endpoint}`.trim(),
		available: true,
		remote: { endpoint: c.endpoint, proxyUrl },
	};
	registry.models.push(spec);
	return spec;
}

export type RemoteState = "starting" | "up" | "unreachable" | "misconfigured";

export interface RemoteModelsOptions {
	config: RemoteModelConfig;
	registry: Registry;
	/** The pass-through's port on 127.0.0.1. */
	port: number;
	/** The endpoint's certificate (PEM), pinned; read at each connection setup so a replaced file applies. */
	cert: () => string;
	/** The endpoint's API key. */
	key: () => string;
	log: Logger;
	healthIntervalMs?: number;
	/** Health checks give up after this (the endpoint is then unreachable until the next one). */
	healthTimeoutMs?: number;
}

export class RemoteModels {
	private readonly o: Required<RemoteModelsOptions>;
	private readonly spec: ModelSpec;
	private server: Server | null = null;
	private timer: NodeJS.Timeout | null = null;
	private current: { state: RemoteState; detail: string } = { state: "starting", detail: "not checked yet" };
	private generation = 0;
	private inUse = 0;
	private readonly inflight = new Set<AbortController>();
	private agent: Agent | null = null;
	private agentCert = "";

	constructor(opts: RemoteModelsOptions) {
		this.o = { healthIntervalMs: 30_000, healthTimeoutMs: 10_000, ...opts };
		const spec = findModel(opts.registry, remoteName(opts.config));
		if (!spec?.remote) throw new RemoteConfigError(`${remoteName(opts.config)} is not registered (addRemoteModel)`);
		this.spec = spec;
	}

	get name(): string {
		return this.spec.name;
	}

	get endpoint(): string {
		return this.o.config.endpoint;
	}

	get proxyUrl(): string {
		return `http://127.0.0.1:${this.o.port}`;
	}

	has(name: string): boolean {
		return name === this.spec.name;
	}

	/** The endpoint's state as the owner sees it (`/models`, service status). */
	get status(): { state: RemoteState; detail: string } {
		return this.current;
	}

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			this.handle(req, res).catch((err: unknown) => {
				this.o.log.error("remote: request failed", { error: (err as Error).message });
				if (!res.headersSent) reply(res, 502, "upstream error");
				else res.destroy();
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.o.port, "127.0.0.1", () => resolve());
		});
		await this.check();
		this.schedule();
	}

	async stop(): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		for (const a of this.inflight) a.abort();
		this.agent?.destroy();
		const s = this.server;
		this.server = null;
		if (!s) return;
		s.closeAllConnections();
		await new Promise<void>((resolve) => s.close(() => resolve()));
	}

	/**
	 * A lease for one job on the remote model: refused (`busy`, so callers wait) unless the endpoint answered
	 * its last check. It becomes invalid when the connection is lost.
	 */
	acquire(name: string): ModelLease | OpResult {
		if (!this.has(name)) return { ok: false, message: `unknown remote model ${name}` };
		if (this.current.state !== "up")
			return { ok: false, busy: true, message: `${this.endpoint} is ${this.current.state}: ${this.current.detail}` };
		const gen = this.generation;
		let released = false;
		this.inUse++;
		return {
			model: name,
			valid: () => !released && gen === this.generation,
			release: () => {
				if (released) return;
				released = true;
				this.inUse = Math.max(0, this.inUse - 1);
			},
		};
	}

	/** One health check now (also run on the timer). Exposed for tests. */
	async check(): Promise<void> {
		try {
			const health = await this.get("/health");
			if (health.status !== 200) return this.lost("unreachable", `health answered HTTP ${health.status}`);
			const props = await this.get("/props");
			if (props.status !== 200) return this.lost("unreachable", `props answered HTTP ${props.status}`);
			const p = JSON.parse(props.body) as {
				model_path?: string;
				default_generation_settings?: { n_ctx?: number };
			};
			const file = this.spec.path.split("/").pop();
			const served = p.model_path?.split("/").pop();
			if (served !== file) return this.lost("misconfigured", `serves ${served ?? "an unknown model"}, not ${file}`);
			const want = slotContext(this.o.registry.defaults, this.spec);
			const ctx = p.default_generation_settings?.n_ctx;
			if (ctx !== want) return this.lost("misconfigured", `context per slot is ${ctx}, the registry says ${want}`);
			if (this.current.state !== "up") this.o.log.info("remote: up", { endpoint: this.endpoint, model: this.name });
			this.current = { state: "up", detail: `${this.name} at ${this.o.config.url}` };
		} catch (err) {
			this.lost("unreachable", (err as Error).message);
		}
	}

	private lost(state: RemoteState, detail: string): void {
		if (this.current.state === "up") {
			this.o.log.warn("remote: lost", { endpoint: this.endpoint, state, detail });
			this.generation++; // leases taken before are no longer valid: their work waits, it did not fail
		}
		this.current = { state, detail };
	}

	private schedule(): void {
		if (!this.server) return;
		this.timer = setTimeout(async () => {
			await this.check();
			this.schedule();
		}, this.o.healthIntervalMs);
		this.timer.unref();
	}

	/** The pinned agent: the endpoint's own certificate is the only trust anchor; rebuilt if the file changed. */
	private pinned(): Agent {
		const cert = this.o.cert();
		if (this.agent && cert === this.agentCert) return this.agent;
		this.agent?.destroy();
		const fingerprint = new X509Certificate(cert).fingerprint256;
		this.agentCert = cert;
		this.agent = new Agent({
			keepAlive: true,
			ca: cert,
			// The certificate itself is pinned (chain to exactly it, and the same fingerprint), so the address
			// in the URL need not match its names: a new DHCP address does not break the pin.
			checkServerIdentity: (_host, peer) =>
				peer.fingerprint256 === fingerprint
					? undefined
					: new Error("the endpoint's certificate is not the pinned one"),
		});
		return this.agent;
	}

	private get(path: string): Promise<{ status: number; body: string }> {
		return new Promise((resolve, reject) => {
			const url = new URL(path, this.o.config.url);
			const req = request(
				url,
				{
					method: "GET",
					agent: this.pinned(),
					headers: { authorization: `Bearer ${this.o.key()}` },
					timeout: this.o.healthTimeoutMs,
				},
				(res) => {
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (c) => {
						body += c;
					});
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
					res.on("error", reject);
				},
			);
			req.on("timeout", () => req.destroy(new Error(`no answer within ${this.o.healthTimeoutMs / 1000} s`)));
			req.on("error", reject);
			req.end();
		});
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = (req.url ?? "/").split("?")[0];
		if (req.method !== "POST" || path !== "/v1/chat/completions") return reply(res, 404, "not found");
		if (this.inUse === 0 || this.current.state !== "up")
			return reply(res, 503, `the remote model is not leased or ${this.endpoint} is not up`, "unavailable");
		const body = await readBody(req);
		if (body === null) return reply(res, 413, "request too large");
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(body) as Record<string, unknown>;
		} catch {
			return reply(res, 400, "body must be JSON");
		}
		if (payload.model !== this.name) return reply(res, 400, `only ${this.name} is served here`);
		payload.model = this.o.config.model; // the endpoint's own name for it
		const gen = this.generation;
		const abort = new AbortController();
		this.inflight.add(abort);
		res.on("close", () => {
			if (!res.writableFinished) abort.abort(); // the caller went away: stop the work on the other machine
		});
		const out = JSON.stringify(payload);
		try {
			await new Promise<void>((resolve, reject) => {
				const up = request(
					new URL("/v1/chat/completions", this.o.config.url),
					{
						method: "POST",
						agent: this.pinned(),
						signal: abort.signal,
						headers: {
							"content-type": "application/json",
							"content-length": Buffer.byteLength(out),
							authorization: `Bearer ${this.o.key()}`,
						},
					},
					(upRes) => {
						res.writeHead(upRes.statusCode ?? 502, {
							"content-type": upRes.headers["content-type"] ?? "application/json",
						});
						upRes.on("data", (c) => res.write(c));
						upRes.on("end", () => {
							res.end();
							resolve();
						});
						upRes.on("error", reject);
					},
				);
				up.on("error", reject);
				up.end(out);
			});
		} catch (err) {
			if (!abort.signal.aborted && gen === this.generation) {
				// The connection to the other machine broke: the work waits for it, it did not fail.
				this.lost("unreachable", `connection lost: ${(err as Error).message}`);
			}
			if (!res.headersSent) reply(res, 503, `${this.endpoint} is unreachable`, "unavailable");
			else res.destroy();
		} finally {
			this.inflight.delete(abort);
		}
	}
}

/** Read a secret file (0600) at each use, so a replaced file applies without a restart. */
export function secretFile(path: string): () => string {
	return () => readFileSync(path, "utf8").trim();
}

function reply(res: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
	res.req.resume();
	res.writeHead(status, { "content-type": "application/json", connection: "close" });
	res.end(JSON.stringify({ error: { code: status, message, type } }));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) return null;
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
