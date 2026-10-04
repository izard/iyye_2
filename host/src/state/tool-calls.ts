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
}

export function recordToolCall(db: Db, row: ToolCallRow): void {
	db.prepare(
		`INSERT INTO tool_calls (id, scope, principal, tool, toolkit, args_json, outcome, result, started_at, finished_at)
		 VALUES (@id, @scope, @principal, @tool, @toolkit, @args_json, @outcome, @result, @started_at, @finished_at)`,
	).run(row);
}

export function toolCallsForScope(db: Db, scope: string): ToolCallRow[] {
	return db.prepare("SELECT * FROM tool_calls WHERE scope = ? ORDER BY started_at, rowid").all(scope) as ToolCallRow[];
}
