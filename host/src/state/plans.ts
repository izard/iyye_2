// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Plans (plan 0.006 C4, migration 021): typed steps, each done only with its evidence. */

import type { Db } from "./db.ts";

export type PlanState = "proposed" | "authorized" | "active" | "suspended" | "completed" | "failed" | "abandoned";
export type StepStatus = "pending" | "running" | "done" | "blocked" | "failed";

export type PlanStep =
	| {
			kind: "investigate";
			question: string;
			status: StepStatus;
			/** The background session of the running attempt, and how many steps it took. */
			session?: string;
			tries?: number;
			evidence?: string;
			reason?: string;
	  }
	| {
			kind: "remind";
			text: string;
			/** Resolved by the host when the plan was proposed. */
			due_at: string;
			status: StepStatus;
			commitment_id?: string;
			evidence?: string;
			reason?: string;
	  }
	| { kind: "other"; description: string; status: StepStatus; reason?: string }
	/** Something the person does themselves (2026-10-13): Iyye only keeps it on the list; done when they say so. */
	| { kind: "task"; description: string; status: StepStatus; done_by?: string; done_at?: string; reason?: string };

export interface PlanRow {
	id: string;
	intent: string;
	proposer_contact_id: string;
	scope: string;
	route_json: string;
	proposed_via: string;
	created_event_id: string | null;
	steps_json: string;
	state: PlanState;
	authorization: string | null;
	version: number;
	created_at: string;
	updated_at: string;
	authorized_at: string | null;
	settled_at: string | null;
	reason: string | null;
}

export const OPEN_PLAN_STATES: readonly PlanState[] = ["proposed", "authorized", "active", "suspended"];

export function steps(p: PlanRow): PlanStep[] {
	return JSON.parse(p.steps_json) as PlanStep[];
}

export function insertPlan(
	db: Db,
	p: Omit<PlanRow, "version" | "updated_at" | "authorized_at" | "settled_at" | "reason" | "steps_json"> & {
		steps: PlanStep[];
	},
): void {
	db.prepare(
		`INSERT INTO plans (id, intent, proposer_contact_id, scope, route_json, proposed_via, created_event_id, steps_json,
			state, authorization, created_at, updated_at, authorized_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		p.id,
		p.intent,
		p.proposer_contact_id,
		p.scope,
		p.route_json,
		p.proposed_via,
		p.created_event_id,
		JSON.stringify(p.steps),
		p.state,
		p.authorization,
		p.created_at,
		p.created_at,
		p.state === "authorized" ? p.created_at : null,
	);
}

export function getPlan(db: Db, id: string): PlanRow | undefined {
	return db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
}

export function findPlans(db: Db, idPrefix: string): PlanRow[] {
	return db.prepare("SELECT * FROM plans WHERE id LIKE ?").all(`${idPrefix}%`) as PlanRow[];
}

export function plansIn(db: Db, states: readonly PlanState[]): PlanRow[] {
	return db
		.prepare(`SELECT * FROM plans WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at`)
		.all(...states) as PlanRow[];
}

export function recentPlans(db: Db, limit = 15): PlanRow[] {
	return db.prepare("SELECT * FROM plans ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(limit) as PlanRow[];
}

/** Update a plan's state and/or steps. A changed lifecycle state is the only thing `expect` guards. */
export function updatePlan(
	db: Db,
	id: string,
	at: string,
	fields: { state?: PlanState; steps?: PlanStep[]; authorization?: string; reason?: string | null },
	expect?: PlanState[],
): boolean {
	const sets: string[] = ["updated_at = @at"];
	const params: Record<string, unknown> = { id, at };
	if (fields.state) {
		sets.push("state = @state");
		params.state = fields.state;
		if (fields.state === "authorized") sets.push("authorized_at = @at");
		if (["completed", "failed", "abandoned"].includes(fields.state)) sets.push("settled_at = @at");
	}
	if (fields.steps) {
		sets.push("steps_json = @steps");
		params.steps = JSON.stringify(fields.steps);
	}
	if (fields.authorization !== undefined) {
		sets.push("authorization = @authorization");
		params.authorization = fields.authorization;
	}
	if (fields.reason !== undefined) {
		sets.push("reason = @reason");
		params.reason = fields.reason;
	}
	const guard = expect?.length ? ` AND state IN (${expect.map((s) => `'${s}'`).join(", ")})` : "";
	return db.prepare(`UPDATE plans SET ${sets.join(", ")} WHERE id = @id${guard}`).run(params).changes > 0;
}
