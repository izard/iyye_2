// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The history of the self model's numeric fields (plan 0.018 §3.2, W1):
 * `self_readings` holds every probe's values for a week, and
 * `self_readings_hourly` the hours before that for 90 days. Nothing reads
 * them to decide anything yet (baselines and forecasts are W3); `/self
 * history` shows them.
 */

import { createHash } from "node:crypto";
import type { Db } from "../state/db.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A short id of the computer the readings are from: a new machine starts a new history. */
export function machineKey(hardware: { machine?: unknown; chip?: unknown; memoryGb?: unknown }): string {
	if (!hardware.machine && !hardware.chip) return "unknown";
	return createHash("sha256")
		.update(`${hardware.machine ?? ""}|${hardware.chip ?? ""}|${hardware.memoryGb ?? ""}`)
		.digest("hex")
		.slice(0, 8);
}

/** One probe's numeric values; fields that could not be read (null) leave no row. */
export function recordReadings(
	db: Db,
	machine: string,
	facet: string,
	values: Readonly<Record<string, number | null | undefined>>,
	at: Date,
): void {
	const insert = db.prepare("INSERT INTO self_readings (facet, field, machine, at, value) VALUES (?, ?, ?, ?, ?)");
	const iso = at.toISOString();
	db.transaction(() => {
		for (const [field, value] of Object.entries(values))
			if (typeof value === "number" && Number.isFinite(value)) insert.run(facet, field, machine, iso, value);
	})();
}

/** Readings older than `rawDays` become hourly rows; hourly rows older than `hourlyDays` go. Safe to repeat. */
export function foldReadings(db: Db, now: Date, o: { rawDays?: number; hourlyDays?: number } = {}): void {
	const cut = new Date(Math.floor((now.getTime() - (o.rawDays ?? 7) * DAY_MS) / HOUR_MS) * HOUR_MS).toISOString();
	db.transaction(() => {
		db.prepare(
			`INSERT INTO self_readings_hourly (facet, field, machine, hour, min, mean, max, n)
			 SELECT facet, field, machine, substr(at, 1, 13), min(value), avg(value), max(value), count(*)
			 FROM self_readings WHERE at < ? GROUP BY facet, field, machine, substr(at, 1, 13)
			 ON CONFLICT (facet, field, machine, hour) DO UPDATE SET
				min = min(min, excluded.min), max = max(max, excluded.max),
				mean = (mean * n + excluded.mean * excluded.n) / (n + excluded.n), n = n + excluded.n`,
		).run(cut);
		db.prepare("DELETE FROM self_readings WHERE at < ?").run(cut);
		db.prepare("DELETE FROM self_readings_hourly WHERE hour < ?").run(
			new Date(now.getTime() - (o.hourlyDays ?? 90) * DAY_MS).toISOString().slice(0, 13),
		);
	})();
}

export interface HourOfReadings {
	/** The hour's start, UTC ("2026-11-09T21"). */
	hour: string;
	min: number;
	mean: number;
	max: number;
	n: number;
}

/** A field's hours since `since` on one machine, oldest first: the folded hours and the recent readings alike. */
export function hourly(db: Db, facet: string, field: string, machine: string, since: Date): HourOfReadings[] {
	const from = since.toISOString().slice(0, 13);
	return db
		.prepare(
			`SELECT hour, min(min) AS min, sum(mean * n) / sum(n) AS mean, max(max) AS max, sum(n) AS n FROM (
				SELECT hour, min, mean, max, n FROM self_readings_hourly WHERE facet = ? AND field = ? AND machine = ? AND hour >= ?
				UNION ALL
				SELECT substr(at, 1, 13), min(value), avg(value), max(value), count(*) FROM self_readings
				WHERE facet = ? AND field = ? AND machine = ? AND at >= ? GROUP BY substr(at, 1, 13)
			 ) GROUP BY hour ORDER BY hour`,
		)
		.all(facet, field, machine, from, facet, field, machine, from) as HourOfReadings[];
}

/** The numeric fields that have readings, as "facet.field". */
export function readingFields(db: Db, machine: string): string[] {
	return (
		db
			.prepare(
				`SELECT DISTINCT facet || '.' || field AS f FROM self_readings WHERE machine = ?
				 UNION SELECT DISTINCT facet || '.' || field FROM self_readings_hourly WHERE machine = ? ORDER BY 1`,
			)
			.all(machine, machine) as { f: string }[]
	).map((r) => r.f);
}
