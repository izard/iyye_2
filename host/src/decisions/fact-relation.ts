// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Fact relation, shadow only (plan 0.011 F3, §3.4 step 2): how a new
 * structured fact relates to a stored belief that is not of the same exact
 * key ("takes violin lessons" against "plays the violin").
 *
 * - **Shadow by construction:** the merge classifies only exact keys, by
 *   rule; for everything else the fallback is `unrelated` (the fact becomes
 *   its own belief). This role is asked at night, before the fact is merged,
 *   about its nearest stored beliefs, and its answer is journaled, never read
 *   by the merge.
 * - **The state is records only:** both statements as the host wrote them
 *   (subject, predicate, value, date), never a model's narration.
 * - **Labels:** `/facts correct <id> <text>` asks about the owner's corrected
 *   value against the old belief and joins the owner's own answer (an owner
 *   label: a correction is the same subject, and says the old value is wrong
 *   unless it repeats it); any decision can also be labelled with
 *   `/decisions label`.
 * - Never waits for the device: if it is busy the call is journaled as skipped.
 */

import type { Belief } from "../facts/beliefs.ts";
import { factSentence } from "../facts/extract.ts";
import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import type { DecisionClient, NoulQuestion, Role } from "./client.ts";

export const FACT_RELATION: Role = {
	name: "fact_relation",
	schemaVersion: 1,
	abstain: { low: 0.3, high: 0.7 },
	fallback: "unrelated: a fact without an exact key match becomes its own belief",
};

export const RELATION_QUESTIONS: NoulQuestion[] = [
	{
		id: "same_fact",
		instructions:
			"The state holds a new statement and a stored belief about the world. Do they say the same thing about the same subject (one would confirm the other)?",
	},
	{
		id: "contradicts",
		instructions:
			"The state holds a new statement and a stored belief about the world. Does the new statement say the stored belief is false, or no longer true?",
	},
	{
		id: "refines",
		instructions:
			"The state holds a new statement and a stored belief about the world. Does the new statement add detail to the stored belief without contradicting it?",
	},
];

/** The pair as the role sees it: records only. */
export interface RelationPair {
	newStatement: { sentence: string; said: string };
	stored: Belief;
}

function stateOf(pair: RelationPair) {
	const b = pair.stored;
	return {
		new_statement: pair.newStatement.sentence,
		new_said_on: pair.newStatement.said.slice(0, 10),
		stored_belief: factSentence({ ...b, negated: b.negated === 1 }),
		stored_since: b.valid_from,
		stored_until: b.valid_to,
	};
}

export class FactRelation {
	private readonly d: {
		db: Db;
		client: DecisionClient;
		device: { tryAcquire(label: string): (() => void) | null };
		log: Logger;
	};

	constructor(deps: {
		db: Db;
		client: DecisionClient;
		device: { tryAcquire(label: string): (() => void) | null };
		log: Logger;
	}) {
		this.d = deps;
	}

	/** Ask about one pair; returns the decision id, or null when not asked. Never throws. */
	async ask(pair: RelationPair, scope: string | null, subjectRef: string): Promise<string | null> {
		const input = { scope, subjectRef, state: stateOf(pair), questions: RELATION_QUESTIONS };
		const release = this.d.device.tryAcquire("decision:fact_relation");
		if (!release) return this.d.client.skip(FACT_RELATION, input, "the device was busy");
		try {
			return (await this.d.client.ask(FACT_RELATION, input)).id;
		} catch (err) {
			this.d.log.warn("decisions: fact relation failed", { error: (err as Error).message });
			return null;
		} finally {
			release();
		}
	}

	/** The owner's correction as a labelled pair: the corrected value against the old belief. */
	async labelCorrection(old: Belief, correctedObject: string, normEqual: boolean, at: string): Promise<string | null> {
		const sentence = factSentence({ ...old, object: correctedObject, negated: false, details: null });
		const id = await this.ask(
			{ newStatement: { sentence, said: at }, stored: old },
			"owner",
			`correction:${old.id}:${at}`,
		);
		if (!id) return null;
		const row = this.d.db.prepare("SELECT status FROM decisions WHERE id = ?").get(id) as
			| { status: string }
			| undefined;
		if (row?.status !== "ok") return id;
		this.d.client.recordOutcome(
			id,
			{ same_fact: normEqual, contradicts: !normEqual, refines: false },
			"owner_correction",
			"owner",
		);
		return id;
	}
}
