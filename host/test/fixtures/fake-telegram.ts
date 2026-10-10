// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-process stand-in for the Telegram Bot API: sendMessage,
 * sendChatAction, getMe, getFile (and the file download) and getUpdates (long polling with Telegram's offset
 * semantics: asking for offset N confirms and drops every update below N).
 * Each chat's next sendMessage responses and each method's next responses
 * can be scripted; unscripted requests succeed. Nothing here ever talks to
 * the real Telegram.
 */

import { createServer, type IncomingMessage as HttpRequest, type Server, type ServerResponse } from "node:http";

export type FakeResponse = "ok" | "429" | "400" | "403" | "500" | "hang" | "drop";

export interface SentMessage {
	token: string;
	chatId: number;
	text: string;
	messageId: number;
}

export interface IncomingMessage {
	fromId: number;
	text?: string;
	caption?: string;
	chatId?: number;
	chatType?: string;
	firstName?: string;
	isBot?: boolean;
	noFrom?: boolean;
	/** Unix seconds; defaults to now. */
	date?: number;
	/** A photo's sizes (file ids from `addFile`), as Telegram sends them: smallest first. */
	photo?: { file_id: string; width: number; height: number; file_size?: number }[];
	document?: { file_id: string; mime_type: string; file_size?: number };
}

export type ApiResponse = "401" | "409" | "500" | "drop";

export class FakeTelegram {
	/** Updates not yet confirmed by an offset, in update_id order. */
	readonly pending: Record<string, unknown>[] = [];
	readonly offsets: (number | undefined)[] = [];
	private readonly apiScripts = new Map<string, ApiResponse[]>();
	private nextUpdateId = 1000;
	private waiters: (() => void)[] = [];
	readonly sent: SentMessage[] = [];
	readonly typing: number[] = [];
	readonly requests: { method: string; chatId: number; outcome: FakeResponse }[] = [];
	private readonly scripts = new Map<number, FakeResponse[]>();
	private server: Server | null = null;
	private nextId = 100;
	private readonly files = new Map<string, Buffer>();
	/** Every file download's request path (it holds the token, as Telegram's does). */
	readonly downloads: string[] = [];
	port = 0;

	/** A file `getFile` knows and the download serves. */
	addFile(fileId: string, bytes: Buffer): void {
		this.files.set(fileId, bytes);
	}

	get apiBase(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** The next sendMessage responses for this chat, in order; afterwards requests succeed. */
	script(chatId: number, ...responses: FakeResponse[]): void {
		this.scripts.set(chatId, [...(this.scripts.get(chatId) ?? []), ...responses]);
	}

	/** Queue an incoming private message (as if a user wrote to the bot). Returns its update_id. */
	receive(m: IncomingMessage): number {
		const update_id = this.nextUpdateId++;
		this.pending.push({
			update_id,
			message: {
				message_id: update_id,
				date: m.date ?? Math.floor(Date.now() / 1000),
				chat: { id: m.chatId ?? m.fromId, type: m.chatType ?? "private" },
				...(m.noFrom
					? {}
					: { from: { id: m.fromId, is_bot: m.isBot ?? false, first_name: m.firstName ?? "User" } }),
				...(m.text !== undefined ? { text: m.text } : {}),
				...(m.caption !== undefined ? { caption: m.caption } : {}),
				...(m.photo ? { photo: m.photo } : {}),
				...(m.document ? { document: m.document } : {}),
			},
		});
		for (const w of this.waiters.splice(0)) w();
		return update_id;
	}

	/** The next responses of a Bot API method (getMe, getUpdates), in order. */
	scriptApi(method: string, ...responses: ApiResponse[]): void {
		this.apiScripts.set(method, [...(this.apiScripts.get(method) ?? []), ...responses]);
	}

	messagesTo(chatId: number): string[] {
		return this.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
	}

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			let data = "";
			req.on("data", (c) => {
				data += c;
			});
			req.on("end", () => {
				const dl = /^\/file\/bot[^/]+\/files\/(.+)$/.exec(req.url ?? "");
				if (dl) {
					this.downloads.push(req.url ?? "");
					const bytes = this.files.get(decodeURIComponent(dl[1]!));
					if (!bytes) res.writeHead(404).end();
					else res.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
					return;
				}
				const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
				const body = JSON.parse(data || "{}") as { chat_id: number; text?: string };
				if (!m) {
					res.writeHead(404).end();
					return;
				}
				const [, token, method] = m;
				if (method === "getFile") {
					const id = (body as unknown as { file_id?: string }).file_id ?? "";
					const bytes = this.files.get(id);
					res.writeHead(bytes ? 200 : 400, { "content-type": "application/json" });
					res.end(
						JSON.stringify(
							bytes
								? { ok: true, result: { file_id: id, file_size: bytes.length, file_path: `files/${id}` } }
								: { ok: false, error_code: 400, description: "Bad Request: invalid file_id" },
						),
					);
					return;
				}
				if (method === "getMe" || method === "getUpdates") {
					this.handleApi(method, body as unknown as Record<string, unknown>, res, req);
					return;
				}
				// Scripts shape sendMessage only; the typing indicator (sendChatAction) always succeeds.
				const outcome = (method === "sendMessage" ? this.scripts.get(body.chat_id)?.shift() : undefined) ?? "ok";
				this.requests.push({ method: method!, chatId: body.chat_id, outcome });
				const reply = (status: number, json: unknown) => {
					res.writeHead(status, { "content-type": "application/json" });
					res.end(JSON.stringify(json));
				};
				switch (outcome) {
					case "hang":
						return; // never answer
					case "drop":
						// The request was read (and, for a real server, possibly acted on); the connection dies.
						if (method === "sendMessage") this.record(token!, body);
						req.socket.destroy();
						return;
					case "429":
						return reply(429, {
							ok: false,
							error_code: 429,
							description: "Too Many Requests: retry after 1",
							parameters: { retry_after: 1 },
						});
					case "400":
						return reply(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
					case "403":
						return reply(403, {
							ok: false,
							error_code: 403,
							description: "Forbidden: bot was blocked by the user",
						});
					case "500":
						if (method === "sendMessage") this.record(token!, body);
						return reply(500, { ok: false, error_code: 500, description: "Internal Server Error" });
					default:
						if (method === "sendChatAction") {
							this.typing.push(body.chat_id);
							return reply(200, { ok: true, result: true });
						}
						return reply(200, { ok: true, result: { message_id: this.record(token!, body) } });
				}
			});
		});
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		this.port = (this.server!.address() as { port: number }).port;
	}

	private handleApi(method: string, body: Record<string, unknown>, res: ServerResponse, req: HttpRequest): void {
		const reply = (status: number, json: unknown) => {
			if (res.writableEnded) return;
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(json));
		};
		if (method === "getUpdates") this.offsets.push(body.offset as number | undefined);
		const scripted = this.apiScripts.get(method)?.shift();
		const failures: Partial<Record<ApiResponse, [number, string]>> = {
			"401": [401, "Unauthorized"],
			"409": [409, "Conflict: terminated by other getUpdates request"],
			"500": [500, "Internal Server Error"],
		};
		const failure = scripted ? failures[scripted] : undefined;
		if (failure) {
			reply(failure[0], { ok: false, error_code: failure[0], description: failure[1] });
			return;
		}
		if (scripted === "drop") {
			req.socket.destroy();
			return;
		}
		if (method === "getMe") {
			reply(200, { ok: true, result: { id: 1, is_bot: true, username: "iyye_test_bot" } });
			return;
		}
		const offset = typeof body.offset === "number" ? body.offset : undefined;
		if (offset !== undefined) {
			// Telegram semantics: asking for offset N confirms everything below N.
			while (this.pending.length > 0 && (this.pending[0]!.update_id as number) < offset) this.pending.shift();
		}
		const answer = () => reply(200, { ok: true, result: this.pending.slice(0, 100) });
		if (this.pending.length > 0) {
			answer();
			return;
		}
		const timeoutS = typeof body.timeout === "number" ? body.timeout : 0;
		const timer = setTimeout(answer, timeoutS * 1000);
		this.waiters.push(() => {
			clearTimeout(timer);
			answer();
		});
	}

	async stop(): Promise<void> {
		const s = this.server;
		this.server = null;
		if (!s) return;
		s.closeAllConnections();
		await new Promise<void>((resolve) => s.close(() => resolve()));
	}

	private record(token: string, body: { chat_id: number; text?: string }): number {
		const messageId = this.nextId++;
		this.sent.push({ token, chatId: body.chat_id, text: body.text ?? "", messageId });
		return messageId;
	}
}
