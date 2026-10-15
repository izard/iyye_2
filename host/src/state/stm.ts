// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Short-term memory (plan 0.002 §3.4): today's answered turns, kept in
 * SQLite until the night moves them into long-term memory. STM holds turns,
 * not extracted facts, so writing and searching it costs no model work.
 *
 * Search is lexical (FTS5, bm25). Query words are cut to a stem and matched
 * as prefixes, so an inflected word still finds its other forms («Джулии»
 * finds «Джулия», "lessons" finds "lesson"). The scopes searched always come
 * from the caller's trusted scope, never from the query.
 */

import type { Db } from "./db.ts";
import { type EventRow, messageText } from "./events.ts";
import { isForgotten } from "./tombstones.ts";

/**
 * day: in short-term memory (today, recallable). backlog: the night could not
 * store it; it left STM and waits for a later night (never recalled).
 * completed / completed_empty: stored (or nothing worth keeping).
 * failed: dropped from the backlog after its attempts or its age ran out.
 */
export type StmState = "day" | "backlog" | "completed" | "completed_empty" | "failed";

export interface StmEpisode {
	event_id: string;
	/**
	 * turn: an answered turn; remember: an explicit owner fact (`/remember`), with no reply;
	 * observation: a finding of Iyye's own probes; summary: the day summary (both in scope `iyye`, plan 0.007 S4).
	 */
	kind: StmKind;
	scope: string;
	/** Null for Iyye's own entries (observation, summary). */
	channel: "web" | "telegram" | null;
	contact_id: string | null;
	action_id: string | null;
	user_text: string;
	reply_text: string;
	said_at: string;
	answered_at: string;
	state: StmState;
	attempts: number;
	last_error: string | null;
	transferred_at: string | null;
}

export interface StmHit extends StmEpisode {
	rank: number;
}

/**
 * Record an answered turn. Call inside the transaction that marks the event
 * answered. Owner commands and failure notices never get here: only a
 * delivered reply answers an event.
 */
export function recordEpisode(db: Db, event: EventRow, action: { id: string; content: string | null }, at: string) {
	if (!event.scope || !event.principal_contact_id) return;
	// Mail enters short-term memory only from trusted senders (plan 0.015, owner decision 3): anyone may write.
	if (event.channel === "email") {
		const c = db.prepare("SELECT trusted FROM contacts WHERE id = ?").get(event.principal_contact_id) as
			| { trusted: number }
			| undefined;
		if (c?.trusted !== 1) return;
	}
	// A forgotten scope's earlier words never return, not even through a delivery that completes late.
	if (isForgotten(db, event.scope, event.received_at)) return;
	const userText = messageText(event);
	const reply = action.content ?? "";
	if (!userText.trim()) return;
	const info = db
		.prepare(
			`INSERT OR IGNORE INTO stm_episodes
			 (event_id, scope, channel, contact_id, action_id, user_text, reply_text, said_at, answered_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			event.id,
			event.scope,
			event.channel,
			event.principal_contact_id,
			action.id,
			userText,
			reply,
			event.observed_at ?? event.received_at,
			at,
		);
	if (info.changes > 0) {
		db.prepare("INSERT INTO stm_fts (event_id, scope, body) VALUES (?, ?, ?)").run(
			event.id,
			event.scope,
			`${userText}\n${reply}`,
		);
	}
}

/**
 * An explicit owner fact (`/remember`): an answered owner web event plus an
 * STM entry of kind `remember` with no reply. Recallable today, and the night
 * stores it before anything else.
 */
export function recordRemember(db: Db, args: { id: string; text: string; at: string }): void {
	db.transaction(() => {
		db.prepare(
			`INSERT INTO events (id, dedup_key, channel, external_ref, principal_contact_id, scope,
				observed_at, received_at, payload_json, status, drop_reason)
			 VALUES (?, ?, 'web', NULL, 'owner', 'owner', ?, ?, ?, 'answered', NULL)`,
		).run(args.id, `remember:${args.id}`, args.at, args.at, JSON.stringify({ text: args.text, remember: true }));
		db.prepare(
			`INSERT INTO stm_episodes (event_id, kind, scope, channel, contact_id, action_id, user_text, reply_text, said_at, answered_at)
			 VALUES (?, 'remember', 'owner', 'web', 'owner', NULL, ?, '', ?, ?)`,
		).run(args.id, args.text, args.at, args.at);
		db.prepare("INSERT INTO stm_fts (event_id, scope, body) VALUES (?, 'owner', ?)").run(args.id, args.text);
	})();
}

export type StmKind = "turn" | "remember" | "observation" | "summary";

/** The owner-readable scope of Iyye's own entries; its long-term bank is `iyye-self`. */
export const IYYE_SCOPE = "iyye";

/**
 * Iyye's own STM entry (plan 0.007 S4): a finding or the day summary. Only
 * the owner reads scope `iyye`; it moves to long-term memory at night like
 * every STM entry. Idempotent by id.
 */
export function recordIyyeEntry(
	db: Db,
	e: { id: string; kind: "observation" | "summary"; text: string; at: string },
): boolean {
	return db.transaction(() => {
		const added =
			db
				.prepare(
					`INSERT OR IGNORE INTO stm_episodes (event_id, kind, scope, channel, contact_id, action_id, user_text, reply_text, said_at, answered_at)
					 VALUES (?, ?, ?, NULL, NULL, NULL, ?, '', ?, ?)`,
				)
				.run(e.id, e.kind, IYYE_SCOPE, e.text, e.at, e.at).changes > 0;
		if (added)
			db.prepare("INSERT INTO stm_fts (event_id, scope, body) VALUES (?, ?, ?)").run(e.id, IYYE_SCOPE, e.text);
		return added;
	})();
}

/** The FTS query for free text: stems as prefixes, OR-ed. Null when nothing is searchable. */
export function stmQuery(text: string): string | null {
	const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
	const stems = [...new Set(words.map((w) => w.slice(0, Math.max(3, w.length - 2))))].slice(0, 24);
	return stems.length ? stems.map((s) => `"${s}"*`).join(" OR ") : null;
}

/** Today's episodes (short-term memory only), in the given scopes, best match first. */
export function searchStm(db: Db, scopes: readonly string[], text: string, limit = 5): StmHit[] {
	const q = stmQuery(text);
	if (!q || scopes.length === 0) return [];
	const marks = scopes.map(() => "?").join(", ");
	return db
		.prepare(
			`SELECT e.*, bm25(stm_fts) AS rank FROM stm_fts f
			 JOIN stm_episodes e ON e.event_id = f.event_id
			 WHERE stm_fts MATCH ? AND f.scope IN (${marks}) AND e.scope IN (${marks}) AND e.state = 'day'
			 ORDER BY rank LIMIT ?`,
		)
		.all(q, ...scopes, ...scopes, limit) as StmHit[];
}

/** Episodes awaiting transfer: explicit owner facts first, then the backlog, then today's, oldest first. */
export function pendingEpisodes(db: Db, limit = 1000): StmEpisode[] {
	return db
		.prepare(
			"SELECT * FROM stm_episodes WHERE state IN ('backlog', 'day') ORDER BY kind = 'remember' DESC, state = 'day', said_at, rowid LIMIT ?",
		)
		.all(limit) as StmEpisode[];
}

/** Remove an episode for good (said before a `/forget`): no transfer, no trace in STM. */
export function dropEpisode(db: Db, eventId: string): void {
	db.transaction(() => {
		db.prepare("DELETE FROM stm_fts WHERE event_id = ?").run(eventId);
		db.prepare("DELETE FROM stm_episodes WHERE event_id = ?").run(eventId);
	})();
}

/** A confirmed transfer: the episode leaves STM (its text stays in events/actions for audit). */
export function leaveStm(db: Db, eventId: string, state: "completed" | "completed_empty", at: string): void {
	db.transaction(() => {
		db.prepare("UPDATE stm_episodes SET state = ?, transferred_at = ?, last_error = NULL WHERE event_id = ?").run(
			state,
			at,
			eventId,
		);
		db.prepare("DELETE FROM stm_fts WHERE event_id = ?").run(eventId);
	})();
}

/**
 * A failed attempt. Today's episode stays in STM for the rest of the night;
 * a backlog episode is dropped (`failed`) once its attempts run out.
 */
export function transferFailed(db: Db, eventId: string, error: string, maxAttempts: number): StmState {
	return db.transaction(() => {
		db.prepare("UPDATE stm_episodes SET attempts = attempts + 1, last_error = ? WHERE event_id = ?").run(
			error.slice(0, 500),
			eventId,
		);
		const row = db.prepare("SELECT attempts, state FROM stm_episodes WHERE event_id = ?").get(eventId) as
			| { attempts: number; state: StmState }
			| undefined;
		if (row && row.attempts >= maxAttempts) {
			db.prepare("UPDATE stm_episodes SET state = 'failed' WHERE event_id = ?").run(eventId);
			db.prepare("DELETE FROM stm_fts WHERE event_id = ?").run(eventId);
			return "failed";
		}
		return row?.state ?? "day";
	})();
}

/**
 * End of a completed night (owner, 2026-10-03: STM is today only). Today's
 * unstored episodes leave STM for the backlog (no longer recallable), and
 * backlog episodes older than `maxAgeDays` are dropped. Returns the counts.
 */
export function endDay(db: Db, now: Date, maxAgeDays: number): { toBacklog: number; dropped: number } {
	return db.transaction(() => {
		const cutoff = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();
		const dropped = db
			.prepare(
				"UPDATE stm_episodes SET state = 'failed', last_error = coalesce(last_error, 'too old') WHERE state = 'backlog' AND said_at < ?",
			)
			.run(cutoff).changes;
		const toBacklog = db.prepare("UPDATE stm_episodes SET state = 'backlog' WHERE state = 'day'").run().changes;
		db.prepare(
			"DELETE FROM stm_fts WHERE event_id IN (SELECT event_id FROM stm_episodes WHERE state != 'day')",
		).run();
		return { toBacklog, dropped };
	})();
}

/** Counts by scope of today's episodes (short-term memory). */
export function stmCounts(db: Db): { scope: string; n: number; oldest: string }[] {
	return db
		.prepare(
			"SELECT scope, count(*) AS n, min(said_at) AS oldest FROM stm_episodes WHERE state = 'day' GROUP BY scope ORDER BY scope",
		)
		.all() as { scope: string; n: number; oldest: string }[];
}

/**
 * Debugging only (scripts/memory-clear.ts --restage): queue every stored or
 * dropped episode in the transfer backlog again, so the next night transfers
 * it again. Returns how many.
 */
export function restageEpisodes(db: Db, scopes?: readonly string[]): number {
	return db.transaction(() => {
		const rows = (
			db.prepare("SELECT event_id, scope FROM stm_episodes WHERE state NOT IN ('day', 'backlog')").all() as {
				event_id: string;
				scope: string;
			}[]
		).filter((r) => !scopes || scopes.includes(r.scope));
		// Old conversations are not today's: they go to the transfer backlog, not into short-term memory.
		const reset = db.prepare(
			"UPDATE stm_episodes SET state = 'backlog', attempts = 0, last_error = NULL, transferred_at = NULL WHERE event_id = ?",
		);
		for (const r of rows) {
			db.prepare("DELETE FROM stm_fts WHERE event_id = ?").run(r.event_id);
			reset.run(r.event_id);
		}
		return rows.length;
	})();
}
