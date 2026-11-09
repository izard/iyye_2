// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.018 W0: what each candidate probe of §3.1 returns on this machine,
 * and what it costs. Fixed commands with fixed arguments, no shell, read-only;
 * nothing is stored. Prints figures only: hardware addresses, host names and
 * network names are counted, never printed; of an address only whether it is
 * private.
 *
 *   node scripts/world-probes.ts [--du <dir>]
 *
 * `--du` also times a walk of that directory's sizes (Iyye's state directory
 * on the Spark: a few seconds, so it belongs to the night).
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { homedir, loadavg, totalmem } from "node:os";
import { join } from "node:path";

const LINUX = process.platform === "linux";
const run = (file: string, args: string[], timeout = 20_000) =>
	new Promise<string | null>((resolve) =>
		execFile(
			file,
			args,
			{
				timeout,
				maxBuffer: 8 * 1024 * 1024,
				env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
			},
			(err, stdout) => resolve(err ? null : stdout),
		),
	);
const read = (path: string) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};
const list = (path: string) => {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
};
const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cde])/i.test(ip);
const num = (s: string | undefined | null) => (s === undefined || s === null || s.trim() === "" ? null : Number(s));

type Probe = () => Promise<unknown> | unknown;
const probes: [string, Probe][] = [];
const probe = (name: string, when: boolean, f: Probe) => when && probes.push([name, f]);

// ---------------------------------------------------------------- compute

probe("compute: load", true, () => ({ load: loadavg().map((x) => Math.round(x * 100) / 100) }));
probe("compute: pressure", LINUX, () =>
	Object.fromEntries(
		["cpu", "memory", "io"].map((k) => {
			const some = /some avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/.exec(read(`/proc/pressure/${k}`) ?? "");
			return [k, some ? some.slice(1).map(Number) : null];
		}),
	),
);
probe("compute: gpu (nvidia-smi)", LINUX, async () => {
	const out = await run("nvidia-smi", [
		"--query-gpu=utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total",
		"--format=csv,noheader,nounits",
	]);
	if (out === null) return null;
	const [util, temp, power, used, total] = out
		.trim()
		.split(",")
		.map((x) => x.trim());
	return { utilPct: num(util), tempC: num(temp), powerW: num(power), memUsedMb: used, memTotalMb: total };
});
probe("memory: GPU memory of Iyye's own processes (nvidia-smi + ps)", LINUX, async () => {
	// On unified memory (the GB10) the GPU reports no total, only each program's share, and a process's
	// resident size does not include it: both are needed to say what uses the memory.
	const out = await run("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]);
	if (out === null) return null;
	const byRole = new Map<string, { n: number; gb: number }>();
	for (const row of out.trim().split("\n").filter(Boolean)) {
		const [pid, mb] = row.split(",").map((x) => x.trim());
		const args = (await run("ps", ["-o", "args=", "-p", pid!])) ?? "";
		const role = ROLES.find(([, re]) => re.test(args))?.[0] ?? "other";
		const r = byRole.get(role) ?? { n: 0, gb: 0 };
		byRole.set(role, { n: r.n + 1, gb: r.gb + Number(mb) / 1024 });
	}
	return Object.fromEntries([...byRole].map(([k, v]) => [k, { n: v.n, gb: Math.round(v.gb * 10) / 10 }]));
});
probe("compute: thermal zones", LINUX, () => {
	const zones = list("/sys/class/thermal").filter((z) => z.startsWith("thermal_zone"));
	const temps = zones.flatMap((z) => {
		const t = num(read(`/sys/class/thermal/${z}/temp`));
		return t === null ? [] : [Math.round(t / 100) / 10];
	});
	return { zones: zones.length, hottestC: temps.length ? Math.max(...temps) : null };
});
probe("compute: hwmon sensors", LINUX, () => {
	let n = 0;
	let hottest: number | null = null;
	for (const h of list("/sys/class/hwmon"))
		for (const f of list(`/sys/class/hwmon/${h}`).filter((x) => /^temp\d+_input$/.test(x))) {
			const t = num(read(`/sys/class/hwmon/${h}/${f}`));
			if (t === null) continue;
			n++;
			hottest = Math.max(hottest ?? -273, Math.round(t / 100) / 10);
		}
	return { sensors: n, hottestC: hottest };
});

// ---------------------------------------------------------------- memory

probe("memory: meminfo", LINUX, () => {
	const m = read("/proc/meminfo") ?? "";
	const gb = (k: string) => {
		const x = new RegExp(`^${k}:\\s+(\\d+) kB`, "m").exec(m);
		return x ? Math.round((Number(x[1]) / 1024 / 1024) * 10) / 10 : null;
	};
	return {
		totalGb: gb("MemTotal"),
		availableGb: gb("MemAvailable"),
		swapTotalGb: gb("SwapTotal"),
		swapFreeGb: gb("SwapFree"),
	};
});
probe("memory: vm_stat, swap (macOS)", !LINUX, async () => {
	const vm = (await run("/usr/bin/vm_stat", [])) ?? "";
	const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384);
	const pages = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
	const swap = (await run("/usr/sbin/sysctl", ["-n", "vm.swapusage"])) ?? "";
	return {
		totalGb: Math.round(totalmem() / 2 ** 30),
		freeOrInactiveGb: Math.round((((pages("Pages free") + pages("Pages inactive")) * page) / 2 ** 30) * 10) / 10,
		swapUsedMb: num(/used = ([\d.]+)M/.exec(swap)?.[1]),
	};
});
/** Iyye's own processes by role: matched on fixed words of the command line; the command line itself is never kept. */
const ROLES: [string, RegExp][] = [
	["host", /node(\S*)? .*src\/main\.ts/],
	["model router", /llama-server .*--models-preset/],
	["model instance", /llama-server .*--port \d+ (?!.*--models-preset)/],
	["long-term memory", /hindsight-api/],
	["memory database", /postgres/],
	["decision service", /kev\.serve/],
	["web search", /granian|searx/],
];
probe("memory: Iyye's own processes (ps)", true, async () => {
	const out = await run("ps", LINUX ? ["-eo", "rss=,args="] : ["-axo", "rss=,args="]);
	if (out === null) return null;
	const byRole = new Map<string, { n: number; gb: number }>();
	for (const line of out.split("\n")) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (!m) continue;
		const role = ROLES.find(([, re]) => re.test(m[2]!))?.[0];
		if (!role) continue;
		const r = byRole.get(role) ?? { n: 0, gb: 0 };
		byRole.set(role, { n: r.n + 1, gb: r.gb + Number(m[1]) / 1024 / 1024 });
	}
	return Object.fromEntries([...byRole].map(([k, v]) => [k, { n: v.n, gb: Math.round(v.gb * 10) / 10 }]));
});

// ---------------------------------------------------------------- storage

const REAL_FS = new Set(["ext4", "xfs", "btrfs", "zfs", "apfs", "f2fs", "vfat", "exfat", "ntfs"]);
probe("storage: filesystems", true, async () => {
	let mounts: string[] = [];
	if (LINUX)
		mounts = (read("/proc/mounts") ?? "")
			.split("\n")
			.map((l) => l.split(" "))
			.filter((p) => REAL_FS.has(p[2] ?? "") && !/^\/(boot|snap|var\/snap)/.test(p[1] ?? ""))
			.map((p) => p[1]!);
	else {
		const out = (await run("/sbin/mount", [])) ?? "";
		mounts = out
			.split("\n")
			.flatMap((l) => (/ on (\/\S*) \((apfs|exfat|msdos)/.exec(l)?.[1] ?? []) as string | string[])
			.filter((m) => m === "/" || m === "/System/Volumes/Data" || m.startsWith("/Volumes/"));
	}
	return [...new Set(mounts)].map((m, i) => {
		const s = statfsSync(m);
		const gb = (b: number) => Math.round((b * s.bsize) / 2 ** 30);
		// A mount point's name can be a volume label: only "/" and the home's filesystem are named.
		return { mount: m === "/" ? "/" : `#${i}`, totalGb: gb(s.blocks), freeGb: gb(s.bavail) };
	});
});

// ---------------------------------------------------------------- network, LAN

/** `iw dev <interface> link`: the signal and the link rate (`/proc/net/wireless` is empty with this driver). */
async function iwLink(ifname: string): Promise<{ signalDbm: number | null; rateMbit: number | null }> {
	const out = (await run("iw", ["dev", ifname, "link"])) ?? "";
	return {
		signalDbm: num(/signal: (-?\d+) dBm/.exec(out)?.[1]),
		rateMbit: num(/tx bitrate: ([\d.]+) MBit/.exec(out)?.[1]),
	};
}
probe("network: interfaces", true, async () => {
	if (LINUX) {
		const out = await run("ip", ["-j", "link"]);
		if (out === null) return null;
		return Promise.all(
			(JSON.parse(out) as { ifname: string; operstate: string; link_type: string }[])
				.filter((l) => l.link_type === "ether")
				.map(async (l) => ({
					kind: /^wl/.test(l.ifname) ? "wifi" : /^(docker|br-|veth|virbr)/.test(l.ifname) ? "virtual" : "ethernet",
					state: l.operstate,
					...(/^wl/.test(l.ifname) ? await iwLink(l.ifname) : {}),
				})),
		);
	}
	const out = (await run("/sbin/ifconfig", [])) ?? "";
	return out
		.split(/\n(?=\S)/)
		.filter((b) => /^en\d/.test(b))
		.map((b) => ({ state: /status: active/.test(b) ? "UP" : "DOWN", hasAddress: /\binet \d/.test(b) }));
});
probe("network: default route, gateway", true, async () => {
	if (LINUX) {
		const route = (await run("ip", ["route", "show", "default"])) ?? "";
		const gw = /^default via (\S+) dev (\S+)/m.exec(route);
		const neigh = gw ? ((await run("ip", ["neigh", "show", gw[1]!])) ?? "") : "";
		return {
			defaultRoute: Boolean(gw),
			gatewayPrivate: gw ? isPrivate(gw[1]!) : null,
			gatewayState: /\b(REACHABLE|STALE|DELAY|PROBE|FAILED|INCOMPLETE)\b/.exec(neigh)?.[1] ?? null,
		};
	}
	const route = (await run("/sbin/route", ["-n", "get", "default"])) ?? "";
	const gw = /gateway:\s*(\S+)/.exec(route)?.[1];
	return { defaultRoute: Boolean(gw), gatewayPrivate: gw ? isPrivate(gw) : null };
});
probe("lan: neighbour table (passive)", true, async () => {
	const rows: { ip: string; mac: string | null; state: string }[] = [];
	if (LINUX) {
		const out = await run("ip", ["-j", "neigh"]);
		if (out === null) return null;
		for (const n of JSON.parse(out) as { dst: string; lladdr?: string; state?: string[] }[])
			rows.push({ ip: n.dst, mac: n.lladdr ?? null, state: (n.state ?? []).join(",") });
	} else {
		const out = (await run("/usr/sbin/arp", ["-an"])) ?? "";
		for (const l of out.split("\n")) {
			const m = /\(([\d.]+)\) at (\S+)/.exec(l);
			if (m) rows.push({ ip: m[1]!, mac: m[2] === "(incomplete)" ? null : m[2]!, state: "" });
		}
	}
	const v4 = rows.filter((r) => /^\d+\./.test(r.ip) && !/^(224\.|239\.|255\.)/.test(r.ip) && !/\.255$/.test(r.ip));
	return {
		entries: rows.length,
		ipv4Hosts: v4.length,
		withHardwareAddress: v4.filter((r) => r.mac && r.mac !== "ff:ff:ff:ff:ff:ff").length,
		allPrivate: v4.every((r) => isPrivate(r.ip)),
		states: [...new Set(rows.map((r) => r.state).filter(Boolean))],
	};
});

// ---------------------------------------------------------------- devices

probe("devices: displays, cameras, sound", LINUX, () => ({
	displaysConnected: list("/sys/class/drm").filter(
		(d) => (read(`/sys/class/drm/${d}/status`) ?? "").trim() === "connected",
	).length,
	connectors: list("/sys/class/drm").filter((d) => /-/.test(d)).length,
	videoDevices: list("/dev").filter((d) => /^video\d+$/.test(d)).length,
	soundCards: ((read("/proc/asound/cards") ?? "").match(/^\s*\d+ \[/gm) ?? []).length,
}));
probe("devices: displays, cameras, sound (system_profiler)", !LINUX, async () => {
	const out = await run(
		"/usr/sbin/system_profiler",
		["-json", "SPDisplaysDataType", "SPCameraDataType", "SPAudioDataType"],
		60_000,
	);
	if (out === null) return null;
	const j = JSON.parse(out) as Record<string, { spdisplays_ndrvs?: unknown[]; _items?: unknown[] }[]>;
	return {
		displays: (j.SPDisplaysDataType ?? []).reduce((n, g) => n + (g.spdisplays_ndrvs?.length ?? 0), 0),
		cameras: (j.SPCameraDataType ?? []).length,
		audioDevices: (j.SPAudioDataType ?? []).reduce((n, g) => n + (g._items?.length ?? 0), 0),
	};
});

// ---------------------------------------------------------------- lifecycle (added by W0: see SPIKE-0.018.md)

probe("lifecycle: what this process runs under", true, async () => {
	const tty = process.stdout.isTTY || process.stderr.isTTY;
	// The chain of parents by program name only: a host under sshd ends with the owner's login.
	const chain: string[] = [];
	let pid = process.ppid;
	for (let i = 0; i < 8 && pid > 1; i++) {
		const out = await run("ps", ["-o", "ppid=,comm=", "-p", String(pid)]);
		const m = /^\s*(\d+)\s+(.*)$/.exec((out ?? "").trim());
		if (!m) break;
		chain.push(m[2]!.trim().split("/").at(-1)!.replace(/:.*$/, ""));
		pid = Number(m[1]);
	}
	return {
		outputIsTerminal: tty,
		parents: chain,
		underSsh: chain.some((c) => /^sshd/.test(c)),
		underServiceManager: chain.length === 0 || /^(systemd|launchd)$/.test(chain.at(-1) ?? ""),
		uptimeS: Math.round(process.uptime()),
		machineUpDays: LINUX
			? Math.round((Number((read("/proc/uptime") ?? "0").split(" ")[0]) / 86_400) * 10) / 10
			: null,
	};
});

// ---------------------------------------------------------------- run

const duDir = process.argv.includes("--du") ? process.argv[process.argv.indexOf("--du") + 1] : undefined;
if (duDir)
	probe(
		`storage: sizes under ${duDir === join(homedir(), ".iyye2") ? "~/.iyye2" : "the given directory"} (du)`,
		true,
		async () => {
			const out = await run(
				"du",
				LINUX
					? ["-s", "--block-size=1M", ...list(duDir).map((d) => join(duDir, d))]
					: ["-sm", ...list(duDir).map((d) => join(duDir, d))],
				120_000,
			);
			if (out === null) return null;
			const rows = out
				.trim()
				.split("\n")
				.map((l) => ({ mb: Number(l.split("\t")[0]), name: l.split("\t")[1]!.split("/").at(-1)! }))
				.sort((a, b) => b.mb - a.mb);
			return {
				entries: rows.length,
				totalGb: Math.round(rows.reduce((a, r) => a + r.mb, 0) / 102.4) / 10,
				largest: rows.slice(0, 5).map((r) => `${r.name} ${Math.round(r.mb / 102.4) / 10} GB`),
			};
		},
	);

console.log(`platform ${process.platform} ${process.arch}, node ${process.versions.node}`);
let total = 0;
for (const [name, f] of probes) {
	const t0 = performance.now();
	let result: unknown;
	try {
		result = await f();
	} catch (err) {
		result = { error: (err as Error).message.slice(0, 120) };
	}
	const ms = performance.now() - t0;
	if (!name.includes("(du)") && !name.includes("system_profiler")) total += ms;
	console.log(`${name} · ${ms.toFixed(0)} ms · ${result === null ? "not available" : JSON.stringify(result)}`);
}
console.log(`the periodic probes together: ${total.toFixed(0)} ms (the directory walk and system_profiler apart)`);
