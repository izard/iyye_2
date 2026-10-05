// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "./db.ts";

export function getCursor(db: Db, channel: string): number | undefined {
	const row = db.prepare("SELECT cursor FROM channel_cursors WHERE channel = ?").get(channel) as
		| { cursor: number }
		| undefined;
	return row?.cursor;
}

/** Move the cursor forward to `value`; never backwards. */
export function advanceCursor(db: Db, channel: string, value: number, at: string): void {
	db.prepare(
		`INSERT INTO channel_cursors (channel, cursor, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (channel) DO UPDATE SET
			cursor = MAX(cursor, excluded.cursor),
			updated_at = CASE WHEN excluded.cursor > cursor THEN excluded.updated_at ELSE updated_at END`,
	).run(channel, value, at);
}
