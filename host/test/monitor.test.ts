// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The `monitor` toolkit (owner decision 2026-10-12) over a fake /proc, /sys
 * and fake commands: parsed readings, program names only (never command
 * lines), long secrets in log lines masked, "not available here" without a
 * source, and only the owner and Iyye's own work get it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { silentLogger } from "../src/log.ts";
import { openDb } from "../src/state/db.ts";
import { ToolBroker } from "../src/tools/broker.ts";
import {
	gpuStatus,
	ioRates,
	type MonitorDeps,
	monitorToolkit,
	pressure,
	systemErrors,
	temperatures,
	topProcesses,
} from "../src/tools/monitor.ts";

/** A fake machine: files by path (a function of the sample number for counters), commands by name. */
function fake(files: Record<string, string | ((n: number) => string)>, cmds: Record<string, string | null> = {}) {
	let n = 0;
	const deps: MonitorDeps = {
		read: (p) => {
			const f = files[p];
			return f === undefined ? null : typeof f === "function" ? f(n) : f;
		},
		list: (p) => {
			const prefix = p.endsWith("/") ? p : `${p}/`;
			return [
				...new Set(
					Object.keys(files)
						.filter((k) => k.startsWith(prefix))
						.map((k) => k.slice(prefix.length).split("/")[0]!),
				),
			];
		},
		exec: async (cmd, args) => {
			const key = `${cmd} ${args.join(" ")}`;
			const hit = Object.keys(cmds).find((k) => key.startsWith(k));
			return hit === undefined ? null : cmds[hit]!;
		},
		sleep: async () => {
			n++;
		},
	};
	return deps;
}

test("gpu_status parses nvidia-smi's fixed query and names programs by their file name only", async () => {
	const d = fake(
		{},
		{
			"nvidia-smi --query-gpu": "NVIDIA GB10, 40, 11.89, 7, 2411, [N/A], P0, 0x0000000000000000\n",
			"nvidia-smi --query-compute-apps": "4242, /home/owner/llama.cpp/build/bin/llama-server, [N/A]\n",
		},
	);
	const out = await gpuStatus(d);
	assert.match(
		out,
		/^NVIDIA GB10: 40 °C, 11\.89 W, 7 % busy, SM clock 2411 MHz, memory clock n\/a, P0, not throttled/,
	);
	assert.match(out, /Programs on the GPU: llama-server \(pid 4242\)/);
	assert.ok(!out.includes("/home/owner"));
	assert.match(await gpuStatus(fake({})), /not available here/);
});

test("temperatures, pressure", () => {
	const d = fake({
		"/sys/class/hwmon/hwmon0/name": "acpitz\n",
		"/sys/class/hwmon/hwmon0/temp1_input": "41500\n",
		"/sys/class/hwmon/hwmon1/name": "nvme\n",
		"/sys/class/hwmon/hwmon1/temp1_input": "38850\n",
		"/sys/class/hwmon/hwmon1/temp1_label": "Composite\n",
		"/sys/class/thermal/thermal_zone0/type": "soc\n",
		"/sys/class/thermal/thermal_zone0/temp": "52000\n",
		"/proc/pressure/memory":
			"some avg10=1.50 avg60=0.40 avg300=0.10 total=1\nfull avg10=0.20 avg60=0.00 avg300=0.00 total=1\n",
	});
	assert.equal(temperatures(d), "acpitz temp1: 41.5 °C\nnvme Composite: 38.9 °C\nsoc (thermal zone): 52.0 °C");
	assert.match(pressure(d), /memory: some 1\.50 % \/ 0\.40 % \/ 0\.10 %; full 0\.20 %/);
	assert.match(temperatures(fake({})), /not available here/);
});

test("top_processes over one second, by program name, never command lines", async () => {
	const stat = (pid: number, ticks: (n: number) => number) => (n: number) =>
		`${pid} (llama server) S 1 1 1 0 -1 0 0 0 0 0 ${ticks(n)} 0 0 0 20 0 1 0 0 0 0`;
	const d = fake({
		"/proc/10/stat": stat(10, (n) => 1000 + n * 150),
		"/proc/10/comm": "llama-server\n",
		"/proc/10/status": "VmRSS:\t30000000 kB\n",
		"/proc/10/cmdline": "llama-server\0--api-key\0SECRET",
		"/proc/11/stat": stat(11, (n) => 5 + n),
		"/proc/11/comm": "node\n",
		"/proc/11/status": "VmRSS:\t200000 kB\n",
	});
	const out = await topProcesses(d);
	assert.match(
		out,
		/By CPU .*\n {2}llama-server \(pid 10\): 150 % CPU, 29297 MB\n {2}node \(pid 11\): 1 % CPU, 195 MB/,
	);
	assert.ok(!out.includes("SECRET") && !out.includes("--api-key"));
});

test("io_rates: whole disks and network interfaces over one second", async () => {
	const d = fake({
		"/proc/diskstats": (n) =>
			[
				`259 0 nvme0n1 1 0 ${1000 + n * 2048} 0 1 0 ${2000 + n * 4096} 0 0 0 0`,
				`259 1 nvme0n1p1 1 0 ${1000 + n * 2048} 0 1 0 0 0 0 0 0`,
				"7 0 loop0 1 0 5 0 1 0 5 0 0 0 0",
			].join("\n"),
		"/proc/net/dev": (n) =>
			`Inter-|\n face |\n    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n  eth0: ${n * 1048576} 0 0 0 0 0 0 0 ${n * 524288} 0 0 0 0 0 0 0\n`,
	});
	const out = await ioRates(d);
	assert.match(out, /disk nvme0n1: read 1\.00 MB\/s, write 2\.00 MB\/s/);
	assert.ok(!/nvme0n1p1|loop0|\blo\b/.test(out));
	assert.match(out, /network eth0: in 1\.00 MB\/s, out 0\.50 MB\/s/);
});

test("system_errors: capped, long secrets masked, failed services", async () => {
	const d = fake(
		{},
		{
			"journalctl -p err": `2026-10-12T21:15:09+0200 spark kernel: Memory cgroup out of memory: Killed process 1 (python3)\n2026-10-12T21:16:00+0200 spark app: bad token ${"Ab9".repeat(12)}\n`,
			"systemctl --failed": "foo.service loaded failed failed Foo\n",
			"systemctl --user --failed": "",
		},
	);
	const out = await systemErrors(d);
	assert.match(out, /latest 2/);
	assert.match(out, /bad token \[masked\]/);
	assert.match(out, /Failed services: foo\.service/);
	assert.match(await systemErrors(fake({})), /not available here/);
});

test("the owner and Iyye's own work get the toolkit; contacts never do", () => {
	const b = new ToolBroker({ db: openDb(":memory:"), log: silentLogger, toolkits: [monitorToolkit(fake({}))] });
	assert.equal(b.forSession({ scope: "owner", principal: "owner" }).names.length, 6);
	assert.equal(b.forSession({ scope: "iyye:inv:1", principal: "iyye" }).names.length, 6);
	assert.equal(b.forSession({ scope: "contact:x", principal: "contact", trusted: true }).names.length, 0);
});
