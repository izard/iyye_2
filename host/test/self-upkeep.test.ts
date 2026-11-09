// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.018 W1: the machine's vitals, what uses memory and disk, the host's
 * runs and the nights. Probes run on captured outputs; nothing here calls the
 * real `ps`, `nvidia-smi` or `du`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { silentLogger } from "../src/log.ts";
import { machineDomain } from "../src/observe/domains.ts";
import { SelfModel } from "../src/self/model.ts";
import type { Exec } from "../src/self/probes.ts";
import { foldReadings, hourly, machineKey, recordReadings } from "../src/self/readings.ts";
import { classifyUnder, type RhythmState, recentNights, recentRuns, trackNight } from "../src/self/runs.ts";
import { SelfUpkeep } from "../src/self/upkeep.ts";
import {
	hottest,
	parseAliases,
	parseDevicesMac,
	parseGpu,
	parseGpuApps,
	parseMeminfo,
	parsePressure,
	parsePs,
	parseSwapUsage,
	useByRole,
} from "../src/self/vitals.ts";
import { openDb } from "../src/state/db.ts";
import { systemStatusTool } from "../src/tools/probes.ts";

const T0 = new Date("2026-11-09T20:00:00Z");
const MIN = 60_000;
const H = 3_600_000;
const after = (ms: number) => new Date(T0.getTime() + ms);

const MEMINFO = [
	"MemTotal:       127599740 kB",
	"MemFree:         2000000 kB",
	"MemAvailable:   47815884 kB",
	"SwapTotal:      16777212 kB",
	"SwapFree:       16357784 kB",
].join("\n");
const PRESSURE = "some avg10=0.00 avg60=1.25 avg300=0.40 total=123\nfull avg10=0.00 avg60=0.10 avg300=0.00 total=9\n";
/** The host (100) started the router (200), Hindsight (500) and Kev (400); PostgreSQL (600) is its own daemon. */
const PS = [
	"    1     0   12000",
	"  100    50  204800", // the host
	"  200   100  262144", // the router
	"  300   200 4194304", // a model instance
	"  301   200 1048576", // another
	"  400   100 2726297", // the decision service
	"  500   100 2097152", // long-term memory
	"  600     1  104857", // the memory database
	"  601   600   52428", // one of its workers
	"  900     1 9999999", // somebody else's process
].join("\n");
const ALIASES = [
	"  300 /home/someone/llama.cpp/bin/llama-server --host 127.0.0.1 --port 47201 --alias gemma-4-26B --model /secret/path/a.gguf",
	"  301 /home/someone/llama.cpp/bin/llama-server --host 127.0.0.1 --port 56903 --alias gemma-4-E4B --model /secret/path/b.gguf",
].join("\n");
const GPU_APPS = "300, 29923\n301, 6420\n400, 15928\n500, 845\n900, 111\n";
const ROOTS = [
	{ role: "the host", pid: 100 },
	{ role: "the model router", pid: 200, router: true },
	{ role: "long-term memory", pid: 500 },
	{ role: "the memory database", pid: 600 },
	{ role: "the decision service", pid: 400 },
	{ role: "web search", pid: 0 }, // not running
];

describe("vitals parsers keep only their listed fields", () => {
	test("pressure, the GPU (no memory figure on unified memory) and the hottest sensor", () => {
		assert.equal(parsePressure(PRESSURE), 1.25);
		assert.equal(parsePressure(null), null);
		assert.deepEqual(parseGpu("3, 41, 12.5\n"), { gpuUtilPct: 3, gpuTempC: 41, gpuPowerW: 12.5 });
		assert.deepEqual(parseGpu("[N/A], [N/A], [N/A]\n"), { gpuUtilPct: null, gpuTempC: null, gpuPowerW: null });
		assert.deepEqual(parseGpu(null), { gpuUtilPct: null, gpuTempC: null, gpuPowerW: null });
		assert.equal(hottest(["40800\n", "38000", null, "0", "999999000"]), 40.8);
		assert.equal(hottest([]), null);
	});

	test("memory and swap, on Linux and macOS", () => {
		assert.deepEqual(parseMeminfo(MEMINFO), { totalGb: 121.7, availableGb: 45.6, swapTotalGb: 16, swapUsedGb: 0.4 });
		assert.deepEqual(parseSwapUsage("total = 4096.00M  used = 3027.25M  free = 1068.75M  (encrypted)"), {
			swapTotalGb: 4,
			swapUsedGb: 3,
		});
		assert.deepEqual(parseSwapUsage(null), { swapTotalGb: null, swapUsedGb: null });
	});

	test("memory by role: each process to its nearest root, models by alias, the GPU's share joined, others left out", () => {
		const use = useByRole(parsePs(PS), ROOTS, parseAliases(ALIASES), parseGpuApps(GPU_APPS));
		assert.deepEqual(use, [
			{ role: "model gemma-4-26B", processes: 1, residentGb: 4, gpuGb: 29.2 },
			{ role: "the decision service", processes: 1, residentGb: 2.6, gpuGb: 15.6 },
			{ role: "model gemma-4-E4B", processes: 1, residentGb: 1, gpuGb: 6.3 },
			{ role: "long-term memory", processes: 1, residentGb: 2, gpuGb: 0.8 },
			{ role: "the model router", processes: 1, residentGb: 0.3, gpuGb: 0 },
			{ role: "the host", processes: 1, residentGb: 0.2, gpuGb: 0 },
			{ role: "the memory database", processes: 2, residentGb: 0.1, gpuGb: 0 },
		]);
		assert.ok(!/secret|someone|47201|9999999/.test(JSON.stringify(use)), "no path, port or foreign process");
		// Where the GPU's shares cannot be read (macOS), they are unknown, not zero.
		assert.equal(useByRole(parsePs(PS), ROOTS, new Map(), null)[0]!.gpuGb, null);
		// A router's child with no alias stays with the router.
		assert.equal(
			useByRole(parsePs(PS), ROOTS, new Map(), null).find((u) => u.role === "the model router")!.processes,
			3,
		);
	});

	test("devices are counts", () => {
		const d = parseDevicesMac(
			JSON.stringify({
				SPDisplaysDataType: [{ spdisplays_ndrvs: [{ _name: "SECRET DISPLAY" }] }],
				SPCameraDataType: [{ _name: "SECRET CAMERA" }, { _name: "Another" }],
				SPAudioDataType: [{ _items: [{}, {}, {}] }],
			}),
		);
		assert.deepEqual(d, { displays: 1, cameras: 2, audio: 3 });
	});

	test("what the host runs under, from its parents' program names", () => {
		const t = { service: false, terminal: true };
		assert.deepEqual(classifyUnder(["bash", "sshd", "sshd", "sshd"], t), {
			kind: "an SSH session",
			endsWithLogin: true,
			parents: ["bash", "sshd", "sshd", "sshd"],
		});
		// tmux started from an SSH session outlives it.
		assert.equal(classifyUnder(["bash", "tmux", "systemd"], t).kind, "tmux");
		assert.equal(classifyUnder(["bash", "tmux", "systemd"], t).endsWithLogin, false);
		assert.equal(classifyUnder(["zsh", "login", "Terminal"], t).kind, "a terminal");
		assert.equal(classifyUnder(["systemd"], { service: true, terminal: false }).kind, "a service manager");
		assert.equal(classifyUnder([], { service: false, terminal: false }).kind, "unknown");
	});
});

describe("the history of readings", () => {
	test("a week of readings, then hours; a field's hours come from both; a new machine is a new history", () => {
		const db = openDb(":memory:");
		const spark = machineKey({ machine: "NVIDIA DGX Spark", chip: "GB10", memoryGb: 122 });
		assert.match(spark, /^[0-9a-f]{8}$/);
		assert.notEqual(spark, machineKey({ machine: "MacBook Pro", chip: "Apple M3 Max", memoryGb: 128 }));
		assert.equal(machineKey({}), "unknown");
		const old = after(-9 * 24 * H);
		// Nine days ago, 20:00–20:50: 40, 50, 60. An hour ago: 30. A value that could not be read leaves no row.
		for (const [i, v] of [40, 50, 60].entries())
			recordReadings(
				db,
				spark,
				"memory",
				{ availableGb: v, swapUsedGb: null },
				new Date(old.getTime() + i * 20 * MIN),
			);
		recordReadings(db, spark, "memory", { availableGb: 30 }, after(-H));
		recordReadings(db, "othermac", "memory", { availableGb: 999 }, after(-H));
		assert.equal((db.prepare("SELECT count(*) AS n FROM self_readings").get() as { n: number }).n, 5);
		foldReadings(db, T0);
		foldReadings(db, T0); // again: nothing counted twice
		assert.equal((db.prepare("SELECT count(*) AS n FROM self_readings").get() as { n: number }).n, 2);
		const hours = hourly(db, "memory", "availableGb", spark, after(-10 * 24 * H));
		assert.deepEqual(hours, [
			{ hour: old.toISOString().slice(0, 13), min: 40, mean: 50, max: 60, n: 3 },
			{ hour: after(-H).toISOString().slice(0, 13), min: 30, mean: 30, max: 30, n: 1 },
		]);
		// Hours older than 90 days go.
		foldReadings(db, after(100 * 24 * H));
		assert.equal((db.prepare("SELECT count(*) AS n FROM self_readings_hourly").get() as { n: number }).n, 0);
	});
});

describe("nights", () => {
	const state = (o: Partial<RhythmState>): RhythmState => ({
		mode: "asleep",
		sleptAt: null,
		reason: null,
		lastNightAt: null,
		interruptedAt: null,
		summary: null,
		...o,
	});
	const window = (at: Date) => at.getUTCHours() >= 1 && at.getUTCHours() < 5;

	test("a row per sleep, closed when awake: in the window or not, completed or interrupted", () => {
		const db = openDb(":memory:");
		assert.equal(trackNight(db, state({}), T0, window), false, "never slept");
		const slept = "2026-11-10T01:00:05.000Z";
		assert.equal(
			trackNight(db, state({ sleptAt: slept, reason: "the rest window" }), after(5 * H + MIN), window),
			true,
		);
		assert.equal(trackNight(db, state({ sleptAt: slept }), after(5 * H + 2 * MIN), window), false, "still asleep");
		const done = state({
			mode: "awake",
			sleptAt: slept,
			lastNightAt: "2026-11-10T01:20:00.000Z",
			summary: "2 moved",
		});
		assert.equal(trackNight(db, done, after(6 * H), window), true);
		assert.equal(trackNight(db, done, after(6 * H + MIN), window), false);
		// A catch-up by day, which the owner interrupts.
		const day = "2026-11-10T10:46:00.000Z";
		trackNight(db, state({ sleptAt: day, reason: "catch-up" }), after(15 * H), window);
		trackNight(
			db,
			state({
				mode: "awake",
				sleptAt: day,
				lastNightAt: "2026-11-10T01:20:00.000Z",
				interruptedAt: "2026-11-10T10:47:30.000Z",
			}),
			after(15 * H),
			window,
		);
		assert.deepEqual(recentNights(db), [
			{
				slept_at: day,
				woke_at: "2026-11-10T10:47:30.000Z",
				reason: "catch-up",
				in_window: 0,
				completed: 0,
				summary: null,
			},
			{
				slept_at: slept,
				woke_at: "2026-11-10T01:20:00.000Z",
				reason: "the rest window",
				in_window: 1,
				completed: 1,
				summary: "2 moved",
			},
		]);
	});
});

// ---------------------------------------------------------------- the upkeep, on a real self model

function rig(
	parents: [number, string][] = [
		[50, "40 bash"],
		[40, "30 tmux: server"],
		[30, "1 systemd"],
	],
) {
	const db = openDb(":memory:");
	const clock = { now: T0 };
	const mode = { m: "awake" as "awake" | "asleep" };
	const rhythm = { s: null as RhythmState | null };
	const dir = mkdtempSync(join(tmpdir(), "iyye-upkeep-"));
	writeFileSync(join(dir, "model.gguf"), Buffer.alloc(1024 * 1024));
	const calls: string[] = [];
	const exec: Exec = async (file, args) => {
		calls.push(`${file} ${args.join(" ")}`);
		if (file === "nvidia-smi") return args[0]!.startsWith("--query-gpu") ? "3, 41, 12.5\n" : GPU_APPS;
		if (file === "ps" && args[1] === "pid=,ppid=,rss=") return PS;
		if (file === "ps" && args[1] === "pid=,args=") return ALIASES;
		if (file === "ps" && args[1] === "ppid=,comm=")
			return parents.find(([pid]) => String(pid) === args[3])?.[1] ?? "";
		if (file === "du") return `${args[1] === join(dir, "voice") ? 20 * 2 ** 20 : 2 ** 19}\t${args[1]}\n`;
		throw new Error(`unexpected command ${file}`);
	};
	const self = new SelfModel({
		db,
		log: silentLogger,
		mode: () => mode.m,
		repoDir: dir,
		hostDir: dir,
		llamaServer: "/x/build_27/bin/llama-server",
		geoHttp: null,
		now: () => clock.now,
	});
	self.setFacet("hardware", { machine: "NVIDIA DGX Spark", chip: "GB10", memoryGb: 122 }, "probe", null, T0);
	let seq = 0;
	const make = () => {
		const u = new SelfUpkeep({
			db,
			log: silentLogger,
			self,
			mode: () => mode.m,
			processes: () => ROOTS,
			paths: { home: dir, state: dir },
			dirs: () => ({ "state/voice": join(dir, "voice"), "state/logs": join(dir, "logs") }),
			models: () => [
				{ name: "gemma-4-E4B", path: join(dir, "model.gguf") },
				{ name: "elsewhere@mbp", path: null },
			],
			rhythm: () =>
				rhythm.s ?? {
					mode: mode.m,
					sleptAt: null,
					reason: null,
					lastNightAt: null,
					interruptedAt: null,
					summary: null,
				},
			inRestWindow: (at) => at.getUTCHours() >= 1 && at.getUTCHours() < 5,
			process: { ppid: 50, env: {}, terminal: true },
			exec,
			readFile: (p) =>
				p === "/proc/meminfo"
					? MEMINFO
					: p.startsWith("/proc/pressure/")
						? PRESSURE
						: p.endsWith("/temp")
							? "40800"
							: null,
			listDir: (p) => (p === "/sys/class/thermal" ? ["thermal_zone0", "cooling_device0"] : []),
			platform: "linux",
			now: () => clock.now,
			newId: () => `run-${++seq}`,
			timezone: "UTC",
		});
		self.attach(u);
		return u;
	};
	return { db, clock, mode, rhythm, self, make, calls, dir };
}

describe("the upkeep", () => {
	test("asleep it still records load, memory and disk, and nothing else; awake also devices and models", async () => {
		const r = rig();
		r.mode.m = "asleep";
		const u = r.make();
		await u.tick();
		const facets = () =>
			(r.db.prepare("SELECT DISTINCT facet FROM self_facts ORDER BY facet").all() as { facet: string }[]).map(
				(x) => x.facet,
			);
		assert.deepEqual(facets(), ["compute", "hardware", "lifecycle", "memory", "models", "storage"]);
		// Asleep the models facet holds only what the memory probe saw loaded.
		assert.deepEqual(r.self.value("models", "gemma-4-26B"), { residentGb: 4, gpuGb: 29.2 });
		assert.equal(r.self.value("models", "elsewhere@mbp"), null);
		assert.equal(r.self.value("compute", "memoryPressure"), 1.25);
		assert.equal(r.self.value("compute", "hottestC"), 40.8);
		assert.equal(r.self.value("memory", "swapUsedGb"), 0.4, "swap on Linux");
		r.mode.m = "awake";
		r.clock.now = after(MIN);
		await u.tick();
		assert.deepEqual(facets(), ["compute", "devices", "hardware", "lifecycle", "memory", "models", "storage"]);
		assert.deepEqual(r.self.value("models", "gemma-4-E4B"), { residentGb: 1, gpuGb: 6.3, fileGb: 0 });
		assert.deepEqual(r.self.value("models", "elsewhere@mbp"), { fileGb: null });
		// Every numeric field is a reading, keyed by the machine; not probed again within its ten minutes.
		const readings = r.db
			.prepare("SELECT facet, field, value, machine FROM self_readings ORDER BY facet, field")
			.all() as {
			facet: string;
			field: string;
			value: number;
			machine: string;
		}[];
		assert.equal(readings.filter((x) => x.field === "availableGb").length, 1);
		assert.deepEqual(
			readings.filter((x) => x.facet === "memory").map((x) => x.field),
			[
				"availableGb",
				"gpu:long-term memory",
				"gpu:model gemma-4-26B",
				"gpu:model gemma-4-E4B",
				"gpu:the decision service",
				"gpu:the host",
				"gpu:the memory database",
				"gpu:the model router",
				"iyyeGpuGb",
				"iyyeResidentGb",
				"resident:long-term memory",
				"resident:model gemma-4-26B",
				"resident:model gemma-4-E4B",
				"resident:the decision service",
				"resident:the host",
				"resident:the memory database",
				"resident:the model router",
				"swapUsedGb",
			],
		);
		assert.equal(readings.find((x) => x.field === "iyyeGpuGb")!.value, 51.9);
		assert.equal(readings.find((x) => x.field === "size:state/voice")!.value, 20);
		assert.ok(
			readings.every((x) => x.machine === machineKey({ machine: "NVIDIA DGX Spark", chip: "GB10", memoryGb: 122 })),
		);
		r.clock.now = after(11 * MIN);
		await u.tick();
		assert.equal(
			(r.db.prepare("SELECT count(*) AS n FROM self_readings WHERE field = 'availableGb'").get() as { n: number }).n,
			2,
		);
		assert.equal(r.calls.filter((c) => c.startsWith("du ")).length, 2, "sizes once a day");
	});

	test("/self memory, disk and history answer from records; the owner's note says what holds the memory", async () => {
		const r = rig();
		const u = r.make();
		await u.tick();
		const mem = r.self.command(["memory"], "owner_web");
		assert.match(mem, /^memory \[just now\]: 45\.6 GB of 121\.7 GB available; swap 0\.4 of 16 GB used/);
		assert.match(mem, /model gemma-4-26B — 4\.0 \+ 29\.2/);
		assert.match(mem, /the memory database \(2 processes\) — 0\.1 \+ 0\.0/);
		assert.match(mem, /in all — 10\.2 \+ 51\.9/);
		const disk = r.self.command(["disk"], "owner_web");
		assert.match(disk, /home, state — [\d.]+ GB free of [\d.]+ GB/);
		assert.match(disk, /state\/voice — 20\.0\n {2}state\/logs — 0\.5/);
		assert.ok(!disk.includes(r.dir), "no path");
		assert.match(r.self.command(["history"], "owner_web"), /memory\.availableGb/);
		assert.match(
			r.self.command(["history", "memory.availableGb"], "owner_web"),
			/memory\.availableGb, the last 2 day\(s\), by the hour.*\n {2}2026-11-09 20h {2}45\.6 {2}\(45\.6 to 45\.6\)/,
		);
		assert.match(r.self.command(["history", "nothing.here"], "owner_web"), /no history/);
		const note = r.self.aboutMe(null);
		assert.match(note, /What your own processes hold .*model gemma-4-26B 33\.2, the decision service 18\.2/);
		assert.match(note, /This run: started just now, under tmux\./);
		// The owner's command reaches it; the old ones still work.
		const ctx = { models: {} as never, db: r.db, issuer: "owner_web", self: r.self };
		assert.match((await handleOwnerCommand("/self memory", ctx)).reply!, /what Iyye's own processes hold/);
		assert.match((await handleOwnerCommand("/self", ctx)).reply!, /more: \/self memory/);
		assert.match(r.self.command(["set", "place", "Munich"], "owner_web"), /noted/);
	});

	test("runs: a killed run is known at the next start, with how long nothing ran; a shutdown is known too", async () => {
		const r = rig([
			[50, "40 bash"],
			[40, "30 sshd: someone@pts/1"],
			[30, "1 sshd"],
		]);
		const first = r.make();
		await first.tick();
		assert.equal(r.self.value("lifecycle", "under"), "an SSH session");
		assert.equal(r.self.value("lifecycle", "endsWithLogin"), true);
		assert.equal(r.self.value("lifecycle", "previousRunEnded"), null);
		assert.ok(!JSON.stringify(recentRuns(r.db)).includes("someone"), "the session's user is not kept");
		// It keeps running for three hours, then the login ends and takes it along: no shutdown.
		r.clock.now = after(3 * H);
		await first.tick();
		await first.stop();
		// 8.5 hours later the owner starts it again, in tmux.
		r.clock.now = after(11.5 * H);
		const second = rigRestart(r, [
			[50, "40 bash"],
			[40, "30 tmux: server"],
			[30, "1 systemd"],
		]);
		await second.tick();
		assert.equal(r.self.value("lifecycle", "previousRunEnded"), "without a shutdown");
		assert.equal(r.self.value("lifecycle", "notRunningHoursBefore"), 8.5);
		assert.equal(r.self.value("lifecycle", "under"), "tmux");
		assert.deepEqual(
			r.db.prepare("SELECT old_json, new_json FROM self_changes WHERE facet = 'lifecycle' ORDER BY at").all(),
			[
				{ old_json: null, new_json: '"an SSH session"' },
				{ old_json: '"an SSH session"', new_json: '"tmux"' },
			],
			"only what it runs under is kept as a change",
		);
		const report = r.self.command(["runs"], "owner_web");
		assert.match(report, /since 2026-11-10 07:30 under tmux — running now; before it nothing ran for 8\.5 h/);
		assert.match(
			report,
			/since 2026-11-09 20:00 under an SSH session — until 2026-11-09 23:00, ended without a shutdown/,
		);
		assert.match(
			r.self.aboutMe(null),
			/before it you were not running for 8\.5 h \(the run before ended without a shutdown\)/,
		);
		// A shutdown, then a third start a minute later.
		second.shutdown();
		await second.stop();
		r.clock.now = after(11.5 * H + MIN);
		const third = rigRestart(r, [[50, "1 systemd"]], { INVOCATION_ID: "abc" });
		await third.tick();
		assert.equal(r.self.value("lifecycle", "previousRunEnded"), "with a shutdown");
		assert.equal(r.self.value("lifecycle", "under"), "a service manager");
		assert.equal(recentRuns(r.db).length, 3);
	});

	test("nights are recorded from the rhythm, and the note counts those in the rest window", async () => {
		const r = rig();
		const u = r.make();
		r.rhythm.s = {
			mode: "asleep",
			sleptAt: "2026-11-09T10:46:00.000Z",
			reason: "catch-up",
			lastNightAt: null,
			interruptedAt: null,
			summary: null,
		};
		await u.tick();
		r.rhythm.s = { ...r.rhythm.s, mode: "awake", lastNightAt: "2026-11-09T10:47:00.000Z", summary: "1 moved" };
		r.clock.now = after(MIN);
		await u.tick();
		assert.equal(r.self.value("rhythm", "nights7"), 1);
		assert.equal(r.self.value("rhythm", "nightsInWindow7"), 0);
		assert.match(
			r.self.command(["runs"], "owner_web"),
			/asleep 2026-11-09 10:46 to 10:47 — outside the rest window \(catch-up\), completed/,
		);
		assert.match(r.self.aboutMe(null), /Nights in the last 7 days: 1, 0 of them in the rest window\./);
	});

	test("the machine observation and system_status read the same fresh figures", async () => {
		const r = rig();
		const u = r.make();
		const domain = machineDomain({
			vitals: () => u.current(),
			memoryGb: () => {
				throw new Error("the domain must not probe on its own");
			},
			loadedModels: async () => ["gemma-4-E4B"],
			services: () => ({ Telegram: "connected" }),
		});
		const seen = await domain.probe();
		assert.equal(seen.memAvailableGb, 45.6);
		assert.equal(seen.swapUsedGb, 0.4);
		assert.ok((seen.diskTotalGb as number) > 0 && (seen.diskFreePct as number) > 0);
		assert.deepEqual(seen.loadedModels, ["gemma-4-E4B"]);
		const status = await systemStatusTool({
			vitals: () => u.current(),
			memory: () => {
				throw new Error("the tool must not probe on its own");
			},
			loadedModels: async () => [],
		}).run({}, { scope: "owner", principal: "owner" }, undefined);
		assert.match(status, /Disk \(volume of home folder\): [\d.]+ GB free of [\d.]+ GB/);
		assert.match(status, /Memory available for new work: 45\.6 GB \(swap in use: 0\.4 GB\)/);
		// Asked again within the minute: no second probe.
		const before = r.calls.length;
		await u.current();
		assert.equal(r.calls.length, before);
	});
});

/** A new upkeep on the same records: the host started again. */
function rigRestart(r: ReturnType<typeof rig>, parents: [number, string][], env: NodeJS.ProcessEnv = {}): SelfUpkeep {
	const u = new SelfUpkeep({
		db: r.db,
		log: silentLogger,
		self: r.self,
		mode: () => r.mode.m,
		processes: () => [],
		paths: { home: r.dir },
		dirs: () => ({}),
		models: () => [],
		rhythm: null,
		inRestWindow: () => false,
		process: { ppid: 50, env, terminal: true },
		exec: async (file, args) => {
			if (file === "ps" && args[1] === "ppid=,comm=")
				return parents.find(([pid]) => String(pid) === args[3])?.[1] ?? "";
			return "";
		},
		readFile: () => null,
		listDir: () => [],
		platform: "linux",
		now: () => r.clock.now,
		newId: () => `restart-${r.clock.now.getTime()}`,
		timezone: "UTC",
	});
	r.self.attach(u);
	return u;
}
