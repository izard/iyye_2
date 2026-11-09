// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps the self model's body current (plan 0.018 W1): how the machine is
 * doing, what uses its memory and disk, when the host was running and when
 * Iyye slept. Observe and record only: nothing here notifies, asks or opens
 * work (baselines, regularities and their signals are W3).
 *
 * | Facet     | What                                                    | When                 |
 * | --------- | ------------------------------------------------------- | -------------------- |
 * | lifecycle | this run's start, what it runs under, the gap before it | at start; a heartbeat every minute |
 * | compute   | load, pressure, GPU, the hottest sensor                 | every 10 min, asleep too |
 * | memory    | available, swap, each of Iyye's own processes by role   | every 10 min, asleep too |
 * | storage   | the filesystems Iyye lives on; its directories' sizes   | hourly; sizes daily  |
 * | devices   | displays, cameras, audio: present or not                | daily, awake         |
 * | models    | each model's file size, load time, memory when loaded   | daily, and when seen loaded |
 * | rhythm    | each night: start, end, in the rest window, completed   | when a night changes |
 *
 * - **Asleep too** (owner decision 1): the vitals are cheap and use no model.
 *   Asleep they only write rows.
 * - **History:** every numeric field is also a row in `self_readings`
 *   (`readings.ts`), keyed by the machine.
 * - **One source of truth:** the `machine` observation and `system_status`
 *   read `current()`; they no longer probe on their own.
 */

import { statSync } from "node:fs";
import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import type { SelfModel } from "./model.ts";
import { type Exec, execAsync, type ListDir, listSysDir, type ReadFile, readSysFile } from "./probes.ts";
import { foldReadings, hourly, machineKey, readingFields, recordReadings } from "./readings.ts";
import {
	endRun,
	heartbeat,
	probeUnder,
	type RhythmState,
	recentNights,
	recentRuns,
	startRun,
	trackNight,
} from "./runs.ts";
import {
	type Compute,
	type DirSize,
	type Filesystem,
	type Memory,
	type ProcessRoot,
	type ProcessUse,
	probeCompute,
	probeDevices,
	probeDirSizes,
	probeFilesystems,
	probeMemory,
	type VitalsDeps,
} from "./vitals.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface UpkeepDeps {
	db: Db;
	log: Logger;
	self: Pick<SelfModel, "setFacet" | "value">;
	/** The processes the host started, by role (read each time: PIDs change with restarts). */
	processes: () => ProcessRoot[];
	/** What Iyye keeps where: name → path, for the filesystems ("home", "state", "models"). */
	paths: Record<string, string>;
	/** Iyye's own directories whose sizes are measured daily: name → path. */
	dirs: () => Record<string, string>;
	/** The registry's models: name and file path. */
	models: () => { name: string; path: string | null }[];
	/** The rhythm's own records; null where there is no rhythm (tests). */
	rhythm: (() => RhythmState) | null;
	/** Whether a moment falls in the rest window. */
	inRestWindow: (at: Date) => boolean;
	/** This process: its parent, environment and whether its output is a terminal; null switches the lifecycle off. */
	process: { ppid: number; env: NodeJS.ProcessEnv; terminal: boolean } | null;
	mode: () => "awake" | "winding_down" | "asleep";
	vitalsMs?: number;
	tickMs?: number;
	exec?: Exec;
	readFile?: ReadFile;
	listDir?: ListDir;
	platform?: NodeJS.Platform;
	now?: () => Date;
	newId?: () => string;
	timezone?: string;
}

/** Disk and memory as the machine observation and `system_status` report them. */
export interface CurrentVitals {
	diskFreeGb: number;
	diskTotalGb: number;
	memAvailableGb: number | null;
	swapUsedGb: number | null;
	load: [number, number, number];
}

export class SelfUpkeep {
	private readonly d: Required<UpkeepDeps>;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private runId: string | null = null;
	private lastFold = 0;
	private readonly at = new Map<string, number>();

	constructor(deps: UpkeepDeps) {
		this.d = {
			vitalsMs: 600_000,
			tickMs: 60_000,
			exec: execAsync,
			readFile: readSysFile,
			listDir: listSysDir,
			platform: process.platform,
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			...deps,
		};
	}

	start(): void {
		if (this.timer) return;
		void this.tick();
		this.timer = setInterval(() => void this.tick(), this.d.tickMs);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.running;
	}

	/** A shutdown: the run is marked as ended, so the next start knows it was not killed. */
	shutdown(): void {
		if (this.runId) endRun(this.d.db, this.runId, this.d.now());
	}

	/** One pass: the run and its heartbeat, the nights, every facet that is due. Public for tests. */
	tick(): Promise<void> {
		if (this.running) return this.running;
		this.running = this.pass()
			.catch((err) => this.d.log.warn("self: upkeep failed", { error: (err as Error).message }))
			.finally(() => {
				this.running = null;
			});
		return this.running;
	}

	private get probes(): VitalsDeps {
		return { exec: this.d.exec, readFile: this.d.readFile, listDir: this.d.listDir, platform: this.d.platform };
	}

	private get machine(): string {
		return machineKey({
			machine: this.d.self.value("hardware", "machine"),
			chip: this.d.self.value("hardware", "chip"),
			memoryGb: this.d.self.value("hardware", "memoryGb"),
		});
	}

	private due(what: string, everyMs: number, now: Date): boolean {
		const last = this.at.get(what);
		return last === undefined || now.getTime() - last >= everyMs;
	}

	private async attempt(what: string, now: Date, f: () => Promise<void>): Promise<void> {
		this.at.set(what, now.getTime()); // a failing probe is tried again at its next turn, not every minute
		try {
			await f();
		} catch (err) {
			this.d.log.warn("self: probe failed", { facet: what, error: (err as Error).message });
		}
	}

	private async pass(): Promise<void> {
		const now = this.d.now();
		if (this.d.process && !this.runId) await this.beginRun(now);
		else if (this.runId) heartbeat(this.d.db, this.runId, now);
		this.nights(now);
		if (this.due("compute", this.d.vitalsMs, now)) await this.attempt("compute", now, () => this.compute(now));
		if (this.due("memory", this.d.vitalsMs, now)) await this.attempt("memory", now, () => this.memory(now));
		if (this.due("storage", HOUR, now)) await this.attempt("storage", now, () => this.storage(now));
		if (this.due("sizes", DAY, now)) await this.attempt("sizes", now, () => this.sizes(now));
		if (this.d.mode() === "awake") {
			if (this.due("devices", DAY, now)) await this.attempt("devices", now, () => this.devices(now));
			if (this.due("models", DAY, now)) await this.attempt("models", now, async () => this.models(now));
		}
		if (now.getTime() - this.lastFold >= HOUR) {
			this.lastFold = now.getTime();
			foldReadings(this.d.db, now);
		}
	}

	// ---------------------------------------------------------------- lifecycle and rhythm

	private async beginRun(now: Date): Promise<void> {
		const under = await probeUnder(this.d.exec, this.d.process!);
		const id = this.d.newId();
		const { previous, notRunningMs } = startRun(this.d.db, { id, under }, now);
		this.runId = id;
		this.d.self.setFacet(
			"lifecycle",
			{
				startedAt: now.toISOString(),
				under: under.kind,
				endsWithLogin: under.endsWithLogin,
				previousRunEnded: previous
					? previous.ended === "shutdown"
						? "with a shutdown"
						: "without a shutdown"
					: null,
				notRunningHoursBefore: notRunningMs === null ? null : Math.round((notRunningMs / HOUR) * 10) / 10,
			},
			"probe",
			null,
			now,
		);
		this.d.log.info("self: run started", {
			under: under.kind,
			previous: previous ? (previous.ended ?? "no shutdown") : "none",
			notRunningMin: notRunningMs === null ? null : Math.round(notRunningMs / 60_000),
		});
	}

	private nights(now: Date): void {
		if (!this.d.rhythm) return;
		if (!trackNight(this.d.db, this.d.rhythm(), now, this.d.inRestWindow)) return;
		const rows = recentNights(this.d.db, 30);
		const week = rows.filter((n) => Date.parse(n.slept_at) >= now.getTime() - 7 * DAY);
		const last = rows[0];
		this.d.self.setFacet(
			"rhythm",
			{
				lastNight: last
					? {
							sleptAt: last.slept_at,
							wokeAt: last.woke_at,
							inWindow: last.in_window === 1,
							completed: last.completed === 1,
							reason: last.reason,
						}
					: null,
				nights7: week.length,
				nightsInWindow7: week.filter((n) => n.in_window === 1).length,
				nightsCompleted7: week.filter((n) => n.completed === 1).length,
			},
			"probe",
			null,
			now,
		);
	}

	// ---------------------------------------------------------------- vitals

	private async compute(now: Date): Promise<void> {
		const c = await probeCompute(this.probes);
		this.d.self.setFacet("compute", { ...c }, "probe", null, now);
		const { cores: _cores, ...numbers } = c;
		recordReadings(this.d.db, this.machine, "compute", numbers, now);
	}

	private async memory(now: Date): Promise<void> {
		const m = await probeMemory(this.probes, this.d.processes());
		this.d.self.setFacet("memory", { ...m }, "probe", null, now);
		const sum = (f: (p: ProcessUse) => number | null) =>
			Math.round(m.processes.reduce((a, p) => a + (f(p) ?? 0), 0) * 10) / 10;
		recordReadings(
			this.d.db,
			this.machine,
			"memory",
			{
				availableGb: m.availableGb,
				swapUsedGb: m.swapUsedGb,
				iyyeResidentGb: sum((p) => p.residentGb),
				iyyeGpuGb: m.processes.some((p) => p.gpuGb !== null) ? sum((p) => p.gpuGb) : null,
				...Object.fromEntries(m.processes.map((p) => [`resident:${p.role}`, p.residentGb])),
				...Object.fromEntries(m.processes.map((p) => [`gpu:${p.role}`, p.gpuGb])),
			},
			now,
		);
		// A model seen loaded: what it holds now is what it takes (kept with the models facet).
		for (const p of m.processes.filter((x) => x.role.startsWith("model ")))
			this.mergeModel(p.role.slice("model ".length), { residentGb: p.residentGb, gpuGb: p.gpuGb }, now);
	}

	private async storage(now: Date): Promise<void> {
		const filesystems = probeFilesystems(this.d.paths);
		this.d.self.setFacet("storage", { filesystems }, "probe", null, now);
		recordReadings(
			this.d.db,
			this.machine,
			"storage",
			Object.fromEntries(filesystems.map((f) => [`free:${f.holds}`, f.freeGb])),
			now,
		);
	}

	private async sizes(now: Date): Promise<void> {
		const sizes = await probeDirSizes(this.probes, this.d.dirs());
		this.d.self.setFacet("storage", { sizes }, "probe", null, now);
		recordReadings(
			this.d.db,
			this.machine,
			"storage",
			Object.fromEntries(sizes.map((s) => [`size:${s.name}`, s.gb])),
			now,
		);
	}

	private async devices(now: Date): Promise<void> {
		this.d.self.setFacet("devices", { ...(await probeDevices(this.probes)) }, "probe", null, now);
	}

	private models(now: Date): void {
		for (const m of this.d.models()) {
			let fileGb: number | null = null;
			try {
				if (m.path) fileGb = Math.round((statSync(m.path).size / 2 ** 30) * 10) / 10;
			} catch {
				fileGb = null; // not on this machine
			}
			const load = this.d.db
				.prepare(
					"SELECT started_at, finished_at FROM model_ops WHERE op = 'load' AND model_name = ? AND state = 'done' AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
				)
				.get(m.name) as { started_at: string; finished_at: string } | undefined;
			this.mergeModel(
				m.name,
				{
					fileGb,
					...(load
						? { loadSeconds: Math.round((Date.parse(load.finished_at) - Date.parse(load.started_at)) / 1000) }
						: {}),
				},
				now,
			);
		}
	}

	private mergeModel(name: string, fields: Record<string, unknown>, now: Date): void {
		const old = this.d.self.value<Record<string, unknown>>("models", name) ?? {};
		this.d.self.setFacet("models", { [name]: { ...old, ...fields } }, "probe", null, now);
	}

	// ---------------------------------------------------------------- reading

	/**
	 * Disk and memory as of now, probed again when the last look is older than
	 * `maxAgeMs`: the figures the `machine` observation and `system_status` use.
	 */
	async current(maxAgeMs = 60_000): Promise<CurrentVitals> {
		const now = this.d.now();
		if (this.due("memory", maxAgeMs, now)) await this.attempt("memory", now, () => this.memory(now));
		if (this.due("storage", maxAgeMs, now)) await this.attempt("storage", now, () => this.storage(now));
		if (this.due("compute", maxAgeMs, now)) await this.attempt("compute", now, () => this.compute(now));
		const fs = this.home();
		return {
			diskFreeGb: fs?.freeGb ?? 0,
			diskTotalGb: fs?.totalGb ?? 0,
			memAvailableGb: this.d.self.value<number>("memory", "availableGb"),
			swapUsedGb: this.d.self.value<number>("memory", "swapUsedGb"),
			load: [
				this.d.self.value<number>("compute", "load1") ?? 0,
				this.d.self.value<number>("compute", "load5") ?? 0,
				this.d.self.value<number>("compute", "load15") ?? 0,
			],
		};
	}

	/** The filesystem the home folder is on (the first one when none is named so). */
	private home(): Filesystem | null {
		const all = this.d.self.value<Filesystem[]>("storage", "filesystems") ?? [];
		return all.find((f) => f.holds.split(", ").includes("home")) ?? all[0] ?? null;
	}

	private ago(iso: string | null | undefined, now: Date): string {
		if (!iso) return "never";
		const min = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
		return min < 1 ? "just now" : min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
	}

	private factAt(facet: string, field: string): string | null {
		return (
			(
				this.d.db.prepare("SELECT observed_at FROM self_facts WHERE facet = ? AND field = ?").get(facet, field) as
					| { observed_at: string }
					| undefined
			)?.observed_at ?? null
		);
	}

	private local(iso: string): string {
		return new Date(iso).toLocaleString("sv-SE", { timeZone: this.d.timezone }).slice(0, 16);
	}

	/** What uses the memory, from the last probe. */
	memoryReport(): string {
		const now = this.d.now();
		const v = <T>(f: string) => this.d.self.value<T>("memory", f);
		const procs = v<ProcessUse[]>("processes");
		if (!procs) return "memory has not been probed yet";
		const gpu = procs.some((p) => p.gpuGb !== null);
		const total = (f: (p: ProcessUse) => number | null) =>
			(Math.round(procs.reduce((a, p) => a + (f(p) ?? 0), 0) * 10) / 10).toFixed(1);
		const swap = v<number>("swapTotalGb");
		return [
			`memory [${this.ago(this.factAt("memory", "processes"), now)}]: ${v<number>("availableGb") ?? "?"} GB of ${v<number>("totalGb") ?? "?"} GB available${swap ? `; swap ${v<number>("swapUsedGb") ?? "?"} of ${swap} GB used` : ""}`,
			`what Iyye's own processes hold (resident${gpu ? " + on the GPU" : ""}, GB):`,
			...procs.map(
				(p) =>
					`  ${p.role}${p.processes > 1 ? ` (${p.processes} processes)` : ""} — ${p.residentGb.toFixed(1)}${p.gpuGb === null ? "" : ` + ${p.gpuGb.toFixed(1)}`}`,
			),
			procs.length
				? `  in all — ${total((p) => p.residentGb)}${gpu ? ` + ${total((p) => p.gpuGb)}` : ""}`
				: "  none of Iyye's processes was found",
			"history: /self history memory.availableGb",
		].join("\n");
	}

	/** What uses the disk, from the last probes. */
	diskReport(): string {
		const now = this.d.now();
		const fs = this.d.self.value<Filesystem[]>("storage", "filesystems");
		if (!fs) return "the disk has not been probed yet";
		const sizes = this.d.self.value<DirSize[]>("storage", "sizes");
		return [
			`filesystems [${this.ago(this.factAt("storage", "filesystems"), now)}]:`,
			...fs.map((f) => `  ${f.holds} — ${f.freeGb} GB free of ${f.totalGb} GB`),
			sizes
				? `Iyye's own directories [${this.ago(this.factAt("storage", "sizes"), now)}], GB:`
				: "Iyye's own directories have not been measured yet (once a day)",
			...(sizes ?? []).filter((s) => s.gb >= 0.1).map((s) => `  ${s.name} — ${s.gb.toFixed(1)}`),
		].join("\n");
	}

	/** When the host was running, and the nights. */
	runsReport(): string {
		const runs = recentRuns(this.d.db, 8);
		const hours = (ms: number) => (ms < HOUR ? `${Math.round(ms / 60_000)} min` : `${(ms / HOUR).toFixed(1)} h`);
		const lines = ["runs of the host (newest first):"];
		for (const [i, r] of runs.entries()) {
			const end =
				i === 0 && r.id === this.runId
					? "running now"
					: `until ${this.local(r.last_seen_at)}, ended ${r.ended === "shutdown" ? "with a shutdown" : "without a shutdown (killed, or the machine went down)"}`;
			lines.push(
				`  since ${this.local(r.started_at)} under ${r.under} — ${end}${r.notRunningMsBefore !== null && r.notRunningMsBefore >= 120_000 ? `; before it nothing ran for ${hours(r.notRunningMsBefore)}` : ""}`,
			);
		}
		if (runs.length === 0) lines.push("  none recorded yet");
		const nights = recentNights(this.d.db, 7);
		lines.push("nights (newest first):");
		for (const n of nights)
			lines.push(
				`  asleep ${this.local(n.slept_at)}${n.woke_at ? ` to ${this.local(n.woke_at).slice(11)}` : " (no end recorded)"} — ${n.in_window ? "in the rest window" : `outside the rest window${n.reason ? ` (${n.reason.slice(0, 60)})` : ""}`}, ${n.completed ? "completed" : "not completed"}`,
			);
		if (nights.length === 0) lines.push("  none recorded yet");
		return lines.join("\n");
	}

	/** `/self history [facet.field] [days]`: a field's readings by the hour (two days) or by the day. */
	historyReport(args: string[]): string {
		const machine = this.machine;
		const [name, daysArg] = args;
		const fields = readingFields(this.d.db, machine);
		if (!name)
			return ["fields with a history (/self history <field> [days]):", ...fields.map((f) => `  ${f}`)].join("\n");
		const dot = name.indexOf(".");
		if (dot < 0 || !fields.includes(name)) return `no history for ${JSON.stringify(name)}; see /self history`;
		const days = Math.min(90, Math.max(1, Number(daysArg) || 2));
		const rows = hourly(
			this.d.db,
			name.slice(0, dot),
			name.slice(dot + 1),
			machine,
			new Date(this.d.now().getTime() - days * DAY),
		);
		if (rows.length === 0) return `no readings of ${name} in the last ${days} day(s)`;
		const f = (x: number) => (Math.round(x * 10) / 10).toString();
		const byHour = days <= 2;
		const groups = new Map<string, typeof rows>();
		for (const r of rows) {
			const local = this.local(`${r.hour}:00:00Z`);
			const key = byHour ? `${local.slice(0, 13)}h` : local.slice(0, 10);
			groups.set(key, [...(groups.get(key) ?? []), r]);
		}
		return [
			`${name}, the last ${days} day(s), by the ${byHour ? "hour" : "day"} (mean, lowest to highest):`,
			...[...groups].map(([key, g]) => {
				const n = g.reduce((a, r) => a + r.n, 0);
				return `  ${key}  ${f(g.reduce((a, r) => a + r.mean * r.n, 0) / n)}  (${f(Math.min(...g.map((r) => r.min)))} to ${f(Math.max(...g.map((r) => r.max)))})`;
			}),
		].join("\n");
	}

	/** `/self memory | disk | runs | history …`; null when the words are not these. */
	command(args: string[]): string | null {
		switch (args[0]) {
			case "memory":
				return this.memoryReport();
			case "disk":
				return this.diskReport();
			case "runs":
				return this.runsReport();
			case "history":
				return this.historyReport(args.slice(1));
			default:
				return null;
		}
	}

	/** Lines for the owner's about-me note: what uses the memory, and how this run and the last nights went. */
	aboutLines(): string[] {
		const now = this.d.now();
		const lines: string[] = [];
		const procs = this.d.self.value<ProcessUse[]>("memory", "processes");
		if (procs?.length) {
			const size = (p: ProcessUse) => p.residentGb + (p.gpuGb ?? 0);
			lines.push(
				`- What your own processes hold (GB of memory, the GPU's share included): ${procs
					.filter((p) => size(p) >= 0.5)
					.slice(0, 6)
					.map((p) => `${p.role} ${size(p).toFixed(1)}`)
					.join(", ")} [${this.ago(this.factAt("memory", "processes"), now)}]`,
			);
		}
		const started = this.d.self.value<string>("lifecycle", "startedAt");
		if (started) {
			const gap = this.d.self.value<number>("lifecycle", "notRunningHoursBefore");
			const ended = this.d.self.value<string>("lifecycle", "previousRunEnded");
			const n = this.d.self.value<number>("rhythm", "nights7");
			lines.push(
				`- This run: started ${this.ago(started, now)}, under ${this.d.self.value<string>("lifecycle", "under")}${
					gap !== null && gap >= 0.1
						? `; before it you were not running for ${gap} h (the run before ended ${ended})`
						: ""
				}.${n ? ` Nights in the last 7 days: ${n}, ${this.d.self.value<number>("rhythm", "nightsInWindow7")} of them in the rest window.` : ""}`,
			);
		}
		return lines;
	}
}

export type { Compute, Memory };
