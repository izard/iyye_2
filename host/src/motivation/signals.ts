// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Need signals for the four motivations (plan 0.010 §3, HLD §5.2), from
 * records only. Each signal names its evidence (record ids or the state it
 * read). Iyye's own replies, summaries and step answers are never read here:
 * self-authored text is never evidence of need (the 1.x lesson).
 *
 * M0 computes what the records already hold; M2 adds deterministic detectors
 * (`detectors.ts`) for recurring questions, intentions and dated events, with
 * Kev's versions of them in shadow (reply review, schema 3).
 */

import { CLAIM_QUESTION, commitmentsOfReply, REPLY_REVIEW } from "../decisions/reply-review.ts";
import { factSentence } from "../facts/extract.ts";
import { IYYE_PROPOSED_VIA } from "../kernel/plans.ts";
import type { Gap } from "../self/model.ts";
import type { Db } from "../state/db.ts";
import { getKv } from "../state/kv.ts";
import { pastEvents, recurringQuestions, unplannedIntentions } from "./detectors.ts";
import { OK_SERVICE_STATES, serviceStatuses } from "./services.ts";

export const MOTIVATIONS = ["self_preservation", "curiosity", "agency", "social"] as const;
export type Motivation = (typeof MOTIVATIONS)[number];

export interface Signal {
	motivation: Motivation;
	kind: string;
	/** The evidence cluster: one opportunity at most per cluster (M1). */
	cluster: string;
	evidence: string[];
	/** Fixed per kind, in [0, 1]. */
	weight: number;
	/** When the evidence was observed; state read now is observed now. */
	observedAt: string;
	text: string;
}

export interface SignalSources {
	db: Db;
	now: Date;
	/** The self model's gaps (curiosity's first signals, §3.1). */
	selfGaps: () => Gap[];
	/** The model manager's self-healing (read-only). */
	healing: () => { model: string; attempts: number; gaveUp: boolean; lastError: string }[];
	/** The self model's sleep facet: did the computer sleep on battery in the last day, and how long. */
	sleep: () => { sleptOnBattery: boolean; asleepMinutes: number } | null;
}

const H = 3_600_000;
const OK_SERVICES = new Set(["up", "connected", "disabled", "not installed", "starting", "restarting"]);

export function collectSignals(s: SignalSources): Signal[] {
	const now = s.now.toISOString();
	const ago = (h: number) => new Date(s.now.getTime() - h * H).toISOString();
	const out: Signal[] = [];
	const add = (x: Omit<Signal, "observedAt"> & { observedAt?: string }) => out.push({ observedAt: now, ...x });
	const db = s.db;

	// ---------------------------------------------------------------- self-preservation
	const machine = db
		.prepare("SELECT id, at, result_json FROM observations WHERE domain = 'machine' ORDER BY at DESC LIMIT 1")
		.get() as { id: string; at: string; result_json: string } | undefined;
	if (machine) {
		const r = JSON.parse(machine.result_json) as Record<string, unknown>;
		const pct = Number(r.diskFreePct);
		const gb = Number(r.diskFreeGb);
		if (pct < 10 && gb < 100)
			add({
				motivation: "self_preservation",
				kind: "disk_low",
				cluster: "disk",
				evidence: [`observation:${machine.id}`],
				weight: 0.8,
				observedAt: machine.at,
				text: `free disk ${gb} GB (${pct}%)`,
			});
		if (Number(r.memAvailableGb) < 4)
			add({
				motivation: "self_preservation",
				kind: "memory_low",
				cluster: "memory",
				evidence: [`observation:${machine.id}`],
				weight: 0.6,
				observedAt: machine.at,
				text: `only ${r.memAvailableGb} GB memory available`,
			});
		// Before the service watcher's first record (M1), the latest observation is the only source.
		if (serviceStatuses(db).length === 0)
			for (const [name, state] of Object.entries((r.services ?? {}) as Record<string, string>)) {
				if (OK_SERVICES.has(state)) continue;
				add({
					motivation: "self_preservation",
					kind: "service_down",
					cluster: `service:${name}`,
					evidence: [`observation:${machine.id}`],
					weight: 0.6,
					observedAt: machine.at,
					text: `${name} is ${state}`,
				});
			}
	}
	// Services, from `service_status` (M1): current, with the outage's duration and its cause. A long outage
	// weighs more (0.6, +0.05 an hour, at most 0.9: 2026-10-07's eight hours of "retrying" sat at 0.59).
	// The episode (since when) is in the cluster: a later outage of the same service is a new one.
	for (const svc of serviceStatuses(db)) {
		if (OK_SERVICE_STATES.has(svc.state)) continue;
		const hours = Math.max(0, s.now.getTime() - Date.parse(svc.since)) / H;
		add({
			motivation: "self_preservation",
			kind: "service_down",
			cluster: `service:${svc.name}@${svc.since}`,
			evidence: [`service_status:${svc.name}`],
			weight: Math.min(0.9, 0.6 + 0.05 * hours),
			text: `${svc.name} has been ${svc.state} for ${hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`}${svc.last_error ? `: ${svc.last_error}` : ""}`,
		});
	}
	for (const h of s.healing())
		add({
			motivation: "self_preservation",
			kind: h.gaveUp ? "model_gave_up" : "model_reloading",
			cluster: `model:${h.model}@${now.slice(0, 10)}`,
			evidence: [`model_ops:${h.model}`],
			weight: h.gaveUp ? 0.9 : 0.5,
			text: `${h.model} ${h.gaveUp ? "could not be loaded" : "is being loaded again"} (${h.attempts} attempt(s); ${h.lastError.slice(0, 80)})`,
		});
	const backlog = (db.prepare("SELECT count(*) AS n FROM stm_episodes WHERE state = 'backlog'").get() as { n: number })
		.n;
	if (backlog > 0)
		add({
			motivation: "self_preservation",
			kind: "memory_backlog",
			cluster: "memory-backlog",
			evidence: [`stm_backlog:${backlog}`],
			weight: Math.min(0.2 + 0.02 * backlog, 0.6),
			text: `${backlog} conversation(s) still waiting to be stored in long-term memory`,
		});
	const lastNight = getKv(db, "rhythm.last_night_at");
	const lastSummary = getKv(db, "rhythm.last_summary") ?? "";
	if (lastNight && lastNight >= ago(36) && /stopped early/.test(lastSummary))
		add({
			motivation: "self_preservation",
			kind: "night_cut_short",
			cluster: `night:${lastNight.slice(0, 10)}`,
			evidence: [`rhythm.last_night_at:${lastNight}`],
			weight: 0.6,
			observedAt: lastNight,
			text: `the last night stopped early: ${lastSummary.slice(lastSummary.indexOf("stopped early")).slice(0, 100)}`,
		});
	const unknown = db
		.prepare("SELECT id, created_at FROM actions WHERE state = 'unknown' AND created_at >= ? ORDER BY created_at")
		.all(ago(7 * 24)) as { id: string; created_at: string }[];
	if (unknown.length)
		add({
			motivation: "self_preservation",
			kind: "unconfirmed_deliveries",
			cluster: "unconfirmed",
			evidence: unknown.slice(0, 10).map((a) => `action:${a.id}`),
			weight: 0.5,
			observedAt: unknown.at(-1)!.created_at,
			text: `${unknown.length} message(s) may or may not have arrived`,
		});
	const sleep = s.sleep();
	if (sleep?.sleptOnBattery && sleep.asleepMinutes >= 60)
		add({
			motivation: "self_preservation",
			kind: "slept_on_battery",
			cluster: `sleep:${now.slice(0, 10)}`,
			evidence: ["self_facts:sleep"],
			weight: 0.4,
			text: `the computer slept ${Math.round(sleep.asleepMinutes / 60)} h on battery in the last day`,
		});

	// ---------------------------------------------------------------- curiosity
	for (const g of s.selfGaps())
		add({
			motivation: "curiosity",
			kind: `self_${g.kind}`,
			// A contradiction's episode (the network it was seen on) is in the cluster: a new network is a new one.
			cluster: `self:${g.facet}:${g.field}${g.episode ? `@${g.episode}` : ""}`,
			evidence: [`self_facts:${g.facet}:${g.field}`],
			// M0 tuning (2026-10-06, 24 h of samples): a missing statement only the owner can give is a mild
			// reason (M1 asks, a few a day); a contradiction is a strong one; a failing probe in between.
			weight: g.kind === "contradicted" ? 0.8 : g.kind === "missing" ? (g.facet === "social" ? 0.3 : 0.4) : 0.4,
			text: g.why,
		});
	for (const o of db
		// Only investigations: the motivations' own asks and notices are actions, never evidence of more need.
		.prepare(
			"SELECT id, question, created_at FROM opportunities WHERE status IN ('open', 'running') AND action_kind = 'investigate'",
		)
		.all() as { id: string; question: string; created_at: string }[])
		add({
			motivation: "curiosity",
			kind: "open_question",
			cluster: `opportunity:${o.id}`,
			evidence: [`opportunity:${o.id}`],
			weight: 0.4,
			observedAt: o.created_at,
			text: o.question.slice(0, 100),
		});

	// Important beliefs Iyye is unsure of (plan 0.011 F4, §3.5): p in [0.3, 0.7], current, about the owner or
	// a person who matters to them (trusted, or with a stated relation). ("Used in recalls" waits until recall
	// knows what a reply actually used.) Recorded only: the tracker does not count them yet (JOURNAL_ONLY).
	// Settled only by new independent evidence moving p out of the band; a belief resting on Iyye's own
	// words alone is never a reason (HLD §11.2).
	for (const b of db
		.prepare(
			`SELECT b.id, b.subject, b.predicate, b.object, b.negated, b.details, b.p, b.updated_at FROM beliefs b
			 WHERE b.state = 'current' AND b.p >= 0.3 AND b.p <= 0.7
			 AND EXISTS (SELECT 1 FROM belief_evidence e WHERE e.belief_id = b.id AND e.source NOT IN ('iyye', 'probe') AND e.weight > 0)
			 AND (b.subject_ref = 'owner'
				OR (b.subject_ref LIKE 'contact:%' AND (
					EXISTS (SELECT 1 FROM contacts c WHERE 'contact:' || c.id = b.subject_ref AND c.trusted = 1)
					OR EXISTS (SELECT 1 FROM self_facts f WHERE f.facet = 'social' AND 'contact:' || substr(f.field, 10) = b.subject_ref))))
			 ORDER BY b.updated_at DESC LIMIT 20`,
		)
		.all() as {
		id: string;
		subject: string;
		predicate: string;
		object: string;
		negated: number;
		details: string | null;
		p: number;
		updated_at: string;
	}[])
		add({
			motivation: "curiosity",
			kind: "belief_uncertain",
			cluster: `belief:${b.id}`,
			evidence: [`belief:${b.id}`],
			weight: 0.35,
			observedAt: b.updated_at,
			text: `unsure (p ${b.p.toFixed(2)}) whether ${factSentence({ ...b, negated: b.negated === 1 })}`,
		});

	// The owner's recurring unanswered question (M2): the owner's two messages are the evidence.
	for (const q of recurringQuestions(db, s.now))
		add({
			motivation: "curiosity",
			kind: "question_recurring",
			cluster: q.cluster,
			evidence: q.evidence,
			weight: 0.6,
			observedAt: q.at,
			text: `the owner asked again, and Iyye did not know: ${q.topic.slice(0, 120)}`,
		});

	// ---------------------------------------------------------------- agency
	// An intention the owner stated with no plan (M2; M3 proposes a plan for it). Strong enough alone to open
	// within the hour (0.7, fading with the remark's age): the plan only waits for the owner's approval.
	for (const i of unplannedIntentions(db, s.now))
		add({
			motivation: "agency",
			kind: "intention_unplanned",
			cluster: i.cluster,
			evidence: i.evidence,
			weight: 0.7,
			observedAt: i.at,
			text: `the owner said: ${i.text.slice(0, 120)}`,
		});
	for (const p of db
		.prepare(
			"SELECT id, intent, state, steps_json, updated_at, proposed_via FROM plans WHERE state IN ('suspended', 'active', 'proposed')",
		)
		.all() as {
		id: string;
		intent: string;
		state: string;
		steps_json: string;
		updated_at: string;
		proposed_via: string;
	}[]) {
		// A plan Iyye proposed itself (M3) was announced once and lapses unapproved: waiting is no need of its own.
		if (p.state === "proposed" && p.proposed_via === IYYE_PROPOSED_VIA) continue;
		// A proposed plan whose first dated step falls due within a day (or has passed) cannot wait for the owner
		// to look (2026-10-07: plan f9236bfb's reminder was due that morning, unseen).
		const due = p.state === "proposed" ? firstDue(p.steps_json) : null;
		const urgent = due !== null && due < new Date(s.now.getTime() + 24 * H).toISOString();
		const stalled = p.state === "active" && p.updated_at < ago(24);
		const waiting = p.state === "proposed" && (urgent || p.updated_at < ago(24));
		if (p.state !== "suspended" && !stalled && !waiting) continue;
		add({
			motivation: "agency",
			kind: p.state === "suspended" ? "plan_suspended" : stalled ? "plan_stalled" : "plan_awaiting_approval",
			cluster: `plan:${p.id}`,
			evidence: [`plan:${p.id}`],
			weight: p.state === "suspended" ? 0.6 : stalled ? 0.4 : urgent ? 0.8 : 0.3,
			// An urgent plan's pressure is current, not as old as the proposal.
			observedAt: urgent ? s.now.toISOString() : p.updated_at,
			text: `plan ${JSON.stringify(p.intent.slice(0, 60))} is ${stalled ? "active with no progress for a day" : p.state}${urgent ? `; its first step is due ${due!.slice(0, 16).replace("T", " ")} UTC` : ""}`,
		});
	}
	for (const c of db
		.prepare(
			"SELECT id, state, coalesce(settled_at, due_at) AS at FROM commitments WHERE (state = 'unknown') OR (state = 'failed' AND settled_at >= ?)",
		)
		.all(ago(7 * 24)) as { id: string; state: string; at: string }[])
		add({
			motivation: "agency",
			kind: c.state === "failed" ? "commitment_failed" : "commitment_unconfirmed",
			cluster: `commitment:${c.id}`,
			evidence: [`commitment:${c.id}`],
			weight: 0.5,
			observedAt: c.at,
			text: `a reminder ${c.state === "failed" ? "could not be delivered" : "may not have arrived"}`,
		});

	// ---------------------------------------------------------------- social
	// A dated event someone mentioned, now over (M2; M3 asks how it went). Its pressure is current while the
	// follow-up is due (the three days after the event), so it is observed now, not when the event was.
	for (const e of pastEvents(db, s.now))
		add({
			motivation: "social",
			kind: "event_followup",
			cluster: e.cluster,
			evidence: e.evidence,
			weight: 0.65,
			text: e.text,
		});
	for (const j of db
		.prepare(
			// Not waiting any more once a later message in that conversation was answered (M0 tuning, 2026-10-06:
			// failures during a restart kept social need near 0.9 for two days after the owner was answered).
			`SELECT j.id, j.scope, j.settled_at FROM jobs j WHERE j.status = 'failed' AND j.settled_at >= ? AND j.scope NOT LIKE 'iyye%'
			 AND NOT EXISTS (SELECT 1 FROM events e WHERE e.scope = j.scope AND e.status = 'answered' AND e.received_at > j.created_at)
			 ORDER BY j.settled_at`,
		)
		.all(ago(48)) as { id: string; scope: string; settled_at: string }[])
		add({
			motivation: "social",
			kind: "person_unanswered",
			cluster: `unanswered:${j.scope}`,
			evidence: [`job:${j.id}`],
			weight: 0.7,
			observedAt: j.settled_at,
			text: `a message in ${j.scope === "owner" ? "the owner's conversation" : "a contact's conversation"} could not be answered`,
		});
	for (const d of db
		.prepare(
			"SELECT id, subject_ref, verdicts_json, created_at FROM decisions WHERE role = ? AND schema_version >= 2 AND status = 'ok' AND created_at >= ?",
		)
		.all(REPLY_REVIEW.name, ago(72)) as {
		id: string;
		subject_ref: string;
		verdicts_json: string;
		created_at: string;
	}[]) {
		const v = JSON.parse(d.verdicts_json ?? "{}") as Record<string, string>;
		if (v[CLAIM_QUESTION.id] !== "yes" || commitmentsOfReply(db, d.subject_ref ?? "").length > 0) continue;
		add({
			motivation: "social",
			kind: "claim_without_record",
			cluster: `claim:${d.subject_ref}`,
			evidence: [`decision:${d.id}`],
			weight: 0.5,
			observedAt: d.created_at,
			text: "a reply claimed something was set up, and nothing was",
		});
	}
	return out;
}

/** A signal's weight, faded by its age (a day's half-life, about). */
export function strength(sig: Signal, now: Date): number {
	const age = Math.max(0, now.getTime() - Date.parse(sig.observedAt));
	return sig.weight * Math.exp(-age / (36 * H));
}

/**
 * Raw need of one motivation, in [0, 1]. Signals of one kind count about
 * once: the strongest, plus 10% for each further one, at most +0.1 above
 * it (M0 tuning, 2026-10-06: five "relation unknown" gaps combined as
 * independent pressures pegged curiosity at 0.97 for a whole day). Kinds
 * then combine as independent pressures, 1 − Π(1 − kind), so one strong
 * reason is enough and different reasons add up.
 */
export function rawNeed(signals: readonly Signal[], now: Date): number {
	const byKind = new Map<string, number[]>();
	for (const sig of signals) byKind.set(sig.kind, [...(byKind.get(sig.kind) ?? []), strength(sig, now)]);
	let rest = 1;
	for (const strengths of byKind.values()) {
		const [top, ...more] = strengths.sort((a, b) => b - a);
		rest *= 1 - Math.min(1, top! + Math.min(0.1, 0.1 * top! * more.length));
	}
	return 1 - rest;
}

/** The earliest `due_at` among a plan's pending steps, or null. */
function firstDue(stepsJson: string): string | null {
	try {
		const due = (JSON.parse(stepsJson) as { due_at?: string; status?: string }[])
			.filter((x) => typeof x.due_at === "string" && x.status !== "done")
			.map((x) => x.due_at!)
			.sort();
		return due[0] ?? null;
	} catch {
		return null;
	}
}
