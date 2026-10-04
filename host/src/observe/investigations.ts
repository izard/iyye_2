// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Opportunities and investigations (plan 0.007 S5, HLD §5.3): when a finding
 * raises a question its probe cannot answer, Iyye looks into it with
 * read-only tools, within bounds that survive restarts.
 *
 * - **Evidence is records only** (rule 1): an opportunity comes from a
 *   finding of an observation domain, never from Iyye's own text (replies,
 *   summaries, step answers). The cluster is that finding; a settled cluster
 *   never qualifies again.
 * - **Eligibility is kernel rules**: awake, initiative not paused, adenosine
 *   at the reserve, no other investigation running, fewer than 3 fruitless
 *   attempts, the cooldown passed. Kev's initiative role is asked in shadow.
 * - **An attempt** is up to 3 background steps in one Pi session (on the
 *   background model, with the read-only `machine` and `project` toolkits).
 *   It is **fruitful** only if the answer cites things the tools returned in
 *   this attempt (host-checked, `citations.ts`); then it becomes an
 *   observation that goes through the importance check like any finding, and
 *   the opportunity is settled. Otherwise the step is asked again, and after
 *   3 steps the attempt is fruitless: cooldown, and suspension after 3.
 * - Machine findings are not investigated yet: no read-only tool can say what
 *   uses the disk. Only repository findings raise questions in 0.007.
 */

import type { InitiativeShadow } from "../decisions/initiative.ts";
import { HOST_NOTE_PREFIX } from "../integration/pi/context.ts";
import type { Logger } from "../log.ts";
import type { BackgroundJob } from "../state/background.ts";
import type { Db } from "../state/db.ts";
import { INVESTIGATION_DOMAIN } from "../state/observations.ts";
import { checkCitations } from "./citations.ts";

export interface Opportunity {
	id: string;
	cluster: string;
	domain: string;
	evidence_json: string;
	evidence_text: string;
	question: string;
	status: "open" | "running" | "settled" | "suspended";
	attempts: number;
	fruitless: number;
	session: string | null;
	steps: number;
	attempt_started_at: string | null;
	cooldown_until: string | null;
	decision_id: string | null;
	answer: string | null;
	finding_id: string | null;
	created_at: string;
	updated_at: string;
}

/** The question a repository finding raises, or null when nothing can investigate it. */
export function questionFor(domain: string, change: string): string | null {
	if (domain !== "workspace" && domain !== "project") return null;
	if (/new commit/.test(change)) {
		return `What do the new commits in the ${domain} repository change? Look at each one (git_log, git_show) and say what it does, citing commit hashes and file names.`;
	}
	if (/uncommitted changes/.test(change)) {
		return `What are the uncommitted changes in the ${domain} repository, and do they look finished? List them with git_status, then open each changed file with read_file before judging. Cite the file names and what is in them.`;
	}
	return null;
}

export interface InvestigationDeps {
	db: Db;
	worker: {
		enqueue(step: { origin: string; prompt: string; session?: string }): string;
		initiativePaused(): boolean;
	};
	energy?: { backgroundAllowed(): boolean } | null;
	mode: () => "awake" | "winding_down" | "asleep";
	initiative?: Pick<InitiativeShadow, "ask" | "outcome"> | null;
	log: Logger;
	now?: () => Date;
	newId?: () => string;
	sweepMs?: number;
	cooldownMs?: number;
	maxFruitless?: number;
	maxSteps?: number;
}

export const ORIGIN = "investigation:";

export class Investigations {
	private readonly d: Required<InvestigationDeps>;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;

	constructor(deps: InvestigationDeps) {
		this.d = {
			energy: null,
			initiative: null,
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			sweepMs: 30 * 60_000,
			cooldownMs: 3_600_000,
			maxFruitless: 3,
			maxSteps: 3,
			...deps,
		};
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), this.d.sweepMs);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.running;
	}

	/** The sweep: new opportunities from findings, attempts that ended badly, and the next attempt. Public for tests. */
	tick(): Promise<void> {
		if (this.running) return this.running;
		this.running = this.sweep().finally(() => {
			this.running = null;
		});
		return this.running;
	}

	/** A background step settled (the worker's `onSettled`); steps of other origins are ignored. */
	onStepSettled(job: BackgroundJob): void {
		if (!job.origin.startsWith(ORIGIN)) return;
		const o = this.get(job.origin.slice(ORIGIN.length));
		if (!o || o.status !== "running" || o.session !== job.session) return;
		const answer = (job.result ?? "").trim();
		const calls = this.d.db
			.prepare(
				// What Iyye itself sent is its own text, never evidence (plan 0.008).
				"SELECT outcome, args_json, result FROM tool_calls WHERE scope = ? AND tool != 'telegram_send' ORDER BY started_at",
			)
			.all(o.session) as { outcome: string; args_json: string; result: string | null }[];
		const grounded = [o.evidence_text, o.question, ...calls.map((c) => `${c.args_json}\n${c.result ?? ""}`)].join(
			"\n",
		);
		const check = checkCitations(answer, grounded);
		const usedTools = calls.some((c) => c.outcome === "ok");
		if (usedTools && check.cited.length > 0 && check.invented.length === 0) {
			this.settle(o, answer);
			return;
		}
		const why = !usedTools
			? "it used no tool"
			: check.invented.length
				? `it names ${check.invented.slice(0, 3).join(", ")}, which the tools did not return`
				: "it cites nothing the tools returned";
		if (o.steps < this.d.maxSteps) {
			this.update(o.id, { steps: o.steps + 1 });
			// Self-contained: if this step's session is lost (a restart, the night), it still carries the question.
			this.d.worker.enqueue({
				origin: `${ORIGIN}${o.id}`,
				session: o.session!,
				prompt: `${HOST_NOTE_PREFIX} That answer is not accepted: ${why}. Use the tools and answer again, citing commit hashes, file names or figures from their results.\n\n${this.firstPrompt(o)}`,
			});
			return;
		}
		this.fruitless(o, `${this.d.maxSteps} steps without a grounded answer (last: ${why})`);
	}

	/** `/opportunities`. */
	report(): string {
		const rows = this.d.db
			.prepare("SELECT * FROM opportunities ORDER BY updated_at DESC LIMIT 10")
			.all() as Opportunity[];
		if (rows.length === 0) return "no opportunities yet (they come from findings that raise a question)";
		const at = (iso: string | null) => (iso ? new Date(iso).toTimeString().slice(0, 5) : "?");
		return [
			`opportunities (at most ${this.d.maxFruitless} fruitless attempts each, ${Math.round(this.d.cooldownMs / 60_000)} min apart):`,
			...rows.map(
				(o) =>
					`  ${o.id.slice(0, 8)} ${o.domain} — ${o.status}, ${o.attempts} attempt(s), ${o.fruitless} fruitless${o.cooldown_until && o.status === "open" ? `, next after ${at(o.cooldown_until)}` : ""}\n    evidence: ${o.evidence_text.slice(0, 120)}${o.answer ? `\n    found: ${o.answer.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
			),
		].join("\n");
	}

	private async sweep(): Promise<void> {
		if (this.d.mode() !== "awake") return;
		this.discover();
		this.reconcile();
		await this.startNext();
	}

	/** Findings of repository domains that raise a question become opportunities, once per finding. */
	private discover(): void {
		const findings = this.d.db
			.prepare(
				`SELECT o.id, o.domain, o.change_text FROM observations o
				 WHERE o.finding = 1 AND o.domain IN ('workspace', 'project')
				 AND NOT EXISTS (SELECT 1 FROM opportunities p WHERE p.cluster = 'observation:' || o.id)
				 ORDER BY o.at`,
			)
			.all() as { id: string; domain: string; change_text: string }[];
		for (const f of findings) {
			const question = questionFor(f.domain, f.change_text ?? "");
			if (!question) continue;
			const at = this.iso();
			this.d.db
				.prepare(
					`INSERT OR IGNORE INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
				)
				.run(
					this.d.newId(),
					`observation:${f.id}`,
					f.domain,
					JSON.stringify([f.id]),
					f.change_text,
					question,
					at,
					at,
				);
		}
	}

	/**
	 * Running attempts: a step that failed or was suspended ends the attempt
	 * fruitless; a step that settled but was never evaluated (a restart in
	 * between) is evaluated now. Evaluating twice is harmless: after the first
	 * time a newer step exists or the opportunity is no longer running.
	 */
	private reconcile(): void {
		for (const o of this.d.db
			.prepare("SELECT * FROM opportunities WHERE status = 'running'")
			.all() as Opportunity[]) {
			const last = this.d.db
				.prepare("SELECT * FROM background_jobs WHERE session = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
				.get(o.session) as BackgroundJob | undefined;
			if (!last) this.fruitless(o, "its step is gone");
			else if (last.status === "failed" || last.status === "suspended")
				this.fruitless(o, `its step ${last.status}: ${last.error ?? ""}`);
			else if (last.status === "settled") this.onStepSettled(last);
		}
	}

	private async startNext(): Promise<void> {
		if (this.d.worker.initiativePaused()) return;
		if (this.d.energy && !this.d.energy.backgroundAllowed()) return;
		const busy = this.d.db.prepare("SELECT 1 FROM opportunities WHERE status = 'running'").get();
		if (busy) return; // one investigation at a time
		const o = this.d.db
			.prepare(
				"SELECT * FROM opportunities WHERE status = 'open' AND fruitless < ? AND (cooldown_until IS NULL OR cooldown_until <= ?) ORDER BY created_at LIMIT 1",
			)
			.get(this.d.maxFruitless, this.iso()) as Opportunity | undefined;
		if (!o) return;
		let decisionId: string | null = null;
		try {
			decisionId =
				(await this.d.initiative?.ask({
					id: o.id,
					domain: o.domain,
					evidence: o.evidence_text,
					question: o.question,
				})) ?? null;
		} catch (err) {
			this.d.log.warn("investigations: initiative shadow failed", { error: (err as Error).message });
		}
		const attempt = o.attempts + 1;
		const session = `iyye:inv:${o.id}:${attempt}`;
		this.update(o.id, {
			status: "running",
			attempts: attempt,
			steps: 1,
			session,
			attempt_started_at: this.iso(),
			decision_id: decisionId,
		});
		this.d.worker.enqueue({
			origin: `${ORIGIN}${o.id}`,
			session,
			prompt: this.firstPrompt(o),
		});
		this.d.log.info("investigations: attempt started", { id: o.id, attempt });
	}

	private firstPrompt(o: Opportunity): string {
		return [
			`Investigation: ${o.question}`,
			`Evidence, observed by Iyye's ${o.domain} probe: ${o.evidence_text}`,
			"Use the tools; do not guess. Answer in at most four sentences, citing the commit hashes, file names or figures the tools returned. An answer that cites nothing the tools returned is not accepted.",
		].join("\n");
	}

	private settle(o: Opportunity, answer: string): void {
		const obsId = this.d.newId();
		const at = this.iso();
		const json = JSON.stringify({ opportunity: o.id, evidence: JSON.parse(o.evidence_json) });
		this.d.db.transaction(() => {
			// The finding goes through the importance check like any other (the observer decides it).
			this.d.db
				.prepare(
					`INSERT INTO observations (id, domain, at, result_json, result_hash, severity, change_text)
					 VALUES (?, '${INVESTIGATION_DOMAIN}', ?, ?, ?, 'threshold', ?)`,
				)
				.run(obsId, at, json, o.id, `${o.evidence_text} → ${answer.replace(/\s+/g, " ").slice(0, 400)}`);
			this.update(o.id, { status: "settled", answer, finding_id: obsId, session: null });
		})();
		if (o.decision_id) this.d.initiative?.outcome(o.decision_id, true);
		this.d.log.info("investigations: settled", { id: o.id });
	}

	private fruitless(o: Opportunity, why: string): void {
		const fruitless = o.fruitless + 1;
		this.update(o.id, {
			status: fruitless >= this.d.maxFruitless ? "suspended" : "open",
			fruitless,
			session: null,
			cooldown_until: new Date(this.d.now().getTime() + this.d.cooldownMs).toISOString(),
			answer: null,
		});
		if (o.decision_id) this.d.initiative?.outcome(o.decision_id, false);
		this.d.log.info("investigations: fruitless attempt", { id: o.id, fruitless, why });
	}

	private get(id: string): Opportunity | undefined {
		return this.d.db.prepare("SELECT * FROM opportunities WHERE id = ?").get(id) as Opportunity | undefined;
	}

	private update(id: string, fields: Partial<Opportunity>): void {
		const cols = Object.keys(fields);
		this.d.db
			.prepare(
				`UPDATE opportunities SET ${cols.map((c) => `${c} = @${c}`).join(", ")}, updated_at = @updated_at WHERE id = @id`,
			)
			.run({ ...fields, id, updated_at: this.iso() });
	}

	private iso(): string {
		return this.d.now().toISOString();
	}
}
