// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Plan 0.018 W0: regularities, baselines and forecasts, as pure rules. */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	baselines,
	daysUntil,
	findRegularity,
	hhmm,
	localParts,
	type Reading,
	type Span,
	surpriseEpisodes,
	trend,
} from "../src/self/normal.ts";

const TZ = "Europe/Berlin";
const H = 3_600_000;
const DAY = 24 * H;
/** A local wall-clock time in Berlin: summer time (+02:00) until 2026-10-25, then +01:00. */
const berlin = (day: string, time: string) => new Date(`${day}T${time}:00${day < "2026-10-25" ? "+02:00" : "+01:00"}`);

describe("local time", () => {
	test("the local day, minute and weekday follow the time zone and its summer time", () => {
		assert.deepEqual(localParts(new Date("2026-10-24T21:30:00Z"), TZ), {
			day: "2026-10-24",
			minute: 23 * 60 + 30,
			hour: 23,
			weekday: 6,
		});
		assert.deepEqual(localParts(new Date("2026-10-25T22:30:00Z"), TZ), {
			day: "2026-10-25",
			minute: 23 * 60 + 30,
			hour: 23,
			weekday: 0,
		});
		assert.equal(localParts(new Date("2026-11-01T23:10:00Z"), TZ).day, "2026-11-02");
		assert.equal(hhmm(23 * 60 + 15), "23:15");
		assert.equal(hhmm(1445), "00:05");
	});
});

describe("regularities", () => {
	const now = berlin("2026-11-02", "12:00");
	const night = (day: string, start: string, nextDay: string, end: string): Span => ({
		start: berlin(day, start),
		end: berlin(nextDay, end),
	});

	test("a nightly gap is found at its local hour across the end of summer time", () => {
		const spans = [
			night("2026-10-21", "23:14", "2026-10-22", "07:10"),
			night("2026-10-22", "23:43", "2026-10-23", "07:40"),
			night("2026-10-23", "23:34", "2026-10-24", "09:02"),
			night("2026-10-25", "23:05", "2026-10-26", "07:18"),
			night("2026-10-26", "23:39", "2026-10-27", "07:28"),
			night("2026-10-28", "23:03", "2026-10-29", "07:19"),
			// One at noon the same week is not part of it.
			night("2026-10-27", "12:00", "2026-10-27", "12:20"),
		];
		const r = findRegularity(spans, now, { timeZone: TZ });
		assert.ok(r);
		assert.equal(r.days, 6);
		assert.equal(r.of, 14);
		assert.equal(hhmm(r.startMinute), "23:24");
		assert.equal(hhmm(r.endMinute!), "07:24");
		assert.equal(r.spreadMinutes, 40);
		assert.deepEqual(r.on.at(-1), "2026-10-28");
	});

	test("a stretch across midnight counts the evening it belongs to, once", () => {
		const spans = [
			night("2026-10-27", "23:50", "2026-10-28", "06:00"),
			night("2026-10-29", "00:10", "2026-10-29", "06:00"), // the night of the 28th
			night("2026-10-29", "23:55", "2026-10-30", "06:00"),
			night("2026-10-31", "00:20", "2026-10-31", "06:00"), // the night of the 30th
			night("2026-10-31", "23:45", "2026-11-01", "06:00"),
			night("2026-11-01", "00:30", "2026-11-01", "00:40"), // again in the night of the 31st: the same day
		];
		const r = findRegularity(spans, now, { timeZone: TZ });
		assert.ok(r);
		assert.equal(r.days, 5);
		assert.deepEqual(r.on, ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]);
	});

	test("too few days, starts scattered through the day, or old ones are no regularity", () => {
		const few = [1, 2, 3, 4].map((d) => night(`2026-10-2${d}`, "23:10", `2026-10-2${d + 1}`, "07:00"));
		assert.equal(findRegularity(few, now, { timeZone: TZ }), null);
		const scattered = ["03:00", "07:30", "11:00", "15:00", "19:00", "22:30"].map((t, i) =>
			night(`2026-10-2${i + 1}`, t, `2026-10-2${i + 1}`, t),
		);
		assert.equal(findRegularity(scattered, now, { timeZone: TZ }), null);
		const old = [1, 2, 3, 4, 5, 6].map((d) => night(`2026-10-0${d}`, "23:10", `2026-10-0${d + 1}`, "07:00"));
		assert.equal(findRegularity(old, now, { timeZone: TZ }), null);
		assert.equal(findRegularity(old, berlin("2026-10-08", "12:00"), { timeZone: TZ })!.days, 6);
	});
});

describe("baselines and surprises", () => {
	const start = berlin("2026-10-05", "00:00").getTime();
	/** Free memory every hour for 30 days: about 60 GB by day, 45 GB at night while the memory model works. */
	const usual = (): Reading[] =>
		Array.from({ length: 30 * 24 }, (_, i) => {
			const at = new Date(start + i * H);
			const hour = localParts(at, TZ).hour;
			return { at, value: (hour >= 2 && hour < 8 ? 45 : 60) + ((i * 7) % 5) - 2 };
		});

	test("a band per hour of the local day", () => {
		const b = baselines(usual(), new Date(start + 30 * DAY), { timeZone: TZ, minSpread: 1 });
		assert.ok(Math.abs(b.get("4")!.median - 45) <= 2);
		assert.ok(Math.abs(b.get("14")!.median - 60) <= 2);
		assert.ok(b.get("14")!.n >= 25 && b.get("14")!.spread >= 1);
	});

	test("the nightly dip is usual; a lasting drop by day is one episode, and a single low reading is none", () => {
		const o = { timeZone: TZ, minSpread: 1, side: "low" as const, floor: (v: number) => v < 40 };
		assert.deepEqual(surpriseEpisodes(usual(), o), []);
		const drop = usual();
		// 29 October, 10:00–18:00 local: nine readings at 20 GB. 31 October, 12:00: one.
		for (const r of drop) {
			const p = localParts(r.at, TZ);
			if (p.day === "2026-10-29" && p.hour >= 10 && p.hour <= 18) r.value = 20;
			if (p.day === "2026-10-31" && p.hour === 12) r.value = 20;
		}
		const eps = surpriseEpisodes(drop, o);
		assert.equal(eps.length, 1);
		assert.equal(localParts(eps[0]!.start, TZ).day, "2026-10-29");
		assert.equal(eps[0]!.side, "low");
		assert.equal(eps[0]!.peak, 20);
		assert.ok(eps[0]!.end && localParts(eps[0]!.end, TZ).hour === 19, "closed by the first usual reading");
		// The floor is the field's own: without it the same drop counts, with a higher bar it does not.
		assert.equal(surpriseEpisodes(drop, { ...o, floor: (v: number) => v < 10 }).length, 0);
	});
});

describe("forecasts", () => {
	test("a steady fall reaches its limit on the day the line says; a rise never does", () => {
		const now = new Date("2026-11-09T12:00:00Z");
		const falling: Reading[] = Array.from({ length: 14 }, (_, i) => ({
			at: new Date(now.getTime() - (13 - i) * DAY),
			value: 500 - i * 10, // 370 GB now, 10 GB a day
		}));
		const t = trend(falling, now)!;
		assert.ok(Math.abs(t.perDay + 10) < 1e-6 && Math.abs(t.value - 370) < 1e-6);
		assert.ok(Math.abs(daysUntil(falling, now, 0)! - 37) < 1e-6);
		assert.equal(
			daysUntil(
				falling.map((r) => ({ at: r.at, value: 1000 - r.value })),
				now,
				0,
			),
			null,
		);
		assert.equal(trend(falling.slice(0, 2), now), null);
	});
});
