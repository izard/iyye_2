// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * What happened to an opportunity (plan 0.010 M4), as records: its structured
 * outcome, whether Iyye's action produced it, and the events on the way.
 * M4's report and Stage 3/4 read these, never Iyye's prose.
 *
 * Four levels, never conflated: attempted (an action taken), delivered (it
 * reached its person: the outbox's receipt), resolved (the condition closed:
 * `outcome`, with `credited` when Iyye's action produced it), useful (later
 * evidence: the owner's word).
 */

import type { Db } from "../state/db.ts";

export type Outcome =
	| "resolved"
	| "declined"
	| "expired"
	| "failed"
	| "capped"
	| "covered"
	| "nothing"
	| "gone"
	| "suspended";
export type EventKind =
	| "opened"
	| "attempted"
	| "withheld"
	| "preempted"
	| "fruitless"
	| "settled"
	| "useful"
	| "not_useful";

/** Why an action did not run now (the `withheld` events' reasons, for the report). */
export type WithheldReason =
	| "paused"
	| "quiet hours"
	| "owner busy"
	| "person busy"
	| "daily cap"
	| "allowance"
	| "energy"
	| "model unavailable"
	| "another initiative job"
	| "higher priority"
	| "asleep";

function localDay(at: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

export function recordEvent(
	db: Db,
	e: {
		opportunityId: string | null;
		motivation: string | null;
		kind: EventKind;
		reason?: string | null;
		ref?: string | null;
		at: Date;
	},
): void {
	// A withheld action is noted once per opportunity, reason and day: the sweep repeats it every ten minutes.
	const dedup = e.kind === "withheld" ? `${e.opportunityId}|${e.reason}|${localDay(e.at)}` : null;
	db.prepare(
		"INSERT OR IGNORE INTO motivation_events (id, at, opportunity_id, motivation, kind, reason, ref, dedup) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		crypto.randomUUID(),
		e.at.toISOString(),
		e.opportunityId,
		e.motivation,
		e.kind,
		e.reason ?? null,
		e.ref ?? null,
		dedup,
	);
}

/** Event ids are random: the journal never takes ids from a caller's sequence (tests rely on theirs). */
/** Settle (or, for `suspended`, suspend) an opportunity with its outcome, and journal it. */
export function settleOpportunity(
	db: Db,
	id: string,
	o: { outcome: Outcome; credited?: boolean; answer?: string | null; at: Date },
): void {
	const row = db.prepare("SELECT motivation FROM opportunities WHERE id = ?").get(id) as
		| { motivation: string | null }
		| undefined;
	if (!row) return;
	db.prepare(
		"UPDATE opportunities SET status = ?, outcome = ?, credited = ?, answer = coalesce(?, answer), updated_at = ? WHERE id = ?",
	).run(
		o.outcome === "suspended" ? "suspended" : "settled",
		o.outcome,
		o.credited ? 1 : 0,
		o.answer ?? null,
		o.at.toISOString(),
		id,
	);
	recordEvent(db, {
		opportunityId: id,
		motivation: row.motivation,
		kind: "settled",
		reason: `${o.outcome}${o.credited ? " (credited)" : ""}`,
		at: o.at,
	});
}
