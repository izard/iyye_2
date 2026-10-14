// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The fact ledger's orphan check (plan 0.011 §5, "two stores drifting"):
 * SQLite holds each structured fact and its belief, Hindsight its stored text
 * (document `fact:<id>` in the bank of the fact's scope); the fact id links
 * them. Run at the end of the fact night, it compares the two and reports,
 * never repairs:
 *
 * - **missing:** a fact SQLite says was stored, with its belief still there
 *   (or none, for a suppressed value), whose document is not in its bank;
 * - **unknown:** a `fact:` document no stored fact accounts for (no such fact,
 *   never stored, or stored in another bank);
 * - **stale:** a document whose belief is gone (`/facts wrong`, `/forget`).
 *   Recall offers stored facts only as their beliefs, so it is inert, but its
 *   text is still there.
 *
 * Documents already queued for deletion and banks being forgotten are work
 * in progress, not orphans. The result is kept in `kv` for `/facts report`
 * and the wake check; nothing here calls a model.
 */

import { banksBeingForgotten } from "../memory/forget.ts";
import { bankFor } from "../memory/gateway.ts";
import type { HindsightClient } from "../memory/hindsight.ts";
import { HindsightError } from "../memory/hindsight.ts";
import type { Db } from "../state/db.ts";
import { getKv, setKv } from "../state/kv.ts";
import { factDocId, pendingFactDocDeletions, queueDocDeletions } from "./night.ts";

export const ORPHAN_CHECK_KEY = "facts.orphan_check";
/** Listed per kind in the record (the counts are complete). */
const SAMPLE = 20;
const PAGE = 200;

export interface OrphanRef {
	bank: string;
	doc: string;
}

export interface OrphanCheck {
	at: string;
	/** Stored facts SQLite expects in long-term memory, and `fact:` documents found there. */
	expected: number;
	found: number;
	counts: { missing: number; unknown: number; stale: number };
	missing: OrphanRef[];
	unknown: OrphanRef[];
	stale: OrphanRef[];
	/** Why the check could not finish (long-term memory unreachable); the counts are then not meaningful. */
	error?: string;
}

export async function checkFactOrphans(
	db: Db,
	ltm: Pick<HindsightClient, "listBanks" | "listDocuments">,
	at: string,
	/** How many of each kind are listed (the counts are always complete); `Infinity` for a repair. */
	sample = SAMPLE,
): Promise<OrphanCheck> {
	const out: OrphanCheck = {
		at,
		expected: 0,
		found: 0,
		counts: { missing: 0, unknown: 0, stale: 0 },
		missing: [],
		unknown: [],
		stale: [],
	};
	const note = (kind: "missing" | "unknown" | "stale", ref: OrphanRef) => {
		out.counts[kind]++;
		if (out[kind].length < sample) out[kind].push(ref);
	};
	const forgetting = banksBeingForgotten(db);
	const queued = new Set(pendingFactDocDeletions(db).map((q) => `${q.bank}/${q.doc}`));
	// SQLite's side: every stored fact, where it should be, and whether its belief still exists.
	const rows = db
		.prepare(
			`SELECT f.id, f.scope, f.belief_id IS NOT NULL AND b.id IS NULL AS dead
			 FROM stm_facts f LEFT JOIN beliefs b ON b.id = f.belief_id WHERE f.stored_at IS NOT NULL`,
		)
		.all() as { id: string; scope: string; dead: number }[];
	const facts = new Map<string, { bank: string; dead: boolean }>();
	for (const r of rows) {
		const bank = bankFor(r.scope);
		if (bank) facts.set(r.id, { bank, dead: r.dead === 1 });
	}
	let banks: string[];
	try {
		banks = await ltm.listBanks();
	} catch (err) {
		return { ...out, error: (err as Error).message };
	}
	// Hindsight's side: every `fact:` document of every bank not being forgotten.
	const seen = new Set<string>();
	for (const bank of banks) {
		if (forgetting.has(bank)) continue;
		for (let offset = 0; ; ) {
			let page: { items: { id: string }[]; total: number };
			try {
				page = await ltm.listDocuments(bank, { q: "fact:", limit: PAGE, offset });
			} catch (err) {
				if (err instanceof HindsightError && err.status === 404) break; // deleted meanwhile
				return { ...out, error: (err as Error).message };
			}
			for (const { id: doc } of page.items) {
				if (!doc.startsWith("fact:")) continue;
				out.found++;
				if (queued.has(`${bank}/${doc}`)) continue;
				const f = facts.get(doc.slice(5));
				if (!f || f.bank !== bank) note("unknown", { bank, doc });
				else if (f.dead) note("stale", { bank, doc });
				else seen.add(`${bank}/${doc}`);
			}
			offset += page.items.length;
			if (page.items.length === 0 || offset >= page.total) break;
		}
	}
	for (const [id, f] of facts) {
		if (f.dead || forgetting.has(f.bank)) continue;
		const ref = { bank: f.bank, doc: factDocId(id) };
		if (queued.has(`${ref.bank}/${ref.doc}`)) continue;
		out.expected++;
		if (!seen.has(`${ref.bank}/${ref.doc}`)) note("missing", ref);
	}
	return out;
}

export function saveOrphanCheck(db: Db, c: OrphanCheck): void {
	setKv(db, ORPHAN_CHECK_KEY, JSON.stringify(c), c.at);
}

export function lastOrphanCheck(db: Db): OrphanCheck | null {
	try {
		const v = JSON.parse(getKv(db, ORPHAN_CHECK_KEY) ?? "null") as OrphanCheck | null;
		return v && typeof v.at === "string" && v.counts ? v : null;
	} catch {
		return null;
	}
}

export const orphanTotal = (c: OrphanCheck) => c.counts.missing + c.counts.unknown + c.counts.stale;

/** The check as `/facts report` shows it. */
export function orphanReport(c: OrphanCheck | null): string {
	if (!c) return "  long-term memory check: not run yet (it runs at the end of each night's fact work)";
	const when = c.at.slice(0, 16).replace("T", " ");
	if (c.error) return `  long-term memory check (${when} UTC): could not finish: ${c.error}`;
	const head = `  long-term memory check (${when} UTC): ${c.expected} stored fact(s) expected, ${c.found} fact document(s) found`;
	if (orphanTotal(c) === 0) return `${head}; no orphans`;
	const list = (label: string, n: number, refs: OrphanRef[]) =>
		n
			? [
					`    ${label}: ${n}${n > refs.length ? ` (first ${refs.length})` : ""}`,
					...refs.map((r) => `      ${r.bank} ${r.doc}`),
				]
			: [];
	return [
		`${head}; orphans (should be 0):`,
		...list("stored in SQLite, missing in long-term memory", c.counts.missing, c.missing),
		...list("in long-term memory, no stored fact behind it", c.counts.unknown, c.unknown),
		...list("in long-term memory, its belief deleted (inert, text remains)", c.counts.stale, c.stale),
	].join("\n");
}

/**
 * `/facts orphans restore`: the stored facts whose text is missing are stored
 * again by the next night (the fact night stores every merged fact without
 * `stored_at`, verbatim, under its own document id). Returns how many.
 */
export function restoreMissing(db: Db, c: OrphanCheck): number {
	let n = 0;
	for (const r of c.missing) {
		n += db
			.prepare("UPDATE stm_facts SET stored_at = NULL WHERE id = ? AND stored_at IS NOT NULL AND state = 'merged'")
			.run(r.doc.slice(5)).changes;
	}
	return n;
}

/** `/facts orphans delete confirm`: unknown and stale documents join the deletion queue (done at the next chance). */
export function queueOrphanDeletions(db: Db, c: OrphanCheck, at: string): number {
	const refs = [...c.unknown, ...c.stale];
	queueDocDeletions(db, refs, at);
	return refs.length;
}
