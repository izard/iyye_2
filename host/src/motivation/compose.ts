// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * One model call for the motivations' own work (plan 0.010 M3): drafting a
 * plan from the owner's intention, composing a follow-up. The same rules as
 * the fact extractor (plan 0.011 F1), which are background work's own:
 *
 * - it runs only when background work may start (`blockedReason`: awake,
 *   initiative not paused, nobody waiting, no conversation for the quiet
 *   period, energy above the reserve), on the background model if it is
 *   already loaded (never loads one);
 * - it holds the device as preemptible and gives way the moment a person
 *   needs it or a reason to yield appears; the output of a call that gave way
 *   is discarded;
 * - one direct completion: no tools and no Pi session, so nothing the prompt
 *   holds is kept anywhere; device time is paid for.
 * - on another machine's model (plan 0.012) it takes that machine's device
 *   slot, a conversation here does not hold it back, and a lost connection
 *   is "not now", never an error.
 */

import type { Complete } from "../facts/extractor.ts";
import type { ModelLease, OpResult } from "../models/manager.ts";
import type { InitiativeLedger } from "./budget.ts";
import type { Motivation } from "./signals.ts";

export type Composed = { ok: true; text: string } | { ok: false; notNow: string } | { ok: false; error: string };

type Slot = { tryAcquire(label: string, opts?: { onPreempt?: () => void }): (() => void) | null };

export interface ComposerDeps {
	device: Slot;
	/** The device slot of the machine a model runs on (plan 0.012); `device` when absent. */
	deviceFor?: ((model: string) => Slot) | null;
	models: {
		selected(key: "background"): string | null;
		acquire(name: string): Promise<ModelLease | OpResult>;
		isRemote?(name: string): boolean;
	};
	background: {
		blockedReason(opts?: { remote?: boolean }): string | null;
		yieldReason(opts?: { remote?: boolean }): string | null;
	};
	complete: Complete;
	energy?: { deviceTime(kind: "background", ms: number, ref: string): void } | null;
	/** M4: initiative's ledger: one job at a time, and each call's device time charged to its motivation. */
	ledger?: Pick<InitiativeLedger, "charge" | "whileComposing"> | null;
	now?: () => Date;
	watchMs?: number;
}

/** Make one completion under background work's rules: the text, "not now" (try later), or an error. */
export function makeComposer(
	deps: ComposerDeps,
): (label: string, system: string, user: string, motivation?: Motivation, opportunityId?: string) => Promise<Composed> {
	const now = deps.now ?? (() => new Date());
	return (label, system, user, motivation, opportunityId) =>
		deps.ledger && opportunityId
			? deps.ledger.whileComposing(opportunityId, () => run(label, system, user, motivation, opportunityId))
			: run(label, system, user, motivation, opportunityId);
	async function run(
		label: string,
		system: string,
		user: string,
		motivation: Motivation | undefined,
		opportunityId: string | undefined,
	): Promise<Composed> {
		const model = deps.models.selected("background");
		const remote = model !== null && deps.models.isRemote?.(model) === true;
		const blocked = deps.background.blockedReason({ remote });
		if (blocked) return { ok: false, notNow: blocked };
		if (!model) return { ok: false, notNow: "no background model is selected" };
		const lease = await deps.models.acquire(model);
		if (!("release" in lease))
			return { ok: false, notNow: `the background model is not available: ${lease.message}` };
		const abort = new AbortController();
		let gaveWay: string | null = null;
		const giveWay = (why: string) => {
			gaveWay ??= why;
			abort.abort();
		};
		const release = (deps.deviceFor?.(model) ?? deps.device).tryAcquire(`motivation:${label}`, {
			onPreempt: () => giveWay("a person needs the device"),
		});
		if (!release) {
			lease.release();
			return { ok: false, notNow: "the device is busy" };
		}
		const watch = setInterval(() => {
			const why = deps.background.yieldReason({ remote });
			if (why) giveWay(why);
		}, deps.watchMs ?? 250);
		watch.unref();
		const t0 = now().getTime();
		try {
			const text = await deps.complete(model, system, user, abort.signal);
			if (gaveWay) return { ok: false, notNow: `gave way: ${gaveWay}` };
			return { ok: true, text };
		} catch (err) {
			if (gaveWay) return { ok: false, notNow: `gave way: ${gaveWay}` };
			// Plan 0.012: the other machine went away mid-call; the work waits for it.
			if (remote && !lease.valid()) return { ok: false, notNow: "the remote model's machine was lost" };
			return { ok: false, error: (err as Error).message };
		} finally {
			clearInterval(watch);
			const kept = !gaveWay && (!remote || lease.valid());
			release();
			lease.release();
			const ms = now().getTime() - t0;
			deps.energy?.deviceTime("background", ms, `motivation:${label}`);
			// M4: the call ran, so its time counts against its motivation, kept or discarded.
			if (motivation && deps.ledger)
				deps.ledger.charge({
					motivation,
					opportunityId: opportunityId ?? null,
					source: "compose",
					machine: remote ? "remote" : "local",
					ms,
					kept,
					ref: `compose:${label}:${t0}`,
				});
		}
	}
}
