// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Reply review, shadow only (plan 0.003 §3.2 role 2, K3).
 *
 * After each delivered reply: "does the reply promise a future action Iyye
 * would take on its own (a reminder, a follow-up, contacting someone)?". Iyye
 * has no way to keep such a promise yet, so a "yes" marks a reply that broke
 * the identity prompt's rule. Labels come from the owner (`/decisions label`)
 * and, later, from the commitments ledger.
 *
 * - **Shadow by construction:** nothing reads the answer; the reply is
 *   already delivered.
 * - **Restart-safe and idle-gated:** the work list is the delivered replies
 *   in SQLite that have no review yet (since the role was first started),
 *   asked one at a time when the decision service is up, the device is free
 *   and no chat is waiting.
 * - Forgotten replies (`/forget`) are never reviewed.
 */

import { createHash } from "node:crypto";
import type { DeviceSlot } from "../kernel/device.ts";
import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import { getEvent, messageText } from "../state/events.ts";
import { getKv, setKv } from "../state/kv.ts";
import type { DecisionClient, NoulQuestion, Role } from "./client.ts";
import { IdleLoop } from "./idle.ts";

export const REPLY_REVIEW: Role = {
	name: "reply_review",
	// 2 (plan 0.006 C2): adds `claims_arranged`, and the commitments ledger labels every answer.
	// 3 (plan 0.010 M2): adds `admits_unknown`, `owner_intention` and `dated_event`, the Kev versions of the M2
	// detectors (`motivation/detectors.ts`), shadow: nothing reads them; only `/decisions label` labels them.
	schemaVersion: 3,
	abstain: { low: 0.35, high: 0.65 },
	fallback: "none: the identity prompt tells the model not to promise future actions; nothing checks the reply",
};

export const PROMISE_QUESTION: NoulQuestion = {
	id: "promises_future_action",
	instructions:
		"The state is an assistant's reply. Does the reply promise or offer a future action the assistant would take later on its own, such as a reminder, a follow-up, flagging or watching for something, or contacting someone?",
};

/**
 * Plan 0.006 C0: "promises or offers" cannot tell a claim from an offer or a
 * clarifying question; this one can (honest replies ≤ 0.27, the one false
 * claim 0.86). With the ledger it makes the label: a reply that claims
 * something is set up, in a turn that created no commitment, is unsupported.
 */
export const CLAIM_QUESTION: NoulQuestion = {
	id: "claims_arranged",
	instructions:
		'The state is a person\'s message and an assistant\'s reply. Does the reply say that the assistant has already set up a reminder or some other future action (for example "I\'ve set a reminder", "I will remind you at 9"), rather than asking for details, offering to do it, or only answering?',
};

/** Plan 0.010 M2, shadow: the reply says Iyye did not know or could not find the answer. */
export const UNKNOWN_QUESTION: NoulQuestion = {
	id: "admits_unknown",
	instructions:
		"The state is a person's message and an assistant's reply. Does the reply say the assistant does not know the answer, or could not find or verify it?",
};

/** Plan 0.010 M2, shadow: the person states an intention to do something concrete (used for the owner only). */
export const INTENTION_QUESTION: NoulQuestion = {
	id: "owner_intention",
	instructions:
		"The state is a person's message and an assistant's reply. Does the person's message state that they intend or want to do something concrete themselves (not a question, not a request to the assistant)?",
};

/** Plan 0.010 M2, shadow: the person mentions an event of theirs on a particular date. */
export const DATED_EVENT_QUESTION: NoulQuestion = {
	id: "dated_event",
	instructions:
		"The state is a person's message and an assistant's reply. Does the person's message mention an event in their own life on a particular day or date (an exam, a trip, an appointment), other than a reminder they ask for?",
};

/** The commitments the turn that produced this reply created (the ledger fact, plan 0.006 C2), plans included (C4). */
export function commitmentsOfReply(db: Db, actionId: string): string[] {
	const reminders = (
		db
			.prepare(
				"SELECT c.id FROM commitments c JOIN actions a ON a.event_id = c.created_event_id WHERE a.id = ? AND c.created_by NOT LIKE 'plan:%' ORDER BY c.created_at",
			)
			.all(actionId) as { id: string }[]
	).map((r) => r.id);
	// A plan the turn authorized at once is arranged too (plan 0.006 C4); one only proposed is not.
	const plans = (
		db
			.prepare(
				"SELECT p.id FROM plans p JOIN actions a ON a.event_id = p.created_event_id WHERE a.id = ? AND p.authorization LIKE 'auto:%' ORDER BY p.created_at",
			)
			.all(actionId) as { id: string }[]
	).map((r) => `plan:${r.id}`);
	// A message the turn sent for the owner (plan 0.008) is a recorded effect too: "I sent Jacob…" is supported.
	const sends = (
		db
			.prepare(
				"SELECT s.id FROM sent_messages s JOIN actions a ON a.event_id = s.requested_event_id WHERE a.id = ? ORDER BY s.created_at",
			)
			.all(actionId) as { id: string }[]
	).map((r) => `send:${r.id}`);
	return [...reminders, ...plans, ...sends];
}

const SINCE_KEY = "decisions.reply_review.since";

/** The reason on a marker row that keeps a reply out of review for good (`/forget`). */
export const FORGOTTEN_REASON = "forgotten";

/**
 * `/forget` (plan 0.002 L6): these replies may quote a forgotten person. Their
 * reviews are deleted, and a marker row with an empty state takes their place,
 * so they are never reviewed again (the work list skips any reply with a row)
 * and a review still in flight is not written (the client checks the marker).
 * Call inside the forget transaction.
 */
export function forgetReplyReviews(db: Db, actionIds: readonly string[], at: string): void {
	const empty = JSON.stringify("");
	for (const id of actionIds) {
		db.prepare("DELETE FROM decisions WHERE role = ? AND subject_ref = ?").run(REPLY_REVIEW.name, id);
		db.prepare(
			`INSERT INTO decisions (id, role, schema_version, mode, scope, subject_ref, state_json, state_hash, questions_json, status, error, created_at)
			 VALUES (?, ?, ?, 'shadow', NULL, ?, ?, ?, '[]', 'skipped', ?, ?)`,
		).run(
			crypto.randomUUID(),
			REPLY_REVIEW.name,
			REPLY_REVIEW.schemaVersion,
			id,
			empty,
			createHash("sha256").update(empty).digest("hex"),
			FORGOTTEN_REASON,
			at,
		);
	}
}

interface PendingReply {
	id: string;
	event_id: string;
	content: string;
	created_at: string;
}

export class ReplyReviewShadow {
	private readonly d: {
		db: Db;
		client: DecisionClient;
		device: DeviceSlot;
		chatPending: () => boolean;
		ready: () => boolean;
		log: Logger;
		pollMs: number;
		now: () => Date;
	};
	private readonly loop: IdleLoop;

	constructor(deps: {
		db: Db;
		client: DecisionClient;
		device: DeviceSlot;
		chatPending: () => boolean;
		/** The decision service is up. The work list is durable, so until then it waits rather than skips. */
		ready?: () => boolean;
		log: Logger;
		pollMs?: number;
		now?: () => Date;
	}) {
		this.d = { pollMs: 5000, now: () => new Date(), ready: () => true, ...deps };
		// Replies delivered before the role first started are history, not work.
		if (!getKv(this.d.db, SINCE_KEY)) {
			const at = this.d.now().toISOString();
			setKv(this.d.db, SINCE_KEY, at, at);
		}
		this.loop = new IdleLoop({ pollMs: this.d.pollMs, drain: () => this.drainOnce() });
	}

	/** Delivered replies still waiting for a review. */
	get pending(): number {
		return (
			this.d.db.prepare(`SELECT count(*) AS n FROM (${PENDING_SQL})`).get(this.since(), REPLY_REVIEW.name) as {
				n: number;
			}
		).n;
	}

	start(): void {
		this.loop.start();
	}

	stop(): Promise<void> {
		return this.loop.stop();
	}

	/** A reply was just delivered: look sooner than the poll interval. */
	wake(): void {
		this.loop.wake();
	}

	/** Review what can run now; returns how many replies were reviewed (exposed for tests). */
	async drainOnce(): Promise<number> {
		let done = 0;
		for (;;) {
			if (!this.d.ready()) break; // a reply asked now would be journaled as skipped, never reviewed
			if (this.d.chatPending()) break; // chat first
			const next = this.d.db.prepare(`${PENDING_SQL} LIMIT 1`).get(this.since(), REPLY_REVIEW.name) as
				| PendingReply
				| undefined;
			if (!next) break;
			const release = this.d.device.tryAcquire("decision:reply_review");
			if (!release) break;
			try {
				const event = getEvent(this.d.db, next.event_id);
				const decision = await this.d.client.ask(REPLY_REVIEW, {
					scope: event?.scope ?? null,
					subjectRef: next.id,
					// What was asked and what was delivered: nothing that happened afterwards.
					state: { message: event ? messageText(event) : "", reply: next.content },
					questions: [
						PROMISE_QUESTION,
						CLAIM_QUESTION,
						UNKNOWN_QUESTION,
						INTENTION_QUESTION,
						DATED_EVENT_QUESTION,
					],
				});
				if (decision.status === "ok") {
					// The ledger's fact, a weak label: did that turn create a commitment? The owner's label wins.
					const made = commitmentsOfReply(this.d.db, next.id);
					this.d.client.recordOutcome(
						decision.id,
						{ commitment_created: made.length > 0, commitments: made },
						"commitments_ledger",
						"weak",
					);
				}
				done++;
			} catch (err) {
				this.d.log.warn("decisions: reply review failed", { error: (err as Error).message });
				break;
			} finally {
				release();
			}
		}
		return done;
	}

	private since(): string {
		return getKv(this.d.db, SINCE_KEY) ?? this.d.now().toISOString();
	}
}

/** Delivered replies since the watermark with no review row (any status: a skipped review is not retried). */
const PENDING_SQL = `SELECT a.id, a.event_id, a.content, a.created_at FROM actions a
	WHERE a.kind = 'reply' AND a.state = 'delivered' AND a.content IS NOT NULL AND a.content != '[forgotten]'
	AND a.event_id IS NOT NULL AND a.created_at >= ?
	AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.role = ? AND d.subject_ref = a.id)
	ORDER BY a.created_at, a.rowid`;
