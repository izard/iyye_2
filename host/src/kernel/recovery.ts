// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Startup reconciliation, before any new work is admitted (HLD §13): a crash
 * may have left a job running or an action half-sent.
 *
 * - An action in `sending`: an adapter that can check exactly (web) settles
 *   it as delivered or puts it back in the queue; otherwise it becomes
 *   `unknown` for the owner to resolve. Never a blind resend.
 * - An action in `queued` (crash before sending) is sent now.
 * - A job left `running` with no action had produced nothing visible: it goes
 *   back to the queue once, and fails (with a notice) on the second
 *   interrupted attempt.
 */

import type { Logger } from "../log.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { Db } from "../state/db.ts";
import { getEvent } from "../state/events.ts";
import { actionCountForJob, jobsInState, requeueJob } from "../state/jobs.ts";
import type { Scheduler } from "./scheduler.ts";

export interface RecoveryReport {
	reconciled: number;
	resent: number;
	unknown: number;
	requeuedJobs: number;
	failedJobs: number;
}

export async function recover(
	db: Db,
	outbox: Outbox,
	scheduler: Pick<Scheduler, "fail">,
	log: Logger,
): Promise<RecoveryReport> {
	const report: RecoveryReport = { reconciled: 0, resent: 0, unknown: 0, requeuedJobs: 0, failedJobs: 0 };
	for (const a of outbox.actionsInState("sending")) {
		const after = outbox.reconcile(a.id);
		if (after.state === "unknown") report.unknown++;
		else report.reconciled++;
	}
	for (const a of outbox.actionsInState("queued")) {
		// Iyye's own messages wait while asleep (a restart mid-night boots asleep); dispatchDue sends them after waking.
		if (a.kind === "status" && outbox.isHeld()) continue;
		await outbox.send(a.id);
		report.resent++;
	}
	for (const job of jobsInState(db, "running")) {
		if (actionCountForJob(db, job.id) > 0) continue;
		const event = getEvent(db, job.trigger_event_id);
		if (job.attempt >= 2 && event) {
			await scheduler.fail(job, event, "interrupted twice by a restart");
			report.failedJobs++;
		} else {
			requeueJob(db, job.id);
			report.requeuedJobs++;
		}
	}
	if (Object.values(report).some((n) => n > 0)) log.info("recovery", { ...report });
	return report;
}
