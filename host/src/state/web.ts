// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "./db.ts";

export type FeedKind = "user" | "reply" | "notice" | "command" | "command_result";

export interface FeedRow {
	seq: number;
	kind: FeedKind;
	client_msg_id: string | null;
	event_id: string | null;
	action_id: string | null;
	text: string;
	created_at: string;
}

/** Append to the owner's web transcript. Returns the new seq, or null if the unique key already exists. */
export function appendFeed(
	db: Db,
	row: { kind: FeedKind; text: string; at: string; clientMsgId?: string; eventId?: string; actionId?: string },
): number | null {
	const info = db
		.prepare(
			`INSERT INTO web_feed (kind, client_msg_id, event_id, action_id, text, created_at)
			 VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
		)
		.run(row.kind, row.clientMsgId ?? null, row.eventId ?? null, row.actionId ?? null, row.text, row.at);
	return info.changes === 1 ? Number(info.lastInsertRowid) : null;
}

export function feedByClientMsgId(db: Db, clientMsgId: string): FeedRow | undefined {
	return db.prepare("SELECT * FROM web_feed WHERE client_msg_id = ?").get(clientMsgId) as FeedRow | undefined;
}

export function feedByActionId(db: Db, actionId: string): FeedRow | undefined {
	return db.prepare("SELECT * FROM web_feed WHERE action_id = ?").get(actionId) as FeedRow | undefined;
}

export interface FeedView extends FeedRow {
	action_state: string | null;
	receipt_level: string | null;
	event_status: string | null;
}

/** Feed rows after `after`, with the delivery state of replies and the status of user messages. */
export function feedSince(db: Db, after: number, limit = 200): FeedView[] {
	return db
		.prepare(
			`SELECT f.*, a.state AS action_state,
				(SELECT r.level FROM receipts r WHERE r.action_id = f.action_id ORDER BY r.chunk_index LIMIT 1) AS receipt_level,
				e.status AS event_status
			 FROM web_feed f
			 LEFT JOIN actions a ON a.id = f.action_id
			 LEFT JOIN events e ON e.id = f.event_id
			 WHERE f.seq > ? ORDER BY f.seq LIMIT ?`,
		)
		.all(after, limit) as FeedView[];
}

export function createWebSession(db: Db, idHash: string, csrf: string, at: Date, ttlMs: number): void {
	db.prepare("INSERT INTO web_sessions (id_hash, csrf, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
		idHash,
		csrf,
		at.toISOString(),
		new Date(at.getTime() + ttlMs).toISOString(),
	);
}

export function findWebSession(db: Db, idHash: string, at: Date): { csrf: string } | undefined {
	return db
		.prepare("SELECT csrf FROM web_sessions WHERE id_hash = ? AND expires_at > ?")
		.get(idHash, at.toISOString()) as { csrf: string } | undefined;
}

export function deleteWebSession(db: Db, idHash: string): void {
	db.prepare("DELETE FROM web_sessions WHERE id_hash = ?").run(idHash);
}

export function pruneWebSessions(db: Db, at: Date): void {
	db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(at.toISOString());
}
