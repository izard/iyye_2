// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Telegram delivery adapter (plan M6), from the 1.x telegram_actuator.py.
 *
 * - Sends only to the chat in the action's route; there is no remembered
 *   default chat (1.x learned one from the first sender).
 * - Plain text, no parse_mode: unbalanced Markdown in model output must not
 *   turn into a rejected send. Link previews are off.
 * - Outcomes are classified by what can have happened:
 *     200 ok:true                    → delivered, receipt = message_id ("provider_accepted":
 *                                      Telegram took it; that is not proof a person read it)
 *     429                            → not sent, retry after retry_after
 *     connection refused / DNS / connect timeout → not sent, retry
 *     400/401/403/404 or ok:false    → rejected (e.g. chat not found, bot blocked): no retry
 *     5xx, timeout or a dropped connection after the request was written
 *                                    → may have been sent: throws, so the action becomes unknown
 * - The bot token is part of every API URL, so it is scrubbed from every
 *   error before it can reach a log, an action or a receipt.
 */

import type { Logger } from "../../log.ts";
import type { ChannelAdapter, Chunk, OutboundAction, Route, SendResult } from "../../outbox/outbox.ts";

export const TELEGRAM_MAX_CHARS = 4096;
const NOT_SENT_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
]);

export class TelegramUncertain extends Error {}

export interface TelegramSenderDeps {
	token: string;
	log: Logger;
	/** Bot API base URL; tests point it at a fake server. */
	apiBase?: string;
	timeoutMs?: number;
}

export class TelegramSender implements ChannelAdapter {
	readonly channel = "telegram" as const;
	readonly maxChunkChars = TELEGRAM_MAX_CHARS;
	private readonly token: string;
	private readonly apiBase: string;
	private readonly timeoutMs: number;
	private readonly log: Logger;

	constructor(deps: TelegramSenderDeps) {
		this.token = deps.token;
		this.apiBase = (deps.apiBase ?? "https://api.telegram.org").replace(/\/$/, "");
		this.timeoutMs = deps.timeoutMs ?? 30_000;
		this.log = deps.log;
	}

	async sendChunk(action: OutboundAction, chunk: Chunk): Promise<SendResult> {
		if (action.route.channel !== "telegram") return { ok: false, level: "none", error: "not a Telegram route" };
		const text = chunk.text.trim();
		if (!text) return { ok: true, level: "skipped_empty" };
		let res: Response;
		try {
			res = await fetch(`${this.apiBase}/bot${this.token}/sendMessage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					chat_id: action.route.chatId,
					text,
					link_preview_options: { is_disabled: true },
				}),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			const code = (err as { cause?: { code?: string } }).cause?.code;
			if (code && NOT_SENT_CODES.has(code)) {
				return { ok: false, level: "none", retryable: true, error: this.scrub(`Telegram unreachable (${code})`) };
			}
			throw new TelegramUncertain(this.scrub(`Telegram send interrupted: ${describe(err)}`));
		}
		const body = (await res.json().catch(() => null)) as {
			ok?: boolean;
			result?: { message_id?: number };
			description?: string;
			parameters?: { retry_after?: number };
		} | null;
		if (res.status >= 500) {
			throw new TelegramUncertain(
				this.scrub(`Telegram answered HTTP ${res.status}; the message may have been sent`),
			);
		}
		if (res.ok && body?.ok === true && typeof body.result?.message_id === "number") {
			return { ok: true, level: "provider_accepted", providerRef: String(body.result.message_id) };
		}
		const description = this.scrub(body?.description ?? `HTTP ${res.status}`);
		if (res.status === 429) {
			return {
				ok: false,
				level: "none",
				retryable: true,
				retryAfterS: body?.parameters?.retry_after ?? 5,
				error: `Telegram rate limit: ${description}`,
			};
		}
		return { ok: false, level: "none", retryable: false, error: `Telegram rejected the message: ${description}` };
	}

	async typing(route: Route): Promise<void> {
		if (route.channel !== "telegram") return;
		try {
			const res = await fetch(`${this.apiBase}/bot${this.token}/sendChatAction`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chat_id: route.chatId, action: "typing" }),
				signal: AbortSignal.timeout(5000),
			});
			await res.body?.cancel();
		} catch (err) {
			this.log.info("telegram: typing indicator failed", { error: this.scrub(describe(err)) });
		}
	}

	/** Remove the bot token from any text that might leave this module. */
	scrub(text: string): string {
		return this.token ? text.split(this.token).join("<token>") : text;
	}
}

function describe(err: unknown): string {
	const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
	return [e.name, e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(": ");
}
