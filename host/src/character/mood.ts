// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Mood (plan 0.009 CH2, HLD §8.2): a fast, honest state computed from
 * records only, never from a model's self-report. `moodAt(db, scope, at)` is
 * a pure function of the records timestamped at or before `at`, so the voice
 * can be given the mood Iyye was in when a message was written, however much
 * later it runs.
 *
 * - **energy** (0–1): the adenosine level after the last ledger entry at or
 *   before `at` (fresh after a full night, tired late). Adenosine is its own
 *   dynamics: no decay here.
 * - **ease** (−1…1, baseline 0): how the day is going. Good and bad records
 *   since the day began (the last refill at or before `at`, at most
 *   `EASE_WINDOW_H` back), each weighted and halved every `EASE_HALF_LIFE_H`
 *   hours of age, as (good − bad) / (good + bad + `EASE_PRIOR`): a few records
 *   move it little, a completed night starts it again at 0. Good: a delivered
 *   message (1), an outcome the owner called useful (2). Bad: a message that
 *   failed for good or may not have arrived (3), a chat turn that failed (3),
 *   a service in trouble (2), a fruitless or not-useful attempt (1).
 * - **engagement** (0–1, baseline 0, per conversation only): that
 *   conversation's messages in the last `ENGAGE_WINDOW_H` hours, each halved
 *   every `ENGAGE_HALF_LIFE_MIN` minutes, as 1 − exp(−sum / `ENGAGE_SCALE`).
 *   Another conversation never moves it: a rude contact cannot make Iyye curt
 *   with the owner.
 *
 * Known approximations: an action's delivery state and a service's state are
 * read as they are now (a service that recovered leaves no trace before its
 * `since`). Mood is read only by the voice; never by Pi's prompt, the
 * motivations or any decision about what Iyye does. The valence of a
 * person's message (a Kev role) and the spoken mood remark are not built yet.
 */

import type { Db } from "../state/db.ts";

export const MOOD_VERSION = 1;
export const EASE_HALF_LIFE_H = 3;
export const EASE_WINDOW_H = 12;
export const EASE_PRIOR = 4;
export const ENGAGE_HALF_LIFE_MIN = 30;
export const ENGAGE_WINDOW_H = 2;
export const ENGAGE_SCALE = 3;

const SERVICE_TROUBLE = ["failed", "retrying", "unreachable", "misconfigured", "down"];

export interface MoodRecord {
	kind: string;
	ref: string;
	at: string;
	weight: number;
}

export interface Mood {
	asOf: string;
	scope: string | null;
	version: number;
	energy: number | null;
	ease: number;
	engagement: number | null;
	sources: {
		energy: { ledger_id: number; at: string; level: number } | null;
		day_start: string | null;
		good: MoodRecord[];
		bad: MoodRecord[];
		/** The conversation's event ids that made its engagement. */
		conversation: string[];
	};
}

const H = 3_600_000;

export function moodAt(db: Db, scope: string | null, at: Date): Mood {
	const T = at.toISOString();
	const t = at.getTime();
	const ledger = db
		.prepare("SELECT id, at, level_after FROM energy_ledger WHERE at <= ? ORDER BY at DESC, id DESC LIMIT 1")
		.get(T) as { id: number; at: string; level_after: number } | undefined;
	const refill = db
		.prepare(
			"SELECT at FROM energy_ledger WHERE kind LIKE 'refill%' AND amount >= 0 AND at <= ? ORDER BY at DESC LIMIT 1",
		)
		.get(T) as { at: string } | undefined;
	const windowStart = new Date(Math.max(t - EASE_WINDOW_H * H, refill ? Date.parse(refill.at) : 0)).toISOString();
	const good: MoodRecord[] = [];
	const bad: MoodRecord[] = [];
	const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as { ref: string; at: string }[];
	for (const r of rows(
		"SELECT id AS ref, created_at AS at FROM actions WHERE kind IN ('reply', 'status') AND state = 'delivered' AND created_at > ? AND created_at <= ?",
		windowStart,
		T,
	))
		good.push({ kind: "delivered", ref: `action:${r.ref}`, at: r.at, weight: 1 });
	for (const r of rows(
		"SELECT id AS ref, created_at AS at FROM actions WHERE state IN ('terminal_failure', 'unknown') AND created_at > ? AND created_at <= ?",
		windowStart,
		T,
	))
		bad.push({ kind: "not delivered", ref: `action:${r.ref}`, at: r.at, weight: 3 });
	for (const r of rows(
		"SELECT id AS ref, settled_at AS at FROM jobs WHERE status = 'failed' AND settled_at > ? AND settled_at <= ?",
		windowStart,
		T,
	))
		bad.push({ kind: "turn failed", ref: `job:${r.ref}`, at: r.at, weight: 3 });
	for (const r of db
		.prepare(
			"SELECT id, at, kind FROM motivation_events WHERE kind IN ('useful', 'not_useful', 'fruitless') AND at > ? AND at <= ?",
		)
		.all(windowStart, T) as { id: string; at: string; kind: string }[]) {
		const rec = { kind: r.kind.replace("_", " "), ref: `motivation_event:${r.id}`, at: r.at };
		if (r.kind === "useful") good.push({ ...rec, weight: 2 });
		else bad.push({ ...rec, weight: 1 });
	}
	// In trouble since before the window: it weighs as if it began at the window's start.
	for (const r of db
		.prepare(
			`SELECT name, state, since FROM service_status WHERE state IN (${SERVICE_TROUBLE.map(() => "?").join(", ")}) AND since <= ?`,
		)
		.all(...SERVICE_TROUBLE, T) as { name: string; state: string; since: string }[])
		bad.push({
			kind: `${r.name} ${r.state}`,
			ref: `service:${r.name}@${r.since}`,
			at: r.since > windowStart ? r.since : windowStart,
			weight: 2,
		});
	const decayed = (recs: MoodRecord[]) =>
		recs.reduce((sum, r) => sum + r.weight * 0.5 ** ((t - Date.parse(r.at)) / (EASE_HALF_LIFE_H * H)), 0);
	const g = decayed(good);
	const b = decayed(bad);
	const ease = clamp((g - b) / (g + b + EASE_PRIOR), -1, 1);
	let engagement: number | null = null;
	const conversation: string[] = [];
	if (scope !== null) {
		const from = new Date(t - ENGAGE_WINDOW_H * H).toISOString();
		let sum = 0;
		for (const e of db
			.prepare(
				"SELECT id, received_at FROM events WHERE scope = ? AND status != 'dropped' AND received_at > ? AND received_at <= ? ORDER BY received_at",
			)
			.all(scope, from, T) as { id: string; received_at: string }[]) {
			conversation.push(e.id);
			sum += 0.5 ** ((t - Date.parse(e.received_at)) / (ENGAGE_HALF_LIFE_MIN * 60_000));
		}
		engagement = 1 - Math.exp(-sum / ENGAGE_SCALE);
	}
	return {
		asOf: T,
		scope,
		version: MOOD_VERSION,
		energy: ledger ? ledger.level_after : null,
		ease,
		engagement,
		sources: {
			energy: ledger ? { ledger_id: ledger.id, at: ledger.at, level: ledger.level_after } : null,
			day_start: refill?.at ?? null,
			good,
			bad,
			conversation,
		},
	};
}

/** Journal a mood snapshot with the records it was computed from. Returns its id. */
export function recordMood(
	db: Db,
	m: Mood,
	reason: "sweep" | "voice" | "command",
	now: Date,
	newId: () => string = () => crypto.randomUUID(),
): string {
	const id = newId();
	db.prepare(
		`INSERT INTO mood_samples (id, created_at, as_of, scope, version, energy, ease, engagement, sources_json, reason)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		now.toISOString(),
		m.asOf,
		m.scope,
		m.version,
		m.energy,
		m.ease,
		m.engagement,
		JSON.stringify(m.sources),
		reason,
	);
	return id;
}

export function energyWord(v: number | null): string {
	if (v === null) return "unknown";
	return v >= 0.7 ? "fresh" : v >= 0.35 ? "steady" : v >= 0.15 ? "tired" : "exhausted";
}

export function easeWord(v: number): string {
	return v <= -0.4 ? "a troubled day" : v <= -0.15 ? "an uneasy day" : v < 0.15 ? "an even day" : "a good day";
}

export function engagementWord(v: number | null): string {
	if (v === null) return "no conversation";
	return v < 0.15 ? "a quiet conversation" : v < 0.5 ? "a conversation" : "a lively conversation";
}

/** The mood in words, as the voice is given it: words only, no numbers. */
export function moodHeader(m: Pick<Mood, "energy" | "ease" | "engagement">): string {
	return `Mood: energy ${energyWord(m.energy)}, ${easeWord(m.ease)}, ${engagementWord(m.engagement)}.`;
}

/** `/mood` (owner surfaces only): now, with its sources, and each conversation active in the last hours. */
export function moodReport(db: Db, now: Date, names: (scope: string) => string = (s) => s): string {
	const m = moodAt(db, null, now);
	const top = (recs: MoodRecord[]) => {
		const byKind = new Map<string, number>();
		for (const r of recs) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
		return [...byKind].map(([k, n]) => `${n} ${k}`).join(", ") || "none";
	};
	const lines = [
		`mood (version ${MOOD_VERSION}, from records only; read only by the voice, which is in shadow):`,
		`  energy: ${energyWord(m.energy)}${m.energy === null ? "" : ` (${m.energy.toFixed(2)}, adenosine at ${m.sources.energy!.at.slice(11, 16)} UTC)`}`,
		`  ease: ${easeWord(m.ease)} (${m.ease.toFixed(2)}, since ${m.sources.day_start ? `the night ending ${m.sources.day_start.slice(0, 16).replace("T", " ")} UTC` : `${EASE_WINDOW_H} h ago`}; good: ${top(m.sources.good)}; bad: ${top(m.sources.bad)})`,
	];
	const active = db
		.prepare(
			"SELECT DISTINCT scope FROM events WHERE scope IS NOT NULL AND status != 'dropped' AND received_at > ? AND received_at <= ? ORDER BY scope",
		)
		.all(new Date(now.getTime() - ENGAGE_WINDOW_H * H).toISOString(), now.toISOString()) as { scope: string }[];
	lines.push(
		active.length
			? "  conversations (each its own, never another's):"
			: `  conversations: none in the last ${ENGAGE_WINDOW_H} h`,
	);
	for (const { scope } of active) {
		const c = moodAt(db, scope, now);
		lines.push(
			`    ${names(scope)}: ${engagementWord(c.engagement)} (${c.engagement!.toFixed(2)}, ${c.sources.conversation.length} message(s))`,
		);
	}
	return lines.join("\n");
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}
