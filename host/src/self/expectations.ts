// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * What is normal for Iyye, kept from its own records (plan 0.018 W3, §3.3).
 * The rules are `normal.ts`'s; this keeps their results and turns them into
 * reasons, deterministically and inspectably (`/self normal`).
 *
 * - **Levels** (memory available, swap, load, pressure, temperatures, the
 *   Wi-Fi's signal) have a baseline: the usual band of that hour of the local
 *   day over the last 28 days. A reading that stays outside it for three
 *   readings, on the side that matters, and past the field's own floor, is a
 *   **surprise** (`self_surprises`), open until a reading is back inside.
 * - **Stocks** (free disk) have a forecast instead: a line through the last
 *   14 days and the day it reaches zero.
 * - **Regularities** (`self_regularities`): something that starts within the
 *   same 90 minutes of the local day on 5 of the last 14 days (the network
 *   going away at night). Never about what Iyye does itself.
 * - **Expected or a problem is the owner's call** (owner decision 4). Until
 *   the owner says, a regularity is a candidate Iyye asks about once. With an
 *   answer, its occurrence in its usual hours is no longer a finding or a
 *   notice (`usual`): if expected, that is all; if a problem, it stays one
 *   standing signal with its count, not one a night.
 *
 * Nothing here acts. `signals()` are reasons for the motivation tracker, which
 * journals the new kinds only until the owner lets them act (`IYYE2_SELF_SIGNALS`).
 */

import type { Logger } from "../log.ts";
import { OK_SERVICE_STATES } from "../motivation/services.ts";
import type { Db } from "../state/db.ts";
import type { SelfModel } from "./model.ts";
import { type Band, bandOf, daysUntil, findRegularity, hhmm, localParts, type Span, trend } from "./normal.ts";
import { hourly, machineKey } from "./readings.ts";
import { type NightRow, recentNights } from "./runs.ts";
import type { Need } from "./surroundings.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A numeric field with a usual band. */
export interface Level {
	facet: string;
	field: string;
	/** In words, for the owner and the signal. */
	name: string;
	unit: string;
	/** Which side is trouble. */
	side: "low" | "high";
	/** The field's own floor: a reading counts only when this also holds. */
	floor: (value: number, cores: number) => boolean;
	floorText: string;
	minSpread: number;
}

export const LEVELS: readonly Level[] = [
	{
		facet: "memory",
		field: "availableGb",
		name: "memory available",
		unit: "GB",
		side: "low",
		floor: (v) => v < 16,
		floorText: "below 16 GB",
		minSpread: 2,
	},
	{
		facet: "memory",
		field: "swapUsedGb",
		name: "swap in use",
		unit: "GB",
		side: "high",
		floor: (v) => v > 4,
		floorText: "above 4 GB",
		minSpread: 0.5,
	},
	{
		facet: "compute",
		field: "load15",
		name: "the load",
		unit: "",
		side: "high",
		floor: (v, cores) => v > 0.75 * cores,
		floorText: "above three quarters of the cores",
		minSpread: 0.5,
	},
	{
		facet: "compute",
		field: "memoryPressure",
		name: "memory pressure",
		unit: "%",
		side: "high",
		floor: (v) => v > 10,
		floorText: "above 10%",
		minSpread: 1,
	},
	{
		facet: "compute",
		field: "ioPressure",
		name: "disk pressure",
		unit: "%",
		side: "high",
		floor: (v) => v > 20,
		floorText: "above 20%",
		minSpread: 1,
	},
	{
		facet: "compute",
		field: "hottestC",
		name: "the hottest sensor",
		unit: "°C",
		side: "high",
		floor: (v) => v > 80,
		floorText: "above 80 °C",
		minSpread: 3,
	},
	{
		facet: "compute",
		field: "gpuTempC",
		name: "the GPU's temperature",
		unit: "°C",
		side: "high",
		floor: (v) => v > 80,
		floorText: "above 80 °C",
		minSpread: 3,
	},
	{
		facet: "link",
		field: "signalDbm",
		name: "the Wi-Fi's signal",
		unit: "dBm",
		side: "low",
		floor: (v) => v < -75,
		floorText: "below −75 dBm",
		minSpread: 3,
	},
];

export interface Surprise {
	id: string;
	facet: string;
	field: string;
	machine: string;
	started_at: string;
	ended_at: string | null;
	side: "low" | "high";
	peak: number;
	usual: number;
}

export interface RegularityRow {
	id: string;
	subject: string;
	start_minute: number;
	end_minute: number | null;
	days: number;
	of_days: number;
	spread_minutes: number;
	first_found: string;
	last_found: string;
	last_on: string | null;
	answer: "expected" | "problem" | null;
	answered_at: string | null;
	answered_by: string | null;
}

/** A reason for the motivation tracker, as `motivation/signals.ts` takes them. */
export interface Reason {
	motivation: "self_preservation" | "curiosity";
	kind: string;
	cluster: string;
	evidence: string[];
	weight: number;
	text: string;
	observedAt?: string;
}

export interface ExpectationsDeps {
	db: Db;
	log: Logger;
	self: Pick<SelfModel, "value">;
	mode: () => "awake" | "winding_down" | "asleep";
	/** What each service needs (`SelfSurroundings`'s map): what fails with the network is the network's regularity. */
	needs: Record<string, Need>;
	/** The rest window's length, to tell a night that outlasts it. */
	restWindowMinutes: number;
	timezone?: string;
	tickMs?: number;
	now?: () => Date;
	newId?: () => string;
	/** How many spreads from the median is unusual, and how many readings in a row. */
	k?: number;
	runs?: number;
	/** Days a bucket needs before it judges anything. */
	minDays?: number;
	baselineDays?: number;
	/** A regularity not found for this long is no longer in force. */
	lapseDays?: number;
}

/** In words: "the network goes away", for a subject and its usual hours. */
function describe(r: Pick<RegularityRow, "subject" | "start_minute" | "end_minute" | "days" | "of_days">): string {
	const what =
		r.subject === "network"
			? "the network goes away"
			: r.subject === "host"
				? "the host stops running"
				: r.subject.startsWith("service:")
					? `${r.subject.slice("service:".length)} stops working`
					: `${r.subject.slice("peer:".length)} stops answering`;
	return `${what} around ${hhmm(r.start_minute)}${r.end_minute === null ? "" : ` and is back by about ${hhmm(r.end_minute)}`} (${r.days} of the last ${r.of_days} days)`;
}

export class SelfExpectations {
	private readonly d: Required<ExpectationsDeps>;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	/** Readings in a row outside the band, per field (not kept across restarts: a run starts again). */
	private readonly run = new Map<string, { n: number; since: string; peak: number; usual: number; dist: number }>();
	/** The last reading looked at, per field. */
	private readonly seen = new Map<string, string>();
	private readonly bands = new Map<string, { hour: string; band: Band | null }>();
	private regularDay: string | null = null;

	constructor(deps: ExpectationsDeps) {
		this.d = {
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			tickMs: MIN,
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			k: 4,
			runs: 3,
			minDays: 5,
			baselineDays: 28,
			lapseDays: 4,
			...deps,
		};
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), this.d.tickMs);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.running;
	}

	/** One pass: new readings against their baselines; the regularities once a day. Public for tests. */
	tick(): Promise<void> {
		if (this.running) return this.running;
		this.running = Promise.resolve()
			.then(() => {
				const now = this.d.now();
				this.surprises();
				const day = localParts(now, this.d.timezone).day;
				// Awake: the day's records are complete enough, and nothing here is urgent.
				if (this.regularDay !== day && this.d.mode() === "awake") {
					this.regularDay = day;
					this.regularities(now);
				}
			})
			.catch((err) => this.d.log.warn("self: expectations failed", { error: (err as Error).message }))
			.finally(() => {
				this.running = null;
			});
		return this.running;
	}

	private get machine(): string {
		return machineKey({
			machine: this.d.self.value("hardware", "machine"),
			chip: this.d.self.value("hardware", "chip"),
			memoryGb: this.d.self.value("hardware", "memoryGb"),
		});
	}

	// ---------------------------------------------------------------- baselines and surprises

	/**
	 * The usual band of a level at this hour of the local day: from the hourly means of the last 28 days,
	 * weekdays and weekends apart when that bucket has enough days, together otherwise; null with too few.
	 */
	band(level: Level, at: Date): Band | null {
		const machine = this.machine;
		const p = localParts(at, this.d.timezone);
		const key = `${machine}|${level.facet}.${level.field}`;
		const hour = `${p.day}T${p.hour}`;
		const cached = this.bands.get(key);
		if (cached?.hour === hour) return cached.band;
		const weekend = p.weekday === 0 || p.weekday === 6;
		const rows = hourly(
			this.d.db,
			level.facet,
			level.field,
			machine,
			new Date(at.getTime() - this.d.baselineDays * DAY),
		)
			.map((r) => ({ at: new Date(`${r.hour}:00:00Z`), value: r.mean }))
			// Not this hour itself: a reading must not be its own baseline.
			.filter((r) => r.at.getTime() < at.getTime() - HOUR)
			.map((r) => ({ ...r, p: localParts(r.at, this.d.timezone) }))
			.filter((r) => r.p.hour === p.hour);
		const same = rows.filter((r) => (r.p.weekday === 0 || r.p.weekday === 6) === weekend);
		const use = same.length >= this.d.minDays ? same : rows;
		const band =
			use.length >= this.d.minDays
				? bandOf(
						use.map((r) => r.value),
						level.minSpread,
					)
				: null;
		this.bands.set(key, { hour, band });
		return band;
	}

	private surprises(): void {
		const machine = this.machine;
		const cores = this.d.self.value<number>("compute", "cores") ?? 1;
		for (const level of LEVELS) {
			const key = `${level.facet}.${level.field}`;
			const latest = this.d.db
				.prepare(
					"SELECT at, value FROM self_readings WHERE facet = ? AND field = ? AND machine = ? ORDER BY at DESC LIMIT 1",
				)
				.get(level.facet, level.field, machine) as { at: string; value: number } | undefined;
			if (!latest || this.seen.get(key) === latest.at) continue;
			this.seen.set(key, latest.at);
			const band = this.band(level, new Date(latest.at));
			if (!band) continue; // a reading the rule cannot judge changes nothing
			const off = (latest.value - band.median) / band.spread;
			const outside = (level.side === "low" ? off < -this.d.k : off > this.d.k) && level.floor(latest.value, cores);
			const open = this.d.db
				.prepare("SELECT * FROM self_surprises WHERE facet = ? AND field = ? AND machine = ? AND ended_at IS NULL")
				.get(level.facet, level.field, machine) as Surprise | undefined;
			if (!outside) {
				this.run.delete(key);
				if (open) this.d.db.prepare("UPDATE self_surprises SET ended_at = ? WHERE id = ?").run(latest.at, open.id);
				continue;
			}
			const r = this.run.get(key) ?? { n: 0, since: latest.at, peak: latest.value, usual: band.median, dist: 0 };
			r.n++;
			if (Math.abs(off) > r.dist) Object.assign(r, { peak: latest.value, usual: band.median, dist: Math.abs(off) });
			this.run.set(key, r);
			if (open) {
				this.d.db
					.prepare("UPDATE self_surprises SET peak = ?, usual = ? WHERE id = ?")
					.run(r.peak, r.usual, open.id);
			} else if (r.n >= this.d.runs) {
				this.d.db
					.prepare(
						"INSERT INTO self_surprises (id, facet, field, machine, started_at, side, peak, usual) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(this.d.newId(), level.facet, level.field, machine, r.since, level.side, r.peak, r.usual);
				this.d.log.info("self: a surprising reading", { field: key, value: latest.value, usual: band.median });
			}
		}
	}

	private openSurprises(): Surprise[] {
		return this.d.db
			.prepare("SELECT * FROM self_surprises WHERE ended_at IS NULL AND machine = ? ORDER BY started_at")
			.all(this.machine) as Surprise[];
	}

	// ---------------------------------------------------------------- regularities

	/** Stretches of something holding, from the change records, for each subject a regularity may be about. */
	spans(now: Date): Map<string, Span[]> {
		const since = new Date(now.getTime() - 21 * DAY).toISOString();
		const changes = (facet: string, field?: string) =>
			this.d.db
				.prepare(
					`SELECT field, new_json, at FROM self_changes WHERE facet = ? AND at >= ? ${field ? "AND field = ?" : ""} ORDER BY at`,
				)
				.all(...(field ? [facet, since, field] : [facet, since])) as {
				field: string;
				new_json: string | null;
				at: string;
			}[];
		const build = (rows: { new_json: string | null; at: string }[], holds: (v: unknown) => boolean | null) => {
			const out: Span[] = [];
			let open: Span | null = null;
			for (const r of rows) {
				const h = holds(r.new_json === null ? null : JSON.parse(r.new_json));
				if (h === true && !open) {
					open = { start: new Date(r.at), end: null };
					out.push(open);
				} else if (h === false && open) {
					open.end = new Date(r.at);
					open = null;
				}
			}
			return out;
		};
		const out = new Map<string, Span[]>();
		// The network: the minute-by-minute link since plan 0.018 W2; before its first record, the older
		// half-hourly probe of the default route (its interface is null while there is none).
		const link = changes("link", "online");
		const before = link[0]?.at ?? "9999";
		const network = [
			...build(
				changes("network", "interface").filter((c) => c.at < before),
				(v) => v === null,
			),
			...build(link, (v) => v === false),
		];
		out.set("network", network);
		const duringNetworkGap = (at: Date) =>
			network.some(
				(s) => s.start.getTime() <= at.getTime() + 5 * MIN && (s.end === null || s.end.getTime() >= at.getTime()),
			);
		// Services: what needs the network and fails with it is the network's; what needs a peer is the peer's.
		const byService = new Map<string, { new_json: string | null; at: string }[]>();
		for (const c of changes("services")) byService.set(c.field, [...(byService.get(c.field) ?? []), c]);
		for (const [name, rows] of byService) {
			const need = this.d.needs[name];
			if (need && need !== "internet") continue;
			const spans = build(rows, (v) => (typeof v === "string" ? !OK_SERVICE_STATES.has(v) : null));
			out.set(`service:${name}`, need === "internet" ? spans.filter((s) => !duringNetworkGap(s.start)) : spans);
		}
		// A machine Iyye uses: not answering, for whatever reason of its own.
		const byPeer = new Map<string, { new_json: string | null; at: string }[]>();
		for (const c of changes("peers")) byPeer.set(c.field, [...(byPeer.get(c.field) ?? []), c]);
		for (const [endpoint, rows] of byPeer)
			out.set(
				`peer:${endpoint}`,
				build(rows, (v) =>
					v === "answering" ? false : v === "not on the LAN" || v === "on the LAN, not answering" ? true : null,
				),
			);
		// The host itself: nothing ran between a run's last heartbeat and the next start.
		const runs = this.d.db
			.prepare("SELECT started_at, last_seen_at FROM host_runs WHERE started_at >= ? ORDER BY started_at")
			.all(since) as { started_at: string; last_seen_at: string }[];
		out.set(
			"host",
			runs.slice(1).flatMap((r, i) => {
				const start = new Date(runs[i]!.last_seen_at);
				const end = new Date(r.started_at);
				return end.getTime() - start.getTime() >= 10 * MIN ? [{ start, end }] : [];
			}),
		);
		return out;
	}

	private regularities(now: Date): void {
		const today = localParts(now, this.d.timezone).day;
		for (const [subject, spans] of this.spans(now)) {
			const r = findRegularity(spans, now, { timeZone: this.d.timezone });
			if (!r) continue;
			const old = this.d.db.prepare("SELECT id FROM self_regularities WHERE subject = ?").get(subject) as
				| { id: string }
				| undefined;
			if (old) {
				this.d.db
					.prepare(
						"UPDATE self_regularities SET start_minute = ?, end_minute = ?, days = ?, of_days = ?, spread_minutes = ?, last_found = ?, last_on = ? WHERE id = ?",
					)
					.run(r.startMinute, r.endMinute, r.days, r.of, r.spreadMinutes, today, r.on.at(-1) ?? null, old.id);
			} else {
				this.d.db
					.prepare(
						`INSERT INTO self_regularities (id, subject, start_minute, end_minute, days, of_days, spread_minutes, first_found, last_found, last_on)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						this.d.newId(),
						subject,
						r.startMinute,
						r.endMinute,
						r.days,
						r.of,
						r.spreadMinutes,
						today,
						today,
						r.on.at(-1) ?? null,
					);
				this.d.log.info("self: a regularity", { subject, days: r.days });
			}
		}
	}

	/** The regularities still in force: found within the last `lapseDays`. */
	inForce(now: Date): RegularityRow[] {
		const since = localParts(new Date(now.getTime() - this.d.lapseDays * DAY), this.d.timezone).day;
		return this.d.db
			.prepare("SELECT * FROM self_regularities WHERE last_found >= ? ORDER BY first_found, subject")
			.all(since) as RegularityRow[];
	}

	/** Whether `now` falls in a regularity's usual hours: from an hour before its usual start to two after its usual end. */
	private within(r: RegularityRow, now: Date): boolean {
		const minute = localParts(now, this.d.timezone).minute;
		const from = r.start_minute - 60;
		const length = (r.end_minute === null ? 8 * 60 : (r.end_minute - r.start_minute + 1440) % 1440) + 60 + 120;
		return (minute - from + 2 * 1440) % 1440 <= Math.min(length, 1439);
	}

	/**
	 * Whether what is happening to `subject` now is its answered regularity ("network", "service:<name>",
	 * "peer:<name>", "host"): then it is not a finding or a notice of its own.
	 */
	usual(subject: string, now: Date = this.d.now()): boolean {
		return this.inForce(now).some((r) => r.subject === subject && r.answer !== null && this.within(r, now));
	}

	/** The question about a candidate, for the motivation actor; null when it is answered or gone. */
	question(id: string): string | null {
		const r = this.d.db.prepare("SELECT * FROM self_regularities WHERE id = ?").get(id) as RegularityRow | undefined;
		if (!r || r.answer !== null) return null;
		const ref = r.id.slice(0, 6);
		return `Something I noticed about my days: ${describe(r)}. Is that intended? Answer here in the web chat with /self expected ${ref} (then I stop reporting it) or /self unexpected ${ref} (then I keep it as one open problem, not a notice every time).`;
	}

	// ---------------------------------------------------------------- forecasts and reasons

	/** Free disk on the filesystem that holds the home folder: how fast it changes, and when it would be gone. */
	diskForecast(now: Date): { gbPerDay: number; daysLeft: number | null; freeGb: number } | null {
		const field = (
			this.d.db
				.prepare(
					"SELECT field FROM self_readings WHERE facet = 'storage' AND field LIKE 'free:%' AND machine = ? ORDER BY at DESC LIMIT 20",
				)
				.all(this.machine) as { field: string }[]
		)
			.map((r) => r.field)
			.find((f) => f.slice("free:".length).split(", ").includes("home"));
		if (!field) return null;
		const readings = hourly(this.d.db, "storage", field, this.machine, new Date(now.getTime() - 14 * DAY)).map(
			(r) => ({
				at: new Date(`${r.hour}:00:00Z`),
				value: r.mean,
			}),
		);
		// Less than three days of readings is no trend.
		if (readings.length < 3 || readings.at(-1)!.at.getTime() - readings[0]!.at.getTime() < 3 * DAY) return null;
		const t = trend(readings, now);
		if (!t) return null;
		return {
			gbPerDay: Math.round(t.perDay * 10) / 10,
			daysLeft: daysUntil(readings, now, 0),
			freeGb: readings.at(-1)!.value,
		};
	}

	private nights(now: Date): NightRow[] {
		return recentNights(this.d.db, 30).filter((n) => Date.parse(n.slept_at) >= now.getTime() - 7 * DAY);
	}

	/**
	 * Reasons from what is normal, for the motivation tracker. New kinds: `self_surprise`, `regularity_unconfirmed`,
	 * `problem_pattern`, `expected_missing`, `disk_filling`, `nights_outside_window`, `nights_too_long`, `not_running`.
	 */
	signals(now: Date = this.d.now()): Reason[] {
		const out: Reason[] = [];
		for (const s of this.openSurprises()) {
			const level = LEVELS.find((l) => l.facet === s.facet && l.field === s.field);
			if (!level) continue;
			out.push({
				motivation: "curiosity",
				kind: "self_surprise",
				cluster: `surprise:${s.id}`,
				evidence: [`self_surprises:${s.id}`],
				weight: 0.6,
				text: `${level.name} has been unusual since ${this.local(s.started_at)}: ${round(s.peak)} ${level.unit}, usually about ${round(s.usual)} at that hour`.replace(
					"  ",
					" ",
				),
			});
		}
		for (const r of this.inForce(now)) {
			if (r.answer === null)
				out.push({
					motivation: "curiosity",
					kind: "regularity_unconfirmed",
					cluster: `regularity:${r.id}`,
					evidence: [`self_regularities:${r.id}`],
					weight: 0.6,
					text: `${describe(r)}; the owner has not said whether that is intended`,
				});
			else if (r.answer === "problem")
				out.push({
					motivation: "self_preservation",
					kind: "problem_pattern",
					cluster: `pattern:${r.id}`,
					evidence: [`self_regularities:${r.id}`],
					weight: 0.6,
					text: `${describe(r)}, and the owner said that is not intended`,
				});
			else if (this.missed(r, now))
				out.push({
					motivation: "curiosity",
					kind: "expected_missing",
					cluster: `missing:${r.id}@${localParts(now, this.d.timezone).day}`,
					evidence: [`self_regularities:${r.id}`],
					weight: 0.4,
					text: `usually ${describe(r)}; this time it did not happen`,
				});
		}
		const disk = this.diskForecast(now);
		if (disk && disk.daysLeft !== null && disk.daysLeft < 30)
			out.push({
				motivation: "self_preservation",
				kind: "disk_filling",
				cluster: "disk-forecast",
				evidence: ["self_readings:storage"],
				weight: disk.daysLeft < 7 ? 0.8 : 0.6,
				text: `free disk falls by ${Math.abs(disk.gbPerDay)} GB a day: about ${Math.round(disk.daysLeft)} days until it is full (${round(disk.freeGb)} GB free)`,
			});
		const nights = this.nights(now);
		const outside = nights.filter((n) => n.in_window === 0);
		if (nights.length >= 3 && outside.length * 2 > nights.length)
			out.push({
				motivation: "self_preservation",
				kind: "nights_outside_window",
				cluster: "nights-outside-window",
				evidence: nights.slice(0, 5).map((n) => `nights:${n.slept_at}`),
				weight: 0.6,
				text: `${outside.length} of the last ${nights.length} nights ran outside the rest window`,
			});
		const done = nights.filter((n) => n.completed === 1 && n.woke_at).slice(0, 5);
		const long = done.filter((n) => Date.parse(n.woke_at!) - Date.parse(n.slept_at) > this.d.restWindowMinutes * MIN);
		if (done.length >= 3 && long.length >= 3)
			out.push({
				motivation: "self_preservation",
				kind: "nights_too_long",
				cluster: "nights-too-long",
				evidence: long.map((n) => `nights:${n.slept_at}`),
				weight: 0.6,
				text: `${long.length} of the last ${done.length} nights took longer than the rest window (${Math.round(this.d.restWindowMinutes / 60)} h)`,
			});
		const gap = this.d.self.value<number>("lifecycle", "notRunningHoursBefore");
		const started = this.d.self.value<string>("lifecycle", "startedAt");
		if (
			gap !== null &&
			gap >= 1 &&
			started &&
			this.d.self.value<string>("lifecycle", "previousRunEnded") === "without a shutdown" &&
			!this.usual("host", new Date(started))
		)
			out.push({
				motivation: "self_preservation",
				kind: "not_running",
				cluster: `run:${started}`,
				evidence: ["host_runs"],
				weight: 0.6,
				observedAt: started,
				text: `I was not running for ${gap} h before ${this.local(started)}, and the run before ended without a shutdown`,
			});
		return out;
	}

	/** An expected regularity whose latest usual start has passed by three hours with no occurrence that day. */
	private missed(r: RegularityRow, now: Date): boolean {
		const p = localParts(now, this.d.timezone);
		const sinceStart = (p.minute - r.start_minute + 1440) % 1440;
		if (sinceStart < 180) return false; // too early to say
		// The local day its latest usual start fell on.
		const day = localParts(new Date(now.getTime() - sinceStart * MIN), this.d.timezone).day;
		return r.last_on !== null && r.last_on < day && !this.occurredOn(r.subject, day, now);
	}

	private occurredOn(subject: string, day: string, now: Date): boolean {
		return (this.spans(now).get(subject) ?? []).some(
			(s) =>
				localParts(s.start, this.d.timezone).day === day ||
				localParts(new Date(s.start.getTime() - 3 * HOUR), this.d.timezone).day === day,
		);
	}

	// ---------------------------------------------------------------- owner views

	private local(iso: string): string {
		return new Date(iso).toLocaleString("sv-SE", { timeZone: this.d.timezone }).slice(0, 16);
	}

	private answer(ref: string | undefined, answer: "expected" | "problem", by: string): string {
		if (!ref || !/^[0-9a-f-]{3,36}$/.test(ref))
			return `usage: /self ${answer === "expected" ? "expected" : "unexpected"} <id> (see /self normal)`;
		const rows = this.d.db
			.prepare("SELECT * FROM self_regularities WHERE id LIKE ?")
			.all(`${ref}%`) as RegularityRow[];
		if (rows.length !== 1)
			return rows.length ? `${ref} matches ${rows.length} regularities` : `no regularity ${ref} (see /self normal)`;
		const r = rows[0]!;
		this.d.db
			.prepare("UPDATE self_regularities SET answer = ?, answered_at = ?, answered_by = ? WHERE id = ?")
			.run(answer, this.d.now().toISOString(), by, r.id);
		return answer === "expected"
			? `noted: ${describe(r)} is expected. I will not report it in those hours any more; if it happens at another time of day, I still will.`
			: `noted: ${describe(r)} is not intended. I keep it as one open problem and will not send a notice each time.`;
	}

	/** `/self normal`: the bands, what is unusual now, the regularities and the forecasts. */
	report(): string {
		const now = this.d.now();
		const cores = this.d.self.value<number>("compute", "cores") ?? 1;
		const lines = [
			`what is normal (the usual band of each hour of the day over ${this.d.baselineDays} days; unusual: ${this.d.k} spreads off for ${this.d.runs} readings, and past the field's floor):`,
		];
		for (const level of LEVELS) {
			const latest = this.d.db
				.prepare(
					"SELECT value FROM self_readings WHERE facet = ? AND field = ? AND machine = ? ORDER BY at DESC LIMIT 1",
				)
				.get(level.facet, level.field, this.machine) as { value: number } | undefined;
			if (!latest) continue;
			const band = this.band(level, now);
			lines.push(
				`  ${level.name} — now ${round(latest.value)} ${level.unit}`.trimEnd() +
					(band
						? `, usually ${round(band.median)} ± ${round(band.spread)} at this hour`
						: `, no baseline yet (${this.d.minDays} days of this hour are needed)`) +
					`; counts only ${level.floorText}${level.floor(latest.value, cores) ? " (it is, now)" : ""}`,
			);
		}
		if (lines.length === 1) lines.push("  no readings yet");
		const open = this.openSurprises();
		lines.push(open.length ? "unusual now:" : "unusual now: nothing");
		for (const s of open) {
			const level = LEVELS.find((l) => l.facet === s.facet && l.field === s.field);
			lines.push(
				`  ${level?.name ?? `${s.facet}.${s.field}`} since ${this.local(s.started_at)}: ${round(s.peak)}, usually about ${round(s.usual)}`,
			);
		}
		const regular = this.inForce(now);
		lines.push(
			regular.length
				? "regularities (5 of 14 days, starting within 90 minutes of the day):"
				: "regularities: none found",
		);
		for (const r of regular) {
			const ref = r.id.slice(0, 6);
			lines.push(
				`  ${ref}  ${describe(r)} — ${
					r.answer === "expected"
						? "expected (you said so)"
						: r.answer === "problem"
							? "not intended (you said so): one open problem"
							: `not answered: /self expected ${ref} · /self unexpected ${ref}`
				}`,
			);
		}
		const disk = this.diskForecast(now);
		lines.push(
			disk
				? `forecast: free disk ${disk.gbPerDay >= 0 ? "grows" : "falls"} by ${Math.abs(disk.gbPerDay)} GB a day${disk.daysLeft === null ? "" : `, about ${Math.round(disk.daysLeft)} days until it is full`}`
				: "forecast: free disk has less than three days of readings",
		);
		return lines.join("\n");
	}

	/** `/self normal | expected <id> | unexpected <id>`; null when the words are not these. */
	command(args: string[], by = "owner"): string | null {
		switch (args[0]) {
			case "normal":
				return this.report();
			case "expected":
				return this.answer(args[1], "expected", by);
			case "unexpected":
				return this.answer(args[1], "problem", by);
			default:
				return null;
		}
	}

	/** Lines for the owner's about-me note: what is unusual now, and what is expected. */
	aboutLines(): string[] {
		const now = this.d.now();
		const lines: string[] = [];
		const open = this.openSurprises();
		if (open.length)
			lines.push(
				`- Unusual now: ${open
					.map((s) => {
						const level = LEVELS.find((l) => l.facet === s.facet && l.field === s.field);
						return `${level?.name ?? s.field} ${round(s.peak)} ${level?.unit ?? ""} (usually about ${round(s.usual)}), since ${this.local(s.started_at)}`.replace(
							"  ",
							" ",
						);
					})
					.join("; ")}.`,
			);
		const answered = this.inForce(now).filter((r) => r.answer !== null);
		if (answered.length)
			lines.push(
				`- Usual for you: ${answered.map((r) => `${describe(r)} — ${r.answer === "expected" ? "your owner said that is intended" : "your owner said that is not intended"}`).join("; ")}.`,
			);
		return lines;
	}
}

function round(x: number): number {
	return Math.round(x * 10) / 10;
}
