// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * `memory_search` (plan 0.002 L3): the model asks a question, the gateway
 * answers from the session's own scope (and, for the owner, contacts'
 * memory, labelled). The model supplies only the query: no bank, scope,
 * contact or person argument exists, so a forged name cannot widen what it
 * reads.
 */

import { Type } from "typebox";
import { formatRecalled, type MemoryGateway } from "../memory/gateway.ts";
import type { IyyeTool } from "./broker.ts";

const PARAMS = Type.Object(
	{ query: Type.String({ minLength: 1, maxLength: 300, description: "What to look for, in a few words" }) },
	{ additionalProperties: false },
);

export function memorySearchTool(gateway: MemoryGateway): IyyeTool<typeof PARAMS> {
	return {
		name: "memory_search",
		label: "Memory search",
		description:
			"Search your memory of earlier conversations with this person: what was said today, and what you remember from before. Returns quoted evidence with dates. Use it when the answer may depend on something said earlier.",
		summary: "look up what was said earlier today and what you remember from before",
		parameters: PARAMS,
		run: async (params, ctx) => {
			// Recall is scoped to a person; Iyye's own background work has no reader yet (plan 0.007 S4).
			if (ctx.principal === "iyye") return "Memory search is not available to background work.";
			const r = await gateway.recall({ scope: ctx.scope, principal: ctx.principal }, params.query, {
				includeIyye: true,
			});
			return r.items.length
				? formatRecalled(r)
				: `Nothing found in memory for that.${r.ltm ? "" : " (Long-term memory is unavailable right now; only today's conversations were searched.)"}`;
		},
	};
}
