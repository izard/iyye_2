// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * M4's evaluation view (plan 0.010): what each motivation opened, tried,
 * resolved and was held back from, from records only (outcomes, events,
 * device charges, the outbox), never from Iyye's prose.
 *
 * - `/motivation report [days]` — per motivation, since the trial period
 *   began (or the last `days`).
 * - `/motivation trace <id>` — one opportunity: its evidence, its events, its
 *   device time and its outcome.
 * - `/motivation useful <id> yes|no` — the owner's word: the fourth outcome
 *   level, kept apart from resolution.
 *
 * **The trial period** (`motivation.trial`): its start and a fingerprint of
 * what decides behaviour (the need and signal code, thresholds, caps, budget).
 * A changed fingerprint starts a new period, so one evaluation never mixes two
 * behaviours.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Db } from "../state/db.ts";
import { getKv, setKv } from "../state/kv.ts";
import type { InitiativeLedger } from "./budget.ts";
import { recordEvent } from "./outcomes.ts";
import { MOTIVATIONS, type Motivation } from "./signals.ts";

const TRIAL_KEY = "motivation.trial";

export interface Trial {
	start: string;
	fingerprint: string;
	/** Earlier periods, newest first (start, end, fingerprint). */
	earlier: { start: string; end: string; fingerprint: string }[];
}

/** The behaviour's fingerprint: the signal and detector code, and every number that decides an action. */
export function behaviourFingerprint(settings: Record<string, unknown>): string {
	// Every file whose code decides what is opened, when and how often (caps, holds, waits, estimates, priority).
	const code = [
		"./signals.ts",
		"./detectors.ts",
		"./tracker.ts",
		"./actor.ts",
		"./budget.ts",
		"../observe/investigations.ts",
	].map((f) => {
		try {
			return readFileSync(new URL(f, import.meta.url), "utf8");
		} catch {
			return f;
		}
	});
	return createHash("sha256").update(JSON.stringify(settings)).update(code.join("\n")).digest("hex").slice(0, 12);
}

/** The current trial period; a new one starts when the fingerprint changed. */
export function ensureTrial(db: Db, fingerprint: string, now: Date): Trial {
	let t: Trial | null = null;
	try {
		t = JSON.parse(getKv(db, TRIAL_KEY) ?? "null") as Trial | null;
	} catch {
		t = null;
	}
	const at = now.toISOString();
	if (t && t.fingerprint === fingerprint) return t;
	const next: Trial = {
		start: at,
		fingerprint,
		earlier: t ? [{ start: t.start, end: at, fingerprint: t.fingerprint }, ...t.earlier].slice(0, 10) : [],
	};
	setKv(db, TRIAL_KEY, JSON.stringify(next), at);
	return next;
}

export function currentTrial(db: Db): Trial | null {
	try {
		return JSON.parse(getKv(db, TRIAL_KEY) ?? "null") as Trial | null;
	} catch {
		return null;
	}
}

interface Counts {
	opened: number;
	attempted: number;
	outcomes: Record<string, number>;
	credited: number;
	withheld: Record<string, number>;
	preempted: number;
	discardedMs: number;
	deviceMs: number;
	unconfirmed: number;
	repeats: number;
	useful: number;
	notUseful: number;
}

export function countsFor(db: Db, m: Motivation, since: string): Counts {
	const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as T;
	const all = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as T[];
	const ev = (kind: string) =>
		one<{ n: number }>(
			"SELECT count(DISTINCT opportunity_id) AS n FROM motivation_events WHERE motivation = ? AND kind = ? AND at >= ?",
			m,
			kind,
			since,
		).n;
	// Every settlement is its own journal record ("resolved (credited)"): a reopened opportunity's earlier
	// episode keeps its outcome, and its new one is counted only once it settles.
	const outcomes: Record<string, number> = {};
	let credited = 0;
	for (const r of all<{ reason: string; n: number }>(
		"SELECT reason, count(*) AS n FROM motivation_events WHERE motivation = ? AND kind = 'settled' AND at >= ? GROUP BY reason",
		m,
		since,
	)) {
		const outcome = r.reason.replace(/ \(credited\)$/, "");
		outcomes[outcome] = (outcomes[outcome] ?? 0) + r.n;
		if (outcome !== r.reason) credited += r.n;
	}
	const withheld: Record<string, number> = {};
	for (const r of all<{ reason: string; n: number }>(
		"SELECT reason, count(*) AS n FROM motivation_events WHERE motivation = ? AND kind = 'withheld' AND at >= ? GROUP BY reason",
		m,
		since,
	))
		withheld[r.reason] = r.n;
	const device = one<{ ms: number; discarded: number }>(
		"SELECT coalesce(sum(ms), 0) AS ms, coalesce(sum(CASE WHEN kept = 0 THEN ms END), 0) AS discarded FROM initiative_device WHERE motivation = ? AND at >= ?",
		m,
		since,
	);
	// Deliveries the outbox could not confirm: notices (by their key) and follow-ups (their sent message).
	const unconfirmed =
		one<{ n: number }>(
			`SELECT count(*) AS n FROM motivation_events v JOIN actions a ON a.idempotency_key = v.ref
			 WHERE v.motivation = ? AND v.kind = 'attempted' AND v.at >= ? AND a.state IN ('unknown', 'failed', 'terminal_failure')`,
			m,
			since,
		).n +
		one<{ n: number }>(
			`SELECT count(*) AS n FROM opportunities o JOIN sent_messages s ON s.id = o.ref JOIN actions a ON a.id = s.action_id
			 WHERE o.motivation = ? AND o.action_kind = 'follow_up' AND o.attempt_started_at >= ? AND a.state IN ('unknown', 'failed', 'terminal_failure')`,
			m,
			since,
		).n;
	// The same evidence cluster acted on more than once (a later episode of an outage is a new cluster).
	const repeats = one<{ n: number }>(
		`SELECT count(*) AS n FROM (SELECT o.cluster FROM motivation_events v JOIN opportunities o ON o.id = v.opportunity_id
		 WHERE v.motivation = ? AND v.kind = 'attempted' AND v.at >= ? GROUP BY o.cluster HAVING count(*) > 1)`,
		m,
		since,
	).n;
	return {
		opened: ev("opened"),
		attempted: ev("attempted"),
		outcomes,
		credited,
		withheld,
		preempted: ev("preempted"),
		discardedMs: device.discarded,
		deviceMs: device.ms,
		unconfirmed,
		repeats,
		useful: ev("useful"),
		notUseful: ev("not_useful"),
	};
}

export function motivationReport(
	db: Db,
	ledger: Pick<InitiativeLedger, "usageLine">,
	o: { now: Date; days?: number | null },
): string {
	const trial = currentTrial(db);
	const since = o.days ? new Date(o.now.getTime() - o.days * 86_400_000).toISOString() : (trial?.start ?? "");
	const head = o.days
		? `the last ${o.days} day(s)`
		: trial
			? `trial period since ${trial.start.slice(0, 16).replace("T", " ")} (behaviour ${trial.fingerprint})`
			: "all records";
	const lines = [`initiative, ${head}:`];
	const fmt = (r: Record<string, number>) =>
		Object.entries(r)
			.map(([k, v]) => `${k} ${v}`)
			.join(", ") || "none";
	for (const m of MOTIVATIONS) {
		const c = countsFor(db, m, since);
		lines.push(
			`  ${m.replace("_", "-")}: opened ${c.opened}, attempted ${c.attempted}; outcomes: ${fmt(c.outcomes)} (credited ${c.credited})`,
			`    withheld: ${fmt(c.withheld)}; preempted ${c.preempted}; unconfirmed deliveries ${c.unconfirmed}; repeats on one cluster ${c.repeats}`,
			`    device: ${(c.deviceMs / 60_000).toFixed(1)} min in the period (${(c.discardedMs / 60_000).toFixed(1)} discarded); today ${ledger.usageLine(m)}; useful ${c.useful}, not useful ${c.notUseful}`,
		);
	}
	const unexplained = (
		db
			.prepare(
				"SELECT count(*) AS n FROM opportunities WHERE status IN ('settled', 'suspended') AND outcome IS NULL",
			)
			.get() as { n: number }
	).n;
	lines.push(`settled without an outcome: ${unexplained}${unexplained ? " (should be 0)" : ""}`);
	lines.push(...actedList(db, since));
	lines.push("/motivation trace <id> shows one opportunity; /motivation useful <id> yes|no records your judgement.");
	return lines.join("\n");
}

/**
 * What Iyye did on its own in the period, newest first, with the ids that `trace` and `useful` take and
 * your judgement so far: the list to label from.
 */
function actedList(db: Db, since: string, limit = 20): string[] {
	const rows = db
		.prepare(
			`SELECT o.id, o.motivation, o.action_kind, o.status, o.outcome, o.evidence_text, max(v.at) AS at,
			   (SELECT u.kind FROM motivation_events u WHERE u.opportunity_id = o.id AND u.kind IN ('useful', 'not_useful')
			    ORDER BY u.at DESC, u.rowid DESC LIMIT 1) AS judged
			 FROM motivation_events v JOIN opportunities o ON o.id = v.opportunity_id
			 WHERE v.kind = 'attempted' AND v.at >= ?
			 GROUP BY o.id ORDER BY at DESC LIMIT ?`,
		)
		.all(since, limit + 1) as {
		id: string;
		motivation: string | null;
		action_kind: string | null;
		status: string;
		outcome: string | null;
		evidence_text: string | null;
		at: string;
		judged: string | null;
	}[];
	if (rows.length === 0) return ["what Iyye did on its own: nothing in this period"];
	const waiting = rows.filter((r) => !r.judged).length;
	return [
		`what Iyye did on its own (${waiting}${rows.length > limit ? "+" : ""} without your judgement):`,
		...rows
			.slice(0, limit)
			.map(
				(r) =>
					`  ${r.id.slice(0, 8)} ${r.at.slice(0, 16).replace("T", " ")} ${(r.motivation ?? "curiosity").replace("_", "-")} · ${r.action_kind ?? "investigate"} — ${r.outcome ?? r.status} · ${r.judged === "useful" ? "useful" : r.judged === "not_useful" ? "not useful" : "not judged yet"}\n    ${(r.evidence_text ?? "").replace(/\s+/g, " ").slice(0, 120)}`,
			),
	];
}

function findOpportunity(db: Db, ref: string): { id: string } | string {
	if (!/^[0-9a-f-]{6,36}$/i.test(ref)) return "give an opportunity id, at least 6 characters (see /opportunities)";
	const rows = db.prepare("SELECT id FROM opportunities WHERE id LIKE ?").all(`${ref}%`) as { id: string }[];
	if (rows.length !== 1) return rows.length ? `${ref} matches ${rows.length} opportunities` : `no opportunity ${ref}`;
	return rows[0]!;
}

/** `/motivation trace <id>`: the chain from evidence to outcome. */
export function traceOpportunity(db: Db, ref: string): string {
	const f = findOpportunity(db, ref);
	if (typeof f === "string") return f;
	const o = db.prepare("SELECT * FROM opportunities WHERE id = ?").get(f.id) as Record<string, string | number | null>;
	const events = db
		.prepare("SELECT at, kind, reason, ref FROM motivation_events WHERE opportunity_id = ? ORDER BY at, rowid")
		.all(f.id) as { at: string; kind: string; reason: string | null; ref: string | null }[];
	const device = db
		.prepare("SELECT at, source, machine, ms, kept FROM initiative_device WHERE opportunity_id = ? ORDER BY at")
		.all(f.id) as { at: string; source: string; machine: string; ms: number; kept: number }[];
	const t = (iso: string) => iso.slice(0, 16).replace("T", " ");
	return [
		`${String(o.id).slice(0, 8)} ${o.motivation ?? "curiosity"} · ${o.action_kind ?? "investigate"} — ${o.status}${o.outcome ? `, ${o.outcome}${o.credited ? " (credited)" : ""}` : ""}`,
		`  cluster ${o.cluster}; signal ${o.signal_kind ?? "finding"}; opened ${t(String(o.created_at))}`,
		`  evidence: ${String(o.evidence_text ?? "").slice(0, 200)} (records ${String(o.evidence_json ?? "[]").slice(0, 120)})`,
		...events.map((e) => `  ${t(e.at)} ${e.kind}${e.reason ? `: ${e.reason}` : ""}${e.ref ? ` [${e.ref}]` : ""}`),
		...device.map(
			(d) =>
				`  ${t(d.at)} device ${d.source} on ${d.machine}: ${(d.ms / 1000).toFixed(0)} s${d.kept ? "" : " (discarded)"}`,
		),
		...(o.answer ? [`  last: ${String(o.answer).slice(0, 200)}`] : []),
	].join("\n");
}

/** `/motivation useful <id> yes|no`: the owner's judgement (the fourth level; never a resolution). */
export function markUseful(db: Db, ref: string, verdict: string, now: Date): string {
	const f = findOpportunity(db, ref);
	if (typeof f === "string") return f;
	if (verdict !== "yes" && verdict !== "no") return "usage: /motivation useful <id> yes|no";
	const o = db.prepare("SELECT motivation FROM opportunities WHERE id = ?").get(f.id) as { motivation: string | null };
	recordEvent(db, {
		opportunityId: f.id,
		motivation: o.motivation ?? "curiosity",
		kind: verdict === "yes" ? "useful" : "not_useful",
		reason: "the owner said",
		at: now,
	});
	return `noted: ${f.id.slice(0, 8)} was ${verdict === "yes" ? "useful" : "not useful"}`;
}
