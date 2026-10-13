// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The `monitor` toolkit (owner decision 2026-10-12): read-only looks at the
 * host's resources, for the owner's turns and Iyye's own work (effect
 * `private`: process names and system logs say what the owner is doing, so
 * never contacts). Typed probes like `system_status`: fixed commands with
 * fixed arguments (no shell), files read directly, output parsed and bounded.
 *
 * - `gpu_status`: nvidia-smi's fixed query (temperature, power draw,
 *   utilisation, clocks, performance state, throttling) and the processes on
 *   the GPU (program names only).
 * - `temperatures`: every hwmon and thermal-zone sensor.
 * - `pressure`: Linux pressure stall information (CPU, memory, I/O).
 * - `top_processes`: the busiest processes over one second, by CPU and by
 *   memory, by program name only (never command lines: they hold paths and
 *   tokens).
 * - `io_rates`: disk and network throughput over one second.
 * - `system_errors`: the system log's errors of the last 24 hours (capped,
 *   long secrets masked) and failed services.
 *
 * These are observations of the real machine, so unlike the sandbox they are
 * evidence. Each says "not available here" where its source does not exist
 * (the owner's Mac has no /proc, hwmon or nvidia-smi).
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { Type } from "typebox";
import type { IyyeTool, Toolkit } from "./broker.ts";

export const MONITOR_TOOLKIT = "monitor";

export interface MonitorDeps {
	read: (path: string) => string | null;
	list: (path: string) => string[];
	exec: (cmd: string, args: string[]) => Promise<string | null>;
	sleep: (ms: number) => Promise<void>;
}

export const realMonitorDeps: MonitorDeps = {
	read: (p) => {
		try {
			return readFileSync(p, "utf8");
		} catch {
			return null;
		}
	},
	list: (p) => {
		try {
			return readdirSync(p);
		} catch {
			return [];
		}
	},
	exec: (cmd, args) =>
		new Promise((resolve) =>
			execFile(
				cmd,
				args,
				{
					timeout: 15_000,
					maxBuffer: 1_000_000,
					env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
				},
				(err, stdout) => resolve(err ? null : stdout),
			),
		),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const NO_ARGS = Type.Object({});
const NA = "not available here";

/** Long runs of hex or base64 (keys, tokens) in log lines. */
const SECRETISH = /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g;

export function monitorToolkit(d: MonitorDeps = realMonitorDeps): Toolkit {
	const tool = (name: string, label: string, description: string, summary: string, run: () => Promise<string>) =>
		({ name, label, description, summary, parameters: NO_ARGS, run }) as IyyeTool<typeof NO_ARGS>;
	return {
		name: MONITOR_TOOLKIT,
		description: "detailed readings of the computer you run on (GPU, sensors, load, processes, logs)",
		effect: "private",
		tools: [
			tool(
				"gpu_status",
				"GPU status",
				"The GPU's temperature, power draw, utilisation, clocks, performance state and throttling, and the programs using it.",
				"the GPU's temperature, power, load, clocks and its programs",
				() => gpuStatus(d),
			),
			tool(
				"temperatures",
				"Temperatures",
				"Every temperature sensor of the computer (board, disks, network, thermal zones), in °C.",
				"every temperature sensor",
				async () => temperatures(d),
			),
			tool(
				"pressure",
				"Resource pressure",
				"How much work waited for CPU, memory or disk (Linux pressure stall information: the share of time some or all tasks were stalled, over 10 s, 60 s and 300 s). High memory or I/O pressure means the machine is struggling.",
				"how much work is stalled waiting for CPU, memory or disk",
				async () => pressure(d),
			),
			tool(
				"top_processes",
				"Top processes",
				"The busiest processes measured over one second: the top 10 by CPU and by memory, by program name.",
				"the busiest processes by CPU and memory",
				() => topProcesses(d),
			),
			tool(
				"io_rates",
				"Disk and network rates",
				"Disk reads and writes and network traffic per device, measured over one second.",
				"disk and network throughput",
				() => ioRates(d),
			),
			tool(
				"system_errors",
				"System errors",
				"The system log's errors of the last 24 hours (the latest 20) and any failed services.",
				"recent system errors and failed services",
				() => systemErrors(d),
			),
		],
	};
}

export async function gpuStatus(d: MonitorDeps): Promise<string> {
	const q = await d.exec("nvidia-smi", [
		"--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.sm,clocks.mem,pstate,clocks_throttle_reasons.active",
		"--format=csv,noheader,nounits",
	]);
	if (q === null) return `GPU: ${NA} (no nvidia-smi)`;
	const lines: string[] = [];
	for (const row of q.trim().split("\n").filter(Boolean)) {
		const [name, temp, power, util, sm, mem, pstate, throttle] = row.split(",").map((x) => x.trim());
		const v = (x: string | undefined, unit: string) => (!x || /N\/A|Not Supported/i.test(x) ? "n/a" : `${x}${unit}`);
		const reasons =
			throttle && /^0x/i.test(throttle) && Number(throttle) !== 0 ? `throttled (${throttle})` : "not throttled";
		lines.push(
			`${name}: ${v(temp, " °C")}, ${v(power, " W")}, ${v(util, " % busy")}, SM clock ${v(sm, " MHz")}, memory clock ${v(mem, " MHz")}, ${pstate ?? "?"}, ${reasons}`,
		);
	}
	const apps = await d.exec("nvidia-smi", [
		"--query-compute-apps=pid,process_name,used_memory",
		"--format=csv,noheader,nounits",
	]);
	const procs = (apps ?? "")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((r) => {
			const [pid, name, memory] = r.split(",").map((x) => x.trim());
			return `${basename(name ?? "?")} (pid ${pid}${memory && !/N\/A/i.test(memory) ? `, ${memory} MiB` : ""})`;
		});
	lines.push(`Programs on the GPU: ${procs.length ? procs.join(", ") : "none"}`);
	return lines.join("\n");
}

export function temperatures(d: MonitorDeps): string {
	const out: string[] = [];
	for (const h of d.list("/sys/class/hwmon").sort()) {
		const dir = `/sys/class/hwmon/${h}`;
		const chip = d.read(`${dir}/name`)?.trim() ?? h;
		for (const f of d
			.list(dir)
			.filter((x) => /^temp\d+_input$/.test(x))
			.sort()) {
			const milli = Number(d.read(`${dir}/${f}`)?.trim());
			if (!Number.isFinite(milli)) continue;
			const label = d.read(`${dir}/${f.replace("_input", "_label")}`)?.trim();
			// A chip with several unlabelled sensors (ACPI zones) names each by its number.
			out.push(`${chip} ${label || f.replace("_input", "")}: ${(milli / 1000).toFixed(1)} °C`);
		}
	}
	for (const z of d
		.list("/sys/class/thermal")
		.filter((x) => x.startsWith("thermal_zone"))
		.sort()) {
		const milli = Number(d.read(`/sys/class/thermal/${z}/temp`)?.trim());
		if (!Number.isFinite(milli)) continue;
		out.push(
			`${d.read(`/sys/class/thermal/${z}/type`)?.trim() ?? z} (thermal zone): ${(milli / 1000).toFixed(1)} °C`,
		);
	}
	return out.length ? out.join("\n") : `Temperatures: ${NA}`;
}

export function pressure(d: MonitorDeps): string {
	const out: string[] = [];
	for (const r of ["cpu", "memory", "io"]) {
		const text = d.read(`/proc/pressure/${r}`);
		if (text === null) continue;
		const parts: string[] = [];
		for (const line of text.trim().split("\n")) {
			const m = /^(some|full) avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/.exec(line);
			if (m) parts.push(`${m[1]} ${m[2]} % / ${m[3]} % / ${m[4]} %`);
		}
		out.push(`${r}: ${parts.join("; ")} (10 s / 60 s / 300 s)`);
	}
	return out.length
		? `Share of time tasks were stalled ("some": at least one, "full": all):\n${out.join("\n")}`
		: `Pressure: ${NA}`;
}

interface ProcSample {
	name: string;
	ticks: number;
	rssKb: number;
}

function sampleProcs(d: MonitorDeps): Map<string, ProcSample> {
	const out = new Map<string, ProcSample>();
	for (const pid of d.list("/proc").filter((x) => /^\d+$/.test(x))) {
		const stat = d.read(`/proc/${pid}/stat`);
		if (!stat) continue;
		// The name is in parentheses and may contain spaces; fields after it are fixed.
		const close = stat.lastIndexOf(")");
		const fields = stat.slice(close + 2).split(" ");
		const ticks = Number(fields[11]) + Number(fields[12]); // utime + stime
		const rss = /VmRSS:\s+(\d+)/.exec(d.read(`/proc/${pid}/status`) ?? "")?.[1];
		const name = (d.read(`/proc/${pid}/comm`) ?? stat.slice(stat.indexOf("(") + 1, close)).trim();
		out.set(pid, { name, ticks, rssKb: Number(rss ?? 0) });
	}
	return out;
}

export async function topProcesses(d: MonitorDeps): Promise<string> {
	const a = sampleProcs(d);
	if (a.size === 0) return `Processes: ${NA}`;
	await d.sleep(1000);
	const b = sampleProcs(d);
	const hz = 100; // USER_HZ on Linux
	const rows = [...b].map(([pid, s]) => ({
		pid,
		name: s.name,
		cpu: (s.ticks - (a.get(pid)?.ticks ?? s.ticks)) / hz,
		memMb: s.rssKb / 1024,
	}));
	const fmt = (r: (typeof rows)[number]) =>
		`${r.name} (pid ${r.pid}): ${(r.cpu * 100).toFixed(0)} % CPU, ${r.memMb.toFixed(0)} MB`;
	return [
		`By CPU over one second (100 % = one core), of ${rows.length} processes:`,
		...[...rows]
			.sort((x, y) => y.cpu - x.cpu)
			.slice(0, 10)
			.map((r) => `  ${fmt(r)}`),
		"By memory (resident):",
		...[...rows]
			.sort((x, y) => y.memMb - x.memMb)
			.slice(0, 10)
			.map((r) => `  ${fmt(r)}`),
	].join("\n");
}

function diskCounters(d: MonitorDeps): Map<string, { read: number; written: number }> {
	const out = new Map<string, { read: number; written: number }>();
	for (const line of (d.read("/proc/diskstats") ?? "").split("\n")) {
		const f = line.trim().split(/\s+/);
		const name = f[2];
		// Whole physical disks only: no partitions, loop or RAM devices.
		if (!name || /^(loop|ram|zram|dm-)/.test(name) || /^(nvme\d+n\d+p\d+|[sv]d[a-z]+\d+|mmcblk\d+p\d+)$/.test(name))
			continue;
		out.set(name, { read: Number(f[5]) * 512, written: Number(f[9]) * 512 });
	}
	return out;
}

function netCounters(d: MonitorDeps): Map<string, { rx: number; tx: number }> {
	const out = new Map<string, { rx: number; tx: number }>();
	for (const line of (d.read("/proc/net/dev") ?? "").split("\n").slice(2)) {
		const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
		if (!m || m[1] === "lo") continue;
		const f = m[2]!.trim().split(/\s+/);
		out.set(m[1]!, { rx: Number(f[0]), tx: Number(f[8]) });
	}
	return out;
}

export async function ioRates(d: MonitorDeps): Promise<string> {
	const da = diskCounters(d);
	const na = netCounters(d);
	if (da.size === 0 && na.size === 0) return `Disk and network rates: ${NA}`;
	await d.sleep(1000);
	const db = diskCounters(d);
	const nb = netCounters(d);
	const mb = (x: number) => `${(x / 1048576).toFixed(2)} MB/s`;
	const out = ["Over one second:"];
	for (const [k, v] of db) {
		const p = da.get(k);
		if (p) out.push(`  disk ${k}: read ${mb(v.read - p.read)}, write ${mb(v.written - p.written)}`);
	}
	for (const [k, v] of nb) {
		const p = na.get(k);
		if (p && (v.rx > 0 || v.tx > 0)) out.push(`  network ${k}: in ${mb(v.rx - p.rx)}, out ${mb(v.tx - p.tx)}`);
	}
	return out.join("\n");
}

export async function systemErrors(d: MonitorDeps): Promise<string> {
	const log = await d.exec("journalctl", [
		"-p",
		"err",
		"--since=-24h",
		"-n",
		"20",
		"--no-pager",
		"-q",
		"-o",
		"short-iso",
	]);
	const failed = await d.exec("systemctl", ["--failed", "--no-legend", "--plain"]);
	const failedUser = await d.exec("systemctl", ["--user", "--failed", "--no-legend", "--plain"]);
	if (log === null && failed === null) return `System errors: ${NA}`;
	const clean = (l: string) => {
		const s = l.replace(SECRETISH, "[masked]");
		return s.length > 220 ? `${s.slice(0, 220)}…` : s;
	};
	const lines = (log ?? "").trim().split("\n").filter(Boolean);
	const units = [...(failed ?? "").trim().split("\n"), ...(failedUser ?? "").trim().split("\n")]
		.filter(Boolean)
		.map((l) => l.split(/\s+/)[0]);
	return [
		lines.length
			? `System log errors in the last 24 hours (latest ${lines.length}):`
			: "No errors in the system log in the last 24 hours.",
		...lines.map((l) => `  ${clean(l)}`),
		units.length ? `Failed services: ${units.join(", ")}` : "No failed services.",
	].join("\n");
}
