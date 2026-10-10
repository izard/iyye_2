// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import { request } from "node:http";
import { TelegramSender } from "../src/channels/telegram/sender.ts";
import { WebChatAdapter } from "../src/channels/web/adapter.ts";
import { WebSessions } from "../src/channels/web/auth.ts";
import { WebServer } from "../src/channels/web/server.ts";
import { createLocalModelRuntime, thinkingLevelFor } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { Scheduler, type SchedulerDeps } from "../src/kernel/scheduler.ts";
import { silentLogger } from "../src/log.ts";
import { MemoryGateway } from "../src/memory/gateway.ts";
import type { HindsightClient } from "../src/memory/hindsight.ts";
import type { ModelManager } from "../src/models/manager.ts";
import type { RouterProcess } from "../src/models/router.ts";
import { type ChannelAdapter, Outbox } from "../src/outbox/outbox.ts";
import type { Db } from "../src/state/db.ts";
import { ToolBroker, type Toolkit } from "../src/tools/broker.ts";
import { memorySearchTool } from "../src/tools/memory-search.ts";
import { freePort, managerRig, type Sandbox } from "./model-helpers.ts";

export const TOKEN = "a".repeat(64);

export interface Stack {
	db: Db;
	models: ModelManager;
	router: RouterProcess;
	conversations: PiConversations;
	outbox: Outbox;
	scheduler: Scheduler;
	web: WebServer;
	port: number;
	stop(): Promise<void>;
}

export interface StackOptions {
	/** A file database, so a test can stop the stack and start a new one on the same state (a restart). */
	dbPath?: string;
	/** Add a Telegram adapter pointed at this (fake) Bot API. */
	telegramApiBase?: string;
	/** Day recall (plan 0.002 L3): STM always, LTM from this client if given; adds `memory_search`. */
	memory?: { ltm: HindsightClient | null; bankCacheMs?: number };
	/** The web chat's reminders chip (plan 0.006 C3), built from the stack's database. */
	remindersStatus?: (db: Db) => () => string;
	/** Request-local notes per scope, built from the stack's database (e.g. recent reminders, plan 0.006). */
	turnNotes?: (db: Db) => (scope: string) => string | null;
	/** More toolkits for the chat broker, built from the stack's database (e.g. reminders, plan 0.006). */
	toolkits?: (db: Db) => Toolkit[];
	/** The outbox's sleep hold (plan 0.002 L4). */
	outboxHeld?: () => boolean;
	/** The web chat's listen address (IYYE2_WEB_LISTEN). */
	webHost?: string;
}

export async function startStack(
	sb: Sandbox,
	schedulerOverrides: Partial<SchedulerDeps> = {},
	opts: StackOptions = {},
): Promise<Stack> {
	const rig = await managerRig(sb, { healthIntervalMs: 200 }, opts.dbPath);
	await rig.manager.start();
	const db = rig.db;
	const gateway = opts.memory
		? new MemoryGateway({
				db,
				ltm: opts.memory.ltm,
				log: silentLogger,
				...(opts.memory.bankCacheMs === undefined ? {} : { bankCacheMs: opts.memory.bankCacheMs }),
			})
		: null;
	const conversations = new PiConversations({
		db,
		runtime: await createLocalModelRuntime({ routerUrl: rig.router.url, registry: sb.registry }),
		thinkingLevel: (m) => thinkingLevelFor(sb.registry, m),
		stateDir: sb.stateDir,
		identity: "You are Iyye.",
		log: silentLogger,
		memory: gateway,
		turnNotes: opts.turnNotes?.(db) ?? null,
		tools:
			gateway || opts.toolkits
				? new ToolBroker({
						db,
						log: silentLogger,
						toolkits: [
							...(gateway
								? [
										{
											name: "core",
											description: "memory",
											effect: "read" as const,
											tools: [memorySearchTool(gateway)],
										},
									]
								: []),
							...(opts.toolkits?.(db) ?? []),
						],
					})
				: null,
	});
	const adapters: ChannelAdapter[] = [new WebChatAdapter({ db, log: silentLogger })];
	if (opts.telegramApiBase) {
		adapters.push(new TelegramSender({ token: "1:fake", log: silentLogger, apiBase: opts.telegramApiBase }));
	}
	const outbox = new Outbox({ db, log: silentLogger, adapters, held: opts.outboxHeld });
	const scheduler = new Scheduler({
		db,
		models: rig.manager,
		conversations,
		outbox,
		log: silentLogger,
		pollMs: 50,
		...schedulerOverrides,
	});
	const port = await freePort();
	const web = new WebServer({
		port,
		log: silentLogger,
		ownerToken: TOKEN,
		sessions: new WebSessions(db),
		admission: { db, now: () => new Date(), newId: () => crypto.randomUUID() },
		models: rig.manager,
		outbox,
		scheduler,
		telegramStatus: () => "disabled (no TELEGRAM_BOT_TOKEN)",
		...(opts.webHost ? { host: opts.webHost } : {}),
		...(opts.remindersStatus ? { remindersStatus: opts.remindersStatus(db) } : {}),
	});
	await web.start();
	scheduler.start();
	return {
		db,
		models: rig.manager,
		router: rig.router,
		conversations,
		outbox,
		scheduler,
		web,
		port,
		stop: async () => {
			await web.stop();
			await scheduler.stop();
			await conversations.disposeAll();
			await rig.manager.stop();
			db.close();
		},
	};
}

export interface HttpResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: Record<string, unknown>;
	text: string;
}

/**
 * Raw node:http request, so Host and Origin are sent exactly as given
 * (fetch may drop or rewrite them, which would hide a missing check).
 */
export function http(
	port: number,
	method: string,
	path: string,
	opts: {
		host?: string;
		origin?: string | null;
		cookie?: string;
		csrf?: string;
		body?: unknown;
		raw?: string;
		/** The address to connect to (default 127.0.0.1). */
		address?: string;
	} = {},
): Promise<HttpResult> {
	const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
	if (opts.origin !== null && method !== "GET") headers.origin = opts.origin ?? `http://127.0.0.1:${port}`;
	if (opts.cookie) headers.cookie = opts.cookie;
	if (opts.csrf) headers["x-csrf-token"] = opts.csrf;
	const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
	if (payload !== undefined) headers["content-type"] = "application/json";
	return new Promise((resolve, reject) => {
		const req = request({ host: opts.address ?? "127.0.0.1", port, method, path, headers }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => {
				text += c;
			});
			res.on("end", () => {
				let body: Record<string, unknown> = {};
				try {
					body = JSON.parse(text) as Record<string, unknown>;
				} catch {
					// not JSON
				}
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
			});
		});
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

/** Log in and return the cookie and CSRF token for later requests. */
export async function loginAs(port: number): Promise<{ cookie: string; csrf: string }> {
	const r = await http(port, "POST", "/api/login", { body: { token: TOKEN } });
	if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
	const setCookie = r.headers["set-cookie"];
	const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
	return { cookie, csrf: String(r.body.csrf) };
}

let counter = 0;
export function msgId(): string {
	return `test-msg-${Date.now()}-${counter++}`;
}
