// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The tool broker (plan M3b; toolkits since plan 0.004 T1; a slice of HLD
 * §9.1). It is the only way a Pi session gets tools, and it decides, from the
 * trusted conversation principal and never from the model, which tools a
 * session may use.
 *
 * - Tools come in **toolkits**: named groups with one permission. A toolkit
 *   whose effect is "read" is for everyone, owner and every contact (owner
 *   decision, plan 0.004 §8); an "act" toolkit is owner-only until per-contact
 *   grants exist.
 * - Tools are always declared in one fixed order (toolkit order, then tool
 *   order). Any change to the declared set, even its order, makes llama.cpp
 *   reprocess the whole conversation (plan 0.004 T0).
 * - The tool set is fixed when a session is built: a session never even sees
 *   a toolkit its principal may not use.
 * - Each call is authorized again at execution time, against the principal
 *   captured when the session was built, so a wrong tool list cannot become
 *   a permission.
 * - Every call, including refusals and failures, is recorded in `tool_calls`.
 * - A turn may make at most `maxCallsPerTurn` calls; the rest are refused, so
 *   a model stuck in a tool loop cannot run forever.
 *
 * Tools here are typed, read-only probes. There is no shell, no interpreter
 * and no argument that can widen what a tool reads.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type { Logger } from "../log.ts";
import type { Route } from "../outbox/outbox.ts";
import type { Db } from "../state/db.ts";
import { recordToolCall } from "../state/tool-calls.ts";

/** `iyye`: Iyye's own background work (plan 0.007): `read` toolkits, and `reach` (plan 0.008, owner decision). */
export type PrincipalKind = "owner" | "contact" | "iyye";

/** Background sessions of plan steps (`kernel/plans.ts`): read-only, whatever Iyye's own work may do. */
export const PLAN_STEP_SCOPE = "iyye:plan:";

/**
 * Who asked in this turn and where a reply to them goes (plan 0.006): set by
 * the scheduler from the triggering event, never by the model. A `self`
 * effect (a reminder) may reach only this route.
 */
export interface TurnContext {
	route: Route;
	contactId: string;
	eventId: string | null;
}

export interface ToolContext {
	scope: string;
	principal: PrincipalKind;
	/** The current turn's asker and route; absent outside a scheduled turn (the console, background work). */
	turn?: TurnContext;
	/** A contact the owner marked trusted (from the kernel's view, never the conversation): may use `reach`. */
	trusted?: boolean;
}

export interface IyyeTool<P extends TSchema = TSchema> {
	name: string;
	label: string;
	/** Shown to the model. */
	description: string;
	/** One line for the system prompt's list of capabilities. */
	summary: string;
	parameters: P;
	run(params: Static<P>, ctx: ToolContext, signal: AbortSignal | undefined): Promise<string>;
}

/** A named group of tools with one permission. */
export interface Toolkit {
	name: string;
	/** Short, for the system prompt and /tools, e.g. "the time and your memory". */
	description: string;
	/**
	 * "read": observes only, for everyone. "self": effects that reach only the
	 * asker's own route (reminders, plan 0.006), for people (owner and contacts),
	 * never Iyye's background work. "reach": messages to other people (plan
	 * 0.008), for the owner, contacts the owner trusts and Iyye's own work
	 * (owner decision). "act": other effects, owner-only until grants exist.
	 */
	effect: "read" | "self" | "reach" | "act";
	tools: IyyeTool[];
}

/** One toolkit as the system prompt lists it. */
export interface ToolkitSummary {
	name: string;
	description: string;
	effect: Toolkit["effect"];
	/** "name: summary" per tool, in declaration order. */
	tools: string[];
}

export interface SessionTools {
	definitions: ToolDefinition[];
	names: string[];
	/** The toolkits this session has, in declaration order. */
	toolkits: ToolkitSummary[];
	/** Called at the start of every turn: resets the per-turn call budget and sets who asked and where. */
	beginTurn(turn?: TurnContext): void;
	/** Refuse every further call this turn (a recovery step must answer, not research). */
	closeTurn(): void;
}

export interface BrokerDeps {
	db: Db;
	/** In declaration order: this order is what the model sees, always. */
	toolkits: Toolkit[];
	log: Logger;
	now?: () => Date;
	newId?: () => string;
	maxCallsPerTurn?: number;
	/** Longest text a tool result may return to the model. */
	maxResultChars?: number;
}

export class ToolBroker {
	private readonly d: Required<BrokerDeps>;
	private readonly kitOf = new Map<string, Toolkit>();

	constructor(deps: BrokerDeps) {
		this.d = {
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			maxCallsPerTurn: 8,
			maxResultChars: 10_000, // a fetched web page is capped at 8,000 characters plus its labels
			...deps,
		};
		const names = new Set<string>();
		const kits = new Set<string>();
		for (const k of deps.toolkits) {
			if (kits.has(k.name)) throw new Error(`duplicate toolkit ${k.name}`);
			kits.add(k.name);
			for (const t of k.tools) {
				if (names.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
				names.add(t.name);
				this.kitOf.set(t.name, k);
			}
		}
	}

	/** Who may use a toolkit. Never decided by the model or by a selection pass. */
	static allowed(kit: Pick<Toolkit, "effect">, principal: PrincipalKind, trusted = false, scope = ""): boolean {
		if (kit.effect === "read") return true;
		if (kit.effect === "self") return principal === "owner" || principal === "contact";
		// A plan step runs a question a contact may have written, approved as a read-only look (0.006 C4): never `reach`.
		if (kit.effect === "reach")
			return principal === "iyye" ? !scope.startsWith(PLAN_STEP_SCOPE) : principal === "owner" || trusted;
		return principal === "owner";
	}

	/** Every toolkit with who may use it (for /tools). */
	get toolkits(): readonly Toolkit[] {
		return this.d.toolkits;
	}

	/** The tools a session in this context may use, bound to that context. */
	forSession(ctx: ToolContext): SessionTools {
		const kits = this.d.toolkits.filter(
			(k) => ToolBroker.allowed(k, ctx.principal, ctx.trusted, ctx.scope) && k.tools.length > 0,
		);
		const permitted = kits.flatMap((k) => k.tools);
		const budget: { used: number; closed: boolean; turn?: TurnContext } = { used: 0, closed: false };
		return {
			definitions: permitted.map((t) => this.definition(t, ctx, budget)),
			names: permitted.map((t) => t.name),
			toolkits: kits.map((k) => ({
				name: k.name,
				description: k.description,
				effect: k.effect,
				tools: k.tools.map((t) => `${t.name}: ${t.summary}`),
			})),
			beginTurn: (turn?: TurnContext) => {
				budget.used = 0;
				budget.closed = false;
				budget.turn = turn;
			},
			closeTurn: () => {
				budget.closed = true;
			},
		};
	}

	private definition(
		tool: IyyeTool,
		ctx: ToolContext,
		budget: { used: number; closed?: boolean; turn?: TurnContext },
	): ToolDefinition {
		return {
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			executionMode: "sequential",
			execute: async (_toolCallId, params, signal) => {
				const startedAt = this.d.now().toISOString();
				const finish = (outcome: "ok" | "denied" | "error", result: string) => {
					recordToolCall(this.d.db, {
						id: this.d.newId(),
						scope: ctx.scope,
						principal: ctx.principal,
						tool: tool.name,
						toolkit: this.kitOf.get(tool.name)?.name ?? null,
						args_json: JSON.stringify(params ?? {}),
						outcome,
						result: result.slice(0, 2000),
						started_at: startedAt,
						finished_at: this.d.now().toISOString(),
					});
					if (outcome !== "ok") this.d.log.warn(`tools: ${tool.name} ${outcome}`, { scope: ctx.scope, result });
					return outcome === "ok"
						? { content: [{ type: "text" as const, text: result }], details: undefined }
						: { content: [{ type: "text" as const, text: result }], details: undefined, isError: true };
				};
				// Authorize again at execution time; the session's tool list is not the permission.
				const kit = this.kitOf.get(tool.name);
				if (!kit || !ToolBroker.allowed(kit, ctx.principal, ctx.trusted, ctx.scope)) {
					return finish("denied", `${tool.name} is not available here`);
				}
				if (budget.closed) return finish("denied", "tools are closed for this reply; answer with what you have");
				if (++budget.used > this.d.maxCallsPerTurn) {
					return finish(
						"denied",
						`tool call limit for this turn (${this.d.maxCallsPerTurn}) reached; answer with what you have`,
					);
				}
				try {
					const text = await tool.run(params as never, { ...ctx, turn: budget.turn }, signal);
					return finish(
						"ok",
						text.length > this.d.maxResultChars ? `${text.slice(0, this.d.maxResultChars)}…` : text,
					);
				} catch (err) {
					return finish("error", `${tool.name} failed: ${(err as Error).message}`);
				}
			},
		};
	}
}
