// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Telegram receiving (plan M5), from the 1.x telegram_sensor.py.
 *
 * Long-polls `getUpdates` and admits each update through admission, which
 * stores the event and advances the durable cursor in one transaction. The
 * next poll asks for `cursor + 1`, which is what tells Telegram it may drop
 * everything before it. So:
 * - an update is confirmed to Telegram only after it was durably admitted
 *   (or durably recorded as dropped), never on fetch;
 * - a batch stops at the first admission error and polls again: admitting a
 *   later update would move the cursor past the failed one, and Telegram
 *   would drop it;
 * - a re-delivered update is a duplicate in admission, not a second event.
 *
 * Errors are retried with exponential backoff and jitter. A rejected token
 * (401/404) or a competing poller or webhook (409) marks the channel failed,
 * visible in the owner UI, and is retried slowly rather than in a tight loop.
 * The bot token is scrubbed from everything this module logs or reports.
 */

import { type AdmissionDeps, admitTelegramUpdate, TELEGRAM_CURSOR } from "../../kernel/admission.ts";
import type { Logger } from "../../log.ts";
import { getCursor } from "../../state/cursors.ts";
import { initKv } from "../../state/kv.ts";
import type { TelegramInbound } from "../types.ts";

export type PollerState =
	| { state: "disabled"; detail: string }
	| { state: "starting"; detail: string }
	| { state: "connected"; detail: string }
	| { state: "retrying"; detail: string }
	| { state: "failed"; detail: string }
	| { state: "stopped"; detail: string };

export interface TelegramPollerDeps {
	token: string;
	admission: AdmissionDeps;
	log: Logger;
	/** Called after updates were admitted, so the scheduler starts at once. */
	wake: () => void;
	apiBase?: string;
	/** Long-poll wait Telegram holds a getUpdates open for, in seconds. */
	longPollS?: number;
	/** Backoff bounds for retryable errors, and the slow retry for a failed token or a conflict. */
	minBackoffMs?: number;
	maxBackoffMs?: number;
	failedRetryMs?: number;
}

interface RawUpdate {
	update_id: number;
	message?: {
		message_id: number;
		date?: number;
		chat: { id: number; type: string };
		from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
		text?: string;
		caption?: string;
	};
}

/** Raw Bot API update → the admission envelope. Text falls back to the caption. */
export function normalizeUpdate(raw: RawUpdate): TelegramInbound {
	const m = raw.message;
	if (!m) return { updateId: raw.update_id, message: null };
	return {
		updateId: raw.update_id,
		message: {
			messageId: m.message_id,
			chatId: m.chat.id,
			chatType: m.chat.type,
			fromUserId: m.from?.id ?? null,
			fromIsBot: m.from?.is_bot === true,
			username: m.from?.username ?? null,
			firstName: m.from?.first_name ?? null,
			text: m.text ?? m.caption ?? "",
			dateUnix: m.date ?? null,
		},
	};
}

class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export class TelegramPoller {
	private readonly d: Required<TelegramPollerDeps>;
	private running = false;
	private loopDone: Promise<void> = Promise.resolve();
	private abort: AbortController | null = null;
	private current: PollerState = { state: "stopped", detail: "not started" };
	private botName: string | null = null;
	private acceptAfter: Date | null = null;

	constructor(deps: TelegramPollerDeps) {
		this.d = {
			apiBase: "https://api.telegram.org",
			longPollS: 30,
			minBackoffMs: 1000,
			maxBackoffMs: 60_000,
			failedRetryMs: 300_000,
			...deps,
		};
	}

	get status(): PollerState {
		return this.current;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		// Messages dated before the first ever Telegram start were addressed to 1.x: record, never answer them.
		const now = this.d.admission.now();
		this.acceptAfter = new Date(
			initKv(this.d.admission.db, "telegram_first_start", now.toISOString(), now.toISOString()),
		);
		this.set("starting", "connecting to Telegram");
		this.loopDone = this.loop();
	}

	async stop(): Promise<void> {
		this.running = false;
		this.abort?.abort();
		await this.loopDone;
		this.set("stopped", "stopped");
	}

	/** One getUpdates round and its admissions; returns the number of updates admitted. Exposed for tests. */
	async pollOnce(): Promise<number> {
		const cursor = getCursor(this.d.admission.db, TELEGRAM_CURSOR);
		const params: Record<string, unknown> = { timeout: this.d.longPollS, allowed_updates: ["message"] };
		if (cursor !== undefined) params.offset = cursor + 1;
		const updates = (await this.call("getUpdates", params, (this.d.longPollS + 15) * 1000)) as RawUpdate[];
		let admitted = 0;
		for (const raw of [...updates].sort((a, b) => a.update_id - b.update_id)) {
			const inbound = normalizeUpdate(raw);
			try {
				const r = admitTelegramUpdate(
					{ ...this.d.admission, telegramAcceptAfter: this.acceptAfter ?? undefined },
					inbound,
				);
				if (r.outcome === "admitted") admitted++;
				if (r.outcome === "dropped")
					this.d.log.info("telegram: update dropped", { updateId: raw.update_id, reason: r.reason });
			} catch (err) {
				// Stop the batch here: admitting a later update would move the cursor past this one.
				this.d.log.error("telegram: admission failed; will poll again", {
					updateId: raw.update_id,
					error: this.scrub((err as Error).message),
				});
				break;
			}
		}
		if (admitted > 0) this.d.wake();
		return admitted;
	}

	private async loop(): Promise<void> {
		let failures = 0;
		while (this.running) {
			try {
				if (!this.botName) {
					const me = (await this.call("getMe", {}, 15_000)) as { username?: string };
					this.botName = me.username ? `@${me.username}` : "bot";
				}
				await this.pollOnce();
				failures = 0;
				this.set("connected", `receiving as ${this.botName}`);
			} catch (err) {
				if (!this.running) break;
				failures++;
				const status = err instanceof ApiError ? err.status : 0;
				const message = this.scrub((err as Error).message);
				if (status === 401 || status === 404) {
					this.botName = null;
					this.set("failed", `Telegram rejected the bot token (${message})`);
					await this.sleep(this.d.failedRetryMs);
				} else if (status === 409) {
					this.set("failed", `another poller or a webhook is using this bot (${message})`);
					await this.sleep(this.d.failedRetryMs);
				} else {
					const backoff = Math.min(this.d.maxBackoffMs, this.d.minBackoffMs * 2 ** Math.min(failures - 1, 10));
					const jittered = backoff / 2 + Math.random() * (backoff / 2);
					this.set("retrying", `${message}; retrying in ${Math.round(jittered / 1000)} s`);
					await this.sleep(jittered);
				}
			}
		}
	}

	private async call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
		this.abort = new AbortController();
		const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]);
		let res: Response;
		try {
			res = await fetch(`${this.d.apiBase.replace(/\/$/, "")}/bot${this.d.token}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(params),
				signal,
			});
		} catch (err) {
			const code = (err as { cause?: { code?: string } }).cause?.code;
			throw new Error(`${method}: ${code ?? (err as Error).name ?? "network error"}`);
		}
		const body = (await res.json().catch(() => null)) as {
			ok?: boolean;
			result?: unknown;
			description?: string;
		} | null;
		if (!res.ok || body?.ok !== true) {
			throw new ApiError(res.status, `${method}: HTTP ${res.status} ${body?.description ?? ""}`.trim());
		}
		return body.result;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, ms);
			this.abort = new AbortController();
			this.abort.signal.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private set(state: PollerState["state"], detail: string): void {
		if (this.current.state !== state || this.current.detail !== detail) {
			const level = state === "failed" ? "error" : state === "retrying" ? "warn" : "info";
			this.d.log[level](`telegram: ${state}`, { detail });
		}
		this.current = { state, detail } as PollerState;
	}

	private scrub(text: string): string {
		return this.d.token ? text.split(this.d.token).join("<token>") : text;
	}
}
