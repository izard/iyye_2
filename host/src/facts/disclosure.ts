// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Beliefs in recall, and who may be told them (plan 0.011 F4, §3.6; owner
 * decision 1, revised 2026-10-07).
 *
 * - **The owner** sees every belief with all its evidence.
 * - **A trusted contact** may be told what Iyye has internalised from other
 *   people, as the belief sentence with its provenance ("Julia said, 3 days
 *   ago"), never anyone's words: unless the belief is private.
 * - **An untrusted contact** sees only beliefs it is a source of, and beliefs
 *   with evidence tied to no person (a cited relay, a measurement).
 * - **Private** (any evidence private by the host's rules, or the owner's
 *   `/facts private`; `/facts share` lifts it): only the person who said it,
 *   and the owner.
 * - Iyye's own records (`iyye-self`, scope `iyye`) stay owner-only.
 * - Only beliefs at or above `minP` are offered; the rest stay visible in
 *   `/facts`.
 */

import { getContact, OWNER_CONTACT_ID } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { IYYE_SCOPE, stmQuery } from "../state/stm.ts";
import { type Belief, type Evidence, evidenceOf, getBelief } from "./beliefs.ts";
import { factSentence } from "./extract.ts";

export interface BeliefReader {
	principal: "owner" | "contact";
	/** The reader's person id ("owner" for the owner). */
	personId: string;
	/** The reader's own scopes (its own, and its linked accounts'). */
	ownScopes: readonly string[];
	trusted: boolean;
}

export interface OfferedBelief {
	belief: Belief;
	/** The evidence this reader may be told about (provenance). */
	evidence: Evidence[];
	text: string;
	when: string;
}

/** True when the belief reaches only its speakers and the owner. */
export function isPrivate(db: Db, b: Pick<Belief, "id" | "disclosure">): boolean {
	if (b.disclosure === "share") return false;
	if (b.disclosure === "private") return true;
	return Boolean(db.prepare("SELECT 1 FROM belief_evidence WHERE belief_id = ? AND private = 1 LIMIT 1").get(b.id));
}

/** The supporting evidence this reader may see, or null when the belief is not for them. */
export function visibleEvidence(db: Db, b: Belief, reader: BeliefReader): Evidence[] | null {
	// Supporting evidence; Iyye's own echoes (weight 0) are not provenance.
	const rows = evidenceOf(db, b.id).filter((e) => e.sign > 0 && !(e.source === "iyye" && e.weight === 0));
	if (reader.principal === "owner") return rows.length ? rows : null;
	const outward = rows.filter((e) => e.scope !== IYYE_SCOPE); // Iyye's own records are the owner's
	const own = outward.filter((e) => e.source === reader.personId || reader.ownScopes.includes(e.scope));
	// Tied to no person: a cited relay that created the belief, a measurement.
	const personless = outward.filter((e) => (e.source === "iyye" && e.weight > 0) || e.source === "probe");
	let visible: Evidence[];
	if (!reader.trusted) visible = [...own, ...personless];
	else if (isPrivate(db, b)) visible = own;
	else visible = outward;
	const seen = new Set<string>();
	visible = visible.filter((e) => !seen.has(e.id) && seen.add(e.id));
	return visible.length ? visible : null;
}

const LABELS: [number, string][] = [
	[0.85, "very likely"],
	[0.7, "likely"],
	[0.5, "possibly"],
	[0, "uncertain"],
];

function ago(iso: string, now: Date): string {
	const days = Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
	return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

/** "[likely 0.85 · Julia said · 3 days ago] Julia plays the violin". */
export function beliefLine(db: Db, b: Belief, evidence: readonly Evidence[], reader: BeliefReader, now: Date): string {
	const label = LABELS.find(([min]) => b.p >= min)![1];
	const who = (e: Evidence) => {
		if (e.source === reader.personId && reader.principal === "contact") return "you said";
		if (e.source === OWNER_CONTACT_ID) return reader.principal === "owner" ? "you said" : "the owner said";
		if (e.source === "iyye") return "Iyye relayed a source";
		if (e.source === "probe") return "measured";
		return `${getContact(db, e.source)?.display_name ?? "someone"} said`;
	};
	const sources = [...new Set(evidence.map(who))].slice(0, 3).join(", ");
	const latest = evidence.reduce((x, e) => (e.at > x ? e.at : x), evidence[0]!.at);
	const validity = b.state === "closed" && b.valid_to ? ` (until ${b.valid_to})` : "";
	return `[${label} ${b.p.toFixed(2)} · ${sources} · ${ago(latest, now)}] ${factSentence({ ...b, negated: b.negated === 1 })}${validity}`;
}

/**
 * Beliefs for a turn: matching the query (and any `extraIds`, e.g. found by
 * Hindsight through their stored sentences), at or above `minP`, filtered for
 * the reader. Marks what was offered (`recalled_at`).
 */
export function offerBeliefs(
	db: Db,
	reader: BeliefReader,
	query: string,
	o: { minP: number; limit: number; now: Date; extraIds?: readonly string[] },
): OfferedBelief[] {
	const q = stmQuery(query);
	const ids = new Set<string>(o.extraIds ?? []);
	if (q) {
		for (const r of db
			.prepare("SELECT belief_id FROM beliefs_fts WHERE beliefs_fts MATCH ? ORDER BY bm25(beliefs_fts) LIMIT 20")
			.all(q) as { belief_id: string }[])
			ids.add(r.belief_id);
	}
	const out: OfferedBelief[] = [];
	for (const id of ids) {
		const b = getBelief(db, id);
		if (!b || b.p < o.minP) continue;
		const evidence = visibleEvidence(db, b, reader);
		if (!evidence) continue;
		out.push({ belief: b, evidence, text: beliefLine(db, b, evidence, reader, o.now), when: b.updated_at });
		if (out.length >= o.limit) break;
	}
	const at = o.now.toISOString();
	for (const x of out) db.prepare("UPDATE beliefs SET recalled_at = ? WHERE id = ?").run(at, x.belief.id);
	return out;
}
