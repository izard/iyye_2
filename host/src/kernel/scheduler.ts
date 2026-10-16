// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The job scheduler (the M4 slice of plan M7). It turns admitted messages
 * into answered ones:
 *
 *   queued job → bind the channel's selected model and lease it → Pi turn in
 *   the job's scope → outbox reply (or a failure notice).
 *
 * - One job in flight on the whole host (HLD §5.1: one device-consuming task
 *   at a time), and none while a model is loading.
 * - Order: the owner's jobs first, then oldest first, except that a contact's
 *   job waiting longer than `agingMs` goes ahead of the owner's, so a busy
 *   owner cannot starve a waiting contact. Within one scope, jobs run strictly
 *   in arrival order: if a scope's oldest job cannot run yet, its later jobs
 *   wait too.
 * - The model is bound when the job starts, so `/use` applies from the next
 *   job and a queued job never waits on a model unloaded after admission.
 * - A job whose model is not available waits; after `modelWaitMs` it fails
 *   with a notice. It never substitutes another model.
 * - If the router is lost mid-turn the turn is aborted and the job fails
 *   honestly with a notice (A13); it is not silently retried.
 * - On shutdown the running turn is aborted and its job returns to the queue:
 *   it has no action yet, so nothing was sent.
 *
 * - A running job's lease is renewed while its turn runs; recovery treats a
 *   job left `running` after a restart as interrupted.
 */

import type { Channel } from "../channels/types.ts";
import type { ScopeView } from "../integration/pi/prompt.ts";
import type { TurnRequest } from "../integration/pi/sessions.ts";
import type { TurnResult } from "../integration/pi/turn.ts";
import type { Logger } from "../log.ts";
import type { ModelLease, OpResult } from "../models/manager.ts";
import { type ActionRow, Outbox, type Route } from "../outbox/outbox.ts";
import { getContact, OWNER_CONTACT_ID } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { contactByEmail } from "../state/emails.ts";
import { type EventRow, getEvent, messageText } from "../state/events.ts";
import { failJob, getJob, type JobRow, markJobRunning, queuedJobs, renewLease, requeueJob } from "../state/jobs.ts";
import { emailSession } from "../state/sessions.ts";
import { OWNER_EMAIL_CONTACT_ID } from "./admission.ts";
import { DeviceSlot } from "./device.ts";

/** What the scheduler needs from the model manager. */
export interface SchedulerModels {
	selected(channel: Channel): string | null;
	acquire(name: string): Promise<ModelLease | OpResult>;
	onRouterLost(listener: (lost: string[]) => void): void;
}

export interface SchedulerDeps {
	db: Db;
	/** Shared with memory work: one device-consuming task at a time (HLD §5.1). */
	device?: DeviceSlot;
	models: SchedulerModels;
	conversations: { turn(req: TurnRequest): Promise<TurnResult> };
	outbox: {
		deliver(req: {
			jobId: string;
			event: EventRow;
			kind: "reply" | "failure_notice";
			content: string;
		}): Promise<ActionRow>;
		/** Best-effort typing indicator; not an action. */
		typing?(route: Route): Promise<void>;
	};
	log: Logger;
	now?: () => Date;
	/** How long a job may wait for its model before failing. */
	modelWaitMs?: number;
	/** Re-check interval when idle or waiting for a model. */
	pollMs?: number;
	/** Recorded on a running job and renewed every third of it while the turn runs. */
	leaseMs?: number;
	/** A contact's job older than this goes ahead of the owner's jobs. */
	agingMs?: number;
	/** Adenosine (plan 0.007 S2): the device time each chat turn used. Never refuses a turn. */
	onDeviceTime?: ((jobId: string, ms: number) => void) | null;
	/** Day and night (plan 0.002 L4); without it the scheduler is always awake. */
	rhythm?: SchedulerRhythm | null;
	/**
	 * The voice (plan 0.009 CH4), between the finished answer and the outbox: the content to deliver, and a
	 * callback that records the attempt against the delivered action. It never throws and never waits for a
	 * model; on any doubt it returns the original. The signal stops it at shutdown or a lost router (the
	 * original then goes out: a finished answer is never recomputed).
	 */
	rephrase?:
		| ((
				event: EventRow,
				text: string,
				signal: AbortSignal,
				profile: BoundProfile | null,
		  ) => Promise<{ content: string; record: (actionId: string) => void }>)
		| null;
	/**
	 * The character profile, resolved once when a turn starts and fixed for its reasoning and its delivery
	 * (owner decision 13): `mind` goes into the turn's prompt (owner views only), the whole object to the
	 * voice. A later owner change applies from the next turn. Never throws into the scheduler.
	 */
	bindProfile?: ((jobId: string, event: EventRow) => BoundProfile | null) | null;
	/**
	 * Mail (plan 0.015): answered by one direct model call with no tools, never a Pi turn. `NO_REPLY` from it
	 * means Iyye read the mail and decided not to answer. Without it, mail jobs fail (and send nothing).
	 */
	email?: { turn(event: EventRow, model: string, signal: AbortSignal): Promise<TurnResult> } | null;
}

/** What the email responder returns for a mail it decided not to answer. */
export const EMAIL_NO_REPLY = "NO_REPLY";

/** A turn's bound profile; the scheduler passes it through without reading more than `mind`. */
export interface BoundProfile {
	mind: string | null;
	[key: string]: unknown;
}

export interface SchedulerRhythm {
	mode(): "awake" | "winding_down" | "asleep";
	wakeForOwner(why: string): string;
	/** True while the chat models are being loaded again after the night: jobs wait, they do not fail. */
	restoring?(): boolean;
}

export class Scheduler {
	private readonly d: Required<SchedulerDeps>;
	private running = false;
	private loopDone: Promise<void> = Promise.resolve();
	private wakeUp: (() => void) | null = null;
	private current: { jobId: string; abort: AbortController; reason: "router_lost" | "shutdown" | null } | null = null;
	/** The voice step of the running job, if one is under way (plan 0.009 CH4). */
	private voiceAbort: AbortController | null = null;

	constructor(deps: SchedulerDeps) {
		this.d = {
			now: () => new Date(),
			modelWaitMs: 120_000,
			pollMs: 1000,
			leaseMs: 15 * 60_000,
			agingMs: 60_000,
			device: new DeviceSlot(),
			rhythm: null,
			onDeviceTime: null,
			rephrase: null,
			bindProfile: null,
			email: null,
			...deps,
		};
		this.d.models.onRouterLost(() => this.abortCurrent("router_lost"));
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.loopDone = this.loop();
	}

	/** Abort the running turn (its job goes back to the queue) and stop taking jobs. */
	async stop(): Promise<void> {
		this.running = false;
		this.abortCurrent("shutdown");
		this.wake();
		await this.loopDone;
	}

	/** True while any chat job waits: memory work (plan 0.002 L2) only starts when this is false. */
	hasQueuedJobs(): boolean {
		return queuedJobs(this.d.db).length > 0;
	}

	/**
	 * True while a job waits that would run now. Asleep, only the owner's jobs
	 * count (they wake Iyye): contacts' jobs are held until waking and must not
	 * stall the night's memory work.
	 */
	hasRunnableJobs(): boolean {
		const queued = queuedJobs(this.d.db);
		if (!this.d.rhythm || this.d.rhythm.mode() === "awake") return queued.length > 0;
		return queued.some((j) => j.scope === "owner");
	}

	/** True while a chat turn is running. */
	get busy(): boolean {
		return this.current !== null;
	}

	/** Called after admission so a new job starts without waiting for the poll interval. */
	wake(): void {
		this.wakeUp?.();
	}

	private abortCurrent(reason: "router_lost" | "shutdown"): void {
		this.voiceAbort?.abort();
		if (!this.current) return;
		this.current.reason ??= reason;
		this.current.abort.abort();
	}

	private async loop(): Promise<void> {
		while (this.running) {
			let worked = false;
			try {
				worked = await this.step();
			} catch (err) {
				this.d.log.error("scheduler: step failed", { error: (err as Error).message });
			}
			if (!worked && this.running) await this.idle();
		}
	}

	private idle(): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(done, this.d.pollMs);
			function done() {
				clearTimeout(timer);
				resolve();
			}
			this.wakeUp = () => {
				this.wakeUp = null;
				done();
			};
		});
	}

	/** Run the first job that can run now. Returns false when nothing could. */
	async step(): Promise<boolean> {
		const blocked = new Set<string>();
		const queued = queuedJobs(this.d.db);
		if (this.d.rhythm && this.d.rhythm.mode() !== "awake") {
			// Asleep or winding down: contacts wait until waking; the owner wakes Iyye.
			if (!queued.some((j) => j.scope === "owner")) return false;
			this.d.rhythm.wakeForOwner("the owner wrote");
		}
		for (const job of this.ordered(queued)) {
			if (blocked.has(job.scope)) continue; // an earlier job in this scope is still waiting
			const event = getEvent(this.d.db, job.trigger_event_id);
			if (!event) {
				failJob(this.d.db, job.id, this.iso());
				continue;
			}
			// A mail is answered with the Telegram model (plan 0.015): email has no model of its own.
			const model = this.d.models.selected(event.channel === "email" ? "telegram" : event.channel);
			const lease = model
				? await this.d.models.acquire(model)
				: { ok: false, message: `no model is selected for ${event.channel}` };
			if (!("release" in lease)) {
				blocked.add(job.scope);
				// A busy refusal (a model is loading) clears by itself: keep waiting, never fail for it.
				const waitsAnyway = lease.busy || this.d.rhythm?.restoring?.() === true;
				if (!waitsAnyway && this.d.now().getTime() - Date.parse(job.created_at) > this.d.modelWaitMs) {
					await this.fail(job, event, `no model available (${lease.message})`);
					return true;
				}
				continue; // wait for the model; try other jobs
			}
			try {
				// Waits while memory work holds the device; memory work only starts when no chat job is queued.
				const releaseDevice = await this.d.device.acquire(`chat:${job.id}`);
				const t0 = this.d.now().getTime();
				try {
					// Plan 0.016: a trusted sender's mail from an address the owner stored is a turn with their
					// chat's tools; any other mail gets the tool-less answer (plan 0.015).
					const mail = this.mailView(event);
					if (event.channel === "email" && !mail) await this.runEmail(job, event, lease);
					else await this.run(job, event, lease, mail);
				} finally {
					releaseDevice();
					try {
						this.d.onDeviceTime?.(job.id, this.d.now().getTime() - t0);
					} catch (err) {
						this.d.log.warn("scheduler: device time not recorded", { error: (err as Error).message });
					}
				}
			} finally {
				lease.release();
			}
			return true;
		}
		return false;
	}

	/**
	 * Owner first, oldest first, with aged contact jobs ahead of everything else. Mail from a sender the owner
	 * does not trust (plan 0.015) comes after everything and never ages ahead: anyone may write, and a burst
	 * of mail must not hold up a conversation. A trusted sender's mail is ordered as their chats are.
	 */
	ordered(jobs: JobRow[]): JobRow[] {
		const now = this.d.now().getTime();
		const untrustedMail = new Set(
			(
				this.d.db
					.prepare(
						`SELECT j.id FROM jobs j JOIN events e ON e.id = j.trigger_event_id
						 LEFT JOIN contacts c ON c.id = e.principal_contact_id
						 WHERE j.status = 'queued' AND e.channel = 'email' AND coalesce(c.trusted, 0) = 0`,
					)
					.all() as { id: string }[]
			).map((r) => r.id),
		);
		const rank = (j: JobRow) =>
			untrustedMail.has(j.id)
				? -1
				: j.scope === "owner"
					? 1
					: now - Date.parse(j.created_at) > this.d.agingMs
						? 2
						: 0;
		return [...jobs].sort((a, b) => rank(b) - rank(a) || Date.parse(a.created_at) - Date.parse(b.created_at));
	}

	/** A mail (plan 0.015): one direct model call, then a reply on the mail's thread, or nothing. */
	private async runEmail(job: JobRow, event: EventRow, lease: ModelLease): Promise<void> {
		if (!this.d.email) {
			await this.fail(job, event, "receiving email is not set up");
			return;
		}
		markJobRunning(this.d.db, job.id, lease.model, new Date(this.d.now().getTime() + this.d.leaseMs).toISOString());
		const abort = new AbortController();
		this.current = { jobId: job.id, abort, reason: null };
		const renew = setInterval(
			() => renewLease(this.d.db, job.id, new Date(this.d.now().getTime() + this.d.leaseMs).toISOString()),
			Math.max(1000, Math.floor(this.d.leaseMs / 3)),
		);
		renew.unref();
		let result: TurnResult;
		let reason: "router_lost" | "shutdown" | null = null;
		try {
			result = await this.d.email.turn(event, lease.model, abort.signal);
		} finally {
			clearInterval(renew);
			reason = this.current?.reason ?? null;
			this.current = null;
		}
		if (reason === "shutdown") {
			requeueJob(this.d.db, job.id);
			return;
		}
		if (reason === "router_lost" || !lease.valid()) {
			await this.fail(getJob(this.d.db, job.id)!, event, "the model stopped while answering");
			return;
		}
		if (!result.ok) {
			await this.fail(job, event, `${result.reason}: ${result.message}`);
			return;
		}
		const at = this.iso();
		if (result.text === EMAIL_NO_REPLY) {
			this.d.db.transaction(() => {
				this.d.db
					.prepare("UPDATE jobs SET status = 'settled', settled_at = ?, lease_until = NULL WHERE id = ?")
					.run(at, job.id);
				this.d.db
					.prepare("UPDATE events SET status = 'ignored' WHERE id = ? AND status = 'admitted'")
					.run(event.id);
				this.d.db
					.prepare(
						"UPDATE email_inbox SET verdict = 'ignored', reason = 'no reply needed', decided_at = ? WHERE event_id = ?",
					)
					.run(at, event.id);
			})();
			this.d.log.info("scheduler: a mail needed no reply", { jobId: job.id });
			return;
		}
		this.d.db
			.prepare("UPDATE email_inbox SET verdict = 'replied', reason = NULL, decided_at = ? WHERE event_id = ?")
			.run(at, event.id);
		await this.d.outbox.deliver({ jobId: job.id, event, kind: "reply", content: result.text });
	}

	/**
	 * Plan 0.016 (owner decision 2026-10-16): a mail is a conversation turn with the sender's own chat tools
	 * only when the receiving server verified it, the address is one the owner stored for that very person
	 * (`/person email`; the owner's own address: the trusted contact `owner-email`, never the owner), and the
	 * owner trusts them now. Read when the job runs, so a trust or address removed since admission counts.
	 */
	mailView(event: EventRow): ScopeView | null {
		if (event.channel !== "email" || !event.principal_contact_id) return null;
		const contact = getContact(this.d.db, event.principal_contact_id);
		if (!contact || contact.kind === "owner" || contact.trusted !== 1) return null;
		const verified = this.d.db
			.prepare("SELECT 1 FROM email_inbox WHERE event_id = ? AND authenticated = 1")
			.get(event.id);
		if (!verified) return null;
		const from = (JSON.parse(event.payload_json) as { from?: { address?: unknown } }).from?.address;
		const stored = typeof from === "string" && from ? contactByEmail(this.d.db, from) : null;
		const own = stored === OWNER_CONTACT_ID && contact.id === OWNER_EMAIL_CONTACT_ID;
		if (!own && stored !== contact.id) return null;
		return {
			kind: "contact",
			channel: "email",
			displayName: contact.display_name,
			trusted: true,
			...(own ? { ownAddress: true } : {}),
		};
	}

	/** A conversation turn; `mail`: the view of a mail allowed its sender's tools (`mailView`). */
	private async run(job: JobRow, event: EventRow, lease: ModelLease, mail: ScopeView | null): Promise<void> {
		const leaseUntil = new Date(this.d.now().getTime() + this.d.leaseMs).toISOString();
		markJobRunning(this.d.db, job.id, lease.model, leaseUntil);
		const abort = new AbortController();
		this.current = { jobId: job.id, abort, reason: null };
		const stopTyping = this.startTyping(Outbox.routeFor(event));
		const renew = setInterval(
			() => renewLease(this.d.db, job.id, new Date(this.d.now().getTime() + this.d.leaseMs).toISOString()),
			Math.max(1000, Math.floor(this.d.leaseMs / 3)),
		);
		renew.unref();
		let profile: BoundProfile | null = null;
		try {
			// The bound profile (owner decision 13) is for chats; a mail turn has none.
			profile = mail ? null : (this.d.bindProfile?.(job.id, event) ?? null);
		} catch (err) {
			this.d.log.warn("scheduler: the profile was not bound; the turn runs without it", {
				error: (err as Error).message,
			});
		}
		let result: TurnResult;
		let reason: "router_lost" | "shutdown" | null = null;
		try {
			result = await this.d.conversations.turn({
				scope: job.scope,
				// A person's mail is its own conversation beside their chat (plan 0.016).
				...(mail ? { session: emailSession(job.scope) } : {}),
				view: mail ?? this.viewFor(event),
				model: lease.model,
				text: mail ? mailTurnText(event) : messageText(event),
				signal: abort.signal,
				// Who asked and the exact route back: a reminder made in this turn can reach only this chat
				// (for a mail, its reply thread).
				turn: {
					route: Outbox.routeFor(event),
					contactId: event.principal_contact_id ?? "",
					eventId: event.id,
				},
				mind: profile?.mind ?? null,
			});
		} finally {
			stopTyping();
			clearInterval(renew);
			reason = this.current?.reason ?? null;
			this.current = null;
		}
		if (reason === "shutdown") {
			requeueJob(this.d.db, job.id);
			this.d.log.info("scheduler: job returned to queue at shutdown", { jobId: job.id });
			return;
		}
		if (reason === "router_lost" || !lease.valid()) {
			await this.fail(getJob(this.d.db, job.id)!, event, "the model stopped while answering");
			return;
		}
		if (result.ok && mail) {
			// Never voiced (the voice is for Telegram); the reply goes back on the mail's thread.
			this.d.db
				.prepare("UPDATE email_inbox SET verdict = 'replied', reason = NULL, decided_at = ? WHERE event_id = ?")
				.run(this.iso(), event.id);
			await this.d.outbox.deliver({ jobId: job.id, event, kind: "reply", content: result.text });
		} else if (result.ok) {
			const voiced = await this.voice(event, result.text, profile);
			const action = await this.d.outbox.deliver({ jobId: job.id, event, kind: "reply", content: voiced.content });
			try {
				voiced.record(action.id);
			} catch (err) {
				this.d.log.warn("scheduler: the voice attempt was not recorded", { error: (err as Error).message });
			}
		} else {
			await this.fail(job, event, `${result.reason}: ${result.message}`);
		}
	}

	/** The voice step (plan 0.009 CH4): the original on any failure; typing continues while it runs. */
	private async voice(
		event: EventRow,
		text: string,
		profile: BoundProfile | null,
	): Promise<{ content: string; record: (actionId: string) => void }> {
		const keep = { content: text, record: () => {} };
		if (!this.d.rephrase) return keep;
		const abort = new AbortController();
		this.voiceAbort = abort;
		const stopTyping = this.startTyping(Outbox.routeFor(event));
		try {
			return await this.d.rephrase(event, text, abort.signal, profile);
		} catch (err) {
			this.d.log.warn("scheduler: the voice failed, the original goes out", { error: (err as Error).message });
			return keep;
		} finally {
			stopTyping();
			this.voiceAbort = null;
		}
	}

	async fail(job: JobRow, event: EventRow, reason: string): Promise<void> {
		if (event.channel === "email") {
			// Never "sorry" by mail (plan 0.015): the owner sees the failure in /email. A trusted sender's mail
			// left unanswered is a failed job like any conversation's (it counts in the motivations and the day);
			// a stranger's is only recorded, so spam can never raise a need.
			const at = this.iso();
			this.d.db.transaction(() => {
				if (getContact(this.d.db, event.principal_contact_id ?? "")?.trusted === 1) failJob(this.d.db, job.id, at);
				else {
					this.d.db
						.prepare("UPDATE jobs SET status = 'settled', settled_at = ?, lease_until = NULL WHERE id = ?")
						.run(at, job.id);
					this.d.db
						.prepare("UPDATE events SET status = 'ignored' WHERE id = ? AND status = 'admitted'")
						.run(event.id);
				}
				this.d.db
					.prepare("UPDATE email_inbox SET verdict = 'failed', reason = ?, decided_at = ? WHERE event_id = ?")
					.run(reason.slice(0, 300), at, event.id);
			})();
			this.d.log.warn("scheduler: a mail could not be answered", { jobId: job.id, reason });
			return;
		}
		failJob(this.d.db, job.id, this.iso());
		this.d.log.warn("scheduler: job failed", { jobId: job.id, reason });
		// A notice is not the reply: it never marks the event answered.
		const content =
			this.viewFor(event).kind === "owner"
				? `I couldn't answer that (${reason.slice(0, 300)}).`
				: "Sorry, I couldn't answer that just now.";
		await this.d.outbox.deliver({ jobId: job.id, event, kind: "failure_notice", content });
	}

	/** Telegram shows "typing…" for about 5 s per call, so repeat it while the turn runs. */
	private startTyping(route: Route): () => void {
		const typing = this.d.outbox.typing?.bind(this.d.outbox);
		if (route.channel !== "telegram" || !typing) return () => {};
		void typing(route);
		const timer = setInterval(() => void typing(route), 4000);
		timer.unref();
		return () => clearInterval(timer);
	}

	/** From the principal admission decided (plan 0.005: an owner-linked Telegram account is the owner). */
	private viewFor(event: EventRow): ScopeView {
		const contact = event.principal_contact_id ? getContact(this.d.db, event.principal_contact_id) : undefined;
		if (event.channel === "web" || contact?.kind === "owner") {
			return { kind: "owner", channel: event.channel === "web" ? "web" : "telegram" };
		}
		return {
			kind: "contact",
			channel: "telegram",
			displayName: contact?.display_name ?? "unknown",
			trusted: contact?.trusted === 1,
		};
	}

	private iso(): string {
		return this.d.now().toISOString();
	}
}

/** A mail as a turn's message (plan 0.016): what was cut or not opened is said, so nothing is claimed of it. */
function mailTurnText(event: EventRow): string {
	const p = JSON.parse(event.payload_json) as { truncated?: unknown; attachments?: unknown };
	return [
		messageText(event),
		...(p.truncated === true ? ["[the rest of the mail was too long and is not shown]"] : []),
		...(typeof p.attachments === "number" && p.attachments > 0
			? [`[${p.attachments} attachment(s), not opened]`]
			: []),
	].join("\n");
}
