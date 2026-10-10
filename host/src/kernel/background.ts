// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Background work (plan 0.007 S1): steps Iyye runs on its own, on the
 * background model, while nobody needs the device.
 *
 * - **Precedence** (HLD §5.1): people first. A step starts only while Iyye
 *   is awake, initiative is not paused, no person is waiting, no
 *   conversation was active for `quietMs`, and the previous step ended at
 *   least `gapMs` ago (the throttle). It never loads a model: the background
 *   model is loaded by day like the chat models, or the step waits.
 * - **Pause, as in 1.x** (owner decision 1): a running step holds the device
 *   slot as preemptible. When a chat turn asks for the device, or a person
 *   starts waiting, or Iyye begins to fall asleep, or the owner pauses
 *   initiative, the step's turn is aborted at once. A running tool finishes
 *   first and its result is kept (S0). The step is `paused`; nothing it was
 *   generating is used.
 * - **Resume:** the paused step continues later in the same Pi session (its
 *   checkpoint) with a host note. If the session is gone (sessions are
 *   retired at night), the step starts again from its prompt. A step paused
 *   `maxPauses` times is suspended.
 * - The result of a settled step goes to its origin (`onSettled`); this
 *   module never interprets it.
 */

import { IdleLoop } from "../decisions/idle.ts";
import { HOST_NOTE_PREFIX } from "../integration/pi/context.ts";
import type { TurnRequest } from "../integration/pi/sessions.ts";
import type { TurnResult } from "../integration/pi/turn.ts";
import type { Logger } from "../log.ts";
import type { ModelLease, OpResult } from "../models/manager.ts";
import {
	type BackgroundJob,
	finishBackgroundJob,
	getBackgroundJob,
	insertBackgroundJob,
	markBackgroundRunning,
	pauseBackgroundJob,
	recoverBackgroundJobs,
	runnableBackgroundJobs,
} from "../state/background.ts";
import type { Db } from "../state/db.ts";
import { getKv, setKv } from "../state/kv.ts";
import type { DeviceSlot } from "./device.ts";

export const RESUME_NOTE = `${HOST_NOTE_PREFIX} You were paused and are resuming now. Continue the work where you stopped, using what the tools already returned.`;

const PAUSED_KEY = "background.paused";

export interface BackgroundDeps {
	db: Db;
	device: DeviceSlot;
	models: {
		selected(key: "background"): string | null;
		acquire(name: string): Promise<ModelLease | OpResult>;
		/** Served by another of the owner's machines (plan 0.012). */
		isRemote?(name: string): boolean;
	};
	/** The device slot of the machine a model runs on (plan 0.012); `device` when absent. */
	deviceFor?: ((model: string) => DeviceSlot) | null;
	/** A separate PiConversations for background work (its own sessions, read-only toolkits). */
	conversations: { turn(req: TurnRequest): Promise<TurnResult>; sessionFile(scope: string): string | null };
	/** A person is waiting: a reply job is queued or running. */
	chatPending: () => boolean;
	rhythm?: { mode(): "awake" | "winding_down" | "asleep" } | null;
	log: Logger;
	/** Adenosine (S2): background work waits below the reserve, and pays for its device time. */
	energy?: {
		backgroundAllowed(): boolean;
		level(): number;
		deviceTime(kind: "background", ms: number, ref: string): void;
		charge(kind: "focus_switch" | "background_step", amount: number, ref: string): boolean;
		charges: { focusSwitch: number; backgroundStep: number };
	} | null;
	/** Called once a step settles, with its result (the origin decides what it means). */
	onSettled?: ((job: BackgroundJob) => void) | null;
	/**
	 * Plan 0.010 M4: initiative's allowances. A queued step whose origin's allowance is used up waits (the next
	 * runnable one goes), and every attempt's device time is charged to its origin's motivation, kept or not.
	 */
	initiative?: {
		stepAllowed(origin: string): boolean;
		chargeStep(
			job: { id: string; origin: string },
			attempt: number,
			ms: number,
			remote: boolean,
			kept: boolean,
		): void;
	} | null;
	now?: () => Date;
	newId?: () => string;
	quietMs?: number;
	gapMs?: number;
	maxPauses?: number;
	pollMs?: number;
	/** How often a running step checks whether it must give way. */
	watchMs?: number;
}

export class BackgroundWorker {
	private readonly d: Required<BackgroundDeps>;
	private readonly loop: IdleLoop;
	private current: { job: BackgroundJob; abort: AbortController; giveWay: (why: string) => void } | null = null;
	private lastStepEnd = 0;
	private stopping = false;
	/** Why nothing runs right now, for /focus. */
	private lastReason = "starting";

	constructor(deps: BackgroundDeps) {
		this.d = {
			rhythm: null,
			energy: null,
			onSettled: null,
			initiative: null,
			deviceFor: null,
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			quietMs: 180_000,
			gapMs: 30_000,
			maxPauses: 5,
			pollMs: 2000,
			watchMs: 250,
			...deps,
		};
		this.loop = new IdleLoop({ pollMs: this.d.pollMs, drain: () => this.drainOnce() });
	}

	/** Queue a step. `session` continues an earlier step's conversation; by default each job has its own. */
	enqueue(step: { origin: string; prompt: string; session?: string }): string {
		const id = this.d.newId();
		insertBackgroundJob(this.d.db, {
			id,
			origin: step.origin,
			session: step.session ?? `iyye:bg:${id}`,
			prompt: step.prompt,
			at: this.iso(),
		});
		this.loop.wake();
		return id;
	}

	start(): void {
		const n = recoverBackgroundJobs(this.d.db);
		if (n) this.d.log.info("background: steps interrupted by a restart are paused", { n });
		this.stopping = false;
		this.loop.start();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.current?.abort.abort();
		await this.loop.stop();
	}

	wake(): void {
		this.loop.wake();
	}

	/** `/pause initiative`: no background step starts, and a running one pauses. */
	pauseInitiative(by: string): string {
		if (this.initiativePaused()) return "initiative is already paused";
		setKv(this.d.db, PAUSED_KEY, JSON.stringify({ by, at: this.iso() }), this.iso());
		this.current?.giveWay("initiative was paused by the owner");
		return "Initiative paused: no background work starts until /resume initiative.";
	}

	resumeInitiative(): string {
		if (!this.initiativePaused()) return "initiative is not paused";
		setKv(this.d.db, PAUSED_KEY, "", this.iso());
		this.loop.wake();
		return "Initiative resumed.";
	}

	initiativePaused(): boolean {
		return Boolean(getKv(this.d.db, PAUSED_KEY));
	}

	/** What is running now and why nothing else is, for /focus. */
	status(): { running: BackgroundJob | null; waiting: string } {
		return { running: this.current?.job ?? null, waiting: this.blockedReason() ?? this.lastReason };
	}

	/** Run one step if one may run now (exposed for tests). Returns true if a step ran. */
	async drainOnce(): Promise<boolean> {
		if (this.current || this.stopping) return false;
		const model = this.d.models.selected("background");
		const remote = model !== null && this.d.models.isRemote?.(model) === true;
		const blocked = this.blockedReason({ remote });
		if (blocked) {
			this.lastReason = blocked;
			return false;
		}
		const runnable = runnableBackgroundJobs(this.d.db);
		const job = runnable.find((j) => this.d.initiative?.stepAllowed(j.origin) ?? true);
		if (!job) {
			this.lastReason = runnable.length ? "initiative's allowance is used up for today" : "nothing to do";
			return false;
		}
		if (!model) {
			this.lastReason = "no background model is selected (/use <model> background)";
			return false;
		}
		// Never loads a model: a lease is refused unless the model is already loaded.
		const lease = await this.d.models.acquire(model);
		if (!("release" in lease)) {
			this.lastReason = `the background model is not available: ${lease.message}`;
			return false;
		}
		const again = this.blockedReason({ remote }); // a person may have arrived during the await
		if (again) {
			lease.release();
			this.lastReason = again;
			return false;
		}
		let gaveWay: string | null = null;
		const abort = new AbortController();
		const giveWay = (why: string) => {
			gaveWay ??= why;
			abort.abort();
		};
		// The device of the machine the model runs on: work on another machine never holds this one's.
		const device = this.d.deviceFor?.(model) ?? this.d.device;
		const releaseDevice = device.tryAcquire(`background:${job.id}`, {
			onPreempt: () => giveWay("a person needs the device"),
		});
		if (!releaseDevice) {
			lease.release();
			this.lastReason = `the device is busy (${device.holder})`;
			return false;
		}
		// A paused step continues in its session; if the session is gone (retired at night), it starts again.
		const resume = job.status === "paused" && this.d.conversations.sessionFile(job.session) !== null;
		markBackgroundRunning(this.d.db, job.id, model, this.iso());
		this.current = { job: getBackgroundJob(this.d.db, job.id)!, abort, giveWay };
		const watch = setInterval(() => {
			const why = this.yieldReason({ remote });
			if (why) giveWay(why);
		}, this.d.watchMs);
		watch.unref();
		let result: TurnResult;
		let modelHeld = true;
		const startedMs = this.d.now().getTime();
		const attempt = job.attempts + 1;
		try {
			result = await this.d.conversations.turn({
				scope: job.session,
				view: { kind: "background" },
				model,
				text: resume ? RESUME_NOTE : job.prompt,
				signal: abort.signal,
			});
		} catch (err) {
			result = { ok: false, reason: "error", message: (err as Error).message };
		} finally {
			clearInterval(watch);
			modelHeld = lease.valid(); // before releasing: a released lease is never valid
			releaseDevice();
			lease.release();
			this.current = null;
			this.lastStepEnd = this.d.now().getTime();
			// Device time is paid for whatever happened to the step: once per attempt.
			this.d.energy?.deviceTime("background", this.lastStepEnd - startedMs, `${job.id}:${attempt}`);
			// M4: and charged to its motivation's allowance, kept only if nothing discarded it.
			this.d.initiative?.chargeStep(
				job,
				attempt,
				this.lastStepEnd - startedMs,
				remote,
				!gaveWay && !this.stopping && (modelHeld || !remote),
			);
		}
		if (this.stopping) {
			pauseBackgroundJob(this.d.db, job.id, false); // shutdown: resumable, not counted
			return true;
		}
		if (gaveWay) {
			// Whatever the turn produced after the pause is not used: no stale result commits.
			if (job.pauses + 1 >= this.d.maxPauses) {
				finishBackgroundJob(this.d.db, job.id, "suspended", this.iso(), {
					error: `paused ${job.pauses + 1} times (last: ${gaveWay})`,
				});
				this.d.log.info("background: step suspended", { id: job.id, origin: job.origin });
			} else {
				pauseBackgroundJob(this.d.db, job.id, true);
				if (gaveWay === "a person needs the device" || gaveWay === "a person is waiting")
					this.d.energy?.charge("focus_switch", this.d.energy.charges.focusSwitch, `${job.id}:pause:${attempt}`);
				this.d.log.info("background: step paused", { id: job.id, why: gaveWay });
			}
			return true;
		}
		if (!modelHeld && remote) {
			// The connection to the other machine was lost (plan 0.012): the step waits for it, it did not fail.
			pauseBackgroundJob(this.d.db, job.id, false);
			this.d.log.info("background: step paused", { id: job.id, why: "the remote model's machine was lost" });
			return true;
		}
		if (!modelHeld) {
			finishBackgroundJob(this.d.db, job.id, "failed", this.iso(), { error: "the model stopped during the step" });
			return true;
		}
		if (result.ok) {
			finishBackgroundJob(this.d.db, job.id, "settled", this.iso(), { result: result.text });
			this.d.energy?.charge("background_step", this.d.energy.charges.backgroundStep, job.id);
			try {
				this.d.onSettled?.(getBackgroundJob(this.d.db, job.id)!);
			} catch (err) {
				this.d.log.warn("background: origin handler failed", { id: job.id, error: (err as Error).message });
			}
		} else {
			finishBackgroundJob(this.d.db, job.id, "failed", this.iso(), { error: `${result.reason}: ${result.message}` });
			this.d.log.warn("background: step failed", { id: job.id, reason: result.reason });
		}
		return true;
	}

	/**
	 * Why a step may not start now, or null. Other background work (fact extraction, plan 0.011) obeys it too.
	 * Work on another machine's model (`remote`, plan 0.012) needs nothing of this machine's device, so a
	 * conversation here does not hold it back.
	 */
	blockedReason(opts: { remote?: boolean } = {}): string | null {
		const why = this.yieldReason(opts) ?? this.lowEnergy();
		if (why) return why;
		const now = this.d.now().getTime();
		const last = this.lastChatActivity();
		if (!opts.remote && last !== null && now - last < this.d.quietMs) {
			return `a conversation was active; background work may start at ${hhmm(new Date(last + this.d.quietMs))}`;
		}
		if (now - this.lastStepEnd < this.d.gapMs) return "spacing steps";
		return null;
	}

	/** Why a running step must give way now, or null (fact extraction gives way on the same rules). */
	yieldReason(opts: { remote?: boolean } = {}): string | null {
		if (this.initiativePaused()) return "initiative is paused (/resume initiative)";
		const mode = this.d.rhythm?.mode() ?? "awake";
		if (mode !== "awake") return mode === "asleep" ? "Iyye is asleep" : "Iyye is going to sleep";
		if (!opts.remote && this.d.chatPending()) return "a person is waiting";
		return null;
	}

	/** Below the energy reserve no new step starts; a running one is left to finish. */
	private lowEnergy(): string | null {
		if (!this.d.energy || this.d.energy.backgroundAllowed()) return null;
		return `energy is low (adenosine ${this.d.energy.level().toFixed(2)}): background work waits for the night`;
	}

	/** The latest chat job start or end (owner or contact), in ms. */
	private lastChatActivity(): number | null {
		const row = this.d.db.prepare("SELECT max(coalesce(settled_at, created_at)) AS t FROM jobs").get() as {
			t: string | null;
		};
		return row.t ? Date.parse(row.t) : null;
	}

	private iso(): string {
		return this.d.now().toISOString();
	}
}

function hhmm(d: Date): string {
	return d.toTimeString().slice(0, 5);
}
