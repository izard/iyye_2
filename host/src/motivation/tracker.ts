// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The motivation tracker, shadow only (plan 0.010 M0, §4): every sweep it
 * collects the need signals, combines them into a raw need per motivation,
 * smooths it, and counts how many sweeps it stayed at or above the
 * threshold. When it has stayed there long enough, the sample names the
 * evidence cluster an opportunity *would* be opened for. Nothing is opened,
 * notified or acted on in M0: the samples are evidence for tuning the
 * weights and the threshold before M1 lets them act.
 *
 * The smoothed need and the sustain counts survive restarts: they are
 * restored from each motivation's latest sample (1.x lost its need average
 * on every restart, which defeated the smoothing).
 */

import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import { actionFor, type Opening } from "./actor.ts";
import {
	collectSignals,
	MOTIVATIONS,
	type Motivation,
	rawNeed,
	type Signal,
	type SignalSources,
	strength,
} from "./signals.ts";

export interface TrackerDeps {
	db: Db;
	log: Logger;
	mode: () => "awake" | "winding_down" | "asleep";
	sources: Omit<SignalSources, "db" | "now">;
	now?: () => Date;
	newId?: () => string;
	sweepMs?: number;
	/** Smoothing: need ← need·(1−α) + raw·α. */
	alpha?: number;
	threshold?: number;
	/** Sweeps at or above the threshold before an opportunity would be opened. */
	sustain?: number;
	/** Samples older than this are pruned. */
	keepDays?: number;
	/** M1: what acts on sustained needs; without it the tracker stays shadow (M0). */
	actor?: { act(openings: readonly Opening[], current: ReadonlySet<string>): Promise<void> } | null;
}

interface State {
	smoothed: number;
	sustained: number;
}

/**
 * Signal kinds recorded but not counted. A claim with no record comes from Kev's reply review, a shadow
 * role: a shadow answer must never change what Iyye needs or does. (An intention with no plan and a past
 * dated event were here until 0.010 M3 gave them actions.)
 */
export const JOURNAL_ONLY = new Set(["claim_without_record"]);

/** Actions the actor bounds itself: each of their signals is queued, not only the strongest. */
const QUEUED = new Set(["ask", "propose", "follow_up"]);

export class MotivationTracker {
	private readonly d: Required<TrackerDeps>;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;

	constructor(deps: TrackerDeps) {
		this.d = {
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			sweepMs: 600_000,
			alpha: 0.3,
			// 0.55, not 0.6 (M1): a steady 0.6 signal's smoothed need approaches 0.6 from below and never reached it
			// (2026-10-07: eight hours of a Telegram outage at 0.59).
			threshold: 0.55,
			actor: null,
			sustain: 3,
			keepDays: 14,
			...deps,
		};
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.sweep(), this.d.sweepMs);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.running;
	}

	/** One sweep (awake only). Public for tests. */
	sweep(): Promise<void> {
		if (this.running) return this.running;
		this.running = Promise.resolve()
			.then(async () => {
				const r = this.sweepOnce();
				if (r && this.d.actor) await this.d.actor.act(r.openings, r.current);
			})
			.catch((err) => this.d.log.warn("motivation: sweep failed", { error: (err as Error).message }))
			.finally(() => {
				this.running = null;
			});
		return this.running;
	}

	private sweepOnce(): { openings: Opening[]; current: Set<string> } | null {
		if (this.d.mode() !== "awake") return null;
		const now = this.d.now();
		const signals = collectSignals({ ...this.d.sources, db: this.d.db, now });
		const at = now.toISOString();
		const openings: Opening[] = [];
		this.d.db.transaction(() => {
			for (const m of MOTIVATIONS) {
				const mine = signals.filter((s) => s.motivation === m);
				// Signals with no action yet are recorded with the sample but never add to need or open anything:
				// otherwise they would raise a need that some other signal's action then answers (HLD §11.2 credit).
				const counted = mine.filter((s) => !JOURNAL_ONLY.has(s.kind));
				const raw = rawNeed(counted, now);
				const prev = this.state(m);
				const smoothed = prev ? prev.smoothed * (1 - this.d.alpha) + raw * this.d.alpha : raw * this.d.alpha;
				const sustained = smoothed >= this.d.threshold ? (prev?.sustained ?? 0) + 1 : 0;
				const top = [...mine].sort((a, b) => strength(b, now) - strength(a, now));
				const first = top.find((s) => !JOURNAL_ONLY.has(s.kind));
				this.d.db
					.prepare(
						`INSERT INTO motivation_samples (id, at, motivation, raw, smoothed, sustained, signals_json, would_open)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						this.d.newId(),
						at,
						m,
						round(raw),
						round(smoothed),
						sustained,
						JSON.stringify(top.slice(0, 10).map((s) => brief(s, now))),
						sustained >= this.d.sustain && first ? first.cluster : null,
					);
				if (sustained >= this.d.sustain && first) {
					openings.push({ motivation: m, signal: first });
					// Questions, proposals and follow-ups are bounded by the actor (a few a day, one at a time): every one
					// the motivation could act on is queued, so an unanswered contradiction does not hold the only slot
					// for a week, and a stronger signal with another action (an urgent plan, a failed reply) does not
					// keep an intention or a past event from ever opening.
					for (const sig of counted)
						if (sig !== first && QUEUED.has(actionFor(m, sig.kind) ?? ""))
							openings.push({ motivation: m, signal: sig });
				}
			}
			this.d.db
				.prepare("DELETE FROM motivation_samples WHERE at < ?")
				.run(new Date(now.getTime() - this.d.keepDays * 86_400_000).toISOString());
		})();
		return { openings, current: new Set(signals.map((s) => s.cluster)) };
	}

	/** The latest sample of a motivation: restores the smoothing and the sustain count after a restart. */
	private state(m: Motivation): State | null {
		const r = this.d.db
			.prepare(
				"SELECT smoothed, sustained FROM motivation_samples WHERE motivation = ? ORDER BY at DESC, rowid DESC LIMIT 1",
			)
			.get(m) as State | undefined;
		return r ?? null;
	}

	/** `/motivation`: each need, its top signals with evidence, and what would be opened (shadow). */
	report(): string {
		const now = this.d.now();
		const lines = [
			`motivations (need is smoothed, α ${this.d.alpha}; an opportunity opens after ${this.d.sustain} sweeps at ≥ ${this.d.threshold}):`,
		];
		for (const m of MOTIVATIONS) {
			const r = this.d.db
				.prepare("SELECT * FROM motivation_samples WHERE motivation = ? ORDER BY at DESC, rowid DESC LIMIT 1")
				.get(m) as
				| {
						at: string;
						raw: number;
						smoothed: number;
						sustained: number;
						signals_json: string;
						would_open: string | null;
				  }
				| undefined;
			if (!r) {
				lines.push(`  ${m}: no sample yet`);
				continue;
			}
			const sigs = JSON.parse(r.signals_json) as ReturnType<typeof brief>[];
			const min = Math.round((now.getTime() - Date.parse(r.at)) / 60_000);
			lines.push(
				`  ${m}: need ${r.smoothed.toFixed(2)} (raw ${r.raw.toFixed(2)}, ${min} min ago)${r.sustained ? ` · high for ${r.sustained} sweep(s)` : ""}${r.would_open ? ` · opens: ${r.would_open}` : ""}`,
				...sigs.slice(0, 3).map((s) => `    ${s.strength.toFixed(2)} ${s.kind}: ${s.text}`),
			);
		}
		return lines.join("\n");
	}
}

function brief(s: Signal, now: Date) {
	return {
		kind: s.kind,
		cluster: s.cluster,
		strength: round(strength(s, now)),
		text: s.text,
		evidence: s.evidence.slice(0, 5),
	};
}

function round(x: number): number {
	return Math.round(x * 1000) / 1000;
}
