// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistent Pi conversations, one per scope (plan M3, HLD §6.2: a scope's
 * session is its conversation history, not a new memory bank per chat).
 *
 * Each session is created with every Pi default overridden:
 * - model runtime: the local-only runtime (runtime.ts);
 * - settings: in memory, telemetry and cache warming off, Pi's own retries
 *   off (the kernel decides retries), no request timeout (a slow local
 *   answer beats a timed-out one);
 * - resources: nothing discovered from disk, the system prompt is Iyye's;
 * - tools: only what the tool broker grants this scope's principal, by exact
 *   name, so Pi's built-in bash/read/edit/write stay off (none at all when
 *   there is no broker or nothing is granted);
 * - cwd: "/" — Pi writes the cwd into the system prompt, and the real state
 *   directory path would show the owner's home folder to every contact. With
 *   no tools and no resource discovery Pi never reads or writes there.
 * - agentDir: an empty directory under the Iyye state dir, so no Pi default
 *   ever falls back to ~/.pi.
 *
 * - memory (plan 0.002 L3): before each turn the memory gateway recalls
 *   evidence for the turn's text; an inline `context` extension inserts it
 *   as a separate message before the user's message in each model request.
 *   Pi restores the messages afterwards, so the recalled block is never
 *   stored in the transcript or retained as an episode.
 *
 * Turns in one scope run strictly one after another, so each reply belongs to
 * exactly one message. Different scopes are independent here; the kernel's
 * scheduler (M7) limits how many run on the device at once.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	type ExtensionFactory,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SelectionRequest, TurnInfo } from "../../decisions/toolkit-selection.ts";
import type { Logger } from "../../log.ts";
import type { Db } from "../../state/db.ts";
import {
	forgetSession,
	getSessionFile,
	recordSessionFile,
	retireSessions,
	touchSession,
} from "../../state/sessions.ts";
import type { SessionTools, ToolBroker, ToolkitSummary, TurnContext } from "../../tools/broker.ts";
import { currentTurnStart, HOST_NOTE_PREFIX, trimEarlierToolResults } from "./context.ts";
import { composeSystemPrompt, type ScopeView } from "./prompt.ts";
import { IyyeResourceLoader, loadInlineExtensions } from "./resources.ts";
import { localModel } from "./runtime.ts";
import { runTurn, type TurnResult } from "./turn.ts";

export interface ConversationsDeps {
	db: Db;
	runtime: ModelRuntime;
	stateDir: string;
	identity: string;
	log: Logger;
	now?: () => Date;
	/** Sessions kept open; idle ones beyond this are disposed and reopen from file. */
	maxLive?: number;
	/** Grants tools per scope; without it no session has tools. */
	tools?: ToolBroker | null;
	/** Recalls per-turn evidence; without it turns get no recalled memory. */
	memory?: TurnMemory | null;
	/** Told about every finished turn (shadow decision roles); it cannot change the turn. */
	afterTurn?: ((turn: TurnInfo) => void) | null;
	/**
	 * Request-local notes for a scope's turn, added next to recalled memory and
	 * never stored in the transcript: e.g. reminders Iyye just sent in that chat
	 * (plan 0.006, owner choice), so it knows what "done, thanks" answers.
	 */
	turnNotes?: ((scope: string) => string | null) | null;
	/**
	 * Toolkit selection, acting (plan 0.004 §3.4). Without it every permitted
	 * toolkit is declared, as before. With it a person's session starts with the
	 * always-on toolkits, and before each turn the selector may add more; they
	 * stay for the rest of the session (each change reprocesses the whole
	 * conversation). Background sessions never select.
	 */
	toolkitSelection?: {
		alwaysOn(name: string): boolean;
		choose(req: SelectionRequest): Promise<string[]>;
	} | null;
}

/** What sessions need from the memory gateway. */
export interface TurnMemory {
	contextBlock(reader: { scope: string; principal: "owner" | "contact" }, query: string): Promise<string | null>;
}

export interface TurnRequest {
	scope: string;
	view: ScopeView;
	/** Registry name of the model this turn must use (bound by the scheduler). */
	model: string;
	text: string;
	signal?: AbortSignal;
	/** Who asked and where (plan 0.006): tools with a `self` effect reach only this route. */
	turn?: TurnContext;
}

interface LiveSession {
	session: AgentSession;
	/** The prompt for every permitted toolkit: it identifies the grants, so a change in them reopens the session. */
	prompt: string;
	/** The toolkits declared to the model, in declaration order; the model's prompt lists exactly these. */
	active: string[];
	view: ScopeView;
	loader: IyyeResourceLoader;
	tools: SessionTools | null;
	lastUsed: number;
	/** The current turn's recalled evidence, read by the session's `context` hook. */
	recall: TurnState;
}

export class PiConversations {
	private readonly d: Required<ConversationsDeps>;
	private readonly live = new Map<string, LiveSession>();
	private readonly chains = new Map<string, Promise<unknown>>();
	private readonly cwd: string;
	private readonly agentDir: string;

	constructor(deps: ConversationsDeps) {
		this.d = {
			now: () => new Date(),
			maxLive: 8,
			tools: null,
			memory: null,
			afterTurn: null,
			turnNotes: null,
			toolkitSelection: null,
			...deps,
		};
		this.cwd = "/";
		this.agentDir = join(deps.stateDir, "pi-agent");
		mkdirSync(this.agentDir, { recursive: true });
	}

	/** Run one turn in a scope after any earlier turn in that scope has finished. */
	turn(req: TurnRequest): Promise<TurnResult> {
		const previous = this.chains.get(req.scope) ?? Promise.resolve();
		const run = previous.then(
			() => this.runInScope(req),
			() => this.runInScope(req),
		);
		const tail = run.catch(() => undefined);
		this.chains.set(req.scope, tail);
		void tail.then(() => {
			if (this.chains.get(req.scope) === tail) this.chains.delete(req.scope);
		});
		return run;
	}

	/** The Pi transcript file backing a scope, if one exists. */
	sessionFile(scope: string): string | null {
		return getSessionFile(this.d.db, scope);
	}

	/**
	 * Start every conversation afresh (after a completed night): wait for any
	 * turn in progress, close the live sessions and retire their transcripts.
	 * Continuity across days comes from memory, not from the chat history.
	 */
	async resetAll(): Promise<number> {
		await this.disposeAll();
		return retireSessions(this.d.db);
	}

	/**
	 * `/forget` (plan 0.002 L6): close these scopes' live sessions and delete
	 * their transcripts, current and retired. Returns how many directories went.
	 */
	async forgetScopes(scopes: readonly string[]): Promise<number> {
		let removed = 0;
		for (const scope of scopes) {
			await this.chains.get(scope)?.catch(() => undefined);
			const live = this.live.get(scope);
			if (live) {
				live.session.dispose();
				this.live.delete(scope);
			}
			forgetSession(this.d.db, scope);
			const dir = join(this.d.stateDir, "sessions", encodeURIComponent(scope));
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
				removed++;
			}
		}
		return removed;
	}

	/** Start these scopes' conversations afresh (as after a night); their transcript files stay. */
	async retireScopes(scopes: readonly string[]): Promise<void> {
		for (const scope of scopes) {
			await this.chains.get(scope)?.catch(() => undefined);
			const live = this.live.get(scope);
			if (live) {
				live.session.dispose();
				this.live.delete(scope);
			}
			forgetSession(this.d.db, scope);
		}
	}

	async disposeAll(): Promise<void> {
		await Promise.allSettled([...this.chains.values()]);
		for (const [scope, live] of this.live) {
			live.session.dispose();
			this.live.delete(scope);
		}
	}

	private async runInScope(req: TurnRequest): Promise<TurnResult> {
		let session: AgentSession;
		let live: LiveSession;
		try {
			live = await this.open(req.scope, req.view, req.model);
			await this.selectToolkits(live, req);
			live.tools?.beginTurn(req.turn);
			session = live.session;
			if (session.model?.id !== req.model) {
				// Recorded in the transcript as a model change; persist: false keeps global defaults untouched.
				await session.setModel(localModel(this.d.runtime, req.model), { persist: false });
			}
		} catch (err) {
			return { ok: false, reason: "error", message: (err as Error).message };
		}
		const notes = req.view.kind === "background" ? null : (this.d.turnNotes?.(req.scope) ?? null);
		live.recall.block = [await this.recallFor(req), notes].filter(Boolean).join("\n\n") || null;
		const startedAt = this.d.now().toISOString();
		let result: TurnResult;
		try {
			result = await runTurn(session, req.text, req.signal);
			if (!result.ok && (result.reason === "truncated" || result.reason === "empty") && !req.signal?.aborted) {
				// The reply ended without an answer: cut off at the output limit after research, or a reasoning
				// model that thought and stopped with no text (2026-10-03). One recovery step, with thinking
				// off for that request so it cannot loop again. After a cut-off the tools are closed (answer
				// from what was found); after an empty reply they stay open within the turn's budget.
				this.d.log.warn("pi: reply ended without an answer; asking for it", {
					scope: req.scope,
					reason: result.reason,
				});
				if (result.reason === "truncated") live.tools?.closeTurn();
				else if (this.d.toolkitSelection && live.tools && req.view.kind !== "background") {
					// The recovery says "look it up with your tools": every permitted toolkit is declared for it
					// (one reprocessing, on a failure path; the 2026-10-03 incident needed web).
					const all = live.tools.toolkits.map((k) => k.name);
					if (all.length > live.active.length) this.declareToolkits(live, all);
				}
				live.recall.noThinking = true;
				const recovered = await runTurn(
					session,
					result.reason === "truncated" ? RECOVERY_NOTE : RECOVERY_NOTE_EMPTY,
					req.signal,
				);
				if (recovered.ok) result = recovered;
			}
		} finally {
			live.recall.block = null;
			live.recall.noThinking = false;
		}
		try {
			if (req.view.kind !== "background")
				this.d.afterTurn?.({
					scope: req.scope,
					principal: req.view.kind,
					text: req.text,
					toolkits: (live.tools?.toolkits ?? []).filter((k) => live.active.includes(k.name)),
					startedAt,
					endedAt: this.d.now().toISOString(),
					ok: result.ok,
				});
		} catch (err) {
			this.d.log.warn("pi: after-turn observer failed", { error: (err as Error).message });
		}
		touchSession(this.d.db, req.scope, this.d.now().toISOString());
		this.evictIdle(req.scope);
		return result;
	}

	/** Plan 0.004 §3.4: add the toolkits this turn needs. Only adds; a failure adds everything permitted. */
	private async selectToolkits(live: LiveSession, req: TurnRequest): Promise<void> {
		const sel = this.d.toolkitSelection;
		if (!sel || !live.tools || req.view.kind === "background") return;
		const permitted = live.tools.toolkits;
		let add: string[];
		try {
			add = await sel.choose({
				scope: req.scope,
				principal: req.view.kind,
				text: req.text,
				permitted,
				active: live.active,
				fresh: live.session.messages.length === 0,
				...(req.signal ? { signal: req.signal } : {}),
			});
		} catch (err) {
			this.d.log.warn("pi: toolkit selection failed; declaring every toolkit", { error: (err as Error).message });
			add = permitted.map((k) => k.name);
		}
		// Never wider than the broker's grant, never narrower than what is declared.
		const next = permitted.map((k) => k.name).filter((n) => live.active.includes(n) || add.includes(n));
		if (next.length === live.active.length) return;
		this.d.log.info("pi: toolkits added", {
			scope: req.scope,
			added: next.filter((n) => !live.active.includes(n)),
			fresh: live.session.messages.length === 0,
		});
		this.declareToolkits(live, next);
	}

	/** Declare exactly these toolkits, in the broker's order, with a prompt that lists exactly them. */
	private declareToolkits(live: LiveSession, active: string[]): void {
		const kits = (live.tools?.toolkits ?? []).filter((k) => active.includes(k.name));
		live.active = kits.map((k) => k.name);
		live.loader.setSystemPrompt(composeSystemPrompt(this.d.identity, live.view, kits));
		live.session.setActiveToolsByName(this.toolNames(live.tools, kits));
	}

	private toolNames(tools: SessionTools | null, kits: readonly ToolkitSummary[]): string[] {
		const wanted = new Set(kits.map((k) => k.name));
		return (tools?.toolkits ?? [])
			.filter((k) => wanted.has(k.name))
			.flatMap((k) => k.tools.map((t) => t.slice(0, t.indexOf(":"))));
	}

	private async recallFor(req: TurnRequest): Promise<string | null> {
		if (!this.d.memory || req.view.kind === "background") return null;
		try {
			return await this.d.memory.contextBlock({ scope: req.scope, principal: req.view.kind }, req.text);
		} catch (err) {
			// No memory is better than no answer; nothing is made up in its place.
			this.d.log.warn("pi: recall failed; answering without memory", {
				scope: req.scope,
				error: (err as Error).message,
			});
			return null;
		}
	}

	private async open(scope: string, view: ScopeView, model: string): Promise<LiveSession> {
		// The principal comes from the trusted view the kernel built, never from the conversation.
		// Background work is the principal `iyye`: read-only toolkits only (ToolBroker.allowed).
		const principal = view.kind === "background" ? "iyye" : view.kind;
		// Trust too comes from the kernel's view; a change in it changes the grants, so the session reopens.
		const trusted = view.kind === "contact" && view.trusted === true;
		const tools = this.d.tools?.forSession({ scope, principal, trusted }) ?? null;
		const prompt = composeSystemPrompt(this.d.identity, view, tools?.toolkits ?? []);
		const existing = this.live.get(scope);
		if (existing && existing.prompt === prompt) {
			existing.lastUsed = Date.now();
			return existing;
		}
		if (existing) {
			// The view or the granted tools changed: reopen with the new prompt and tool set.
			existing.session.dispose();
			this.live.delete(scope);
		}
		const sessionDir = join(this.d.stateDir, "sessions", encodeURIComponent(scope));
		mkdirSync(sessionDir, { recursive: true });
		const recorded = getSessionFile(this.d.db, scope);
		const manager =
			recorded && existsSync(recorded)
				? SessionManager.open(recorded, sessionDir, this.cwd)
				: SessionManager.create(this.cwd, sessionDir);
		const file = manager.getSessionFile();
		if (!file) throw new Error(`Pi did not assign a session file for scope ${scope}`);
		if (file !== recorded) recordSessionFile(this.d.db, scope, file, this.d.now().toISOString());

		const recall: TurnState = { block: null, noThinking: false };
		// Plan 0.004 §3.4: a person's session declares the always-on toolkits plus what earlier turns added.
		// Pi's `tools` option would declare all of them on every reopen, so the transcript's loadout is restored here.
		const permittedKits = tools?.toolkits ?? [];
		const selecting = Boolean(this.d.toolkitSelection && tools && view.kind !== "background");
		let active = permittedKits.map((k) => k.name);
		if (selecting) {
			const declared = new Set(getCurrentTools(manager.buildSessionContext().messages).map((t) => t.name));
			active = permittedKits
				.filter(
					(k) =>
						this.d.toolkitSelection!.alwaysOn(k.name) || this.toolNames(tools, [k]).some((n) => declared.has(n)),
				)
				.map((k) => k.name);
		}
		const loader = new IyyeResourceLoader(
			composeSystemPrompt(
				this.d.identity,
				view,
				permittedKits.filter((k) => active.includes(k.name)),
			),
			await loadInlineExtensions([contextHook(recall)], this.cwd, this.agentDir),
		);
		const { session } = await createAgentSession({
			cwd: this.cwd,
			agentDir: this.agentDir,
			modelRuntime: this.d.runtime,
			model: localModel(this.d.runtime, model),
			thinkingLevel: "off",
			...(tools && tools.names.length > 0
				? { customTools: tools.definitions, tools: tools.names }
				: { noTools: "all" as const }),
			resourceLoader: loader,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({
				enableInstallTelemetry: false,
				enableAnalytics: false,
				cacheWarming: "off",
				retry: { enabled: false, provider: { maxRetries: 0 } },
				// 0 disables it; Pi then uses about 24 days as the request timeout (it uses this value for the
				// whole request). A thinking model at 8 tokens/s can take far longer than any fixed limit.
				httpIdleTimeoutMs: 0,
				defaultThinkingLevel: "off",
			}),
		});
		const live: LiveSession = { session, prompt, active, view, loader, tools, lastUsed: Date.now(), recall };
		// Every permitted tool is registered (so one can be added later); only the active ones are declared.
		if (selecting) this.declareToolkits(live, active);
		this.live.set(scope, live);
		this.d.log.info("pi: session opened", { scope, file, resumed: file === recorded, tools: tools?.names ?? [] });
		return live;
	}

	private evictIdle(current: string): void {
		if (this.live.size <= this.d.maxLive) return;
		const idle = [...this.live]
			.filter(([scope, l]) => scope !== current && !this.chains.has(scope) && !l.session.isStreaming)
			.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		for (const [scope, l] of idle.slice(0, this.live.size - this.d.maxLive)) {
			l.session.dispose();
			this.live.delete(scope);
		}
	}
}

/** Sent as a user-role message, clearly labelled, when a reply ran out of room before answering. */
/** Request-local state the context hook reads: recalled evidence, and a recovery step's thinking switch. */
interface TurnState {
	block: string | null;
	/** True during a recovery step: the request goes out with thinking off, whatever the model's setting. */
	noThinking: boolean;
}

/** Sent as a user-role message, clearly labelled, when a reply ran out of room before answering. */
export const RECOVERY_NOTE = `${HOST_NOTE_PREFIX} Your previous reply was cut off at the length limit before you answered. Answer the person's last message now, briefly, using only what you have already found. Do not call tools. If you could not find the answer, say so plainly.`;

/** Sent when the model finished without any answer text (2026-10-03: it reasoned for 9 minutes and stopped). */
export const RECOVERY_NOTE_EMPTY = `${HOST_NOTE_PREFIX} Your previous reply ended without an answer. Answer the person's last message now, directly. If you are not sure of a fact, look it up with your tools first; if you still cannot find it, say so plainly.`;

/**
 * The per-request context hook (request-local: Pi restores the messages after
 * the call, so nothing here enters the transcript). A recovery step's
 * requests also go out with thinking off (`before_provider_request`).
 * 1. large tool results from earlier turns become one-line stubs (context.ts);
 * 2. the turn's recalled evidence is inserted as its own message just before
 *    the person's message.
 */
function contextHook(recall: TurnState): ExtensionFactory {
	return (pi) => {
		pi.on("before_provider_request", (event) => {
			if (!recall.noThinking || typeof event.payload !== "object" || event.payload === null) return undefined;
			const payload = event.payload as { chat_template_kwargs?: Record<string, unknown> };
			return { ...payload, chat_template_kwargs: { ...payload.chat_template_kwargs, enable_thinking: false } };
		});
		pi.on("context", (event) => {
			const messages = trimEarlierToolResults(event.messages);
			const block = recall.block;
			const i = currentTurnStart(messages);
			if (!block || i < 0) return { messages };
			const memory = {
				role: "user" as const,
				content: [{ type: "text" as const, text: block }],
				timestamp: Date.now(),
			};
			return { messages: [...messages.slice(0, i), memory, ...messages.slice(i)] };
		});
	};
}
