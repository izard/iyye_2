// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Does a message need the thinking model? Shadow only (owner decision
 * 2026-11-14).
 *
 * The chat model decides for itself when to call `ask_thinking_model`
 * (`tools/thinking.ts`). This role asks Kev the same thing about every
 * answered turn that had the tool on offer, and records beside the answer
 * what the chat model did. It is evidence for a later owner decision (a hint
 * to the chat model, say), and data for Stage 4.
 *
 * - **Shadow by construction:** `observe` returns nothing and the only writer
 *   of the answers is the decision journal. The toolkit stays always declared
 *   (`ALWAYS_ON`), and nothing a session declares, is told or does reads this.
 * - **Never slows a reply:** the state is the message alone (the pre-decision
 *   state), so it is asked after the turn, from a queue, when the decision
 *   service is up, the device is free and no chat is waiting.
 * - **The outcome is a weak label, and only of agreement:** "the chat model
 *   asked the thinking model in that turn" is that model's own judgement, the
 *   very thing in question. Who is right is said only by the owner's labels
 *   (`/decisions queue`, `/decisions label`), which live in `decision_labels`
 *   and never replace the record of what happened.
 * - **A turn told the thinking model was away says nothing about the chat
 *   model's judgement** (`Toolkit.note`): its outcome is marked `away`, and
 *   the comparison with the chat model leaves it out. Kev's answer about the
 *   message still stands, and the owner can still label it.
 * - **Two wordings, one call:** Kev answers each question on its own, so a
 *   second wording costs nothing and the owner's labels can later say which
 *   predicts better. Both were fixed by `scripts/thinking-need-spike.ts` on
 *   the 351 answered messages of 2026-10-10..11-14 (the chat model asked the
 *   thinking model in 30, and 15 of those messages named it themselves):
 *   against the chat model's choice, `needs_thinking_model` ranked 0.71 (AUC)
 *   and `asks_for_careful_answer` 0.78; "is it a hard question" 0.62, "can it
 *   be answered at once" 0.57. A wording about puzzles, math and logic (0.74)
 *   said a plain no to 11 of the 30: the thinking model is mostly asked for
 *   thorough answers, not riddles. Zero-shot, none is good enough to act on.
 * - **Known limit:** Kev sees the message without its conversation, so "and
 *   with five instead?" cannot be judged.
 */

import type { DeviceSlot } from "../kernel/device.ts";
import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import { THINKING_TOOLKIT, thinkingCalls } from "../tools/thinking.ts";
import type { DecisionClient, NoulQuestion, Role } from "./client.ts";
import { IdleLoop } from "./idle.ts";
import type { TurnInfo } from "./toolkit-selection.ts";

export const THINKING_NEED: Role = {
	name: "thinking_need",
	schemaVersion: 1,
	abstain: { low: 0.3, high: 0.6 },
	fallback: "the chat model decides for itself whether to ask the thinking model",
};

/** The role's question, and the one the owner labels: the wording toolkit selection would ask of this toolkit. */
export const NEED_QUESTION: NoulQuestion = {
	id: "needs_thinking_model",
	instructions:
		"The state is a message someone sent to their personal assistant. To answer it well, does the assistant need a stronger reasoning model for hard questions, that is: a careful answer from that reasoning model?",
};

/** A second wording of the same need, about what the message asks for. Scored against the same labels. */
export const ASKS_QUESTION: NoulQuestion = {
	id: "asks_for_careful_answer",
	instructions:
		"The state is a message someone sent to their personal assistant. Does the message ask for a careful, thorough or expert answer, or ask the assistant to think hard or to consult a stronger model?",
};

export const NEED_QUESTIONS: readonly NoulQuestion[] = [NEED_QUESTION, ASKS_QUESTION];

/** What the turn's records say the chat model did (the weak label). */
export interface ThinkingNeedOutcome {
	/** The session asked the thinking model at least once in that turn. */
	called: boolean;
	calls: number;
	/** How many of the calls the thinking model answered (it may have been away). */
	answered: number;
	/** The turn was told beforehand that the thinking model could not be asked: not calling it was no judgement. */
	away: boolean;
}

export class ThinkingNeedShadow {
	private readonly d: {
		db: Db;
		client: DecisionClient;
		device: DeviceSlot;
		chatPending: () => boolean;
		ready: () => boolean;
		log: Logger;
		maxQueue: number;
		pollMs: number;
	};
	private readonly queue: TurnInfo[] = [];
	private readonly loop: IdleLoop;

	constructor(deps: {
		db: Db;
		client: DecisionClient;
		device: DeviceSlot;
		chatPending: () => boolean;
		/** The decision service is up: until then a turn waits in the queue, since an ask would be journaled as skipped. */
		ready?: () => boolean;
		log: Logger;
		maxQueue?: number;
		pollMs?: number;
	}) {
		this.d = { maxQueue: 50, pollMs: 2000, ready: () => true, ...deps };
		this.loop = new IdleLoop({ pollMs: this.d.pollMs, drain: () => this.drainOnce() });
	}

	/** Called after every turn; returns nothing on purpose (shadow). Only turns that had the tool on offer count. */
	observe(turn: TurnInfo): void {
		if (!turn.ok || !turn.text.trim() || !turn.toolkits.some((k) => k.name === THINKING_TOOLKIT)) return;
		this.queue.push(turn);
		if (this.queue.length > this.d.maxQueue) {
			this.queue.shift();
			this.d.log.warn("decisions: thinking-need queue full; dropped the oldest turn");
		}
		this.loop.wake();
	}

	/** `/forget` (plan 0.002 L6): queued turns of these scopes are never asked. */
	forgetScopes(scopes: readonly string[]): void {
		for (let i = this.queue.length - 1; i >= 0; i--) {
			if (scopes.includes(this.queue[i]!.scope)) this.queue.splice(i, 1);
		}
	}

	get pending(): number {
		return this.queue.length;
	}

	start(): void {
		this.loop.start();
	}

	stop(): Promise<void> {
		return this.loop.stop();
	}

	/** Ask what can be asked now; returns how many turns were decided (exposed for tests). */
	async drainOnce(): Promise<number> {
		let done = 0;
		while (this.queue.length > 0) {
			if (!this.d.ready()) break;
			if (this.d.chatPending()) break; // chat first; try again later
			const release = this.d.device.tryAcquire("decision:thinking_need");
			if (!release) break;
			const turn = this.queue.shift()!;
			try {
				await this.decide(turn);
				done++;
			} catch (err) {
				this.d.log.warn("decisions: thinking need failed", { error: (err as Error).message });
			} finally {
				release();
			}
		}
		return done;
	}

	private async decide(turn: TurnInfo): Promise<void> {
		const decision = await this.d.client.ask(THINKING_NEED, {
			scope: turn.scope,
			subjectRef: `turn@${turn.startedAt}`,
			// The pre-decision state only: what was asked. Nothing from the turn's result.
			state: { message: turn.text.slice(0, 4000) },
			questions: [...NEED_QUESTIONS],
		});
		const { calls, answered } = thinkingCalls(this.d.db, turn.scope, turn.startedAt, turn.endedAt);
		const outcome: ThinkingNeedOutcome = {
			called: calls > 0,
			calls,
			answered,
			away: turn.noted?.includes(THINKING_TOOLKIT) === true,
		};
		this.d.client.recordOutcome(decision.id, outcome, "tool_calls");
	}
}
