// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The owner's `/decisions` report (plan 0.003 §3.5): the service, then per
 * role what was asked and how it compared with what actually happened.
 * Most roles are shadow: their numbers are evidence for a later owner
 * decision. An acting role's rows are journaled `acting` (plan 0.004 §3.4).
 */

import type { Db } from "../state/db.ts";
import { joinOutcome, type Role } from "./client.ts";
import { INITIATIVE } from "./initiative.ts";
import { MEMORY_SALIENCE, SALIENCE_QUESTION } from "./memory-salience.ts";
import { OBSERVATION_IMPORTANCE } from "./observation-importance.ts";
import { CLAIM_QUESTION, commitmentsOfReply, PROMISE_QUESTION, REPLY_REVIEW } from "./reply-review.ts";
import { INCLUDE_AT, TOOLKIT_SELECTION, TOOLKIT_SELECTION_ACTING } from "./toolkit-selection.ts";

/** Every role this host asks, in report order. */
export const ROLES: readonly Role[] = [
	TOOLKIT_SELECTION,
	MEMORY_SALIENCE,
	REPLY_REVIEW,
	OBSERVATION_IMPORTANCE,
	INITIATIVE,
];

/** Reply reviews before schema 2 (plan 0.006 C2) were asked only "promises or offers". */
const LEGACY_REVIEW_LABEL = {
	field: "promises_future_action",
	yes: "the reply promised a future action",
	no: "the reply promised no future action",
};

/** Roles the owner can label with `/decisions label`, and the question each label answers. */
const LABELLED: Record<string, { field: string; yes: string; no: string }> = {
	[MEMORY_SALIENCE.name]: {
		field: "worth_remembering",
		yes: "the message was worth remembering",
		no: "the message was not worth remembering",
	},
	[OBSERVATION_IMPORTANCE.name]: {
		field: "worth_telling",
		yes: "the change was worth telling you about",
		no: "the change was not worth telling you about",
	},
	[INITIATIVE.name]: {
		field: "worth_investigating",
		yes: "it was worth investigating",
		no: "it was not worth investigating",
	},
	[REPLY_REVIEW.name]: {
		field: "claims_arranged",
		yes: "the reply claimed something was set up",
		no: "the reply did not claim anything was set up",
	},
};

interface Row {
	id: string;
	mode: string;
	schema_version: number;
	role: string;
	answers_json: string | null;
	verdicts_json: string | null;
	outcome_source: string | null;
	label_strength: string | null;
	state_hash: string;
	subject_ref: string | null;
	scope: string | null;
	status: string;
	created_at: string;
	latency_ms: number | null;
	checkpoint: string | null;
	outcome_json: string | null;
	error: string | null;
	state_json: string;
}

interface SelectionOutcome {
	used: string[];
	toolkits: Record<string, { p: number | null; verdict: "yes" | "no" | "abstain" | null; used: boolean }>;
}

export function decisionsReport(
	db: Db,
	service: { state: string; detail: string },
	pendingSelection = 0,
	pendingReplies = 0,
): string {
	const rows = db.prepare("SELECT * FROM decisions ORDER BY created_at, rowid").all() as Row[];
	const lines = [`decision service: ${service.state}: ${service.detail}`];
	if (rows.length === 0) return [...lines, "no decisions yet"].join("\n");
	// A role acts when its latest row says so (toolkit selection can be switched back to shadow).
	const latest = new Map<string, string>();
	for (const r of rows) latest.set(r.role, r.mode);
	const acting = [...latest].filter(([, m]) => m === "acting").map(([r]) => r);
	lines.push(
		acting.length
			? `acting: ${acting.join(", ")} (its answer changes what Iyye does, with a fallback when Kev cannot answer); the rest are shadow`
			: "mode: shadow (nothing acts on these answers)",
	);
	const byRole = new Map<string, Row[]>();
	for (const r of rows) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r]);
	for (const [role, rs] of byRole) {
		const ok = rs.filter((r) => r.status === "ok");
		const lat = ok.map((r) => r.latency_ms ?? 0).sort((a, b) => a - b);
		lines.push(
			"",
			`${role}: ${rs.length} asked · ${ok.length} ok · ${rs.filter((r) => r.status === "error").length} errors · ${rs.filter((r) => r.status === "skipped").length} skipped` +
				(lat.length ? ` · median ${lat[Math.floor(lat.length / 2)]} ms` : ""),
		);
		const last = rs.at(-1)!;
		if (last.status === "error") lines.push(`  last error: ${last.error}`);
		if (role === TOOLKIT_SELECTION.name) {
			const shadow = ok.filter((r) => r.schema_version < 2);
			if (shadow.length) lines.push(...selectionLines(shadow, pendingSelection));
			const acted = rs.filter((r) => r.schema_version >= 2);
			if (acted.length) lines.push(...actingSelectionLines(acted));
		}
		if (role === MEMORY_SALIENCE.name) lines.push(...salienceLines(ok));
		if (role === REPLY_REVIEW.name) lines.push(...reviewLines(db, ok, pendingReplies));
	}
	lines.push("", "more: /decisions <role> (recent answers) · /decisions label <id> yes|no");
	return lines.join("\n");
}

/** `/decisions <role>`: its most recent rows, with what each was about and how it turned out. */
export function roleReport(db: Db, role: string, limit = 12): string {
	if (!ROLES.some((r) => r.name === role)) {
		return `unknown role ${JSON.stringify(role)}; roles: ${ROLES.map((r) => r.name).join(", ")}`;
	}
	const rows = (
		db
			.prepare("SELECT * FROM decisions WHERE role = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
			.all(role, limit) as Row[]
	).reverse();
	if (rows.length === 0) return `${role}: no decisions yet`;
	const acts = rows.at(-1)!.mode === "acting";
	const r0 = acts && role === TOOLKIT_SELECTION.name ? TOOLKIT_SELECTION_ACTING : ROLES.find((r) => r.name === role)!;
	const lines = [
		`${role} (schema ${rows.at(-1)!.schema_version}, unsure between ${r0.abstain.low} and ${r0.abstain.high}; ${acts ? `acting — without Kev: ${r0.fallback ?? "its fallback"}` : `shadow — ${r0.fallback ?? "nothing acts on it"}`}):`,
	];
	for (const r of rows) {
		const answers = r.answers_json ? (JSON.parse(r.answers_json) as Record<string, { noul?: number }>) : {};
		const verdicts = r.verdicts_json ? (JSON.parse(r.verdicts_json) as Record<string, string>) : {};
		const ps = Object.entries(answers)
			.map(([q, a]) => `${q}=${a.noul?.toFixed(2)} ${verdicts[q] ?? ""}`.trim())
			.join(", ");
		const outcome = r.outcome_json ? ` → ${r.outcome_json} (${r.outcome_source}, ${r.label_strength ?? "weak"})` : "";
		lines.push(
			`  ${r.id.slice(0, 8)} ${r.created_at.slice(0, 16).replace("T", " ")} ${r.scope ?? "-"} ${r.status}${r.status === "ok" ? `: ${ps}` : r.error ? `: ${r.error}` : ""}${outcome} · state ${r.state_hash.slice(0, 8)}: ${preview(r.state_json)}`,
		);
	}
	return lines.join("\n");
}

/**
 * `/decisions label <id> yes|no`: the owner's answer to a decision's question
 * (an owner label: no weak label replaces it). Only roles with an owner
 * question; the model's own answer is never a label.
 */
export function labelDecision(db: Db, ref: string, answer: string, issuer: string, at: string): string {
	if (!/^[0-9a-f-]{6,36}$/i.test(ref)) return "usage: /decisions label <id, at least 6 characters> yes|no";
	if (answer !== "yes" && answer !== "no") return "usage: /decisions label <id> yes|no";
	const rows = db
		.prepare("SELECT id, role, schema_version FROM decisions WHERE id LIKE ?")
		.all(`${ref.toLowerCase()}%`) as { id: string; role: string; schema_version: number }[];
	if (rows.length === 0) return `no decision ${ref}; see /decisions <role>`;
	if (rows.length > 1) return `${ref} matches ${rows.length} decisions; use more of the id`;
	const row = rows[0]!;
	// A label answers the question the row was asked: a schema-1 reply review was never asked claims_arranged (§15 #18).
	const l = row.role === REPLY_REVIEW.name && row.schema_version < 2 ? LEGACY_REVIEW_LABEL : LABELLED[row.role];
	if (!l) return `${row.role} is labelled automatically, not by the owner`;
	const yes = answer === "yes";
	joinOutcome(db, row.id, { [l.field]: yes }, issuer, "owner", at);
	return `labelled ${row.id.slice(0, 8)} (${row.role}): ${yes ? l.yes : l.no}`;
}

function preview(stateJson: string): string {
	const s = JSON.parse(stateJson) as unknown;
	const text = typeof s === "string" ? s : JSON.stringify(s);
	return text.replace(/\s+/g, " ").slice(0, 70);
}

function noul(r: Row, question: string): number | null {
	const a = r.answers_json ? (JSON.parse(r.answers_json) as Record<string, { noul?: number }>) : {};
	return typeof a[question]?.noul === "number" ? a[question]!.noul! : null;
}

/**
 * Memory salience against the transfer's result (weak) or the owner's label.
 * The threshold that would have separated them best is the evidence for the
 * owner's later decision to let the role act.
 */
function salienceLines(rows: Row[]): string[] {
	const labelled = rows
		.filter((r) => r.outcome_json)
		.map((r) => ({
			p: noul(r, SALIENCE_QUESTION.id),
			kept: (JSON.parse(r.outcome_json!) as { worth_remembering: boolean }).worth_remembering,
			owner: r.label_strength === "owner",
			v: (JSON.parse(r.verdicts_json ?? "{}") as Record<string, string>)[SALIENCE_QUESTION.id],
		}))
		.filter((x): x is { p: number; kept: boolean; owner: boolean; v: string } => x.p !== null);
	if (labelled.length === 0) return ["  no outcomes yet (they arrive as the night stores each message)"];
	const mean = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "-");
	const kept = labelled.filter((x) => x.kept);
	const empty = labelled.filter((x) => !x.kept);
	const decided = labelled.filter((x) => x.v !== "abstain");
	const agree = decided.filter((x) => (x.v === "yes") === x.kept).length;
	const best = bestThreshold(labelled.map((x) => ({ p: x.p, yes: x.kept })));
	return [
		`  ${labelled.length} with an outcome (${labelled.filter((x) => x.owner).length} labelled by you): kept ${kept.length} (mean p ${mean(kept.map((x) => x.p))}), nothing kept ${empty.length} (mean p ${mean(empty.map((x) => x.p))})`,
		`  at its band: ${agree}/${decided.length} agree, ${labelled.length - decided.length} unsure`,
		`  best single threshold so far: p ≥ ${best.t.toFixed(2)} → ${best.correct}/${labelled.length} agree (weak labels: Hindsight's extraction is itself a model)`,
	];
}

/**
 * Reply review against the commitments ledger (plan 0.006 C2): of the replies
 * Kev says claim something is set up, which came from a turn that created a
 * commitment (supported) and which did not (unsupported: listed for the
 * owner). The ledger fact is recomputed here, so an owner label never hides it.
 */
function reviewLines(db: Db, rows: Row[], pending: number): string[] {
	const verdicts = (r: Row) => JSON.parse(r.verdicts_json ?? "{}") as Record<string, string>;
	const promise = (r: Row) => verdicts(r)[PROMISE_QUESTION.id];
	// Schemas are never pooled (plan 0.003 K2) unless the question and the state are the same word for word:
	// schema 3 (plan 0.010 M2) only added questions, so these two figures count schemas 2 and 3; schema 1 apart.
	const v2 = rows.filter((r) => r.schema_version >= 2);
	const v1 = rows.length - v2.length;
	const out = [
		`  promises or offers a future action: ${v2.filter((r) => promise(r) === "yes").length} yes · ${v2.filter((r) => promise(r) === "abstain").length} unsure · ${v2.filter((r) => promise(r) === "no").length} no${v1 ? ` (and ${v1} earlier schema-1 review(s), not pooled)` : ""}`,
	];
	if (v2.length) {
		const claims = (r: Row) => verdicts(r)[CLAIM_QUESTION.id];
		const made = (r: Row) => commitmentsOfReply(db, r.subject_ref ?? "").length > 0;
		const yes = v2.filter((r) => claims(r) === "yes");
		const supported = yes.filter(made);
		const unsupported = yes.filter((r) => !made(r));
		out.push(
			`  claims something is set up: ${yes.length} yes · ${v2.filter((r) => claims(r) === "abstain").length} unsure · ${v2.filter((r) => claims(r) === "no").length} no`,
			`  of the yes: ${supported.length} with a reminder made in that turn · ${unsupported.length} WITHOUT one (unsupported)`,
		);
		if (unsupported.length) {
			out.push(
				"  unsupported claims (label: /decisions label <id> yes|no — yes: it did claim something was set up):",
				...unsupported
					.slice(-5)
					.map(
						(r) =>
							`    ${r.id.slice(0, 8)} p=${noul(r, CLAIM_QUESTION.id)?.toFixed(2)}${r.label_strength === "owner" ? " (labelled)" : ""}: ${((JSON.parse(r.state_json) as { reply?: string }).reply ?? "").replace(/\s+/g, " ").slice(0, 80)}`,
					),
			);
		}
	}
	const owner = rows.filter((r) => r.label_strength === "owner" && r.outcome_json);
	if (owner.length) {
		const agree = owner.filter((r) => {
			const o = JSON.parse(r.outcome_json!) as { claims_arranged?: boolean; promises_future_action?: boolean };
			const [q, truth] =
				o.claims_arranged !== undefined
					? [CLAIM_QUESTION.id, o.claims_arranged]
					: [PROMISE_QUESTION.id, o.promises_future_action];
			const v = verdicts(r)[q];
			return v !== undefined && v !== "abstain" && (v === "yes") === truth;
		}).length;
		out.push(`  your labels: ${owner.length}, Kev agrees on ${agree}`);
	} else out.push("  no labels from you yet");
	if (pending) out.push(`  ${pending} delivered repl${pending === 1 ? "y" : "ies"} waiting to be reviewed`);
	return out;
}

/** The cut-off on p that agrees with the labels most often (ties: the lowest). */
export function bestThreshold(xs: { p: number; yes: boolean }[]): { t: number; correct: number } {
	const cuts = [0, ...[...new Set(xs.map((x) => x.p))].sort((a, b) => a - b), 1.01];
	let best = { t: 0.5, correct: -1 };
	for (const t of cuts) {
		const correct = xs.filter((x) => x.p >= t === x.yes).length;
		if (correct > best.correct) best = { t: Math.min(t, 1), correct };
	}
	return best;
}

/** Per toolkit: "needed" (yes or abstain: an unsure answer would include it) against actually used. */
function selectionLines(rows: Row[], pending: number): string[] {
	const stats = new Map<string, { tp: number; fn: number; fp: number; tn: number; abstain: number }>();
	const misses: string[] = [];
	let switches = 0;
	let harmful = 0;
	const active = new Map<string, Set<string>>(); // scope + day → toolkits a sticky, additive selection would have active
	for (const r of rows) {
		if (!r.outcome_json) continue;
		const o = JSON.parse(r.outcome_json) as SelectionOutcome;
		const key = `${r.scope}|${r.created_at.slice(0, 10)}`;
		const on = active.get(key) ?? new Set<string>();
		active.set(key, on);
		for (const [kit, v] of Object.entries(o.toolkits)) {
			const s = stats.get(kit) ?? { tp: 0, fn: 0, fp: 0, tn: 0, abstain: 0 };
			stats.set(kit, s);
			if (v.verdict === null) continue;
			const needed = v.verdict !== "no";
			if (v.verdict === "abstain") s.abstain++;
			if (needed && v.used) s.tp++;
			else if (needed) s.fp++;
			else if (v.used) s.fn++;
			else s.tn++;
			if (!needed && v.used) {
				if (!on.has(kit)) harmful++;
				const msg = (JSON.parse(r.state_json) as { message?: string }).message ?? "";
				misses.push(
					`  ${r.created_at.slice(0, 16).replace("T", " ")} ${kit} p=${v.p?.toFixed(2)}: ${msg.slice(0, 70).replace(/\s+/g, " ")}`,
				);
			}
			if (needed && !on.has(kit)) {
				on.add(kit);
				switches++;
			}
		}
	}
	const out = ["  per toolkit (needed = yes or unsure; used = the model called it):"];
	for (const [kit, s] of stats) {
		const n = s.tp + s.fn + s.fp + s.tn;
		out.push(
			`    ${kit}: ${n} turns · used ${s.tp + s.fn} · needed&used ${s.tp} · missed ${s.fn} · extra ${s.fp} · unsure ${s.abstain}` +
				(s.tp + s.fn ? ` · recall ${Math.round((100 * s.tp) / (s.tp + s.fn))}%` : ""),
		);
	}
	out.push(
		`  if it acted (sticky, add-only per conversation and day): ${switches} tool-list change(s) (each reprocesses the conversation), ${harmful} turn(s) missing a needed toolkit`,
	);
	if (misses.length) out.push("  recent misses:", ...misses.slice(-5));
	if (pending) out.push(`  ${pending} turn(s) waiting to be asked`);
	return out;
}

interface ActingOutcome {
	include_at: number;
	fresh: boolean;
	added: string[];
	kept_out: string[];
	declared: string[];
	used: string[];
	ok: boolean;
}

/**
 * Acting toolkit selection (plan 0.004 §3.4). A toolkit kept out cannot be
 * called, so a miss never shows as a tool call. The nearest sign is the same
 * toolkit added on the very next turn of that conversation: the person may
 * have had to ask again. That count is an upper bound (the next message may
 * simply be a new question), so both messages are listed for the owner to
 * judge. An add after the first turn reprocesses the whole conversation.
 */
function actingSelectionLines(rows: Row[]): string[] {
	const per = new Map<string, { asked: number; added: number; used: number; kept: number; next: number }>();
	const kit = (k: string) => {
		const s = per.get(k) ?? { asked: 0, added: 0, used: 0, kept: 0, next: 0 };
		per.set(k, s);
		return s;
	};
	let reprocessed = 0;
	let fallbacks = 0;
	const missed: string[] = [];
	const previous = new Map<string, { kept: string[]; at: string; message: string }>(); // scope → its last asked turn
	for (const r of rows) {
		if (!r.outcome_json) continue;
		const o = JSON.parse(r.outcome_json) as ActingOutcome;
		if (r.status !== "ok") fallbacks++;
		if (!o.fresh && o.added.length) reprocessed++;
		const message = ((JSON.parse(r.state_json) as { message?: string }).message ?? "")
			.replace(/\s+/g, " ")
			.slice(0, 60);
		const before = previous.get(r.scope ?? "");
		for (const k of o.added) {
			const s = kit(k);
			s.asked++;
			s.added++;
			if (o.used.includes(k)) s.used++;
			if (before?.kept.includes(k)) {
				s.next++;
				missed.push(
					`  ${before.at} ${k} kept out for ${JSON.stringify(before.message)}, added for ${JSON.stringify(message)}`,
				);
			}
		}
		for (const k of o.kept_out) {
			kit(k).asked++;
			kit(k).kept++;
		}
		previous.set(r.scope ?? "", { kept: o.kept_out, at: r.created_at.slice(0, 16).replace("T", " "), message });
	}
	const out = [`  acting (schema 2; kept out only below p ${INCLUDE_AT}, included when Kev cannot answer):`];
	for (const [k, s] of per)
		out.push(
			`    ${k}: asked ${s.asked} · added ${s.added} (used ${s.used}) · kept out ${s.kept} · kept out, then added on the next turn ${s.next} (at most that many misses)`,
		);
	out.push(
		`  ${reprocessed} add(s) after a conversation's first turn (each reprocessed it) · ${fallbacks} turn(s) where Kev could not answer (everything included)`,
	);
	if (missed.length)
		out.push(
			"  kept out, then added on the next turn (judge each: a miss, or a new question?):",
			...missed.slice(-5),
		);
	return out;
}
