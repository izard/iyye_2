// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed read-only probes of Iyye's extended self (plan 0.010 M0b): fixed
 * commands with fixed arguments, run asynchronously (some take seconds and
 * must not block the event loop), never a shell, never a model.
 *
 * Every parser keeps an explicit list of fields. Device identifiers
 * (serial number, platform UUID, provisioning UDID), the public IP address,
 * the ISP and postal codes are never kept: they must not reach the self
 * model, memory or a prompt.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";

export type Exec = (file: string, args: string[], opts?: { timeoutMs?: number; maxBuffer?: number }) => Promise<string>;

/** `execFile` without a shell, with a fixed PATH, a timeout and a bounded output. */
export const execAsync: Exec = (file, args, opts = {}) =>
	new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{
				encoding: "utf8",
				timeout: opts.timeoutMs ?? 15_000,
				maxBuffer: opts.maxBuffer ?? 1024 * 1024,
				env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
			},
			(err, stdout) => (err ? reject(err) : resolve(stdout)),
		);
	});

// ---------------------------------------------------------------- hardware

export interface Hardware {
	machine: string | null;
	model: string | null;
	chip: string | null;
	/** "16 (12 performance, 4 efficiency)". */
	cores: string | null;
	memoryGb: number | null;
	os: string | null;
}

/** `system_profiler -json SPHardwareDataType`: only the fields below; never serial, UUID or UDID. */
export function parseHardware(json: string, swVers: string): Hardware {
	const hw = (JSON.parse(json) as { SPHardwareDataType?: Record<string, string>[] }).SPHardwareDataType?.[0] ?? {};
	const procs = /proc (\d+):(\d+):(\d+):(\d+)/.exec(hw.number_processors ?? "");
	const mem = /([\d.]+)\s*GB/.exec(hw.physical_memory ?? "");
	const name = /ProductName:\s*(.+)/.exec(swVers)?.[1]?.trim();
	const version = /ProductVersion:\s*(.+)/.exec(swVers)?.[1]?.trim();
	return {
		machine: hw.machine_name ?? null,
		model: hw.machine_model ?? null,
		chip: hw.chip_type ?? hw.cpu_type ?? null,
		cores: procs ? `${procs[1]} (${procs[3]} performance, ${procs[4]} efficiency)` : null,
		memoryGb: mem ? Number(mem[1]) : null,
		os: name && version ? `${name} ${version}` : null,
	};
}

export async function probeHardware(exec: Exec): Promise<Hardware> {
	const [json, sw] = await Promise.all([
		exec("/usr/sbin/system_profiler", ["-json", "SPHardwareDataType"], { timeoutMs: 30_000 }),
		exec("/usr/bin/sw_vers", []),
	]);
	return parseHardware(json, sw);
}

// ---------------------------------------------------------------- power

export interface Power {
	source: "AC" | "battery" | null;
	batteryPct: number | null;
	charging: boolean | null;
	/** True when the lid is closed. */
	lidClosed: boolean | null;
	/** Closing the lid puts the machine to sleep (no external display, or on battery). */
	lidCausesSleep: boolean | null;
}

export function parsePower(batt: string, clamshell: string): Power {
	const source = /Now drawing from '([^']+)'/.exec(batt)?.[1];
	const pct = /(\d+)%;/.exec(batt);
	const state = /\d+%;\s*([a-z ]+);/i.exec(batt)?.[1]?.trim().toLowerCase();
	const yesNo = (key: string) => {
		const m = new RegExp(`"${key}"\\s*=\\s*(Yes|No)`).exec(clamshell);
		return m ? m[1] === "Yes" : null;
	};
	return {
		source: source === "AC Power" ? "AC" : source === "Battery Power" ? "battery" : null,
		batteryPct: pct ? Number(pct[1]) : null,
		charging: state ? state === "charging" : null,
		lidClosed: yesNo("AppleClamshellState"),
		lidCausesSleep: yesNo("AppleClamshellCausesSleep"),
	};
}

export async function probePower(exec: Exec): Promise<Power> {
	const [batt, clam] = await Promise.all([
		exec("/usr/bin/pmset", ["-g", "batt"]),
		exec("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"]).catch(() => ""),
	]);
	return parsePower(batt, clam);
}

// ---------------------------------------------------------------- sleep history

export interface SleepHistory {
	/** Over the window: how often the system slept, woke briefly for maintenance, and fully woke. */
	sleeps: number;
	darkWakes: number;
	wakes: number;
	/** Minutes asleep in the window. */
	asleepMinutes: number;
	sleptOnBattery: boolean;
	lastSleepAt: string | null;
	lastWakeAt: string | null;
}

const PMSET_LINE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d) (Sleep|Wake|DarkWake)\s{2,}(.*)$/;

/** `pmset -g log`, only lines at or after `since`. Times come back as ISO (UTC). */
export function parseSleepLog(log: string, since: Date, now: Date): SleepHistory {
	const events: { at: number; kind: string; rest: string }[] = [];
	for (const line of log.split("\n")) {
		const m = PMSET_LINE.exec(line);
		if (!m) continue;
		const at = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
		if (Number.isNaN(at) || at < since.getTime()) continue;
		events.push({ at, kind: m[5]!, rest: m[6]! });
	}
	let asleep = 0;
	let sleepingSince: number | null = null;
	let battery = false;
	let lastSleep: number | null = null;
	let lastWake: number | null = null;
	const h = { sleeps: 0, darkWakes: 0, wakes: 0 };
	for (const e of events) {
		if (e.kind === "Sleep") {
			h.sleeps++;
			lastSleep = e.at;
			sleepingSince ??= e.at;
			if (/Using Batt/i.test(e.rest)) battery = true;
		} else {
			if (e.kind === "DarkWake") h.darkWakes++;
			else {
				h.wakes++;
				lastWake = e.at;
			}
			if (sleepingSince !== null) {
				asleep += e.at - sleepingSince;
				sleepingSince = null;
			}
		}
	}
	if (sleepingSince !== null) asleep += now.getTime() - sleepingSince;
	const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
	return {
		...h,
		asleepMinutes: Math.round(asleep / 60_000),
		sleptOnBattery: battery,
		lastSleepAt: iso(lastSleep),
		lastWakeAt: iso(lastWake),
	};
}

export async function probeSleep(exec: Exec, now: Date, windowMs = 24 * 3_600_000): Promise<SleepHistory> {
	// About 4 MB and a second of CPU: asynchronous, and only the last day is parsed.
	const log = await exec("/usr/bin/pmset", ["-g", "log"], { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 });
	return parseSleepLog(log, new Date(now.getTime() - windowMs), now);
}

// ---------------------------------------------------------------- Linux (2026-10-10: the DGX Spark)

/** Read a small system file; null when it is missing or unreadable. Tests replace it. */
export type ReadFile = (path: string) => string | null;
export const readSysFile: ReadFile = (path) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};
/** The entries of a system directory (empty when missing). */
export type ListDir = (path: string) => string[];
export const listSysDir: ListDir = (path) => {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
};

const clean = (s: string | null | undefined) => {
	const t = (s ?? "").replace(/\0/g, "").replace(/_/g, " ").trim();
	return t && !/^(to be filled|default string|system product name|not specified)/i.test(t) ? t.slice(0, 80) : null;
};

/**
 * Linux hardware from DMI or the device tree (product and vendor only; never the serial number, the board
 * serial or the product UUID), `lscpu` (core types), the memory size, `nvidia-smi` (the GPU's name) and
 * os-release.
 */
export function parseHardwareLinux(o: {
	product: string | null;
	vendor: string | null;
	family: string | null;
	deviceTreeModel: string | null;
	lscpu: string;
	memoryBytes: number;
	gpu: string;
	osRelease: string | null;
}): Hardware {
	const groups: { model: string; cores: number }[] = [];
	let current: { model: string; cores: number; sockets: number } | null = null;
	const flush = () => {
		if (current) groups.push({ model: current.model, cores: current.cores * current.sockets });
	};
	for (const line of o.lscpu.split("\n")) {
		const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
		if (!m) continue;
		const [key, value] = [m[1]!.trim(), m[2]!.trim()];
		if (key === "Model name") {
			flush();
			current = { model: value, cores: 0, sockets: 1 };
		} else if (current && key === "Core(s) per socket") current.cores = Number(value) || 0;
		else if (current && (key === "Socket(s)" || key === "Cluster(s)")) current.sockets = Number(value) || 1;
	}
	flush();
	const total = groups.reduce((x, g) => x + g.cores, 0);
	const gpus = o.gpu
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const cpu = groups.map((g) => g.model).join(" + ");
	const machine = clean(o.product) ?? clean(o.deviceTreeModel);
	const vendor = clean(o.vendor);
	return {
		machine: machine
			? vendor && !machine.toLowerCase().startsWith(vendor.toLowerCase())
				? `${vendor} ${machine}`
				: machine
			: null,
		model: clean(o.family),
		chip: [cpu || null, gpus.length ? `GPU ${gpus.join(", ")}` : null].filter(Boolean).join("; ") || null,
		cores: total
			? groups.length > 1
				? `${total} (${groups.map((g) => `${g.cores} ${g.model}`).join(", ")})`
				: String(total)
			: null,
		memoryGb: o.memoryBytes > 0 ? Math.round(o.memoryBytes / 2 ** 30) : null,
		os: /^PRETTY_NAME="?([^"\n]+)"?/m.exec(o.osRelease ?? "")?.[1]?.trim() ?? null,
	};
}

export async function probeHardwareLinux(exec: Exec, read: ReadFile = readSysFile): Promise<Hardware> {
	const [lscpu, gpu] = await Promise.all([
		exec("lscpu", []).catch(() => ""),
		exec("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]).catch(() => ""),
	]);
	return parseHardwareLinux({
		product: read("/sys/devices/virtual/dmi/id/product_name"),
		vendor: read("/sys/devices/virtual/dmi/id/sys_vendor"),
		family: read("/sys/devices/virtual/dmi/id/product_family"),
		deviceTreeModel: read("/proc/device-tree/model"),
		lscpu,
		memoryBytes: totalmem(),
		gpu,
		osRelease: read("/etc/os-release"),
	});
}

/**
 * Linux power from `/sys/class/power_supply` (mains, batteries) and the ACPI lid. No supply at all is a
 * machine on mains power without a battery (a desktop such as the Spark).
 */
export function probePowerLinux(read: ReadFile = readSysFile, list: ListDir = listSysDir): Power {
	const base = "/sys/class/power_supply";
	const supplies = list(base).map((name) => ({
		type: read(join(base, name, "type"))?.trim() ?? "",
		online: read(join(base, name, "online"))?.trim() ?? null,
		capacity: read(join(base, name, "capacity"))?.trim() ?? null,
		status:
			read(join(base, name, "status"))
				?.trim()
				.toLowerCase() ?? null,
	}));
	const mains = supplies.filter((s) => s.type === "Mains" || s.type === "USB");
	const battery = supplies.find((s) => s.type === "Battery");
	const onMains =
		mains.length === 0
			? battery === undefined || battery.status !== "discharging"
			: mains.some((s) => s.online === "1");
	const lid = list("/proc/acpi/button/lid")
		.map((d) => /state:\s*(open|closed)/.exec(read(`/proc/acpi/button/lid/${d}/state`) ?? "")?.[1])
		.find(Boolean);
	return {
		source: onMains ? "AC" : "battery",
		batteryPct: battery?.capacity && /^\d+$/.test(battery.capacity) ? Number(battery.capacity) : null,
		charging: battery?.status ? battery.status === "charging" : null,
		lidClosed: lid ? lid === "closed" : null,
		lidCausesSleep: null,
	};
}

/**
 * Linux sleep history from the kernel journal: "PM: suspend entry" and "PM: suspend exit" (and hibernation),
 * with times only (`-o short-iso`; the host name on each line is never kept). No dark wakes on Linux.
 */
export function parseSuspendJournal(log: string, since: Date, now: Date, onBattery = false): SleepHistory {
	const events: { at: number; kind: "Sleep" | "Wake" }[] = [];
	for (const line of log.split("\n")) {
		const m =
			/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?)\s.*PM: (?:suspend|hibernation) (entry|exit)/.exec(
				line,
			);
		if (!m) continue;
		const at = Date.parse(m[1]!.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
		if (Number.isNaN(at) || at < since.getTime()) continue;
		events.push({ at, kind: m[2] === "entry" ? "Sleep" : "Wake" });
	}
	const pmsetLike = events
		.map((e) => {
			const d = new Date(e.at);
			const p = (x: number) => String(x).padStart(2, "0");
			return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000 ${e.kind}  ${onBattery && e.kind === "Sleep" ? "Using Batt" : "Using AC"}`;
		})
		.join("\n");
	return parseSleepLog(pmsetLike, since, now);
}

export async function probeSleepLinux(exec: Exec, now: Date, windowMs = 24 * 3_600_000): Promise<SleepHistory> {
	const since = new Date(now.getTime() - windowMs);
	const log = await exec(
		"journalctl",
		[
			"-k",
			"--since",
			`@${Math.floor(since.getTime() / 1000)}`,
			"-o",
			"short-iso",
			"--no-pager",
			"-g",
			"PM: (suspend|hibernation) (entry|exit)",
		],
		{ timeoutMs: 30_000, maxBuffer: 16 * 1024 * 1024 },
	).catch((err: Error & { code?: number }) => {
		// journalctl exits 1 when nothing matched: no sleep in the window.
		if (err.code === 1) return "";
		throw err;
	});
	return parseSuspendJournal(log, since, now, probePowerLinux().source === "battery");
}

/** `ip route show default` and `ip neigh show <gateway>`: the same opaque network id as on macOS. */
export function parseNetworkLinux(route: string, neigh: string): Network {
	const m = /^default via (\S+) dev (\S+)/m.exec(route);
	const mac = /lladdr ([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i.exec(neigh)?.[1] ?? "";
	return {
		interface: m?.[2] ?? null,
		networkId: m ? createHash("sha256").update(`${m[1]}|${mac}`).digest("hex").slice(0, 12) : null,
	};
}

export async function probeNetworkLinux(exec: Exec): Promise<Network> {
	const route = await exec("ip", ["route", "show", "default"]).catch(() => "");
	const gateway = /^default via (\S+)/m.exec(route)?.[1];
	const neigh =
		gateway && /^[\d.]+$/.test(gateway) ? await exec("ip", ["neigh", "show", gateway]).catch(() => "") : "";
	return parseNetworkLinux(route, neigh);
}

// ---------------------------------------------------------------- network

export interface Network {
	interface: string | null;
	/** An opaque id of the network (gateway address and its hardware address, hashed): it changes when the network does. */
	networkId: string | null;
}

export function parseNetwork(route: string, arp: string): Network {
	const gateway = /gateway:\s*(\S+)/.exec(route)?.[1] ?? null;
	const iface = /interface:\s*(\S+)/.exec(route)?.[1] ?? null;
	const mac = /\bat ([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i.exec(arp)?.[1] ?? "";
	return {
		interface: iface,
		networkId: gateway ? createHash("sha256").update(`${gateway}|${mac}`).digest("hex").slice(0, 12) : null,
	};
}

export async function probeNetwork(exec: Exec): Promise<Network> {
	const route = await exec("/sbin/route", ["-n", "get", "default"]).catch(() => "");
	const gateway = /gateway:\s*(\S+)/.exec(route)?.[1];
	const arp = gateway && /^[\d.]+$/.test(gateway) ? await exec("/usr/sbin/arp", ["-n", gateway]).catch(() => "") : "";
	return parseNetwork(route, arp);
}

// ---------------------------------------------------------------- versions

export interface Versions {
	iyye: string | null;
	node: string;
	pi: string | null;
	llamaBuild: string | null;
}

/** Iyye's own code (the iyye_2 commit), Node, the pinned Pi, and the llama.cpp build directory. */
export async function probeVersions(
	exec: Exec,
	opts: { repoDir: string; hostDir: string; llamaServer: string },
): Promise<Versions> {
	const commit = await exec("/usr/bin/git", ["-C", opts.repoDir, "rev-parse", "--short", "HEAD"]).catch(() => "");
	let pi: string | null = null;
	try {
		const pkg = JSON.parse(readFileSync(join(opts.hostDir, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		pi = pkg.dependencies?.["@earendil-works/pi-coding-agent"] ?? null;
	} catch {
		pi = null;
	}
	return {
		iyye: commit.trim() || null,
		node: process.versions.node,
		pi,
		llamaBuild: /\/(build[^/]*)\/bin\//.exec(opts.llamaServer)?.[1] ?? null,
	};
}

// ---------------------------------------------------------------- place

export interface PlaceEstimate {
	city: string | null;
	region: string | null;
	country: string | null;
	timezone: string | null;
	/** Rounded to 0.1° (about 10 km): enough for daylight and weather, no closer. */
	lat: number | null;
	lon: number | null;
	service: string;
}

/** An IP-geolocation answer (ipinfo.io's shape), keeping only the city-level fields: never the IP, ISP or postal code. */
export function parsePlace(body: string, service: string): PlaceEstimate {
	const j = JSON.parse(body) as Record<string, unknown>;
	const str = (k: string) =>
		typeof j[k] === "string" && (j[k] as string).trim() ? (j[k] as string).trim().slice(0, 80) : null;
	const [lat, lon] = (str("loc") ?? "").split(",").map(Number);
	const round = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
	return {
		city: str("city"),
		region: str("region"),
		country: str("country"),
		timezone: str("timezone"),
		lat: round(lat),
		lon: round(lon),
		service,
	};
}

export const GEOLOCATION_URL = "https://ipinfo.io/json";

export async function probePlace(http: {
	get(url: string): Promise<{ status: number; body: string }>;
}): Promise<PlaceEstimate> {
	const page = await http.get(GEOLOCATION_URL);
	if (page.status !== 200) throw new Error(`geolocation answered HTTP ${page.status}`);
	return parsePlace(page.body, "ipinfo.io");
}

/**
 * Sunrise and sunset (NOAA's simplified solar equations), offline, accurate
 * to a few minutes; null in polar day or night.
 */
export function solarTimes(lat: number, lon: number, date: Date): { sunrise: Date; sunset: Date } | null {
	const rad = Math.PI / 180;
	const start = Date.UTC(date.getUTCFullYear(), 0, 0);
	const day = Math.floor((date.getTime() - start) / 86_400_000);
	const g = ((2 * Math.PI) / 365) * (day - 1);
	const eqTime =
		229.18 *
		(0.000075 +
			0.001868 * Math.cos(g) -
			0.032077 * Math.sin(g) -
			0.014615 * Math.cos(2 * g) -
			0.040849 * Math.sin(2 * g));
	const decl =
		0.006918 -
		0.399912 * Math.cos(g) +
		0.070257 * Math.sin(g) -
		0.006758 * Math.cos(2 * g) +
		0.000907 * Math.sin(2 * g) -
		0.002697 * Math.cos(3 * g) +
		0.00148 * Math.sin(3 * g);
	const cosH =
		(Math.cos(90.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl));
	if (cosH < -1 || cosH > 1) return null;
	const ha = Math.acos(cosH) / rad;
	const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
	const at = (minutes: number) => new Date(midnight + minutes * 60_000);
	return { sunrise: at(720 - 4 * (lon + ha) - eqTime), sunset: at(720 - 4 * (lon - ha) - eqTime) };
}
