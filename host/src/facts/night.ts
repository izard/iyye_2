// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The fact ledger's night (plan 0.011 F2), run by the night before the
 * episodes' own transfer (which stays unchanged during the comparison week):
 *
 * 1. Delete the stored text of facts the owner removed (`/facts wrong`) or
 *    forgot, queued when they did.
 * 2. Extract what the day left, under the memory gate.
 * 3. Merge today's facts into beliefs, oldest first (`beliefs.ts`). Before a
 *    fact with no belief of its exact key is merged, the `fact_relation`
 *    shadow role (F3) is asked about its nearest stored beliefs; its answer is
 *    journaled and never read here.
 * 4. Store each merged fact in long-term memory, verbatim (no model call), as
 *    one structured sentence in the bank of the scope it came from (document
 *    `fact:<id>`), tagged `structured-fact`, its speaker and modality. A fact
 *    that could not be stored is retried on the next night.
 * 5. Compare the two stores (`orphans.ts`, plan §5): a stored fact whose text
 *    is missing, or a `fact:` document no stored fact accounts for, is
 *    reported (`/facts report`, the wake check), never repaired here.
 *
 * Hindsight remains storage and retrieval; the belief lives in SQLite.
 */

import type { FactRelation } from "../decisions/fact-relation.ts";
import type { Logger } from "../log.ts";
import { banksBeingForgotten, PENDING_BANKS_KEY, parseBanks } from "../memory/forget.ts";
import { bankFor } from "../memory/gateway.ts";
import { type HindsightClient, HindsightError, VERBATIM_STRATEGY } from "../memory/hindsight.ts";
import { OBSERVATIONS_MISSION, REPLY_MISSION, RETAIN_MISSION } from "../memory/night.ts";
import { SPEAKER_IYYE, SPEAKER_PERSON, SPEAKER_PROBE, STRUCTURED_TAG } from "../memory/provenance.ts";
import { getContact, OWNER_CONTACT_ID } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { getEvent } from "../state/events.ts";
import { getKv, setKv } from "../state/kv.ts";
import { IYYE_SCOPE } from "../state/stm.ts";
import { isForgotten } from "../state/tombstones.ts";
import { type Belief, getBelief, mergeFact, rebuildAllTimelines } from "./beliefs.ts";
import { factSentence } from "./extract.ts";
import { type Complete, extractPendingAtNight } from "./extractor.ts";
import { checkFactOrphans, orphanTotal, saveOrphanCheck } from "./orphans.ts";
import type { StmFact } from "./store.ts";

export { STRUCTURED_TAG };
const DOC_DELETIONS_KEY = "facts.documents_to_delete";

export const factDocId = (stmFactId: string) => `fact:${stmFactId}`;

/** Queue stored fact documents for deletion in long-term memory (done at the next chance). */
export function queueFactDocDeletions(
	db: Db,
	items: readonly { scope: string; stmFactId: string }[],
	at: string,
): void {
	const queued = pendingFactDocDeletions(db);
	for (const i of items) {
		const bank = bankFor(i.scope);
		if (bank) queued.push({ bank, doc: factDocId(i.stmFactId) });
	}
	setKv(db, DOC_DELETIONS_KEY, JSON.stringify(queued), at);
}

/** Queue documents by bank and id (the orphan repair: documents no stored fact accounts for). */
export function queueDocDeletions(db: Db, refs: readonly { bank: string; doc: string }[], at: string): void {
	const queued = pendingFactDocDeletions(db);
	const have = new Set(queued.map((q) => `${q.bank}/${q.doc}`));
	for (const r of refs) if (!have.has(`${r.bank}/${r.doc}`)) queued.push({ bank: r.bank, doc: r.doc });
	setKv(db, DOC_DELETIONS_KEY, JSON.stringify(queued), at);
}

export function pendingFactDocDeletions(db: Db): { bank: string; doc: string }[] {
	try {
		const v = JSON.parse(getKv(db, DOC_DELETIONS_KEY) ?? "[]") as unknown;
		return Array.isArray(v) ? (v as { bank: string; doc: string }[]) : [];
	} catch {
		return [];
	}
}

/** Delete what is queued; a 404 counts as done. Returns how many are left. */
export async function deleteQueuedFactDocs(
	db: Db,
	ltm: Pick<HindsightClient, "deleteDocument">,
	log: Logger,
): Promise<number> {
	const left: { bank: string; doc: string }[] = [];
	for (const q of pendingFactDocDeletions(db)) {
		try {
			await ltm.deleteDocument(q.bank, q.doc);
		} catch (err) {
			if (err instanceof HindsightError && err.status === 404) continue;
			log.warn("facts: deleting a stored fact failed; it stays queued", {
				bank: q.bank,
				error: (err as Error).message,
			});
			left.push(q);
		}
	}
	setKv(db, DOC_DELETIONS_KEY, JSON.stringify(left), new Date().toISOString());
	return left.length;
}

export interface FactNightDeps {
	db: Db;
	ltm: Pick<HindsightClient, "ensureBank" | "retain" | "recall" | "deleteDocument"> &
		Partial<Pick<HindsightClient, "listBanks" | "listDocuments">>;
	gate: {
		run<T>(
			label: string,
			fn: (model: string) => Promise<T>,
			opts?: { thinking?: boolean },
		): Promise<{ ok: true; value: T } | { ok: false; busy?: boolean; message: string }>;
	};
	complete: Complete;
	log: Logger;
	/** Extract what the day left (IYYE2_FACTS_EXTRACT). */
	extract: boolean;
	/** Merge into beliefs and store (IYYE2_FACTS_MERGE). */
	merge: boolean;
	maxStep: number;
	/** The F3 shadow role; null without the decision service. */
	relation?: Pick<FactRelation, "ask"> | null;
	now?: () => Date;
	newId?: () => string;
	busyRetryMs?: number;
}

export interface FactNightOutcome {
	extracted: number;
	merged: number;
	stored: number;
	/** "stopped" (owner input, waking), or why it could not go on; null when done. */
	stopped: string | null;
}

export class FactNight {
	private readonly d: Required<FactNightDeps>;
	private readonly banksReady = new Set<string>();

	constructor(deps: FactNightDeps) {
		this.d = {
			relation: null,
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			busyRetryMs: 2000,
			...deps,
		};
	}

	async run(shouldStop: () => boolean): Promise<FactNightOutcome> {
		const out: FactNightOutcome = { extracted: 0, merged: 0, stored: 0, stopped: null };
		this.banksReady.clear();
		try {
			await deleteQueuedFactDocs(this.d.db, this.d.ltm, this.d.log);
		} catch {
			// best effort: retried next night
		}
		if (this.d.extract) {
			const r = await extractPendingAtNight({
				db: this.d.db,
				log: this.d.log,
				gate: this.d.gate,
				complete: this.d.complete,
				shouldStop,
				now: this.d.now,
				newId: this.d.newId,
				busyRetryMs: this.d.busyRetryMs,
			});
			out.extracted = r.done;
			if (r.stopped) return { ...out, stopped: r.stopped };
		}
		if (!this.d.merge) return out;
		const night = this.d.now().toISOString();
		const facts = this.d.db
			.prepare("SELECT * FROM stm_facts WHERE state = 'day' ORDER BY said_at, created_at")
			.all() as StmFact[];
		for (const listed of facts) {
			if (shouldStop()) return { ...out, stopped: "stopped" };
			try {
				if (this.d.relation && this.current(listed.id, "day")) await this.askRelation(listed);
				// Read again right before the merge (as the night does): a /forget may have landed meanwhile.
				const f = this.current(listed.id, "day");
				if (!f) continue;
				this.d.db.transaction(() =>
					mergeFact(this.d.db, f, { night, maxStep: this.d.maxStep, now: this.d.now(), newId: this.d.newId }),
				)();
				out.merged++;
			} catch (err) {
				// One bad fact never stops the night: it is left out, and the episodes' own transfer still runs.
				this.d.db.prepare("UPDATE stm_facts SET state = 'dropped' WHERE id = ? AND state = 'day'").run(listed.id);
				this.d.log.warn("facts: merging a fact failed; it is left out", {
					id: listed.id,
					error: (err as Error).message,
				});
			}
		}
		// Plan 0.013 E1: a planned date that has come holds now (the merge itself only rebuilds the keys it touched).
		rebuildAllTimelines(this.d.db, this.d.now().toISOString().slice(0, 10));
		const toStore = this.d.db
			.prepare("SELECT id FROM stm_facts WHERE state = 'merged' AND stored_at IS NULL ORDER BY said_at")
			.all() as { id: string }[];
		for (const { id } of toStore) {
			if (shouldStop()) return { ...out, stopped: "stopped" };
			const f = this.current(id, "merged");
			const bank = f ? bankFor(f.scope) : null;
			// The forgetting set is read each time: storing would re-create a bank being deleted.
			if (!f || f.stored_at || !bank || banksBeingForgotten(this.d.db).has(bank)) continue;
			try {
				await this.store(bank, f);
				this.d.db.prepare("UPDATE stm_facts SET stored_at = ? WHERE id = ?").run(this.d.now().toISOString(), f.id);
				// The bank is consolidated after the episodes, like a bank that received a turn.
				const pending = parseBanks(getKv(this.d.db, PENDING_BANKS_KEY));
				if (!pending.includes(bank))
					setKv(this.d.db, PENDING_BANKS_KEY, JSON.stringify([...pending, bank]), this.d.now().toISOString());
				out.stored++;
			} catch (err) {
				if (!(err instanceof HindsightError) || [502, 503, 504].includes(err.status))
					return { ...out, stopped: `long-term memory is unreachable: ${(err as Error).message}` };
				this.d.log.warn("facts: storing a fact failed; it is retried next night", { id: f.id, error: err.message });
			}
		}
		await this.checkOrphans();
		return out;
	}

	/** Step 5: report what the two stores disagree on; a failure only says so. */
	private async checkOrphans(): Promise<void> {
		const { listBanks, listDocuments } = this.d.ltm;
		if (!listBanks || !listDocuments) return;
		const ltm = { listBanks: listBanks.bind(this.d.ltm), listDocuments: listDocuments.bind(this.d.ltm) };
		const c = await checkFactOrphans(this.d.db, ltm, this.d.now().toISOString());
		saveOrphanCheck(this.d.db, c);
		if (c.error) this.d.log.warn("facts: the orphan check could not finish", { error: c.error });
		else if (orphanTotal(c) > 0) this.d.log.warn("facts: SQLite and long-term memory disagree", { ...c.counts });
	}

	/** The fact as it is now, if it is still in the expected state and its scope was not forgotten since it was said. */
	private current(id: string, state: "day" | "merged"): (StmFact & { stored_at: string | null }) | null {
		const f = this.d.db.prepare("SELECT * FROM stm_facts WHERE id = ? AND state = ?").get(id, state) as
			| (StmFact & { stored_at: string | null })
			| undefined;
		if (!f) return null;
		if (f.scope !== IYYE_SCOPE) {
			const receivedAt = getEvent(this.d.db, f.event_id)?.received_at ?? f.said_at;
			if (isForgotten(this.d.db, f.scope, receivedAt)) return null;
		}
		return f;
	}

	/** F3 shadow: the fact's nearest stored beliefs of another key, from earlier nights' structured facts. */
	private async askRelation(f: StmFact): Promise<void> {
		const exact = this.d.db.prepare("SELECT 1 FROM beliefs WHERE fact_key = ?").get(f.fact_key);
		const bank = bankFor(f.scope);
		if (exact || !bank) return;
		const sentence = factSentence({ ...f, negated: f.negated === 1 });
		let hits: { document_id: string | null; score: number | null }[] = [];
		try {
			hits = await this.d.ltm.recall(bank, sentence, 300, { tags: [STRUCTURED_TAG] });
		} catch {
			return; // a missing bank or an outage: nothing to compare with
		}
		const seen = new Set<string>();
		for (const h of hits) {
			if (seen.size >= 2) break;
			if (!h.document_id?.startsWith("fact:") || (h.score !== null && h.score < 0.3)) continue;
			const row = this.d.db.prepare("SELECT belief_id FROM stm_facts WHERE id = ?").get(h.document_id.slice(5)) as
				| { belief_id: string | null }
				| undefined;
			const b: Belief | null = row?.belief_id ? getBelief(this.d.db, row.belief_id) : null;
			if (!b || seen.has(b.id) || b.fact_key === f.fact_key) continue;
			seen.add(b.id);
			await this.d.relation!.ask(
				{ newStatement: { sentence, said: f.said_at }, stored: b },
				f.scope,
				`${f.id}~${b.id}`,
			);
		}
	}

	private async store(bank: string, f: StmFact): Promise<void> {
		if (!this.banksReady.has(bank)) {
			const own = f.scope === IYYE_SCOPE;
			await this.d.ltm.ensureBank(bank, {
				retainMission: RETAIN_MISSION,
				replyMission: REPLY_MISSION,
				observations: !own,
				...(own ? {} : { observationsMission: OBSERVATIONS_MISSION }),
			});
			this.banksReady.add(bank);
		}
		const speaker =
			f.modality === "told_by_iyye" ? SPEAKER_IYYE : f.modality === "measured" ? SPEAKER_PROBE : SPEAKER_PERSON;
		await this.d.ltm.retain(bank, {
			documentId: factDocId(f.id),
			content: `${factSentence({ ...f, negated: f.negated === 1 })} [${this.provenance(f)}, ${f.said_at.slice(0, 10)}]`,
			context:
				f.modality === "told_by_iyye"
					? "A structured fact: what Iyye told someone, not evidence of it."
					: f.modality === "measured"
						? "A structured fact: a measurement by Iyye's own probe."
						: "A structured fact: what a person stated, extracted and checked against their own words.",
			timestamp: f.said_at,
			tags: [`scope:${f.scope}`, speaker, STRUCTURED_TAG, `modality:${f.modality}`],
			metadata: { fact_key: f.fact_key, belief_id: f.belief_id ?? "", stm_fact_id: f.id },
			strategy: VERBATIM_STRATEGY,
		});
	}

	private provenance(f: StmFact): string {
		if (f.modality === "measured") return "measured by Iyye's probe";
		const who = (id: string) =>
			id === OWNER_CONTACT_ID ? "the owner" : (getContact(this.d.db, id)?.display_name ?? "a contact");
		if (f.modality === "told_by_iyye") {
			const to =
				f.scope === "owner" ? "the owner" : f.scope.startsWith("contact:") ? who(f.scope.slice(8)) : "someone";
			return `Iyye told ${to}${f.cited ? `, citing ${f.cited}` : ""}`;
		}
		return `stated by ${who(f.source)}`;
	}
}
