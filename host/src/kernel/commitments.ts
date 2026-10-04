// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The commitment clock (plan 0.006 C1, HLD §7.2, §8.1): due reminders become
 * actions on their exact route. No model is involved: the text was fixed when
 * the reminder was made.
 *
 * - **Asleep: nothing is sent** (owner decision 3, HLD §15 #11). A reminder
 *   that falls due at night waits for the morning and says when it was due.
 * - **Late:** more than 5 minutes late it says "(due at 03:00)"; more than
 *   `lateMs` (6 h, an outage) "(late: due at …)"; more than `maxLateMs`
 *   (7 days) it is failed and reported to the owner instead.
 * - **Repeating:** when an occurrence is sent, the next one is created (the
 *   first time still ahead; occurrences missed during an outage are skipped).
 *   A unique (series, time) makes a retry after a crash a no-op.
 * - The action carries the commitment: the outbox settles both together.
 */

import type { Logger } from "../log.ts";
import type { Route } from "../outbox/outbox.ts";
import { type Commitment, dueCommitments, insertCommitment, quoteReminder } from "../state/commitments.ts";
import type { Db } from "../state/db.ts";
import { describeAt } from "./when.ts";

export interface ClockDeps {
	db: Db;
	outbox: {
		sendOwn(req: { key: string; route: Route; content: string; commitmentId?: string }): Promise<unknown>;
		notifyOwner(req: { key: string; content: string }): Promise<unknown>;
	};
	mode: () => "awake" | "winding_down" | "asleep";
	log: Logger;
	now?: () => Date;
	newId?: () => string;
	tickMs?: number;
	lateMs?: number;
	maxLateMs?: number;
}

export class CommitmentClock {
	private readonly d: Required<ClockDeps>;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;

	constructor(deps: ClockDeps) {
		this.d = {
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			tickMs: 15_000,
			lateMs: 6 * 3_600_000,
			maxLateMs: 7 * 86_400_000,
			...deps,
		};
	}

	start(): void {
		if (this.timer) return;
		void this.tick(); // at startup too: a reminder due during downtime goes out now, saying it is late
		this.timer = setInterval(() => void this.tick(), this.d.tickMs);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.running;
	}

	/** Send what is due. Public for tests. */
	tick(): Promise<void> {
		if (this.running) return this.running;
		this.running = this.pass().finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async pass(): Promise<void> {
		if (this.d.mode() !== "awake") return; // asleep: it waits for the morning
		const now = this.d.now();
		for (const c of dueCommitments(this.d.db, now.toISOString())) {
			const lateMs = now.getTime() - Date.parse(c.due_at);
			if (c.recurrence !== "none") this.scheduleNext(c, now);
			if (lateMs > this.d.maxLateMs) {
				this.d.db
					.prepare(
						"UPDATE commitments SET state = 'failed', settled_at = ?, reason = ? WHERE id = ? AND state = 'scheduled'",
					)
					.run(now.toISOString(), "more than 7 days late (Iyye was not running)", c.id);
				await this.d.outbox.notifyOwner({
					key: `commitment-missed:${c.id}`,
					content: `${quoteReminder(this.d.db, c)}, due ${describeAt(new Date(c.due_at))}, was missed: Iyye was not running for more than 7 days.`,
				});
				continue;
			}
			const due = new Date(c.due_at);
			const note =
				lateMs > this.d.lateMs
					? ` (late: due at ${describeAt(due)})`
					: lateMs > 5 * 60_000
						? ` (due at ${due.toTimeString().slice(0, 5)})`
						: "";
			await this.d.outbox.sendOwn({
				key: `reminder:${c.id}`,
				route: JSON.parse(c.route_json) as Route,
				content: `⏰ ${c.text}${note}`,
				commitmentId: c.id,
			});
			this.d.log.info("commitments: reminder sent", { id: c.id, lateMs });
		}
	}

	/** The next occurrence still ahead; missed ones are skipped. */
	private scheduleNext(c: Commitment, now: Date): void {
		const next = new Date(c.due_at);
		do next.setDate(next.getDate() + (c.recurrence === "daily" ? 1 : 7));
		while (next.getTime() <= now.getTime());
		insertCommitment(this.d.db, {
			id: this.d.newId(),
			scope: c.scope,
			recipient_contact_id: c.recipient_contact_id,
			route_json: c.route_json,
			text: c.text,
			due_at: next.toISOString(),
			timezone: c.timezone,
			recurrence: c.recurrence,
			series_id: c.series_id,
			created_by: c.created_by,
			created_event_id: c.created_event_id,
			created_at: now.toISOString(),
		});
	}
}
