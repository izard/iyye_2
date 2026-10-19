// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Beliefs (plan 0.011 F2, §3.4): the nightly merge of structured facts into
 * one common world model, a Bayesian update in log-odds that counts only
 * independent evidence and knows about time.
 *
 * - **p is a fold over evidence rows** (from 0.5): `logit(p) = Σ sign ·
 *   weight · logit(p_source)`. Nothing else writes it, so removing a
 *   person's rows (`/forget`) recomputes it exactly, and a belief left with
 *   no evidence is deleted.
 * - **Independence:** a source that already supports a belief adds a row of
 *   weight 0 (a person repeating themselves); Iyye's own words never add to
 *   or lower a belief another source holds (weight 0), and create one only
 *   when they cite a source (a web result, a measurement), with that prior;
 *   uncited, they stay stored text and create no belief. Exit gates #2, #12.
 * - **The nightly cap:** one night's updates to an existing belief move its
 *   log-odds by at most `maxStep`; the evidence that creates a belief applies
 *   its prior in full.
 * - **Deterministic classification** for the same fact key (plan §3.4 step
 *   2): the same value corroborates; the negation contradicts; another value
 *   of a single-valued predicate (lives in, works at, age, …) said later
 *   *changes* it (the old belief is closed, its history kept: "lived in
 *   Berlin until 2025"), said the same day contradicts it; other predicates
 *   hold several values. Non-exact relations are F3's shadow role.
 */

import type { Db } from "../state/db.ts";
import { COMPARISON, logit, normalizeTerm, privateReason, sigmoid } from "./extract.ts";
import type { StmFact } from "./store.ts";

/** Predicates with one value at a time: a new value replaces the old one. */
export const SINGLE_VALUED = new Set([
	"is_named",
	"lives_in",
	"located_in",
	"from",
	"works_at",
	"works_as",
	"age",
	"born_on",
]);

export type Relation = "new" | "corroborates" | "contradicts" | "changes" | "correction";

export interface Belief {
	id: string;
	fact_key: string;
	subject_ref: string;
	subject: string;
	predicate: string;
	object: string;
	object_norm: string;
	negated: number;
	details: string | null;
	time_frame: string;
	valid_from: string;
	valid_to: string | null;
	p: number;
	state: "current" | "closed";
	closed_by: string | null;
	created_at: string;
	updated_at: string;
	/** The owner's override (plan §3.6): null follows the evidence. */
	disclosure: "private" | "share" | null;
	recalled_at: string | null;
}

export interface Evidence {
	id: string;
	belief_id: string;
	stm_fact_id: string | null;
	source: string;
	scope: string;
	event_id: string | null;
	modality: string;
	sign: number;
	source_p: number;
	weight: number;
	relation: Relation;
	night: string;
	at: string;
	private: number;
	/** The date the evidence says its value held from (null for a contradiction or a confirmation; plan 0.013 E1). */
	effective_at: string | null;
	/** When it was said. */
	said_at: string | null;
	/** 0 when `effective_at` is only the day it was received (rows merged before the dates were kept). */
	effective_known: number;
}

export interface MergeOptions {
	/** This night's id: the cap counts the updates made under it. */
	night: string;
	maxStep: number;
	now: Date;
	newId: () => string;
}

export interface MergeResult {
	beliefId: string | null;
	relation: Relation | "suppressed";
	/** Other beliefs this fact contradicted or closed. */
	touched: { beliefId: string; how: "contradicts" | "changes" }[];
}

/** True when every word of `inner` appears, in order and whole, in `outer` ("nvidia" in "nvidia germany"). */
export function containsWords(outer: string, inner: string): boolean {
	if (!inner || inner === outer) return inner === outer && inner !== "";
	return ` ${outer} `.includes(` ${inner} `);
}

/** A comparison or an estimate, not a value: it neither replaces nor contradicts one. */
export function approximate(text: string): boolean {
	return COMPARISON.test(text);
}

/** The probability the evidence rows give (0.5 with none). */
export function foldP(rows: readonly Pick<Evidence, "sign" | "weight" | "source_p">[]): number {
	return sigmoid(rows.reduce((x, r) => x + r.sign * r.weight * logit(clampP(r.source_p)), 0));
}

function clampP(p: number): number {
	return Math.min(0.99, Math.max(0.01, p));
}

/** Recompute a belief's p from its evidence; a belief with no evidence left is deleted. Returns p or null. */
export function recompute(db: Db, beliefId: string, at: string): number | null {
	const rows = db
		.prepare("SELECT sign, weight, source_p FROM belief_evidence WHERE belief_id = ?")
		.all(beliefId) as Pick<Evidence, "sign" | "weight" | "source_p">[];
	if (rows.length === 0) {
		db.prepare("DELETE FROM beliefs WHERE id = ?").run(beliefId);
		return null;
	}
	const p = foldP(rows);
	db.prepare("UPDATE beliefs SET p = ?, updated_at = ? WHERE id = ?").run(p, at, beliefId);
	return p;
}

export function getBelief(db: Db, id: string): Belief | null {
	return (db.prepare("SELECT * FROM beliefs WHERE id = ?").get(id) as Belief | undefined) ?? null;
}

function predicateOf(key: string): string {
	return key.slice(key.indexOf("|") + 1);
}

/** The weight one more row may have: independence, Iyye's echoes, and the night's cap. */
function weightFor(
	db: Db,
	beliefId: string,
	row: { source: string; modality: string; sign: number; source_p: number; relation: Relation },
	o: MergeOptions,
): number {
	const rows = db.prepare("SELECT * FROM belief_evidence WHERE belief_id = ?").all(beliefId) as Evidence[];
	if (row.modality === "told_by_iyye") return row.relation === "new" && rows.length === 0 && row.sign === 1 ? 1 : 0;
	if (rows.some((r) => r.source === row.source && r.sign === row.sign && r.weight > 0)) return 0;
	if (row.relation === "new" || row.relation === "correction") return 1; // a belief's creation applies its prior in full
	const used = rows
		.filter((r) => r.night === o.night && r.relation !== "new" && r.relation !== "correction")
		.reduce((x, r) => x + Math.abs(r.weight * logit(clampP(r.source_p))), 0);
	const term = Math.abs(logit(clampP(row.source_p)));
	const room = Math.max(0, o.maxStep - used);
	return term <= room ? 1 : Math.round((room / term) * 1000) / 1000;
}

function addEvidence(
	db: Db,
	beliefId: string,
	row: {
		stmFactId: string | null;
		source: string;
		scope: string;
		eventId: string | null;
		modality: string;
		sign: 1 | -1;
		sourceP: number;
		relation: Relation;
		private?: number;
		effectiveAt: string | null;
		saidAt: string;
	},
	o: MergeOptions,
): void {
	const weight = weightFor(
		db,
		beliefId,
		{ source: row.source, modality: row.modality, sign: row.sign, source_p: row.sourceP, relation: row.relation },
		o,
	);
	db.prepare(
		`INSERT INTO belief_evidence (id, belief_id, stm_fact_id, source, scope, event_id, modality, sign, source_p, weight, relation, night, at, private,
			effective_at, said_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		o.newId(),
		beliefId,
		row.stmFactId,
		row.source,
		row.scope,
		row.eventId,
		row.modality,
		row.sign,
		row.sourceP,
		weight,
		row.relation,
		o.night,
		o.now.toISOString(),
		row.private ?? 0,
		row.effectiveAt,
		row.saidAt,
	);
	recompute(db, beliefId, o.now.toISOString());
}

function createBelief(
	db: Db,
	f: Pick<
		StmFact,
		| "fact_key"
		| "subject_ref"
		| "subject"
		| "predicate"
		| "object"
		| "negated"
		| "details"
		| "time_frame"
		| "valid_from"
	>,
	o: MergeOptions,
): string {
	const id = o.newId();
	const at = o.now.toISOString();
	db.prepare(
		`INSERT INTO beliefs (id, fact_key, subject_ref, subject, predicate, object, object_norm, negated, details, time_frame,
			valid_from, p, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.5, ?, ?)`,
	).run(
		id,
		f.fact_key,
		f.subject_ref,
		f.subject,
		f.predicate,
		f.object,
		normalizeTerm(f.object),
		f.negated,
		f.details,
		f.time_frame,
		f.valid_from,
		at,
		at,
	);
	return id;
}

function findBelief(db: Db, key: string, objectNorm: string, negated: number): Belief | null {
	return (
		(db
			.prepare("SELECT * FROM beliefs WHERE fact_key = ? AND object_norm = ? AND negated = ?")
			.get(key, objectNorm, negated) as Belief | undefined) ?? null
	);
}

/**
 * Merge one structured fact (call inside a transaction, oldest fact first).
 * The fact is marked merged (or dropped, when a suppression covers it).
 * Which value of a single-valued key holds when is not decided here: the
 * fact's evidence row carries its dates, and `rebuildTimeline` derives the
 * date ranges from all of the key's evidence (plan 0.013 E1).
 */
export function mergeFact(db: Db, f: StmFact, o: MergeOptions): MergeResult {
	const at = o.now.toISOString();
	const norm = normalizeTerm(f.object);
	const suppressed = db
		.prepare(
			"SELECT 1 FROM belief_suppressions WHERE fact_key = ? AND object_norm = ? AND negated = ? AND until_at >= ?",
		)
		.get(f.fact_key, norm, f.negated, f.said_at);
	if (suppressed) {
		db.prepare("UPDATE stm_facts SET state = 'dropped', merged_at = ? WHERE id = ?").run(at, f.id);
		return { beliefId: null, relation: "suppressed", touched: [] };
	}
	const row = (relation: Relation, sign: 1 | -1) => ({
		stmFactId: f.id,
		source: f.source,
		scope: f.scope,
		eventId: f.event_id,
		modality: f.modality,
		sign,
		sourceP: f.p,
		relation,
		private: f.private ?? 0,
		// Only supporting rows place a value in time; a contradiction says nothing about when.
		effectiveAt: sign > 0 ? f.valid_from : null,
		saidAt: f.said_at,
	});
	const touched: MergeResult["touched"] = [];
	const single = SINGLE_VALUED.has(predicateOf(f.fact_key));
	const before = single ? currentOf(db, f.fact_key) : null;
	let beliefId: string;
	let relation: Relation;
	// The same value, or the same value more or less specifically ("Nvidia" and "Nvidia Germany"): one belief.
	const same =
		findBelief(db, f.fact_key, norm, f.negated) ??
		(
			db
				.prepare(
					"SELECT * FROM beliefs WHERE fact_key = ? AND negated = ? AND state = 'current' ORDER BY created_at",
				)
				.all(f.fact_key, f.negated) as Belief[]
		).find((b) => containsWords(b.object_norm, norm) || containsWords(norm, b.object_norm)) ??
		null;
	if (!same && f.modality === "told_by_iyye" && !f.cited) {
		// Iyye's own uncited words create no belief (HLD §11.2): they stay stored text, labelled as Iyye's.
		db.prepare("UPDATE stm_facts SET state = 'merged', merged_at = ?, belief_id = NULL WHERE id = ?").run(at, f.id);
		return { beliefId: null, relation: "new", touched: [] };
	}
	if (same) {
		beliefId = same.id;
		relation = "corroborates";
		addEvidence(db, beliefId, row("corroborates", 1), o);
	} else {
		// A new value: what it contradicts among the beliefs of the same key.
		const others = db
			.prepare(
				"SELECT * FROM beliefs WHERE fact_key = ? AND state = 'current' AND NOT (object_norm = ? AND negated = ?)",
			)
			.all(f.fact_key, norm, f.negated) as Belief[];
		// Iyye's own words never replace or contradict what someone else said (they only add weight-0 rows),
		// and a comparison or an estimate ("older than 10", "about 40") is no other value of the key.
		const replaces =
			single &&
			f.negated === 0 &&
			f.modality !== "told_by_iyye" &&
			!approximate(norm) &&
			!approximate(normalizeTerm(f.details ?? ""));
		relation = "new";
		beliefId = createBelief(db, f, o);
		addEvidence(db, beliefId, row("new", 1), o);
		for (const b of others) {
			if (b.object_norm === norm) {
				// The same value, the other way round: "plays the violin" against "does not play the violin".
				addEvidence(db, b.id, row("contradicts", -1), o);
				touched.push({ beliefId: b.id, how: "contradicts" });
			} else if (replaces && plainValue(b) && b.valid_from === f.valid_from) {
				// Another value of a single-valued key said for the same time: one of them is wrong. A value for an
				// older date is history before it (plan 0.013: an older report keeps later transitions, in p too).
				addEvidence(db, b.id, row("contradicts", -1), o);
				touched.push({ beliefId: b.id, how: "contradicts" });
			}
		}
	}
	if (single) {
		rebuildTimeline(db, f.fact_key, o.now.toISOString().slice(0, 10));
		const after = currentOf(db, f.fact_key);
		if (after?.id === beliefId && before && before.id !== beliefId) {
			relation = "changes";
			db.prepare(
				"UPDATE belief_evidence SET relation = 'changes' WHERE stm_fact_id = ? AND belief_id = ? AND sign = 1",
			).run(f.id, beliefId);
			touched.push({ beliefId: before.id, how: "changes" });
		}
	}
	db.prepare("UPDATE stm_facts SET state = 'merged', merged_at = ?, belief_id = ? WHERE id = ?").run(
		at,
		beliefId,
		f.id,
	);
	return { beliefId, relation, touched };
}

/**
 * `/facts correct <id> <text>`: the owner's statement of the right value, the
 * strongest evidence. It supports the corrected value from today (an explicit
 * correction wins its date, plan 0.013 decision 1); for a single-valued key the
 * timeline then closes what was current, its history kept; for others the old
 * value is contradicted. A correction to the value already current confirms it.
 */
export function correctBelief(
	db: Db,
	beliefId: string,
	text: string,
	o: MergeOptions,
): { newId: string; old: Belief; already: boolean } | string {
	const old = getBelief(db, beliefId);
	if (!old) return "no such belief";
	const object = text.trim().slice(0, 200);
	if (!object) return "give the right value: /facts correct <id> <text>";
	const today = o.now.toISOString().slice(0, 10);
	return db.transaction(() => {
		const norm = normalizeTerm(object);
		const row = (sign: 1 | -1, relation: Relation, effectiveAt: string | null) => ({
			stmFactId: null,
			source: "owner",
			scope: "owner",
			eventId: null,
			modality: "stated",
			sign,
			sourceP: 0.9,
			relation,
			// The same rules as extraction: an owner correction about health, money, an address… is private too.
			private: privateReason({ ...old, object, details: null, quote: object }, "") ? 1 : 0,
			effectiveAt,
			saidAt: o.now.toISOString(),
		});
		const single = SINGLE_VALUED.has(predicateOf(old.fact_key)) && old.negated === 0;
		const target = findBelief(db, old.fact_key, norm, 0);
		if (target && target.state === "current" && (target.id === old.id || single)) {
			// Already the value that holds: the owner's word confirms it, and moves nothing in time.
			addEvidence(db, target.id, row(1, "correction", null), o);
			return { newId: target.id, old, already: true };
		}
		const newId = target?.id ?? createBelief(db, { ...old, object, negated: 0, details: null, valid_from: today }, o);
		addEvidence(db, newId, row(1, "correction", today), o);
		if (single) rebuildTimeline(db, old.fact_key, today);
		else if (newId !== old.id) addEvidence(db, old.id, row(-1, "correction", null), o);
		return { newId, old, already: false };
	})();
}

/**
 * `/facts confirm <id>`: the owner says the belief is right, the strongest
 * evidence (the same weight as a correction that repeats the value). A
 * repeat confirmation adds nothing: the owner is one source. It confirms the
 * value; it does not move when it held.
 */
export function confirmBelief(db: Db, beliefId: string, o: MergeOptions): Belief | string {
	const b = getBelief(db, beliefId);
	if (!b) return "no such belief";
	db.transaction(() =>
		addEvidence(
			db,
			b.id,
			{
				stmFactId: null,
				source: "owner",
				scope: "owner",
				eventId: null,
				modality: "stated",
				sign: 1,
				sourceP: 0.9,
				relation: "correction",
				private: privateReason({ ...b, quote: b.object }, "") ? 1 : 0,
				effectiveAt: null,
				saidAt: o.now.toISOString(),
			},
			o,
		),
	)();
	return getBelief(db, b.id)!;
}

// ------------------------------------------------------------------ timelines (plan 0.013 E1)

export interface Interval {
	belief_id: string;
	seq: number;
	valid_from: string;
	valid_to: string | null;
	opened_by: string | null;
	closed_by: string | null;
	approximate: number;
}

/** A plain value of a key: not a negation, not a comparison or an estimate. Only these take turns in time. */
function plainValue(b: Pick<Belief, "negated" | "object_norm" | "details">): boolean {
	return b.negated === 0 && !approximate(b.object_norm) && !approximate(normalizeTerm(b.details ?? ""));
}

/** The plain value of a single-valued key that holds now, if any. */
export function currentOf(db: Db, key: string): Belief | null {
	return (
		(db
			.prepare(
				`SELECT b.* FROM beliefs b JOIN belief_intervals i ON i.belief_id = b.id
				 WHERE b.fact_key = ? AND i.valid_to IS NULL LIMIT 1`,
			)
			.get(key) as Belief | undefined) ?? null
	);
}

export function intervalsOf(db: Db, beliefId: string): Interval[] {
	return db.prepare("SELECT * FROM belief_intervals WHERE belief_id = ? ORDER BY seq").all(beliefId) as Interval[];
}

/**
 * Derive the date ranges of a single-valued key's plain values from their
 * supporting evidence (plan 0.013 E1). Deterministic and idempotent: the
 * merge, corrections, deletions, `/forget` and the backfill all call it, and
 * running it twice changes nothing.
 *
 * Transitions are ordered by the date each one says its value held from; for
 * the same date (owner decision 1) an explicit owner correction comes last
 * (it wins), then the later `said_at`, then the evidence id. A transition to
 * another value closes the current range and opens one, so a report placed at
 * an older date keeps every later transition, and the latest date decides
 * what holds now. A transition to the value already current corroborates.
 * Iyye's own cited words open a range only when no value holds at that date.
 * Ranges that open and close on the same day (a same-date loser) are not
 * kept: that value never held, and `/facts` shows it as a conflict.
 */
export function rebuildTimeline(db: Db, key: string, today = new Date().toISOString().slice(0, 10)): void {
	if (!SINGLE_VALUED.has(predicateOf(key))) return;
	const beliefs = (db.prepare("SELECT * FROM beliefs WHERE fact_key = ?").all(key) as Belief[]).filter(plainValue);
	const ids = beliefs.map((b) => b.id);
	db.prepare(`DELETE FROM belief_intervals WHERE belief_id IN (SELECT id FROM beliefs WHERE fact_key = ?)`).run(key);
	if (ids.length === 0) return;
	const steps = (
		db
			.prepare(
				`SELECT * FROM belief_evidence WHERE belief_id IN (${ids.map(() => "?").join(", ")})
				 AND sign = 1 AND effective_at IS NOT NULL AND NOT (modality = 'told_by_iyye' AND weight = 0)`,
			)
			.all(...ids) as Evidence[]
	)
		// A date still to come (a planned move) does not hold yet; the nightly rebuild lets it in on its day.
		.filter((e) => e.effective_at!.slice(0, 10) <= today)
		.sort(
			(a, b) =>
				a.effective_at!.localeCompare(b.effective_at!) ||
				Number(isCorrection(a)) - Number(isCorrection(b)) ||
				(a.said_at ?? a.at).localeCompare(b.said_at ?? b.at) ||
				a.id.localeCompare(b.id),
		);
	const ranges: Omit<Interval, "seq">[] = [];
	let open = null as Omit<Interval, "seq"> | null;
	for (const e of steps) {
		if (open?.belief_id === e.belief_id) continue;
		if (open && e.modality === "told_by_iyye") continue; // Iyye's word never replaces a value someone gave
		const day = e.effective_at!.slice(0, 10);
		if (open) {
			open.valid_to = day;
			open.closed_by = e.belief_id;
		}
		open = {
			belief_id: e.belief_id,
			valid_from: day,
			valid_to: null,
			opened_by: e.id,
			closed_by: null,
			approximate: e.effective_known === 0 ? 1 : 0,
		};
		ranges.push(open);
	}
	const kept = ranges.filter((r) => r.valid_to === null || r.valid_to > r.valid_from);
	const insert = db.prepare(
		"INSERT INTO belief_intervals (belief_id, seq, valid_from, valid_to, opened_by, closed_by, approximate) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const seq = new Map<string, number>();
	for (const r of kept) {
		const n = (seq.get(r.belief_id) ?? 0) + 1;
		seq.set(r.belief_id, n);
		insert.run(r.belief_id, n, r.valid_from, r.valid_to, r.opened_by, r.closed_by, r.approximate);
	}
	// The cache on `beliefs`: the latest range; a value that never held is closed on its first date.
	const update = db.prepare("UPDATE beliefs SET state = ?, valid_from = ?, valid_to = ?, closed_by = ? WHERE id = ?");
	for (const b of beliefs) {
		const mine = kept.filter((r) => r.belief_id === b.id);
		const last = mine.at(-1);
		if (last)
			update.run(
				last.valid_to === null ? "current" : "closed",
				last.valid_from,
				last.valid_to,
				last.closed_by,
				b.id,
			);
		else {
			const first = steps.find((e) => e.belief_id === b.id)?.effective_at?.slice(0, 10);
			if (first)
				// It never held: a same-date value that lost the tie (shown as a conflict, labelled in recall).
				update.run(
					"closed",
					first,
					first,
					ranges.find((r) => r.valid_from === first && r.belief_id !== b.id)?.belief_id ?? null,
					b.id,
				);
			else {
				// Only dates still to come (or none): planned, not holding; `valid_from` says from when.
				const planned = (
					db
						.prepare(
							"SELECT min(effective_at) AS d FROM belief_evidence WHERE belief_id = ? AND sign = 1 AND effective_at IS NOT NULL",
						)
						.get(b.id) as { d: string | null }
				).d;
				update.run("closed", planned?.slice(0, 10) ?? b.valid_from, null, null, b.id);
			}
		}
	}
}

/** An explicit owner correction (`/facts correct`): it wins its date. */
function isCorrection(e: Pick<Evidence, "relation" | "stm_fact_id" | "source">): boolean {
	return e.relation === "correction" && e.stm_fact_id === null && e.source === "owner";
}

/**
 * Values of the same key that compete with this one where it held (owner decision 1: one current value does not
 * resolve a disagreement): supporting evidence for another plain value dated inside one of its ranges, or a
 * same-date value that lost the tie. For `/facts`.
 */
export function conflictsOf(db: Db, b: Belief): { belief: Belief; evidence: Evidence[] }[] {
	if (!SINGLE_VALUED.has(predicateOf(b.fact_key)) || !plainValue(b)) return [];
	const ranges = intervalsOf(db, b.id);
	if (ranges.length === 0) return [];
	const inside = (d: string) => ranges.some((r) => d >= r.valid_from && (r.valid_to === null || d < r.valid_to));
	const out: { belief: Belief; evidence: Evidence[] }[] = [];
	for (const o of db
		.prepare("SELECT * FROM beliefs WHERE fact_key = ? AND id <> ?")
		.all(b.fact_key, b.id) as Belief[]) {
		if (!plainValue(o)) continue;
		const ev = evidenceOf(db, o.id).filter(
			(e) =>
				e.sign > 0 &&
				e.effective_at &&
				!(e.modality === "told_by_iyye" && e.weight === 0) &&
				inside(e.effective_at.slice(0, 10)),
		);
		if (ev.length) out.push({ belief: o, evidence: ev });
	}
	return out;
}

/**
 * Plan 0.013 E3's audit, once: Iyye's words stored as cited before citations were traced to a tool result
 * become uncited (their stored fact and their evidence, weight 0), and a belief they alone created goes, as
 * if they had never been cited (Iyye's uncited words create no belief). Nothing is merged again.
 */
export function auditUntracedCitations(db: Db, at: string): number {
	if (db.prepare("SELECT 1 FROM kv WHERE key = 'cited_relay_audit_v1'").get()) return 0;
	let n = 0;
	db.transaction(() => {
		const facts = (
			db
				.prepare(
					"SELECT id FROM stm_facts WHERE modality = 'told_by_iyye' AND cited IS NOT NULL AND tool_call_id IS NULL",
				)
				.all() as { id: string }[]
		).map((r) => r.id);
		n = facts.length;
		const touched = new Set<string>();
		for (const id of facts) {
			db.prepare("UPDATE stm_facts SET cited = NULL, p = 0.4 WHERE id = ?").run(id);
			for (const r of db
				.prepare("SELECT belief_id FROM belief_evidence WHERE stm_fact_id = ? AND weight > 0")
				.all(id) as {
				belief_id: string;
			}[])
				touched.add(r.belief_id);
			db.prepare("UPDATE belief_evidence SET weight = 0 WHERE stm_fact_id = ?").run(id);
		}
		const keys = new Set<string>();
		for (const b of touched) {
			const belief = getBelief(db, b);
			if (!belief) continue;
			keys.add(belief.fact_key);
			const holds = db.prepare("SELECT 1 FROM belief_evidence WHERE belief_id = ? AND weight > 0 LIMIT 1").get(b);
			if (!holds) db.prepare("DELETE FROM beliefs WHERE id = ?").run(b);
			else recompute(db, b, at);
		}
		for (const k of keys) rebuildTimeline(db, k, at.slice(0, 10));
		db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('cited_relay_audit_v1', ?, ?)").run(String(n), at);
	})();
	return n;
}

/** Every single-valued key's timeline as of `today` (the night: planned dates that arrived now hold). */
export function rebuildAllTimelines(db: Db, today: string): number {
	const keys = (db.prepare("SELECT DISTINCT fact_key FROM beliefs").all() as { fact_key: string }[])
		.map((r) => r.fact_key)
		.filter((k) => SINGLE_VALUED.has(predicateOf(k)));
	db.transaction(() => {
		for (const k of keys) rebuildTimeline(db, k, today);
	})();
	return keys.length;
}

/** Plan 0.013 E1's backfill: every single-valued key's timeline, once (restartable: it only rebuilds). */
export function ensureBeliefTimelines(db: Db, at: string): number {
	if (db.prepare("SELECT 1 FROM kv WHERE key = 'belief_timelines_v1'").get()) return 0;
	const keys = (db.prepare("SELECT DISTINCT fact_key FROM beliefs").all() as { fact_key: string }[]).map(
		(r) => r.fact_key,
	);
	let n = 0;
	db.transaction(() => {
		for (const k of keys)
			if (SINGLE_VALUED.has(predicateOf(k))) {
				rebuildTimeline(db, k, at.slice(0, 10));
				n++;
			}
		db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('belief_timelines_v1', ?, ?)").run(String(n), at);
	})();
	return n;
}

/**
 * `/facts wrong <id>` (owner decision 2): delete the belief outright with its
 * history, and suppress its value so the evidence said so far cannot re-create
 * it. Returns the structured facts behind it (their stored text goes too).
 */
export function deleteBelief(
	db: Db,
	beliefId: string,
	by: string,
	at: string,
): { scope: string; stmFactId: string }[] | string {
	const b = getBelief(db, beliefId);
	if (!b) return "no such belief";
	return db.transaction(() => {
		const facts = db
			.prepare(
				"SELECT scope, stm_fact_id FROM belief_evidence WHERE belief_id = ? AND stm_fact_id IS NOT NULL AND sign = 1",
			)
			.all(beliefId) as { scope: string; stm_fact_id: string }[];
		db.prepare(
			`INSERT INTO belief_suppressions (fact_key, object_norm, negated, until_at, by) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (fact_key, object_norm, negated) DO UPDATE SET until_at = excluded.until_at, by = excluded.by`,
		).run(b.fact_key, b.object_norm, b.negated, at, by);
		db.prepare("UPDATE beliefs SET closed_by = NULL WHERE closed_by = ?").run(beliefId);
		db.prepare("DELETE FROM beliefs WHERE id = ?").run(beliefId); // its evidence and ranges go with it (cascade)
		rebuildTimeline(db, b.fact_key, at.slice(0, 10)); // what it had closed may hold again
		return facts.map((f) => ({ scope: f.scope, stmFactId: f.stm_fact_id }));
	})();
}

/**
 * `/forget` (plan §3.6): the person's evidence leaves every belief (p is
 * recomputed from what remains), beliefs about them go, and so does any belief
 * left with no evidence. Call inside the forget transaction.
 */
export function forgetBeliefs(db: Db, scopes: readonly string[], personIds: readonly string[], at: string): string[] {
	const marks = scopes.map(() => "?").join(", ");
	const ids = personIds.map(() => "?").join(", ");
	const refs = personIds.map((id) => `contact:${id}`);
	const touched = (
		db
			.prepare(`SELECT DISTINCT belief_id FROM belief_evidence WHERE scope IN (${marks}) OR source IN (${ids})`)
			.all(...scopes, ...personIds) as { belief_id: string }[]
	).map((r) => r.belief_id);
	const keys = (
		db
			.prepare(
				`SELECT DISTINCT b.fact_key FROM beliefs b JOIN belief_evidence e ON e.belief_id = b.id
				 WHERE e.scope IN (${marks}) OR e.source IN (${ids})`,
			)
			.all(...scopes, ...personIds) as { fact_key: string }[]
	).map((r) => r.fact_key);
	db.prepare(`DELETE FROM belief_evidence WHERE scope IN (${marks}) OR source IN (${ids})`).run(
		...scopes,
		...personIds,
	);
	const about = (
		db.prepare(`SELECT id FROM beliefs WHERE subject_ref IN (${refs.map(() => "?").join(", ")})`).all(...refs) as {
			id: string;
		}[]
	).map((r) => r.id);
	db.prepare(`DELETE FROM beliefs WHERE subject_ref IN (${refs.map(() => "?").join(", ")})`).run(...refs);
	for (const id of touched) recompute(db, id, at);
	// Their words placed values in time too: the ranges are rebuilt from the evidence that remains (plan 0.013 E1).
	for (const k of keys) rebuildTimeline(db, k, at.slice(0, 10));
	// Every belief their words shaped or that was about them: what quotes it elsewhere must go too.
	return [...new Set([...touched, ...about])];
}

/**
 * Remove the evidence these facts gave (`/forget`: facts of Iyye's stored replies that named the person,
 * owner decision 2026-10-19) and recompute what it touched. Returns the beliefs touched.
 */
export function forgetEvidenceOf(db: Db, stmFactIds: readonly string[], at: string): string[] {
	if (stmFactIds.length === 0) return [];
	const marks = stmFactIds.map(() => "?").join(", ");
	const touched = db
		.prepare(
			`SELECT DISTINCT e.belief_id, b.fact_key FROM belief_evidence e JOIN beliefs b ON b.id = e.belief_id
			 WHERE e.stm_fact_id IN (${marks})`,
		)
		.all(...stmFactIds) as { belief_id: string; fact_key: string }[];
	db.prepare(`DELETE FROM belief_evidence WHERE stm_fact_id IN (${marks})`).run(...stmFactIds);
	for (const t of touched) recompute(db, t.belief_id, at);
	for (const k of new Set(touched.map((t) => t.fact_key))) rebuildTimeline(db, k, at.slice(0, 10));
	return touched.map((t) => t.belief_id);
}

/** `/facts <words>`: beliefs whose subject, predicate or value mention the words, with their evidence (owner only). */
export function searchBeliefs(db: Db, words: string, limit = 10): Belief[] {
	const terms = words
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length >= 2)
		.slice(0, 6);
	if (terms.length === 0) return [];
	const where = terms
		.map(() => "lower(subject || ' ' || predicate || ' ' || object || ' ' || fact_key) LIKE ?")
		.join(" AND ");
	return db
		.prepare(`SELECT * FROM beliefs WHERE ${where} ORDER BY state = 'current' DESC, p DESC, updated_at DESC LIMIT ?`)
		.all(...terms.map((t) => `%${t}%`), limit) as Belief[];
}

export function evidenceOf(db: Db, beliefId: string): Evidence[] {
	return db.prepare("SELECT * FROM belief_evidence WHERE belief_id = ? ORDER BY at").all(beliefId) as Evidence[];
}
