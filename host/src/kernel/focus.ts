// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** `/focus` (plan 0.007 S1): what Iyye is doing now, the rule that chose it, and its background queue. */

import { backgroundJobsIn } from "../state/background.ts";
import type { Db } from "../state/db.ts";
import type { BackgroundWorker } from "./background.ts";

export interface FocusState {
	db: Db;
	worker: Pick<BackgroundWorker, "status" | "initiativePaused">;
	/** The device slot's current holder label, if any. */
	deviceHolder: string | null;
	/** Reply jobs waiting. */
	queuedReplies: number;
	/** `remote`: the state of another machine's model (plan 0.012), e.g. "on mbp: up"; it is never "loaded" here. */
	backgroundModel: { name: string | null; loaded: boolean; remote?: string | null };
	quietS: number;
	gapS: number;
}

export function focusReport(s: FocusState): string {
	const when = (iso: string | null) => (iso ? new Date(iso).toTimeString().slice(0, 5) : "?");
	const st = s.worker.status();
	const lines = [
		`now: ${describeHolder(s.deviceHolder, st.running?.origin)}`,
		`order: owner input → people waiting → owner-requested work → background work (only after ${Math.round(s.quietS / 60)} min without conversation; steps at least ${s.gapS} s apart)`,
	];
	if (s.queuedReplies) lines.push(`people waiting: ${s.queuedReplies} message(s)`);
	lines.push(
		`initiative: ${s.worker.initiativePaused() ? "PAUSED (/resume initiative)" : "on (/pause initiative)"}`,
		`background model: ${s.backgroundModel.name ?? "none selected (/use <model> background)"}${s.backgroundModel.name ? (s.backgroundModel.remote ? ` (${s.backgroundModel.remote}; a conversation here does not hold it back)` : s.backgroundModel.loaded ? " (loaded)" : " (not loaded)") : ""}`,
	);
	if (!st.running) lines.push(`background: waiting: ${st.waiting}`);
	const queue = backgroundJobsIn(s.db, ["running", "paused", "queued"]).reverse();
	if (queue.length === 0) lines.push("background queue: empty");
	else {
		lines.push(`background queue: ${queue.length}`);
		for (const j of queue.slice(0, 8)) {
			lines.push(
				`  ${j.id.slice(0, 8)} ${j.origin} — ${j.status}${j.pauses ? ` (paused ×${j.pauses})` : ""}, since ${when(j.created_at)}`,
			);
		}
	}
	const done = backgroundJobsIn(s.db, ["settled", "failed", "suspended"], 3);
	if (done.length) {
		lines.push("recent background steps:");
		for (const j of done) {
			lines.push(
				`  ${j.id.slice(0, 8)} ${j.origin} — ${j.status} at ${when(j.settled_at)}${j.error ? `: ${j.error.slice(0, 120)}` : ""}`,
			);
		}
	}
	return lines.join("\n");
}

function describeHolder(holder: string | null, backgroundOrigin: string | undefined): string {
	if (!holder) return "idle";
	if (holder.startsWith("chat:")) return "answering a message";
	if (holder === "console") return "a terminal chat turn";
	if (holder.startsWith("memory:")) return `memory work (${holder.slice("memory:".length).split(":")[0]})`;
	if (holder.startsWith("decision:")) return `a shadow decision (${holder.slice("decision:".length)})`;
	if (holder.startsWith("background:"))
		return `a background step ${holder.slice("background:".length, "background:".length + 8)}${backgroundOrigin ? ` (${backgroundOrigin})` : ""}`;
	return holder;
}
