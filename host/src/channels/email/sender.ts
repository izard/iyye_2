// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The email delivery adapter (plan 0.014): one action is one mail to the
 * route's single address, with the route's subject, from Iyye's own mailbox.
 * Never split (one chunk). Outcomes, as `smtp.ts` classifies them:
 *
 *   250 after the message      → delivered ("provider_accepted": the server
 *                                took it; not proof anyone read it), receipt =
 *                                the Message-ID
 *   refused, or failed before the message was complete
 *                              → not sent (retried when the cause may pass)
 *   no answer after the message → throws: the action becomes unknown, never
 *                                sent again by itself
 */

import type { Logger } from "../../log.ts";
import type { ChannelAdapter, Chunk, OutboundAction, SendResult } from "../../outbox/outbox.ts";
import { type SmtpResult, type SmtpSettings, sendMail } from "./smtp.ts";

export interface EmailSenderDeps {
	/** The settings with the password, read at each send, or why email is off. */
	load: () => SmtpSettings | string;
	log: Logger;
	now?: () => Date;
	send?: typeof sendMail;
}

export class EmailSender implements ChannelAdapter {
	readonly channel = "email" as const;
	readonly maxChunkChars = Number.POSITIVE_INFINITY;

	private readonly d: EmailSenderDeps;

	constructor(deps: EmailSenderDeps) {
		this.d = deps;
	}

	async sendChunk(action: OutboundAction, chunk: Chunk): Promise<SendResult> {
		const route = action.route;
		if (route.channel !== "email") return { ok: false, level: "smtp", error: "not an email route" };
		const s = this.d.load();
		if (typeof s === "string") return { ok: false, level: "smtp", error: `email is off: ${s}`, retryable: false };
		const messageId = `${action.id}.${chunk.index}@${s.from.split("@")[1]}`;
		const r: SmtpResult = await (this.d.send ?? sendMail)(s, {
			to: route.to,
			subject: route.subject,
			...(route.inReplyTo ? { inReplyTo: route.inReplyTo } : {}),
			...(route.references ? { references: route.references } : {}),
			text: chunk.text,
			messageId,
			date: (this.d.now ?? (() => new Date()))(),
		});
		if (r.ok) return { ok: true, level: "provider_accepted", providerRef: messageId };
		this.d.log.warn("email: not sent", { actionId: action.id, error: r.error, retryable: r.retryable });
		return { ok: false, level: "smtp", error: r.error, retryable: r.retryable };
	}
}
