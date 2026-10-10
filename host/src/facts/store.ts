// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Today's structured facts (plan 0.011 F1): which documents still need
 * extraction, writing what was kept, searching it for recall, and
 * forgetting it.
 *
 * - **Documents** of an STM entry: the person's words (`<event>:said`), Iyye's
 *   reply (`<event>:replied`), or Iyye's own finding (`<entry>:found`). The
 *   work list is `stm_episodes` itself: a document with no
 *   `fact_extractions` row is still to do.
 * - **Which entries:** turns and `/remember` (both documents), self-model
 *   changes and repository findings. Not machine findings (passing states),
 *   not day summaries, not investigation answers: those are Iyye's own words,
 *   and a self-authored narration is never evidence (HLD §11.2).
 * - **Written at once, checked at write time:** a `/forget` may land between
 *   a turn and its extraction, so the tombstone and the entry itself are
 *   checked in the transaction that stores the facts.
 */

import { getContact, OWNER_CONTACT_ID, resolvePerson } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { getEvent } from "../state/events.ts";
import { isInvestigationEntry } from "../state/observations.ts";
import { IYYE_SCOPE, type StmEpisode, stmQuery } from "../state/stm.ts";
import { isForgotten } from "../state/tombstones.ts";
import { conflictsOf, getBelief } from "./beliefs.ts";
import { type DocTool, type ExtractedFact, type ExtractionDoc, factSentence, type KnownPerson } from "./extract.ts";

export interface FactDoc {
	docId: string;
	episode: StmEpisode;
	doc: ExtractionDoc;
}

export interface StmFact {
	id: string;
	doc_id: string;
	event_id: string;
	scope: string;
	modality: ExtractedFact["modality"];
	source: string;
	subject: string;
	subject_ref: string;
	predicate: string;
	object: string;
	details: string | null;
	valid_from: string;
	time_frame: string;
	hedged: number;
	negated: number;
	quote: string;
	cited: string | null;
	fact_key: string;
	p: number;
	said_at: string;
	created_at: string;
	state: "day" | "merged" | "dropped";
	merged_at: string | null;
	belief_id: string | null;
	/** 1 when the host's rules made it private (plan §3.6). */
	private: number;
}

/** The people facts may name: persons, never accounts (an account linked to the owner is the owner). */
export function knownPeople(db: Db): KnownPerson[] {
	return (
		db
			.prepare(
				"SELECT id, display_name, kind FROM contacts WHERE id NOT IN (SELECT account_id FROM contact_links) ORDER BY created_at",
			)
			.all() as { id: string; display_name: string; kind: string }[]
	).map((c) => ({
		id: c.kind === "owner" ? OWNER_CONTACT_ID : c.id,
		name: c.kind === "owner" ? "the owner" : c.display_name,
	}));
}

/**
 * Tools whose results observe the world (plan 0.013 E3). The clock is none of them (it supports no other
 * fact); memory, reminders, plans and messages are Iyye's own records.
 */
const OBSERVATION_TOOLS = [
	"web_search",
	"web_fetch",
	"system_status",
	"git_log",
	"git_show",
	"git_status",
	"read_file",
	"list_dir",
];
/** Another model's answer (owner decision 2): kept as provenance, never an observation. */
const MODEL_TOOLS = ["ask_thinking_model", "look_at_image"];

/** The successful tool results of a reply's own turn, by the event the host recorded with each call. */
function turnTools(db: Db, e: StmEpisode): DocTool[] {
	const tools = [...OBSERVATION_TOOLS, ...MODEL_TOOLS];
	const rows = db
		.prepare(
			`SELECT id, tool, result FROM tool_calls WHERE event_id = ? AND outcome = 'ok' AND result IS NOT NULL
			 AND tool IN (${tools.map(() => "?").join(", ")}) ORDER BY started_at, rowid LIMIT 8`,
		)
		.all(e.event_id, ...tools) as { id: string; tool: string; result: string }[];
	return rows.map((r, i) => ({
		ref: i + 1,
		id: r.id,
		tool: r.tool,
		observes: OBSERVATION_TOOLS.includes(r.tool),
		text: r.result,
	}));
}

/** The documents of one STM entry that facts are extracted from (none for entries that are not evidence). */
export function docsFor(db: Db, e: StmEpisode): FactDoc[] {
	if (e.kind === "summary") return [];
	if (e.kind === "observation") {
		if (isInvestigationEntry(db, e.event_id)) return [];
		if (!e.event_id.startsWith("self:")) {
			const id = e.event_id.startsWith("obs:") ? e.event_id.slice(4) : e.event_id;
			const row = db.prepare("SELECT domain FROM observations WHERE id = ?").get(id) as
				| { domain: string }
				| undefined;
			if (!row || row.domain === "machine") return [];
		}
		return [
			{
				docId: `${e.event_id}:found`,
				episode: e,
				doc: { kind: "finding", text: e.user_text, speaker: "Iyye's probe", speakerId: null, at: e.said_at },
			},
		];
	}
	const who = speakerOf(db, e);
	const out: FactDoc[] = [
		{ docId: `${e.event_id}:said`, episode: e, doc: { kind: "person", text: e.user_text, ...who, at: e.said_at } },
	];
	if (e.kind === "turn" && e.reply_text.trim())
		out.push({
			docId: `${e.event_id}:replied`,
			episode: e,
			doc: {
				kind: "reply",
				text: e.reply_text,
				speaker: "Iyye",
				speakerId: null,
				recipient: who.speaker,
				asked: e.user_text,
				at: e.answered_at ?? e.said_at,
				tools: turnTools(db, e),
			},
		});
	return out;
}

function speakerOf(db: Db, e: StmEpisode): { speaker: string; speakerId: string } {
	if (e.scope === "owner" || !e.contact_id) return { speaker: "the owner", speakerId: OWNER_CONTACT_ID };
	const account = getContact(db, e.contact_id);
	const person = account ? resolvePerson(db, account) : null;
	if (!person || person.kind === "owner" || person.id === OWNER_CONTACT_ID)
		return { speaker: "the owner", speakerId: OWNER_CONTACT_ID };
	return { speaker: person.display_name, speakerId: person.id };
}

/** Documents still to extract, oldest first, from entries in the given states. */
export function pendingDocs(db: Db, states: readonly ("day" | "backlog")[], limit = 20): FactDoc[] {
	const marks = states.map(() => "?").join(", ");
	const episodes = db
		.prepare(`SELECT * FROM stm_episodes WHERE state IN (${marks}) AND scope != ? ORDER BY said_at, rowid LIMIT 500`)
		.all(...states, "owner-console") as StmEpisode[];
	const done = db.prepare("SELECT 1 FROM fact_extractions WHERE doc_id = ? AND status != 'failed'");
	const failed = db.prepare("SELECT attempts FROM fact_extractions WHERE doc_id = ? AND status = 'failed'");
	const out: FactDoc[] = [];
	for (const e of episodes) {
		for (const d of docsFor(db, e)) {
			if (done.get(d.docId)) continue;
			const f = failed.get(d.docId) as { attempts: number } | undefined;
			if (f && f.attempts >= MAX_ATTEMPTS) continue;
			out.push(d);
			if (out.length >= limit) return out;
		}
	}
	return out;
}

export const MAX_ATTEMPTS = 3;

/** True when the entry still exists and nothing forgot it since it was said. */
function stillRemembered(db: Db, e: StmEpisode): boolean {
	const row = db.prepare("SELECT state FROM stm_episodes WHERE event_id = ?").get(e.event_id) as
		| { state: string }
		| undefined;
	if (!row || (row.state !== "day" && row.state !== "backlog")) return false;
	if (e.scope === IYYE_SCOPE) return true;
	const receivedAt = getEvent(db, e.event_id)?.received_at ?? e.said_at;
	return !isForgotten(db, e.scope, receivedAt);
}

/**
 * Store one document's result in one transaction: its kept facts (searchable
 * at once) and its extraction row. Nothing is stored when the entry was
 * forgotten or left short-term memory meanwhile; returns how many facts went in.
 */
export function recordExtraction(
	db: Db,
	d: FactDoc,
	r: {
		kept: ExtractedFact[];
		dropped: Record<string, number>;
		badLines: number;
		model: string;
		deviceMs: number;
		at: string;
		newId: () => string;
	},
): number {
	return db.transaction(() => {
		if (!stillRemembered(db, d.episode)) {
			db.prepare(
				`INSERT OR REPLACE INTO fact_extractions (doc_id, event_id, scope, kind, status, model, error, at)
				 VALUES (?, ?, ?, ?, 'skipped', ?, 'forgotten or no longer in short-term memory', ?)`,
			).run(d.docId, d.episode.event_id, d.episode.scope, d.doc.kind, r.model, r.at);
			return 0;
		}
		const insert = db.prepare(
			`INSERT INTO stm_facts (id, doc_id, event_id, scope, modality, source, subject, subject_ref, predicate, object,
				details, valid_from, time_frame, hedged, negated, quote, cited, fact_key, p, said_at, created_at, private, tool_call_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const fts = db.prepare("INSERT INTO stm_facts_fts (fact_id, scope, body) VALUES (?, ?, ?)");
		for (const f of r.kept) {
			const id = r.newId();
			insert.run(
				id,
				d.docId,
				d.episode.event_id,
				d.episode.scope,
				f.modality,
				f.source,
				f.subject,
				f.subjectRef,
				f.predicate,
				f.object,
				f.details,
				f.validFrom,
				f.timeFrame,
				f.hedged ? 1 : 0,
				f.negated ? 1 : 0,
				f.quote,
				f.cited,
				f.key,
				f.p,
				d.doc.at,
				r.at,
				f.private ? 1 : 0,
				f.toolCallId,
			);
			fts.run(id, d.episode.scope, `${factSentence(f)}\n${f.quote}`);
		}
		db.prepare(
			`INSERT OR REPLACE INTO fact_extractions (doc_id, event_id, scope, kind, status, attempts, model, kept, dropped_json, bad_lines, device_ms, at)
			 VALUES (?, ?, ?, ?, 'done', coalesce((SELECT attempts + 1 FROM fact_extractions WHERE doc_id = ?), 1), ?, ?, ?, ?, ?, ?)`,
		).run(
			d.docId,
			d.episode.event_id,
			d.episode.scope,
			d.doc.kind,
			d.docId,
			r.model,
			r.kept.length,
			JSON.stringify(r.dropped),
			r.badLines,
			r.deviceMs,
			r.at,
		);
		return r.kept.length;
	})();
}

/** A failed attempt (the model did not answer); after MAX_ATTEMPTS the document is left out. */
export function recordExtractionFailure(db: Db, d: FactDoc, model: string | null, error: string, at: string): void {
	db.prepare(
		`INSERT INTO fact_extractions (doc_id, event_id, scope, kind, status, attempts, model, error, at)
		 VALUES (?, ?, ?, ?, 'failed', 1, ?, ?, ?)
		 ON CONFLICT (doc_id) DO UPDATE SET attempts = attempts + 1, error = excluded.error, at = excluded.at, model = excluded.model
		 WHERE status = 'failed'`,
	).run(d.docId, d.episode.event_id, d.episode.scope, d.doc.kind, model, error.slice(0, 300), at);
}

/**
 * Today's facts in the given scopes, best match first: only while their entry
 * is in short-term memory (STM is today only), and not yet merged.
 */
export function searchFacts(db: Db, scopes: readonly string[], text: string, limit = 5): StmFact[] {
	const q = stmQuery(text);
	if (!q || scopes.length === 0) return [];
	const marks = scopes.map(() => "?").join(", ");
	return db
		.prepare(
			`SELECT s.* FROM stm_facts_fts f JOIN stm_facts s ON s.id = f.fact_id JOIN stm_episodes e ON e.event_id = s.event_id
			 WHERE stm_facts_fts MATCH ? AND f.scope IN (${marks}) AND s.scope IN (${marks}) AND s.state = 'day' AND e.state = 'day'
			 ORDER BY bm25(stm_facts_fts) LIMIT ?`,
		)
		.all(q, ...scopes, ...scopes, limit) as StmFact[];
}

/**
 * `/forget` (plan §3.6): the person's facts go, from their scopes and every
 * fact about them, with their extraction rows. Call inside the forget transaction.
 */
export function forgetFacts(
	db: Db,
	scopes: readonly string[],
	personIds: readonly string[],
	opts: { ownerReplies?: readonly string[] } = {},
): void {
	const marks = scopes.map(() => "?").join(", ");
	const refs = personIds.map((id) => `contact:${id}`);
	const refMarks = refs.map(() => "?").join(", ");
	const where = `scope IN (${marks}) OR subject_ref IN (${refMarks})`;
	db.prepare(`DELETE FROM stm_facts_fts WHERE fact_id IN (SELECT id FROM stm_facts WHERE ${where})`).run(
		...scopes,
		...refs,
	);
	db.prepare(`DELETE FROM stm_facts WHERE ${where}`).run(...scopes, ...refs);
	db.prepare(`DELETE FROM fact_extractions WHERE scope IN (${marks})`).run(...scopes);
	// Iyye's replies to the owner may quote the person: their facts go, like the replies' text.
	for (const id of opts.ownerReplies ?? []) {
		const doc = `${id}:replied`;
		db.prepare("DELETE FROM stm_facts_fts WHERE fact_id IN (SELECT id FROM stm_facts WHERE doc_id = ?)").run(doc);
		db.prepare("DELETE FROM stm_facts WHERE doc_id = ? AND state = 'day'").run(doc);
		db.prepare("UPDATE fact_extractions SET status = 'skipped', kept = 0, error = 'forgotten' WHERE doc_id = ?").run(
			doc,
		);
	}
}

/** `/facts`: today's extraction in numbers, and the latest facts. */
export function factsTodayReport(db: Db, limit = 12): string {
	const ex = db
		.prepare(
			"SELECT kind, status, count(*) AS n, sum(kept) AS kept, sum(device_ms) AS ms FROM fact_extractions GROUP BY kind, status ORDER BY kind, status",
		)
		.all() as { kind: string; status: string; n: number; kept: number; ms: number | null }[];
	const drops = new Map<string, number>();
	for (const r of db.prepare("SELECT dropped_json FROM fact_extractions WHERE status = 'done'").all() as {
		dropped_json: string;
	}[]) {
		for (const [why, n] of Object.entries(JSON.parse(r.dropped_json) as Record<string, number>))
			drops.set(why, (drops.get(why) ?? 0) + n);
	}
	const facts = db
		.prepare("SELECT * FROM stm_facts WHERE state = 'day' ORDER BY created_at DESC LIMIT ?")
		.all(limit) as StmFact[];
	const pending = pendingDocs(db, ["day"], 1000).length;
	return [
		`facts extracted during the day (plan 0.011): ${pending} document(s) waiting`,
		...ex.map(
			(r) =>
				`  ${r.kind} ${r.status}: ${r.n} document(s)${r.status === "done" ? `, ${r.kept ?? 0} fact(s) kept` : ""}${r.ms ? `, ${Math.round(r.ms / 1000)} s device time` : ""}`,
		),
		...(drops.size ? [`  dropped: ${[...drops].map(([w, n]) => `${w} ${n}`).join("; ")}`] : []),
		facts.length ? "today's latest facts:" : "no facts in short-term memory",
		...facts.map(
			(f) =>
				`  ${f.id.slice(0, 8)} [${f.modality}, ${f.source === OWNER_CONTACT_ID ? "owner" : f.source}, p ${f.p.toFixed(2)}] ${factSentence({ ...f, negated: f.negated === 1 })}`,
		),
	].join("\n");
}

/** The ledger's integrity figures (plan 0.013 E6): `/facts report` and the fixed integrity test. */
export interface FactsIntegrity {
	documents: { done: number; failed: number; givenUp: number; skipped: number };
	relays: { cited: number; uncited: number; citedUntraced: number };
	/** Single-valued keys with more than one value current: always 0. */
	keysWithTwoCurrent: number;
	/** Current values with competing evidence where they hold. */
	conflicts: number;
	beliefs: number;
}

export function factsIntegrity(db: Db): FactsIntegrity {
	const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;
	const docs = one<{ done: number; failed: number; given_up: number; skipped: number }>(
		`SELECT count(*) FILTER (WHERE status = 'done') AS done, count(*) FILTER (WHERE status = 'failed' AND attempts < ?) AS failed,
			count(*) FILTER (WHERE status = 'failed' AND attempts >= ?) AS given_up, count(*) FILTER (WHERE status = 'skipped') AS skipped
		 FROM fact_extractions`,
		MAX_ATTEMPTS,
		MAX_ATTEMPTS,
	);
	const relays = one<{ cited: number; uncited: number; untraced: number }>(
		`SELECT count(*) FILTER (WHERE cited IS NOT NULL) AS cited, count(*) FILTER (WHERE cited IS NULL) AS uncited,
			count(*) FILTER (WHERE cited IS NOT NULL AND tool_call_id IS NULL) AS untraced
		 FROM stm_facts WHERE modality = 'told_by_iyye'`,
	);
	const twoCurrent = one<{ n: number }>(
		`SELECT count(*) AS n FROM (SELECT b.fact_key FROM beliefs b JOIN belief_intervals i ON i.belief_id = b.id
		 WHERE i.valid_to IS NULL GROUP BY b.fact_key HAVING count(*) > 1)`,
	).n;
	const current = db.prepare("SELECT id FROM beliefs WHERE state = 'current'").all() as { id: string }[];
	const conflicts = current.filter((r) => {
		const b = getBelief(db, r.id);
		return b !== null && conflictsOf(db, b).length > 0;
	}).length;
	return {
		documents: {
			done: docs.done ?? 0,
			failed: docs.failed ?? 0,
			givenUp: docs.given_up ?? 0,
			skipped: docs.skipped ?? 0,
		},
		relays: { cited: relays.cited ?? 0, uncited: relays.uncited ?? 0, citedUntraced: relays.untraced ?? 0 },
		keysWithTwoCurrent: twoCurrent,
		conflicts,
		beliefs: one<{ n: number }>("SELECT count(*) AS n FROM beliefs").n,
	};
}

export function integrityReport(i: FactsIntegrity): string {
	return [
		"fact ledger integrity (plan 0.013):",
		`  documents: ${i.documents.done} done, ${i.documents.failed} failed (to retry), ${i.documents.givenUp} given up, ${i.documents.skipped} skipped (forgotten)`,
		`  Iyye's words: ${i.relays.cited} cited (traced to a tool result), ${i.relays.uncited} uncited${i.relays.citedUntraced ? `, ${i.relays.citedUntraced} cited but untraced (should be 0)` : ""}`,
		`  beliefs: ${i.beliefs}; current values with a conflict: ${i.conflicts}; keys with two current values: ${i.keysWithTwoCurrent}${i.keysWithTwoCurrent ? " (should be 0)" : ""}`,
	].join("\n");
}
