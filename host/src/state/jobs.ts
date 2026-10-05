// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "./db.ts";

export type JobStatus = "queued" | "running" | "settled" | "failed";

export interface JobRow {
	id: string;
	trigger_event_id: string;
	scope: string;
	model_name: string | null;
	status: JobStatus;
	lease_until: string | null;
	attempt: number;
	created_at: string;
	settled_at: string | null;
}

export function insertQueuedJob(
	db: Db,
	j: { id: string; triggerEventId: string; scope: string; modelName: string | null; at: string },
): void {
	db.prepare(
		`INSERT INTO jobs (id, trigger_event_id, scope, model_name, status, created_at)
		 VALUES (?, ?, ?, ?, 'queued', ?)`,
	).run(j.id, j.triggerEventId, j.scope, j.modelName, j.at);
}

export function getJobForEvent(db: Db, eventId: string): JobRow | undefined {
	return db.prepare("SELECT * FROM jobs WHERE trigger_event_id = ?").get(eventId) as JobRow | undefined;
}

export function getJob(db: Db, id: string): JobRow | undefined {
	return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

/** Queued jobs in the order the scheduler should consider them: the owner first, then oldest first. */
export function queuedJobs(db: Db): JobRow[] {
	return db
		.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY (scope = 'owner') DESC, created_at, rowid")
		.all() as JobRow[];
}

export function markJobRunning(db: Db, id: string, modelName: string, leaseUntil: string): void {
	db.prepare(
		"UPDATE jobs SET status = 'running', model_name = ?, lease_until = ?, attempt = attempt + 1 WHERE id = ?",
	).run(modelName, leaseUntil, id);
}

export function requeueJob(db: Db, id: string): void {
	db.prepare("UPDATE jobs SET status = 'queued', lease_until = NULL WHERE id = ?").run(id);
}

export function failJob(db: Db, id: string, at: string): void {
	db.prepare("UPDATE jobs SET status = 'failed', settled_at = ?, lease_until = NULL WHERE id = ?").run(at, id);
}

export function jobsInState(db: Db, status: JobStatus): JobRow[] {
	return db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at").all(status) as JobRow[];
}

export function actionCountForJob(db: Db, jobId: string): number {
	return (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE job_id = ?").get(jobId) as { n: number }).n;
}

/** Extend a running job's lease; a no-op once the job has left `running`. */
export function renewLease(db: Db, id: string, leaseUntil: string): void {
	db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ? AND status = 'running'").run(leaseUntil, id);
}
