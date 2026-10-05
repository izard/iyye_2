// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Background jobs (plan 0.007 S1, migration 016): one row is one step. */

import type { Db } from "./db.ts";

export type BackgroundStatus = "queued" | "running" | "paused" | "settled" | "failed" | "suspended";

export interface BackgroundJob {
	id: string;
	origin: string;
	session: string;
	prompt: string;
	status: BackgroundStatus;
	model_name: string | null;
	attempts: number;
	pauses: number;
	result: string | null;
	error: string | null;
	created_at: string;
	started_at: string | null;
	settled_at: string | null;
}

export function insertBackgroundJob(
	db: Db,
	j: { id: string; origin: string; session: string; prompt: string; at: string },
): void {
	db.prepare(
		"INSERT INTO background_jobs (id, origin, session, prompt, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)",
	).run(j.id, j.origin, j.session, j.prompt, j.at);
}

export function getBackgroundJob(db: Db, id: string): BackgroundJob | undefined {
	return db.prepare("SELECT * FROM background_jobs WHERE id = ?").get(id) as BackgroundJob | undefined;
}

/** Steps that may run: paused ones first (they hold a started checkpoint), then queued, oldest first. */
export function runnableBackgroundJobs(db: Db): BackgroundJob[] {
	return db
		.prepare(
			"SELECT * FROM background_jobs WHERE status IN ('paused', 'queued') ORDER BY status = 'queued', created_at, rowid",
		)
		.all() as BackgroundJob[];
}

export function backgroundJobsIn(db: Db, statuses: readonly BackgroundStatus[], limit = 50): BackgroundJob[] {
	return db
		.prepare(
			`SELECT * FROM background_jobs WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY created_at DESC, rowid DESC LIMIT ?`,
		)
		.all(...statuses, limit) as BackgroundJob[];
}

export function markBackgroundRunning(db: Db, id: string, model: string, at: string): void {
	db.prepare(
		"UPDATE background_jobs SET status = 'running', model_name = ?, attempts = attempts + 1, started_at = coalesce(started_at, ?) WHERE id = ?",
	).run(model, at, id);
}

/** Interrupted for a person (counted) or by a shutdown or crash (not counted); resumable either way. */
export function pauseBackgroundJob(db: Db, id: string, counted: boolean): void {
	db.prepare(`UPDATE background_jobs SET status = 'paused'${counted ? ", pauses = pauses + 1" : ""} WHERE id = ?`).run(
		id,
	);
}

export function finishBackgroundJob(
	db: Db,
	id: string,
	status: "settled" | "failed" | "suspended",
	at: string,
	fields: { result?: string | null; error?: string | null } = {},
): void {
	db.prepare("UPDATE background_jobs SET status = ?, result = ?, error = ?, settled_at = ? WHERE id = ?").run(
		status,
		fields.result ?? null,
		fields.error ?? null,
		at,
		id,
	);
}

/** After a crash, a step left `running` is paused: its checkpoint is its Pi session. */
export function recoverBackgroundJobs(db: Db): number {
	return db.prepare("UPDATE background_jobs SET status = 'paused' WHERE status = 'running'").run().changes;
}
