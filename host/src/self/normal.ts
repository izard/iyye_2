// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * What is normal for Iyye (plan 0.018 §3.3): pure, deterministic rules over
 * records. W0 only measures them on past records (`scripts/world-spike.ts`);
 * nothing in the host calls them yet.
 *
 * - **A regularity:** something that starts within the same stretch of the
 *   local day on most days (the network going away around 23:15).
 * - **A baseline:** the usual band of a numeric reading at an hour of the
 *   local day, and readings that stay outside it.
 * - **A forecast:** a straight line through recent readings, and when it
 *   reaches a limit.
 *
 * Local time, never UTC: a habit of the household keeps its local hour when
 * summer time ends (2026-10-25 moved the nightly network gap by an hour in UTC).
 */

const DAY_MIN = 1440;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The local day ("2026-11-09"), minute of that day, hour and weekday (0 = Sunday) of an instant. */
export function localParts(at: Date, timeZone: string): { day: string; minute: number; hour: number; weekday: number } {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			weekday: "short",
			hourCycle: "h23",
		});
		formatters.set(timeZone, f);
	}
	const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
	const hour = Number(p.hour) % 24;
	return {
		day: `${p.year}-${p.month}-${p.day}`,
		minute: hour * 60 + Number(p.minute),
		hour,
		weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? ""),
	};
}

/** "23:15" for a minute of the day. */
export function hhmm(minute: number): string {
	const m = ((Math.round(minute) % DAY_MIN) + DAY_MIN) % DAY_MIN;
	return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function median(xs: readonly number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ---------------------------------------------------------------- regularities

/** A stretch during which something held (the network away, a service down); `end` null while it still holds. */
export interface Span {
	start: Date;
	end: Date | null;
}

export interface Regularity {
	/** The usual start and end, as minutes of the local day; `endMinute` null when no member has ended. */
	startMinute: number;
	endMinute: number | null;
	/** Days it happened on, of the days looked at. */
	days: number;
	of: number;
	/** From the earliest to the latest start among those days, in minutes. */
	spreadMinutes: number;
	/** The local days it happened on, oldest first. */
	on: string[];
}

export interface RegularityOptions {
	timeZone: string;
	/** Days looked back from `now` (14). */
	windowDays?: number;
	/** Days it must have happened on (5). */
	minDays?: number;
	/** How far apart in the day the starts may be (90 minutes). */
	widthMinutes?: number;
}

/**
 * The most regular daily start among the spans of the last `windowDays`: the
 * stretch of `widthMinutes` of the local day that holds starts from the most
 * different days. Null when that is fewer than `minDays`. A stretch may cross
 * midnight; a day is counted once however often it happened in it.
 */
export function findRegularity(spans: readonly Span[], now: Date, o: RegularityOptions): Regularity | null {
	const windowDays = o.windowDays ?? 14;
	const minDays = o.minDays ?? 5;
	const width = o.widthMinutes ?? 90;
	const since = now.getTime() - windowDays * DAY_MS;
	const recent = spans
		.filter((s) => s.start.getTime() > since && s.start.getTime() <= now.getTime())
		.map((s) => ({ ...s, minute: localParts(s.start, o.timeZone).minute }));
	let best: { from: number; members: { offset: number; day: string; span: Span }[]; spread: number } | null = null;
	for (const anchor of recent) {
		const byDay = new Map<string, { offset: number; day: string; span: Span }>();
		for (const s of recent) {
			const offset = (s.minute - anchor.minute + DAY_MIN) % DAY_MIN;
			if (offset >= width) continue;
			// The local day the stretch began on: a start just after midnight belongs to the evening before.
			const day = localParts(new Date(s.start.getTime() - offset * MIN_MS), o.timeZone).day;
			const had = byDay.get(day);
			if (!had || offset < had.offset) byDay.set(day, { offset, day, span: s });
		}
		const members = [...byDay.values()];
		const spread = Math.max(...members.map((m) => m.offset)) - Math.min(...members.map((m) => m.offset));
		if (
			!best ||
			members.length > best.members.length ||
			(members.length === best.members.length && spread < best.spread)
		)
			best = { from: anchor.minute, members, spread };
	}
	if (!best || best.members.length < minDays) return null;
	const from = best.from;
	const ends = best.members.flatMap((m) =>
		m.span.end ? [(localParts(m.span.end, o.timeZone).minute - from + DAY_MIN) % DAY_MIN] : [],
	);
	return {
		startMinute: Math.round(from + median(best.members.map((m) => m.offset))) % DAY_MIN,
		endMinute: ends.length ? Math.round(from + median(ends)) % DAY_MIN : null,
		days: best.members.length,
		of: windowDays,
		spreadMinutes: best.spread,
		on: best.members.map((m) => m.day).sort(),
	};
}

// ---------------------------------------------------------------- baselines

export interface Reading {
	at: Date;
	value: number;
}

export interface Band {
	median: number;
	/** A robust spread (1.4826 × the median absolute deviation), never below the field's `minSpread`. */
	spread: number;
	n: number;
}

/** By hour of the local day, or also weekdays and weekends apart. */
export type Buckets = "hour" | "hour+weekend";

export function bucketOf(at: Date, timeZone: string, buckets: Buckets): string {
	const p = localParts(at, timeZone);
	return buckets === "hour" ? String(p.hour) : `${p.weekday === 0 || p.weekday === 6 ? "we" : "wd"}:${p.hour}`;
}

export interface BaselineOptions {
	timeZone: string;
	buckets?: Buckets;
	/** Days of readings a baseline is made of (28). */
	days?: number;
	/** The smallest spread a band may have, in the reading's unit. */
	minSpread?: number;
}

/** Each bucket's usual band, from the readings of the `days` before `now`. */
export function baselines(readings: readonly Reading[], now: Date, o: BaselineOptions): Map<string, Band> {
	const since = now.getTime() - (o.days ?? 28) * DAY_MS;
	const byBucket = new Map<string, number[]>();
	for (const r of readings) {
		if (r.at.getTime() < since || r.at.getTime() >= now.getTime()) continue;
		const b = bucketOf(r.at, o.timeZone, o.buckets ?? "hour");
		byBucket.set(b, [...(byBucket.get(b) ?? []), r.value]);
	}
	const out = new Map<string, Band>();
	for (const [b, values] of byBucket) out.set(b, bandOf(values, o.minSpread)!);
	return out;
}

export function bandOf(values: readonly number[], minSpread = 0): Band | null {
	if (values.length === 0) return null;
	const m = median(values);
	const mad = median(values.map((v) => Math.abs(v - m)));
	return { median: m, spread: Math.max(1.4826 * mad, minSpread), n: values.length };
}

export interface SurpriseOptions extends BaselineOptions {
	/** How many spreads from the median is unusual (4). */
	k?: number;
	/** Readings a bucket needs before it judges anything (6). */
	minN?: number;
	/** Readings in a row outside the band before it counts (3). */
	runs?: number;
	/** Only this side counts ("low" for free memory and free disk). */
	side?: "low" | "high" | "both";
	/** The field's own floor: a reading counts only when this also holds (free memory below 16 GB). */
	floor?: (value: number) => boolean;
}

export interface Episode {
	start: Date;
	end: Date | null;
	side: "low" | "high";
	/** The reading furthest from its band, and that band's median. */
	peak: number;
	usual: number;
}

/**
 * Replay: at each reading, the baseline is made of the readings before it, and
 * a run of readings outside their bands (and past the floor) is one episode,
 * until a reading is back inside. This is what W3 would have raised.
 */
export function surpriseEpisodes(readings: readonly Reading[], o: SurpriseOptions): Episode[] {
	const k = o.k ?? 4;
	const minN = o.minN ?? 6;
	const runs = o.runs ?? 3;
	const side = o.side ?? "both";
	const window = (o.days ?? 28) * DAY_MS;
	const sorted = [...readings].sort((a, b) => a.at.getTime() - b.at.getTime());
	const buckets = sorted.map((r) => bucketOf(r.at, o.timeZone, o.buckets ?? "hour"));
	const out: Episode[] = [];
	let run: { start: Date; side: "low" | "high"; n: number; peak: number; usual: number; dist: number } | null = null;
	let open: Episode | null = null;
	for (const [i, r] of sorted.entries()) {
		// The band of this reading's bucket, from the readings before it.
		const earlier = sorted.filter(
			(x, j) => j < i && buckets[j] === buckets[i] && x.at.getTime() >= r.at.getTime() - window,
		);
		const band = bandOf(
			earlier.map((x) => x.value),
			o.minSpread,
		);
		let where: "low" | "high" | null = null;
		if (band && band.n >= minN && band.spread > 0) {
			if (r.value < band.median - k * band.spread) where = "low";
			else if (r.value > band.median + k * band.spread) where = "high";
		}
		if (where && ((side !== "both" && side !== where) || (o.floor && !o.floor(r.value)))) where = null;
		if (!where || !band || (run && run.side !== where)) {
			if (open) open.end = r.at;
			open = null;
			run = null;
		}
		if (!where || !band) continue;
		const dist = Math.abs(r.value - band.median) / band.spread;
		run ??= { start: r.at, side: where, n: 0, peak: r.value, usual: band.median, dist };
		run.n++;
		if (dist > run.dist) Object.assign(run, { peak: r.value, usual: band.median, dist });
		if (run.n === runs) {
			open = { start: run.start, end: null, side: where, peak: run.peak, usual: run.usual };
			out.push(open);
		} else if (open) Object.assign(open, { peak: run.peak, usual: run.usual });
	}
	return out;
}

// ---------------------------------------------------------------- forecasts

/** The least-squares line through the readings: its slope per day and its value at `at`. Null with fewer than 3. */
export function trend(readings: readonly Reading[], at: Date): { perDay: number; value: number } | null {
	if (readings.length < 3) return null;
	const xs = readings.map((r) => (r.at.getTime() - at.getTime()) / DAY_MS);
	const ys = readings.map((r) => r.value);
	const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
	const my = ys.reduce((a, b) => a + b, 0) / ys.length;
	const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
	if (sxx === 0) return null;
	const perDay = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / sxx;
	return { perDay, value: my - perDay * mx };
}

/** Days from `now` until the line through the last `days` of readings reaches `limit`; null when it never does. */
export function daysUntil(readings: readonly Reading[], now: Date, limit: number, days = 14): number | null {
	const since = now.getTime() - days * DAY_MS;
	const t = trend(
		readings.filter((r) => r.at.getTime() >= since && r.at.getTime() <= now.getTime()),
		now,
	);
	if (!t || t.perDay === 0) return null;
	const d = (limit - t.value) / t.perDay;
	return d >= 0 ? d : null;
}
