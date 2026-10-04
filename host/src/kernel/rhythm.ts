// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Day and night (plan 0.002 L4, the minimal HLD §8.1 modes, as in 1.x):
 *
 *   awake → winding_down → asleep → awake ("waking up day N")
 *
 * - Falls asleep at the start of the rest window once the owner has been
 *   quiet for `quietMs`; on the owner's `/sleep`; or as catch-up when STM
 *   holds episodes older than 24 h and no night has run for 24 h (the
 *   machine was off or asleep at night), once the owner has been quiet for
 *   `catchUpQuietMs`.
 * - Winding down: no new contact jobs; the running turn finishes and is
 *   delivered. Then asleep: the outbox holds retries, and the night's memory
 *   work runs (night.ts).
 * - Tired (plan 0.007 S2): when adenosine falls below its wind-down level,
 *   Iyye sleeps at the next quiet moment (`quietMs`), outside the window too,
 *   for at least `minRestMs`. A completed night refills adenosine to 1; a
 *   night the owner interrupts refills it in proportion to the night it had.
 * - Owner input wakes Iyye at once; the night stops after its current
 *   operation and continues when the owner has been quiet again inside the
 *   window. Contacts' messages wait until waking.
 * - Wakes when the night's work is done, at the end of the window, or when
 *   the work cannot proceed (and says why). The day number advances with
 *   every night that ran, not with an interrupted one.
 * - "starting sleep" and "waking up day N" are local status notices in the
 *   owner's web chat, not outward messages.
 * - The mode is persisted: after a restart an unfinished night resumes.
 */

import type { Logger } from "../log.ts";
import type { NightOutcome } from "../memory/night.ts";
import type { Db } from "../state/db.ts";
import { getKv, setKv } from "../state/kv.ts";
import { endDay } from "../state/stm.ts";
import type { DayWindow } from "./day-summary.ts";

export type Mode = "awake" | "winding_down" | "asleep";

export interface RestWindow {
	/** Minutes after local midnight. A window may wrap past midnight. */
	startMin: number;
	endMin: number;
}

export interface RhythmDeps {
	db: Db;
	window: RestWindow;
	/** The night's work; null when long-term memory is unavailable (the night then only rests). */
	night: { run(shouldStop: () => boolean): Promise<NightOutcome> } | null;
	/** True while a chat turn holds the device; winding down waits for it. */
	turnRunning: () => boolean;
	/** A local status notice in the owner's web chat. */
	notify: (text: string) => void;
	/**
	 * Models for the night: asleep, everything but `keep()` (the memory model)
	 * is unloaded; waking loads the chat models again. Null: models are left alone.
	 */
	models?: {
		restForNight(keep: string[], by: string): Promise<{ ok: boolean; message: string }>;
		wakeFromNight(by: string): Promise<{ ok: boolean; message: string }>;
	} | null;
	keep?: () => string[];
	/**
	 * Called when a night completes, before waking (owner decision 2026-10-03:
	 * chat history does not survive the night). Not called for a night the
	 * owner interrupted: that night is still owed.
	 */
	onNightEnd?: (() => Promise<void>) | null;
	/** Adenosine (plan 0.007 S2): a third reason to sleep, and what the night refills. */
	energy?: {
		tired(): boolean;
		level(): number;
		refill(to: number, kind: "refill_night" | "refill_partial"): void;
		describe(): string;
	} | null;
	/**
	 * The end of a completed day (plan 0.007 S3): `compose` runs at the end of
	 * the night, while the memory model is still loaded; `afterWake` runs once
	 * the day's models are back (the day summary, then the wake check).
	 */
	dayEnd?: {
		compose(w: DayWindow): Promise<string | null>;
		afterWake(day: number, summary: string | null): Promise<void>;
	} | null;
	/** A tired nap lasts at least this long, even when the night has no work. */
	minRestMs?: number;
	/** Backlog entries older than this are dropped at the end of a night. */
	backlogMaxAgeDays?: number;
	/**
	 * True once the night's work can run (the model router and long-term memory
	 * are up). After a restart the night waits for it, at most `readyWaitMs`,
	 * instead of failing at once and losing the night.
	 */
	ready?: () => boolean;
	readyWaitMs?: number;
	log: Logger;
	now?: () => Date;
	quietMs?: number;
	catchUpQuietMs?: number;
	tickMs?: number;
}

const K = {
	mode: "rhythm.mode",
	day: "rhythm.day",
	lastNight: "rhythm.last_night_at",
	reason: "rhythm.sleep_reason",
	ownerActive: "rhythm.owner_active_at",
	sleptAt: "rhythm.slept_at",
	lastSleptAt: "rhythm.last_slept_at",
	lastReason: "rhythm.last_reason",
	lastSummary: "rhythm.last_summary",
	interruptedAt: "rhythm.interrupted_at",
	workAtSleep: "rhythm.night_work_at_sleep",
};

const TIRED = "tired: adenosine is low";

/** What `/night` shows about the night in progress, from the host. */
export interface NightLive {
	/** The device holder label, e.g. "memory:retain:<event>" or "chat:<job>". */
	deviceHolder: string | null;
	/** Conversations still in short-term memory. */
	stmWaiting: number;
	/** Why memory work cannot run, if anything. */
	problem: string | null;
}

export function parseWindow(spec: string): RestWindow {
	const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim());
	if (!m) throw new Error(`rest window must look like 02:00-06:00, got ${JSON.stringify(spec)}`);
	const [h1, m1, h2, m2] = m.slice(1).map(Number) as [number, number, number, number];
	if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) throw new Error(`invalid rest window ${spec}`);
	const startMin = h1 * 60 + m1;
	const endMin = h2 * 60 + m2;
	if (startMin === endMin) throw new Error(`empty rest window ${spec}`);
	return { startMin, endMin };
}

/** The start of the window containing `now`, or null when `now` is outside it. */
export function windowStartFor(now: Date, w: RestWindow): Date | null {
	const minute = now.getHours() * 60 + now.getMinutes();
	const inside =
		w.startMin < w.endMin ? minute >= w.startMin && minute < w.endMin : minute >= w.startMin || minute < w.endMin;
	if (!inside) return null;
	const start = new Date(now);
	start.setHours(Math.floor(w.startMin / 60), w.startMin % 60, 0, 0);
	if (start > now) start.setDate(start.getDate() - 1); // wrapped window, after midnight
	return start;
}

export class Rhythm {
	private readonly d: Required<RhythmDeps>;
	private timer: NodeJS.Timeout | null = null;
	private nightRun: Promise<void> | null = null;
	private stopping = false;
	private restoringModels = false;

	constructor(deps: RhythmDeps) {
		this.d = {
			now: () => new Date(),
			quietMs: 15 * 60_000,
			catchUpQuietMs: 30 * 60_000,
			tickMs: 30_000,
			models: null,
			keep: () => [],
			onNightEnd: null,
			energy: null,
			dayEnd: null,
			minRestMs: 60 * 60_000,
			backlogMaxAgeDays: 7,
			ready: () => true,
			readyWaitMs: 5 * 60_000,
			...deps,
		};
	}

	/** True from waking until the chat models are loaded again: jobs wait for them instead of failing. */
	restoring(): boolean {
		return this.restoringModels;
	}

	mode(): Mode {
		const m = getKv(this.d.db, K.mode);
		return m === "winding_down" || m === "asleep" ? m : "awake";
	}

	day(): number {
		return Number(getKv(this.d.db, K.day) ?? "1") || 1;
	}

	lastNight(): string | null {
		return getKv(this.d.db, K.lastNight);
	}

	start(): void {
		if (this.timer) return;
		this.stopping = false;
		if (this.mode() !== "awake") {
			this.d.log.info("rhythm: resuming the night after a restart", { mode: this.mode() });
			this.beginNight();
		}
		this.timer = setInterval(() => this.tick(), this.d.tickMs);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.nightRun; // stops after its current operation; the mode stays for the restart
	}

	/** Decide whether to fall asleep. Public for tests. */
	tick(): void {
		if (this.mode() !== "awake" || this.nightRun) return;
		const due = this.due(this.d.now());
		if (due.kind === "window" && due.quietLeftMs === 0) this.sleep("rest window");
		else if (due.kind === "catch-up" && due.quietLeftMs === 0)
			this.sleep("catch-up: short-term memory is more than a day old");
		else if (due.kind === "tired" && due.quietLeftMs === 0) this.sleep(TIRED);
	}

	/** Which night is owed now, and how much more owner quiet it needs. */
	private due(now: Date): {
		kind: "window" | "catch-up" | "tired" | "none";
		quietLeftMs: number;
		stmSince: string | null;
	} {
		const quietFor = now.getTime() - this.lastOwnerInput();
		const start = windowStartFor(now, this.d.window);
		const last = this.lastNight();
		const oldest = (
			this.d.db.prepare("SELECT min(said_at) AS t FROM stm_episodes WHERE state IN ('day', 'backlog')").get() as {
				t: string | null;
			}
		).t;
		if (start && (!last || Date.parse(last) < start.getTime())) {
			return { kind: "window", quietLeftMs: Math.max(0, this.d.quietMs - quietFor), stmSince: oldest };
		}
		const dayAgo = now.getTime() - 24 * 3600_000;
		if (oldest && Date.parse(oldest) < dayAgo && (!last || Date.parse(last) < dayAgo)) {
			return { kind: "catch-up", quietLeftMs: Math.max(0, this.d.catchUpQuietMs - quietFor), stmSince: oldest };
		}
		if (this.d.energy?.tired()) {
			return { kind: "tired", quietLeftMs: Math.max(0, this.d.quietMs - quietFor), stmSince: oldest };
		}
		return { kind: "none", quietLeftMs: 0, stmSince: oldest };
	}

	/** `/day`: the mode, the day, and when the next night will start and why. */
	describeDay(stmWaiting: number, backlog = 0): string {
		const now = this.d.now();
		const mode = this.mode();
		const lines = [
			`${mode === "awake" ? "awake" : mode === "asleep" ? "asleep" : "winding down"} · day ${this.day()} · rest window ${showWindow(this.d.window)}`,
		];
		if (mode !== "awake") {
			const since = getKv(this.d.db, K.sleptAt);
			lines.push(
				`sleeping since ${since ? clock(new Date(since), now) : "?"} (${getKv(this.d.db, K.reason) ?? "?"}); see /night`,
			);
		} else {
			const due = this.due(now);
			const quiet = (ms: number) =>
				ms === 0 ? "now (within 30 s)" : `once you have been quiet ${Math.ceil(ms / 60_000)} more min`;
			if (due.kind === "window") lines.push(`next sleep: tonight's night is due, ${quiet(due.quietLeftMs)}`);
			else if (due.kind === "catch-up")
				lines.push(
					`next sleep: catch-up (short-term memory since ${clock(new Date(due.stmSince!), now)}), ${quiet(due.quietLeftMs)}`,
				);
			else if (due.kind === "tired") lines.push(`next sleep: tired (adenosine is low), ${quiet(due.quietLeftMs)}`);
			else lines.push(`next sleep: ${clock(nextWindowStart(now, this.d.window), now)} (rest window)`);
			if (this.restoringModels) lines.push("the chat models are loading again after the night");
		}
		if (this.d.energy) lines.push(`energy: ${this.d.energy.describe()}`);
		lines.push(`short-term memory (today): ${stmWaiting} conversation(s) waiting for the night`);
		if (backlog)
			lines.push(`transfer backlog: ${backlog} earlier conversation(s) not yet stored (not in short-term memory)`);
		const last = this.lastNight();
		lines.push(`last night: ${last ? `ended ${clock(new Date(last), now)}` : "none yet"}`);
		const woken = getKv(this.d.db, K.interruptedAt);
		if (woken && (!last || woken > last))
			lines.push(`woken by you at ${clock(new Date(woken), now)}; that night's work is still owed`);
		return lines.join("\n");
	}

	/** `/night`: the night in progress, if any, and the last completed one. */
	describeNight(live: NightLive): string {
		const now = this.d.now();
		const mode = this.mode();
		const lines: string[] = [];
		if (mode === "awake") {
			lines.push("awake: no night in progress");
		} else {
			const since = getKv(this.d.db, K.sleptAt);
			lines.push(
				`${mode === "asleep" ? "asleep" : "winding down"} since ${since ? clock(new Date(since), now) : "?"} (${getKv(this.d.db, K.reason) ?? "?"})`,
			);
			lines.push(`now: ${doing(mode, live.deviceHolder)}`);
			lines.push(`left to store: ${live.stmWaiting} conversation(s) (today's and the backlog)`);
			if (this.d.models && mode === "asleep")
				lines.push("chat models are unloaded until waking; only the memory model may be loaded");
			if (live.problem) lines.push(`blocked: ${live.problem}`);
		}
		const last = this.lastNight();
		if (!last) {
			lines.push("last night: none yet");
		} else {
			const from = getKv(this.d.db, K.lastSleptAt);
			const took = from ? ` (${Math.max(1, Math.round((Date.parse(last) - Date.parse(from)) / 60_000))} min)` : "";
			lines.push(
				`last night: ${from ? `${clock(new Date(from), now)} – ` : "ended "}${clock(new Date(last), now)}${took}, ${getKv(this.d.db, K.lastReason) ?? "?"}`,
			);
			lines.push(`  ${getKv(this.d.db, K.lastSummary) ?? ""}`);
		}
		return lines.join("\n");
	}

	/** Fall asleep now (rest window, catch-up, or the owner's /sleep). */
	sleep(reason: string): string {
		if (this.mode() !== "awake") return `already ${this.mode().replace("_", " ")}`;
		this.set(K.reason, reason);
		this.set(K.sleptAt, this.d.now().toISOString());
		this.set(K.workAtSleep, String(this.nightWorkLeft()));
		this.set(K.mode, "winding_down");
		this.d.notify(`starting sleep (${reason})`);
		this.d.log.info("rhythm: starting sleep", { reason });
		this.beginNight();
		return "starting sleep";
	}

	/** The owner did something that is not a chat message (a command, a console turn): it counts as not quiet. */
	noteOwnerActivity(): void {
		this.set(K.ownerActive, this.d.now().toISOString());
	}

	/** The owner wrote, or asked to /wake: wake now; an unfinished night continues later. */
	wakeForOwner(why: string): string {
		this.noteOwnerActivity(); // or the next tick would see a quiet owner and fall straight back asleep
		if (this.mode() === "awake") return "already awake";
		const wasAsleep = this.mode() === "asleep";
		this.refillForInterruptedNight();
		this.set(K.interruptedAt, this.d.now().toISOString());
		this.set(K.mode, "awake");
		if (wasAsleep && this.d.models) {
			this.restoringModels = true;
			// The night loop reloads them when it returns; with no night running (a boot), do it here.
			if (!this.nightRun) void this.restoreModels();
		}
		this.d.notify(`waking up day ${this.day()} (${why}; the night's work continues later)`);
		this.d.log.info("rhythm: woken by the owner", { why });
		return "awake";
	}

	private beginNight(): void {
		if (this.nightRun) return;
		this.nightRun = this.night().finally(() => {
			this.nightRun = null;
		});
	}

	private async night(): Promise<void> {
		const awake = () => this.mode() === "awake" || this.stopping;
		while (this.mode() === "winding_down" && !this.stopping && this.d.turnRunning()) await pause(500);
		if (awake()) return;
		this.set(K.mode, "asleep");
		let outcome: NightOutcome | null = null;
		const ending = () => awake() || this.windowOver();
		try {
			if (this.d.models) {
				const r = await this.d.models.restForNight(this.d.keep(), "night");
				this.d.log.info("rhythm: models resting", { message: r.message });
			}
			if (this.d.night) {
				const deadline = Date.now() + this.d.readyWaitMs;
				while (!this.d.ready() && !ending() && Date.now() < deadline) await pause(1000);
				if (!ending() && !this.d.ready()) {
					outcome = {
						kind: "blocked",
						reason: "the model router or long-term memory did not come up",
						completed: 0,
						empty: 0,
						failed: 0,
					};
				} else if (!ending()) {
					outcome = await this.d.night.run(ending);
				}
			}
			// A tired nap rests at least minRestMs, even when the night had nothing to do.
			while (
				getKv(this.d.db, K.reason) === TIRED &&
				!awake() &&
				this.d.now().getTime() - Date.parse(getKv(this.d.db, K.sleptAt) ?? this.d.now().toISOString()) <
					this.d.minRestMs
			)
				await pause(Math.min(1000, this.d.tickMs));
		} catch (err) {
			outcome = { kind: "blocked", reason: (err as Error).message, completed: 0, empty: 0, failed: 0 };
		}
		// The day summary is composed now, while the memory model is still loaded, and only while still asleep.
		// It awaits a model; the completion check comes after it, so an owner who wakes Iyye meanwhile leaves
		// the night owed (its summary is composed when it completes) instead of completing it behind their back.
		let summary: string | null = null;
		if (!awake() && this.d.dayEnd) {
			try {
				summary = await this.d.dayEnd.compose({
					day: this.day(),
					from:
						this.lastNight() ??
						new Date(
							Date.parse(getKv(this.d.db, K.sleptAt) ?? this.d.now().toISOString()) - 86_400_000,
						).toISOString(),
					to: getKv(this.d.db, K.sleptAt) ?? this.d.now().toISOString(),
					outcome,
				});
			} catch (err) {
				this.d.log.warn("rhythm: the day summary failed", { error: (err as Error).message });
			}
		}
		if (this.stopping) return; // the mode stays: after the restart the night resumes
		let completedDay: { day: number; summary: string | null } | null = null;
		if (this.mode() !== "awake") {
			// A completed night ends the day: short-term memory is today only (owner, 2026-10-03). What the
			// night could not store leaves STM for the bounded transfer backlog.
			const ended = endDay(this.d.db, this.d.now(), this.d.backlogMaxAgeDays);
			// Conversations start afresh before waking (memory carries the days).
			let fresh = false;
			try {
				if (this.d.onNightEnd) {
					await this.d.onNightEnd();
					fresh = true;
				}
			} catch (err) {
				this.d.log.warn("rhythm: starting conversations afresh failed", { error: (err as Error).message });
			}
			this.finishNight(outcome, fresh, ended);
			completedDay = { day: this.day() - 1, summary };
		} // else woken by the owner: the night continues later
		await this.restoreModels();
		if (completedDay && this.d.dayEnd) {
			try {
				await this.d.dayEnd.afterWake(completedDay.day + 1, completedDay.summary);
			} catch (err) {
				this.d.log.warn("rhythm: after-waking work failed", { error: (err as Error).message });
			}
		}
	}

	private async restoreModels(): Promise<void> {
		if (!this.d.models) return;
		this.restoringModels = true;
		try {
			const r = await this.d.models.wakeFromNight("waking");
			if (!r.ok) this.d.notify(`after waking: ${r.message}`);
			this.d.log.info("rhythm: models back for the day", { message: r.message });
		} catch (err) {
			this.d.notify(`after waking, the chat models could not be loaded: ${(err as Error).message}`);
		} finally {
			this.restoringModels = false;
		}
	}

	private finishNight(
		outcome: NightOutcome | null,
		freshConversations = false,
		ended: { toBacklog: number; dropped: number } = { toBacklog: 0, dropped: 0 },
	): void {
		const day = this.day() + 1;
		this.set(K.day, String(day));
		this.set(K.lastNight, this.d.now().toISOString());
		this.set(K.lastSleptAt, getKv(this.d.db, K.sleptAt) ?? this.d.now().toISOString());
		this.set(K.lastReason, getKv(this.d.db, K.reason) ?? "?");
		const summary = outcome ? describe(outcome) : "long-term memory is unavailable; nothing was transferred";
		this.set(K.lastSummary, summary);
		this.d.energy?.refill(1, "refill_night");
		if (this.d.models) this.restoringModels = true; // before the scheduler can see the mode change
		this.set(K.mode, "awake");
		const backlog =
			(ended.toBacklog
				? ` ${ended.toBacklog} conversation(s) could not be stored tonight: they left short-term memory and wait for the next night.`
				: "") +
			(ended.dropped
				? ` ${ended.dropped} older conversation(s) could not be stored within ${this.d.backlogMaxAgeDays} days and were dropped from the queue (see /memory).`
				: "");
		this.d.notify(
			`waking up day ${day} — ${summary}${backlog}${freshConversations ? " Conversations start afresh; earlier days are in memory." : ""}`,
		);
		this.d.log.info("rhythm: waking up", { day, outcome });
	}

	/** A rest-window night ends with its window; a catch-up or /sleep night ends when its work is done. */
	private windowOver(): boolean {
		return getKv(this.d.db, K.reason) === "rest window" && windowStartFor(this.d.now(), this.d.window) === null;
	}

	/** Conversations the night still has to store. */
	private nightWorkLeft(): number {
		return (
			this.d.db.prepare("SELECT count(*) AS n FROM stm_episodes WHERE state IN ('day', 'backlog')").get() as {
				n: number;
			}
		).n;
	}

	/**
	 * A night the owner interrupted refills adenosine in proportion to the
	 * night it had: the larger of the share of its work done and the share of
	 * a full rest window slept (1.x: proportional refill on an interrupted wake).
	 */
	private refillForInterruptedNight(): void {
		if (!this.d.energy || this.mode() === "awake") return;
		const at = Number(getKv(this.d.db, K.workAtSleep) ?? "0");
		const work = at > 0 ? Math.max(0, at - this.nightWorkLeft()) / at : 0;
		const slept = this.d.now().getTime() - Date.parse(getKv(this.d.db, K.sleptAt) ?? this.d.now().toISOString());
		const full = ((this.d.window.endMin - this.d.window.startMin + 1440) % 1440) * 60_000;
		const share = Math.min(1, Math.max(work, slept / full));
		const level = this.d.energy.level();
		if (share > 0) this.d.energy.refill(level + (1 - level) * share, "refill_partial");
	}

	private lastOwnerInput(): number {
		const row = this.d.db.prepare("SELECT max(received_at) AS t FROM events WHERE scope = 'owner'").get() as {
			t: string | null;
		};
		const active = getKv(this.d.db, K.ownerActive);
		return Math.max(row.t ? Date.parse(row.t) : 0, active ? Date.parse(active) : 0);
	}

	private set(key: string, value: string): void {
		setKv(this.d.db, key, value, this.d.now().toISOString());
	}
}

function describe(o: NightOutcome): string {
	const moved = `${o.completed} conversation(s) moved to long-term memory, ${o.empty} with nothing worth keeping${o.failed ? `, ${o.failed} failed for good` : ""}`;
	if (o.kind === "done")
		return `${moved}${o.consolidated.length ? `; consolidated ${o.consolidated.length} bank(s)` : ""}.`;
	if (o.kind === "stopped") return `${moved}; the rest stays in short-term memory for the next night.`;
	return `${moved}; stopped early: ${o.reason}. The rest stays in short-term memory.`;
}

function pause(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function showWindow(w: RestWindow): string {
	const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
	return `${hm(w.startMin)}–${hm(w.endMin)}`;
}

/** The next start of the rest window after `now`. */
export function nextWindowStart(now: Date, w: RestWindow): Date {
	const start = new Date(now);
	start.setHours(Math.floor(w.startMin / 60), w.startMin % 60, 0, 0);
	if (start <= now) start.setDate(start.getDate() + 1);
	return start;
}

/** Local time, with the date when it is not today. */
function clock(d: Date, now: Date): string {
	const two = (n: number) => String(n).padStart(2, "0");
	const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
	return d.toDateString() === now.toDateString()
		? hm
		: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}

function doing(mode: Mode, holder: string | null): string {
	if (mode === "winding_down")
		return holder?.startsWith("chat:") ? "waiting for a chat turn to finish" : "getting ready";
	if (!holder) return "between steps";
	if (holder.startsWith("memory:retain:")) return "moving a conversation into long-term memory";
	if (holder.startsWith("memory:consolidate:")) return `consolidating ${holder.slice("memory:consolidate:".length)}`;
	if (holder.startsWith("chat:") || holder === "console") return "answering a message";
	return holder;
}
