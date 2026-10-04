// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory salience, shadow only (plan 0.003 §3.2 role 1, K3).
 *
 * At night, before each STM episode is retained: "does this message contain
 * something worth remembering long-term?". The outcome is the transfer's own
 * result: `completed` (Hindsight extracted facts) or `completed_empty`. That
 * is one model's judgement, so the label is **weak**. The owner can override
 * it with `/decisions label`.
 *
 * - **Shadow by construction:** the night calls `ask` and `outcome` and never
 *   reads an answer; every episode is retained exactly as without the role.
 * - **The pre-decision state only:** the person's message, never Iyye's reply
 *   or anything the transfer produced.
 * - **One answered decision per episode:** a backlog episode retried on a
 *   later night reuses its answered decision, so one message is never two
 *   training examples. The night asks at most once per episode per run.
 * - **Never waits for the device:** if it is busy the call is journaled as
 *   skipped.
 */

import type { DeviceSlot } from "../kernel/device.ts";
import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import type { StmEpisode } from "../state/stm.ts";
import type { DecisionClient, NoulQuestion, Role } from "./client.ts";

export const MEMORY_SALIENCE: Role = {
	name: "memory_salience",
	schemaVersion: 1,
	// K0: small talk 0.03–0.22, facts 0.32–0.74. A fitted threshold comes from this role's own shadow data.
	abstain: { low: 0.2, high: 0.35 },
	fallback: "every episode is retained; Hindsight's extraction decides what is kept",
};

export const SALIENCE_QUESTION: NoulQuestion = {
	id: "worth_remembering",
	instructions:
		"The state is one message a person sent to their personal assistant. Does it contain something worth remembering long-term about the person or the people, places, plans, preferences or facts in their life, beyond small talk, greetings, thanks or a one-off question?",
};

export class MemorySalience {
	private readonly d: { db: Db; client: DecisionClient; device: DeviceSlot; log: Logger };

	constructor(deps: { db: Db; client: DecisionClient; device: DeviceSlot; log: Logger }) {
		this.d = deps;
	}

	/** Ask about one episode before its transfer; returns the decision id, or null when not asked. */
	async ask(e: StmEpisode): Promise<string | null> {
		if (e.kind !== "turn") return null; // /remember: the owner decided; Iyye's own entries are not a person's words
		// An answered decision is reused; a skipped or failed one (Kev down, device busy) is asked again on a later night.
		const earlier = this.d.db
			.prepare(
				"SELECT id FROM decisions WHERE role = ? AND subject_ref = ? AND status = 'ok' ORDER BY created_at LIMIT 1",
			)
			.get(MEMORY_SALIENCE.name, e.event_id) as { id: string } | undefined;
		if (earlier) return earlier.id;
		const input = { scope: e.scope, subjectRef: e.event_id, state: e.user_text, questions: [SALIENCE_QUESTION] };
		const release = this.d.device.tryAcquire("decision:memory_salience");
		if (!release) return this.d.client.skip(MEMORY_SALIENCE, input, "the device was busy");
		try {
			return (await this.d.client.ask(MEMORY_SALIENCE, input)).id;
		} catch (err) {
			this.d.log.warn("decisions: memory salience failed", { error: (err as Error).message });
			return null;
		} finally {
			release();
		}
	}

	/** The transfer's result, joined as a weak label. Only a confirmed transfer is an outcome, and only an answered decision gets one. */
	outcome(id: string, transfer: "completed" | "completed_empty"): void {
		const row = this.d.db.prepare("SELECT status FROM decisions WHERE id = ?").get(id) as
			| { status: string }
			| undefined;
		if (row?.status !== "ok") return;
		this.d.client.recordOutcome(
			id,
			{ worth_remembering: transfer === "completed", transfer },
			"hindsight_extraction",
			"weak",
		);
	}
}
