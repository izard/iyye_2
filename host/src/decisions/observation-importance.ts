// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Observation importance (plan 0.007 S4; owner decision 6): the first role
 * that **acts**. For each change Iyye's own probes observed: "is this worth
 * remembering long-term and telling the owner about?".
 *
 * - What it decides is narrow: whether Iyye's own observation becomes a
 *   finding (kept in memory, shown to the owner). Never a permission, a route,
 *   or anything about a person.
 * - p ≥ 0.45 → a finding; p ≤ 0.30 → recorded only (band from the S0 spike:
 *   wording v1 ranked 15/15 hand cases). Between, or Kev unavailable: the
 *   deterministic fallback, the change rule's severity (a threshold crossing
 *   is a finding).
 * - The state is the domain and the change text, nothing else. Every answer
 *   is journaled with its revision; the owner labels it with `/decisions label`.
 */

import type { DeviceSlot } from "../kernel/device.ts";
import type { Severity } from "../observe/domains.ts";
import type { DecisionClient, NoulQuestion, Role } from "./client.ts";

export const OBSERVATION_IMPORTANCE: Role = {
	name: "observation_importance",
	schemaVersion: 1,
	abstain: { low: 0.3, high: 0.45 },
	fallback: "the change rule: a threshold crossing is a finding, a minor change is not",
	mode: "acting",
};

export const IMPORTANCE_QUESTION: NoulQuestion = {
	id: "worth_telling",
	instructions:
		"The state is a change Iyye's own probe observed on the computer it runs on or in its own code repository. Is this change worth remembering long-term and telling the owner about, rather than routine noise?",
};

export type ImportanceResult =
	| { kind: "decided"; finding: boolean; by: "kev" | "fallback"; decisionId: string | null }
	/** The device is busy: decide on a later tick, so Kev decides whenever it can. */
	| { kind: "deferred" };

export class ObservationImportance {
	private readonly d: { client: DecisionClient; device: DeviceSlot };

	constructor(deps: { client: DecisionClient; device: DeviceSlot }) {
		this.d = deps;
	}

	async decide(input: {
		observationId: string;
		domain: string;
		change: string;
		severity: Severity;
	}): Promise<ImportanceResult> {
		const release = this.d.device.tryAcquire("decision:observation_importance");
		if (!release) return { kind: "deferred" };
		let decision: Awaited<ReturnType<DecisionClient["ask"]>>;
		try {
			decision = await this.d.client.ask(OBSERVATION_IMPORTANCE, {
				scope: "iyye",
				subjectRef: input.observationId,
				state: { domain: input.domain, change: input.change },
				questions: [IMPORTANCE_QUESTION],
			});
		} finally {
			release();
		}
		const v = decision.verdicts[IMPORTANCE_QUESTION.id];
		if (decision.status === "ok" && (v === "yes" || v === "no")) {
			return { kind: "decided", finding: v === "yes", by: "kev", decisionId: decision.id };
		}
		// Unsure, an error, or Kev down: the deterministic rule decides, and the journal row stays as evidence.
		return { kind: "decided", finding: input.severity === "threshold", by: "fallback", decisionId: decision.id };
	}
}
