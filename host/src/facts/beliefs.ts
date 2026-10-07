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
import { COMPARISON, logit, normalizeTerm, sigmoid } from "./extract.ts";
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
		`INSERT INTO belief_evidence (id, belief_id, stm_fact_id, source, scope, event_id, modality, sign, source_p, weight, relation, night, at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
	});
	const touched: MergeResult["touched"] = [];
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
		// A new value: what it contradicts or replaces among the beliefs of the same key.
		const others = db
			.prepare(
				"SELECT * FROM beliefs WHERE fact_key = ? AND state = 'current' AND NOT (object_norm = ? AND negated = ?)",
			)
			.all(f.fact_key, norm, f.negated) as Belief[];
		const single = SINGLE_VALUED.has(predicateOf(f.fact_key));
		// Iyye's own words never replace or contradict what someone else said (they only add weight-0 rows),
		// and a comparison or an estimate ("older than 10", "about 40") is no other value of the key.
		const replaces =
			single &&
			f.negated === 0 &&
			f.modality !== "told_by_iyye" &&
			!approximate(norm) &&
			!approximate(normalizeTerm(f.details ?? ""));
		const changed = replaces
			? others.filter((b) => b.negated === 0 && !approximate(b.object_norm) && b.valid_from < f.valid_from)
			: [];
		relation = changed.length ? "changes" : "new";
		beliefId = createBelief(db, f, o);
		addEvidence(db, beliefId, row(relation === "changes" ? "changes" : "new", 1), o);
		for (const b of others) {
			if (b.object_norm === norm) {
				// The same value, the other way round: "plays the violin" against "does not play the violin".
				addEvidence(db, b.id, row("contradicts", -1), o);
				touched.push({ beliefId: b.id, how: "contradicts" });
			} else if (changed.includes(b)) {
				db.prepare(
					"UPDATE beliefs SET state = 'closed', valid_to = ?, closed_by = ?, updated_at = ? WHERE id = ?",
				).run(f.valid_from, beliefId, at, b.id);
				touched.push({ beliefId: b.id, how: "changes" });
			} else if (replaces && b.negated === 0 && !approximate(b.object_norm)) {
				// Another value of a single-valued key said at the same time: one of them is wrong.
				addEvidence(db, b.id, row("contradicts", -1), o);
				touched.push({ beliefId: b.id, how: "contradicts" });
			}
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
 * strongest evidence. It creates (or supports) the corrected belief, and the
 * old one is closed (single-valued) or contradicted, its history kept.
 */
export function correctBelief(
	db: Db,
	beliefId: string,
	text: string,
	o: MergeOptions,
): { newId: string; old: Belief } | string {
	const old = getBelief(db, beliefId);
	if (!old) return "no such belief";
	const object = text.trim().slice(0, 200);
	if (!object) return "give the right value: /facts correct <id> <text>";
	return db.transaction(() => {
		const norm = normalizeTerm(object);
		const row = (sign: 1 | -1, relation: Relation) => ({
			stmFactId: null,
			source: "owner",
			scope: "owner",
			eventId: null,
			modality: "stated",
			sign,
			sourceP: 0.9,
			relation,
		});
		const target = findBelief(db, old.fact_key, norm, 0);
		if (target?.id === old.id) return { newId: old.id, old };
		const newId =
			target?.id ??
			createBelief(
				db,
				{ ...old, object, negated: 0, details: null, valid_from: o.now.toISOString().slice(0, 10) },
				o,
			);
		addEvidence(db, newId, row(1, "correction"), o);
		if (SINGLE_VALUED.has(predicateOf(old.fact_key)) && old.negated === 0)
			db.prepare(
				"UPDATE beliefs SET state = 'closed', valid_to = ?, closed_by = ?, updated_at = ? WHERE id = ?",
			).run(o.now.toISOString().slice(0, 10), newId, o.now.toISOString(), old.id);
		else addEvidence(db, old.id, row(-1, "correction"), o);
		return { newId, old };
	})();
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
		db.prepare("DELETE FROM beliefs WHERE id = ?").run(beliefId); // its evidence goes with it (cascade)
		return facts.map((f) => ({ scope: f.scope, stmFactId: f.stm_fact_id }));
	})();
}

/**
 * `/forget` (plan §3.6): the person's evidence leaves every belief (p is
 * recomputed from what remains), beliefs about them go, and so does any belief
 * left with no evidence. Call inside the forget transaction.
 */
export function forgetBeliefs(db: Db, scopes: readonly string[], personIds: readonly string[], at: string): void {
	const marks = scopes.map(() => "?").join(", ");
	const ids = personIds.map(() => "?").join(", ");
	const refs = personIds.map((id) => `contact:${id}`);
	const touched = (
		db
			.prepare(`SELECT DISTINCT belief_id FROM belief_evidence WHERE scope IN (${marks}) OR source IN (${ids})`)
			.all(...scopes, ...personIds) as { belief_id: string }[]
	).map((r) => r.belief_id);
	db.prepare(`DELETE FROM belief_evidence WHERE scope IN (${marks}) OR source IN (${ids})`).run(
		...scopes,
		...personIds,
	);
	db.prepare(`DELETE FROM beliefs WHERE subject_ref IN (${refs.map(() => "?").join(", ")})`).run(...refs);
	for (const id of touched) recompute(db, id, at);
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
