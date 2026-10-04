// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Initiative, shadow only (plan 0.007 S5, HLD §5.3): before an investigation
 * attempt starts, "is this worth investigating now?". The kernel's eligibility
 * rules and the deterministic baseline (investigate every eligible
 * opportunity) decide; the answer is journaled and compared with whether the
 * attempt was fruitful (a weak label) and the owner's label.
 *
 * Plan §2.6 asked for a choice (investigate / defer / no work); the decision
 * client speaks yes/no (`noul`) only, so this is the one question "worth it
 * now?". A choice needs the client's schema work first.
 */

import type { DeviceSlot } from "../kernel/device.ts";
import type { DecisionClient, NoulQuestion, Role } from "./client.ts";

export const INITIATIVE: Role = {
	name: "initiative",
	schemaVersion: 1,
	abstain: { low: 0.3, high: 0.6 },
	fallback: "investigate every eligible opportunity (one at a time, within the bounds)",
};

export const INITIATIVE_QUESTION: NoulQuestion = {
	id: "worth_investigating",
	instructions:
		"The state is something Iyye's own probe noticed about its computer or its own code, and the question it raises. Is it worth Iyye spending a few minutes now looking into it with read-only tools, rather than leaving it?",
};

export class InitiativeShadow {
	private readonly d: { client: DecisionClient; device: DeviceSlot };

	constructor(deps: { client: DecisionClient; device: DeviceSlot }) {
		this.d = deps;
	}

	/** Journal Kev's answer; returns the decision id. Never changes what happens. */
	async ask(o: { id: string; domain: string; evidence: string; question: string }): Promise<string | null> {
		const input = {
			scope: "iyye",
			subjectRef: o.id,
			state: { domain: o.domain, noticed: o.evidence, question: o.question },
			questions: [INITIATIVE_QUESTION],
		};
		const release = this.d.device.tryAcquire("decision:initiative");
		if (!release) return this.d.client.skip(INITIATIVE, input, "the device was busy");
		try {
			return (await this.d.client.ask(INITIATIVE, input)).id;
		} finally {
			release();
		}
	}

	/** Whether the attempt found something (weak: the host's citation check). */
	outcome(decisionId: string, fruitful: boolean): void {
		this.d.client.recordOutcome(decisionId, { worth_investigating: fruitful }, "investigation_result", "weak");
	}
}
