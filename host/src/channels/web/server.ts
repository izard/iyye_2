// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The owner's local web chat (plan M4).
 *
 * Every request:  Host must be 127.0.0.1:<port> or localhost:<port> (blocks
 *                 DNS rebinding). No CORS headers are ever sent.
 * Every POST:     Origin must be present and exactly http://127.0.0.1:<port>
 *                 or http://localhost:<port>; outside /api/login it also
 *                 needs the session cookie and the session's X-CSRF-Token.
 * /api/* reads:   need the session cookie (401 otherwise).
 *
 * Login: the host prints http://127.0.0.1:<port>/login#<token>. The token sits
 * in the URL fragment, which browsers never send, so it never appears in a
 * request line, log or Referer; the page posts it to /api/login.
 *
 * Messages: known owner commands run here (deterministically, never via Pi)
 * and their results go to the transcript; anything else is admitted as a
 * chat message and answered by the scheduler through the outbox.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AdmissionDeps } from "../../kernel/admission.ts";
import { admitOwnerWebMessage } from "../../kernel/admission.ts";
import { type CommandExtras, handleOwnerCommand, isKnownCommand } from "../../kernel/commands.ts";
import type { Logger } from "../../log.ts";
import type { ModelManager } from "../../models/manager.ts";
import type { Outbox, Resolution, Route } from "../../outbox/outbox.ts";
import { getContact } from "../../state/contacts.ts";
import { getEvent } from "../../state/events.ts";
import { MODEL_CHANNELS } from "../../state/models.ts";
import { appendFeed, feedByClientMsgId, feedSince } from "../../state/web.ts";
import { tokenMatches, WebSessions } from "./auth.ts";

const MAX_BODY_BYTES = 64 * 1024;
export const MAX_TEXT_CHARS = 8000;
const CLIENT_MSG_ID = /^[A-Za-z0-9_-]{8,64}$/;
const UI_DIR = new URL("./ui/", import.meta.url);
const STATIC: Record<string, { file: string; type: string }> = {
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/login": { file: "index.html", type: "text/html; charset=utf-8" },
	"/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
	"/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

export interface WebServerDeps {
	port: number;
	log: Logger;
	ownerToken: string;
	sessions: WebSessions;
	admission: AdmissionDeps;
	models: ModelManager;
	outbox: Pick<Outbox, "acknowledge" | "actionsInState" | "receipts" | "resolve" | "get">;
	scheduler: { wake(): void };
	/** Telegram's state as shown to the owner, e.g. "connected: receiving as @bot" or "disabled (no TELEGRAM_BOT_TOKEN)". */
	telegramStatus: () => string;
	/** Long-term memory's state as shown to the owner, e.g. "up: …" or "needs provisioning: …". */
	memoryStatus?: () => string;
	/** The decision service's state (plan 0.003), e.g. "up: jaredpalmer/kev-4b@… (mlx)". */
	decisionsStatus?: () => string;
	/** Iyye's SearXNG (plan 0.004), e.g. "up: SearXNG on 127.0.0.1:8184 (…)". */
	webStatus?: () => string;
	/** Today's reminders (plan 0.006 C3), e.g. "2 due later today · 1 delivered"; empty: no chip. */
	remindersStatus?: () => string;
	/** /sleep, /wake and /memory (plan 0.002). */
	commandExtras?: CommandExtras;
	host?: string;
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export class WebServer {
	private readonly d: WebServerDeps;
	private server: Server | null = null;
	private readonly allowedHosts: Set<string>;
	private readonly allowedOrigins: Set<string>;
	private readonly running = new Set<Promise<unknown>>();

	constructor(deps: WebServerDeps) {
		this.d = deps;
		this.allowedHosts = new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`]);
		this.allowedOrigins = new Set([...this.allowedHosts].map((h) => `http://${h}`));
	}

	get loginUrl(): string {
		return `http://127.0.0.1:${this.d.port}/login#${this.d.ownerToken}`;
	}

	start(): Promise<void> {
		this.server = createServer((req, res) => {
			this.handle(req, res).catch((err: unknown) => {
				const status = err instanceof HttpError ? err.status : 500;
				if (status === 500) this.d.log.error("web: request failed", { error: (err as Error).message });
				if (!res.headersSent)
					json(res, status, { error: err instanceof HttpError ? err.message : "internal error" });
				else res.end();
			});
		});
		return new Promise((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.d.port, this.d.host ?? "127.0.0.1", () => {
				this.d.log.info("web: listening", { url: `http://127.0.0.1:${this.d.port}/` });
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		await Promise.allSettled([...this.running]);
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		securityHeaders(res);
		if (!this.allowedHosts.has(req.headers.host ?? "")) throw new HttpError(403, "unexpected Host header");
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const path = url.pathname;
		const method = req.method ?? "GET";

		if (method === "GET" && STATIC[path]) return this.serveStatic(res, STATIC[path]);
		if (!path.startsWith("/api/")) throw new HttpError(404, "not found");
		res.setHeader("cache-control", "no-store");

		if (method === "POST") {
			const origin = req.headers.origin;
			if (!origin || !this.allowedOrigins.has(origin)) throw new HttpError(403, "cross-origin request refused");
		}
		if (method === "POST" && path === "/api/login") return this.login(req, res);

		const session = this.d.sessions.lookup(req.headers.cookie);
		if (!session) throw new HttpError(401, "not logged in");
		if (method === "POST" && !tokenMatches(req.headers["x-csrf-token"], session.csrf)) {
			throw new HttpError(403, "missing or wrong CSRF token");
		}

		if (method === "GET" && path === "/api/session") return json(res, 200, { csrf: session.csrf });
		if (method === "POST" && path === "/api/logout") {
			this.d.sessions.destroy(session.id);
			res.setHeader("set-cookie", WebSessions.clearCookie());
			return json(res, 200, { ok: true });
		}
		if (method === "GET" && path === "/api/messages") {
			const after = Number(url.searchParams.get("after") ?? 0);
			return json(res, 200, { messages: feedSince(this.d.admission.db, Number.isFinite(after) ? after : 0) });
		}
		if (method === "POST" && path === "/api/messages") return this.postMessage(req, res);
		if (method === "POST" && path === "/api/ack") return this.ack(req, res);
		if (method === "GET" && path === "/api/status") return json(res, 200, await this.status());
		if (method === "GET" && path === "/api/actions") return json(res, 200, { actions: this.attention() });
		if (method === "POST" && path === "/api/actions/resolve") return this.resolve(req, res);
		if (method === "GET" && path === "/api/models") return json(res, 200, await this.d.models.status());
		throw new HttpError(404, "not found");
	}

	private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		if (!tokenMatches(body.token, this.d.ownerToken)) {
			this.d.log.warn("web: login refused");
			throw new HttpError(401, "wrong token");
		}
		const s = this.d.sessions.create();
		res.setHeader("set-cookie", WebSessions.cookie(s.id));
		this.d.log.info("web: owner logged in");
		json(res, 200, { csrf: s.csrf });
	}

	private async postMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		const clientMsgId = body.client_msg_id;
		const text = body.text;
		if (typeof clientMsgId !== "string" || !CLIENT_MSG_ID.test(clientMsgId)) {
			throw new HttpError(400, "client_msg_id must be 8-64 characters of A-Z, a-z, 0-9, _ or -");
		}
		if (typeof text !== "string") throw new HttpError(400, "text must be a string");
		if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, `text is longer than ${MAX_TEXT_CHARS} characters`);
		const at = this.d.admission.now().toISOString();

		if (isKnownCommand(text)) {
			const seq = appendFeed(this.d.admission.db, { kind: "command", text: text.trim(), at, clientMsgId });
			if (seq === null) return json(res, 200, { duplicate: true, command: true });
			this.track(this.runCommand(text));
			return json(res, 202, { command: true });
		}

		const r = admitOwnerWebMessage(this.d.admission, { clientMsgId, text });
		// Insert-or-ignore: a retry after a crash between admission and this line still records it once.
		if (!feedByClientMsgId(this.d.admission.db, clientMsgId)) {
			appendFeed(this.d.admission.db, { kind: "user", text, at, clientMsgId, eventId: r.eventId });
		}
		if (r.outcome === "admitted") this.d.scheduler.wake();
		json(res, r.outcome === "duplicate" ? 200 : 202, { event_id: r.eventId, outcome: r.outcome });
	}

	private async runCommand(text: string): Promise<void> {
		let reply: string;
		try {
			reply = (
				await handleOwnerCommand(text, {
					models: this.d.models,
					db: this.d.admission.db,
					issuer: "owner_web",
					...this.d.commandExtras,
				})
			).reply;
		} catch (err) {
			reply = `command failed: ${(err as Error).message}`;
		}
		appendFeed(this.d.admission.db, {
			kind: "command_result",
			text: reply,
			at: this.d.admission.now().toISOString(),
		});
	}

	private async ack(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		if (typeof body.action_id !== "string") throw new HttpError(400, "action_id required");
		json(res, 200, { upgraded: this.d.outbox.acknowledge(body.action_id, "client_ack") });
	}

	/**
	 * Outward messages that need the owner: sent-or-not unknown, waiting to
	 * retry, or failed for good. A Telegram reply listed here is never copied
	 * into the web transcript (no cross-channel substitute delivery).
	 */
	private attention() {
		const db = this.d.admission.db;
		return this.d.outbox
			.actionsInState("unknown", "failed", "terminal_failure")
			.filter((a) => a.resolution !== "dismiss")
			.slice(-50)
			.map((a) => {
				const route = JSON.parse(a.route_json) as Route;
				const event = a.event_id ? getEvent(db, a.event_id) : undefined;
				const contact = event?.principal_contact_id ? getContact(db, event.principal_contact_id) : undefined;
				const chunks = this.d.outbox.receipts(a.id);
				return {
					id: a.id,
					kind: a.kind,
					state: a.state,
					channel: route.channel,
					recipient:
						route.channel === "web"
							? "owner (web chat)"
							: `${contact?.display_name ?? "unknown contact"} (Telegram)`,
					created_at: a.created_at,
					attempts: a.attempts,
					next_attempt_at: a.next_attempt_at,
					last_error: a.last_error,
					preview: (a.content ?? "").slice(0, 300),
					chunks: { total: chunks.length, delivered: chunks.filter((c) => c.outcome === "delivered").length },
				};
			});
	}

	private async resolve(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		const resolution = body.resolution;
		if (typeof body.action_id !== "string") throw new HttpError(400, "action_id required");
		if (resolution !== "delivered" && resolution !== "resend" && resolution !== "dismiss") {
			throw new HttpError(400, "resolution must be delivered, resend or dismiss");
		}
		const action = this.d.outbox.get(body.action_id);
		if (!action) throw new HttpError(404, "no such action");
		if (!["unknown", "failed", "terminal_failure"].includes(action.state) || action.resolution === "dismiss") {
			throw new HttpError(409, `action is ${action.state}${action.resolution ? ` (${action.resolution})` : ""}`);
		}
		const after = await this.d.outbox.resolve(body.action_id, resolution as Resolution, "owner_web");
		json(res, 200, { state: after.state });
	}

	private async status() {
		const s = await this.d.models.status();
		const modelFor = (channel: "web" | "telegram") => {
			const name = this.d.models.selected(channel);
			const m = s.models.find((x) => x.name === name);
			return { model: name, status: m?.status ?? (name ? "unknown" : "none selected") };
		};
		return {
			host: "up",
			router: s.router,
			availableRamGb: s.availableRamGb,
			channels: Object.fromEntries(MODEL_CHANNELS.map((c) => [c, modelFor(c)])),
			telegram: this.d.telegramStatus(),
			memory: this.d.memoryStatus?.() ?? "disabled: not configured",
			decisions: this.d.decisionsStatus?.() ?? "disabled: not configured",
			web: this.d.webStatus?.() ?? "disabled: not configured",
			reminders: this.d.remindersStatus?.() ?? "",
			attention: this.attention().length,
		};
	}

	private serveStatic(res: ServerResponse, f: { file: string; type: string }): void {
		res.writeHead(200, { "content-type": f.type, "cache-control": "no-cache" });
		res.end(readFileSync(new URL(f.file, UI_DIR)));
	}

	private track(p: Promise<unknown>): void {
		this.running.add(p);
		void p.finally(() => this.running.delete(p));
	}
}

function securityHeaders(res: ServerResponse): void {
	res.setHeader(
		"content-security-policy",
		"default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
	);
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("referrer-policy", "no-referrer");
	res.setHeader("x-frame-options", "DENY");
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
		chunks.push(chunk as Buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
		return parsed as Record<string, unknown>;
	} catch {
		throw new HttpError(400, "body must be a JSON object");
	}
}
