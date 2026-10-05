// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import type { Channel } from "../channels/types.ts";
import type { Db } from "./db.ts";

export type EventStatus = "admitted" | "answered" | "dropped";

export interface EventRow {
	id: string;
	dedup_key: string;
	channel: Channel;
	external_ref: string | null;
	principal_contact_id: string | null;
	scope: string | null;
	observed_at: string | null;
	received_at: string;
	payload_json: string;
	status: EventStatus;
	drop_reason: string | null;
}

export interface NewEvent {
	id: string;
	dedupKey: string;
	channel: Channel;
	externalRef: string | null;
	principalContactId: string | null;
	scope: string | null;
	observedAt: string | null;
	receivedAt: string;
	payload: unknown;
	status: "admitted" | "dropped";
	dropReason: string | null;
}

/** Insert unless the dedup key already exists. Returns true when a row was written. */
export function insertEventIfNew(db: Db, e: NewEvent): boolean {
	const info = db
		.prepare(
			`INSERT INTO events (id, dedup_key, channel, external_ref, principal_contact_id, scope,
				observed_at, received_at, payload_json, status, drop_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (dedup_key) DO NOTHING`,
		)
		.run(
			e.id,
			e.dedupKey,
			e.channel,
			e.externalRef,
			e.principalContactId,
			e.scope,
			e.observedAt,
			e.receivedAt,
			JSON.stringify(e.payload),
			e.status,
			e.dropReason,
		);
	return info.changes === 1;
}

export function getEventByDedupKey(db: Db, dedupKey: string): EventRow | undefined {
	return db.prepare("SELECT * FROM events WHERE dedup_key = ?").get(dedupKey) as EventRow | undefined;
}

export function getEvent(db: Db, id: string): EventRow | undefined {
	return db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
}

/** The text the sender wrote (web: `text`; Telegram: `message.text`). */
export function messageText(event: EventRow): string {
	const payload = JSON.parse(event.payload_json) as { text?: unknown; message?: { text?: unknown } };
	const text = event.channel === "web" ? payload.text : payload.message?.text;
	return typeof text === "string" ? text : "";
}
