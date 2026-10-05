// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The memory pass-through (plan 0.002 L2, HLD §9.3: one admission broker).
 *
 * Hindsight's model calls (fact extraction, consolidation) come here instead
 * of going to the llama.cpp router directly. A call is forwarded only while
 * the memory gate has admitted memory work; at any other time it gets 503, so
 * Hindsight can never put work on the device behind the scheduler's back.
 *
 * - 127.0.0.1 only, a key from a 0600 file (given only to Hindsight); wrong key 401.
 * - Only `POST /v1/chat/completions` (and a stub `GET /v1/models`); anything else 404.
 * - The model is always the admitted one: Hindsight never chooses it. The
 *   model's reasoning is set per request from the admission
 *   (`chat_template_kwargs.enable_thinking`), off unless the admission asks
 *   for it: off made extraction about 3x faster in L0, on extracted more
 *   carefully. Harmless for templates that ignore it.
 * - Responses stream straight through; if Hindsight disconnects, the upstream
 *   request is aborted.
 * - Closing an admission stops new calls, drains in-flight ones (bounded,
 *   then aborts them), and only then reports closed, so the gate can safely
 *   release the model and the device.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "../log.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface PassthroughLease {
	readonly model: string;
	valid(): boolean;
}

export interface Admission {
	readonly model: string;
	/** Requests forwarded under this admission. */
	readonly forwarded: number;
	/** Stop admitting, drain in-flight requests (aborting after `drainMs`), then resolve. */
	close(drainMs?: number): Promise<void>;
}

export interface PassthroughOptions {
	port: number;
	routerUrl: string;
	/** The key Hindsight must send (read at each request, so a rotated file applies). */
	key: () => string;
	log: Logger;
}

interface Current {
	model: string;
	thinking: boolean;
	lease: PassthroughLease;
	closing: boolean;
	forwarded: number;
	inflight: Set<AbortController>;
	drained: (() => void) | null;
}

export class MemoryPassthrough {
	private readonly o: PassthroughOptions;
	private server: Server | null = null;
	private current: Current | null = null;

	constructor(opts: PassthroughOptions) {
		this.o = opts;
	}

	get url(): string {
		return `http://127.0.0.1:${this.o.port}`;
	}

	/** True while memory work is admitted and not closing. */
	get admitted(): boolean {
		return this.current !== null && !this.current.closing;
	}

	start(): Promise<void> {
		this.server = createServer((req, res) => {
			this.handle(req, res).catch((err: unknown) => {
				this.o.log.error("passthrough: request failed", { error: (err as Error).message });
				if (!res.headersSent) reply(res, 502, "upstream error");
				else res.destroy();
			});
		});
		return new Promise((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.o.port, "127.0.0.1", () => resolve());
		});
	}

	async stop(): Promise<void> {
		this.abortAll("passthrough stopping");
		const s = this.server;
		this.server = null;
		if (!s) return;
		s.closeAllConnections();
		await new Promise<void>((resolve) => s.close(() => resolve()));
	}

	/**
	 * Admit memory work on `lease.model`. Only one admission at a time.
	 * `thinking` is the model's reasoning for this work (off unless asked).
	 */
	admit(lease: PassthroughLease, opts: { thinking?: boolean } = {}): Admission {
		if (this.current) throw new Error("memory work is already admitted");
		const cur: Current = {
			model: lease.model,
			thinking: opts.thinking === true,
			lease,
			closing: false,
			forwarded: 0,
			inflight: new Set(),
			drained: null,
		};
		this.current = cur;
		return {
			model: lease.model,
			get forwarded() {
				return cur.forwarded;
			},
			close: async (drainMs = 30_000) => {
				cur.closing = true;
				if (cur.inflight.size > 0) {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(() => {
							for (const a of cur.inflight) a.abort();
							resolve();
						}, drainMs);
						cur.drained = () => {
							clearTimeout(timer);
							resolve();
						};
					});
				}
				if (this.current === cur) this.current = null;
			},
		};
	}

	/** The router was lost: abort whatever is in flight now; later calls get 503 until a new admission. */
	abortAll(reason: string): void {
		const cur = this.current;
		if (!cur) return;
		cur.closing = true;
		if (cur.inflight.size > 0) this.o.log.warn("passthrough: aborting in-flight memory calls", { reason });
		for (const a of cur.inflight) a.abort();
	}

	private isAdmitted(cur: Current | null): boolean {
		return cur !== null && cur === this.current && !cur.closing && cur.lease.valid();
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.headers.authorization !== `Bearer ${this.o.key()}`) return reply(res, 401, "unauthorized");
		const path = (req.url ?? "/").split("?")[0];
		if (req.method === "GET" && path === "/v1/models") {
			req.resume();
			res.writeHead(200, { "content-type": "application/json", connection: "close" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "iyye-memory", object: "model" }] }));
			return;
		}
		if (req.method !== "POST" || path !== "/v1/chat/completions") return reply(res, 404, "not found");
		if (!this.isAdmitted(this.current)) return notAdmitted(res);
		const body = await readBody(req);
		if (body === null) return reply(res, 413, "request too large");
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(body) as Record<string, unknown>;
		} catch {
			return reply(res, 400, "body must be JSON");
		}
		// Check again: the admission may have closed while the body arrived, and the
		// gate may already have released the device. Nothing below awaits before inflight.add.
		const cur = this.current;
		if (!cur || !this.isAdmitted(cur)) return notAdmitted(res);
		payload.model = cur.model;
		payload.chat_template_kwargs = {
			...((payload.chat_template_kwargs as Record<string, unknown> | undefined) ?? {}),
			enable_thinking: cur.thinking,
		};
		const abort = new AbortController();
		cur.inflight.add(abort);
		cur.forwarded++;
		res.on("close", () => {
			if (!res.writableFinished) abort.abort(); // Hindsight went away: stop the work on the device
		});
		try {
			const upstream = await fetch(`${this.o.routerUrl.replace(/\/$/, "")}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: abort.signal,
			});
			res.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") ?? "application/json",
			});
			if (upstream.body) {
				for await (const chunk of upstream.body) res.write(chunk);
			}
			res.end();
		} catch (err) {
			if (abort.signal.aborted) {
				if (!res.headersSent) reply(res, 503, "memory call aborted", "unavailable");
				else res.destroy();
			} else {
				throw err;
			}
		} finally {
			cur.inflight.delete(abort);
			if (cur.inflight.size === 0) cur.drained?.();
		}
	}
}

function notAdmitted(res: ServerResponse): void {
	reply(res, 503, "memory work is not admitted now; Iyye schedules it", "unavailable");
}

function reply(res: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
	res.req.resume(); // discard an unread body, or the client sees a reset instead of this answer
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
