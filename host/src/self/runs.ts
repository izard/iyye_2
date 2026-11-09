// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * When Iyye was running and when it slept (plan 0.018 W1, the lifecycle and
 * rhythm facets). W0 found the host had ended with the owner's SSH session
 * every night for a month, that no night had run in its rest window, and
 * that no record said so.
 *
 * - `host_runs`: a row per start, a heartbeat, and `ended` only on a
 *   shutdown. At the next start, a row without it is a run that was killed.
 * - `nights`: a row per sleep, from the rhythm's own records.
 * - What the host runs under is told from its parents' program names (never
 *   their command lines) and the service manager's own mark.
 */

import type { Db } from "../state/db.ts";
import type { Exec } from "./probes.ts";

export interface Under {
	/** In words, for the owner: "tmux", "an SSH session", "a service manager", "a terminal", "unknown". */
	kind: string;
	/** Whether the host ends when its login does. */
	endsWithLogin: boolean;
	/** Program names of the parents, nearest first. */
	parents: string[];
}

/** What a chain of parents means. `service`: the service manager started this process itself. */
export function classifyUnder(parents: readonly string[], o: { service: boolean; terminal: boolean }): Under {
	const names = parents.map((p) => p.toLowerCase());
	const has = (re: RegExp) => names.some((n) => re.test(n));
	const base = { parents: [...parents] };
	if (o.service) return { kind: "a service manager", endsWithLogin: false, ...base };
	if (has(/^(tmux|screen|zellij)/))
		return {
			kind: names.find((n) => /^(tmux|screen|zellij)/.test(n))!.split(/[:\s]/)[0]!,
			endsWithLogin: false,
			...base,
		};
	if (has(/^sshd/)) return { kind: "an SSH session", endsWithLogin: true, ...base };
	if (o.terminal) return { kind: "a terminal", endsWithLogin: true, ...base };
	return { kind: "unknown", endsWithLogin: false, ...base };
}

/** The host's parents by program name (`ps -o ppid=,comm=`), up to eight levels. */
export async function probeUnder(
	exec: Exec,
	o: { ppid: number; env: NodeJS.ProcessEnv; terminal: boolean },
): Promise<Under> {
	const parents: string[] = [];
	let pid = o.ppid;
	for (let i = 0; i < 8 && pid > 1; i++) {
		const out = await exec("ps", ["-o", "ppid=,comm=", "-p", String(pid)]).catch(() => "");
		const m = /^\s*(\d+)\s+(.*)$/.exec(out.trim());
		if (!m) break;
		// "/usr/sbin/sshd" → "sshd"; "sshd: name@pts/1" → "sshd" (the session's user and terminal are not kept).
		parents.push(m[2]!.trim().split("/").at(-1)!.replace(/:.*$/, "").slice(0, 40));
		pid = Number(m[1]);
	}
	// systemd marks what it starts; launchd names its job (a shell in a terminal has "0").
	const service = Boolean(o.env.INVOCATION_ID) || ((o.env.XPC_SERVICE_NAME ?? "0") !== "0" && parents.length <= 1);
	return classifyUnder(parents, { service, terminal: o.terminal });
}

export interface RunRow {
	id: string;
	started_at: string;
	last_seen_at: string;
	ended: "shutdown" | null;
	under: string;
	parents_json: string;
}

/** A new run begins. Returns the run before it, and how long nothing ran in between. */
export function startRun(
	db: Db,
	run: { id: string; under: Under },
	now: Date,
): { previous: RunRow | null; notRunningMs: number | null } {
	const previous =
		(db.prepare("SELECT * FROM host_runs ORDER BY started_at DESC LIMIT 1").get() as RunRow | undefined) ?? null;
	const at = now.toISOString();
	db.prepare("INSERT INTO host_runs (id, started_at, last_seen_at, under, parents_json) VALUES (?, ?, ?, ?, ?)").run(
		run.id,
		at,
		at,
		run.under.kind,
		JSON.stringify(run.under.parents),
	);
	return {
		previous,
		notRunningMs: previous ? Math.max(0, now.getTime() - Date.parse(previous.last_seen_at)) : null,
	};
}

export function heartbeat(db: Db, id: string, now: Date): void {
	db.prepare("UPDATE host_runs SET last_seen_at = ? WHERE id = ?").run(now.toISOString(), id);
}

/** A shutdown: the only way a run is marked as ended. */
export function endRun(db: Db, id: string, now: Date): void {
	db.prepare("UPDATE host_runs SET last_seen_at = ?, ended = 'shutdown' WHERE id = ?").run(now.toISOString(), id);
}

export interface RunSpan extends RunRow {
	/** How long nothing ran before this run started; null for the first. */
	notRunningMsBefore: number | null;
}

/** The latest runs, newest first, each with the gap before it. */
export function recentRuns(db: Db, limit = 10): RunSpan[] {
	const rows = db.prepare("SELECT * FROM host_runs ORDER BY started_at DESC LIMIT ?").all(limit + 1) as RunRow[];
	return rows.slice(0, limit).map((r, i) => {
		const before = rows[i + 1];
		return {
			...r,
			notRunningMsBefore: before ? Math.max(0, Date.parse(r.started_at) - Date.parse(before.last_seen_at)) : null,
		};
	});
}

// ---------------------------------------------------------------- nights

/** The rhythm's own records, as the host reads them. */
export interface RhythmState {
	mode: string;
	sleptAt: string | null;
	reason: string | null;
	/** When the last night completed. */
	lastNightAt: string | null;
	interruptedAt: string | null;
	summary: string | null;
}

export interface NightRow {
	slept_at: string;
	woke_at: string | null;
	reason: string | null;
	in_window: number;
	completed: number;
	summary: string | null;
}

/**
 * Keep `nights` in step with the rhythm (called every minute): a sleep the
 * table does not know gets a row; once Iyye is awake again the row gets its
 * end and whether the night completed. Returns true when a row changed.
 */
export function trackNight(db: Db, s: RhythmState, now: Date, inWindow: (at: Date) => boolean): boolean {
	if (!s.sleptAt) return false;
	let changed = false;
	const row = db.prepare("SELECT * FROM nights WHERE slept_at = ?").get(s.sleptAt) as NightRow | undefined;
	if (!row) {
		db.prepare("INSERT INTO nights (slept_at, reason, in_window) VALUES (?, ?, ?)").run(
			s.sleptAt,
			s.reason,
			inWindow(new Date(s.sleptAt)) ? 1 : 0,
		);
		changed = true;
	}
	if (s.mode === "awake" && !row?.woke_at) {
		const completed = s.lastNightAt !== null && s.lastNightAt >= s.sleptAt;
		const interrupted = s.interruptedAt !== null && s.interruptedAt >= s.sleptAt;
		// Known to the second when the rhythm recorded it; else this minute's tick.
		const woke = completed ? s.lastNightAt! : interrupted ? s.interruptedAt! : now.toISOString();
		db.prepare("UPDATE nights SET woke_at = ?, completed = ?, summary = ? WHERE slept_at = ?").run(
			woke,
			completed ? 1 : 0,
			completed ? s.summary : null,
			s.sleptAt,
		);
		changed = true;
	}
	return changed;
}

export function recentNights(db: Db, limit = 14): NightRow[] {
	return db.prepare("SELECT * FROM nights ORDER BY slept_at DESC LIMIT ?").all(limit) as NightRow[];
}
