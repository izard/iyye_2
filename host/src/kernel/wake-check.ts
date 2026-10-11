// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The wake check (plan 0.007 S3, HLD §11.1: "on waking, Iyye briefly checks
 * its health"): deterministic, from records and service states, no model.
 * It returns only problems; nothing to say means no message.
 */

import { lastOrphanCheck, orphanTotal } from "../facts/orphans.ts";
import type { Db } from "../state/db.ts";

export interface WakeState {
	db: Db;
	/** name → state ("up", "disabled", …), for the services that should be up. */
	services: Record<string, string>;
	/** Models selected for the day but not loaded after waking. */
	missingModels: string[];
	now?: Date;
}

const QUIET_STATES = new Set(["up", "connected", "disabled", "not installed"]);

export function wakeProblems(s: WakeState): string[] {
	const out: string[] = [];
	for (const [name, state] of Object.entries(s.services)) {
		if (!QUIET_STATES.has(state)) out.push(`${name} is ${state}`);
	}
	if (s.missingModels.length) out.push(`not loaded after waking: ${s.missingModels.join(", ")}`);
	const n = (sql: string) => (s.db.prepare(sql).get() as { n: number }).n;
	const backlog = n("SELECT count(*) AS n FROM stm_episodes WHERE state = 'backlog'");
	if (backlog)
		out.push(`${backlog} earlier conversation(s) are still waiting to be stored in long-term memory (/memory)`);
	const unknown = n("SELECT count(*) AS n FROM actions WHERE state = 'unknown'");
	if (unknown) out.push(`${unknown} message(s) may or may not have been delivered and need your review`);
	const suspended = n(
		"SELECT count(*) AS n FROM background_jobs WHERE status = 'suspended' AND settled_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')",
	);
	if (suspended) out.push(`${suspended} background step(s) were suspended after too many interruptions (/focus)`);
	const forgetting = n("SELECT count(*) AS n FROM bank_deletions_pending");
	if (forgetting) out.push(`${forgetting} forgotten memory bank(s) could not be deleted yet (/memory)`);
	// The fact ledger's orphan check of the night just ended (plan 0.011 §5).
	const orphans = lastOrphanCheck(s.db);
	if (orphans && Date.parse(orphans.at) >= (s.now ?? new Date()).getTime() - 86_400_000) {
		if (orphans.error)
			out.push(`the check of stored facts against long-term memory could not finish (/facts report)`);
		else if (orphanTotal(orphans))
			out.push(`${orphanTotal(orphans)} stored fact(s) and long-term memory disagree (/facts report)`);
	}
	return out;
}

export function wakeMessage(day: number, problems: string[]): string {
	return [`Waking up on day ${day}, a few things need attention:`, ...problems.map((p) => `- ${p}`)].join("\n");
}
