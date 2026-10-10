// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "./db.ts";

export interface ToolCallRow {
	id: string;
	scope: string;
	principal: "owner" | "contact" | "iyye";
	tool: string;
	/** The toolkit the tool belongs to (plan 0.004); null for calls recorded before toolkits. */
	toolkit: string | null;
	args_json: string;
	outcome: "ok" | "denied" | "error";
	result: string | null;
	started_at: string;
	finished_at: string;
	/** The event of the turn that made the call (plan 0.013 E3); null outside a scheduled turn. */
	event_id?: string | null;
	/** sha256 of the result the model saw. */
	result_hash?: string | null;
}

export function recordToolCall(db: Db, row: ToolCallRow): void {
	db.prepare(
		`INSERT INTO tool_calls (id, scope, principal, tool, toolkit, args_json, outcome, result, started_at, finished_at, event_id, result_hash)
		 VALUES (@id, @scope, @principal, @tool, @toolkit, @args_json, @outcome, @result, @started_at, @finished_at, @event_id, @result_hash)`,
	).run({ event_id: null, result_hash: null, ...row });
}

export function toolCallsForScope(db: Db, scope: string): ToolCallRow[] {
	return db.prepare("SELECT * FROM tool_calls WHERE scope = ? ORDER BY started_at, rowid").all(scope) as ToolCallRow[];
}
