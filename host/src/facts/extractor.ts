// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Fact extraction during the day (plan 0.011 F1): one document at a time,
 * on the background model, while nobody needs the device.
 *
 * - **Background work's rules** (plan 0.007 S1), from the background worker
 *   itself: awake, initiative not paused, nobody waiting, no conversation
 *   for the quiet period, energy above the reserve. It never loads a model.
 * - **Preemptible:** it holds the device slot as preemptible; when a person
 *   needs the device, or a reason to give way appears, the call is aborted
 *   and its output is never used (the document stays to do, no attempt
 *   charged). Device time is paid for like a background step.
 * - **One direct completion per document** (no tools, no Pi session): an
 *   explicit `max_tokens`, thinking off, and a hang detector only.
 * - What is left at night is extracted by the night under the memory gate
 *   (`extractPendingAtNight`), before the merge.
 */

import { IdleLoop } from "../decisions/idle.ts";
import type { Logger } from "../log.ts";
import type { ModelLease, OpResult } from "../models/manager.ts";
import type { Db } from "../state/db.ts";
import { extractionInput, extractionPrompt, type KnownPerson, parseFacts, processFacts } from "./extract.ts";
import { type FactDoc, knownPeople, pendingDocs, recordExtraction, recordExtractionFailure } from "./store.ts";

/** One completion: the model's text, or null when it gave nothing usable (an error is thrown). */
export type Complete = (model: string, system: string, user: string, signal: AbortSignal) => Promise<string>;

/**
 * A completion on the router (as the day summary does): explicit max_tokens, thinking off, a hang detector.
 * `routerUrl` may depend on the model: another machine's model goes to its pass-through (plan 0.012).
 */
export function routerComplete(routerUrl: string | ((model: string) => string), maxTokens = 1200): Complete {
	return async (model, system, user, signal) => {
		const base = typeof routerUrl === "string" ? routerUrl : routerUrl(model);
		const res = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model,
				stream: false,
				max_tokens: maxTokens,
				temperature: 0,
				chat_template_kwargs: { enable_thinking: false },
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
			}),
			signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]), // a hang detector, not a latency budget
		});
		if (!res.ok) throw new Error(`the model answered HTTP ${res.status}`);
		const body = (await res.json()) as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] };
		const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
		// Cut off at max_tokens: what arrived is not the answer (2026-10-10 review: a partial JSON line read as
		// a complete extraction). A failure, so the caller tries again or gives up, never uses half an answer.
		if (choice?.finish_reason === "length") throw new Error(`the answer was cut off at ${maxTokens} tokens`);
		// Only a finished answer with text counts: a body without one (`{}`) is no answer, never an empty one.
		if (!choice || typeof choice.message?.content !== "string")
			throw new Error("the model's response had no answer text");
		// Only "stop" says the answer is finished (2026-10-10 review): a missing marker is no proof of it.
		if (choice.finish_reason !== "stop")
			throw new Error(`the answer ended with ${JSON.stringify(choice.finish_reason ?? null)}, not "stop"`);
		return choice.message.content;
	};
}

/** Extract one document and store the result. Throws when the model failed (nothing is stored). */
export async function extractOne(
	db: Db,
	d: FactDoc,
	opts: {
		complete: Complete;
		model: string;
		signal: AbortSignal;
		people?: KnownPerson[];
		now: () => Date;
		newId: () => string;
	},
): Promise<number> {
	const t0 = opts.now().getTime();
	const text = await opts.complete(opts.model, extractionPrompt(d.doc.kind), extractionInput(d.doc), opts.signal);
	if (opts.signal.aborted) throw new Error("aborted");
	const parsed = parseFacts(text);
	// "Nothing to extract" is an empty reply (the prompt's own rule). Text with no well-formed fact line is a
	// failed attempt, not an empty document: retried, and given up only after MAX_ATTEMPTS.
	if (text.trim() && parsed.facts.length === 0)
		throw new Error(
			parsed.bad > 0
				? `${parsed.bad} malformed line(s) and no fact`
				: "the reply was not JSON lines (and not empty)",
		);
	const { kept, dropped } = processFacts(parsed.facts, d.doc, opts.people ?? knownPeople(db));
	const reasons: Record<string, number> = {};
	for (const x of dropped) {
		const why = x.why.replace(/^(the (?:number|date|name)) .+ is not in the source$/, "$1 is not in the source");
		reasons[why] = (reasons[why] ?? 0) + 1;
	}
	return recordExtraction(db, d, {
		kept,
		dropped: reasons,
		badLines: parsed.bad,
		model: opts.model,
		deviceMs: opts.now().getTime() - t0,
		at: opts.now().toISOString(),
		newId: opts.newId,
	});
}

type Slot = { tryAcquire(label: string, opts?: { onPreempt?: () => void }): (() => void) | null };

export interface FactExtractorDeps {
	db: Db;
	log: Logger;
	device: Slot;
	/** The device slot of the machine a model runs on (plan 0.012); `device` when absent. */
	deviceFor?: ((model: string) => Slot) | null;
	models: {
		selected(key: "background"): string | null;
		acquire(name: string): Promise<ModelLease | OpResult>;
		isRemote?(name: string): boolean;
	};
	/** The background worker: its rules for when background work may start, and when it must give way. */
	background: {
		blockedReason(opts?: { remote?: boolean }): string | null;
		yieldReason(opts?: { remote?: boolean }): string | null;
	};
	complete: Complete;
	energy?: { deviceTime(kind: "background", ms: number, ref: string): void } | null;
	enabled?: boolean;
	now?: () => Date;
	newId?: () => string;
	pollMs?: number;
	watchMs?: number;
}

export class FactExtractor {
	private readonly d: Required<FactExtractorDeps>;
	private readonly loop: IdleLoop;
	private running = false;
	private lastReason = "starting";

	constructor(deps: FactExtractorDeps) {
		this.d = {
			energy: null,
			deviceFor: null,
			enabled: true,
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			pollMs: 15_000,
			watchMs: 250,
			...deps,
		};
		this.loop = new IdleLoop({ pollMs: this.d.pollMs, drain: () => this.drainOnce() });
	}

	start(): void {
		if (this.d.enabled) this.loop.start();
	}

	stop(): Promise<void> {
		return this.loop.stop();
	}

	wake(): void {
		this.loop.wake();
	}

	/** Why nothing is extracted right now (for /facts). */
	status(): string {
		return this.d.enabled ? this.lastReason : "off (IYYE2_FACTS_EXTRACT=0)";
	}

	/** Extract one document if one may run now (exposed for tests). Returns true if one was attempted. */
	async drainOnce(): Promise<boolean> {
		if (this.running) return false;
		const model = this.d.models.selected("background");
		const remote = model !== null && this.d.models.isRemote?.(model) === true;
		const blocked = this.d.background.blockedReason({ remote });
		if (blocked) {
			this.lastReason = blocked;
			return false;
		}
		const d = pendingDocs(this.d.db, ["day"], 1)[0];
		if (!d) {
			this.lastReason = "nothing to extract";
			return false;
		}
		if (!model) {
			this.lastReason = "no background model is selected";
			return false;
		}
		const lease = await this.d.models.acquire(model); // refused unless already loaded: never loads a model
		if (!("release" in lease)) {
			this.lastReason = `the background model is not available: ${lease.message}`;
			return false;
		}
		const abort = new AbortController();
		let gaveWay: string | null = null;
		const giveWay = (why: string) => {
			gaveWay ??= why;
			abort.abort();
		};
		const release = (this.d.deviceFor?.(model) ?? this.d.device).tryAcquire(`facts:${d.docId}`, {
			onPreempt: () => giveWay("a person needs the device"),
		});
		if (!release) {
			lease.release();
			this.lastReason = "the device is busy";
			return false;
		}
		this.running = true;
		const watch = setInterval(() => {
			const why = this.d.background.yieldReason({ remote });
			if (why) giveWay(why);
		}, this.d.watchMs);
		watch.unref();
		const t0 = this.d.now().getTime();
		try {
			const n = await extractOne(this.d.db, d, {
				complete: this.d.complete,
				model,
				signal: abort.signal,
				now: this.d.now,
				newId: this.d.newId,
			});
			this.lastReason = "extracting";
			this.d.log.info("facts: extracted", { doc: d.docId, kept: n });
		} catch (err) {
			// Given way, or the other machine was lost (plan 0.012): the output is discarded and the document
			// stays to do, uncharged.
			if (!gaveWay && !(remote && !lease.valid()))
				recordExtractionFailure(this.d.db, d, model, (err as Error).message, this.d.now().toISOString());
			this.lastReason = gaveWay ? `gave way: ${gaveWay}` : `the last extraction failed: ${(err as Error).message}`;
		} finally {
			clearInterval(watch);
			release();
			lease.release();
			this.running = false;
			this.d.energy?.deviceTime("background", this.d.now().getTime() - t0, `facts:${d.docId}`);
		}
		return true;
	}
}

/**
 * At night, before the merge: extract what the day left, under the memory
 * gate (the memory model), one document per gate run so owner input waits for
 * at most one. Returns how many documents were done, or why it stopped.
 */
export async function extractPendingAtNight(deps: {
	db: Db;
	log: Logger;
	gate: {
		run<T>(
			label: string,
			fn: (model: string) => Promise<T>,
			opts?: { thinking?: boolean },
		): Promise<{ ok: true; value: T } | { ok: false; busy?: boolean; message: string }>;
	};
	complete: Complete;
	shouldStop: () => boolean;
	now?: () => Date;
	newId?: () => string;
	busyRetryMs?: number;
}): Promise<{ done: number; stopped: string | null }> {
	const now = deps.now ?? (() => new Date());
	const newId = deps.newId ?? (() => crypto.randomUUID());
	let done = 0;
	const tried = new Set<string>();
	for (;;) {
		if (deps.shouldStop()) return { done, stopped: "stopped" };
		const d = pendingDocs(deps.db, ["day", "backlog"], 50).find((x) => !tried.has(x.docId));
		if (!d) return { done, stopped: null };
		const r = await deps.gate.run(
			`facts:${d.docId}`,
			async (model) => {
				try {
					await extractOne(deps.db, d, {
						complete: deps.complete,
						model,
						signal: new AbortController().signal,
						now,
						newId,
					});
					return true;
				} catch (err) {
					recordExtractionFailure(deps.db, d, model, (err as Error).message, now().toISOString());
					return false;
				}
			},
			{ thinking: false },
		);
		if (!r.ok) {
			if (!r.busy) return { done, stopped: r.message };
			await new Promise((x) => setTimeout(x, deps.busyRetryMs ?? 2000));
			continue;
		}
		tried.add(d.docId);
		if (r.value) done++;
	}
}
