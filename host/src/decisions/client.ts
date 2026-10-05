// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed decisions (plan 0.003 §3.3, HLD §9.4): ask the local decision model
 * a set of yes/no (`noul`) questions about one state, validate the answers,
 * and journal everything with the checkpoint that answered.
 *
 * - A **role** fixes the questions' wording and its abstention band; the
 *   state comes from records, never from a model.
 * - Answers outside [0, 1], missing answers or a malformed body are errors,
 *   never guessed. A failure is journaled and the caller goes on: there is no
 *   retry storm and never a hosted fallback.
 * - The caller holds the device: this client never takes the device slot itself.
 */

import { createHash } from "node:crypto";
import type { Db } from "../state/db.ts";
import { isForgotten } from "../state/tombstones.ts";
import type { CheckpointInfo } from "./service.ts";

export type Verdict = "yes" | "no" | "abstain";

export interface NoulQuestion {
	id: string;
	instructions: string;
}

/**
 * A versioned role (plan 0.003 §3.3). Its questions are fixed text built by
 * the role's own module from records, never from model output. Bump
 * `schemaVersion` whenever the questions or the state change: rows of
 * different versions are never pooled.
 */
export interface Role {
	name: string;
	schemaVersion: number;
	/** p ≤ low → no, p ≥ high → yes, between → abstain. */
	abstain: { low: number; high: number };
	/** What Iyye does without the model: the deterministic rule that stays in charge while the role is shadow. */
	fallback?: string;
	/** `acting`: the answer changes what Iyye does (journaled so); default `shadow`. */
	mode?: "shadow" | "acting";
}

/** weak: from another model or process (e.g. extraction); owner: the owner said so. */
export type LabelStrength = "weak" | "owner";

export interface DecisionService {
	/** Null unless the service is up and serving the pinned checkpoint. */
	readonly checkpoint: CheckpointInfo | null;
	readonly baseUrl: string;
	apiKey(): string;
}

export interface Decision {
	id: string;
	status: "ok" | "error" | "skipped";
	error: string | null;
	probabilities: Record<string, number>;
	verdicts: Record<string, Verdict>;
}

export function verdict(p: number, band: Role["abstain"]): Verdict {
	return p >= band.high ? "yes" : p <= band.low ? "no" : "abstain";
}

/** The one writer of outcomes: a weak label never replaces an owner label. */
export function joinOutcome(
	db: Db,
	id: string,
	outcome: unknown,
	source: string,
	strength: LabelStrength,
	at: string,
): boolean {
	return (
		db
			.prepare(
				`UPDATE decisions SET outcome_json = ?, outcome_source = ?, outcome_at = ?, label_strength = ?
				 WHERE id = ? AND (? = 'owner' OR label_strength IS NULL OR label_strength = 'weak')`,
			)
			.run(JSON.stringify(outcome), source, at, strength, id, strength).changes > 0
	);
}

export class DecisionClient {
	private readonly d: { db: Db; service: DecisionService; timeoutMs: number; now: () => Date; newId: () => string };

	constructor(deps: {
		db: Db;
		service: DecisionService;
		timeoutMs?: number;
		now?: () => Date;
		newId?: () => string;
	}) {
		this.d = { timeoutMs: 5000, now: () => new Date(), newId: () => crypto.randomUUID(), ...deps };
	}

	/** Ask and journal. Never throws: failures come back as `error` (or `skipped` when the service is down). */
	async ask(
		role: Role,
		input: {
			scope: string | null;
			subjectRef: string | null;
			state: unknown;
			questions: NoulQuestion[];
			/** An acting call ends with the work that asked for it (e.g. the turn is cancelled). */
			signal?: AbortSignal;
		},
	): Promise<Decision> {
		const id = this.d.newId();
		const stateJson = JSON.stringify(input.state);
		const base = {
			id,
			role: role.name,
			schema_version: role.schemaVersion,
			mode: role.mode ?? "shadow",
			scope: input.scope,
			subject_ref: input.subjectRef,
			state_json: stateJson,
			state_hash: createHash("sha256").update(stateJson).digest("hex"),
			questions_json: JSON.stringify(input.questions),
			created_at: this.d.now().toISOString(),
		};
		const ck = this.d.service.checkpoint;
		if (!ck) {
			this.insert({ ...base, status: "skipped", error: "the decision service is not up" });
			return { id, status: "skipped", error: "the decision service is not up", probabilities: {}, verdicts: {} };
		}
		const started = Date.now();
		try {
			const res = await fetch(`${this.d.service.baseUrl}/v1/systemone`, {
				method: "POST",
				headers: { authorization: `Bearer ${this.d.service.apiKey()}`, "content-type": "application/json" },
				body: JSON.stringify({
					model: "kev-latest",
					state: input.state,
					questions: Object.fromEntries(
						input.questions.map((q) => [q.id, { type: "noul", instructions: q.instructions }]),
					),
				}),
				signal: input.signal
					? AbortSignal.any([input.signal, AbortSignal.timeout(this.d.timeoutMs)])
					: AbortSignal.timeout(this.d.timeoutMs),
			});
			const text = await res.text();
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
			const body = JSON.parse(text) as { answers?: Record<string, { noul?: unknown }>; truncated?: unknown };
			// A server that cut the state answered about something else: never use it (Kev refuses by default).
			if (body.truncated === true) throw new Error("the state was truncated by the server");
			// The checkpoint must be the one that was up when the call began (HLD §15 #17).
			const now = this.d.service.checkpoint;
			if (!now || now.run !== ck.run) throw new Error("the checkpoint changed during the call");
			const answers = body.answers ?? {};
			const probabilities: Record<string, number> = {};
			for (const q of input.questions) {
				const p = answers[q.id]?.noul;
				if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)
					throw new Error(`no valid answer for ${q.id}`);
				probabilities[q.id] = p;
			}
			const verdicts = Object.fromEntries(
				Object.entries(probabilities).map(([q, p]) => [q, verdict(p, role.abstain)]),
			);
			this.insert({
				...base,
				status: "ok",
				error: null,
				checkpoint: ck.run,
				base_model: ck.base,
				temperature: ck.temperature,
				backend: ck.backend,
				lora: ck.lora,
				dtype: ck.dtype,
				answers_json: JSON.stringify(answers),
				verdicts_json: JSON.stringify(verdicts),
				latency_ms: Date.now() - started,
			});
			return { id, status: "ok", error: null, probabilities, verdicts };
		} catch (err) {
			const message = (err as Error).message;
			this.insert({
				...base,
				status: "error",
				error: message,
				checkpoint: ck.run,
				latency_ms: Date.now() - started,
			});
			return { id, status: "error", error: message, probabilities: {}, verdicts: {} };
		}
	}

	/**
	 * Journal a call that was not made (the device was busy, chat was waiting).
	 * Not retried: a shadow question is evidence, not work that must happen.
	 */
	skip(
		role: Role,
		input: { scope: string | null; subjectRef: string | null; state: unknown; questions: NoulQuestion[] },
		reason: string,
	): string {
		const id = this.d.newId();
		const stateJson = JSON.stringify(input.state);
		this.insert({
			id,
			role: role.name,
			schema_version: role.schemaVersion,
			mode: role.mode ?? "shadow",
			scope: input.scope,
			subject_ref: input.subjectRef,
			state_json: stateJson,
			state_hash: createHash("sha256").update(stateJson).digest("hex"),
			questions_json: JSON.stringify(input.questions),
			created_at: this.d.now().toISOString(),
			status: "skipped",
			error: reason,
		});
		return id;
	}

	/**
	 * Join what actually happened (shadow outcome) to a journaled decision.
	 * Labels are never self-generated: the source is a record or the owner.
	 * A weak label never replaces an owner label. Returns false when nothing changed.
	 */
	recordOutcome(id: string, outcome: unknown, source: string, strength: LabelStrength = "weak"): boolean {
		return joinOutcome(this.d.db, id, outcome, source, strength, this.d.now().toISOString());
	}

	private insert(row: Record<string, unknown>): void {
		// `/forget` may have run while the call was in flight: what it removed is not written back.
		const scope = row.scope as string | null;
		if (scope && isForgotten(this.d.db, scope, row.created_at as string)) return;
		if (
			row.subject_ref &&
			this.d.db
				.prepare(
					"SELECT 1 FROM decisions WHERE role = ? AND subject_ref = ? AND status = 'skipped' AND error = 'forgotten'",
				)
				.get(row.role, row.subject_ref)
		) {
			return;
		}
		const cols = Object.keys(row);
		this.d.db
			.prepare(`INSERT INTO decisions (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`)
			.run(row);
	}
}
