// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import type { Channel } from "../channels/types.ts";
import type { Db } from "./db.ts";

/** The chat channels: each has a selected model that is loaded at startup. */
/** Channels with their own selected chat model; email (plan 0.015) answers with the Telegram one. */
export const MODEL_CHANNELS: readonly Exclude<Channel, "email">[] = ["web", "telegram"];

/**
 * What a model can be selected for: a chat channel, long-term memory work (0.002 L2), background work (0.007),
 * or the voice (0.009 CH3, shadow). The voice is not a day key: the host never loads, heals or reloads it.
 */
export type SelectionKey = Channel | "memory" | "background" | "voice";
export const SELECTION_KEYS: readonly SelectionKey[] = ["web", "telegram", "memory", "background", "voice"];

/** The selections loaded by day and unloaded at night: the chat channels and background work. */
export const DAY_KEYS: readonly SelectionKey[] = ["web", "telegram", "background"];

/** The model currently selected for a channel or for memory, if any. */
export function getSelectedModel(db: Db, channel: SelectionKey): string | null {
	const row = db.prepare("SELECT model_name FROM model_selection WHERE channel = ?").get(channel) as
		| { model_name: string }
		| undefined;
	return row?.model_name ?? null;
}

export function setSelectedModel(db: Db, channel: SelectionKey, modelName: string, setBy: string, at: string): void {
	db.prepare(
		`INSERT INTO model_selection (channel, model_name, set_by, set_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (channel) DO UPDATE SET model_name = excluded.model_name, set_by = excluded.set_by, set_at = excluded.set_at`,
	).run(channel, modelName, setBy, at);
}

/** Give a channel its configured default only if the owner has not chosen one. */
export function seedSelectedModel(db: Db, channel: SelectionKey, modelName: string, at: string): void {
	db.prepare(
		`INSERT INTO model_selection (channel, model_name, set_by, set_at) VALUES (?, ?, 'config', ?)
		 ON CONFLICT (channel) DO NOTHING`,
	).run(channel, modelName, at);
}

export type ModelOpKind = "load" | "unload" | "router_start" | "router_stop";
export type ModelOpState = "running" | "done" | "failed" | "refused";

export interface ModelOpRow {
	id: string;
	op: ModelOpKind;
	model_name: string | null;
	requested_by: string;
	state: ModelOpState;
	error: string | null;
	started_at: string;
	finished_at: string | null;
}

export function startModelOp(
	db: Db,
	op: { id: string; op: ModelOpKind; modelName: string | null; requestedBy: string; at: string },
): void {
	db.prepare(
		`INSERT INTO model_ops (id, op, model_name, requested_by, state, started_at)
		 VALUES (?, ?, ?, ?, 'running', ?)`,
	).run(op.id, op.op, op.modelName, op.requestedBy, op.at);
}

export function finishModelOp(
	db: Db,
	id: string,
	state: Exclude<ModelOpState, "running">,
	error: string | null,
	at: string,
): void {
	db.prepare("UPDATE model_ops SET state = ?, error = ?, finished_at = ? WHERE id = ?").run(state, error, at, id);
}

/** Operations still `running` belong to a host run that ended mid-operation. */
export function abandonRunningModelOps(db: Db, at: string): number {
	return db
		.prepare(
			"UPDATE model_ops SET state = 'failed', error = 'host stopped during operation', finished_at = ? WHERE state = 'running'",
		)
		.run(at).changes;
}

export function recentModelOps(db: Db, limit = 10): ModelOpRow[] {
	return db.prepare("SELECT * FROM model_ops ORDER BY started_at DESC, rowid DESC LIMIT ?").all(limit) as ModelOpRow[];
}
