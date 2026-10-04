// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** The owner's `/memory` report (plan 0.002 §3.5): day/night, STM by conversation, failures, LTM. */

import { getContact } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { stmCounts } from "../state/stm.ts";
import { pendingBankDeletions } from "../state/tombstones.ts";

export interface ReportState {
	mode: string;
	day: number;
	lastNight: string | null;
	ltm: string;
	problem: string | null;
}

export function memoryReport(db: Db, s: ReportState): string {
	const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "never");
	const lines = [
		`${s.mode.replace("_", " ")}, day ${s.day} · last night: ${when(s.lastNight)}`,
		`long-term memory: ${s.ltm}`,
		...(s.problem ? [`memory work blocked: ${s.problem}`] : []),
	];
	const counts = stmCounts(db);
	if (counts.length === 0) lines.push("short-term memory (today): empty");
	else {
		lines.push("short-term memory (today; moves to long-term memory at night):");
		for (const c of counts) {
			const who =
				c.scope === "owner" ? "you" : (getContact(db, c.scope.replace(/^contact:/, ""))?.display_name ?? c.scope);
			lines.push(`  ${who}: ${c.n} conversation(s) since ${when(c.oldest)}`);
		}
	}
	const backlog = db
		.prepare(
			"SELECT count(*) AS n, min(said_at) AS oldest, max(attempts) AS tries FROM stm_episodes WHERE state = 'backlog'",
		)
		.get() as { n: number; oldest: string | null; tries: number | null };
	if (backlog.n > 0) {
		lines.push(
			`transfer backlog: ${backlog.n} earlier conversation(s) not yet stored, since ${when(backlog.oldest)} (up to ${backlog.tries ?? 0} failed attempt(s); not recallable until stored)`,
		);
	}
	const failed = db
		.prepare("SELECT count(*) AS n, max(last_error) AS err FROM stm_episodes WHERE state = 'failed'")
		.get() as { n: number; err: string | null };
	if (failed.n > 0) {
		lines.push(`${failed.n} conversation(s) dropped from the backlog (never stored): ${failed.err ?? ""}`);
	}
	const forgetting = pendingBankDeletions(db);
	if (forgetting.length > 0) {
		lines.push(
			`forgotten, deletion pending (never read; retried at startup and every night): ${forgetting
				.map(
					(p) =>
						`${p.bank} since ${when(p.requested_at)}, ${p.attempts} attempt(s)${p.last_error ? `: ${p.last_error}` : ""}`,
				)
				.join("; ")}`,
		);
	}
	return lines.join("\n");
}
