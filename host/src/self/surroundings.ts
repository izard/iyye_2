// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * What is around Iyye (plan 0.018 W2): the link, the local network, and the
 * machines it is configured to use. Observe and record; the one thing it
 * tells others is a cause (`cause`, `network`), so a failure of the link is
 * one finding and one notice, not one for each service that needs it.
 *
 * | Facet | What                                                          | When |
 * | ----- | ------------------------------------------------------------- | ---- |
 * | link  | a way out or not, Wi-Fi and Ethernet up or down, signal, rate, whether the gateway answers | every minute (files); signal and gateway every 10 min |
 * | lan   | hosts on the local network (`lan_hosts`)                      | the neighbour table every 30 min; an active probe a few times a day |
 * | peers | each machine Iyye uses: answering, on the LAN but silent, or gone | every 10 min, and when the link changes |
 *
 * - **Changes are recorded when they happen** (W0): `link.online`, `link.wifi`
 *   and `link.ethernet`, and each peer's state, are rows in `self_changes`.
 * - **The internet is not probed** (owner decision 3). Without a default
 *   route nothing outside can be reached, and that much is certain; with one,
 *   nothing is claimed.
 * - **Dependencies are declared** by the host (`needs`), not learned.
 */

import { networkInterfaces } from "node:os";
import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import { getKv, setKv } from "../state/kv.ts";
import { findHost, forgetHost, type LanHost, labelHost, listHosts, recordHosts } from "./lan.ts";
import type { SelfModel } from "./model.ts";
import {
	hostId,
	isLanHost,
	isPrivate,
	type Link,
	localSubnet,
	type Neighbour,
	type NetDeps,
	parseIwLink,
	pingOnce,
	readLink,
	readNeighbours,
	subnetAddresses,
} from "./network.ts";
import { type Exec, execAsync, type ListDir, listSysDir, type ReadFile, readSysFile } from "./probes.ts";
import { machineKey, recordReadings } from "./readings.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const SWEEPS_KEY = "self.lan.sweeps";

/** A machine Iyye is configured to use. */
export interface PeerConfig {
	/** The owner's name for it ("mbp"). */
	endpoint: string;
	/** What Iyye uses it for ("the thinking model"). */
	serves: string;
	/** Its address when the configuration gives a private IPv4 one; null otherwise. */
	address: string | null;
	/** Whether its server answers now, and the last error when it does not. */
	answering: boolean;
	error: string | null;
}

export type PeerState =
	| "answering"
	| "on the LAN, not answering"
	| "not on the LAN"
	| "unknown: the network is away"
	| "unknown";

/** What a service needs that is outside this machine. */
export type Need = "internet" | { peer: string };

export interface SurroundingsDeps {
	db: Db;
	log: Logger;
	self: Pick<SelfModel, "setFacet" | "value">;
	mode: () => "awake" | "winding_down" | "asleep";
	peers: () => PeerConfig[];
	/** Service name (as in `service_status`) → what it needs. Other things that need the internet may be named too. */
	needs: Record<string, Need>;
	/** `off`: no LAN records. `passive`: the neighbour table. `active`: also the rare probe of the subnet. */
	lan: "off" | "passive" | "active";
	sweepsPerDay?: number;
	/** Told at once when the way out appears or disappears. */
	onLinkChange?: (online: boolean) => void;
	detailsMs?: number;
	lanMs?: number;
	sweepGapMs?: number;
	/** Between two echo requests of the active probe. */
	sweepPaceMs?: number;
	tickMs?: number;
	exec?: Exec;
	readFile?: ReadFile;
	listDir?: ListDir;
	platform?: NodeJS.Platform;
	interfaces?: NetDeps["interfaces"];
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
	timezone?: string;
}

export class SelfSurroundings {
	private readonly d: Required<SurroundingsDeps>;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private sweeping: Promise<void> | null = null;
	private stopping = false;
	private readonly at = new Map<string, number>();
	/** The last link read, with its interface and gateway (never stored). */
	private link: Link | null = null;
	private neighbours: Neighbour[] = [];

	constructor(deps: SurroundingsDeps) {
		this.d = {
			sweepsPerDay: 3,
			onLinkChange: () => undefined,
			detailsMs: 10 * MIN,
			lanMs: 30 * MIN,
			sweepGapMs: 4 * HOUR,
			sweepPaceMs: 250,
			tickMs: MIN,
			exec: execAsync,
			readFile: readSysFile,
			listDir: listSysDir,
			platform: process.platform,
			interfaces: networkInterfaces,
			now: () => new Date(),
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
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
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.running;
		await this.sweeping;
	}

	/** One pass. Public for tests. */
	tick(): Promise<void> {
		if (this.running) return this.running;
		this.running = this.pass()
			.catch((err) => this.d.log.warn("self: surroundings failed", { error: (err as Error).message }))
			.finally(() => {
				this.running = null;
			});
		return this.running;
	}

	/** The active probe in progress, if any (tests wait for it). */
	get probing(): Promise<void> | null {
		return this.sweeping;
	}

	private get net(): NetDeps {
		return {
			exec: this.d.exec,
			readFile: this.d.readFile,
			listDir: this.d.listDir,
			platform: this.d.platform,
			interfaces: this.d.interfaces,
		};
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
		if (last !== undefined && now.getTime() - last < everyMs) return false;
		this.at.set(what, now.getTime());
		return true;
	}

	private async pass(): Promise<void> {
		const now = this.d.now();
		const changed = await this.readLink(now);
		if (this.link === null) return; // a platform with no link probe
		if (changed || this.due("details", this.d.detailsMs, now)) await this.details(now);
		if (changed || this.due("peers", this.d.detailsMs, now) || this.peersMoved()) this.peers(now);
		if (this.d.lan === "off" || !this.link.online) return;
		if (this.due("lan", this.d.lanMs, now)) await this.lan(now);
		if (this.d.lan === "active" && this.d.mode() === "awake" && !this.sweeping && this.sweepAllowed(now)) {
			this.sweeping = this.sweep(now)
				.catch((err) => this.d.log.warn("self: the LAN probe failed", { error: (err as Error).message }))
				.finally(() => {
					this.sweeping = null;
				});
		}
	}

	// ---------------------------------------------------------------- link

	/** Read the link; true when the way out appeared or disappeared. */
	private async readLink(now: Date): Promise<boolean> {
		const link = await readLink(this.net);
		if (!link) return false;
		this.link = link;
		const was = this.d.self.value<boolean>("link", "online");
		const moved =
			was !== link.online ||
			this.d.self.value("link", "wifi") !== link.wifi ||
			this.d.self.value("link", "ethernet") !== link.ethernet;
		if (!moved) return false;
		this.d.self.setFacet(
			"link",
			{
				online: link.online,
				wifi: link.wifi,
				ethernet: link.ethernet,
				...(was !== link.online ? { since: now.toISOString() } : {}),
			},
			"probe",
			null,
			now,
		);
		if (was !== link.online) {
			this.d.log.info(link.online ? "self: the network is back" : "self: the network is away", {
				wifi: link.wifi,
				ethernet: link.ethernet,
			});
			// The first reading after a start is a state, not a change.
			if (was !== null) this.d.onLinkChange(link.online);
			return true;
		}
		return false;
	}

	/** The Wi-Fi's signal and rate, and whether the gateway answers at the link layer. */
	private async details(now: Date): Promise<void> {
		const link = this.link!;
		let signal: { signalDbm: number | null; rateMbit: number | null } = { signalDbm: null, rateMbit: null };
		if (this.d.platform === "linux" && link.wifi === "up" && link.iface)
			signal = parseIwLink(await this.d.exec("iw", ["dev", link.iface, "link"]).catch(() => ""));
		this.neighbours = link.online ? await readNeighbours(this.net) : [];
		const gw = link.gateway ? this.neighbours.find((n) => n.ip === link.gateway) : undefined;
		this.d.self.setFacet(
			"link",
			{ ...signal, gateway: !link.online ? null : gw?.mac ? "answers" : gw ? "silent" : "not asked lately" },
			"probe",
			null,
			now,
		);
		recordReadings(this.d.db, this.machine, "link", { ...signal, online: link.online ? 1 : 0 }, now);
	}

	// ---------------------------------------------------------------- peers

	private peerState(p: PeerConfig): PeerState {
		if (p.answering) return "answering";
		if (this.link && !this.link.online) return "unknown: the network is away";
		if (!p.address) return "unknown";
		const seen = this.neighbours.find((n) => n.ip === p.address);
		// A refused connection is an answer from the machine itself: it is there, its server is not.
		if (seen?.mac || /ECONNREFUSED/.test(p.error ?? "")) return "on the LAN, not answering";
		return "not on the LAN";
	}

	/** A peer's server started or stopped answering since the last look. */
	private peersMoved(): boolean {
		return this.d
			.peers()
			.some((p) => (this.d.self.value<PeerState>("peers", p.endpoint) === "answering") !== p.answering);
	}

	private peers(now: Date): void {
		const fields = Object.fromEntries(this.d.peers().map((p) => [p.endpoint, this.peerState(p)]));
		if (Object.keys(fields).length) this.d.self.setFacet("peers", fields, "probe", null, now);
	}

	// ---------------------------------------------------------------- lan

	private async lan(now: Date): Promise<void> {
		this.neighbours = await readNeighbours(this.net);
		const { present, fresh } = recordHosts(this.d.db, this.neighbours, now);
		this.d.self.setFacet("lan", { hostsNow: present, hostsKnown: listHosts(this.d.db).length }, "probe", null, now);
		recordReadings(this.d.db, this.machine, "lan", { hostsNow: present }, now);
		if (fresh.length) this.d.log.info("self: new hosts on the LAN", { n: fresh.length });
	}

	private sweeps(now: Date): { day: string; n: number; lastAt: number } {
		const day = now.toISOString().slice(0, 10);
		try {
			const s = JSON.parse(getKv(this.d.db, SWEEPS_KEY) ?? "null") as {
				day: string;
				n: number;
				lastAt: number;
			} | null;
			if (s) return s.day === day ? s : { day, n: 0, lastAt: s.lastAt };
		} catch {
			// a damaged record counts as none
		}
		return { day, n: 0, lastAt: 0 };
	}

	private sweepAllowed(now: Date): boolean {
		const s = this.sweeps(now);
		return s.n < this.d.sweepsPerDay && now.getTime() - s.lastAt >= this.d.sweepGapMs;
	}

	/**
	 * The active probe (owner decision 2): one echo request to each address of
	 * the local subnet, one at a time, so the kernel learns who is there; then
	 * the neighbour table is read as usual. Counted before it starts, so a
	 * failing one is not tried again at once.
	 */
	private async sweep(now: Date): Promise<void> {
		const subnet = localSubnet(this.d.interfaces(), this.link?.iface ?? null);
		const addresses = subnet ? subnetAddresses(subnet.address, subnet.prefix) : [];
		const s = this.sweeps(now);
		setKv(
			this.d.db,
			SWEEPS_KEY,
			JSON.stringify({ day: s.day, n: s.n + 1, lastAt: now.getTime() }),
			now.toISOString(),
		);
		if (addresses.length === 0) return;
		for (const address of addresses) {
			if (this.stopping || !this.link?.online || this.d.mode() !== "awake") return;
			await pingOnce(this.net, address);
			await this.d.sleep(this.d.sweepPaceMs);
		}
		await this.lan(this.d.now());
		this.d.log.info("self: probed the LAN", { addresses: addresses.length });
	}

	// ---------------------------------------------------------------- causes

	/** The link, for the signals and the machine observation: whether there is a way out, since when, and who needs it. */
	network(): { online: boolean | null; since: string | null; dependents: string[] } {
		return {
			online: this.d.self.value<boolean>("link", "online"),
			since: this.d.self.value<string>("link", "since"),
			dependents: Object.entries(this.d.needs)
				.filter(([, need]) => need === "internet")
				.map(([name]) => name),
		};
	}

	/** Why a service that is not fine is so, when the cause is outside it and known; null otherwise. */
	cause(service: string): string | null {
		const need = this.d.needs[service];
		if (!need) return null;
		const online = this.d.self.value<boolean>("link", "online");
		if (need === "internet") return online === false ? "the network is away" : null;
		const state = this.d.self.value<PeerState>("peers", need.peer);
		if (state === "on the LAN, not answering")
			return `${need.peer} is on the local network, but its server does not answer`;
		if (state === "not on the LAN") return `${need.peer} is not on the local network`;
		if (state === "unknown: the network is away") return "the network is away";
		return null;
	}

	// ---------------------------------------------------------------- reading

	private local(iso: string): string {
		return new Date(iso).toLocaleString("sv-SE", { timeZone: this.d.timezone }).slice(0, 16);
	}

	private ago(iso: string | null | undefined, now: Date): string {
		if (!iso) return "never";
		const min = Math.round((now.getTime() - Date.parse(iso)) / MIN);
		return min < 1 ? "just now" : min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
	}

	private linkLine(): string | null {
		const v = <T>(f: string) => this.d.self.value<T>("link", f);
		const online = v<boolean>("online");
		if (online === null) return null;
		const since = v<string>("since");
		const signal = v<number>("signalDbm");
		const parts = [
			v<string>("wifi") &&
				`Wi-Fi ${v<string>("wifi")}${signal !== null && v<string>("wifi") === "up" ? ` (${signal} dBm, ${v<number>("rateMbit") ?? "?"} Mbit/s)` : ""}`,
			v<string>("ethernet") && `Ethernet ${v<string>("ethernet") === "up" ? "up" : "has no link"}`,
		].filter(Boolean);
		return `${online ? "there is a way out" : "the network is away (no default route)"}${since ? ` since ${this.local(since)}` : ""}; ${parts.join(", ") || "no network hardware seen"}${online && v<string>("gateway") ? `; the gateway ${v<string>("gateway")}` : ""}`;
	}

	private peerLines(): string[] {
		return this.d.peers().map((p) => {
			const state = this.d.self.value<PeerState>("peers", p.endpoint) ?? "not looked at yet";
			return `${p.endpoint} (${p.serves}): ${state}`;
		});
	}

	/** `/self network`: the link, its last changes, and the machines Iyye uses. */
	networkReport(): string {
		const line = this.linkLine();
		if (!line) return "the network has not been looked at yet";
		const changes = this.d.db
			.prepare(
				"SELECT field, new_json, at FROM self_changes WHERE facet IN ('link', 'peers') AND old_json IS NOT NULL ORDER BY at DESC LIMIT 12",
			)
			.all() as { field: string; new_json: string; at: string }[];
		const say = (c: { field: string; new_json: string }) => {
			const v = JSON.parse(c.new_json) as unknown;
			if (c.field === "online") return v ? "the network came back" : "the network went away";
			if (c.field === "wifi" || c.field === "ethernet")
				return `${c.field === "wifi" ? "Wi-Fi" : "Ethernet"} ${v ?? "gone"}`;
			return `${c.field}: ${v}`;
		};
		const peers = this.peerLines();
		const needs = this.network().dependents;
		return [
			`network: ${line}`,
			...(needs.length ? [`needs a way out: ${needs.join(", ")}`] : []),
			...(peers.length ? ["machines Iyye uses:", ...peers.map((p) => `  ${p}`)] : []),
			changes.length ? "last changes (newest first):" : "no change recorded yet",
			...changes.map((c) => `  ${this.local(c.at)}  ${say(c)}`),
			"hosts on the local network: /self hosts",
		].join("\n");
	}

	/** `/self hosts`: who has been seen on the local network. */
	hostsReport(): string {
		if (this.d.lan === "off") return "the local network is not looked at (IYYE2_SELF_LAN=off)";
		const now = this.d.now();
		const hosts = listHosts(this.d.db);
		if (hosts.length === 0) return "no host seen on the local network yet";
		const known = this.known();
		const s = this.sweeps(now);
		return [
			`hosts seen on the local network (${this.d.lan === "active" ? `the neighbour table, and a probe of the subnet at most ${this.d.sweepsPerDay} a day; ${s.n} today` : "the neighbour table only"}):`,
			...hosts.map(
				(h) =>
					`  ${h.id.slice(0, 6)}  ${h.address ?? "?"}  ${h.label ?? known.get(h.id) ?? "unnamed"} — seen ${this.ago(h.last_seen, now)}, first ${this.local(h.first_seen).slice(0, 10)}, on ${h.days_seen} day(s)`,
			),
			"name one: /self host <id> <name> · forget one: /self host <id> forget",
		].join("\n");
	}

	/** Hosts Iyye can name itself: the gateway, and the machines it is configured to use. */
	private known(): Map<string, string> {
		const out = new Map<string, string>();
		const by = (ip: string | null) => this.neighbours.find((n) => n.ip === ip && isLanHost(n));
		const gw = by(this.link?.gateway ?? null);
		if (gw?.mac) out.set(hostId(gw.mac), "the gateway");
		for (const p of this.d.peers()) {
			const n = by(p.address);
			if (n?.mac) out.set(hostId(n.mac), p.endpoint);
		}
		return out;
	}

	private host(args: string[]): string {
		const [idStart, ...words] = args;
		if (!idStart || words.length === 0) return "usage: /self host <id> <name> · /self host <id> forget";
		const h: LanHost | string = findHost(this.d.db, idStart.toLowerCase());
		if (typeof h === "string") return h;
		if (words.length === 1 && words[0] === "forget") {
			forgetHost(this.d.db, h.id);
			return `forgotten: ${h.id.slice(0, 6)} is no longer listed, also when it comes back`;
		}
		const name = words.join(" ").trim().slice(0, 80);
		labelHost(this.d.db, h.id, name);
		return `noted: ${h.id.slice(0, 6)} is ${name}`;
	}

	/** `/self network | hosts | host …`; null when the words are not these. */
	command(args: string[]): string | null {
		switch (args[0]) {
			case "network":
				return this.networkReport();
			case "hosts":
				return this.hostsReport();
			case "host":
				return this.host(args.slice(1));
			default:
				return null;
		}
	}

	/** A line for the owner's about-me note. */
	aboutLines(): string[] {
		const line = this.linkLine();
		if (!line) return [];
		const peers = this.peerLines();
		return [`- Network: ${line}.${peers.length ? ` Machines you use: ${peers.join("; ")}.` : ""}`];
	}
}

/** The private IPv4 address a URL names, or null. */
export function privateAddressOf(url: string): string | null {
	try {
		const host = new URL(url).hostname;
		return /^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivate(host) ? host : null;
	} catch {
		return null;
	}
}
