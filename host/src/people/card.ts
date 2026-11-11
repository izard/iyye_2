// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * A person's card (plan 0.018 W5, §3.5): what the records show about someone
 * Iyye talks with, worked out each time it is read. Nothing is stored, so
 * `/forget` needs no path of its own: when the records go, the card goes.
 * What `/forget` keeps (that a message arrived, and when) is not read either:
 * a card starts at the person's last forgetting.
 *
 * - **From records only:** when and how often they write, the scripts they
 *   write in, what is open between them and Iyye, what the fact ledger holds
 *   about them, and what is missing. Never a guess about character or mood,
 *   never a relation taken from tone (HLD §6.4).
 * - **Owner only.** The card is for `/person` and the owner's about-me note.
 * - Hours are the host's local hours: where a person is, Iyye does not know.
 */

import { evidenceOf, getBelief } from "../facts/beliefs.ts";
import { beliefLine } from "../facts/disclosure.ts";
import { localParts } from "../self/normal.ts";
import { accountsOf, type Contact, OWNER_CONTACT_ID } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { emailOf } from "../state/emails.ts";
import { forgottenAt } from "../state/tombstones.ts";

const DAY = 86_400_000;
const OWNER_READER = { principal: "owner" as const, personId: OWNER_CONTACT_ID, ownScopes: ["owner"], trusted: true };
/** The local hour a person's day is counted from: a message at 01:00 belongs to the evening before. */
const DAY_STARTS = 4;
/** Messages, and different days, before anything is said about when a person writes. */
const MIN_MESSAGES = 8;
const MIN_DAYS = 3;

export interface UsualHours {
	/** Local hours, both included: "between 16 and 21". `from` may be later than `to` (across midnight). */
	from: number;
	to: number;
}

export interface PersonCard {
	personId: string;
	/** The owner's own statement of who they are; null when there is none. */
	relation: string | null;
	firstSeen: string | null;
	lastSeen: string | null;
	messages30: number;
	daysActive30: number;
	/** When they usually write; null with too few messages to say. */
	usualHours: UsualHours | null;
	/** "weekdays" or "weekends" when four fifths of their messages fall there; else null. */
	usualDays: "weekdays" | "weekends" | null;
	/** Their messages by the script they are mostly written in, most used first. */
	scripts: { script: string; messages: number }[];
	/** Reminders waiting for them, with the next one's time. */
	reminders: { waiting: number; next: string | null };
	/** Their plans that are still open, by state. */
	plans: Record<string, number>;
	/** The last time Iyye asked them how something went, and how that ended. */
	lastFollowUp: { at: string; outcome: string } | null;
	/** Messages Iyye sent them on its own or for someone, in the last 30 days. */
	sentByIyye30: number;
	/** What the fact ledger holds about them, as the owner reads it; and how many beliefs in all. */
	known: string[];
	knownTotal: number;
	missing: string[];
}

const SCRIPTS: [string, RegExp][] = [
	["Cyrillic", /\p{Script=Cyrillic}/gu],
	["Latin", /\p{Script=Latin}/gu],
	["Greek", /\p{Script=Greek}/gu],
	["Arabic", /\p{Script=Arabic}/gu],
	["Hebrew", /\p{Script=Hebrew}/gu],
	["Han", /\p{Script=Han}/gu],
];

/** The script most of a text's letters are in; null for a text with no letters. */
export function scriptOf(text: string): string | null {
	let best: { script: string; n: number } | null = null;
	for (const [script, re] of SCRIPTS) {
		const n = text.match(re)?.length ?? 0;
		if (n > 0 && (!best || n > best.n)) best = { script, n };
	}
	return best?.script ?? null;
}

/**
 * When someone usually writes: the hours between the tenth and the ninetieth
 * percentile of their messages, the day counted from 04:00. Null with fewer
 * than `MIN_MESSAGES` messages or `MIN_DAYS` days.
 */
export function usualHoursOf(times: readonly Date[], timeZone: string): UsualHours | null {
	const parts = times.map((t) => localParts(t, timeZone));
	if (parts.length < MIN_MESSAGES || new Set(parts.map((p) => p.day)).size < MIN_DAYS) return null;
	const shifted = parts.map((p) => (p.hour - DAY_STARTS + 24) % 24).sort((a, b) => a - b);
	const at = (q: number) => shifted[Math.min(shifted.length - 1, Math.floor(q * shifted.length))]!;
	return { from: (at(0.1) + DAY_STARTS) % 24, to: (at(0.9) + DAY_STARTS) % 24 };
}

/** Whether a local hour falls in a person's usual hours. */
export function inUsualHours(u: UsualHours, hour: number): boolean {
	return u.from <= u.to ? hour >= u.from && hour <= u.to : hour >= u.from || hour <= u.to;
}

/** When the person was last forgotten (any account of theirs); "" when never. Nothing before it is on a card. */
function forgottenSince(db: Db, ids: readonly string[]): string {
	return ids.reduce((latest, id) => {
		const at = forgottenAt(db, `contact:${id}`);
		return at && at > latest ? at : latest;
	}, "");
}

/** The person's own messages since a time (every account of theirs), never from before they were forgotten. */
function messageTimes(db: Db, ids: readonly string[], from: string): { at: string; text: string | null }[] {
	const floor = forgottenSince(db, ids);
	const since = floor > from ? floor : from;
	return db
		.prepare(
			`SELECT received_at AS at, coalesce(json_extract(payload_json, '$.text'), json_extract(payload_json, '$.message.text')) AS text
			 FROM events WHERE principal_contact_id IN (${ids.map(() => "?").join(", ")}) AND received_at >= ? AND status != 'dropped'
			 ORDER BY received_at`,
		)
		.all(...ids, since) as { at: string; text: string | null }[];
}

/** When a person usually writes, from their last 60 days (the card's own figure, without the rest of the card). */
export function usualHoursFor(db: Db, p: Contact, now: Date, timeZone: string): UsualHours | null {
	const ids = [p.id, ...accountsOf(db, p.id).map((a) => a.id)];
	return usualHoursOf(
		messageTimes(db, ids, new Date(now.getTime() - 60 * DAY).toISOString()).map((m) => new Date(m.at)),
		timeZone,
	);
}

export function personCard(db: Db, p: Contact, now: Date, timeZone: string): PersonCard {
	const ids = [p.id, ...accountsOf(db, p.id).map((a) => a.id)];
	const marks = ids.map(() => "?").join(", ");
	const iso = (ms: number) => new Date(now.getTime() - ms).toISOString();
	const recent = messageTimes(db, ids, iso(60 * DAY));
	const last30 = recent.filter((m) => m.at >= iso(30 * DAY));
	const floor = forgottenSince(db, ids);
	const span = db
		.prepare(
			`SELECT min(received_at) AS first, max(received_at) AS last FROM events WHERE principal_contact_id IN (${marks}) AND status != 'dropped' AND received_at > ?`,
		)
		.get(...ids, floor) as { first: string | null; last: string | null };
	const times = recent.map((m) => new Date(m.at));
	const weekend = times.filter((t) => [0, 6].includes(localParts(t, timeZone).weekday)).length;
	const scripts = new Map<string, number>();
	for (const m of recent) {
		const s = m.text ? scriptOf(m.text) : null;
		if (s) scripts.set(s, (scripts.get(s) ?? 0) + 1);
	}
	const reminders = db
		.prepare(
			`SELECT count(*) AS n, min(due_at) AS next FROM commitments WHERE recipient_contact_id IN (${marks}) AND state IN ('scheduled', 'due')`,
		)
		.get(...ids) as { n: number; next: string | null };
	const plans = Object.fromEntries(
		(
			db
				.prepare(
					`SELECT state, count(*) AS n FROM plans WHERE proposer_contact_id IN (${marks}) AND state IN ('proposed', 'authorized', 'active', 'suspended') GROUP BY state`,
				)
				.all(...ids) as { state: string; n: number }[]
		).map((r) => [r.state, r.n]),
	);
	const followUp = db
		.prepare(
			`SELECT o.updated_at AS at, o.status, o.outcome, o.answer FROM opportunities o JOIN events e ON o.cluster = 'event:' || e.id
			 WHERE o.action_kind = 'follow_up' AND e.principal_contact_id IN (${marks}) AND e.received_at > ? ORDER BY o.updated_at DESC LIMIT 1`,
		)
		.get(...ids, floor) as { at: string; status: string; outcome: string | null; answer: string | null } | undefined;
	const sent = (
		db
			.prepare(
				`SELECT count(*) AS n FROM sent_messages WHERE recipient_contact_id IN (${marks}) AND created_at >= ?`,
			)
			.get(...ids, iso(30 * DAY)) as { n: number }
	).n;
	const refs = ids.map((id) => `contact:${id}`);
	const beliefs = db
		.prepare(
			`SELECT id FROM beliefs WHERE state = 'current' AND subject_ref IN (${marks}) AND predicate NOT LIKE 'other:%' ORDER BY p DESC, updated_at DESC`,
		)
		.all(...refs) as { id: string }[];
	const known = beliefs.slice(0, 6).flatMap((r) => {
		const b = getBelief(db, r.id);
		const ev = b ? evidenceOf(db, b.id) : [];
		return b && ev.length ? [beliefLine(db, b, ev, OWNER_READER, now)] : [];
	});
	const relation = (() => {
		const r = db
			.prepare("SELECT value_json FROM self_facts WHERE facet = 'social' AND field = ?")
			.get(`relation:${p.id}`) as { value_json: string } | undefined;
		return r ? (JSON.parse(r.value_json) as string) : null;
	})();
	const ordered = [...scripts].sort((a, b) => b[1] - a[1]).map(([script, messages]) => ({ script, messages }));
	const missing: string[] = [];
	if (!relation) missing.push("who they are to you (/self relation)");
	if (!emailOf(db, p.id)) missing.push("an email address (/person email)");
	// A name is matched as it is written: one known only in another script than the person writes in is not found.
	const nameScript = scriptOf(p.display_name);
	if (ordered[0] && nameScript && ordered[0].script !== nameScript && ordered[0].messages >= MIN_MESSAGES)
		missing.push(`their name in ${ordered[0].script} script (it is known in ${nameScript} only)`);
	return {
		personId: p.id,
		relation,
		firstSeen: span.first,
		lastSeen: span.last,
		messages30: last30.length,
		daysActive30: new Set(last30.map((m) => localParts(new Date(m.at), timeZone).day)).size,
		usualHours: usualHoursOf(times, timeZone),
		usualDays:
			times.length < MIN_MESSAGES
				? null
				: weekend >= 0.8 * times.length
					? "weekends"
					: weekend <= 0.2 * times.length
						? "weekdays"
						: null,
		scripts: ordered,
		reminders: { waiting: reminders.n, next: reminders.next },
		plans,
		lastFollowUp: followUp
			? {
					at: followUp.at,
					outcome:
						followUp.status !== "settled"
							? "waiting for their reply"
							: followUp.answer === "replied" || followUp.outcome === "resolved"
								? "they replied"
								: (followUp.answer ?? followUp.outcome ?? "ended"),
				}
			: null,
		sentByIyye30: sent,
		known,
		knownTotal: beliefs.length,
		missing,
	};
}

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** "between 16:00 and 21:59". */
export function hoursText(u: UsualHours): string {
	return `between ${hh(u.from)} and ${String(u.to).padStart(2, "0")}:59`;
}

/** The card as the owner reads it in `/person`. */
export function cardLines(c: PersonCard, now: Date): string[] {
	const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "?");
	const ago = (iso: string) => {
		const min = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
		return min < 90
			? `${Math.max(min, 0)} min ago`
			: min < 48 * 60
				? `${Math.round(min / 60)} h ago`
				: `${Math.round(min / 1440)} days ago`;
	};
	const lines: string[] = [];
	lines.push(`Who they are to you: ${c.relation ? JSON.stringify(c.relation) : "not said"}`);
	lines.push(
		c.lastSeen
			? `Writes: ${c.messages30} message(s) on ${c.daysActive30} day(s) in the last 30; last ${ago(c.lastSeen)}; first ${day(c.firstSeen)}`
			: "Writes: has not written yet",
	);
	if (c.usualHours)
		lines.push(
			`Usually writes ${hoursText(c.usualHours)} (local time here)${c.usualDays ? `, mostly on ${c.usualDays}` : ""}`,
		);
	if (c.scripts.length)
		lines.push(`Writes in: ${c.scripts.map((s) => `${s.script} script (${s.messages} message(s))`).join(", ")}`);
	const open = [
		c.reminders.waiting
			? `${c.reminders.waiting} reminder(s) waiting${c.reminders.next ? `, the next ${c.reminders.next.slice(0, 16).replace("T", " ")} UTC` : ""}`
			: null,
		...Object.entries(c.plans).map(([state, n]) => `${n} plan(s) ${state}`),
		c.lastFollowUp ? `Iyye last asked how something went ${ago(c.lastFollowUp.at)}: ${c.lastFollowUp.outcome}` : null,
		c.sentByIyye30 ? `${c.sentByIyye30} message(s) from Iyye in the last 30 days` : null,
	].filter(Boolean);
	lines.push(`Between them and Iyye: ${open.length ? open.join("; ") : "nothing open"}`);
	lines.push(
		c.knownTotal
			? `What Iyye holds about them (${c.knownTotal} belief(s)${c.knownTotal > c.known.length ? `, the surest ${c.known.length}` : ""}; /facts shows all):`
			: "What Iyye holds about them: nothing yet",
	);
	lines.push(...c.known.map((k) => `  - ${k}`));
	lines.push(`Missing: ${c.missing.length ? c.missing.join("; ") : "nothing"}`);
	return lines;
}

/** One short line for the owner's about-me note. */
export function cardSummary(name: string, trusted: boolean, c: PersonCard, now: Date): string {
	const hours = (iso: string) => {
		const min = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
		return min < 90
			? `${Math.max(min, 0)} min ago`
			: min < 48 * 60
				? `${Math.round(min / 60)} h ago`
				: `${Math.round(min / 1440)} days ago`;
	};
	const open = [
		c.reminders.waiting ? `${c.reminders.waiting} reminder(s) waiting` : null,
		Object.values(c.plans).reduce((a, n) => a + n, 0)
			? `${Object.values(c.plans).reduce((a, n) => a + n, 0)} open plan(s)`
			: null,
	].filter(Boolean);
	return [
		`${JSON.stringify(name.slice(0, 40))}${c.relation ? ` (${JSON.stringify(c.relation.slice(0, 60))})` : ""}${trusted ? ", trusted" : ""}: ${c.messages30} message(s) in 30 days${c.lastSeen ? `, last ${hours(c.lastSeen)}` : ""}`,
		c.usualHours ? `usually writes ${hoursText(c.usualHours)}` : null,
		...open,
	]
		.filter(Boolean)
		.join("; ");
}
