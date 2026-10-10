// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.010 M0b: the extended self model. Probes run on captured outputs
 * (identifiers replaced); nothing here calls the real pmset, system_profiler
 * or a geolocation service.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { silentLogger } from "../src/log.ts";
import { forgetRecords, forgetTarget } from "../src/memory/forget.ts";
import { latestMachine, SelfModel, selfNoteFor } from "../src/self/model.ts";
import {
	type Exec,
	parseHardware,
	parseNetwork,
	parsePlace,
	parsePower,
	parseSleepLog,
	solarTimes,
} from "../src/self/probes.ts";
import { getContact } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";

const HARDWARE = JSON.stringify({
	SPHardwareDataType: [
		{
			_name: "hardware_overview",
			activation_lock_status: "activation_lock_enabled",
			chip_type: "Apple M3 Max",
			machine_model: "Mac15,8",
			machine_name: "MacBook Pro",
			number_processors: "proc 16:0:12:4",
			physical_memory: "128 GB",
			platform_UUID: "00000000-SECRET-UUID",
			provisioning_UDID: "SECRET-UDID",
			serial_number: "SECRETSERIAL",
		},
	],
});
const SW_VERS = "ProductName:\t\tmacOS\nProductVersion:\t\t27.0.1\nBuildVersion:\t\t26A434\n";
const BATT_AC =
	"Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n";
const BATT_BAT =
	"Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t76%; discharging; 9:30 remaining present: true\n";
const CLAM_OPEN = '      "AppleClamshellCausesSleep" = Yes\n      "AppleClamshellState" = No\n';
const SLEEP_LOG = [
	"2026-10-05 00:04:36 +0200 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to rtc/SleepService Using BATT (Charge:76%) 30 secs",
	"2026-10-05 00:05:06 +0200 Sleep               \tEntering Sleep state due to 'Sleep Service Back to Sleep':TCPKeepAlive=active Using Batt (Charge:76%) 1001 secs",
	"2026-10-05 00:21:47 +0200 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to rtc/SleepService Using BATT (Charge:76%) 2 secs",
	"2026-10-05 00:21:49 +0200 Sleep               \tEntering Sleep state due to 'Sleep Service Back to Sleep' Using Batt (Charge:76%) 963 secs",
	"2026-10-05 07:13:08 +0200 Wake                \tWake from Deep Idle [CDNVA] : due to lid Using BATT (Charge:75%)",
	"2026-10-05 07:13:09 +0200 Assertions          \tPID 1 Created …",
].join("\n");
const ROUTE = "   route to: default\ndestination: default\n    gateway: 192.168.1.1\n  interface: en0\n";
const ARP_A = "? (192.168.1.1) at 74:24:9f:a3:7c:d5 on en0 ifscope [ethernet]\n";
const ARP_B = "? (192.168.1.1) at 10:20:30:40:50:60 on en0 ifscope [ethernet]\n";
const PLACE = JSON.stringify({
	ip: "203.0.113.7",
	hostname: "host.example.net",
	city: "Munich",
	region: "Bavaria",
	country: "DE",
	loc: "48.1374,11.5755",
	org: "AS1234 Example ISP",
	postal: "80331",
	timezone: "Europe/Berlin",
});

describe("probe parsers keep only their listed fields", () => {
	test("hardware: model, chip, cores, memory, OS; never the serial, UUID or UDID", () => {
		const h = parseHardware(HARDWARE, SW_VERS);
		assert.deepEqual(h, {
			machine: "MacBook Pro",
			model: "Mac15,8",
			chip: "Apple M3 Max",
			cores: "16 (12 performance, 4 efficiency)",
			memoryGb: 128,
			os: "macOS 27.0.1",
		});
		assert.ok(!/SECRET/.test(JSON.stringify(h)));
	});

	test("power, lid and last night's sleep from pmset and ioreg", () => {
		assert.deepEqual(parsePower(BATT_AC, CLAM_OPEN), {
			source: "AC",
			batteryPct: 100,
			charging: false,
			lidClosed: false,
			lidCausesSleep: true,
		});
		assert.equal(parsePower(BATT_BAT, "").source, "battery");
		assert.equal(parsePower(BATT_BAT, "").lidClosed, null);
		const s = parseSleepLog(SLEEP_LOG, new Date("2026-10-04T12:00:00Z"), new Date("2026-10-05T08:00:00Z"));
		assert.equal(s.sleeps, 2);
		assert.equal(s.darkWakes, 2);
		assert.equal(s.wakes, 1);
		assert.equal(s.sleptOnBattery, true);
		assert.equal(s.lastWakeAt, "2026-10-05T05:13:08.000Z");
		// 00:05:06 → 00:21:47 and 00:21:49 → 07:13:08.
		assert.equal(s.asleepMinutes, 17 + 411);
		assert.equal(
			parseSleepLog(SLEEP_LOG, new Date("2026-10-05T06:00:00Z"), new Date()).sleeps,
			0,
			"older lines are ignored",
		);
	});

	test("network: an opaque id that changes with the gateway's hardware address", () => {
		const a = parseNetwork(ROUTE, ARP_A);
		assert.equal(a.interface, "en0");
		assert.match(a.networkId!, /^[0-9a-f]{12}$/);
		assert.equal(parseNetwork(ROUTE, ARP_A).networkId, a.networkId);
		assert.notEqual(parseNetwork(ROUTE, ARP_B).networkId, a.networkId, "same gateway address, another network");
		assert.ok(!JSON.stringify(a).includes("192.168"));
	});

	test("place: city level only; never the IP, hostname, ISP or postal code; coordinates to 0.1°", () => {
		const p = parsePlace(PLACE, "ipinfo.io");
		assert.deepEqual(p, {
			city: "Munich",
			region: "Bavaria",
			country: "DE",
			timezone: "Europe/Berlin",
			lat: 48.1,
			lon: 11.6,
			service: "ipinfo.io",
		});
		assert.ok(!/203\.0|example|ISP|80331/.test(JSON.stringify(p)));
	});

	test("sunrise and sunset, offline", () => {
		const t = solarTimes(48.1, 11.6, new Date("2026-10-05T12:00:00Z"))!;
		// Munich, early October: about 05:20 and 16:55 UTC.
		assert.ok(
			Math.abs(t.sunrise.getTime() - Date.parse("2026-10-05T05:20:00Z")) < 15 * 60_000,
			t.sunrise.toISOString(),
		);
		assert.ok(
			Math.abs(t.sunset.getTime() - Date.parse("2026-10-05T16:55:00Z")) < 15 * 60_000,
			t.sunset.toISOString(),
		);
		assert.equal(solarTimes(85, 0, new Date("2026-06-21T12:00:00Z")), null, "polar day");
	});
});

interface Rig {
	db: Db;
	model: SelfModel;
	setNow(d: Date): void;
	setMode(m: "awake" | "asleep"): void;
	out: Map<string, string>;
	calls: string[];
	geoCalls: number;
}

/** The DGX Spark as it answered on 2026-10-10 (serials and UUIDs planted to prove they are never kept). */
const LSCPU = `Architecture:                            aarch64
CPU(s):                                  20
Vendor ID:                               ARM
Model name:                              Cortex-X925
Thread(s) per core:                      1
Core(s) per socket:                      10
Socket(s):                               1
Model name:                              Cortex-A725
Thread(s) per core:                      1
Core(s) per socket:                      10
Socket(s):                               1
`;
const SPARK_FILES: Record<string, string> = {
	"/sys/devices/virtual/dmi/id/product_name": "NVIDIA_DGX_Spark\n",
	"/sys/devices/virtual/dmi/id/sys_vendor": "NVIDIA\n",
	"/sys/devices/virtual/dmi/id/product_family": "DGX Spark\n",
	"/sys/devices/virtual/dmi/id/product_serial": "SECRET-SERIAL-123",
	"/sys/devices/virtual/dmi/id/product_uuid": "00000000-SECRET-UUID",
	"/etc/os-release": 'PRETTY_NAME="Ubuntu 24.04.5 LTS"\nNAME="Ubuntu"\n',
	"/proc/acpi/button/lid/LID0/state": "state:      open\n",
};
const SUSPEND_LOG = [
	"2026-10-04T23:30:00+02:00 spark-3ac3 kernel: PM: suspend entry (s2idle)",
	"2026-10-05T07:00:00+02:00 spark-3ac3 kernel: PM: suspend exit",
].join("\n");

function rig(opts: { geo?: boolean; platform?: NodeJS.Platform } = {}): Rig {
	const db = openDb(":memory:");
	let now = new Date("2026-10-05T10:00:00Z");
	let mode: "awake" | "asleep" = "awake";
	const out = new Map<string, string>([
		["system_profiler", HARDWARE],
		["sw_vers", SW_VERS],
		["pmset -g batt", BATT_AC],
		["ioreg", CLAM_OPEN],
		["pmset -g log", SLEEP_LOG],
		["route", ROUTE],
		["arp", ARP_A],
		["git", "e75a57c\n"],
		["lscpu", LSCPU],
		["nvidia-smi", "NVIDIA GB10\n"],
		["journalctl", SUSPEND_LOG],
		["ip route", "default via 192.168.1.1 dev wlP9s9 proto dhcp src 192.168.1.123 metric 600\n"],
		["ip neigh", "192.168.1.1 dev wlP9s9 lladdr 3c:a6:2f:00:00:01 REACHABLE\n"],
	]);
	const calls: string[] = [];
	const exec: Exec = async (file, args) => {
		const base = file.split("/").pop()!;
		const key = base === "pmset" ? `pmset ${args.join(" ")}` : base === "ip" ? `ip ${args[0]}` : base;
		calls.push(key);
		const v = out.get(key);
		if (v === undefined) throw new Error(`no fake output for ${key}`);
		return v;
	};
	const r: Rig = {
		db,
		setNow: (d) => {
			now = d;
		},
		setMode: (m) => {
			mode = m;
		},
		out,
		calls,
		geoCalls: 0,
		model: undefined as never,
	};
	r.model = new SelfModel({
		db,
		log: silentLogger,
		mode: () => mode,
		repoDir: "/repo",
		hostDir: "/nonexistent",
		llamaServer: "/x/llama.cpp/build_27/bin/llama-server",
		geoHttp:
			opts.geo === false
				? null
				: {
						get: async () => {
							r.geoCalls++;
							return { status: 200, body: PLACE };
						},
					},
		exec,
		platform: opts.platform ?? "darwin",
		readFile: (path) => SPARK_FILES[path] ?? null,
		listDir: (path) => (path === "/proc/acpi/button/lid" ? ["LID0"] : []),
		now: () => now,
		timezone: "Europe/Berlin",
		live: () => ({ models: { web: "gemma-4-26B", background: "gemma-4-E4B" }, mode: "awake", day: 7 }),
	});
	return r;
}

const stm = (db: Db) =>
	db.prepare("SELECT event_id, user_text FROM stm_episodes WHERE scope = 'iyye' ORDER BY event_id").all() as {
		event_id: string;
		user_text: string;
	}[];
const changes = (db: Db) =>
	db.prepare("SELECT facet, field FROM self_changes").all() as { facet: string; field: string }[];

describe("the self model", () => {
	test("probes every facet while awake; stable facts keep a history and are retained once; volatile ones just update", async () => {
		const r = rig();
		await r.model.tick();
		assert.equal(r.model.value("hardware", "chip"), "Apple M3 Max");
		assert.equal(r.model.value("power", "source"), "AC");
		assert.equal(r.model.value("versions", "iyye"), "e75a57c");
		assert.equal(r.model.value("versions", "llamaBuild"), "build_27");
		assert.equal(r.model.value("place", "estimate_city"), "Munich");
		assert.equal(r.geoCalls, 1);
		const retained = stm(r.db).map((e) => e.user_text);
		assert.equal(retained.length, 3, "hardware, versions, place");
		assert.match(
			retained.find((t) => t.includes("runs on"))!,
			/^2026-10-05, Iyye's self model: Iyye runs on MacBook Pro \(Mac15,8\), Apple M3 Max, 16 \(12 performance, 4 efficiency\) cores, 128 GB memory, macOS 27\.0\.1\.$/,
		);
		assert.ok(!/SECRET/.test(JSON.stringify(r.db.prepare("SELECT * FROM self_facts").all())));
		const firstChanges = changes(r.db).length;
		assert.ok(
			changes(r.db).every((c) => ["hardware", "versions", "network", "place"].includes(c.facet)),
			"no history for power or sleep",
		);

		// Nothing is due ten minutes later except power; the same values change nothing.
		r.setNow(new Date("2026-10-05T10:10:00Z"));
		r.out.set("pmset -g batt", BATT_BAT);
		r.calls.length = 0;
		await r.model.tick();
		assert.deepEqual(r.calls.sort(), ["ioreg", "pmset -g batt"]);
		assert.equal(r.model.value("power", "source"), "battery");
		assert.equal(changes(r.db).length, firstChanges, "a volatile change keeps no history");
		assert.equal(stm(r.db).length, 3);

		// A day later everything is probed again; unchanged stable facts are not retained twice.
		r.setNow(new Date("2026-10-06T10:30:00Z"));
		await r.model.tick();
		assert.equal(stm(r.db).length, 3);
		// A new commit is a change, retained once.
		r.out.set("git", "abc1234\n");
		r.setNow(new Date("2026-10-07T11:00:00Z"));
		await r.model.tick();
		assert.equal(stm(r.db).length, 4);
	});

	test("asleep nothing is probed; waking looks at power, sleep and the network at once; a new network re-estimates the place", async () => {
		const r = rig();
		await r.model.tick();
		r.setMode("asleep");
		r.calls.length = 0;
		r.setNow(new Date("2026-10-06T10:00:00Z"));
		await r.model.tick();
		assert.equal(r.calls.length, 0, "nothing probed asleep");
		r.setMode("awake");
		r.setNow(new Date("2026-10-05T10:05:00Z")); // nothing would be due by time
		r.out.set("arp", ARP_B);
		await r.model.afterWake();
		assert.ok(r.calls.includes("pmset -g log") && r.calls.includes("arp"));
		assert.equal(r.geoCalls, 2, "a new network: the place is estimated again");
	});

	test("owner statements, gaps, the about-me block (owner only), and /forget of a relation", async () => {
		const r = rig();
		r.db
			.prepare(
				"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('jacob-1', 'Jacob', 'contact', 't')",
			)
			.run();
		r.db
			.prepare(
				"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('e1', 'e1', 'telegram', 'jacob-1', 'contact:jacob-1', ?, '{}', 'answered')",
			)
			.run("2026-10-05T09:00:00.000Z");
		await r.model.tick();
		let gaps = r.model.gaps().map((g) => `${g.kind} ${g.facet}:${g.field}`);
		assert.deepEqual(gaps.sort(), ["missing place:stated", "missing social:relation:jacob-1"]);

		const ctx = { models: {} as never, db: r.db, issuer: "owner_web", self: r.model };
		const cmd = async (t: string) => (await handleOwnerCommand(t, ctx)).reply;
		assert.match(await cmd("/self set place Hamburg, at home"), /noted: Iyye is at Hamburg/);
		assert.match(await cmd("/self set expected-hardware NVIDIA DGX Spark, 128 GB, ordered"), /expected hardware/);
		assert.match(await cmd("/self relation Jacob my son"), /noted: Jacob — my son/);
		gaps = r.model.gaps().map((g) => `${g.kind} ${g.facet}:${g.field}`);
		assert.deepEqual(gaps, ["contradicted place:stated"], "the network says Munich, the owner Hamburg");
		assert.match(
			await cmd("/self"),
			/contradicted: the network places Iyye in Munich, the owner said "Hamburg, at home"/,
		);

		// The owner's statement about a person is never retained to memory (forget could not reach it there).
		assert.ok(!stm(r.db).some((e) => e.user_text.includes("my son")));
		assert.ok(
			stm(r.db).some((e) => e.user_text.includes("DGX Spark")),
			"expected hardware is retained",
		);

		const about = r.model.aboutMe(latestMachine(r.db));
		assert.match(about, /^<about_me>\n.*for live figures call system_status/s);
		assert.match(
			about,
			/- Hardware: Iyye runs on MacBook Pro .* Expected \(the owner said\): NVIDIA DGX Spark, 128 GB, ordered\. \[just now\]/,
		);
		assert.match(about, /- Power: on the power adapter, battery 100%, lid open \[just now\]/);
		assert.match(
			about,
			/- The computer's sleep, last 24 h: asleep 7 h 8 min \(on battery\), 2 brief maintenance wake-ups, 1 full wake-ups/,
		);
		assert.match(
			about,
			/- Place: The owner says Iyye is at Hamburg, at home\. The network places it in Munich, Bavaria, DE\. Sunrise \d\d:\d\d, sunset \d\d:\d\d/,
		);
		assert.match(about, /- People who wrote in the last 30 days: "Jacob" \("my son"\), 1 message\(s\)/);
		assert.match(about, /Models: web gemma-4-26B, background gemma-4-E4B\. Day 7, awake\./);
		assert.equal(selfNoteFor("contact:jacob-1", r.model, r.db), null, "a contact's turn never gets it");
		assert.equal(selfNoteFor("owner", r.model, r.db), about);

		const t = forgetTarget(r.db, getContact(r.db, "jacob-1")!);
		assert.ok(typeof t !== "string");
		forgetRecords(r.db, t, "owner_web", new Date().toISOString());
		assert.equal(r.model.value("social", "relation:jacob-1"), null);
		assert.equal(
			(r.db.prepare("SELECT count(*) AS n FROM self_changes WHERE facet = 'social'").get() as { n: number }).n,
			0,
		);
	});

	test("without geolocation the place is never estimated, and only the owner's statement is missing", async () => {
		const r = rig({ geo: false });
		await r.model.tick();
		assert.equal(r.model.value("place", "estimate_city"), null);
		assert.deepEqual(
			r.model.gaps().map((g) => `${g.kind} ${g.facet}:${g.field}`),
			["missing place:stated"],
		);
	});

	test("a failing probe becomes a stale gap with its reason, and the others still run", async () => {
		const r = rig();
		await r.model.tick();
		r.out.delete("system_profiler");
		r.setNow(new Date("2026-10-07T11:00:00Z")); // past twice the hardware window
		await r.model.tick();
		const g = r.model.gaps().find((x) => x.facet === "hardware")!;
		assert.equal(g.kind, "stale");
		assert.match(g.why, /hardware is 49 h old \(no fake output for system_profiler\)/);
		assert.equal(r.model.ageMs("power", new Date("2026-10-07T11:00:00Z")), 0, "power was still probed");
	});

	test("on Linux (the Spark) every facet is probed with Linux's own tools, and no serial or UUID is kept", async () => {
		const r = rig({ platform: "linux" });
		await r.model.tick();
		await r.model.afterWake();
		assert.deepEqual(
			r.calls.filter((c) => /^(system_profiler|sw_vers|pmset|ioreg|route|arp)/.test(c)),
			[],
			"no macOS command",
		);
		assert.equal(r.model.value("hardware", "machine"), "NVIDIA DGX Spark");
		assert.equal(r.model.value("hardware", "model"), "DGX Spark");
		assert.equal(r.model.value("hardware", "chip"), "Cortex-X925 + Cortex-A725; GPU NVIDIA GB10");
		assert.equal(r.model.value("hardware", "cores"), "20 (10 Cortex-X925, 10 Cortex-A725)");
		assert.equal(r.model.value("hardware", "os"), "Ubuntu 24.04.5 LTS");
		assert.equal(r.model.value("power", "source"), "AC", "no power supply at all: mains, no battery");
		assert.equal(r.model.value("power", "batteryPct"), null);
		assert.equal(r.model.value("power", "lidClosed"), false);
		assert.equal(r.model.value("sleep", "sleeps"), 1);
		assert.equal(r.model.value("sleep", "asleepMinutes"), 450);
		assert.equal(r.model.value("sleep", "sleptOnBattery"), false);
		assert.equal(r.model.value("network", "interface"), "wlP9s9");
		assert.match(String(r.model.value("network", "networkId")), /^[0-9a-f]{12}$/);
		const all = JSON.stringify(r.db.prepare("SELECT * FROM self_facts").all());
		assert.ok(!/SECRET|3c:a6:2f|192\.168\.1\.1\b/.test(all), "never a serial, UUID, gateway or hardware address");
		r.setNow(new Date("2026-10-05T10:05:00Z"));
		assert.deepEqual(
			r.model.gaps().filter((g) => ["hardware", "power", "sleep"].includes(g.facet)),
			[],
		);
	});

	test("on another platform, the platform-probed facets are never probed and never a gap", async () => {
		const r = rig({ platform: "freebsd" });
		await r.model.tick();
		assert.deepEqual(
			r.calls.filter((c) => /system_profiler|sw_vers|pmset|ioreg|lscpu|nvidia-smi|journalctl/.test(c)),
			[],
		);
		assert.ok(r.model.ageMs("versions", new Date("2026-10-05T10:00:00Z")) !== null, "versions still probed");
		r.setNow(new Date("2026-10-09T10:00:00Z"));
		const facets = r.model.gaps().map((g) => g.facet);
		for (const f of ["hardware", "power", "sleep"]) assert.ok(!facets.includes(f as never), `${f} is not a gap`);
	});
});
