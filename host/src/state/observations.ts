// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Observation records (plan 0.007 S4/S5) as other modules need them. */

import type { Db } from "./db.ts";

/** Investigation answers are observations too, but written by the background model (S5). */
export const INVESTIGATION_DOMAIN = "investigation";

/**
 * True when an STM entry (`obs:<observation id>`) holds an investigation's
 * answer: Iyye's own words, grounded in tool results, never a measurement
 * (rule 1: Iyye's narration is not evidence).
 */
export function isInvestigationEntry(db: Db, entryId: string): boolean {
	if (!entryId.startsWith("obs:")) return false;
	const row = db.prepare("SELECT domain FROM observations WHERE id = ?").get(entryId.slice(4)) as
		| { domain: string }
		| undefined;
	return row?.domain === INVESTIGATION_DOMAIN;
}
