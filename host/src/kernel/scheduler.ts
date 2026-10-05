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
import { getContact } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { type EventRow, getEvent, messageText } from "../state/events.ts";
import { failJob, getJob, type JobRow, markJobRunning, queuedJobs, renewLease, requeueJob } from "../state/jobs.ts";
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
			const model = this.d.models.selected(event.channel);
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
					await this.run(job, event, lease);
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

	/** Owner first, oldest first, with aged contact jobs ahead of everything else. */
	ordered(jobs: JobRow[]): JobRow[] {
		const now = this.d.now().getTime();
		const rank = (j: JobRow) => (j.scope === "owner" ? 1 : now - Date.parse(j.created_at) > this.d.agingMs ? 2 : 0);
		return [...jobs].sort((a, b) => rank(b) - rank(a) || Date.parse(a.created_at) - Date.parse(b.created_at));
	}

	private async run(job: JobRow, event: EventRow, lease: ModelLease): Promise<void> {
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
		let result: TurnResult;
		let reason: "router_lost" | "shutdown" | null = null;
		try {
			result = await this.d.conversations.turn({
				scope: job.scope,
				view: this.viewFor(event),
				model: lease.model,
				text: messageText(event),
				signal: abort.signal,
				// Who asked and the exact route back: a reminder made in this turn can reach only this chat.
				turn: {
					route: Outbox.routeFor(event),
					contactId: event.principal_contact_id ?? "",
					eventId: event.id,
				},
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
		if (result.ok) {
			await this.d.outbox.deliver({ jobId: job.id, event, kind: "reply", content: result.text });
		} else {
			await this.fail(job, event, `${result.reason}: ${result.message}`);
		}
	}

	async fail(job: JobRow, event: EventRow, reason: string): Promise<void> {
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
