// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plans (plan 0.006 C4, HLD §7.1, §15 #7): a durable intention with typed
 * steps, run by the kernel one step at a time. No model decides that a step
 * or a plan is done; each step has its own evidence.
 *
 * - **investigate**: a read-only question, run as a background step (the
 *   background model, the read-only `machine` and `project` toolkits). Done
 *   only when the answer cites what the tools returned in that session
 *   (`observe/citations.ts`, as in S5); after `maxSteps` ungrounded answers
 *   the plan fails.
 * - **remind**: a reminder on the proposer's own route, at the time the host
 *   resolved when the plan was proposed (and the person was told). Every
 *   reminder is scheduled when the plan becomes active, so it keeps its time
 *   whatever the other steps do; the other steps run one at a time, in order.
 *   A reminder is done only when the outbox settles it `fulfilled` (a
 *   delivery receipt). Failed or cancelled → the plan fails (and its other
 *   coming reminders are cancelled); unconfirmed (`unknown`) → the plan is
 *   suspended until a receipt settles it.
 * - **other**: nothing can do it, so it is blocked and the plan is suspended.
 *   Such a plan never completes; the owner can cancel it.
 * - **task** (2026-10-13): something the person does themselves (an agreed
 *   list: "add the sandbox, then write access"). Iyye only keeps it; it is
 *   done when the person says so in their own conversation
 *   (`plan_task_done`) or the owner with `/plan done <id> <n>`. Tasks wait
 *   in any order and never block the other steps; the plan completes when
 *   every step is done. A plan of tasks only, proposed by the owner on any
 *   of their own channels, is authorized at once: it arranges nothing.
 *
 * **Authorization** (HLD §3, security invariants): a plan runs only once
 * authorized. It is authorized at once only when the owner proposed it in
 * the local web chat and every step is internal or reminds that web chat.
 * Anything else waits, `proposed`, for `/plan approve`, an owner command
 * that never comes from Telegram. A Telegram message can at most propose.
 *
 * **Iyye's own proposals** (plan 0.010 M3, owner decision 3): from an
 * intention the owner stated, Iyye may propose a plan for the owner. It is
 * never authorized at once, wherever the owner said it; its reminders go to
 * the owner's web chat; and if the owner does not approve it within
 * `ownProposalTtlMs` it is dropped (abandoned, "not approved"), so a remark
 * the owner let pass does not wait for ever.
 */

import { HOST_NOTE_PREFIX } from "../integration/pi/context.ts";
import type { Logger } from "../log.ts";
import { checkCitations } from "../observe/citations.ts";
import { type Route, routeLabel } from "../outbox/outbox.ts";
import type { BackgroundJob } from "../state/background.ts";
import { getCommitment, insertCommitment } from "../state/commitments.ts";
import { getContact, OWNER_CONTACT_ID } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import {
	findPlans,
	getPlan,
	insertPlan,
	OPEN_PLAN_STATES,
	type PlanRow,
	type PlanStep,
	plansIn,
	recentPlans,
	steps as stepsOf,
	updatePlan,
} from "../state/plans.ts";
import { PLAN_STEP_SCOPE } from "../tools/broker.ts";
import { describeAt, parseWhen } from "./when.ts";

export const PLAN_ORIGIN = "plan:";
/** `proposed_via` of the plans Iyye proposes itself (plan 0.010 M3). */
export const IYYE_PROPOSED_VIA = "Iyye, from the owner's words";

/** A step as the proposer gives it, before the host resolves it. */
export type ProposedStep =
	| { kind: "investigate"; question: string }
	| { kind: "remind"; text: string; when: string }
	| { kind: "other"; description: string }
	| { kind: "task"; description: string };

export interface Proposal {
	intent: string;
	steps: ProposedStep[];
	/** From the turn (the triggering event), never from the model. Iyye's own proposals: the owner. */
	proposer: string;
	/** `iyye`: Iyye proposes for the owner, from their words (never authorized at once). */
	principal: "owner" | "contact" | "iyye";
	scope: string;
	route: Route;
	eventId: string | null;
	via: string;
}

export interface PlanRunnerDeps {
	db: Db;
	worker: { enqueue(step: { origin: string; prompt: string; session?: string }): string; wake?(): void };
	outbox: { notifyOwner(req: { key: string; content: string }): Promise<unknown> };
	log: Logger;
	now?: () => Date;
	newId?: () => string;
	tickMs?: number;
	/** Background steps an investigate step may take before it fails. */
	maxSteps?: number;
	/** Open plans a contact may have. */
	contactMax?: number;
	/** How long a plan Iyye proposed itself waits for approval before it is dropped. */
	ownProposalTtlMs?: number;
	timezone?: string;
}

const MAX_STEPS_PER_PLAN = 5;

export class PlanRunner {
	private readonly d: Required<PlanRunnerDeps>;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;

	constructor(deps: PlanRunnerDeps) {
		this.d = {
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			tickMs: 15_000,
			maxSteps: 3,
			contactMax: 5,
			ownProposalTtlMs: 3 * 86_400_000,
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			...deps,
		};
	}

	start(): void {
		if (this.timer) return;
		void this.tick();
		this.timer = setInterval(() => void this.tick(), this.d.tickMs);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.running;
	}

	/** Advance every authorized, active or suspended plan. Public for tests. */
	tick(): Promise<void> {
		if (this.running) return this.running;
		this.running = this.advanceAll().finally(() => {
			this.running = null;
		});
		return this.running;
	}

	/**
	 * `plan_propose`: validate and record. Returns the text the tool gives the
	 * model; a refusal tells it to ask, never to choose.
	 */
	propose(p: Proposal): string {
		return this.proposePlan(p).text;
	}

	/** `propose`, with the new plan's id when one was recorded. */
	proposePlan(p: Proposal): { id: string | null; text: string } {
		const no = (text: string) => ({ id: null, text });
		const intent = p.intent.replace(/\s+/g, " ").trim();
		if (!intent) return no("Not proposed: say what the plan is for.");
		if (p.steps.length === 0 || p.steps.length > MAX_STEPS_PER_PLAN)
			return no(`Not proposed: a plan has 1 to ${MAX_STEPS_PER_PLAN} steps.`);
		if (p.principal === "contact") {
			const open = plansIn(this.d.db, OPEN_PLAN_STATES).filter((x) => x.scope === p.scope).length;
			if (open >= this.d.contactMax)
				return no(
					`Not proposed: this chat already has ${open} open plans. They must finish or be cancelled by the owner first.`,
				);
		}
		const now = this.d.now();
		const steps: PlanStep[] = [];
		for (const [i, s] of p.steps.entries()) {
			if (s.kind === "investigate") {
				const question = s.question.trim();
				if (!question) return no(`Not proposed: step ${i + 1} has no question.`);
				steps.push({ kind: "investigate", question, status: "pending" });
			} else if (s.kind === "remind") {
				const text = s.text.trim();
				if (!text) return no(`Not proposed: step ${i + 1} says nothing to remind about.`);
				const when = parseWhen(s.when, now);
				if (!when.ok)
					return no(
						`Not proposed: step ${i + 1}: ${when.error}. Ask the person what they meant; do not choose another time yourself.`,
					);
				steps.push({ kind: "remind", text, due_at: when.at.toISOString(), status: "pending" });
			} else {
				const description = s.description.trim();
				if (!description) return no(`Not proposed: step ${i + 1} is empty.`);
				steps.push({ kind: s.kind, description, status: "pending" });
			}
		}
		// Only the owner's own proposal in the local web chat; never Iyye's, wherever the owner said it.
		const ownWebChat = p.principal === "owner" && p.route.channel === "web";
		const typed = steps.every((s) => s.kind !== "other");
		// The owner's own to-do list arranges nothing (no tool runs, nothing is sent): any owner channel.
		const ownList = p.principal === "owner" && steps.every((s) => s.kind === "task");
		const auto = (ownWebChat && typed) || ownList;
		const id = this.d.newId();
		insertPlan(this.d.db, {
			id,
			intent,
			proposer_contact_id: p.proposer,
			scope: p.scope,
			route_json: JSON.stringify(p.route),
			proposed_via: p.via,
			created_event_id: p.eventId,
			steps,
			state: auto ? "authorized" : "proposed",
			authorization: ownList
				? "auto: the owner's own list (steps only the owner does)"
				: auto
					? "auto: proposed by the owner in the web chat; internal steps and reminders to it"
					: null,
			created_at: now.toISOString(),
		});
		this.d.log.info("plans: proposed", { id, auto, steps: steps.length });
		const list = steps.map((s, i) => `  ${i + 1}. ${stepText(s)}`).join("\n");
		if (auto) {
			queueMicrotask(() => void this.tick());
			return {
				id,
				text: ownList
					? `Plan ${id.slice(0, 8)} is kept as a list of things the person does:\n${list}\nEach is done when they say so (plan_task_done); it lasts beyond today, so later conversations can see what is still open.`
					: `Plan ${id.slice(0, 8)} is authorized and starts now. Reminders go out at their times; the other steps run one at a time, in order:\n${list}\nEach step is done only with its evidence (a grounded answer, a delivered reminder, the person's word for their own tasks); tell the person exactly these steps and times.`,
			};
		}
		if (p.principal === "iyye") {
			const days = Math.round(this.d.ownProposalTtlMs / 86_400_000);
			this.notify(
				`plan-proposed:${id}`,
				`From what you said, I could keep this as a plan: ${quote(intent)}\n${list}\n/plan approve ${id.slice(0, 8)} to let it run, /plan cancel ${id.slice(0, 8)} if not. Unless you approve it, I drop it in ${days} day(s).`,
			);
			return { id, text: `Plan ${id.slice(0, 8)} proposed to the owner.` };
		}
		this.notify(
			`plan-proposed:${id}`,
			`${proposerName(this.d.db, p.proposer)} proposed a plan (${p.via}): ${quote(intent)}\n${list}\n/plan approve ${id.slice(0, 8)} to let it run, /plan cancel ${id.slice(0, 8)} to drop it.`,
		);
		const why = typed
			? "it reaches beyond the owner's web chat"
			: "a step has no tool that can do it (it would stay blocked)";
		return {
			id,
			text: `Plan ${id.slice(0, 8)} is only proposed: it waits for the owner's approval because ${why}. Nothing is arranged yet; tell the person that, not that it will happen. Steps:\n${list}`,
		};
	}

	/** `/plan approve <id>`: owner surfaces only (commands never come from Telegram). */
	approve(ref: string, by: string): string {
		const p = this.find(ref);
		if (typeof p === "string") return p;
		if (p.state !== "proposed") return `plan ${p.id.slice(0, 8)} is ${p.state}, not waiting for approval`;
		const ok = updatePlan(this.d.db, p.id, this.iso(), { state: "authorized", authorization: `owner:${by}` }, [
			"proposed",
		]);
		if (!ok) return `plan ${p.id.slice(0, 8)} changed meanwhile; look again with /plan ${p.id.slice(0, 8)}`;
		queueMicrotask(() => void this.tick());
		const blocked = stepsOf(p).some((s) => s.kind === "other");
		return `approved: ${quote(p.intent)}${blocked ? " (it has a step no tool can do: it will stop there, suspended)" : ""}`;
	}

	/**
	 * A task step done (2026-10-13): by the person in their own conversation (`plan_task_done`, `scope` given:
	 * only plans of that conversation) or by the owner (`/plan done`, scope null). Recorded with who and when.
	 */
	markTaskDone(ref: string, stepNo: number, by: string, scope: string | null): string {
		const p = this.find(ref);
		if (typeof p === "string") return p;
		if (scope !== null && p.scope !== scope) return `no plan ${ref} in this conversation`;
		if (!["authorized", "active", "suspended"].includes(p.state)) return `plan ${p.id.slice(0, 8)} is ${p.state}`;
		const steps = stepsOf(p);
		const s = steps[stepNo - 1];
		if (!s) return `plan ${p.id.slice(0, 8)} has no step ${stepNo}`;
		if (s.kind !== "task")
			return `step ${stepNo} is not a task of the person's: it is done only with its own evidence`;
		if (s.status === "done") return `step ${stepNo} was already done`;
		steps[stepNo - 1] = { ...s, status: "done", done_by: by, done_at: this.iso() };
		if (!updatePlan(this.d.db, p.id, this.iso(), { steps }, ["authorized", "active", "suspended"]))
			return `plan ${p.id.slice(0, 8)} changed meanwhile; look again`;
		queueMicrotask(() => void this.tick());
		const left = steps.filter((x) => x.status !== "done").length;
		return `done: step ${stepNo} of plan ${p.id.slice(0, 8)} (${quote(s.description, 120)}); ${left ? `${left} step(s) left` : "every step is done"}`;
	}

	/** `/plan cancel <id>`: abandoned; its coming reminders are cancelled and its queued steps dropped. */
	cancel(ref: string, by: string): string {
		const p = this.find(ref);
		if (typeof p === "string") return p;
		if (!OPEN_PLAN_STATES.includes(p.state)) return `plan ${p.id.slice(0, 8)} is already ${p.state}`;
		this.abandon(p, `cancelled by ${by}`);
		return `cancelled: ${quote(p.intent)}`;
	}

	/** `/plans`: open plans first, then the latest settled ones. */
	report(): string {
		const open = plansIn(this.d.db, OPEN_PLAN_STATES);
		const settled = recentPlans(this.d.db, 10).filter((p) => !OPEN_PLAN_STATES.includes(p.state));
		if (open.length + settled.length === 0) return "no plans yet";
		const line = (p: PlanRow) => {
			const s = stepsOf(p);
			const done = s.filter((x) => x.status === "done").length;
			return `  ${p.id.slice(0, 8)} ${p.state} · ${done}/${s.length} steps · ${proposedBy(this.d.db, p)} · ${quote(p.intent, 100)}${p.reason ? ` (${p.reason})` : ""}`;
		};
		return [
			...(open.length ? ["open plans:", ...open.map(line)] : ["no open plans"]),
			...(settled.length ? ["latest settled:", ...settled.map(line)] : []),
			"/plan <id> for steps and evidence",
		].join("\n");
	}

	/** `/plan <id>`: the steps and what each one rests on. */
	detail(ref: string): string {
		const p = this.find(ref);
		if (typeof p === "string") return p;
		const route = JSON.parse(p.route_json) as Route;
		return [
			`plan ${p.id.slice(0, 8)}: ${quote(p.intent)}`,
			`  ${p.state}${p.reason ? ` (${p.reason})` : ""} · proposed by ${proposedBy(this.d.db, p)}${p.proposed_via === IYYE_PROPOSED_VIA ? " (from your words)" : ` via ${p.proposed_via}`}, ${describeAt(new Date(p.created_at))}`,
			`  outward steps go to ${routeLabel(route)}`,
			`  authorization: ${p.authorization ?? "none yet"}`,
			...stepsOf(p).map(
				(s, i) =>
					`  ${i + 1}. [${s.status}] ${stepText(s)}${"evidence" in s && s.evidence ? `\n     evidence: ${s.evidence.replace(/\s+/g, " ").slice(0, 300)}` : ""}${s.reason ? `\n     ${s.reason}` : ""}`,
			),
		].join("\n");
	}

	/** A background step settled (the worker's `onSettled`); steps of other origins are ignored. */
	onStepSettled(job: BackgroundJob): void {
		if (!job.origin.startsWith(PLAN_ORIGIN)) return;
		const [id, idx] = job.origin.slice(PLAN_ORIGIN.length).split(":");
		const p = getPlan(this.d.db, id ?? "");
		const i = Number(idx);
		if (!p || !["active", "suspended"].includes(p.state)) return;
		const steps = stepsOf(p);
		const s = steps[i];
		if (!s || s.kind !== "investigate" || s.status !== "running" || s.session !== job.session) return;
		const answer = (job.result ?? "").trim();
		const calls = this.d.db
			.prepare(
				// What Iyye itself sent is its own text, never evidence (plan 0.008).
				"SELECT outcome, args_json, result FROM tool_calls WHERE scope = ? AND tool != 'telegram_send' ORDER BY started_at",
			)
			.all(s.session) as { outcome: string; args_json: string; result: string | null }[];
		// The question (written by a person or the model) may be named, but it is never evidence:
		// at least one cited thing must come from the tools alone.
		const results = calls.map((c) => `${c.args_json}\n${c.result ?? ""}`).join("\n");
		const check = checkCitations(answer, `${s.question}\n${results}`);
		const tools = checkCitations(answer, results);
		const fromTools = tools.cited.filter((t) => !tools.invented.includes(t));
		const usedTools = calls.some((c) => c.outcome === "ok");
		if (usedTools && fromTools.length > 0 && check.invented.length === 0) {
			steps[i] = {
				...s,
				status: "done",
				evidence: `${answer.slice(0, 1200)} [cites: ${fromTools.slice(0, 8).join(", ")}]`,
			};
			updatePlan(this.d.db, p.id, this.iso(), { steps });
			void this.tick();
			return;
		}
		const why = !usedTools
			? "it used no tool"
			: check.invented.length
				? `it names ${check.invented.slice(0, 3).join(", ")}, which the tools did not return`
				: "it cites nothing the tools returned";
		const tries = s.tries ?? 1;
		if (tries < this.d.maxSteps) {
			steps[i] = { ...s, tries: tries + 1 };
			updatePlan(this.d.db, p.id, this.iso(), { steps });
			this.d.worker.enqueue({
				origin: job.origin,
				session: s.session,
				prompt: `${HOST_NOTE_PREFIX} That answer is not accepted: ${why}. Use the tools and answer again, citing file names, commit hashes or figures from their results.\n\n${investigatePrompt(p, s.question)}`,
			});
			return;
		}
		steps[i] = { ...s, status: "failed", reason: `${tries} answers without grounding (last: ${why})` };
		this.fail(p, steps, `step ${i + 1} found no grounded answer`);
	}

	private async advanceAll(): Promise<void> {
		await Promise.resolve(); // so a tick asked for while advancing joins this one
		this.dropStaleOwnProposals();
		for (const { id } of plansIn(this.d.db, ["authorized", "active", "suspended"])) {
			try {
				// Step by step until nothing changes: a step done now lets the next one start in the same tick.
				for (let k = 0; k < 2 * MAX_STEPS_PER_PLAN + 3; k++) {
					const p = getPlan(this.d.db, id)!;
					if (!["authorized", "active", "suspended"].includes(p.state)) break;
					this.advance(p);
					const q = getPlan(this.d.db, id)!;
					if (q.state === p.state && q.steps_json === p.steps_json) break;
				}
			} catch (err) {
				this.d.log.warn("plans: advancing failed", { id, error: (err as Error).message });
			}
		}
	}

	private advance(plan: PlanRow): void {
		let p = plan;
		if (p.state === "authorized") {
			this.activate(p);
			return;
		}
		const steps = stepsOf(p);
		// Reminders run on their own clocks; the other steps one at a time, in order.
		let unconfirmed = -1;
		for (const [k, s] of steps.entries()) {
			if (s.kind !== "remind" || s.status !== "running") continue;
			if (this.followReminder(p, steps, k) === "unknown" && unconfirmed < 0) unconfirmed = k;
			p = getPlan(this.d.db, p.id)!;
			if (!["active", "suspended"].includes(p.state)) return;
		}
		// Suspended while a reminder is unconfirmed or a step is blocked; active again once neither holds.
		const blocked = steps.some((s) => s.status === "blocked");
		if (!blocked && unconfirmed >= 0 && p.state !== "suspended") {
			updatePlan(this.d.db, p.id, this.iso(), {
				state: "suspended",
				reason: `step ${unconfirmed + 1}: the reminder may have been sent, but no receipt confirms it`,
			});
			this.notify(
				`plan-unconfirmed:${p.id}`,
				`Plan paused: its reminder may or may not have arrived (no receipt), so it is not counted as done. Plan: ${quote(p.intent, 100)}. /plan ${p.id.slice(0, 8)} shows it.`,
			);
			p = getPlan(this.d.db, p.id)!;
		} else if (!blocked && unconfirmed < 0 && p.state === "suspended") {
			updatePlan(this.d.db, p.id, this.iso(), { state: "active", reason: null });
			p = getPlan(this.d.db, p.id)!;
		}
		// Reminders run on their own clocks and tasks wait for the person: neither holds the others back.
		const i = steps.findIndex((s) => s.kind !== "remind" && s.kind !== "task" && s.status !== "done");
		if (i < 0) {
			if (steps.every((s) => s.status === "done")) this.complete(p, steps);
			return;
		}
		const s = steps[i]!;
		if (s.status === "pending") {
			this.startStep(p, steps, i);
			return;
		}
		if (s.status === "blocked") return; // suspended for good; the owner can cancel
		if (s.status === "failed") {
			this.fail(p, steps, s.reason ?? `step ${i + 1} failed`);
			return;
		}
		if (s.kind === "investigate") this.followInvestigation(p, steps, i);
	}

	/**
	 * Authorized → active. Every reminder is scheduled now, at the time the
	 * person was told, whatever the other steps do; the plan completes only
	 * when every step, reminders included, has its evidence.
	 */
	private activate(p: PlanRow): void {
		const steps = stepsOf(p);
		this.d.db.transaction(() => {
			for (const [k, s] of steps.entries()) {
				if (s.kind !== "remind" || s.status !== "pending") continue;
				const id = this.d.newId();
				insertCommitment(this.d.db, {
					id,
					scope: p.scope,
					recipient_contact_id: p.proposer_contact_id,
					route_json: p.route_json,
					text: s.text,
					due_at: s.due_at,
					timezone: this.d.timezone,
					recurrence: "none",
					series_id: id,
					created_by: `${PLAN_ORIGIN}${p.id}`,
					created_event_id: p.created_event_id,
					created_at: this.iso(),
				});
				steps[k] = { ...s, status: "running", commitment_id: id };
			}
			updatePlan(this.d.db, p.id, this.iso(), { state: "active", steps }, ["authorized"]);
		})();
	}

	/** Iyye's own proposals the owner left unapproved are dropped after their time (plan 0.010 M3). */
	private dropStaleOwnProposals(): void {
		const before = new Date(this.d.now().getTime() - this.d.ownProposalTtlMs).toISOString();
		for (const p of plansIn(this.d.db, ["proposed"])) {
			if (p.proposed_via !== IYYE_PROPOSED_VIA || p.created_at >= before) continue;
			if (updatePlan(this.d.db, p.id, this.iso(), { state: "abandoned", reason: "not approved" }, ["proposed"]))
				this.d.log.info("plans: own proposal dropped", { id: p.id });
		}
	}

	private complete(p: PlanRow, steps: PlanStep[]): void {
		if (!updatePlan(this.d.db, p.id, this.iso(), { state: "completed", reason: null }, ["active", "suspended"]))
			return;
		this.notify(
			`plan-completed:${p.id}`,
			`Plan done: ${quote(p.intent)}\n${steps.map((s, k) => `  ${k + 1}. ${stepText(s)}${"evidence" in s && s.evidence ? ` → ${s.evidence.replace(/\s+/g, " ").slice(0, 200)}` : ""}`).join("\n")}`,
		);
		this.d.log.info("plans: completed", { id: p.id });
	}

	private startStep(p: PlanRow, steps: PlanStep[], i: number): void {
		const s = steps[i]!;
		if (s.kind === "other") {
			steps[i] = { ...s, status: "blocked", reason: "no tool can do this step" };
			updatePlan(this.d.db, p.id, this.iso(), { steps, state: "suspended", reason: `step ${i + 1} is blocked` });
			this.notify(
				`plan-blocked:${p.id}`,
				`Plan stopped at step ${i + 1}, which nothing can do: ${quote(s.description, 160)} (plan: ${quote(p.intent, 100)}). It stays suspended; /plan cancel ${p.id.slice(0, 8)} drops it.`,
			);
			return;
		}
		if (s.kind !== "investigate") return; // reminders are scheduled when the plan becomes active
		const session = `${PLAN_STEP_SCOPE}${p.id}:${i}`;
		steps[i] = { ...s, status: "running", session, tries: 1 };
		updatePlan(this.d.db, p.id, this.iso(), { steps });
		this.d.worker.enqueue({
			origin: `${PLAN_ORIGIN}${p.id}:${i}`,
			session,
			prompt: investigatePrompt(p, s.question),
		});
	}

	/** A reminder step follows its commitment: the outbox settles it from receipts. */
	private followReminder(p: PlanRow, steps: PlanStep[], i: number): "waiting" | "unknown" | "settled" {
		const s = steps[i] as Extract<PlanStep, { kind: "remind" }>;
		const c = s.commitment_id ? getCommitment(this.d.db, s.commitment_id) : undefined;
		if (!c) {
			steps[i] = { ...s, status: "failed", reason: "its reminder is gone" };
			this.fail(p, steps, `step ${i + 1}: its reminder is gone`);
			return "settled";
		}
		if (c.state === "fulfilled") {
			const receipt = this.d.db
				.prepare(
					"SELECT level, acknowledged_at FROM receipts WHERE action_id = ? AND outcome = 'delivered' ORDER BY acknowledged_at DESC LIMIT 1",
				)
				.get(c.action_id) as { level: string; acknowledged_at: string | null } | undefined;
			steps[i] = {
				...s,
				status: "done",
				evidence: `reminder ${c.id.slice(0, 8)} delivered: action ${c.action_id?.slice(0, 8)}, receipt ${receipt?.level ?? "?"}${receipt?.acknowledged_at ? ` at ${receipt.acknowledged_at}` : ""}`,
			};
			updatePlan(this.d.db, p.id, this.iso(), { steps });
			return "settled";
		}
		if (c.state === "failed" || c.state === "cancelled") {
			steps[i] = { ...s, status: "failed", reason: `its reminder ${c.state}${c.reason ? `: ${c.reason}` : ""}` };
			this.fail(p, steps, `step ${i + 1}: the reminder ${c.state}`);
			return "settled";
		}
		return c.state === "unknown" ? "unknown" : "waiting";
	}

	/**
	 * An investigate step follows its background job: a failed or suspended
	 * job counts as an ungrounded answer; a settled job not yet evaluated (a
	 * restart in between) is evaluated now.
	 */
	private followInvestigation(p: PlanRow, steps: PlanStep[], i: number): void {
		const s = steps[i] as Extract<PlanStep, { kind: "investigate" }>;
		const last = this.d.db
			.prepare("SELECT * FROM background_jobs WHERE session = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
			.get(s.session) as BackgroundJob | undefined;
		if (!last) {
			// Its job is gone (never written, or removed): start the step again.
			steps[i] = { ...s, status: "pending" };
			updatePlan(this.d.db, p.id, this.iso(), { steps });
			return;
		}
		if (last.status === "settled") this.onStepSettled(last);
		else if (last.status === "failed" || last.status === "suspended") {
			steps[i] = { ...s, status: "failed", reason: `its background step ${last.status}: ${last.error ?? ""}` };
			this.fail(p, steps, `step ${i + 1} could not run`);
		}
	}

	private fail(p: PlanRow, steps: PlanStep[], reason: string): void {
		if (!updatePlan(this.d.db, p.id, this.iso(), { steps, state: "failed", reason }, ["active", "suspended"])) return;
		this.cancelLeftovers(p.id, "the plan failed");
		this.notify(`plan-failed:${p.id}`, `Plan failed: ${quote(p.intent, 120)} — ${reason}.`);
		this.d.log.info("plans: failed", { id: p.id, reason });
	}

	private abandon(p: PlanRow, reason: string): void {
		this.d.db.transaction(() => {
			updatePlan(this.d.db, p.id, this.iso(), { state: "abandoned", reason });
			this.cancelLeftovers(p.id, reason);
		})();
		this.d.log.info("plans: abandoned", { id: p.id, reason });
	}

	/** Reminders not yet sent and steps not yet run: nothing of a settled plan happens later. */
	private cancelLeftovers(id: string, reason: string): void {
		const at = this.iso();
		this.d.db
			.prepare(
				"UPDATE commitments SET state = 'cancelled', settled_at = ?, reason = ? WHERE created_by = ? AND state = 'scheduled'",
			)
			.run(at, reason, `${PLAN_ORIGIN}${id}`);
		this.d.db
			.prepare(
				"UPDATE background_jobs SET status = 'failed', error = ?, settled_at = ? WHERE origin LIKE ? AND status IN ('queued', 'paused')",
			)
			.run(reason, at, `${PLAN_ORIGIN}${id}:%`);
	}

	private find(ref: string): PlanRow | string {
		if (!/^[0-9a-f-]{6,36}$/i.test(ref)) return "give a plan id, at least 6 characters (see /plans)";
		const found = findPlans(this.d.db, ref.toLowerCase());
		if (found.length === 0) return `no plan ${ref}`;
		if (found.length > 1) return `${ref} matches ${found.length} plans; give more of the id`;
		return found[0]!;
	}

	private notify(key: string, content: string): void {
		this.d.outbox
			.notifyOwner({ key, content })
			.catch((err) => this.d.log.warn("plans: notice failed", { key, error: (err as Error).message }));
	}

	private iso(): string {
		return this.d.now().toISOString();
	}
}

/**
 * A request-local note for a conversation's turns (2026-10-13): its open plans, with each step's state, so a
 * question like "what did we plan?" is answered from the record, not from memory. None when there are none.
 */
export function openPlansNote(db: Db, scope: string): string | null {
	const open = plansIn(db, OPEN_PLAN_STATES).filter((p) => p.scope === scope);
	if (open.length === 0) return null;
	const lines = open
		.slice(0, 5)
		.map((p) =>
			[
				`plan ${p.id.slice(0, 8)} (${p.state}, since ${p.created_at.slice(0, 10)}): ${quote(p.intent, 200)}`,
				...stepsOf(p).map((s, i) => `  ${i + 1}. [${s.status}] ${stepText(s)}`),
			].join("\n"),
		);
	return `<open_plans>\nThe plans of this conversation that are not finished (records, not memory):\n${lines.join("\n")}\n</open_plans>`;
}

function investigatePrompt(p: PlanRow, question: string): string {
	return [
		`A step of a plan (${p.intent.slice(0, 200)}): ${question}`,
		"Use the tools; do not guess. Answer in at most four sentences, citing the file names, commit hashes or figures the tools returned. An answer that cites nothing the tools returned is not accepted.",
	].join("\n");
}

function stepText(s: PlanStep): string {
	if (s.kind === "investigate") return `look into: ${quote(s.question, 200)}`;
	if (s.kind === "remind") return `remind at ${describeAt(new Date(s.due_at))}: ${quote(s.text, 200)}`;
	if (s.kind === "task")
		return `the person does: ${quote(s.description, 200)}${s.status === "done" && s.done_at ? ` (done ${s.done_at.slice(0, 10)})` : ""}`;
	return `${quote(s.description, 200)} (no tool can do this)`;
}

/** Words a person or the model wrote: quoted and clipped, so they read as data. */
function quote(text: string, max = 300): string {
	return JSON.stringify(text.replace(/\s+/g, " ").slice(0, max));
}

/** Who proposed a plan, as the owner reads it: Iyye for its own proposals. */
function proposedBy(db: Db, p: PlanRow): string {
	return p.proposed_via === IYYE_PROPOSED_VIA ? "Iyye" : proposerName(db, p.proposer_contact_id);
}

function proposerName(db: Db, id: string): string {
	return id === OWNER_CONTACT_ID ? "you" : JSON.stringify((getContact(db, id)?.display_name ?? id).slice(0, 64));
}
