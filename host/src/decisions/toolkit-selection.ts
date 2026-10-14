// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Toolkit selection (plan 0.004 T4 shadow, §3.4 acting; plan 0.003 §3.2 role 3).
 *
 * `IYYE2_TOOLKIT_SELECTION=act` (the default) uses `ToolkitSelector` before
 * each turn; `shadow` keeps `ToolkitSelectionShadow`, which asks after it.
 * Only one of them runs.
 *
 * For each answered turn: "does this message need <toolkit>?", one `noul`
 * per permitted toolkit other than `core`. The outcome comes free: the
 * toolkits the model actually called in that turn (`tool_calls.toolkit`).
 *
 * - **Shadow by construction:** `observe` returns nothing, and the only
 *   writer of the answers is the decision journal. The tools a session
 *   declares never depend on it.
 * - **Never slows a reply:** the question uses only the message and the
 *   toolkits on offer (the pre-decision state), so it is asked *after* the
 *   turn, from a queue, when the device is free and no chat is waiting. It
 *   takes the shared device slot like memory work, and never waits in line.
 */

import type { DeviceSlot } from "../kernel/device.ts";
import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import type { ToolkitSummary } from "../tools/broker.ts";
import type { DecisionClient, NoulQuestion, Role } from "./client.ts";
import { IdleLoop } from "./idle.ts";

export const CORE_TOOLKIT = "core";

/**
 * Always declared, never selected. `reminders` and `plans` too (a deviation
 * from §3.4, which predates them): without them the operating note says
 * "you cannot schedule anything", so a hidden `reminders` would refuse a
 * reminder outright, and no shadow evidence yet says Kev recognises one.
 * `messaging` (plan 0.008, owner-only) likewise: a hidden one would make Iyye
 * refuse "send Jacob a greeting", the request that motivated it.
 */
export const ALWAYS_ON: readonly string[] = [
	CORE_TOOLKIT,
	"reminders",
	"plans",
	"messaging",
	"thinking",
	"vision",
	// The sandbox (2026-10-12): declared from a session's start, so testing a hypothesis needs no selection.
	"sandbox",
	// Detailed host readings (2026-10-12), owner's sessions only.
	"monitor",
];

export const TOOLKIT_SELECTION: Role = {
	name: "toolkit_selection",
	schemaVersion: 1,
	// Shadow only: the band summarises answers; acting on it is a later owner decision.
	abstain: { low: 0.3, high: 0.6 },
};

/**
 * Acting (§3.4, owner decision 2026-10-04). Only `machine` and `web` are
 * chosen. A toolkit is kept out only when Kev says p < 0.2: the shadow band's
 * 0.3 would have hidden `machine` from "what is your uptime?" (p 0.285, it was
 * used); the highest score of a message that needed no web was 0.27.
 */
export const TOOLKIT_SELECTION_ACTING: Role = {
	name: "toolkit_selection",
	schemaVersion: 2,
	abstain: { low: 0.3, high: 0.6 },
	fallback: "include the toolkit (Kev down, an error, or unsure)",
	mode: "acting",
};
export const INCLUDE_AT = 0.2;

/** What a finished turn tells the shadow role. */
export interface TurnInfo {
	scope: string;
	principal: "owner" | "contact";
	text: string;
	/** The toolkits the session had, in declaration order. */
	toolkits: ToolkitSummary[];
	startedAt: string;
	endedAt: string;
	ok: boolean;
}

/** The questions for one turn (exposed for tests and the report). */
export function selectionQuestions(toolkits: readonly ToolkitSummary[]): NoulQuestion[] {
	return toolkits
		.filter((k) => k.name !== CORE_TOOLKIT)
		.map((k) => ({
			id: k.name,
			instructions: `The state is a message someone sent to their personal assistant. To answer it well, does the assistant need ${k.description}, that is: ${k.tools.map((t) => t.replace(/^[a-z_]+: /, "")).join("; ")}?`,
		}));
}

export class ToolkitSelectionShadow {
	private readonly d: {
		db: Db;
		client: DecisionClient;
		device: DeviceSlot;
		chatPending: () => boolean;
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
		log: Logger;
		maxQueue?: number;
		pollMs?: number;
	}) {
		this.d = { maxQueue: 50, pollMs: 2000, ...deps };
		this.loop = new IdleLoop({ pollMs: this.d.pollMs, drain: () => this.drainOnce() });
	}

	/** Called after every turn; returns nothing on purpose (shadow). */
	observe(turn: TurnInfo): void {
		if (!turn.ok || selectionQuestions(turn.toolkits).length === 0) return;
		this.queue.push(turn);
		if (this.queue.length > this.d.maxQueue) {
			this.queue.shift();
			this.d.log.warn("decisions: toolkit-selection queue full; dropped the oldest turn");
		}
		this.loop.wake();
	}

	/** `/forget` (plan 0.002 L6): queued turns of these scopes are never decided. */
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

	/** Process what can run now; returns how many turns were decided (exposed for tests). */
	async drainOnce(): Promise<number> {
		let done = 0;
		while (this.queue.length > 0) {
			if (this.d.chatPending()) break; // chat first; try again later
			const release = this.d.device.tryAcquire("decision:toolkit_selection");
			if (!release) break;
			const turn = this.queue.shift()!;
			try {
				await this.decide(turn);
				done++;
			} catch (err) {
				this.d.log.warn("decisions: toolkit selection failed", { error: (err as Error).message });
			} finally {
				release();
			}
		}
		return done;
	}

	private async decide(turn: TurnInfo): Promise<void> {
		const questions = selectionQuestions(turn.toolkits);
		const decision = await this.d.client.ask(TOOLKIT_SELECTION, {
			scope: turn.scope,
			subjectRef: `turn@${turn.startedAt}`,
			// The pre-decision state only: what was asked. Nothing from the turn's result.
			state: { message: turn.text.slice(0, 4000) },
			questions,
		});
		const used = usedToolkits(this.d.db, turn);
		this.d.client.recordOutcome(
			decision.id,
			{
				used,
				toolkits: Object.fromEntries(
					questions.map((q) => [
						q.id,
						{
							p: decision.probabilities[q.id] ?? null,
							verdict: decision.verdicts[q.id] ?? null,
							used: used.includes(q.id),
						},
					]),
				),
			},
			"tool_calls",
		);
	}
}

export interface SelectionRequest {
	scope: string;
	principal: "owner" | "contact";
	text: string;
	/** What the broker permits this principal, in declaration order. Never widened here. */
	permitted: readonly ToolkitSummary[];
	/** The toolkits the session declares now (sticky: never removed until the session ends). */
	active: readonly string[];
	/** True when the session has no turn yet: declaring more costs no reprocessing. */
	fresh: boolean;
	signal?: AbortSignal;
}

/**
 * Before a turn: which permitted, not yet active toolkits to add. One Kev call
 * with a `noul` per candidate; no call when there is none. Anything not a
 * confident no is included, and so is everything when Kev cannot answer.
 * Selection can only narrow what the broker permits, and only ever adds.
 */
export class ToolkitSelector {
	private readonly d: { db: Db; client: DecisionClient; log: Logger; now: () => Date };
	/** The decision behind each scope's current turn, joined with its outcome after the turn. */
	private readonly pending = new Map<string, { id: string; added: string[]; keptOut: string[]; fresh: boolean }>();

	constructor(deps: { db: Db; client: DecisionClient; log: Logger; now?: () => Date }) {
		this.d = { now: () => new Date(), ...deps };
	}

	alwaysOn(name: string): boolean {
		return ALWAYS_ON.includes(name);
	}

	async choose(req: SelectionRequest): Promise<string[]> {
		this.pending.delete(req.scope);
		const candidates = req.permitted.filter((k) => !this.alwaysOn(k.name) && !req.active.includes(k.name));
		if (candidates.length === 0) return [];
		const decision = await this.d.client.ask(TOOLKIT_SELECTION_ACTING, {
			scope: req.scope,
			subjectRef: `turn@${this.d.now().toISOString()}`,
			state: { message: req.text.slice(0, 4000) },
			questions: selectionQuestions(candidates),
			...(req.signal ? { signal: req.signal } : {}),
		});
		const added =
			decision.status === "ok"
				? candidates.filter((k) => (decision.probabilities[k.name] ?? 1) >= INCLUDE_AT).map((k) => k.name)
				: candidates.map((k) => k.name);
		const keptOut = candidates.map((k) => k.name).filter((n) => !added.includes(n));
		if (decision.status !== "ok")
			this.d.log.warn("decisions: toolkit selection unavailable; including every toolkit", {
				status: decision.status,
				error: decision.error,
			});
		this.pending.set(req.scope, { id: decision.id, added, keptOut, fresh: req.fresh });
		return added;
	}

	/** After the turn (the sessions' `afterTurn`): what was declared and what the model called. */
	observe(turn: TurnInfo): void {
		const p = this.pending.get(turn.scope);
		if (!p) return;
		this.pending.delete(turn.scope);
		const used = usedToolkits(this.d.db, turn);
		this.d.client.recordOutcome(
			p.id,
			{
				include_at: INCLUDE_AT,
				fresh: p.fresh,
				added: p.added,
				kept_out: p.keptOut,
				declared: turn.toolkits.map((k) => k.name),
				used,
				ok: turn.ok,
			},
			"tool_calls",
		);
	}

	/** `/forget` (plan 0.002 L6). */
	forgetScopes(scopes: readonly string[]): void {
		for (const s of scopes) this.pending.delete(s);
	}
}

/** Toolkits the model called during the turn (any outcome: a call is a need). */
function usedToolkits(db: Db, turn: TurnInfo): string[] {
	return (
		db
			.prepare(
				"SELECT DISTINCT toolkit FROM tool_calls WHERE scope = ? AND started_at >= ? AND started_at <= ? AND toolkit IS NOT NULL ORDER BY toolkit",
			)
			.all(turn.scope, turn.startedAt, turn.endedAt) as { toolkit: string }[]
	).map((r) => r.toolkit);
}
