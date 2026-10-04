// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * When a reminder is due (plan 0.006 §2.3): the host resolves the time, the
 * model never supplies a bare timestamp it computed itself. Accepted forms,
 * in the owner's local timezone:
 *
 * - `2026-10-06 09:00` (or with a `T`), `2026-10-06` (09:00)
 * - `12 october 12:00`, `october 12 at noon`, `12 october` (09:00), with an optional year;
 *   without a year, the next such date
 * - `in 20 minutes`, `in 2 hours`, `in 3 days`, `in 1 week`
 * - `today 18:00`, `tomorrow 09:00`, `tomorrow` (09:00)
 * - `monday 18:30`, `next monday`: the next such day, never today
 * - `18:30`, `9am`, `9:30 pm`, `noon`, `midnight`: today if still ahead, otherwise tomorrow
 *
 * The past and anything beyond a year are refused. The result says whether a
 * default time (09:00) was filled in, so the reply can say so.
 */

export type When = { ok: true; at: Date; defaulted: boolean } | { ok: false; error: string };

const UNITS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DEFAULT_HOUR = 9;
const YEAR_MS = 366 * 86_400_000;

export function parseWhen(input: string, now: Date): When {
	const s = input.trim().toLowerCase().replace(/\s+/g, " ").replace(/^at /, "");
	const r = resolve(s, now);
	if (!r.ok) return r;
	if (r.at.getTime() <= now.getTime()) return { ok: false, error: `${describeAt(r.at, now)} is in the past` };
	if (r.at.getTime() - now.getTime() > YEAR_MS) return { ok: false, error: "more than a year ahead" };
	return r;
}

function resolve(s: string, now: Date): When {
	let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2}))?$/.exec(s);
	if (m) {
		const [, y, mo, d, h, mi] = m;
		const at = new Date(Number(y), Number(mo) - 1, Number(d), h ? Number(h) : DEFAULT_HOUR, mi ? Number(mi) : 0);
		if (at.getMonth() !== Number(mo) - 1) return { ok: false, error: `no such date: ${s}` };
		return { ok: true, at, defaulted: !h };
	}
	const date = dayMonth(s, now);
	if (date) return date;
	m = /^in (\d+(?:\.\d+)?|an?|one) (minute|min|hour|hr|day|week)s?$/.exec(s);
	if (m) {
		const n = /^(a|an|one)$/.test(m[1]!) ? 1 : Number(m[1]);
		const unit = ({ min: "minute", hr: "hour" } as Record<string, string>)[m[2]!] ?? m[2]!;
		return { ok: true, at: new Date(now.getTime() + n * UNITS[unit]!), defaulted: false };
	}
	m =
		/^(today|tomorrow|(?:next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))(?: (?:at )?(.+))?$/.exec(
			s,
		);
	if (m) {
		const day = new Date(now);
		const word = m[1]!.replace(/^next /, "");
		if (word === "tomorrow") day.setDate(day.getDate() + 1);
		else if (word !== "today") {
			const ahead = (DAYS.indexOf(word) - now.getDay() + 7) % 7 || 7; // never today
			day.setDate(day.getDate() + ahead);
		}
		if (!m[2]) {
			day.setHours(DEFAULT_HOUR, 0, 0, 0);
			return { ok: true, at: day, defaulted: true };
		}
		const t = clock(m[2]);
		if (!t) return { ok: false, error: `not a time of day: ${m[2]}` };
		day.setHours(t.h, t.m, 0, 0);
		return { ok: true, at: day, defaulted: false };
	}
	const t = clock(s);
	if (t) {
		const at = new Date(now);
		at.setHours(t.h, t.m, 0, 0);
		if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
		return { ok: true, at, defaulted: false };
	}
	return {
		ok: false,
		error: `cannot read "${s}": use a form like "in 2 hours", "tomorrow 09:00", "monday 18:30" or "2026-10-06 09:00"`,
	};
}

const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

/** "12 october 12:00", "october 12th at noon", "12 oct 2026"; null when it is not this form. */
function dayMonth(s: string, now: Date): When | null {
	const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
	const m =
		new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? ${mon},?(?: (\\d{4}))?(?:,? (?:at )?(.+))?$`).exec(s) ??
		(() => {
			const r = new RegExp(`^${mon} (\\d{1,2})(?:st|nd|rd|th)?,?(?: (\\d{4}))?(?:,? (?:at )?(.+))?$`).exec(s);
			return r ? [r[0], r[2], r[1], r[3], r[4]] : null;
		})();
	if (!m) return null;
	const day = Number(m[1]);
	const month = MONTHS.findIndex((x) => x.startsWith(m[2]!.slice(0, 3)));
	const t = m[4] ? clock(m[4]) : null;
	if (m[4] && !t) return { ok: false, error: `not a time of day: ${m[4]}` };
	const make = (y: number) => new Date(y, month, day, t ? t.h : DEFAULT_HOUR, t ? t.m : 0);
	let at = make(m[3] ? Number(m[3]) : now.getFullYear());
	if (at.getMonth() !== month) return { ok: false, error: `no such date: ${s}` };
	if (!m[3] && at.getTime() <= now.getTime()) at = make(now.getFullYear() + 1); // no year: the next such date
	return { ok: true, at, defaulted: !t };
}

/** "18:30", "9am", "9:30 pm", "21", "noon", "midnight". */
function clock(s: string): { h: number; m: number } | null {
	if (s.trim() === "noon") return { h: 12, m: 0 };
	if (s.trim() === "midnight") return { h: 0, m: 0 };
	const m = /^(\d{1,2})(?::(\d{2}))? ?(am|pm)?$/.exec(s.trim());
	if (!m) return null;
	let h = Number(m[1]);
	const mi = m[2] ? Number(m[2]) : 0;
	if (m[3]) {
		if (h < 1 || h > 12) return null;
		h = (h % 12) + (m[3] === "pm" ? 12 : 0);
	}
	if (h > 23 || mi > 59) return null;
	return { h, m: mi };
}

/** "Monday 5 October 2026 09:00", in local time. */
export function describeAt(at: Date, _now: Date = new Date()): string {
	const day = at.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
	return `${day} ${at.toTimeString().slice(0, 5)}`;
}
