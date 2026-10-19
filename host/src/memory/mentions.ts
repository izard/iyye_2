// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a text names a person (`/forget`, plan 0.002 L6; owner decision
 * 2026-10-19). Without a record of which memory fed each reply, the only way
 * to find Iyye's stored words that may quote someone is their name: whole
 * words, any case, every name the person and their linked accounts carry.
 * It errs both ways, and the owner sees the count before confirming: a
 * namesake's text goes too, and a quote that never names them stays.
 */

import { accountsOf, type Contact } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";

/** Names shorter than this would match inside ordinary text ("Al", "Bo"): they are not looked for. */
export const MIN_NAME_CHARS = 3;

export function personNames(db: Db, person: Contact): string[] {
	const names = [person.display_name, ...accountsOf(db, person.id).map((a) => a.display_name)]
		.map((n) => n.trim().replace(/\s+/g, " "))
		.filter((n) => [...n].length >= MIN_NAME_CHARS);
	return [...new Set(names.map((n) => n.toLowerCase()))];
}

/** One pattern for all the names: whole words only, any case, any script. */
export function mentionPattern(names: readonly string[]): RegExp | null {
	if (names.length === 0) return null;
	const alts = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
	return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
}

export function mentionsAny(text: string, names: readonly string[]): boolean {
	const re = mentionPattern(names);
	return re !== null && re.test(text);
}
