// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.018 W2: the link, the local network, the machines Iyye uses, and
 * the cause of an outage. Probes run on captured outputs; nothing here sends
 * a packet or reads the real network.
 */

import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, test } from "node:test";
import { silentLogger } from "../src/log.ts";
import { recordServices } from "../src/motivation/services.ts";
import { collectSignals } from "../src/motivation/signals.ts";
import { machineDomain, type ProbeResult } from "../src/observe/domains.ts";
import { Observer } from "../src/observe/observer.ts";
import { findHost, forgetHost, labelHost, listHosts, recordHosts } from "../src/self/lan.ts";
import { SelfModel } from "../src/self/model.ts";
import {
	hostId,
	isLanHost,
	localSubnet,
	parseArp,
	parseIwLink,
	parseLinkMac,
	parseNeighbours,
	parseRouteTable,
	readLinkLinux,
	subnetAddresses,
} from "../src/self/network.ts";
import type { Exec } from "../src/self/probes.ts";
import { type PeerConfig, privateAddressOf, SelfSurroundings } from "../src/self/surroundings.ts";
import { openDb } from "../src/state/db.ts";

const T0 = new Date("2026-11-09T20:00:00Z");
const MIN = 60_000;
const H = 60 * MIN;
const after = (ms: number) => new Date(T0.getTime() + ms);

const ROUTES = [
	"Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
	"wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0",
	"docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
	"wlan0\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0",
].join("\n");
const NO_DEFAULT = ROUTES.split("\n")
	.filter((l) => !l.includes("\t00000000\t0101A8C0"))
	.join("\n");
const NEIGH = JSON.stringify([
	{ dst: "192.168.1.1", dev: "wlan0", lladdr: "74:24:9F:A3:7C:D5", state: ["REACHABLE"] },
	{ dst: "192.168.1.177", dev: "wlan0", lladdr: "aa:bb:cc:00:11:22", state: ["STALE"] },
	{ dst: "192.168.1.50", dev: "wlan0", state: ["FAILED"] },
	{ dst: "fe80::1", dev: "wlan0", lladdr: "74:24:9f:a3:7c:d5", state: ["REACHABLE"] },
]);
const IW =
	"Connected to 74:24:9f:a3:7c:d5 (on wlan0)\n\tSSID: SECRETNAME\n\tsignal: -59 dBm\n\ttx bitrate: 864.8 MBit/s 80MHz\n";
/** The kernel's files: a Wi-Fi card that is up, an Ethernet port with no link, a bridge that is not hardware. */
const files = (routes: () => string, wifi: () => string = () => "up") => ({
	listDir: (p: string) => (p === "/sys/class/net" ? ["lo", "docker0", "eth0", "wlan0"] : []),
	readFile: (p: string) => {
		if (p === "/proc/net/route") return routes();
		if (p === "/sys/class/net/wlan0/device/uevent" || p === "/sys/class/net/eth0/device/uevent") return "DRIVER=x\n";
		if (p === "/sys/class/net/wlan0/uevent") return "DEVTYPE=wlan\nINTERFACE=wlan0\n";
		if (p === "/sys/class/net/eth0/uevent") return "INTERFACE=eth0\n";
		if (p === "/sys/class/net/docker0/uevent") return "DEVTYPE=bridge\n";
		if (p === "/sys/class/net/wlan0/operstate") return `${wifi()}\n`;
		if (p === "/sys/class/net/eth0/operstate") return "down\n";
		if (p === "/sys/class/net/docker0/operstate") return "up\n";
		return null;
	},
});
const IFACES: NodeJS.Dict<NetworkInterfaceInfo[]> = {
	wlan0: [
		{
			address: "192.168.1.123",
			netmask: "255.255.255.0",
			family: "IPv4",
			mac: "x",
			internal: false,
			cidr: "192.168.1.123/24",
		},
	],
};

describe("network parsers keep only their listed fields", () => {
	test("the default route from the kernel's table; the link from its files", () => {
		assert.deepEqual(parseRouteTable(ROUTES), { iface: "wlan0", gateway: "192.168.1.1" });
		assert.equal(parseRouteTable(NO_DEFAULT), null);
		assert.equal(parseRouteTable(null), null);
		assert.deepEqual(readLinkLinux(files(() => ROUTES)), {
			online: true,
			wifi: "up",
			ethernet: "down",
			iface: "wlan0",
			gateway: "192.168.1.1",
		});
		assert.deepEqual(
			readLinkLinux(
				files(
					() => NO_DEFAULT,
					() => "down",
				),
			),
			{
				online: false,
				wifi: "down",
				ethernet: "down",
				iface: null,
				gateway: null,
			},
		);
		assert.deepEqual(parseIwLink(IW), { signalDbm: -59, rateMbit: 864.8 });
		assert.deepEqual(parseIwLink("Not connected.\n"), { signalDbm: null, rateMbit: null });
		const mac = parseLinkMac(
			"   route to: default\n    gateway: 192.168.1.1\n  interface: en0\n",
			"lo0: flags=8049\nen0: flags=8863\n\tinet 192.168.1.177\n\tstatus: active\nen1: flags=8863\n\tstatus: inactive\n",
		);
		assert.deepEqual(mac, { online: true, wifi: null, ethernet: "up", iface: "en0", gateway: "192.168.1.1" });
		assert.equal(parseLinkMac("route: writing to routing socket: not in table\n", "").online, false);
	});

	test("neighbours: IPv4 hosts with a hardware address; a host is known by a hash of it", () => {
		const n = parseNeighbours(NEIGH);
		assert.deepEqual(n, [
			{ ip: "192.168.1.1", mac: "74:24:9f:a3:7c:d5" },
			{ ip: "192.168.1.177", mac: "aa:bb:cc:00:11:22" },
			{ ip: "192.168.1.50", mac: null },
		]);
		assert.deepEqual(parseNeighbours("not json"), []);
		assert.deepEqual(
			parseArp(
				"? (192.168.1.1) at 74:24:9f:a3:7c:d5 on en0 ifscope [ethernet]\n? (192.168.1.9) at (incomplete) on en0\n? (224.0.0.251) at 1:0:5e:0:0:fb on en0\n",
			),
			[
				{ ip: "192.168.1.1", mac: "74:24:9f:a3:7c:d5" },
				{ ip: "192.168.1.9", mac: null },
				{ ip: "224.0.0.251", mac: "1:0:5e:0:0:fb" },
			],
		);
		assert.equal(isLanHost({ ip: "192.168.1.1", mac: "74:24:9f:a3:7c:d5" }), true);
		assert.equal(isLanHost({ ip: "192.168.1.50", mac: null }), false, "nobody answered");
		assert.equal(isLanHost({ ip: "192.168.1.255", mac: "ff:ff:ff:ff:ff:ff" }), false, "broadcast");
		assert.equal(isLanHost({ ip: "203.0.113.7", mac: "aa:bb:cc:00:11:22" }), false, "not a private address");
		assert.match(hostId("74:24:9F:A3:7C:D5"), /^[0-9a-f]{12}$/);
		assert.equal(hostId("74:24:9F:A3:7C:D5"), hostId("74:24:9f:a3:7c:d5"));
		assert.ok(!hostId("74:24:9f:a3:7c:d5").includes("74249f"));
	});

	test("the active probe stays in a small private subnet", () => {
		assert.deepEqual(localSubnet(IFACES, "wlan0"), { address: "192.168.1.123", prefix: 24 });
		assert.equal(localSubnet(IFACES, "eth0"), null);
		assert.equal(localSubnet(IFACES, null), null);
		const all = subnetAddresses("192.168.1.123", 24);
		assert.equal(all.length, 253, "every host address but our own");
		assert.equal(all[0], "192.168.1.1");
		assert.equal(all.at(-1), "192.168.1.254");
		assert.ok(!all.includes("192.168.1.123") && !all.includes("192.168.1.0") && !all.includes("192.168.1.255"));
		assert.equal(subnetAddresses("10.1.2.3", 22).length, 1021);
		assert.deepEqual(subnetAddresses("10.1.2.3", 16), [], "too wide");
		assert.deepEqual(subnetAddresses("203.0.113.7", 24), [], "not private");
		assert.equal(privateAddressOf("https://192.168.1.177:8191"), "192.168.1.177");
		assert.equal(privateAddressOf("https://example.org:8191"), null);
		assert.equal(privateAddressOf("https://203.0.113.7:8191"), null);
	});
});

describe("hosts on the local network", () => {
	test("first and last seen, days, the owner's name for one, and forgetting one for good", () => {
		const db = openDb(":memory:");
		const seen = parseNeighbours(NEIGH);
		assert.deepEqual(recordHosts(db, seen, T0).present, 2);
		assert.equal(recordHosts(db, seen, after(30 * MIN)).fresh.length, 0);
		recordHosts(db, [seen[0]!], after(26 * H)); // the next day, only the gateway
		const [gw, mbp] = listHosts(db);
		assert.equal(gw!.address, "192.168.1.1");
		assert.equal(gw!.days_seen, 2);
		assert.equal(mbp!.days_seen, 1);
		assert.equal(mbp!.last_seen, after(30 * MIN).toISOString());
		assert.ok(!JSON.stringify(listHosts(db)).includes("74:24"), "no hardware address is kept");
		const found = findHost(db, mbp!.id.slice(0, 6));
		assert.ok(typeof found !== "string" && found.id === mbp!.id);
		assert.match(findHost(db, "zzz") as string, /letters and digits/);
		assert.match(findHost(db, "000000") as string, /no host/);
		labelHost(db, mbp!.id, "Alex's laptop");
		assert.equal(listHosts(db)[1]!.label, "Alex's laptop");
		forgetHost(db, mbp!.id);
		assert.equal(listHosts(db).length, 1);
		// It comes back: still not listed, and not counted.
		assert.deepEqual(recordHosts(db, seen, after(27 * H)), { present: 1, fresh: [] });
		assert.equal(listHosts(db).length, 1);
	});
});

// ---------------------------------------------------------------- the surroundings, on a real self model

function rig(lan: "off" | "passive" | "active" = "passive") {
	const db = openDb(":memory:");
	const clock = { now: T0 };
	const mode = { m: "awake" as "awake" | "asleep" };
	const net = { routes: ROUTES, wifi: "up", neigh: NEIGH };
	const thinking: PeerConfig = {
		endpoint: "mbp",
		serves: "the thinking model",
		address: "192.168.1.177",
		answering: false,
		error: "connect ETIMEDOUT 192.168.1.177:8191",
	};
	const pings: string[] = [];
	const linkChanges: boolean[] = [];
	const exec: Exec = async (file, args) => {
		if (file === "ip" && args.join(" ") === "-j neigh") return net.neigh;
		if (file === "iw") return IW;
		if (file === "ping") {
			pings.push(args.at(-1)!);
			return "";
		}
		throw new Error(`unexpected command ${file} ${args.join(" ")}`);
	};
	const self = new SelfModel({
		db,
		log: silentLogger,
		mode: () => mode.m,
		repoDir: ".",
		hostDir: ".",
		llamaServer: "x",
		geoHttp: null,
		now: () => clock.now,
	});
	const f = files(
		() => net.routes,
		() => net.wifi,
	);
	const s = new SelfSurroundings({
		db,
		log: silentLogger,
		self,
		mode: () => mode.m,
		peers: () => [thinking],
		needs: { Telegram: "internet", "web search": "internet", "the thinking model on mbp": { peer: "mbp" } },
		lan,
		sweepsPerDay: 2,
		onLinkChange: (online) => linkChanges.push(online),
		exec,
		...f,
		platform: "linux",
		interfaces: () => IFACES,
		now: () => clock.now,
		sleep: async () => undefined,
		timezone: "UTC",
	});
	self.attach(s);
	return { db, clock, mode, net, thinking, pings, linkChanges, self, s };
}

describe("the surroundings", () => {
	test("the link's loss is recorded within the minute, once, and told at once; so is its return", async () => {
		const r = rig();
		await r.s.tick();
		assert.equal(r.self.value("link", "online"), true);
		assert.equal(r.self.value("link", "ethernet"), "down");
		assert.equal(r.self.value("link", "signalDbm"), -59);
		assert.equal(r.self.value("link", "gateway"), "answers");
		assert.deepEqual(r.linkChanges, [], "the first reading is a state, not a change");
		assert.deepEqual(r.s.network(), {
			online: true,
			since: T0.toISOString(),
			dependents: ["Telegram", "web search"],
		});
		// 23:12: the access point goes. The next minute's reading sees it.
		r.net.routes = NO_DEFAULT;
		r.net.wifi = "down";
		r.clock.now = after(MIN);
		await r.s.tick();
		r.clock.now = after(2 * MIN);
		await r.s.tick();
		assert.deepEqual(r.linkChanges, [false]);
		assert.equal(r.s.network().since, after(MIN).toISOString());
		assert.equal(r.self.value("link", "gateway"), null);
		const changes = () =>
			r.db
				.prepare(
					"SELECT field, new_json, at FROM self_changes WHERE facet = 'link' AND old_json IS NOT NULL ORDER BY at, field",
				)
				.all() as { field: string; new_json: string; at: string }[];
		assert.deepEqual(changes(), [
			{ field: "online", new_json: "false", at: after(MIN).toISOString() },
			{ field: "wifi", new_json: '"down"', at: after(MIN).toISOString() },
		]);
		const report = r.self.command(["network"], "owner_web");
		assert.match(
			report,
			/^network: the network is away \(no default route\) since 2026-11-09 20:01; Wi-Fi down, Ethernet has no link/,
		);
		assert.match(report, /needs a way out: Telegram, web search/);
		assert.match(report, /2026-11-09 20:01 {2}the network went away/);
		assert.ok(
			!/SECRETNAME|192\.168\.1\.1\b|74:24/.test(report),
			"no network name, gateway address or hardware address",
		);
		// 07:11: back.
		r.net.routes = ROUTES;
		r.net.wifi = "up";
		r.clock.now = after(8 * H);
		await r.s.tick();
		assert.deepEqual(r.linkChanges, [false, true]);
		assert.equal(changes().length, 4);
		assert.match(
			r.self.aboutMe(null),
			/- Network: there is a way out since 2026-11-10 04:00; Wi-Fi up \(-59 dBm, 864\.8 Mbit\/s\), Ethernet has no link; the gateway answers\. Machines you use: mbp \(the thinking model\): on the LAN, not answering\./,
		);
	});

	test("a machine Iyye uses: answering, there but silent, gone, or unknown while the network is away", async () => {
		const r = rig();
		const state = () => r.self.value("peers", "mbp");
		await r.s.tick();
		assert.equal(state(), "on the LAN, not answering", "the kernel has its hardware address");
		assert.equal(
			r.s.cause("the thinking model on mbp"),
			"mbp is on the local network, but its server does not answer",
		);
		assert.equal(r.s.cause("Telegram"), null, "there is a way out: nothing is claimed about the internet");
		assert.equal(r.s.cause("the decision service"), null, "it needs nothing outside");
		// It leaves the network: nobody answers for its address any more.
		r.net.neigh = JSON.stringify([{ dst: "192.168.1.1", lladdr: "74:24:9f:a3:7c:d5", state: ["REACHABLE"] }]);
		r.clock.now = after(10 * MIN);
		await r.s.tick();
		assert.equal(state(), "not on the LAN");
		assert.equal(r.s.cause("the thinking model on mbp"), "mbp is not on the local network");
		// A refused connection is an answer from the machine itself.
		r.thinking.error = "connect ECONNREFUSED 192.168.1.177:8191";
		r.clock.now = after(20 * MIN);
		await r.s.tick();
		assert.equal(state(), "on the LAN, not answering");
		// Its server answers: known at the next minute, not at the next ten.
		r.thinking.answering = true;
		r.clock.now = after(21 * MIN);
		await r.s.tick();
		assert.equal(state(), "answering");
		assert.equal(r.s.cause("the thinking model on mbp"), null);
		// The network goes: what the machine does is not known.
		r.thinking.answering = false;
		r.net.routes = NO_DEFAULT;
		r.clock.now = after(22 * MIN);
		await r.s.tick();
		assert.equal(state(), "unknown: the network is away");
		assert.equal(r.s.cause("the thinking model on mbp"), "the network is away");
		assert.equal(r.s.cause("Telegram"), "the network is away");
		assert.deepEqual(
			(
				r.db.prepare("SELECT new_json FROM self_changes WHERE facet = 'peers' ORDER BY at").all() as {
					new_json: string;
				}[]
			).map((c) => JSON.parse(c.new_json)),
			[
				"on the LAN, not answering",
				"not on the LAN",
				"on the LAN, not answering",
				"answering",
				"unknown: the network is away",
			],
		);
	});

	test("the local network: the neighbour table every half hour; the owner names and forgets hosts", async () => {
		const r = rig("passive");
		await r.s.tick();
		assert.equal(r.self.value("lan", "hostsNow"), 2);
		assert.deepEqual(r.pings, [], "passive: no packet is sent");
		const list = r.self.command(["hosts"], "owner_web");
		assert.match(list, /the neighbour table only/);
		assert.match(
			list,
			/[0-9a-f]{6} {2}192\.168\.1\.1 {2}the gateway — seen just now, first 2026-11-09, on 1 day\(s\)/,
		);
		assert.match(list, /[0-9a-f]{6} {2}192\.168\.1\.177 {2}mbp — seen just now/, "a machine Iyye uses is named");
		const id = /([0-9a-f]{6}) {2}192\.168\.1\.177/.exec(list)![1]!;
		assert.match(
			r.self.command(["host", id, "Alex's", "laptop"], "owner_web"),
			/noted: [0-9a-f]{6} is Alex's laptop/,
		);
		assert.match(r.self.command(["hosts"], "owner_web"), /192\.168\.1\.177 {2}Alex's laptop/);
		assert.match(r.self.command(["host", id, "forget"], "owner_web"), /no longer listed/);
		assert.doesNotMatch(r.self.command(["hosts"], "owner_web"), /192\.168\.1\.177/);
		assert.match(r.self.command(["host", id], "owner_web"), /usage/);
		assert.match(r.self.command(["host", "abc", "x"], "owner_web"), /no host abc/);
		// Not looked at while the network is away, and not at all when switched off.
		const off = rig("off");
		await off.s.tick();
		assert.equal(off.self.value("lan", "hostsNow"), null);
		assert.match(off.self.command(["hosts"], "owner_web"), /not looked at/);
	});

	test("the active probe: one echo request per address of the subnet, a few times a day, awake, never elsewhere", async () => {
		const r = rig("active");
		await r.s.tick();
		await r.s.probing;
		assert.equal(r.pings.length, 253);
		assert.ok(r.pings.every((a) => a.startsWith("192.168.1.") && a !== "192.168.1.123"));
		assert.match(r.self.command(["hosts"], "owner_web"), /a probe of the subnet at most 2 a day; 1 today/);
		// Not again within four hours.
		r.clock.now = after(H);
		await r.s.tick();
		await r.s.probing;
		assert.equal(r.pings.length, 253);
		// Asleep: not at all. (It is past midnight UTC now: a new day's count.)
		r.mode.m = "asleep";
		r.clock.now = after(5 * H);
		await r.s.tick();
		assert.equal(r.s.probing, null);
		r.mode.m = "awake";
		await r.s.tick();
		await r.s.probing;
		assert.equal(r.pings.length, 506);
		r.clock.now = after(10 * H);
		await r.s.tick();
		await r.s.probing;
		assert.equal(r.pings.length, 759, "the second of that day");
		// The day's two are used up.
		r.clock.now = after(15 * H);
		await r.s.tick();
		await r.s.probing;
		assert.equal(r.pings.length, 759);
		assert.match(r.self.command(["hosts"], "owner_web"), /2 today/);
		// A new day: again, unless the network is away.
		r.net.routes = NO_DEFAULT;
		r.clock.now = after(30 * H);
		await r.s.tick();
		assert.equal(r.s.probing, null);
		assert.equal(r.pings.length, 759);
	});
});

describe("one cause, one signal, one finding", () => {
	const sources = (network: { online: boolean | null; since: string | null; dependents: string[] } | null) => ({
		selfGaps: () => [],
		healing: () => [],
		sleep: () => null,
		network: () => network,
		cause: (service: string) => (service === "the thinking model on mbp" ? "mbp is not on the local network" : null),
	});
	const states = {
		Telegram: { state: "retrying", detail: "getUpdates: EAI_AGAIN" },
		"web search": { state: "up" },
		"the decision service": { state: "retrying", detail: "exited" },
		"the thinking model on mbp": { state: "unreachable", detail: "connect EHOSTUNREACH" },
	};

	test("signals: the network away is one; what needs it is not signalled beside it; a cause outside is named", () => {
		const db = openDb(":memory:");
		recordServices(db, () => states, T0);
		const away = { online: false, since: after(-30 * MIN).toISOString(), dependents: ["Telegram", "web search"] };
		const sig = collectSignals({ db, now: after(30 * MIN), ...sources(away) });
		assert.deepEqual(
			sig.map((s) => [s.kind, s.cluster.split("@")[0]]),
			[
				["network_away", "network"],
				["service_down", "service:the decision service"],
				["service_down", "service:the thinking model on mbp"],
			],
		);
		assert.equal(
			sig[0]!.text,
			"the network has been away for 1.0 h (no default route); Telegram, web search cannot be reached without it",
		);
		assert.equal(sig[0]!.weight, 0.65);
		assert.match(
			sig[2]!.text,
			/the thinking model on mbp has been unreachable for 30 min \(mbp is not on the local network\)/,
		);
		assert.match(sig[1]!.text, /the decision service has been retrying for 30 min: exited/);
		// The network is there: Telegram's outage is its own again.
		const online = collectSignals({ db, now: after(30 * MIN), ...sources({ ...away, online: true }) });
		assert.deepEqual(
			online.map((s) => s.cluster.split("@")[0]),
			["service:Telegram", "service:the decision service", "service:the thinking model on mbp"],
		);
		// Every change of a service's state is kept with its time.
		recordServices(db, () => ({ ...states, Telegram: { state: "connected" } }), after(8 * H));
		assert.deepEqual(
			db
				.prepare(
					"SELECT old_json, new_json, at FROM self_changes WHERE facet = 'services' AND field = 'Telegram' ORDER BY at",
				)
				.all(),
			[
				{ old_json: null, new_json: '"retrying"', at: T0.toISOString() },
				{ old_json: '"retrying"', new_json: '"connected"', at: after(8 * H).toISOString() },
			],
		);
	});

	test("the machine observation: the loss and the return are one change each, carrying what needs the network", () => {
		const machine = machineDomain({ memoryGb: () => 50, loadedModels: async () => [], services: () => ({}) });
		const m = (o: Partial<Record<string, unknown>>): ProbeResult => ({
			diskFreeGb: 200,
			diskTotalGb: 1000,
			diskFreePct: 20,
			memAvailableGb: 50,
			swapUsedGb: 0,
			loadedModels: [],
			services: { Telegram: "connected", "the decision service": "up" },
			online: true,
			needOnline: ["Telegram", "web search"],
			...o,
		});
		const down = { Telegram: "retrying", "the decision service": "up" };
		assert.equal(machine.compare(null, m({ online: false }), T0).severity, "none", "the first look is a baseline");
		assert.deepEqual(machine.compare(m({}), m({ online: false, services: down }), T0), {
			severity: "threshold",
			text: "the network is away (no default route); Telegram, web search cannot be reached without it",
		});
		// Still away, and Telegram only now gives up: nothing new.
		assert.equal(machine.compare(m({ online: false }), m({ online: false, services: down }), T0).severity, "none");
		// Something that does not need the network fails meanwhile: that is its own change.
		assert.equal(
			machine.compare(
				m({ online: false, services: down }),
				m({ online: false, services: { ...down, "the decision service": "retrying" } }),
				T0,
			).text,
			"the decision service is retrying",
		);
		assert.deepEqual(machine.compare(m({ online: false, services: down }), m({}), T0), {
			severity: "minor",
			text: "the network is back",
		});
		// Without the link's state (a host with no surroundings) services are reported as before.
		assert.equal(
			machine.compare(
				m({ online: undefined, needOnline: undefined }),
				m({ online: undefined, needOnline: undefined, services: down }),
				T0,
			).text,
			"Telegram is retrying",
		);
	});

	test("exit check: a simulated network loss gives one finding that names it", async () => {
		const r = rig();
		const telegram = { state: "connected" };
		const sent: string[] = [];
		const observer = new Observer({
			db: r.db,
			domains: [
				machineDomain({
					network: () => r.s.network(),
					memoryGb: () => 50,
					loadedModels: async () => [],
					services: () => ({ Telegram: telegram.state }),
					path: "/",
				}),
			],
			defaultEnabled: ["machine"],
			importance: { decide: async () => ({ kind: "decided", finding: true, by: "fallback", decisionId: null }) },
			notifyOwner: async (_key, text) => {
				sent.push(text);
			},
			mode: () => "awake",
			log: silentLogger,
			quietMs: 0,
			now: () => r.clock.now,
		});
		const surroundings = new SelfSurroundings({
			db: r.db,
			log: silentLogger,
			self: r.self,
			mode: () => "awake",
			peers: () => [],
			needs: { Telegram: "internet", "web search": "internet" },
			lan: "off",
			onLinkChange: () => void observer.lookNow("machine"),
			exec: async () => "",
			...files(() => r.net.routes),
			platform: "linux",
			interfaces: () => IFACES,
			now: () => r.clock.now,
			timezone: "UTC",
		});
		await surroundings.tick();
		await observer.tick(); // the baseline
		// The network goes; a minute later the surroundings see it and ask for a look; Telegram gives up after that.
		r.net.routes = NO_DEFAULT;
		r.clock.now = after(MIN);
		await surroundings.tick();
		await observer.tick();
		telegram.state = "retrying";
		r.clock.now = after(3 * H);
		await observer.tick();
		r.clock.now = after(6 * H);
		await observer.tick();
		assert.deepEqual(sent, [
			"I noticed (machine): the network is away (no default route); Telegram, web search cannot be reached without it",
		]);
		// It comes back, and Telegram with it: one more, and no "Telegram is connected again".
		r.net.routes = ROUTES;
		telegram.state = "connected";
		r.clock.now = after(8 * H);
		await surroundings.tick();
		await observer.tick();
		assert.deepEqual(sent.slice(1), ["I noticed (machine): the network is back"]);
	});
});
