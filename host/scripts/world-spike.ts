// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.018 W0: what the rules for "what is normal" (`src/self/normal.ts`)
 * and for recurring requests would have found in Iyye's own records. No
 * model, no network, nothing written to the database. Opens it read-only;
 * point it at a copy (`sqlite3 -readonly ~/.iyye2/iyye.db ".backup <copy>"`),
 * never at a live file opened for writing.
 *
 *   node scripts/world-spike.ts <db> [--tz <zone>] [--out <dir>]
 *
 * Prints figures and word stems only. With `--out`, the recurring requests'
 * own texts go to `<dir>/requests.json` (what the owner wrote: keep the
 * directory 0700).
 *
 * 1. Regularities: for every kind of event the records hold with a time (the
 *    network away, a service not fine, no awake charge, a model loaded, the
 *    owner's first message of the day), replayed day by day.
 * 2. Baselines: the numeric fields of the `machine` observations, with how
 *    many surprises each setting would have raised.
 * 3. Forecasts: free disk, and the length of the nights.
 * 4. Recurring requests: the owner's turns that repeat across days and were
 *    answered with read-only tools.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { contentStems } from "../src/facts/disclosure.ts";
import {
	daysUntil,
	findRegularity,
	hhmm,
	localParts,
	type Reading,
	type Regularity,
	type Span,
	surpriseEpisodes,
	trend,
} from "../src/self/normal.ts";

const args = process.argv.slice(2);
const path = args[0];
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!path || path.startsWith("--")) {
	console.error("usage: node scripts/world-spike.ts <db> [--tz <zone>] [--out <dir>]");
	process.exit(2);
}
const TZ = opt("--tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const OUT = opt("--out");
const db = new Database(path, { readonly: true, fileMustExist: true });
const DAY = 86_400_000;
const all = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
const say = (title: string, o: unknown) => console.log(`${title} ${JSON.stringify(o)}`);

const first = all<{ at: string }>("SELECT min(at) AS at FROM observations")[0]!.at;
const last = all<{ at: string }>("SELECT max(at) AS at FROM energy_ledger")[0]!.at;
const START = new Date(first);
const END = new Date(last);
say("period", { from: first.slice(0, 10), to: last.slice(0, 10), days: Math.round((+END - +START) / DAY), tz: TZ });

// ---------------------------------------------------------------- 1. regularities

const series = new Map<string, Span[]>();

// The network away: the self model's interface going null, until it is back.
{
	const rows = all<{ at: string; v: string }>(
		"SELECT at, new_json AS v FROM self_changes WHERE facet = 'network' AND field = 'interface' ORDER BY at",
	);
	const spans: Span[] = [];
	let open: Span | null = null;
	for (const r of rows) {
		if (r.v === "null" && !open) {
			open = { start: new Date(r.at), end: null };
			spans.push(open);
		} else if (r.v !== "null" && open) {
			open.end = new Date(r.at);
			open = null;
		}
	}
	series.set("the network away", spans);
}

// Each service not fine, from the machine observations (every 2 h: starts are known to 2 h only).
const OK = new Set(["up", "connected", "disabled", "not installed", "starting", "restarting"]);
const machine = all<{ at: string; result_json: string }>(
	"SELECT at, result_json FROM observations WHERE domain = 'machine' ORDER BY at",
).map((r) => ({ at: new Date(r.at), r: JSON.parse(r.result_json) as Record<string, unknown> }));
{
	const open = new Map<string, Span>();
	for (const m of machine) {
		for (const [name, state] of Object.entries((m.r.services ?? {}) as Record<string, string>)) {
			const key = `${name} not fine (2 h probe)`;
			if (!OK.has(state) && !open.has(name)) {
				const s: Span = { start: m.at, end: null };
				open.set(name, s);
				series.set(key, [...(series.get(key) ?? []), s]);
			} else if (OK.has(state) && open.has(name)) {
				open.get(name)!.end = m.at;
				open.delete(name);
			} else if (!series.has(key)) series.set(key, []);
		}
	}
}

// No awake charge: gaps in the time-awake charges (asleep, or the host not running).
const awake = all<{ at: string }>("SELECT at FROM energy_ledger WHERE kind = 'awake' ORDER BY at").map(
	(r) => new Date(r.at),
);
const gaps: Span[] = [];
{
	const steps = awake.slice(1).map((t, i) => +t - +awake[i]!);
	const usual = [...steps].sort((a, b) => a - b)[steps.length >> 1] ?? 600_000;
	for (const [i, d] of steps.entries())
		if (d > 3 * usual + 60_000) gaps.push({ start: awake[i]!, end: awake[i + 1]! });
	say("awake charges", { n: awake.length, usualStepMin: Math.round(usual / 60_000), gaps: gaps.length });
}
series.set(
	"no awake charge for over 1 h (asleep, or not running)",
	gaps.filter((g) => +g.end! - +g.start > 3_600_000),
);
// Completed nights by the local hour they ended at, for each machine Iyye ran on.
{
	const moved = all<{ at: string }>(
		"SELECT at FROM self_changes WHERE facet = 'hardware' AND field = 'machine' AND old_json IS NOT NULL ORDER BY at",
	).map((r) => r.at);
	const nights = all<{ at: string }>("SELECT at FROM energy_ledger WHERE kind = 'refill_night' ORDER BY at");
	const eras = [first, ...moved, "9999"];
	for (let i = 0; i + 1 < eras.length; i++) {
		const mine = nights.filter((n) => n.at >= eras[i]! && n.at < eras[i + 1]!);
		const hours = mine.map((n) => localParts(new Date(n.at), TZ).hour);
		say(`nights completed on machine ${i + 1} (since ${eras[i]!.slice(0, 10)})`, {
			n: mine.length,
			endedBetween01and07: hours.filter((h) => h >= 1 && h < 7).length,
			endedByDay07to20: hours.filter((h) => h >= 7 && h < 20).length,
			endedInTheEvening: hours.filter((h) => h >= 20 || h < 1).length,
		});
	}
}

// Models loaded and unloaded, by model and by who asked: the night, waking, a start and healing are Iyye's own
// doing, not something to learn about the world.
for (const r of all<{ op: string; model_name: string | null; started_at: string; requested_by: string }>(
	"SELECT op, model_name, started_at, requested_by FROM model_ops WHERE op IN ('load', 'unload') AND model_name IS NOT NULL ORDER BY started_at",
)) {
	const own = ["night", "waking", "system", "heal"].includes(r.requested_by);
	const key = `${r.op} ${r.model_name} (${own ? `Iyye's own: ${r.requested_by}` : `asked by ${r.requested_by}`})`;
	series.set(key, [...(series.get(key) ?? []), { start: new Date(r.started_at), end: null }]);
}

// The owner's first message of the local day (a day starts at 04:00), and all the owner's messages.
const ownerEvents = all<{ at: string; channel: string }>(
	"SELECT received_at AS at, channel FROM events WHERE scope = 'owner' AND status != 'dropped' ORDER BY received_at",
).map((r) => ({ at: new Date(r.at), channel: r.channel }));
{
	const firstOf = new Map<string, Date>();
	for (const e of ownerEvents) {
		const day = localParts(new Date(+e.at - 4 * 3_600_000), TZ).day;
		if (!firstOf.has(day)) firstOf.set(day, e.at);
	}
	series.set(
		"the owner's first message of the day",
		[...firstOf.values()].map((start) => ({ start, end: null })),
	);
}

// Turns that failed.
series.set(
	"a turn failed",
	all<{ at: string }>(
		"SELECT settled_at AS at FROM jobs WHERE status = 'failed' AND settled_at IS NOT NULL ORDER BY 1",
	).map((r) => ({ start: new Date(r.at), end: null })),
);

/** Replay: the rule at noon of every day once 14 days of records exist. */
function replay(spans: Span[], o: { minDays: number; widthMinutes: number }) {
	let firstFound: string | null = null;
	let held = 0;
	let evaluated = 0;
	let latest: Regularity | null = null;
	for (let t = +START + 14 * DAY; t <= +END + DAY; t += DAY) {
		const now = new Date(Math.min(t, +END));
		evaluated++;
		latest = findRegularity(spans, now, { timeZone: TZ, ...o });
		if (latest) {
			held++;
			firstFound ??= localParts(now, TZ).day;
		}
	}
	return { firstFound, held, evaluated, latest };
}

console.log("\n# 1. regularities (5 of 14 days, within 90 minutes)");
for (const [name, spans] of series) {
	const r = replay(spans, { minDays: 5, widthMinutes: 90 });
	say(name, {
		events: spans.length,
		firstFound: r.firstFound,
		heldOnDays: `${r.held}/${r.evaluated}`,
		now: r.latest && {
			start: hhmm(r.latest.startMinute),
			end: r.latest.endMinute === null ? null : hhmm(r.latest.endMinute),
			days: `${r.latest.days}/${r.latest.of}`,
			spreadMin: r.latest.spreadMinutes,
		},
	});
}
console.log("\n# 1b. how many series give a regularity at some point, by setting");
for (const minDays of [4, 5, 7])
	for (const widthMinutes of [60, 90, 120]) {
		const found = [...series].filter(([, s]) => replay(s, { minDays, widthMinutes }).held > 0).map(([n]) => n);
		say(`minDays ${minDays} width ${widthMinutes}`, { n: found.length, of: series.size, found });
	}

// The owner's hours.
{
	const hours = new Array<number>(24).fill(0);
	for (const e of ownerEvents) hours[localParts(e.at, TZ).hour]!++;
	const total = hours.reduce((a, b) => a + b, 0);
	const quiet = hours.flatMap((n, h) => (n / total < 0.01 ? [h] : []));
	say("the owner's messages by local hour", { total, hours, hoursUnder1pct: quiet });
}

// ---------------------------------------------------------------- 2. baselines

console.log("\n# 2. baselines of the machine observations (surprises on the low side)");
const field = (k: string): Reading[] =>
	machine.flatMap((m) => (typeof m.r[k] === "number" ? [{ at: m.at, value: m.r[k] as number }] : []));
const FIELDS: { name: string; minSpread: number; floor: (v: number) => boolean; floorText: string }[] = [
	{ name: "memAvailableGb", minSpread: 2, floor: (v) => v < 16, floorText: "< 16 GB" },
	{ name: "diskFreeGb", minSpread: 5, floor: (v) => v < 200, floorText: "< 200 GB" },
];
for (const f of FIELDS) {
	// One machine at a time: a reading from the Mac is no baseline for the Spark.
	const readings = field(f.name);
	const values = readings.map((r) => r.value).sort((a, b) => a - b);
	say(f.name, { n: readings.length, min: values[0], median: values[values.length >> 1], max: values.at(-1) });
	for (const withFloor of [false, true])
		for (const k of [3, 4, 6])
			for (const runs of [1, 2, 3]) {
				const eps = surpriseEpisodes(readings, {
					timeZone: TZ,
					minSpread: f.minSpread,
					side: "low",
					k,
					runs,
					...(withFloor ? { floor: f.floor } : {}),
				});
				say(`  k ${k} runs ${runs} floor ${withFloor ? f.floorText : "none"}`, {
					episodes: eps.length,
					...(eps.length && eps.length <= 6
						? { at: eps.map((e) => `${localParts(e.start, TZ).day} ${e.peak} (usual ${e.usual})`) }
						: {}),
				});
			}
}

// ---------------------------------------------------------------- 3. forecasts

console.log("\n# 3. forecasts");
{
	const disk = field("diskFreeGb");
	// The disk changed when Iyye moved machines: only readings of the latest disk size.
	const size = machine.at(-1)?.r.diskTotalGb;
	const same = machine.flatMap((m) =>
		m.r.diskTotalGb === size && typeof m.r.diskFreeGb === "number"
			? [{ at: m.at, value: m.r.diskFreeGb as number }]
			: [],
	);
	const t = trend(
		same.filter((r) => +r.at >= +END - 14 * DAY),
		END,
	);
	say("free disk", {
		readings: disk.length,
		onThisDisk: same.length,
		gbPerDay: t && Math.round(t.perDay * 10) / 10,
		daysUntilFull: (() => {
			const d = daysUntil(same, END, 0);
			return d === null ? null : Math.round(d);
		})(),
	});
	const nights = gaps
		.filter((g) => +g.end! - +g.start > 3_600_000)
		.map((g) => ({ at: g.start, value: (+g.end! - +g.start) / 3_600_000 }));
	const nt = trend(
		nights.filter((r) => +r.at >= +END - 14 * DAY),
		END,
	);
	const lens = nights.map((n) => n.value).sort((a, b) => a - b);
	say("stretches not awake (h)", {
		n: nights.length,
		median: lens.length ? Math.round(lens[lens.length >> 1]! * 10) / 10 : null,
		max: lens.length ? Math.round(lens.at(-1)! * 10) / 10 : null,
		hoursPerDayTrend: nt && Math.round(nt.perDay * 100) / 100,
	});
}

// ---------------------------------------------------------------- 4. recurring requests

console.log("\n# 4. recurring requests (the owner's turns)");
/** Toolkits whose tools only read (plan 0.004): a request answered with these alone could be a routine. */
const READ_ONLY = new Set(["core", "machine", "monitor", "web", "project", "vision"]);
interface Turn {
	id: string;
	text: string;
	at: Date;
	channel: string;
	stems: string[];
	tools: string[];
	effects: boolean;
}
const tools = new Map<string, { tool: string; toolkit: string }[]>();
for (const t of all<{ event_id: string | null; tool: string; toolkit: string | null }>(
	"SELECT event_id, tool, toolkit FROM tool_calls WHERE event_id IS NOT NULL",
))
	tools.set(t.event_id!, [...(tools.get(t.event_id!) ?? []), { tool: t.tool, toolkit: t.toolkit ?? "?" }]);
const turns: Turn[] = all<{ event_id: string; user_text: string; said_at: string; channel: string }>(
	"SELECT event_id, user_text, said_at, channel FROM stm_episodes WHERE scope = 'owner' AND kind = 'turn' AND user_text IS NOT NULL ORDER BY said_at",
).map((r) => {
	const used = tools.get(r.event_id) ?? [];
	return {
		id: r.event_id,
		text: r.user_text,
		at: new Date(r.said_at),
		channel: r.channel,
		stems: contentStems(r.user_text),
		tools: [...new Set(used.map((u) => u.tool))],
		effects: used.some((u) => !READ_ONLY.has(u.toolkit)),
	};
});
const shared = (a: string[], b: string[]) => {
	const other = new Set(b);
	return a.filter((s) => other.has(s)).length;
};
/** The recurring-question detector's match: at least two shared content words, half of the shorter one's. */
const alike = (a: Turn, b: Turn) =>
	shared(a.stems, b.stems) >= Math.max(2, Math.ceil(Math.min(a.stems.length, b.stems.length) / 2));

/** Requests that repeat: groups of turns linked by likeness (a chain of alike turns is one request). */
function clusters(now: Date, o: { windowDays: number; minDays: number; needTools: boolean }) {
	const recent = turns.filter(
		(t) =>
			+t.at > +now - o.windowDays * DAY &&
			+t.at <= +now &&
			t.stems.length >= 2 &&
			// Answered with read-only tools: a turn that changed something, or needed no tool, is no routine.
			(!o.needTools || (t.tools.length > 0 && !t.effects)),
	);
	const group = new Map<Turn, Turn[]>();
	for (const t of recent) {
		const linked = [...new Set(recent.filter((x) => group.has(x) && alike(x, t)).map((x) => group.get(x)!))];
		const merged = [...linked.flat(), t];
		for (const m of merged) group.set(m, merged);
	}
	return [...new Set(group.values())]
		.map((members) => ({ members, days: new Set(members.map((t) => localParts(t.at, TZ).day)).size }))
		.filter((c) => c.days >= o.minDays);
}

say("owner turns", {
	n: turns.length,
	withTools: turns.filter((t) => t.tools.length).length,
	readOnlyOnly: turns.filter((t) => t.tools.length && !t.effects).length,
});
for (const needTools of [false, true])
	for (const minDays of [3, 4, 5]) {
		// Replay day by day; a cluster is known by its earliest member.
		const seen = new Map<string, { firstFound: string; last: { members: Turn[]; days: number } }>();
		for (let t = +START + 14 * DAY; t <= +END + DAY; t += DAY) {
			const now = new Date(Math.min(t, +END));
			for (const c of clusters(now, { windowDays: 14, minDays, needTools })) {
				// The same request on a later day is the same cluster when it is alike to an earlier one's seed.
				const ids = new Set(c.members.map((m) => m.id));
				const key = [...seen].find(([, v]) => v.last.members.some((m) => ids.has(m.id)))?.[0] ?? c.members[0]!.id;
				seen.set(key, { firstFound: seen.get(key)?.firstFound ?? localParts(now, TZ).day, last: c });
			}
		}
		say(`minDays ${minDays}, ${needTools ? "answered with read-only tools" : "any turn"}`, { clusters: seen.size });
		if (minDays !== 4) continue;
		const detail = [...seen.values()].map((s) => {
			const m = s.last.members;
			const firstByDay = new Map<string, Turn>();
			for (const t of m) if (!firstByDay.has(localParts(t.at, TZ).day)) firstByDay.set(localParts(t.at, TZ).day, t);
			const minutes = [...firstByDay.values()].map((t) => localParts(t.at, TZ).minute).sort((a, b) => a - b);
			const count = new Map<string, number>();
			for (const t of m) for (const st of t.stems) count.set(st, (count.get(st) ?? 0) + 1);
			return {
				firstFound: s.firstFound,
				turns: m.length,
				days: s.last.days,
				usualTime: hhmm(minutes[minutes.length >> 1]!),
				earliest: hhmm(minutes[0]!),
				latest: hhmm(minutes.at(-1)!),
				channels: [...new Set(m.map((t) => t.channel))],
				tools: [...new Set(m.flatMap((t) => t.tools))],
				commonStems: [...count]
					.filter(([, n]) => n >= m.length / 2)
					.map(([st]) => st)
					.slice(0, 6),
				texts: m.map((t) => ({ at: t.at.toISOString(), text: t.text })),
			};
		});
		for (const d of detail) say("  cluster", { ...d, texts: undefined });
		if (OUT && needTools) {
			mkdirSync(OUT, { recursive: true, mode: 0o700 });
			writeFileSync(join(OUT, "requests.json"), JSON.stringify(detail, null, 2), { mode: 0o600 });
			console.log(`  texts written to ${join(OUT, "requests.json")}`);
		}
	}
