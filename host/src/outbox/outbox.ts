// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The transactional outbox (HLD §7.3, plan M6). Every outward message is an
 * `actions` row before any adapter runs, and it is delivered only to the
 * exact route of the message it answers. There is no fallback channel.
 *
 * States: queued → sending → delivered
 *                          ↘ failed (retryable, waits for next_attempt_at) → queued …
 *                          ↘ terminal_failure (rejected, or retries exhausted)
 *                          ↘ unknown (may have been sent; only the owner resolves it)
 *
 * Write order for one attempt:
 *   1. the action (content, hash, idempotency key, route) is committed `queued`;
 *   2. it is claimed (`queued` → `sending`) in one conditional update, so two
 *      senders can never both send it;
 *   3. on the first attempt its chunks are persisted as `pending` receipts
 *      (the split is stored, never recomputed);
 *   4. per chunk, in order: the receipt is committed `sending`, the adapter is
 *      called, and the receipt is committed `delivered` / `failed` / `unknown`;
 *   5. when every chunk is delivered, the action is `delivered` and, for a
 *      reply, the event `answered` and the job `settled`, in one transaction.
 *
 * Adapters return ok:false for a definite non-delivery (with `retryable` when
 * trying again could help) and throw only when the message may have gone out.
 * Retries resume at the first undelivered chunk; a retryable failure never
 * blocks the caller, the dispatcher retries it after `next_attempt_at`.
 */

import { createHash } from "node:crypto";
import type { Channel } from "../channels/types.ts";
import type { Logger } from "../log.ts";
import { getCommitment, quoteReminder, settleCommitment } from "../state/commitments.ts";
import type { Db } from "../state/db.ts";
import { type EventRow, getEvent } from "../state/events.ts";
import { recordEpisode } from "../state/stm.ts";
import { splitOffsets } from "./split.ts";

/** A conversation's route: where a turn came from and where its reply goes. */
export type ChatRoute = { channel: "web"; contact: "owner" } | { channel: "telegram"; chatId: number };
/**
 * An email (plan 0.014): one address and its subject; a reply to a mail (plan 0.015) also names the mail it
 * answers. Never the route of a turn with tools: a mail's turn has none.
 */
export type EmailRoute = { channel: "email"; to: string; subject: string; inReplyTo?: string; references?: string };
export type Route = ChatRoute | EmailRoute;
/** Channels the outbox delivers on. */
export type OutboundChannel = Channel;
export type ActionKind = "reply" | "failure_notice";
export type ActionState = "prepared" | "queued" | "sending" | "delivered" | "failed" | "unknown" | "terminal_failure";

export interface OutboundAction {
	id: string;
	/** `message`: Iyye's own message to the owner, answering nothing (plan 0.007 S3). */
	kind: ActionKind | "message";
	eventId: string;
	route: Route;
	content: string;
}

export interface Chunk {
	index: number;
	total: number;
	text: string;
}

export interface SendResult {
	ok: boolean;
	/** Strength of the acknowledgement, e.g. "ui_enqueued" or "provider_accepted". */
	level: string;
	providerRef?: string;
	error?: string;
	/** For ok:false: nothing was sent and trying again later could succeed. */
	retryable?: boolean;
	/** For a retryable failure: the earliest sensible retry, in seconds (e.g. Telegram's retry_after). */
	retryAfterS?: number;
}

export interface ChannelAdapter {
	readonly channel: OutboundChannel;
	/** Longest chunk the channel accepts, in UTF-16 code units (Infinity: never split). */
	readonly maxChunkChars: number;
	/** Return ok:false for a definite non-delivery; throw only when the outcome is uncertain. */
	sendChunk(action: OutboundAction, chunk: Chunk): Promise<SendResult>;
	/** For adapters that can check exactly: the receipt of an earlier send of this chunk, or null if it never landed. */
	reconcileChunk?(action: OutboundAction, index: number): SendResult | null;
	/** Best-effort "typing…" signal on a route. Not an action: no record, no receipt. */
	typing?(route: Route): Promise<void>;
}

export interface ActionRow {
	id: string;
	job_id: string | null;
	event_id: string | null;
	kind: ActionKind | "status";
	route_json: string;
	content_hash: string;
	content: string | null;
	idempotency_key: string;
	state: ActionState;
	attempts: number;
	created_at: string;
	next_attempt_at: string | null;
	last_error: string | null;
	resolution: string | null;
	resolved_by: string | null;
	resolved_at: string | null;
	/** The commitment this action fulfils (plan 0.006): settled with the action, in the same transaction. */
	commitment_id: string | null;
}

export interface ReceiptRow {
	action_id: string;
	chunk_index: number;
	adapter: string;
	level: string;
	provider_ref: string | null;
	acknowledged_at: string | null;
	outcome: "pending" | "sending" | "delivered" | "failed" | "unknown";
	error: string | null;
	chunk_start: number | null;
	chunk_end: number | null;
}

export type Resolution = "delivered" | "resend" | "dismiss";

/** Crash-injection points for tests; a hook that throws leaves the database exactly as a crash would. */
export interface OutboxHooks {
	beforeChunkMarked?(actionId: string, index: number): void;
	afterChunkMarked?(actionId: string, index: number): void;
	afterAdapter?(actionId: string, index: number): void;
}

export interface OutboxDeps {
	db: Db;
	adapters: ChannelAdapter[];
	log: Logger;
	now?: () => Date;
	newId?: () => string;
	/** Attempts before a retryable failure becomes terminal. */
	maxAttempts?: number;
	/** Delay before attempt n+1, by n (last value repeats). */
	backoffMs?: number[];
	/** How often the dispatcher looks for due retries. */
	dispatchIntervalMs?: number;
	hooks?: OutboxHooks;
	/** True while asleep: retries wait until waking (HLD §15 #11). */
	held?: () => boolean;
}

/** A reply to a mail: to its sender, "Re: " its subject, threaded by its Message-ID. */
function emailReplyRoute(event: EventRow): EmailRoute {
	const p = JSON.parse(event.payload_json) as {
		from?: { address?: unknown };
		subject?: unknown;
		messageId?: unknown;
		references?: unknown;
	};
	const to = typeof p.from?.address === "string" ? p.from.address : "";
	if (!to) throw new Error(`mail ${event.id} has no sender to reply to`);
	const subject = typeof p.subject === "string" && p.subject.trim() ? p.subject.trim() : "your message";
	const id = typeof p.messageId === "string" ? p.messageId : null;
	const refs = [...(typeof p.references === "string" ? p.references.split(/\s+/) : []), ...(id ? [id] : [])]
		.filter(Boolean)
		.slice(-10)
		.join(" ");
	return {
		channel: "email",
		to,
		subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
		...(id ? { inReplyTo: id } : {}),
		...(refs ? { references: refs } : {}),
	};
}

export class Outbox {
	private readonly d: Required<OutboxDeps>;
	private readonly adapters = new Map<OutboundChannel, ChannelAdapter>();
	private dispatcher: NodeJS.Timeout | null = null;
	private readonly inFlight = new Set<Promise<unknown>>();
	private dispatching = false;

	constructor(deps: OutboxDeps) {
		this.d = {
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			maxAttempts: 4,
			backoffMs: [5000, 30_000, 120_000],
			dispatchIntervalMs: 1000,
			hooks: {},
			...deps,
			held: deps.held ?? (() => false),
		};
		for (const a of deps.adapters) this.adapters.set(a.channel, a);
	}

	/**
	 * The only route a reply to this event may take: the channel and chat it came from; for a mail (plan
	 * 0.015), its sender's address, in the same thread.
	 */
	static routeFor(event: EventRow): Route {
		if (event.channel === "email") return emailReplyRoute(event);
		return Outbox.chatRouteFor(event);
	}

	/** The route of a conversation turn (web or Telegram); a mail's event has none. */
	static chatRouteFor(event: EventRow): ChatRoute {
		if (event.channel === "web") return { channel: "web", contact: "owner" };
		if (event.channel !== "telegram") throw new Error(`event ${event.id} is not a conversation turn`);
		const payload = JSON.parse(event.payload_json) as { message?: { chatId?: unknown } };
		const chatId = payload.message?.chatId;
		if (typeof chatId !== "number") throw new Error(`event ${event.id} has no Telegram chat to reply to`);
		return { channel: "telegram", chatId };
	}

	/** Start retrying due `failed` actions in the background. */
	start(): void {
		if (this.dispatcher) return;
		this.dispatcher = setInterval(() => void this.dispatchDue(), this.d.dispatchIntervalMs);
		this.dispatcher.unref();
	}

	/** Stop retrying and wait (bounded) for sends already in progress: aborting one mid-flight would create an unknown. */
	async stop(maxWaitMs = 15_000): Promise<void> {
		if (this.dispatcher) clearInterval(this.dispatcher);
		this.dispatcher = null;
		await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => setTimeout(r, maxWaitMs))]);
	}

	/** Prepare one action answering `event` and make one attempt to deliver it. */
	async deliver(req: { jobId: string; event: EventRow; kind: ActionKind; content: string }): Promise<ActionRow> {
		const id = this.d.newId();
		const route = Outbox.routeFor(req.event);
		this.d.db
			.prepare(
				`INSERT INTO actions (id, job_id, event_id, kind, route_json, content_hash, content, idempotency_key, state, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
			)
			.run(
				id,
				req.jobId,
				req.event.id,
				req.kind,
				JSON.stringify(route),
				sha256(req.content),
				req.content,
				`action:${id}`,
				this.iso(),
			);
		return this.send(id);
	}

	/**
	 * Iyye's own message to the owner (plan 0.007 S3): a day summary, a wake
	 * check, later a finding. The route is always the owner's web chat, never
	 * Telegram (owner decision 7). `key` makes it idempotent: the same key is
	 * one action, however often it is asked for (a restart, a retried night).
	 * While asleep it waits, queued, and is sent after waking (HLD §15 #11).
	 */
	notifyOwner(req: { key: string; content: string }): Promise<ActionRow> {
		return this.sendOwn({ key: req.key, route: { channel: "web", contact: "owner" }, content: req.content });
	}

	/**
	 * An Iyye message that answers nothing, on an exact route: a notice to the
	 * owner, or a reminder to the chat that asked for it (plan 0.006). With a
	 * `commitmentId` the commitment becomes `due` in the same transaction that
	 * creates the action, and the action's end settles it. Idempotent by `key`;
	 * held (queued) while asleep.
	 */
	async sendOwn(req: { key: string; route: Route; content: string; commitmentId?: string }): Promise<ActionRow> {
		const id = this.d.newId();
		const key = `notice:${req.key}`;
		const at = this.iso();
		const inserted = this.d.db.transaction(() => {
			const n = this.d.db
				.prepare(
					`INSERT INTO actions (id, job_id, event_id, kind, route_json, content_hash, content, idempotency_key, state, created_at, commitment_id)
					 VALUES (?, NULL, NULL, 'status', ?, ?, ?, ?, 'queued', ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`,
				)
				.run(
					id,
					JSON.stringify(req.route),
					sha256(req.content),
					req.content,
					key,
					at,
					req.commitmentId ?? null,
				).changes;
			if (n && req.commitmentId) {
				this.d.db
					.prepare("UPDATE commitments SET state = 'due', action_id = ? WHERE id = ? AND state = 'scheduled'")
					.run(id, req.commitmentId);
			}
			return n;
		})();
		const row = this.d.db.prepare("SELECT * FROM actions WHERE idempotency_key = ?").get(key) as ActionRow;
		if (!inserted || this.d.held()) return row;
		return this.send(row.id);
	}

	/** True while asleep: Iyye's own messages and retries wait. */
	isHeld(): boolean {
		return this.d.held();
	}

	/** One delivery attempt of a queued action. A no-op unless this call claims it. */
	send(actionId: string): Promise<ActionRow> {
		const p = this.attempt(actionId);
		this.inFlight.add(p);
		void p.finally(() => this.inFlight.delete(p)).catch(() => undefined);
		return p;
	}

	/** Retry every `failed` action whose wait has passed. */
	async dispatchDue(): Promise<number> {
		if (this.dispatching || this.d.held()) return 0;
		this.dispatching = true;
		try {
			// Iyye's own messages queued while asleep go out once awake.
			const held = this.d.db
				.prepare("SELECT id FROM actions WHERE state = 'queued' AND kind = 'status' ORDER BY created_at")
				.all() as { id: string }[];
			for (const { id } of held) await this.send(id);
			const due = this.d.db
				.prepare("SELECT id FROM actions WHERE state = 'failed' AND next_attempt_at <= ? ORDER BY next_attempt_at")
				.all(this.iso()) as { id: string }[];
			for (const { id } of due) {
				if (
					this.d.db.prepare("UPDATE actions SET state = 'queued' WHERE id = ? AND state = 'failed'").run(id)
						.changes
				) {
					await this.send(id);
				}
			}
			return due.length;
		} finally {
			this.dispatching = false;
		}
	}

	/**
	 * Recovery after a crash, for an action left `sending`. A chunk caught in
	 * `sending` may have gone out: an adapter that can check exactly settles
	 * it, otherwise the action becomes `unknown` for the owner. If no chunk was
	 * in flight, nothing could have been sent twice, so the action is queued
	 * again and resumes at its first undelivered chunk.
	 */
	reconcile(actionId: string): ActionRow {
		const row = this.get(actionId)!;
		if (row.state !== "sending") return row;
		const action = toOutbound(row);
		const adapter = this.adapters.get(action.route.channel);
		let unknown = false;
		for (const r of this.receipts(actionId).filter((c) => c.outcome === "sending" || c.outcome === "unknown")) {
			const settled = adapter?.reconcileChunk?.(action, r.chunk_index);
			if (settled === undefined || r.outcome === "unknown") {
				this.setChunk(actionId, r.chunk_index, "unknown", {
					level: r.level,
					ok: false,
					error: "interrupted mid-send",
				});
				unknown = true;
			} else if (settled) {
				this.setChunk(actionId, r.chunk_index, "delivered", settled);
			} else {
				this.setChunk(actionId, r.chunk_index, "pending", { ok: false, level: r.level });
			}
		}
		if (unknown) {
			this.setState(actionId, "unknown", "interrupted mid-send: the message may or may not have gone out");
			return this.get(actionId)!;
		}
		if (this.receipts(actionId).length > 0 && this.receipts(actionId).every((r) => r.outcome === "delivered")) {
			this.complete(row);
		} else {
			this.d.db.prepare("UPDATE actions SET state = 'queued' WHERE id = ?").run(actionId);
		}
		return this.get(actionId)!;
	}

	/**
	 * The owner settles an `unknown` or failed action:
	 * - delivered: they confirm it arrived (receipt level `owner_confirmed`);
	 * - resend: undelivered and unknown chunks are sent again, accepting a possible duplicate;
	 * - dismiss: it is closed as `terminal_failure`.
	 */
	async resolve(actionId: string, resolution: Resolution, by: string): Promise<ActionRow> {
		const row = this.get(actionId);
		if (!row) throw new Error(`no action ${actionId}`);
		if (!["unknown", "failed", "terminal_failure"].includes(row.state)) {
			throw new Error(`action ${actionId} is ${row.state}; only unknown or failed actions can be resolved`);
		}
		const at = this.iso();
		this.d.db
			.prepare("UPDATE actions SET resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?")
			.run(resolution, by, at, actionId);
		if (resolution === "delivered") {
			this.d.db.transaction(() => {
				this.d.db
					.prepare(
						`UPDATE receipts SET outcome = 'delivered', level = 'owner_confirmed', acknowledged_at = ?, error = NULL
						 WHERE action_id = ? AND outcome <> 'delivered'`,
					)
					.run(at, actionId);
				this.complete(row);
			})();
		} else if (resolution === "resend") {
			this.d.db
				.prepare(
					"UPDATE receipts SET outcome = 'pending', error = NULL WHERE action_id = ? AND outcome <> 'delivered'",
				)
				.run(actionId);
			this.d.db.prepare("UPDATE actions SET state = 'queued', next_attempt_at = NULL WHERE id = ?").run(actionId);
			await this.send(actionId);
		} else {
			this.terminal(row, `dismissed by ${by}`);
		}
		this.d.log.info("outbox: action resolved", { actionId, resolution, by });
		return this.get(actionId)!;
	}

	/** Best-effort typing indicator on the route's channel. */
	async typing(route: Route): Promise<void> {
		try {
			await this.adapters.get(route.channel)?.typing?.(route);
		} catch {
			// cosmetic
		}
	}

	get(actionId: string): ActionRow | undefined {
		return this.d.db.prepare("SELECT * FROM actions WHERE id = ?").get(actionId) as ActionRow | undefined;
	}

	receipts(actionId: string): ReceiptRow[] {
		return this.d.db
			.prepare("SELECT * FROM receipts WHERE action_id = ? ORDER BY chunk_index")
			.all(actionId) as ReceiptRow[];
	}

	actionsInState(...states: ActionState[]): ActionRow[] {
		return this.d.db
			.prepare(`SELECT * FROM actions WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at`)
			.all(...states) as ActionRow[];
	}

	/** Upgrade a delivered action's receipts to a stronger acknowledgement (e.g. the browser showed it). */
	acknowledge(actionId: string, level: string): boolean {
		return (
			this.d.db
				.prepare(
					`UPDATE receipts SET level = ?, acknowledged_at = ?
					 WHERE action_id = ? AND outcome = 'delivered' AND level <> ?`,
				)
				.run(level, this.iso(), actionId, level).changes > 0
		);
	}

	// ---------------------------------------------------------------- internals

	private async attempt(actionId: string): Promise<ActionRow> {
		const claimed = this.d.db
			.prepare(
				"UPDATE actions SET state = 'sending', attempts = attempts + 1, next_attempt_at = NULL WHERE id = ? AND state = 'queued'",
			)
			.run(actionId).changes;
		const row = this.get(actionId);
		if (!row) throw new Error(`no action ${actionId}`);
		if (claimed !== 1) return row; // someone else has it, or it is not queued
		const action = toOutbound(row);
		const adapter = this.adapters.get(action.route.channel);
		if (!adapter) {
			this.terminal(row, `no adapter for channel ${action.route.channel}`);
			return this.get(actionId)!;
		}
		const chunks = this.ensureChunks(row, adapter);
		for (const c of chunks) {
			if (c.outcome === "delivered") continue;
			const text = action.content.slice(c.chunk_start ?? 0, c.chunk_end ?? action.content.length);
			this.d.hooks.beforeChunkMarked?.(actionId, c.chunk_index);
			this.d.db
				.prepare("UPDATE receipts SET outcome = 'sending' WHERE action_id = ? AND chunk_index = ?")
				.run(actionId, c.chunk_index);
			this.d.hooks.afterChunkMarked?.(actionId, c.chunk_index);
			let result: SendResult;
			try {
				result = await adapter.sendChunk(action, { index: c.chunk_index, total: chunks.length, text });
			} catch (err) {
				// It may have been sent: never guess, never resend automatically.
				const error = (err as Error).message;
				this.setChunk(actionId, c.chunk_index, "unknown", { ok: false, level: c.level, error });
				this.setState(actionId, "unknown", error);
				this.d.log.error("outbox: send outcome unknown", { actionId, chunk: c.chunk_index, error });
				return this.get(actionId)!;
			}
			this.d.hooks.afterAdapter?.(actionId, c.chunk_index);
			if (!result.ok) {
				this.setChunk(actionId, c.chunk_index, "failed", result);
				this.failed(row, result);
				return this.get(actionId)!;
			}
			this.setChunk(actionId, c.chunk_index, "delivered", result);
		}
		this.complete(row);
		return this.get(actionId)!;
	}

	/** The persisted chunk receipts, created on the first attempt. */
	private ensureChunks(row: ActionRow, adapter: ChannelAdapter): ReceiptRow[] {
		const existing = this.receipts(row.id);
		if (existing.length > 0) return existing;
		const content = row.content ?? "";
		const insert = this.d.db.prepare(
			`INSERT INTO receipts (action_id, chunk_index, adapter, level, outcome, chunk_start, chunk_end)
			 VALUES (?, ?, ?, 'none', 'pending', ?, ?)`,
		);
		this.d.db.transaction(() => {
			splitOffsets(content, adapter.maxChunkChars).forEach(([start, end], i) => {
				insert.run(row.id, i, adapter.channel, start, end);
			});
		})();
		return this.receipts(row.id);
	}

	private setChunk(actionId: string, index: number, outcome: ReceiptRow["outcome"], r: SendResult): void {
		this.d.db
			.prepare(
				`UPDATE receipts SET outcome = ?, level = ?, provider_ref = COALESCE(?, provider_ref), acknowledged_at = ?, error = ?
				 WHERE action_id = ? AND chunk_index = ?`,
			)
			.run(
				outcome,
				r.level,
				r.providerRef ?? null,
				outcome === "delivered" ? this.iso() : null,
				r.error ?? null,
				actionId,
				index,
			);
	}

	private setState(actionId: string, state: ActionState, lastError: string | null): void {
		this.d.db.transaction(() => {
			this.d.db.prepare("UPDATE actions SET state = ?, last_error = ? WHERE id = ?").run(state, lastError, actionId);
			// A reminder that may or may not have gone out is `unknown`, never sent again blindly (HLD §7.3).
			const c = this.get(actionId)?.commitment_id;
			if (state === "unknown" && c) settleCommitment(this.d.db, c, "unknown", this.iso(), lastError);
		})();
	}

	/** A definite non-delivery: retry later if it can help and attempts remain, otherwise stop. */
	private failed(row: ActionRow, result: SendResult): void {
		const attempts = (this.get(row.id)?.attempts ?? row.attempts) as number;
		if (result.retryable && attempts < this.d.maxAttempts) {
			const backoff = this.d.backoffMs[Math.min(attempts - 1, this.d.backoffMs.length - 1)] ?? 5000;
			const waitMs = Math.max(backoff, (result.retryAfterS ?? 0) * 1000);
			this.d.db
				.prepare("UPDATE actions SET state = 'failed', last_error = ?, next_attempt_at = ? WHERE id = ?")
				.run(result.error ?? "failed", new Date(this.d.now().getTime() + waitMs).toISOString(), row.id);
			this.d.log.warn("outbox: delivery failed, will retry", { actionId: row.id, attempts, error: result.error });
			return;
		}
		this.terminal(row, result.error ?? "failed");
	}

	private terminal(row: ActionRow, error: string): void {
		const at = this.iso();
		this.d.db.transaction(() => {
			this.d.db
				.prepare(
					"UPDATE actions SET state = 'terminal_failure', last_error = ?, next_attempt_at = NULL WHERE id = ?",
				)
				.run(error, row.id);
			// A reply to a mail (plan 0.015) that could not go out: recorded in the inbox. A stranger's is only
			// recorded (the job settled, the event `ignored`), so a bounce from a stranger never raises a need.
			const mail = row.kind === "reply" && JSON.parse(row.route_json).channel === "email";
			const stranger =
				mail &&
				(
					this.d.db
						.prepare(
							"SELECT coalesce(c.trusted, 0) AS t FROM events e LEFT JOIN contacts c ON c.id = e.principal_contact_id WHERE e.id = ?",
						)
						.get(row.event_id) as { t: number } | undefined
				)?.t !== 1;
			if (mail)
				this.d.db
					.prepare("UPDATE email_inbox SET verdict = 'failed', reason = ?, decided_at = ? WHERE event_id = ?")
					.run(`the reply could not be sent: ${error.slice(0, 200)}`, at, row.event_id);
			if (row.kind === "reply" && row.job_id) {
				this.d.db
					.prepare(`UPDATE jobs SET status = ?, settled_at = ?, lease_until = NULL WHERE id = ?`)
					.run(stranger ? "settled" : "failed", at, row.job_id);
				if (stranger)
					this.d.db
						.prepare("UPDATE events SET status = 'ignored' WHERE id = ? AND status = 'admitted'")
						.run(row.event_id);
			}
			if (row.commitment_id) settleCommitment(this.d.db, row.commitment_id, "failed", at, error);
		})();
		this.d.log.warn("outbox: delivery failed for good", { actionId: row.id, error });
		if (row.idempotency_key.startsWith("notice:send:")) {
			// A message sent for the owner (plan 0.008) failed for good: the owner is told, once.
			// By the message's own id (its key): the action may fail inside the very call that creates it.
			const sentId = row.idempotency_key.slice("notice:send:".length);
			const to = this.d.db
				.prepare(
					"SELECT c.display_name FROM sent_messages s JOIN contacts c ON c.id = s.recipient_contact_id WHERE s.id = ?",
				)
				.get(sentId) as { display_name: string } | undefined;
			void this.notifyOwner({
				key: `send-failed:${sentId}`,
				content: `Your message to ${JSON.stringify((to?.display_name ?? "a contact").slice(0, 64))} could not be delivered: ${error.slice(0, 200)}`,
			}).catch(() => undefined);
		}
		if (row.idempotency_key.startsWith("notice:email:")) {
			// An email (plan 0.014) failed for good: the owner is told, once (also for a mail a contact asked for).
			const mailId = row.idempotency_key.slice("notice:email:".length);
			const m = this.d.db.prepare("SELECT address FROM sent_emails WHERE id = ?").get(mailId) as
				| { address: string }
				| undefined;
			void this.notifyOwner({
				key: `email-failed:${mailId}`,
				content: `The email to ${m?.address ?? "an address"} could not be delivered: ${error.slice(0, 200)}`,
			}).catch(() => undefined);
		}
		if (row.commitment_id) {
			// One truthful notice to the owner (plan 0.006 §2.1); never for the owner's own notices, so no loop.
			void this.notifyOwner({
				key: `commitment-failed:${row.commitment_id}`,
				content: `${this.reminderLabel(row.commitment_id)} could not be delivered: ${error.slice(0, 200)}`,
			}).catch(() => undefined);
		}
	}

	private complete(row: ActionRow): void {
		const at = this.iso();
		this.d.db.transaction(() => {
			this.d.db
				.prepare("UPDATE actions SET state = 'delivered', last_error = NULL, next_attempt_at = NULL WHERE id = ?")
				.run(row.id);
			if (row.kind === "reply" && row.job_id) {
				this.d.db.prepare("UPDATE events SET status = 'answered' WHERE id = ?").run(row.event_id);
				// The answered turn enters short-term memory in the same transaction (plan 0.002 §3.4).
				const event = row.event_id ? getEvent(this.d.db, row.event_id) : undefined;
				if (event) recordEpisode(this.d.db, event, row, at);
				this.d.db
					.prepare("UPDATE jobs SET status = 'settled', settled_at = ?, lease_until = NULL WHERE id = ?")
					.run(at, row.job_id);
			}
			// Fulfilled only by the receipt of its own action (HLD §7.2, §15 #5).
			if (row.commitment_id) settleCommitment(this.d.db, row.commitment_id, "fulfilled", at);
		})();
	}

	private reminderLabel(commitmentId: string): string {
		const c = getCommitment(this.d.db, commitmentId);
		return c ? quoteReminder(this.d.db, c) : "A reminder";
	}

	private iso(): string {
		return this.d.now().toISOString();
	}
}

export function toOutbound(row: ActionRow): OutboundAction {
	return {
		id: row.id,
		kind: row.kind === "status" ? "message" : row.kind,
		eventId: row.event_id ?? "",
		route: JSON.parse(row.route_json) as Route,
		content: row.content ?? "",
	};
}

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
