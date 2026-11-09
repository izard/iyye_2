// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed read-only probes of how the machine is doing (plan 0.018 W1): load
 * and pressure, the GPU, memory and what uses it, the filesystems Iyye lives
 * on, the sizes of its own directories, and which devices are present.
 * Fixed commands with fixed arguments, never a shell, never a model
 * (`self/probes.ts`'s rules).
 *
 * - **What uses the memory** is answered per role, for the processes the
 *   host itself started (their trees). On the Spark a process's resident
 *   size leaves out what it holds on the GPU, and the GB10 reports no GPU
 *   total (W0), so both figures are kept, joined by process.
 * - **Nothing identifying is kept:** no PID, no command line (a model
 *   instance's `--alias` is read from the router's own children, and only
 *   that word), no mount point or volume name, no device name.
 */

import { statfsSync, statSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { parseVmStat } from "../models/memory.ts";
import type { Exec, ListDir, ReadFile } from "./probes.ts";

export interface VitalsDeps {
	exec: Exec;
	readFile: ReadFile;
	listDir: ListDir;
	platform: NodeJS.Platform;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const num = (s: string | null | undefined): number | null => {
	if (s === null || s === undefined) return null;
	const n = Number(s.trim());
	return s.trim() !== "" && Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------- compute

export interface Compute {
	cores: number;
	load1: number;
	load5: number;
	load15: number;
	/** Linux pressure stall information: the share of the last minute some work waited (percent). */
	cpuPressure: number | null;
	memoryPressure: number | null;
	ioPressure: number | null;
	gpuUtilPct: number | null;
	gpuTempC: number | null;
	gpuPowerW: number | null;
	/** The hottest of the thermal zones and sensors, °C. */
	hottestC: number | null;
}

/** `/proc/pressure/<kind>`: the "some" line's 60-second average. */
export function parsePressure(text: string | null): number | null {
	return num(/^some .*\bavg60=([\d.]+)/m.exec(text ?? "")?.[1]);
}

/** `nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits`. */
export function parseGpu(csv: string | null): Pick<Compute, "gpuUtilPct" | "gpuTempC" | "gpuPowerW"> {
	const [util, temp, power] = (csv ?? "").trim().split("\n")[0]?.split(",") ?? [];
	return { gpuUtilPct: num(util), gpuTempC: num(temp), gpuPowerW: num(power) };
}

/** Milli-degree readings (each thermal zone's `temp`, each hwmon sensor's `temp<n>_input`): the hottest, in °C. */
export function hottest(readings: readonly (string | null)[]): number | null {
	const temps = readings.flatMap((r) => {
		const t = num(r);
		// A disconnected sensor reads 0 or a huge value.
		return t === null || t <= 0 || t > 150_000 ? [] : [round1(t / 1000)];
	});
	return temps.length ? Math.max(...temps) : null;
}

export async function probeCompute(d: VitalsDeps): Promise<Compute> {
	const [load1, load5, load15] = loadavg().map((x) => Math.round(x * 100) / 100) as [number, number, number];
	const base = { cores: cpus().length, load1, load5, load15 };
	if (d.platform !== "linux")
		return {
			...base,
			cpuPressure: null,
			memoryPressure: null,
			ioPressure: null,
			gpuUtilPct: null,
			gpuTempC: null,
			gpuPowerW: null,
			hottestC: null,
		};
	const gpu = await d
		.exec("nvidia-smi", ["--query-gpu=utilization.gpu,temperature.gpu,power.draw", "--format=csv,noheader,nounits"])
		.catch(() => null);
	const sensors = [
		...d
			.listDir("/sys/class/thermal")
			.filter((z) => z.startsWith("thermal_zone"))
			.map((z) => d.readFile(`/sys/class/thermal/${z}/temp`)),
		...d.listDir("/sys/class/hwmon").flatMap((h) =>
			d
				.listDir(`/sys/class/hwmon/${h}`)
				.filter((f) => /^temp\d+_input$/.test(f))
				.map((f) => d.readFile(`/sys/class/hwmon/${h}/${f}`)),
		),
	];
	return {
		...base,
		cpuPressure: parsePressure(d.readFile("/proc/pressure/cpu")),
		memoryPressure: parsePressure(d.readFile("/proc/pressure/memory")),
		ioPressure: parsePressure(d.readFile("/proc/pressure/io")),
		...parseGpu(gpu),
		hottestC: hottest(sensors),
	};
}

// ---------------------------------------------------------------- memory

/** A process the host started, by what it is for. */
export interface ProcessRoot {
	role: string;
	pid: number;
	/** The model router: its children are the model instances, each named by its `--alias`. */
	router?: boolean;
}

export interface ProcessUse {
	role: string;
	processes: number;
	residentGb: number;
	/** Its share of the GPU's memory; null where that cannot be read. */
	gpuGb: number | null;
}

export interface Memory {
	totalGb: number;
	availableGb: number | null;
	swapTotalGb: number | null;
	swapUsedGb: number | null;
	processes: ProcessUse[];
}

/** `/proc/meminfo`: total, available and swap, in GB. */
export function parseMeminfo(text: string): Pick<Memory, "totalGb" | "availableGb" | "swapTotalGb" | "swapUsedGb"> {
	const gb = (key: string) => {
		const kb = num(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text)?.[1]);
		return kb === null ? null : kb / 2 ** 20;
	};
	const swapTotal = gb("SwapTotal");
	const swapFree = gb("SwapFree");
	return {
		totalGb: round1(gb("MemTotal") ?? totalmem() / 2 ** 30),
		availableGb: gb("MemAvailable") === null ? null : round1(gb("MemAvailable")!),
		swapTotalGb: swapTotal === null ? null : round1(swapTotal),
		swapUsedGb: swapTotal === null || swapFree === null ? null : round1(swapTotal - swapFree),
	};
}

/** macOS `sysctl -n vm.swapusage`: "total = 2048.00M  used = 1124.25M  free = …". */
export function parseSwapUsage(text: string | null): Pick<Memory, "swapTotalGb" | "swapUsedGb"> {
	const mb = (key: string) => num(new RegExp(`${key} = ([\\d.]+)M`).exec(text ?? "")?.[1]);
	const total = mb("total");
	const used = mb("used");
	return {
		swapTotalGb: total === null ? null : round1(total / 1024),
		swapUsedGb: used === null ? null : round1(used / 1024),
	};
}

interface Proc {
	pid: number;
	ppid: number;
	rssKb: number;
}

/** `ps -eo pid=,ppid=,rss=`: numbers only, no program names. */
export function parsePs(text: string): Proc[] {
	return text.split("\n").flatMap((line) => {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
		return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]) }] : [];
	});
}

/** `ps -o pid=,args= -p …` of the router's children: only each one's `--alias` word is read. */
export function parseAliases(text: string): Map<number, string> {
	const out = new Map<number, string>();
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s+.*?--alias\s+([\w.@:+-]{1,80})(\s|$)/.exec(line);
		if (m) out.set(Number(m[1]), m[2]!);
	}
	return out;
}

/** `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits`: PID → MiB. */
export function parseGpuApps(csv: string | null): Map<number, number> | null {
	if (csv === null) return null;
	const out = new Map<number, number>();
	for (const line of csv.split("\n")) {
		const [pid, mb] = line.split(",").map((x) => num(x));
		if (pid !== null && pid !== undefined && mb !== null && mb !== undefined) out.set(pid, (out.get(pid) ?? 0) + mb);
	}
	return out;
}

/**
 * Memory by role. Every process belongs to its nearest ancestor among the
 * roots (so the host's own figure leaves out the services it started), and a
 * child of the router is the model its alias names. Processes that are not
 * Iyye's are not listed at all.
 */
export function useByRole(
	procs: readonly Proc[],
	roots: readonly ProcessRoot[],
	aliases: ReadonlyMap<number, string>,
	gpu: ReadonlyMap<number, number> | null,
): ProcessUse[] {
	const byPid = new Map(procs.map((p) => [p.pid, p]));
	const rootRole = new Map(roots.map((r) => [r.pid, r.role]));
	const routers = new Set(roots.filter((r) => r.router).map((r) => r.pid));
	const roleOf = (pid: number): string | null => {
		let at: Proc | undefined = byPid.get(pid);
		for (let depth = 0; at && depth < 64; depth++) {
			if (routers.has(at.ppid) && aliases.has(at.pid)) return `model ${aliases.get(at.pid)}`;
			if (rootRole.has(at.pid)) return rootRole.get(at.pid)!;
			at = byPid.get(at.ppid);
		}
		return null;
	};
	const use = new Map<string, { processes: number; kb: number; gpuMb: number }>();
	for (const p of procs) {
		const role = roleOf(p.pid);
		if (!role) continue;
		const u = use.get(role) ?? { processes: 0, kb: 0, gpuMb: 0 };
		use.set(role, { processes: u.processes + 1, kb: u.kb + p.rssKb, gpuMb: u.gpuMb + (gpu?.get(p.pid) ?? 0) });
	}
	return [...use]
		.map(([role, u]) => ({
			role,
			processes: u.processes,
			residentGb: round1(u.kb / 2 ** 20),
			gpuGb: gpu ? round1(u.gpuMb / 1024) : null,
		}))
		.sort((a, b) => b.residentGb + (b.gpuGb ?? 0) - (a.residentGb + (a.gpuGb ?? 0)));
}

export async function probeMemory(d: VitalsDeps, roots: readonly ProcessRoot[]): Promise<Memory> {
	const linux = d.platform === "linux";
	const totals = linux
		? parseMeminfo(d.readFile("/proc/meminfo") ?? "")
		: {
				totalGb: round1(totalmem() / 2 ** 30),
				availableGb: await d
					.exec("/usr/bin/vm_stat", [])
					.then((t) => round1(parseVmStat(t)))
					.catch(() => null),
				...parseSwapUsage(await d.exec("/usr/sbin/sysctl", ["-n", "vm.swapusage"]).catch(() => null)),
			};
	const live = roots.filter((r) => Number.isInteger(r.pid) && r.pid > 1);
	const ps = await d.exec("ps", linux ? ["-eo", "pid=,ppid=,rss="] : ["-axo", "pid=,ppid=,rss="]).catch(() => "");
	const procs = parsePs(ps);
	const routers = new Set(live.filter((r) => r.router).map((r) => r.pid));
	const instances = procs.filter((p) => routers.has(p.ppid)).map((p) => p.pid);
	const aliases = instances.length
		? parseAliases(await d.exec("ps", ["-o", "pid=,args=", "-p", instances.join(",")]).catch(() => ""))
		: new Map<number, string>();
	const gpu = linux
		? parseGpuApps(
				await d
					.exec("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"])
					.catch(() => null),
			)
		: null;
	return { ...totals, processes: useByRole(procs, live, aliases, gpu) };
}

// ---------------------------------------------------------------- storage

export interface Filesystem {
	/** What Iyye keeps there ("home, state, models"), never the mount point or the volume's name. */
	holds: string;
	totalGb: number;
	freeGb: number;
}

/** The filesystems under the given paths, one entry per device. */
export function probeFilesystems(paths: Readonly<Record<string, string>>): Filesystem[] {
	const byDevice = new Map<number, { holds: string[]; path: string }>();
	for (const [what, path] of Object.entries(paths)) {
		try {
			const dev = statSync(path).dev;
			const had = byDevice.get(dev);
			if (had) had.holds.push(what);
			else byDevice.set(dev, { holds: [what], path });
		} catch {
			// not there (no models directory on this machine)
		}
	}
	return [...byDevice.values()].map((f) => {
		const s = statfsSync(f.path);
		const gb = (blocks: number) => round1((blocks * s.bsize) / 2 ** 30);
		return { holds: f.holds.join(", "), totalGb: gb(s.blocks), freeGb: gb(s.bavail) };
	});
}

export interface DirSize {
	/** "state/voice", "models": the directory's place in Iyye's own tree, never an absolute path. */
	name: string;
	gb: number;
}

/** `du -sk` of each of a fixed list of Iyye's own directories (`name` → path). One that cannot be read is left out. */
export async function probeDirSizes(d: VitalsDeps, dirs: Readonly<Record<string, string>>): Promise<DirSize[]> {
	const sizes = await Promise.all(
		Object.entries(dirs).map(async ([name, path]) => {
			const out = await d.exec("du", ["-sk", path], { timeoutMs: 120_000 }).catch(() => "");
			const kb = num(/^(\d+)\t/.exec(out)?.[1]);
			return kb === null ? [] : [{ name, gb: round1(kb / 2 ** 20) }];
		}),
	);
	return sizes.flat().sort((a, b) => b.gb - a.gb);
}

// ---------------------------------------------------------------- devices

export interface Devices {
	displays: number | null;
	cameras: number | null;
	/** Sound cards (Linux) or audio devices (macOS). */
	audio: number | null;
}

/** `system_profiler -json SPDisplaysDataType SPCameraDataType SPAudioDataType`: counts only. */
export function parseDevicesMac(json: string): Devices {
	const j = JSON.parse(json) as Record<string, { spdisplays_ndrvs?: unknown[]; _items?: unknown[] }[] | undefined>;
	return {
		displays: (j.SPDisplaysDataType ?? []).reduce((n, g) => n + (g.spdisplays_ndrvs?.length ?? 0), 0),
		cameras: (j.SPCameraDataType ?? []).length,
		audio: (j.SPAudioDataType ?? []).reduce((n, g) => n + (g._items?.length ?? 0), 0),
	};
}

/** Presence only, never content: connected displays, video devices, sound cards. */
export async function probeDevices(d: VitalsDeps): Promise<Devices> {
	if (d.platform === "linux")
		return {
			displays: d
				.listDir("/sys/class/drm")
				.filter((c) => (d.readFile(`/sys/class/drm/${c}/status`) ?? "").trim() === "connected").length,
			cameras: d.listDir("/dev").filter((f) => /^video\d+$/.test(f)).length,
			audio: ((d.readFile("/proc/asound/cards") ?? "").match(/^\s*\d+ \[/gm) ?? []).length,
		};
	if (d.platform === "darwin")
		return parseDevicesMac(
			await d.exec(
				"/usr/sbin/system_profiler",
				["-json", "SPDisplaysDataType", "SPCameraDataType", "SPAudioDataType"],
				{
					timeoutMs: 60_000,
					maxBuffer: 8 * 1024 * 1024,
				},
			),
		);
	return { displays: null, cameras: null, audio: null };
}
