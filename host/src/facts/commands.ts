// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * `/facts` (plan 0.011, owner only):
 *
 * - `/facts` — today's extraction and facts, and the beliefs in numbers.
 * - `/facts <words>` — beliefs about them: value, probability, validity, and
 *   every piece of evidence with its source (the owner sees all evidence).
 * - `/facts compare` — last night's structured facts by conversation, next to
 *   how many of the same conversations Hindsight's own extraction kept (the
 *   comparison week, F2).
 * - `/facts correct <id> <text>` — the owner's right value: the strongest
 *   evidence; the old belief is closed or contradicted, its history kept.
 * - `/facts wrong <id>` — delete the belief outright (owner decision 2), its
 *   stored text too, and suppress the value so the same evidence cannot bring
 *   it back.
 * - `/facts confirm <id>` — the owner says the belief is right (an answer to
 *   one of Iyye's questions about an uncertain belief, plan 0.010 M2).
 * - `/facts private <id>`, `/facts share <id>` — override the host's privacy
 *   rules for one belief (plan §3.6).
 * - `/facts why <id>` — why a belief exists (plan 0.013 E5): its ranges, each
 *   piece of evidence, the structured fact and the message it came from, and
 *   the tool result it was traced to.
 * - `/facts report` — the ledger's integrity figures (plan 0.013 E6).
 */

import type { FactRelation } from "../decisions/fact-relation.ts";
import type { Logger } from "../log.ts";
import type { HindsightClient } from "../memory/hindsight.ts";
import { getContact, OWNER_CONTACT_ID } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { getEvent } from "../state/events.ts";
import {
	type Belief,
	confirmBelief,
	conflictsOf,
	correctBelief,
	deleteBelief,
	evidenceOf,
	getBelief,
	intervalsOf,
	searchBeliefs,
} from "./beliefs.ts";
import { isPrivate } from "./disclosure.ts";
import { factSentence, normalizeTerm } from "./extract.ts";
import { deleteQueuedFactDocs, queueFactDocDeletions } from "./night.ts";
import { factsIntegrity, factsTodayReport, integrityReport } from "./store.ts";

export interface FactsCommandDeps {
	db: Db;
	log: Logger;
	ltm: Pick<HindsightClient, "deleteDocument"> | null;
	extractorStatus: () => string;
	relation?: Pick<FactRelation, "labelCorrection"> | null;
	now?: () => Date;
	newId?: () => string;
}

export class FactsCommand {
	private readonly d: Required<FactsCommandDeps>;

	constructor(deps: FactsCommandDeps) {
		this.d = { relation: null, now: () => new Date(), newId: () => crypto.randomUUID(), ...deps };
	}

	async command(args: string[], by: string): Promise<string> {
		const [sub, ...rest] = args;
		if (!sub) return this.overview();
		if (sub === "compare") return this.compare();
		if (sub === "correct") return this.correct(rest[0] ?? "", rest.slice(1).join(" "), by);
		if (sub === "confirm") return this.confirm(rest[0] ?? "");
		if (sub === "wrong") return this.wrong(rest[0] ?? "", by);
		if (sub === "private" || sub === "share") return this.disclose(rest[0] ?? "", sub);
		if (sub === "why" && rest.length === 1) return this.why(rest[0]!);
		if (sub === "report" && rest.length === 0) return integrityReport(factsIntegrity(this.d.db));
		return this.lookup(args.join(" "));
	}

	private overview(): string {
		const b = this.d.db
			.prepare(
				"SELECT count(*) AS n, count(*) FILTER (WHERE state = 'current') AS current, count(*) FILTER (WHERE p >= 0.7) AS likely FROM beliefs",
			)
			.get() as { n: number; current: number; likely: number };
		return [
			factsTodayReport(this.d.db),
			`extraction now: ${this.d.extractorStatus()}`,
			`beliefs: ${b.n} (${b.current} current, ${b.likely} with p ≥ 0.7); /facts <words> to look one up`,
		].join("\n");
	}

	private lookup(words: string): string {
		const found = searchBeliefs(this.d.db, words);
		if (found.length === 0) return `no beliefs about ${JSON.stringify(words)}`;
		return found.map((b) => this.describe(b)).join("\n");
	}

	private describe(b: Belief): string {
		const ev = evidenceOf(this.d.db, b.id);
		// Every range the value held (plan 0.013 E1); "~" marks a date that is only when it was received.
		const ranges = intervalsOf(this.d.db, b.id);
		const day = (d: string, approx: number) => `${approx ? "~" : ""}${d}`;
		const validity = ranges.length
			? ranges
					.map((r) =>
						r.valid_to
							? `${day(r.valid_from, r.approximate)} – ${r.valid_to}`
							: `since ${day(r.valid_from, r.approximate)}`,
					)
					.join(", ")
			: b.valid_to
				? b.valid_to === b.valid_from
					? `never held (${b.valid_from})`
					: `${b.valid_from} – ${b.valid_to}`
				: b.state === "closed"
					? `planned from ${b.valid_from}`
					: `since ${b.valid_from}`;
		const conflicts = conflictsOf(this.d.db, b);
		return [
			`${b.id.slice(0, 8)} [p ${b.p.toFixed(2)}, ${b.state}, ${validity}, ${isPrivate(this.d.db, b) ? "private" : "shareable with trusted contacts"}${b.disclosure ? " (your choice)" : ""}] ${factSentence({ ...b, negated: b.negated === 1 })}`,
			...ev.map(
				(e) =>
					`    ${e.sign > 0 ? "+" : "−"} ${this.who(e.source)} (${e.modality}, ${e.relation}, p ${e.source_p.toFixed(2)}, weight ${e.weight}${e.private ? ", private" : ""}) ${e.effective_at ? `from ${day(e.effective_at.slice(0, 10), e.effective_known === 0 ? 1 : 0)}, ` : ""}said ${(e.said_at ?? e.at).slice(0, 10)}`,
			),
			// Choosing one current value does not settle a disagreement (owner decision, plan 0.013).
			...conflicts.map(
				(c) =>
					`    conflict: ${c.belief.object} (${c.belief.id.slice(0, 8)}, p ${c.belief.p.toFixed(2)}) from ${[...new Set(c.evidence.map((e) => this.who(e.source)))].join(", ")} for ${[...new Set(c.evidence.map((e) => e.effective_at!.slice(0, 10)))].join(", ")}`,
			),
		].join("\n");
	}

	/** `/facts why <id>` (plan 0.013 E5): the chain from the belief to what it rests on. Owner only. */
	private why(ref: string): string {
		const b = this.resolve(ref);
		if (typeof b === "string") return b;
		const db = this.d.db;
		const lines = [this.describe(b).split("\n")[0]!];
		for (const e of evidenceOf(db, b.id)) {
			lines.push(
				`  ${e.sign > 0 ? "supports" : "contradicts"} · ${this.who(e.source)} · ${e.relation} · weight ${e.weight}${e.effective_at ? ` · from ${e.effective_at.slice(0, 10)}${e.effective_known ? "" : " (approximate)"}` : ""} · said ${(e.said_at ?? e.at).slice(0, 16).replace("T", " ")}`,
			);
			if (!e.stm_fact_id) {
				lines.push("      your own word (/facts correct or confirm)");
				continue;
			}
			const f = db.prepare("SELECT * FROM stm_facts WHERE id = ?").get(e.stm_fact_id) as
				| {
						quote: string;
						event_id: string;
						scope: string;
						modality: string;
						cited: string | null;
						tool_call_id: string | null;
				  }
				| undefined;
			if (!f) {
				lines.push("      its structured fact is gone (forgotten or deleted)");
				continue;
			}
			lines.push(`      quote: ${JSON.stringify(f.quote.slice(0, 200))} (${f.modality}, ${f.scope})`);
			const ev = getEvent(db, f.event_id);
			if (ev)
				lines.push(
					`      message ${f.event_id.slice(0, 8)} on ${ev.channel}, ${ev.received_at.slice(0, 16).replace("T", " ")}`,
				);
			if (f.tool_call_id) {
				const t = db
					.prepare("SELECT tool, started_at, result, result_hash FROM tool_calls WHERE id = ?")
					.get(f.tool_call_id) as
					| { tool: string; started_at: string; result: string | null; result_hash: string | null }
					| undefined;
				lines.push(
					t
						? `      ${f.cited ? "cited" : "taken from (another model's answer: no observation weight)"}: ${t.tool} at ${t.started_at.slice(0, 16).replace("T", " ")}${t.result_hash ? `, result ${t.result_hash.slice(0, 12)}` : ""}: ${JSON.stringify((t.result ?? "").replace(/\s+/g, " ").slice(0, 160))}`
						: "      its tool result is gone",
				);
			} else if (f.modality === "told_by_iyye")
				lines.push("      Iyye's own words, traced to no tool result: not evidence");
		}
		lines.push("Traced means where a claim came from, not that it is true.");
		return lines.join("\n");
	}

	private who(source: string): string {
		if (source === OWNER_CONTACT_ID) return "the owner";
		if (source === "iyye") return "Iyye";
		if (source === "probe") return "a probe";
		return getContact(this.d.db, source)?.display_name ?? "a contact";
	}

	private compare(): string {
		const last = this.d.db.prepare("SELECT max(merged_at) AS at FROM stm_facts WHERE state = 'merged'").get() as {
			at: string | null;
		};
		if (!last.at) return "no night has merged facts yet";
		const since = new Date(Date.parse(last.at) - 12 * 3_600_000).toISOString();
		const rows = this.d.db
			.prepare(
				`SELECT s.scope, count(DISTINCT s.event_id) AS episodes, count(*) AS facts,
					(SELECT count(*) FROM stm_episodes e WHERE e.scope = s.scope AND e.state = 'completed' AND e.transferred_at >= ?) AS hindsight
				 FROM stm_facts s WHERE s.state = 'merged' AND s.merged_at >= ? GROUP BY s.scope`,
			)
			.all(since, since) as { scope: string; episodes: number; facts: number; hindsight: number }[];
		const facts = this.d.db
			.prepare("SELECT * FROM stm_facts WHERE state = 'merged' AND merged_at >= ? ORDER BY scope, said_at LIMIT 30")
			.all(since) as {
			scope: string;
			subject: string;
			predicate: string;
			object: string;
			negated: number;
			details: string | null;
		}[];
		return [
			"last night: structured facts next to Hindsight's own extraction (node scripts/dump-ltm.ts shows Hindsight's side)",
			...rows.map(
				(r) =>
					`  ${r.scope}: ${r.facts} structured fact(s) from ${r.episodes} entr(ies); Hindsight kept something from ${r.hindsight} conversation(s)`,
			),
			...facts.map((f) => `  · ${f.scope}: ${factSentence({ ...f, negated: f.negated === 1 })}`),
		].join("\n");
	}

	private resolve(ref: string): Belief | string {
		if (!/^[0-9a-f-]{6,36}$/i.test(ref)) return "give a belief id, at least 6 characters (see /facts <words>)";
		const rows = this.d.db.prepare("SELECT id FROM beliefs WHERE id LIKE ?").all(`${ref}%`) as { id: string }[];
		if (rows.length !== 1) return rows.length ? `${ref} matches ${rows.length} beliefs` : `no belief ${ref}`;
		return getBelief(this.d.db, rows[0]!.id)!;
	}

	private async correct(ref: string, text: string, _by: string): Promise<string> {
		const b = this.resolve(ref);
		if (typeof b === "string") return b;
		const now = this.d.now();
		const r = correctBelief(this.d.db, b.id, text, {
			night: `correction:${now.toISOString()}`,
			maxStep: Number.POSITIVE_INFINITY,
			now,
			newId: this.d.newId,
		});
		if (typeof r === "string") return r;
		// F3: the correction is an owner-labelled pair for the fact-relation role (shadow; never read here).
		void this.d.relation
			?.labelCorrection(r.old, text.trim(), normalizeTerm(text) === r.old.object_norm, now.toISOString())
			.catch(() => null);
		const nb = getBelief(this.d.db, r.newId)!;
		if (r.already)
			return `already current: ${factSentence({ ...nb, negated: nb.negated === 1 })}; your word confirms it (p ${nb.p.toFixed(2)})`;
		const old = getBelief(this.d.db, b.id);
		return `noted: ${factSentence({ ...nb, negated: nb.negated === 1 })} (p ${nb.p.toFixed(2)}), from today; ${
			r.newId === b.id
				? "it holds again"
				: old?.state === "closed"
					? "the old value is closed, kept as history"
					: "the old value is contradicted"
		}`;
	}

	/** `/facts private|share <id>`: the owner's override of the host's privacy rules (plan §3.6). */
	private disclose(ref: string, how: "private" | "share"): string {
		const b = this.resolve(ref);
		if (typeof b === "string") return b;
		this.d.db
			.prepare("UPDATE beliefs SET disclosure = ?, updated_at = ? WHERE id = ?")
			.run(how, this.d.now().toISOString(), b.id);
		return how === "private"
			? `private: ${factSentence({ ...b, negated: b.negated === 1 })} reaches only the people who said it, and you`
			: `shareable: trusted contacts may be told ${factSentence({ ...b, negated: b.negated === 1 })}, with who said it`;
	}

	private confirm(ref: string): string {
		const b = this.resolve(ref);
		if (typeof b === "string") return b;
		const now = this.d.now();
		const r = confirmBelief(this.d.db, b.id, {
			night: `confirmation:${now.toISOString()}`,
			maxStep: Number.POSITIVE_INFINITY,
			now,
			newId: this.d.newId,
		});
		if (typeof r === "string") return r;
		return `confirmed: ${factSentence({ ...r, negated: r.negated === 1 })} (p ${r.p.toFixed(2)})`;
	}

	private async wrong(ref: string, by: string): Promise<string> {
		const b = this.resolve(ref);
		if (typeof b === "string") return b;
		const at = this.d.now().toISOString();
		const facts = deleteBelief(this.d.db, b.id, by, at);
		if (typeof facts === "string") return facts;
		queueFactDocDeletions(this.d.db, facts, at);
		let left = facts.length;
		if (this.d.ltm) left = await deleteQueuedFactDocs(this.d.db, this.d.ltm, this.d.log).catch(() => left);
		return `deleted: ${factSentence({ ...b, negated: b.negated === 1 })}. The same evidence will not bring it back; new evidence may.${left ? ` (${left} stored text(s) are deleted at the next chance)` : ""}`;
	}
}
