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
 */

import type { Complete } from "../facts/extractor.ts";
import type { ModelLease, OpResult } from "../models/manager.ts";

export type Composed = { ok: true; text: string } | { ok: false; notNow: string } | { ok: false; error: string };

export interface ComposerDeps {
	device: { tryAcquire(label: string, opts?: { onPreempt?: () => void }): (() => void) | null };
	models: { selected(key: "background"): string | null; acquire(name: string): Promise<ModelLease | OpResult> };
	background: { blockedReason(): string | null; yieldReason(): string | null };
	complete: Complete;
	energy?: { deviceTime(kind: "background", ms: number, ref: string): void } | null;
	now?: () => Date;
	watchMs?: number;
}

/** Make one completion under background work's rules: the text, "not now" (try later), or an error. */
export function makeComposer(deps: ComposerDeps): (label: string, system: string, user: string) => Promise<Composed> {
	const now = deps.now ?? (() => new Date());
	return async (label, system, user) => {
		const blocked = deps.background.blockedReason();
		if (blocked) return { ok: false, notNow: blocked };
		const model = deps.models.selected("background");
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
		const release = deps.device.tryAcquire(`motivation:${label}`, {
			onPreempt: () => giveWay("a person needs the device"),
		});
		if (!release) {
			lease.release();
			return { ok: false, notNow: "the device is busy" };
		}
		const watch = setInterval(() => {
			const why = deps.background.yieldReason();
			if (why) giveWay(why);
		}, deps.watchMs ?? 250);
		watch.unref();
		const t0 = now().getTime();
		try {
			const text = await deps.complete(model, system, user, abort.signal);
			if (gaveWay) return { ok: false, notNow: `gave way: ${gaveWay}` };
			return { ok: true, text };
		} catch (err) {
			return gaveWay ? { ok: false, notNow: `gave way: ${gaveWay}` } : { ok: false, error: (err as Error).message };
		} finally {
			clearInterval(watch);
			release();
			lease.release();
			deps.energy?.deviceTime("background", now().getTime() - t0, `motivation:${label}`);
		}
	};
}
