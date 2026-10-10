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
import { IYYE_SCOPE } from "../state/stm.ts";
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

/** Words that say nothing about what a belief is about (English, Russian, and the rewrite's "the user"). */
const STOPWORDS = new Set(
	(
		"the a an and or but not no yes you your yours he him his she her hers it its we us our they them their this that these those " +
		"what which who whom whose when where why how did does do done is are was were be been being have has had can could would " +
		"should will shall may might must about with from for into onto over under than then there here some any all each every " +
		"tell told say said know knew remember think thought please also just only very much many more most user owner iyye " +
		"что как где когда кто чей чья почему зачем это эта этот эти тот та те его её их мой моя моё мои твой твоя наш наша ваш " +
		"был была было были есть быть мне меня мной тебе ты вы он она они оно для или если тоже уже только ещё еще про скажи сказал помнишь знаешь"
	).split(" "),
);

/** The content words of a text as stems (stopwords out), the way recall matches them. */
export function contentStems(text: string): string[] {
	const words = (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOPWORDS.has(w));
	return [...new Set(words.map((w) => w.slice(0, Math.max(3, w.length - 2))))].slice(0, 24);
}

/** The lexical query for beliefs: content words only (stems as prefixes, OR-ed); null when there are none. */
export function beliefQuery(text: string): string | null {
	const stems = contentStems(text);
	return stems.length ? stems.map((s) => `"${s}"*`).join(" OR ") : null;
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
	// Privacy first, whoever reads: a private belief reaches only its speakers (2026-10-10 review: an untrusted
	// reader was shown a private belief through its personless evidence, a trusted one was not).
	let visible: Evidence[];
	if (isPrivate(db, b)) visible = own;
	else if (!reader.trusted) visible = [...own, ...personless];
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
	// Plan 0.013 E1: a value that never held (a same-date value that lost) is disputed, not past history; a
	// value from a date still to come is planned, not holding.
	const today = now.toISOString().slice(0, 10);
	const validity =
		b.state !== "closed"
			? ""
			: b.valid_to && b.valid_to === b.valid_from
				? " (disputed: another value was given for the same time)"
				: b.valid_to
					? ` (until ${b.valid_to})`
					: b.valid_from > today
						? ` (from ${b.valid_from}, not yet)`
						: "";
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
	const q = beliefQuery(query);
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
