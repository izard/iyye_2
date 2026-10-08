// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The M2 detectors (plan 0.010 §3): deterministic rules over records, in
 * charge while the Kev questions that will one day replace them run in
 * shadow (reply review, schema 3). HLD §9.4: every role has a deterministic
 * fallback.
 *
 * - **A recurring question** (curiosity): the owner asked about the same
 *   topic on two different days, and Iyye said it did not know at least once.
 *   The evidence is the owner's two messages; Iyye's admission is only a
 *   filter (self-authored text is never evidence of need). Contacts'
 *   questions are not used: an untrusted account must not steer Iyye's web
 *   activity, and their words would end up in Iyye's own findings.
 * - **An intention with no plan** (agency, the owner only): "I want to …",
 *   "I need to …", «хочу», «надо», «собираюсь». Since M3 an intention leads
 *   to a proposed plan, so suggestions to Iyye ("let's …", "we should …")
 *   and requests the turn itself handled (a tool call, a reminder, a plan)
 *   are not intentions.
 * - **A dated event** (social): a message naming an event on a clear date
 *   ("today", "tomorrow", "on Monday", "12 October", «завтра»), now past.
 *   Since M3 a follow-up message comes of it, so a date in the past or a
 *   recurring one ("last Monday", "every Monday") is not an event, and an
 *   event with no time of day is over only in the evening.
 */

import { contentStems } from "../facts/disclosure.ts";
import { parseWhen } from "../kernel/when.ts";
import type { Db } from "../state/db.ts";

/** Iyye's reply admits it did not know or could not find the answer (English and Russian). */
export function admitsUnknown(reply: string): boolean {
	return /\b(i (don'?t|do not) know|i('m| am) not sure|i (couldn'?t|could not|can'?t|cannot|wasn'?t able to|was not able to) (find|tell|confirm|verify|check|look up|answer)|i (don'?t|do not) have (that|this|any|enough) (information|data|details)|no information (about|on)|i have no (information|record|data))\b|не знаю|не уверен|не (смог|смогла|удалось) (найти|узнать|проверить)|не нашёл|не нашел|не нашла|нет (информации|данных)/i.test(
		reply,
	);
}

/** An owner's message that states an intention to do something (not a question). */
export function statesIntention(text: string): string | null {
	for (const sentence of text.split(/(?<=[.!;\n])\s+/)) {
		const t = sentence.trim();
		if (!t || t.endsWith("?")) continue;
		if (
			/\b(i (want|need|have|plan|intend|hope) to|i'?d like to|i would like to|i'?m going to|i am going to|i'?ll (try|have) to|we need to|we want to)\b|(?<![\p{L}])(хочу|надо|нужно|собираюсь|планирую)(?![\p{L}])/iu.test(
				t,
			) &&
			// Asking Iyye to look something up is a request, not an intention ("I want to know …").
			!/\b(want|need|like|have|going) to (know|see|check|ask|understand|find out|look|test|try)\b|(хочу|надо|нужно) (знать|узнать|посмотреть|проверить|спросить|понять)/iu.test(
				t,
			)
		)
			return t.slice(0, 200);
	}
	return null;
}

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const RU_WEEKDAYS: Record<string, string> = {
	понедельник: "monday",
	вторник: "tuesday",
	среду: "wednesday",
	четверг: "thursday",
	пятницу: "friday",
	субботу: "saturday",
	воскресенье: "sunday",
};

/** The hour an event with no time of day is taken to be over ("how did the exam go?" not before the evening). */
export const EVENING_HOUR = 18;

/**
 * The first clear date phrase in a message, resolved against when it was said, as the time the event is
 * over; null when none.
 */
export function eventDate(text: string, saidAt: Date): { phrase: string; at: Date } | null {
	const t = text.toLowerCase();
	if (t.trim().endsWith("?") || /\bremind|напомни/.test(t)) return null; // a question; a reminder request is a commitment
	// Past or recurring: "last Monday", "every Friday", "two days ago", «в прошлую пятницу», «каждый день».
	if (
		/\b(last|every|each|ago|yesterday|previous|past|used to)\b|(?<![\p{L}])(прошл\p{L}*|кажд\p{L}*|вчера|назад)(?![\p{L}])/iu.test(
			t,
		)
	)
		return null;
	if (/\btoday\b|\btonight\b|\bthis evening\b|(?<![\p{L}])сегодня(?![\p{L}])/u.test(t)) {
		const evening = new Date(saidAt);
		evening.setHours(EVENING_HOUR, 0, 0, 0);
		return { phrase: "today", at: new Date(Math.max(evening.getTime(), saidAt.getTime() + 3_600_000)) };
	}
	const candidates: string[] = [];
	const push = (re: RegExp, map: (m: RegExpExecArray) => string) => {
		const m = re.exec(t);
		if (m) candidates.push(map(m));
	};
	// With its time when one follows ("tomorrow at 10:00"): the event is over then, not in the evening.
	push(/\btomorrow\b(?:,? (?:at )?(\d{1,2}(?::\d{2})?(?: ?[ap]m)?|noon)\b)?|завтра/, (m) =>
		m[1] ? `tomorrow ${m[1]}` : "tomorrow",
	);
	push(new RegExp(`\\b(next )?(${WEEKDAYS})\\b`), (m) => `${m[1] ?? ""}${m[2]}`);
	push(/в (понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)/, (m) => RU_WEEKDAYS[m[1]!]!);
	push(new RegExp(`\\b(\\d{1,2}) (${MONTHS})\\b`), (m) => `${m[1]} ${m[2]}`);
	push(new RegExp(`\\b(${MONTHS}) (\\d{1,2})\\b`), (m) => `${m[2]} ${m[1]}`);
	push(/\bin (\d{1,2}) (day|days|week|weeks)\b/, (m) => `in ${m[1]} ${m[2]}`);
	push(/\b(\d{4}-\d{2}-\d{2})\b/, (m) => m[1]!);
	for (const phrase of candidates) {
		const w = parseWhen(phrase, saidAt);
		if (!w.ok) continue;
		if (w.defaulted) w.at.setHours(EVENING_HOUR, 0, 0, 0); // a whole day, not 09:00: over in the evening
		return { phrase, at: w.at };
	}
	return null;
}

interface OwnerTurn {
	event_id: string;
	user_text: string;
	reply_text: string;
	said_at: string;
}

/**
 * The owner's recurring unanswered questions: an owner turn Iyye could not
 * answer, and another owner message on another day sharing at least two of
 * its content words (half of them for short questions). One per topic, and
 * none once an opportunity exists for it (the investigation then carries it).
 */
export function recurringQuestions(
	db: Db,
	now: Date,
	days = 14,
): { cluster: string; evidence: string[]; topic: string; at: string }[] {
	const since = new Date(now.getTime() - days * 86_400_000).toISOString();
	const turns = db
		.prepare(
			"SELECT event_id, user_text, reply_text, said_at FROM stm_episodes WHERE scope = 'owner' AND kind = 'turn' AND said_at >= ? ORDER BY said_at",
		)
		.all(since) as OwnerTurn[];
	const out: { cluster: string; evidence: string[]; topic: string; at: string }[] = [];
	const taken = new Set<string>();
	for (const a of turns) {
		if (taken.has(a.event_id) || !admitsUnknown(a.reply_text)) continue;
		const cluster = `question:${a.event_id}`;
		if (db.prepare("SELECT 1 FROM opportunities WHERE cluster = ?").get(cluster)) continue;
		const stems = contentStems(a.user_text);
		if (stems.length < 2) continue;
		const need = Math.max(2, Math.ceil(stems.length / 2));
		const b = turns.find((x) => {
			if (x.event_id === a.event_id || x.said_at.slice(0, 10) === a.said_at.slice(0, 10)) return false;
			const other = new Set(contentStems(x.user_text));
			return stems.filter((s) => other.has(s)).length >= need;
		});
		if (!b) continue;
		taken.add(a.event_id);
		taken.add(b.event_id);
		out.push({
			cluster,
			evidence: [`event:${a.event_id}`, `event:${b.event_id}`],
			topic: a.user_text.replace(/\s+/g, " ").slice(0, 300),
			at: a.said_at > b.said_at ? a.said_at : b.said_at,
		});
	}
	return out;
}

/** The owner's intentions of the last week that no plan came from. */
export function unplannedIntentions(
	db: Db,
	now: Date,
): { cluster: string; evidence: string[]; text: string; at: string }[] {
	const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
	return (
		db
			.prepare(
				`SELECT e.event_id, e.user_text, e.said_at FROM stm_episodes e
				 WHERE e.scope = 'owner' AND e.kind IN ('turn', 'remember') AND e.said_at >= ?
				 AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.created_event_id = e.event_id)
				 AND NOT EXISTS (SELECT 1 FROM commitments c WHERE c.created_event_id = e.event_id)
				 -- A turn that used a tool did what was asked: the request is not an open intention.
				 AND NOT EXISTS (SELECT 1 FROM tool_calls t WHERE t.scope = e.scope AND t.started_at >= e.said_at AND t.started_at <= e.answered_at)
				 -- Once acted on (a plan proposed, or nothing to propose), the opportunity carries it.
				 AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.cluster = 'intention:' || e.event_id)
				 ORDER BY e.said_at`,
			)
			.all(since) as { event_id: string; user_text: string; said_at: string }[]
	).flatMap((r) => {
		const text = statesIntention(r.user_text);
		return text
			? [{ cluster: `intention:${r.event_id}`, evidence: [`event:${r.event_id}`], text, at: r.said_at }]
			: [];
	});
}

/** Dated events people mentioned that are now past (within three days), for a follow-up. */
export function pastEvents(
	db: Db,
	now: Date,
): { cluster: string; evidence: string[]; scope: string; text: string; at: string }[] {
	const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
	return (
		db
			.prepare(
				"SELECT event_id, scope, user_text, said_at FROM stm_episodes WHERE kind = 'turn' AND said_at >= ? AND scope != 'owner-console' ORDER BY said_at",
			)
			.all(since) as { event_id: string; scope: string; user_text: string; said_at: string }[]
	).flatMap((r) => {
		// Once followed up (or decided against), the opportunity carries it.
		if (db.prepare("SELECT 1 FROM opportunities WHERE cluster = ?").get(`event:${r.event_id}`)) return [];
		const d = eventDate(r.user_text, new Date(r.said_at));
		if (!d) return [];
		const ago = now.getTime() - d.at.getTime();
		if (ago < 0 || ago > 3 * 86_400_000) return [];
		return [
			{
				cluster: `event:${r.event_id}`,
				evidence: [`event:${r.event_id}`],
				scope: r.scope,
				// Signal texts are kept with the motivation samples, which /forget does not reach: a contact's
				// words are never quoted there, only the owner's.
				text:
					r.scope === "owner"
						? `"${r.user_text.replace(/\s+/g, " ").slice(0, 120)}" (${d.phrase}, now past)`
						: `a message in ${r.scope} named a date (${d.phrase}), now past`,
				at: d.at.toISOString(),
			},
		];
	});
}
