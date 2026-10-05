// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Adenosine (plan 0.007 S2, HLD §8.2; owner decision 3: Iyye 1.0's model):
 * a level from 1 (rested) to 0 (exhausted), charged by what Iyye actually
 * does while awake and refilled by sleep.
 *
 * - **One writer:** every change goes through `charge` or `refill` into
 *   `energy_ledger`. A charge with a reference (an answered turn, a model
 *   operation, a background step) is unique per kind and reference, so it is
 *   never charged twice (1.x lesson: charges centralized).
 * - **Where charges come from:** a periodic sweep over records that already
 *   exist (time awake, answered turns, model loads and unloads), and device
 *   time reported by the scheduler and the background worker.
 * - **What it does:** below `reserve` no new background work starts; below
 *   `windDown` Iyye goes to sleep at the next quiet moment. Owner chat is
 *   never refused, at any level.
 * - **Refill:** a completed night restores 1; a night the owner interrupted
 *   restores in proportion to the night it had; a restart restores nothing.
 *   A refill also moves the sweep's watermark, so the night's own model
 *   unloads are absorbed by it instead of charged to the next day.
 */

import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import { getKv, setKv } from "../state/kv.ts";

/** Costs, as a fraction of a full level. Starting values from 1.x (plan 0.007 §2.2), tuned from the ledger. */
export interface EnergyCharges {
	awakePerHour: number;
	stmWrite: number;
	focusSwitch: number;
	modelLoad: number;
	modelUnload: number;
	backgroundPerMin: number;
	chatPerMin: number;
	backgroundStep: number;
}

/**
 * `awakePerHour` is 0.02, not plan §2.2's 0.04: §2.2 assumed a 16-hour day,
 * but a rest-window night ends when its work is done (minutes), so Iyye is
 * awake about 24 hours. At 0.04 a typical day reached the wind-down level by
 * the evening and took a nap (a full night) every day. At 0.02 a typical day
 * (about 10 turns, three model loads at waking) ends near 0.25 at the
 * window; only a heavy day naps. A test simulates both days.
 */
export const DEFAULT_CHARGES: EnergyCharges = {
	awakePerHour: 0.02,
	stmWrite: 0.005,
	focusSwitch: 0.01,
	modelLoad: 0.025,
	modelUnload: 0.02,
	backgroundPerMin: 0.02,
	chatPerMin: 0.005,
	backgroundStep: 0.01,
};

export type ChargeKind =
	| "awake"
	| "stm_write"
	| "focus_switch"
	| "model_load"
	| "model_unload"
	| "device_background"
	| "device_chat"
	| "background_step";

const K = {
	level: "adenosine.level",
	since: "adenosine.since",
	timeAt: "adenosine.time_charged_at",
};

export interface AdenosineDeps {
	db: Db;
	log: Logger;
	/** Awake time is charged only while awake. */
	mode: () => "awake" | "winding_down" | "asleep";
	charges?: Partial<EnergyCharges>;
	reserve?: number;
	windDown?: number;
	now?: () => Date;
	tickMs?: number;
	/** The longest gap charged as awake time in one tick: the host being off is not being awake. */
	maxGapMs?: number;
}

export class Adenosine {
	private readonly d: Required<Omit<AdenosineDeps, "charges">> & { charges: EnergyCharges };
	private timer: NodeJS.Timeout | null = null;

	constructor(deps: AdenosineDeps) {
		this.d = {
			reserve: 0.35,
			windDown: 0.15,
			now: () => new Date(),
			tickMs: 5 * 60_000,
			maxGapMs: 15 * 60_000,
			...deps,
			charges: { ...DEFAULT_CHARGES, ...deps.charges },
		};
		// Only what happens from now on is charged; earlier history is not.
		if (!getKv(this.d.db, K.since)) this.setKv(K.since, this.iso());
	}

	get charges(): EnergyCharges {
		return this.d.charges;
	}

	get thresholds(): { reserve: number; windDown: number } {
		return { reserve: this.d.reserve, windDown: this.d.windDown };
	}

	level(): number {
		const v = Number(getKv(this.d.db, K.level) ?? "1");
		return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
	}

	/** True while background work may start (at or above the reserve). */
	backgroundAllowed(): boolean {
		return this.level() >= this.d.reserve;
	}

	/** True when Iyye should go to sleep at the next quiet moment. */
	tired(): boolean {
		return this.level() < this.d.windDown;
	}

	start(): void {
		if (this.timer) return;
		this.setKv(K.timeAt, String(this.d.now().getTime())); // downtime is not awake time
		this.timer = setInterval(() => this.tick(), this.d.tickMs);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * The one writer of charges. `amount` is a cost (positive). With a `ref`,
	 * the same kind and reference is charged at most once; returns false if
	 * it already was.
	 */
	charge(kind: ChargeKind, amount: number, ref: string | null = null): boolean {
		if (!(amount > 0)) return false;
		return this.write(kind, -amount, ref);
	}

	/**
	 * Sleep: raise the level to `to` (never lowers it), and move the sweep's
	 * watermark so what happened before is not charged afterwards.
	 */
	refill(to: number, kind: "refill_night" | "refill_partial"): void {
		this.sweepRecords(); // charge what happened since the last sweep before the watermark moves past it
		const level = this.level();
		const target = Math.min(1, Math.max(level, to));
		this.write(kind, target - level, null);
		this.setKv(K.since, this.iso());
		this.d.log.info("adenosine: refilled", { kind, level: round(target) });
	}

	/** Charge time awake and sweep answered turns and model operations. Public for tests. */
	tick(): void {
		const now = this.d.now().getTime();
		const last = Number(getKv(this.d.db, K.timeAt) ?? String(now));
		const gap = Math.min(Math.max(0, now - last), this.d.maxGapMs);
		this.setKv(K.timeAt, String(now));
		if (this.d.mode() === "awake" && gap > 0) this.charge("awake", (gap / 3_600_000) * this.d.charges.awakePerHour);
		this.sweepRecords();
	}

	/**
	 * Answered turns and completed model operations since the watermark, each
	 * charged once. `>=`: the unique (kind, ref) already stops a second charge,
	 * and `>` would miss work finished in the watermark's own millisecond.
	 */
	private sweepRecords(): void {
		const since = getKv(this.d.db, K.since) ?? this.iso();
		for (const r of this.d.db.prepare("SELECT event_id FROM stm_episodes WHERE answered_at >= ?").all(since) as {
			event_id: string;
		}[]) {
			this.charge("stm_write", this.d.charges.stmWrite, r.event_id);
		}
		for (const r of this.d.db
			.prepare("SELECT id, op FROM model_ops WHERE state = 'done' AND op IN ('load', 'unload') AND finished_at >= ?")
			.all(since) as { id: string; op: "load" | "unload" }[]) {
			this.charge(
				r.op === "load" ? "model_load" : "model_unload",
				r.op === "load" ? this.d.charges.modelLoad : this.d.charges.modelUnload,
				r.id,
			);
		}
	}

	/** Device time used by a chat turn or a background step (reported by the scheduler and the worker). */
	deviceTime(kind: "chat" | "background", ms: number, ref: string): void {
		const perMin = kind === "chat" ? this.d.charges.chatPerMin : this.d.charges.backgroundPerMin;
		this.charge(kind === "chat" ? "device_chat" : "device_background", (ms / 60_000) * perMin, ref);
	}

	/** When the level would reach `windDown` at the recent rate, or null. */
	tiredAt(): Date | null {
		const level = this.level();
		if (level < this.d.windDown) return null;
		const now = this.d.now().getTime();
		const from = new Date(now - 2 * 3_600_000).toISOString();
		const spent = -(
			this.d.db
				.prepare("SELECT coalesce(sum(amount), 0) AS s FROM energy_ledger WHERE at >= ? AND amount < 0")
				.get(from) as { s: number }
		).s;
		const perHour = Math.max(this.d.charges.awakePerHour, spent / 2);
		return new Date(now + ((level - this.d.windDown) / perHour) * 3_600_000);
	}

	/** One line for `/day` and the status chip. */
	describe(): string {
		const level = this.level();
		const head = `adenosine ${level.toFixed(2)}`;
		if (level < this.d.windDown) return `${head}: tired, sleeps at the next quiet moment`;
		const at = this.tiredAt();
		const tired = at ? `; tired (below ${this.d.windDown}) near ${hhmm(at)} at this rate` : "";
		if (level < this.d.reserve)
			return `${head}: low, background work waits for the night (reserve ${this.d.reserve})${tired}`;
		return `${head}: background work allowed (reserve ${this.d.reserve})${tired}`;
	}

	/** `/energy`: where the energy went in the last 24 hours. */
	report(): string {
		const from = new Date(this.d.now().getTime() - 24 * 3_600_000).toISOString();
		const rows = this.d.db
			.prepare(
				"SELECT kind, count(*) AS n, sum(amount) AS s FROM energy_ledger WHERE at >= ? GROUP BY kind ORDER BY sum(amount)",
			)
			.all(from) as { kind: string; n: number; s: number }[];
		const lastRefill = this.d.db
			.prepare(
				"SELECT at, kind, level_after FROM energy_ledger WHERE amount >= 0 AND kind LIKE 'refill%' ORDER BY id DESC LIMIT 1",
			)
			.get() as { at: string; kind: string; level_after: number } | undefined;
		const lines = [
			this.describe(),
			`owner chat is never refused for low energy; below ${this.d.reserve} background work waits, below ${this.d.windDown} Iyye sleeps at the next quiet moment`,
		];
		if (lastRefill)
			lines.push(
				`last refill: ${lastRefill.kind === "refill_night" ? "a full night" : "an interrupted night"} at ${hhmm(new Date(lastRefill.at))}, to ${lastRefill.level_after.toFixed(2)}`,
			);
		const spent = rows.filter((r) => r.s < 0);
		if (spent.length === 0) lines.push("last 24 h: nothing charged yet");
		else {
			lines.push("last 24 h, spent on:");
			for (const r of spent) lines.push(`  ${LABELS[r.kind] ?? r.kind}: ${(-r.s).toFixed(3)} (${r.n}×)`);
		}
		return lines.join("\n");
	}

	private write(kind: string, delta: number, ref: string | null): boolean {
		return this.d.db.transaction(() => {
			const after = Math.min(1, Math.max(0, this.level() + delta));
			const info = this.d.db
				.prepare("INSERT OR IGNORE INTO energy_ledger (at, kind, amount, level_after, ref) VALUES (?, ?, ?, ?, ?)")
				.run(this.iso(), kind, delta, after, ref);
			if (info.changes === 0) return false;
			this.setKv(K.level, String(after));
			return true;
		})();
	}

	private setKv(key: string, value: string): void {
		setKv(this.d.db, key, value, this.iso());
	}

	private iso(): string {
		return this.d.now().toISOString();
	}
}

const LABELS: Record<string, string> = {
	awake: "time awake",
	stm_write: "short-term memory entries (conversations, findings, summaries)",
	focus_switch: "background work paused for a person",
	model_load: "model loads",
	model_unload: "model unloads",
	device_background: "background device time",
	device_chat: "chat device time",
	background_step: "background steps",
};

function round(x: number): number {
	return Math.round(x * 1000) / 1000;
}

function hhmm(d: Date): string {
	return d.toTimeString().slice(0, 5);
}
