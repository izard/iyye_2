// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The owner's reminder commands (plan 0.006 C1), deterministic, no model:
 * `/remind <when> <text>`, `/reminders`, `/commitments`, `/cancel <id>`.
 * A reminder set by command goes to the owner's web chat.
 */

import { type Route, routeLabel } from "../outbox/outbox.ts";
import {
	cancelSeries,
	findCommitments,
	insertCommitment,
	openCommitments,
	recentCommitments,
} from "../state/commitments.ts";
import { getContact, OWNER_CONTACT_ID } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { describeAt, parseWhen } from "./when.ts";

export interface ReminderCommandDeps {
	db: Db;
	now?: () => Date;
	newId?: () => string;
	timezone?: string;
}

export class ReminderCommands {
	private readonly d: Required<ReminderCommandDeps>;

	constructor(deps: ReminderCommandDeps) {
		this.d = {
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			...deps,
		};
	}

	/** `/remind <when> <text>`: the longest leading words that read as a time are the time; the rest is the text. */
	remind(input: string, by: string): string {
		const words = input.trim().split(/\s+/).filter(Boolean);
		const now = this.d.now();
		for (let k = words.length - 1; k >= 1; k--) {
			const when = parseWhen(words.slice(0, k).join(" "), now);
			if (!when.ok) continue;
			const text = words.slice(k).join(" ");
			const id = this.d.newId();
			insertCommitment(this.d.db, {
				id,
				scope: "owner",
				recipient_contact_id: OWNER_CONTACT_ID,
				route_json: JSON.stringify({ channel: "web", contact: "owner" }),
				text,
				due_at: when.at.toISOString(),
				timezone: this.d.timezone,
				recurrence: "none",
				series_id: id,
				created_by: by,
				created_event_id: null,
				created_at: now.toISOString(),
			});
			return `Reminder ${id.slice(0, 8)} set for ${describeAt(when.at)} (${this.d.timezone}), to this chat: ${text}${when.defaulted ? " (no time was given, so 09:00)" : ""}`;
		}
		return 'usage: /remind <when> <text>, e.g. "/remind tomorrow 9:00 call Julia" or "/remind in 2 hours check the oven"';
	}

	/** `/reminders`: the owner's own coming reminders. */
	reminders(): string {
		const open = openCommitments(this.d.db, "owner");
		if (open.length === 0) return "you have no reminders set";
		return ["your reminders:", ...open.map((c) => `  ${line(c)}`)].join("\n");
	}

	/** `/commitments`: every reminder, everyone's, latest first, with its state. */
	all(): string {
		const rows = recentCommitments(this.d.db, 20);
		if (rows.length === 0) return "no commitments yet";
		return [
			"commitments (latest 20; fulfilled = delivery confirmed by its own receipt):",
			...rows.map(
				(c) =>
					`  ${line(c)} · for ${who(this.d.db, c.recipient_contact_id)} on ${route(c.route_json)} · ${c.state}${c.reason ? ` (${c.reason})` : ""}${evidence(this.d.db, c.action_id)}`,
			),
		].join("\n");
	}

	/** `/cancel <id>`: any reminder, the owner's or a contact's. */
	cancel(ref: string, by: string): string {
		if (!/^[0-9a-f-]{6,36}$/i.test(ref)) return "usage: /cancel <id, at least 6 characters> (see /commitments)";
		const found = findCommitments(this.d.db, ref.toLowerCase(), null).filter((c) => c.state === "scheduled");
		if (found.length === 0) return `no coming reminder ${ref}`;
		if (found.length > 1) return `${ref} matches ${found.length} reminders; give more of the id`;
		const n = cancelSeries(this.d.db, found[0]!, this.d.now().toISOString(), by);
		return `cancelled: ${found[0]!.text}${n > 1 ? ` (${n} occurrences)` : ""}`;
	}
}

function line(c: { id: string; due_at: string; recurrence: string; text: string }): string {
	return `${c.id.slice(0, 8)} ${describeAt(new Date(c.due_at))}${c.recurrence === "none" ? "" : `, every ${c.recurrence === "daily" ? "day" : "week"}`} — ${c.text}`;
}

/** The action and its receipts: what the state rests on (plan 0.006 C3). */
function evidence(db: Db, actionId: string | null): string {
	if (!actionId) return "";
	const a = db.prepare("SELECT state, attempts FROM actions WHERE id = ?").get(actionId) as
		| { state: string; attempts: number }
		| undefined;
	if (!a) return "";
	const r = db
		.prepare(
			"SELECT group_concat(DISTINCT level) AS levels, max(acknowledged_at) AS at FROM receipts WHERE action_id = ? AND outcome = 'delivered'",
		)
		.get(actionId) as { levels: string | null; at: string | null };
	const receipt = r.levels
		? `, receipt ${r.levels}${r.at ? ` at ${new Date(r.at).toTimeString().slice(0, 5)}` : ""}`
		: "";
	return ` · action ${actionId.slice(0, 8)} ${a.state}${a.attempts > 1 ? ` after ${a.attempts} attempts` : ""}${receipt}`;
}

function who(db: Db, contactId: string): string {
	return contactId === OWNER_CONTACT_ID ? "you" : (getContact(db, contactId)?.display_name ?? contactId);
}

function route(json: string): string {
	return routeLabel(JSON.parse(json) as Route);
}
