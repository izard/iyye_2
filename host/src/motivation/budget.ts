// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Initiative's device-time budget and scheduling (plan 0.010 §7, M4; owner
 * decisions 7–10):
 *
 * - **Allowances:** an absolute daily budget (`IYYE2_INITIATIVE_BUDGET_MIN`,
 *   120 min), split curiosity 40 %, agency 30 %, social 30 %. Curiosity and
 *   agency may use each other's unused share (one pool between them); social
 *   never borrows and is never borrowed from. Self-preservation does no
 *   inference (notices, reloads) and is uncapped within the energy reserve.
 * - **Charged:** actual inference time (`initiative_device`): the composer's
 *   calls and investigations' background steps, kept or discarded after a
 *   preemption, on this machine or the MBP. Waiting for a model charges
 *   nothing (nothing ran). Approved plans are the owner's work (no share).
 * - **Eligibility:** work starts only if its estimated cost (the median of the
 *   last kept charges of its kind, a default before there are any) fits what
 *   is left; work already running may finish (overshoot: one call or step).
 * - **One initiative job at a time** across the actor and the investigations
 *   loop: a composer call in flight, or an investigation running (its steps
 *   are one job).
 * - **Priority, deterministic:** `need × urgency(age) ÷ cost`, from durable
 *   rows only (the motivation's latest smoothed need, the opportunity's age,
 *   its kind's estimated cost), ties to self-preservation, then the older
 *   opportunity, then its id. A component starts a row only if no higher-ranked
 *   row is ready, so neither loop's timing decides.
 */

import type { Db } from "../state/db.ts";
import { getKv } from "../state/kv.ts";
import type { Motivation } from "./signals.ts";

export const SHARES: Readonly<Record<Motivation, number | null>> = {
	self_preservation: null, // uncapped: no inference
	curiosity: 0.4,
	agency: 0.3,
	social: 0.3,
};
/** Curiosity and agency share one pool (owner decision 8). */
const POOLED: readonly Motivation[] = ["curiosity", "agency"];
const DEFAULT_ESTIMATE_MS = { compose: 60_000, step: 5 * 60_000 } as const;
const INVESTIGATION_ORIGIN = "investigation:";
const INITIATIVE_KINDS = ["propose", "follow_up", "investigate"] as const;

export interface BudgetDeps {
	db: Db;
	/** The daily initiative budget in minutes. */
	budgetMin: number;
	now?: () => Date;
	/** Readiness rules the actor and the investigations loop apply (the same numbers they use). */
	rules?: {
		socialHours?: readonly [number, number];
		proposalsPerDay?: number;
		socialPerDay?: number;
		maxFruitless?: number;
	};
}

export interface Charge {
	motivation: Motivation;
	opportunityId: string | null;
	source: "compose" | "step";
	machine: "local" | "remote";
	ms: number;
	/** False when the work was discarded (preempted, or the other machine lost). */
	kept: boolean;
	ref: string;
}

interface Row {
	id: string;
	motivation: Motivation;
	action_kind: string;
	status: string;
	created_at: string;
	fruitless: number;
	cooldown_until: string | null;
}

export function localDay(at: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

export class InitiativeLedger {
	private readonly d: Required<Omit<BudgetDeps, "rules">> & { rules: Required<NonNullable<BudgetDeps["rules"]>> };
	/** The opportunity whose composer call is in flight (in memory: a restart ends the call). */
	private composing: string | null = null;

	constructor(deps: BudgetDeps) {
		this.d = {
			now: () => new Date(),
			...deps,
			rules: { socialHours: [9, 21], proposalsPerDay: 2, socialPerDay: 3, maxFruitless: 3, ...deps.rules },
		};
	}

	// ---------------------------------------------------------------- charging

	charge(c: Charge): void {
		const at = this.d.now();
		this.d.db
			.prepare(
				`INSERT OR IGNORE INTO initiative_device (id, at, day, motivation, opportunity_id, source, machine, ms, kept, ref)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				crypto.randomUUID(),
				at.toISOString(),
				localDay(at),
				c.motivation,
				c.opportunityId,
				c.source,
				c.machine,
				Math.max(0, Math.round(c.ms)),
				c.kept ? 1 : 0,
				c.ref,
			);
	}

	/** A background step's device time, if it was initiative's (an investigation's step). */
	chargeStep(job: { id: string; origin: string }, attempt: number, ms: number, remote: boolean, kept: boolean): void {
		if (!job.origin.startsWith(INVESTIGATION_ORIGIN)) return; // approved plans and the owner's work: no share
		const id = job.origin.slice(INVESTIGATION_ORIGIN.length);
		this.charge({
			motivation: this.motivationOf(id) ?? "curiosity",
			opportunityId: id,
			source: "step",
			machine: remote ? "remote" : "local",
			ms,
			kept,
			ref: `${job.id}:${attempt}`,
		});
	}

	/** Composer calls go through here: one at a time, charged whatever happened. */
	async whileComposing<T>(opportunityId: string, run: () => Promise<T>): Promise<T> {
		this.composing = opportunityId;
		try {
			return await run();
		} finally {
			this.composing = null;
		}
	}

	usedMs(m: Motivation, day = localDay(this.d.now())): number {
		return (
			this.d.db
				.prepare("SELECT coalesce(sum(ms), 0) AS ms FROM initiative_device WHERE day = ? AND motivation = ?")
				.get(day, m) as { ms: number }
		).ms;
	}

	/** Device time a motivation may still use today (Infinity for self-preservation). */
	remainingMs(m: Motivation, day = localDay(this.d.now())): number {
		const share = SHARES[m];
		if (share === null) return Number.POSITIVE_INFINITY;
		const budget = this.d.budgetMin * 60_000;
		if (POOLED.includes(m)) {
			const pool = POOLED.reduce((x, p) => x + (SHARES[p] ?? 0), 0) * budget;
			const used = POOLED.reduce((x, p) => x + this.usedMs(p, day), 0);
			return pool - used;
		}
		return share * budget - this.usedMs(m, day);
	}

	allowanceMs(m: Motivation): number | null {
		const share = SHARES[m];
		return share === null ? null : share * this.d.budgetMin * 60_000;
	}

	/** The median of the last kept charges of a kind, or its default. */
	estimateMs(source: "compose" | "step"): number {
		const rows = (
			this.d.db
				.prepare("SELECT ms FROM initiative_device WHERE source = ? AND kept = 1 ORDER BY at DESC LIMIT 9")
				.all(source) as { ms: number }[]
		)
			.map((r) => r.ms)
			.sort((a, b) => a - b);
		return rows.length ? rows[Math.floor(rows.length / 2)]! : DEFAULT_ESTIMATE_MS[source];
	}

	/** The allowance lets work of this kind start now. */
	affords(m: Motivation, source: "compose" | "step"): boolean {
		return this.remainingMs(m) >= this.estimateMs(source);
	}

	// ---------------------------------------------------------------- scheduling

	/**
	 * Another initiative job in progress (a composer call, a running investigation), other than `except`. An
	 * investigation whose remaining steps all wait for its allowance is not in progress: it holds nothing until
	 * tomorrow, so another motivation's work (social has its own share) may go.
	 */
	inProgress(except: string | null = null): string | null {
		if (this.composing && this.composing !== except) return this.composing;
		const running = this.d.db
			.prepare("SELECT id FROM opportunities WHERE status = 'running' AND action_kind = 'investigate' AND id != ?")
			.all(except ?? "") as { id: string }[];
		for (const { id } of running) {
			const origin = `${INVESTIGATION_ORIGIN}${id}`;
			const steps = this.d.db
				.prepare(
					"SELECT status FROM background_jobs WHERE origin = ? AND status IN ('queued', 'running', 'paused')",
				)
				.all(origin) as { status: string }[];
			// No pending step: it is between a settled step and its evaluation (moments), still in progress.
			if (steps.length === 0 || steps.some((s) => s.status === "running") || this.stepAllowed(origin)) return id;
		}
		return null;
	}

	/** Whether an open initiative row could start now by the shared host rules (not counting the job in progress). */
	ready(r: Row, now: Date): boolean {
		if (r.status !== "open") return false;
		if (this.paused().includes(r.motivation) || getKv(this.d.db, "background.paused")) return false;
		const today = new Date(now);
		today.setHours(0, 0, 0, 0);
		const since = today.toISOString();
		// A lasting hold the component found today (a daily cap: Iyye already wrote to that person, the
		// messenger's limit) keeps it from being ready until tomorrow, so it never blocks lower-ranked work.
		if (
			this.d.db
				.prepare(
					"SELECT 1 FROM motivation_events WHERE opportunity_id = ? AND kind = 'withheld' AND reason = 'daily cap' AND at >= ? LIMIT 1",
				)
				.get(r.id, since)
		)
			return false;
		if (r.action_kind === "investigate") {
			if (r.fruitless >= this.d.rules.maxFruitless) return false;
			if (r.cooldown_until && r.cooldown_until > now.toISOString()) return false;
			return this.affords(r.motivation, "step");
		}
		if (r.action_kind === "follow_up") {
			const [from, to] = this.d.rules.socialHours;
			if (now.getHours() < from || now.getHours() >= to) return false;
			const started = (
				this.d.db
					.prepare(
						"SELECT count(*) AS n FROM opportunities WHERE action_kind = 'follow_up' AND ref IS NOT NULL AND attempt_started_at >= ?",
					)
					.get(since) as { n: number }
			).n;
			if (started >= this.d.rules.socialPerDay) return false;
		}
		if (r.action_kind === "propose") {
			const made = (
				this.d.db
					.prepare(
						"SELECT count(*) AS n FROM opportunities WHERE action_kind = 'propose' AND ref IS NOT NULL AND updated_at >= ?",
					)
					.get(since) as { n: number }
			).n;
			if (made >= this.d.rules.proposalsPerDay) return false;
		}
		return this.affords(r.motivation, "compose");
	}

	/** Priority of an initiative row: need × urgency(age) ÷ cost (minutes). */
	priority(r: Row, now: Date): number {
		const need = Math.max(0.01, this.need(r.motivation));
		const ageH = Math.max(0, (now.getTime() - Date.parse(r.created_at)) / 3_600_000);
		const urgency = 1 + Math.min(ageH / 24, 1);
		const cost = this.estimateMs(r.action_kind === "investigate" ? "step" : "compose") / 60_000;
		return (need * urgency) / Math.max(cost, 0.1);
	}

	/** Open initiative rows, highest priority first (deterministic). */
	rank(now: Date): Row[] {
		const rows = this.d.db
			.prepare(
				`SELECT id, motivation, action_kind, status, created_at, fruitless, cooldown_until FROM opportunities
				 WHERE status = 'open' AND action_kind IN (${INITIATIVE_KINDS.map(() => "?").join(", ")})`,
			)
			.all(...INITIATIVE_KINDS) as Row[];
		const order = (m: Motivation) => (m === "self_preservation" ? 0 : 1);
		return rows
			.map((r) => ({ r, p: this.priority(r, now) }))
			.sort(
				(a, b) =>
					b.p - a.p ||
					order(a.r.motivation) - order(b.r.motivation) ||
					a.r.created_at.localeCompare(b.r.created_at) ||
					a.r.id.localeCompare(b.r.id),
			)
			.map((x) => x.r);
	}

	/**
	 * Why this row may not start now ("another initiative job", "allowance", "higher priority"), or null.
	 * The component's own transient checks (a person in a conversation) still apply after this.
	 */
	mayStart(id: string, now = this.d.now()): "another initiative job" | "allowance" | "higher priority" | null {
		if (this.inProgress(id)) return "another initiative job";
		const ranked = this.rank(now);
		const me = ranked.find((r) => r.id === id);
		if (!me) return null; // not an initiative row (or not open): nothing to rank
		if (!this.affords(me.motivation, me.action_kind === "investigate" ? "step" : "compose")) return "allowance";
		for (const r of ranked) {
			if (r.id === id) return null;
			if (this.ready(r, now)) return "higher priority";
		}
		return null;
	}

	/** Whether a queued background step may run now (the worker asks per job). */
	stepAllowed(origin: string): boolean {
		if (!origin.startsWith(INVESTIGATION_ORIGIN)) return true;
		const m = this.motivationOf(origin.slice(INVESTIGATION_ORIGIN.length)) ?? "curiosity";
		return this.affords(m, "step");
	}

	/** `/motivation report`: the day's use against each allowance. */
	usageLine(m: Motivation): string {
		const used = this.usedMs(m);
		const allowance = this.allowanceMs(m);
		const min = (ms: number) => (ms / 60_000).toFixed(1);
		const over =
			this.remainingMs(m) < 0
				? `; over by ${min(-this.remainingMs(m))} min (a call or step already running may finish)`
				: "";
		return allowance === null
			? `${min(used)} min (uncapped)`
			: `${min(used)} of ${min(allowance)} min${POOLED.includes(m) ? ` (pooled with ${POOLED.filter((p) => p !== m).join(", ")})` : ""}${over}`;
	}

	private need(m: Motivation): number {
		const r = this.d.db
			.prepare("SELECT smoothed FROM motivation_samples WHERE motivation = ? ORDER BY at DESC, rowid DESC LIMIT 1")
			.get(m) as { smoothed: number } | undefined;
		return r?.smoothed ?? 0;
	}

	private motivationOf(opportunityId: string): Motivation | null {
		const r = this.d.db.prepare("SELECT motivation FROM opportunities WHERE id = ?").get(opportunityId) as
			| { motivation: Motivation | null }
			| undefined;
		return r?.motivation ?? null;
	}

	private paused(): Motivation[] {
		try {
			return JSON.parse(getKv(this.d.db, "motivation.paused") ?? "[]") as Motivation[];
		} catch {
			return [];
		}
	}
}
