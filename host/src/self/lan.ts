// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The hosts on Iyye's local network (plan 0.018 W2, table `lan_hosts`):
 * who was seen, when first and last, and what the owner calls them. Owner
 * only: nothing here reaches a contact's turn or a session that can search
 * the web.
 */

import type { Db } from "../state/db.ts";
import { hostId, isLanHost, type Neighbour } from "./network.ts";

export interface LanHost {
	id: string;
	address: string | null;
	first_seen: string;
	last_seen: string;
	days_seen: number;
	last_day: string;
	label: string | null;
	ignored: number;
}

/** Record the hosts in the neighbour table now. Returns how many are there, and the ids seen for the first time. */
export function recordHosts(db: Db, neighbours: readonly Neighbour[], now: Date): { present: number; fresh: string[] } {
	const at = now.toISOString();
	const day = at.slice(0, 10);
	const fresh: string[] = [];
	let present = 0;
	db.transaction(() => {
		for (const n of neighbours) {
			if (!isLanHost(n)) continue;
			const id = hostId(n.mac);
			const old = db.prepare("SELECT ignored, last_day FROM lan_hosts WHERE id = ?").get(id) as
				| { ignored: number; last_day: string }
				| undefined;
			if (old?.ignored) continue;
			present++;
			if (!old) {
				db.prepare(
					"INSERT INTO lan_hosts (id, address, first_seen, last_seen, last_day) VALUES (?, ?, ?, ?, ?)",
				).run(id, n.ip, at, at, day);
				fresh.push(id);
			} else {
				db.prepare(
					"UPDATE lan_hosts SET address = ?, last_seen = ?, last_day = ?, days_seen = days_seen + ? WHERE id = ?",
				).run(n.ip, at, day, old.last_day === day ? 0 : 1, id);
			}
		}
	})();
	return { present, fresh };
}

/** The hosts the owner has not asked to forget, most recently seen first. */
export function listHosts(db: Db): LanHost[] {
	return db.prepare("SELECT * FROM lan_hosts WHERE ignored = 0 ORDER BY last_seen DESC, id").all() as LanHost[];
}

/** The one host an id or the start of one names; a message when it names none or several. */
export function findHost(db: Db, idStart: string): LanHost | string {
	if (!/^[0-9a-f]{3,12}$/.test(idStart)) return "a host's id is the letters and digits /self hosts shows";
	const rows = db
		.prepare("SELECT * FROM lan_hosts WHERE ignored = 0 AND id LIKE ? ORDER BY id")
		.all(`${idStart}%`) as LanHost[];
	return rows.length === 1 ? rows[0]! : rows.length ? `${idStart} matches ${rows.length} hosts` : `no host ${idStart}`;
}

export function labelHost(db: Db, id: string, label: string): void {
	db.prepare("UPDATE lan_hosts SET label = ? WHERE id = ?").run(label.slice(0, 80), id);
}

/**
 * `/forget <person>`: the owner's names for hosts that name the person go ("Julia's phone"); the host itself
 * stays, unnamed. `names` is a test for a text naming them (`memory/mentions.ts`). Call inside the forget
 * transaction.
 */
export function forgetHostLabels(db: Db, names: (text: string) => boolean): number {
	let n = 0;
	for (const h of db.prepare("SELECT id, label FROM lan_hosts WHERE label IS NOT NULL").all() as {
		id: string;
		label: string;
	}[]) {
		if (!names(h.label)) continue;
		db.prepare("UPDATE lan_hosts SET label = NULL WHERE id = ?").run(h.id);
		n++;
	}
	return n;
}

/** Forget a host: only its id stays, so it is not listed again when it reappears. */
export function forgetHost(db: Db, id: string): void {
	db.prepare("UPDATE lan_hosts SET ignored = 1, address = NULL, label = NULL WHERE id = ?").run(id);
}
