// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The night's memory work (plan 0.002 §3.4, L5): move short-term memory into
 * long-term memory, then consolidate. It runs only while Iyye is asleep.
 *
 * - One gated retain per episode, oldest first, so owner input waits for at
 *   most one retain. `document_id` = event id: a retry after a crash replaces
 *   the same document, never duplicates it.
 * - An episode leaves STM only once its transfer is confirmed: `completed`,
 *   or `completed_empty` when extraction found nothing worth keeping. A failed
 *   attempt leaves it in STM (still recallable) for the next night; after
 *   `maxAttempts` it is `failed` and shown to the owner.
 * - Hindsight unreachable (no connection, or 502/503/504: its database or
 *   the pass-through is down) or the memory model unavailable: the night
 *   stops without charging attempts, and says why. Other errors (e.g. 500,
 *   extraction failed) are charged to the episode.
 * - Banks that received facts are consolidated afterwards, each under the
 *   gate with reasoning off (L0: about 5 s, against about 100 s with it on).
 *   The list survives a restart, so an interrupted night still consolidates.
 */

import type { Logger } from "../log.ts";
import { getContact } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { getEvent } from "../state/events.ts";
import { getKv, setKv } from "../state/kv.ts";
import { isInvestigationEntry } from "../state/observations.ts";
import { dropEpisode, leaveStm, pendingEpisodes, type StmEpisode, transferFailed } from "../state/stm.ts";
import { isForgotten } from "../state/tombstones.ts";
import { banksBeingForgotten, PENDING_BANKS_KEY, retryBankDeletions } from "./forget.ts";
import type { GateResult } from "./gate.ts";
import { bankFor } from "./gateway.ts";
import { type HindsightClient, HindsightError, VERBATIM_STRATEGY } from "./hindsight.ts";
import {
	observedDocId,
	repliedDocId,
	SPEAKER_IYYE,
	SPEAKER_PERSON,
	SPEAKER_PROBE,
	saidDocId,
	summaryDocId,
} from "./provenance.ts";

/**
 * What every Iyye bank is told to extract (HLD §6.1, §11.2). A backstop only:
 * provenance comes from the speaker tags, and the person's documents hold no
 * words of Iyye's at all.
 */
export const RETAIN_MISSION = [
	"Each document holds the words of one person talking with Iyye, a personal assistant; its context names the person.",
	"Extract durable facts about that person and the people, places, plans, preferences, dates and commitments they state, including corrections of earlier facts.",
	"Iyye's own replies are not evidence: never record a fact only because Iyye said or repeated it.",
	"Ignore small talk, greetings, thanks, arithmetic and questions that state nothing new.",
	"Write every fact in English.",
].join(" ");

export interface NightGate {
	run<T>(label: string, fn: (model: string) => Promise<T>, opts?: { thinking?: boolean }): Promise<GateResult<T>>;
	readonly problem: string | null;
}

export interface NightDeps {
	db: Db;
	ltm: HindsightClient;
	gate: NightGate;
	log: Logger;
	now?: () => Date;
	/** The memory model's reasoning during extraction. */
	thinking?: boolean;
	maxAttempts?: number;
	/** The memory-salience shadow role (plan 0.003 K3): asked before each retain, joined to its result. */
	salience?: {
		ask(e: StmEpisode): Promise<string | null>;
		outcome(id: string, transfer: "completed" | "completed_empty"): void;
	} | null;
	/** Hindsight's stored model traces of a bank, purged after a forgotten bank is deleted. */
	purgeTraces?: ((bank: string) => Promise<unknown>) | null;
	/** Wait before retrying when the device is still busy (winding down). */
	busyRetryMs?: number;
	consolidatePollMs?: number;
	consolidateTimeoutMs?: number;
}

export type NightOutcome =
	| { kind: "done"; completed: number; empty: number; failed: number; consolidated: string[] }
	| { kind: "stopped"; completed: number; empty: number; failed: number }
	| { kind: "blocked"; reason: string; completed: number; empty: number; failed: number };

type Transfer = "completed" | "completed_empty" | "retry" | "failed" | { unreachable: string };

export class NightWork {
	private readonly d: Required<NightDeps>;
	private readonly banksReady = new Set<string>();

	constructor(deps: NightDeps) {
		this.d = {
			now: () => new Date(),
			thinking: true,
			purgeTraces: null,
			salience: null,
			maxAttempts: 3,
			busyRetryMs: 2000,
			consolidatePollMs: 2000,
			consolidateTimeoutMs: 600_000,
			...deps,
		};
	}

	/** Transfer every STM episode, then consolidate. `shouldStop` is checked between operations. */
	async run(shouldStop: () => boolean): Promise<NightOutcome> {
		this.banksReady.clear(); // banks may have been deleted since the last night (scripts/memory-clear.ts)
		const n = { completed: 0, empty: 0, failed: 0 };
		const attempted = new Set<string>();
		const salienceAsked = new Map<string, string | null>();
		// Forgotten banks go before anything is written (L6). A bank still queued is skipped tonight:
		// writing to it now would be wiped by its deletion, or would bring the person back.
		const left = await retryBankDeletions({
			db: this.d.db,
			ltm: this.d.ltm,
			log: this.d.log,
			purgeTraces: this.d.purgeTraces,
		});
		for (const bank of left) this.banksReady.delete(bank);
		for (;;) {
			const forgetting = banksBeingForgotten(this.d.db);
			const episode = pendingEpisodes(this.d.db, 200).find(
				(e) => !attempted.has(e.event_id) && !forgetting.has(bankFor(e.scope) ?? ""),
			);
			if (!episode) break;
			if (shouldStop()) return { kind: "stopped", ...n };
			// The tombstone is compared with when Iyye received it, as at answer time (said_at may be earlier).
			const receivedAt = getEvent(this.d.db, episode.event_id)?.received_at ?? episode.said_at;
			if (isForgotten(this.d.db, episode.scope, receivedAt)) {
				dropEpisode(this.d.db, episode.event_id); // said before a /forget: never stored
				continue;
			}
			// Shadow only (plan 0.003 K3): asked before the transfer, never read; the episode is retained regardless.
			// At most once per episode in a run: a retry while the device is busy must not journal a skip each time.
			if (this.d.salience && !salienceAsked.has(episode.event_id)) {
				salienceAsked.set(episode.event_id, await this.d.salience.ask(episode).catch(() => null));
			}
			const salienceId = salienceAsked.get(episode.event_id) ?? null;
			const r = await this.d.gate.run(`retain:${episode.event_id}`, () => this.transfer(episode), {
				thinking: this.d.thinking,
			});
			if (!r.ok) {
				if (!r.busy) return { kind: "blocked", reason: r.message, ...n };
				await sleep(this.d.busyRetryMs); // a chat turn is still finishing (winding down)
				continue;
			}
			const t = r.value;
			if (typeof t === "object") return { kind: "blocked", reason: t.unreachable, ...n };
			attempted.add(episode.event_id); // at most one attempt per episode per night
			if (salienceId && (t === "completed" || t === "completed_empty")) this.d.salience?.outcome(salienceId, t);
			if (t === "completed") n.completed++;
			else if (t === "completed_empty") n.empty++;
			else if (t === "failed") n.failed++;
		}
		const consolidated: string[] = [];
		const banks = this.pendingBanks().filter((b) => !banksBeingForgotten(this.d.db).has(b));
		for (let i = 0; i < banks.length; ) {
			const bank = banks[i]!;
			if (shouldStop()) return { kind: "stopped", ...n };
			const r = await this.d.gate.run(`consolidate:${bank}`, () => this.consolidate(bank, shouldStop));
			if (!r.ok) {
				if (!r.busy) return { kind: "blocked", reason: r.message, ...n };
				await sleep(this.d.busyRetryMs); // retry the same bank
				continue;
			}
			if (r.value === "stopped") return { kind: "stopped", ...n };
			if (typeof r.value === "object") return { kind: "blocked", reason: r.value.unreachable, ...n };
			// A failed consolidation keeps the bank pending for the next night; a deleted bank is dropped.
			if (r.value === "completed" || r.value === "gone") {
				this.setPendingBanks(this.pendingBanks().filter((b) => b !== bank));
				if (r.value === "completed") consolidated.push(bank);
			}
			i++;
		}
		return { kind: "done", consolidated, ...n };
	}

	private async transfer(e: StmEpisode): Promise<Transfer> {
		const bank = bankFor(e.scope);
		if (!bank) {
			leaveStm(this.d.db, e.event_id, "completed_empty", this.iso()); // a scope without a bank keeps nothing
			return "completed_empty";
		}
		try {
			try {
				await this.retainEpisode(bank, e);
			} catch (err) {
				// The bank was deleted while the host was running: create it again and retry once.
				if (!(err instanceof HindsightError) || err.status !== 404) throw err;
				this.banksReady.delete(bank);
				await this.retainEpisode(bank, e);
			}
			// Only the person's words decide whether the turn was worth keeping (Iyye's own entries: their one document).
			const units = await this.d.ltm.documentUnits(
				bank,
				e.kind === "observation"
					? observedDocId(e.event_id)
					: e.kind === "summary"
						? summaryDocId(e.event_id)
						: saidDocId(e.event_id),
			);
			if (units > 0) this.setPendingBanks([...new Set([...this.pendingBanks(), bank])]);
			const state = units > 0 ? "completed" : "completed_empty";
			leaveStm(this.d.db, e.event_id, state, this.iso());
			return state;
		} catch (err) {
			if (!(err instanceof HindsightError) || isOutage(err)) {
				return { unreachable: `long-term memory is unreachable: ${(err as Error).message}` };
			}
			this.d.log.warn("memory: transfer failed", { eventId: e.event_id, error: err.message });
			return transferFailed(this.d.db, e.event_id, err.message, this.d.maxAttempts) === "failed"
				? "failed"
				: "retry";
		}
	}

	private async retainEpisode(bank: string, e: StmEpisode): Promise<void> {
		if (!this.banksReady.has(bank)) {
			await this.d.ltm.ensureBank(bank, { retainMission: RETAIN_MISSION });
			this.banksReady.add(bank);
		}
		const who = this.speaker(e);
		const base = [`scope:${e.scope}`, ...(e.channel ? [`channel:${e.channel}`] : [])];
		if (e.kind === "observation" || e.kind === "summary") {
			// Iyye's own entries (plan 0.007 S4), stored verbatim: no model extraction can rephrase a measurement
			// into a fact about a person, and the speaker tag says what each is.
			const finding = e.kind === "observation";
			// An investigation's answer is the background model's text, grounded in tool results but not itself a
			// measurement: it is stored as Iyye's own words (rule 1), never as `speaker:probe` evidence (S5).
			const investigation = finding && isInvestigationEntry(this.d.db, e.event_id);
			await this.d.ltm.retain(bank, {
				documentId: finding ? observedDocId(e.event_id) : summaryDocId(e.event_id),
				content: e.user_text,
				context: investigation
					? "Iyye's own investigation, written from read-only tool results: the tool results were the evidence, these are Iyye's words."
					: finding
						? "A finding of Iyye's own probe of its computer or its own code: a measurement, not anyone's statement."
						: "Iyye's own summary of a day, built from its records. Iyye's words, not evidence about anyone.",
				timestamp: e.said_at,
				tags: [
					...base,
					investigation || !finding ? SPEAKER_IYYE : SPEAKER_PROBE,
					investigation ? "investigation" : finding ? "finding" : "day-summary",
				],
				metadata: { entry_id: e.event_id, kind: e.kind },
				strategy: VERBATIM_STRATEGY,
			});
			return;
		}
		if (e.kind === "remember") {
			// `/remember`: the owner's own words, stated as something to keep. There is no reply.
			await this.d.ltm.retain(bank, {
				documentId: saidDocId(e.event_id),
				content: e.user_text,
				context:
					"The owner explicitly asked Iyye to remember this (local web chat). Every statement here is the owner's own.",
				timestamp: e.said_at,
				tags: [...base, SPEAKER_PERSON, "remember"],
				metadata: { event_id: e.event_id, speaker: who, kind: "remember" },
			});
			return;
		}
		// Provenance by construction: one document per speaker, tagged by the host, never judged by the model.
		// The person's words alone are extracted; no text of Iyye's is in that document.
		await this.d.ltm.retain(bank, {
			documentId: saidDocId(e.event_id),
			content: e.user_text,
			context: `${who} wrote this to Iyye (${e.channel === "web" ? "local web chat" : "Telegram"}). Every statement here is ${who}'s own.`,
			timestamp: e.said_at,
			tags: [...base, SPEAKER_PERSON],
			metadata: { event_id: e.event_id, speaker: who },
		});
		// Iyye's reply is stored verbatim, with no model call: searchable as what Iyye said, never rephrased into a fact.
		if (e.reply_text.trim()) {
			await this.d.ltm.retain(bank, {
				documentId: repliedDocId(e.event_id),
				content: e.reply_text,
				context: `Iyye's own reply to ${who}. Iyye's words, not evidence about ${who} or the world.`,
				timestamp: e.answered_at,
				tags: [...base, SPEAKER_IYYE],
				metadata: { event_id: e.event_id, action_id: e.action_id ?? "", speaker: "Iyye" },
				strategy: VERBATIM_STRATEGY,
			});
		}
	}

	private async consolidate(
		bank: string,
		shouldStop: () => boolean,
	): Promise<"completed" | "failed" | "gone" | "stopped" | { unreachable: string }> {
		try {
			const op = await this.d.ltm.consolidate(bank);
			const deadline = Date.now() + this.d.consolidateTimeoutMs;
			while (Date.now() < deadline) {
				const status = await this.d.ltm.operationStatus(bank, op);
				if (status === "completed") return "completed";
				if (status === "failed" || status === "cancelled" || status === "not_found") {
					this.d.log.warn("memory: consolidation did not complete", { bank, status });
					return "failed";
				}
				if (shouldStop()) return "stopped"; // the gate then drains and aborts its model calls
				await sleep(this.d.consolidatePollMs);
			}
			this.d.log.warn("memory: consolidation timed out", { bank });
			return "failed";
		} catch (err) {
			if (err instanceof HindsightError && err.status === 404) return "gone"; // deleted: nothing left to consolidate
			if (!(err instanceof HindsightError) || isOutage(err))
				return { unreachable: `long-term memory is unreachable: ${(err as Error).message}` };
			this.d.log.warn("memory: consolidation failed", { bank, error: err.message });
			return "failed";
		}
	}

	private speaker(e: StmEpisode): string {
		if (e.scope === "owner") return "the owner";
		if (e.kind === "observation" || e.kind === "summary" || !e.contact_id) return "Iyye";
		const c = getContact(this.d.db, e.contact_id);
		return `the contact ${JSON.stringify((c?.display_name ?? "unknown").slice(0, 64))}`;
	}

	private pendingBanks(): string[] {
		try {
			return JSON.parse(getKv(this.d.db, PENDING_BANKS_KEY) ?? "[]") as string[];
		} catch {
			return [];
		}
	}

	private setPendingBanks(banks: string[]): void {
		setKv(this.d.db, PENDING_BANKS_KEY, JSON.stringify(banks), this.iso());
	}

	private iso(): string {
		return this.d.now().toISOString();
	}
}

/** Hindsight is up but cannot work (its database, or the pass-through to the model, is down): not the episode's fault. */
function isOutage(err: HindsightError): boolean {
	return err.status === 502 || err.status === 503 || err.status === 504;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
