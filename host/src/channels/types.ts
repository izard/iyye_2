// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

export type Channel = "web" | "telegram";

/**
 * A message typed by the owner into the local web chat. It carries no
 * principal: the web adapter constructs it only after authenticating the
 * request (plan M4), and admission assigns the owner from the channel.
 */
export interface WebOwnerMessage {
	/** Client-generated id; a retried POST with the same id is one event. */
	clientMsgId: string;
	text: string;
	/** When the client says the owner sent it (informational). */
	observedAt?: string;
}

/**
 * One Telegram `getUpdates` result, normalized by the poller (plan M5).
 * Identity comes from `message.fromUserId` only; names are display data.
 */
export interface TelegramInbound {
	updateId: number;
	/** null for update kinds that are not a new message. */
	message: TelegramMessage | null;
}

export interface TelegramMessage {
	messageId: number;
	chatId: number;
	/** Telegram chat.type: "private", "group", "supergroup", "channel". */
	chatType: string;
	/** null when Telegram supplies no `from` (e.g. channel posts). */
	fromUserId: number | null;
	fromIsBot: boolean;
	username: string | null;
	firstName: string | null;
	/** `text`, falling back to `caption`; "" when neither exists. */
	text: string;
	dateUnix: number | null;
}
