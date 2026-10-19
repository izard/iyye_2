// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** The owner's `/tools` report (plan 0.004 T1): toolkits, who has them, and the latest calls. */

import { getContact } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import type { ToolCallRow } from "../state/tool-calls.ts";
import type { Toolkit } from "./broker.ts";

export function toolsReport(db: Db, toolkits: readonly Toolkit[], recent = 10): string {
	const lines = ["toolkits, in declaration order:"];
	for (const k of toolkits) {
		const who = {
			read: "everyone (read-only)",
			self: "the owner and contacts, to their own chat",
			reach: "the owner, trusted contacts and Iyye itself",
			act: "the owner and trusted contacts (has effects)",
			private: "the owner and Iyye itself (read-only)",
			trusted: "the owner and trusted contacts (read-only)",
			compute: "the owner and Iyye itself (runs code in a sandbox; not evidence)",
			send: "the owner and trusted contacts (has effects)",
		}[k.effect];
		lines.push(`  ${k.name} — ${k.description} · ${who}`);
		for (const t of k.tools) lines.push(`    ${t.name}: ${t.summary}`);
	}
	const calls = db
		.prepare("SELECT * FROM tool_calls ORDER BY started_at DESC, rowid DESC LIMIT ?")
		.all(recent) as ToolCallRow[];
	if (calls.length === 0) {
		lines.push("no tool calls yet");
	} else {
		lines.push(`last ${calls.length} call(s):`);
		for (const c of calls) {
			const who =
				c.scope === "owner"
					? "you"
					: c.scope.startsWith("contact:")
						? (getContact(db, c.scope.slice("contact:".length))?.display_name ?? c.scope)
						: c.scope;
			lines.push(
				`  ${c.started_at.slice(0, 16).replace("T", " ")} ${who}: ${c.toolkit ? `${c.toolkit}/` : ""}${c.tool} → ${c.outcome}${c.outcome === "ok" ? "" : ` (${(c.result ?? "").slice(0, 80)})`}`,
			);
		}
	}
	return lines.join("\n");
}
