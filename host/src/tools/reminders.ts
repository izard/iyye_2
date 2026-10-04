// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The `reminders` toolkit (plan 0.006 C1), effect `self`: the owner and every
 * contact may set reminders, and a reminder can only ever reach the chat that
 * asked for it (owner decision 1). Iyye's background work never gets it.
 *
 * - The route and the person come from the turn (the scheduler, from the
 *   triggering event), never from the model.
 * - The time is resolved by the host (`kernel/when.ts`, the C0 decision); a
 *   refusal tells the model to ask, never to choose another time.
 * - The result states the exact day and time and whether it repeats, so the
 *   reply can quote the record.
 * - A contact has at most `contactMax` open reminders and sees and cancels
 *   only their own.
 */

import { Type } from "typebox";
import { type RestWindow, windowStartFor } from "../kernel/rhythm.ts";
import { describeAt, parseWhen } from "../kernel/when.ts";
import {
	cancelSeries,
	findCommitments,
	insertCommitment,
	openCommitments,
	type Recurrence,
} from "../state/commitments.ts";
import type { Db } from "../state/db.ts";
import type { IyyeTool, ToolContext, Toolkit } from "./broker.ts";

export interface ReminderDeps {
	db: Db;
	now?: () => Date;
	newId?: () => string;
	/** Open reminders a contact may have. */
	contactMax?: number;
	/** The rest window: a reminder due inside it arrives when Iyye wakes. */
	restWindow?: RestWindow | null;
	timezone?: string;
}

export function remindersToolkit(deps: ReminderDeps): Toolkit {
	const d = {
		now: () => new Date(),
		newId: () => crypto.randomUUID(),
		contactMax: 20,
		restWindow: null as RestWindow | null,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		...deps,
	};
	const noTurn = "Reminders can only be set in a conversation with a person.";

	const create: IyyeTool = {
		name: "reminder_create",
		label: "Set a reminder",
		description:
			"Set a reminder: at the given time Iyye sends the text to this chat. Use it only when the person asks to be reminded; if the time or what to remind about is missing, ask them first instead of choosing. Returns the exact day and time, and whether it repeats; tell the person exactly that.",
		summary: "set a reminder that Iyye sends to this chat at a given time",
		parameters: Type.Object({
			text: Type.String({
				minLength: 1,
				maxLength: 300,
				description: "What to remind about, in the person's words",
			}),
			when: Type.String({
				minLength: 1,
				maxLength: 60,
				description:
					'When, in one of these forms: "in 20 minutes", "in 2 hours", "tomorrow 09:00", "monday 18:30", "18:30", "noon", "12 October 12:00" or "2026-10-12 12:00". Iyye resolves it in the owner\'s timezone.',
			}),
			recurrence: Type.Optional(
				Type.Union([Type.Literal("none"), Type.Literal("daily"), Type.Literal("weekly")], {
					description: '"daily" for "every day", "weekly" for "every Monday" and the like; otherwise leave it out',
				}),
			),
		}),
		run: async (p: { text: string; when: string; recurrence?: Recurrence }, ctx: ToolContext) => {
			if (!ctx.turn) return noTurn;
			const now = d.now();
			if (ctx.principal !== "owner" && openCommitments(d.db, ctx.scope).length >= d.contactMax) {
				return `Not set: this chat already has ${d.contactMax} open reminders. Ask the person to cancel one first.`;
			}
			const when = parseWhen(p.when, now);
			if (!when.ok)
				return `Not set: ${when.error}. Ask the person what they meant; do not choose another time yourself.`;
			const id = d.newId();
			const recurrence = p.recurrence ?? "none";
			insertCommitment(d.db, {
				id,
				scope: ctx.scope,
				recipient_contact_id: ctx.turn.contactId,
				route_json: JSON.stringify(ctx.turn.route),
				text: p.text.trim(),
				due_at: when.at.toISOString(),
				timezone: d.timezone,
				recurrence,
				series_id: id,
				created_by: `tool:${ctx.principal}`,
				created_event_id: ctx.turn.eventId,
				created_at: now.toISOString(),
			});
			const repeat =
				recurrence === "daily"
					? ", then every day"
					: recurrence === "weekly"
						? ", then every week"
						: ", once (it does not repeat)";
			const night =
				d.restWindow && windowStartFor(when.at, d.restWindow)
					? " Iyye rests at that time, so it will arrive when Iyye wakes up."
					: "";
			return `Reminder ${id.slice(0, 8)} set for ${describeAt(when.at)}${repeat} (${d.timezone}): ${p.text.trim()}${when.defaulted ? " (no time was given, so 09:00)" : ""}.${night}`;
		},
	};

	const list: IyyeTool = {
		name: "reminder_list",
		label: "List reminders",
		description: "The reminders this chat has that are still to come.",
		summary: "this chat's coming reminders",
		parameters: Type.Object({}),
		run: async (_p: object, ctx: ToolContext) => {
			if (!ctx.turn) return noTurn;
			const open = openCommitments(d.db, ctx.scope);
			if (open.length === 0) return "No reminders are set.";
			return open
				.map(
					(c) =>
						`${c.id.slice(0, 8)}: ${describeAt(new Date(c.due_at))}${c.recurrence === "none" ? "" : `, every ${c.recurrence === "daily" ? "day" : "week"}`} — ${c.text}${c.state === "scheduled" ? "" : ` (${c.state})`}`,
				)
				.join("\n");
		},
	};

	const cancel: IyyeTool = {
		name: "reminder_cancel",
		label: "Cancel a reminder",
		description:
			"Cancel one of this chat's reminders by its id (from reminder_list); a repeating one stops repeating.",
		summary: "cancel one of this chat's reminders",
		parameters: Type.Object({ id: Type.String({ pattern: "^[0-9a-f-]{6,36}$" }) }),
		run: async (p: { id: string }, ctx: ToolContext) => {
			if (!ctx.turn) return noTurn;
			// Only this chat's own reminders: another person's id is simply not found.
			const found = findCommitments(d.db, p.id, ctx.scope).filter((c) => c.state === "scheduled");
			if (found.length !== 1)
				return found.length
					? "That id matches more than one reminder; give more of it."
					: `No coming reminder ${p.id} here.`;
			const n = cancelSeries(d.db, found[0]!, d.now().toISOString(), ctx.principal);
			return `Cancelled: ${found[0]!.text}${n > 1 ? ` (${n} occurrences)` : ""}.`;
		},
	};

	return {
		name: "reminders",
		description: "reminders Iyye sends to this chat",
		effect: "self",
		tools: [create, list, cancel] as IyyeTool[],
	};
}
