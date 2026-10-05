// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Web chat delivery adapter. "Sending" to the owner's web chat is appending
 * to their transcript (`web_feed`), which the browser polls. The receipt is
 * therefore `ui_enqueued`, weaker than the browser confirming it showed the
 * message (`client_ack`, set by POST /api/ack). Because the transcript is in
 * the same database, an interrupted send can be reconciled exactly.
 */

import type { Logger } from "../../log.ts";
import type { ChannelAdapter, Chunk, OutboundAction, SendResult } from "../../outbox/outbox.ts";
import type { Db } from "../../state/db.ts";
import { appendFeed, feedByActionId } from "../../state/web.ts";

export class WebChatAdapter implements ChannelAdapter {
	readonly channel = "web" as const;
	/** The transcript has no length limit: a web reply is always one chunk. */
	readonly maxChunkChars = Number.POSITIVE_INFINITY;
	private readonly db: Db;
	private readonly now: () => Date;
	private readonly onAppend: () => void;

	constructor(deps: { db: Db; log: Logger; now?: () => Date; onAppend?: () => void }) {
		this.db = deps.db;
		this.now = deps.now ?? (() => new Date());
		this.onAppend = deps.onAppend ?? (() => {});
	}

	async sendChunk(action: OutboundAction, chunk: Chunk): Promise<SendResult> {
		if (action.route.channel !== "web") return { ok: false, level: "none", error: "not a web route" };
		const seq = appendFeed(this.db, {
			// Iyye's own messages read as Iyye speaking; failure notices stand out.
			kind: action.kind === "failure_notice" ? "notice" : "reply",
			text: chunk.text,
			at: this.now().toISOString(),
			eventId: action.eventId || undefined,
			actionId: action.id,
		});
		this.onAppend();
		const existing = seq ?? feedByActionId(this.db, action.id)?.seq;
		return { ok: true, level: "ui_enqueued", providerRef: `feed:${existing}` };
	}

	reconcileChunk(action: OutboundAction): SendResult | null {
		const row = feedByActionId(this.db, action.id);
		return row ? { ok: true, level: "ui_enqueued", providerRef: `feed:${row.seq}` } : null;
	}
}
