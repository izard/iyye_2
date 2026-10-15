// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

export type Channel = "web" | "telegram" | "email";

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
	/**
	 * A photo (its largest size within `MAX_IMAGE_BYTES`) or an image sent as a file: only Telegram's file id,
	 * never the image. It is downloaded when a tool looks at it (`channels/telegram/files.ts`).
	 */
	image?: TelegramImage;
}

export interface TelegramImage {
	fileId: string;
	/** Bytes, when Telegram says. */
	size: number | null;
	/** "photo" (Telegram re-encodes them as JPEG) or the document's own image MIME type. */
	kind: "photo" | "image/jpeg" | "image/png" | "image/webp";
}
