// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import type { TelegramInbound, TelegramMessage } from "../src/channels/types.ts";
import type { AdmissionDeps } from "../src/kernel/admission.ts";
import { openDb } from "../src/state/db.ts";

/** A fresh in-memory database with a deterministic clock and id sequence. */
export function testDeps(overrides: Partial<AdmissionDeps> = {}): AdmissionDeps {
	let tick = 0;
	let seq = 0;
	return {
		db: openDb(":memory:"),
		now: () => new Date(Date.UTC(2026, 9, 2, 12, 0, tick++)),
		newId: () => `id-${++seq}`,
		...overrides,
	};
}

export function tgMessage(updateId: number, msg: Partial<TelegramMessage> = {}): TelegramInbound {
	const fromUserId = msg.fromUserId === undefined ? 1001 : msg.fromUserId;
	return {
		updateId,
		message: {
			messageId: updateId * 10,
			chatId: fromUserId ?? -5,
			chatType: "private",
			fromUserId,
			fromIsBot: false,
			username: "julia_k",
			firstName: "Julia",
			text: "hello",
			dateUnix: 1_790_000_000,
			...msg,
		},
	};
}

export function count(deps: AdmissionDeps, table: string): number {
	return (deps.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
