// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed read-only probes of the network Iyye is on (plan 0.018 W2): whether
 * there is a link and a way out, how good the Wi-Fi is, whether the gateway
 * answers, and which hosts the kernel has seen on the local network.
 *
 * - **The link is read from files** on Linux (`/sys/class/net`,
 *   `/proc/net/route`): no process is started, so it can be read every
 *   minute and a change is known when it happens (W0: the 30-minute probe
 *   caught the nightly gap on 5 of 14 days).
 * - **Nothing identifying is kept:** a hardware address only as a hash, no
 *   host name, no network name, no public address. A private (RFC 1918)
 *   address of a host on the local network is kept, owner-only (owner
 *   decision 2).
 * - **The active probe** (owner decision 2: allowed, rarely) is one echo
 *   request to each address of the local subnet, one at a time; it only makes
 *   the kernel look, and what is kept is still the neighbour table. Never a
 *   port, never beyond the local subnet, never a subnet wider than /22.
 */

import { createHash } from "node:crypto";
import type { NetworkInterfaceInfo } from "node:os";
import type { Exec, ListDir, ReadFile } from "./probes.ts";

export interface NetDeps {
	exec: Exec;
	readFile: ReadFile;
	listDir: ListDir;
	platform: NodeJS.Platform;
	/** `os.networkInterfaces()`. */
	interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

/** RFC 1918 and link-local IPv4. */
export function isPrivate(ip: string): boolean {
	return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip);
}

// ---------------------------------------------------------------- the link

export interface Link {
	/** A default route exists: there is a way out of this machine. */
	online: boolean;
	/** "up", "down" (the hardware is there, no link), or null (no such hardware). */
	wifi: "up" | "down" | null;
	ethernet: "up" | "down" | null;
	/** The interface the default route uses, and the gateway on it; never stored. */
	iface: string | null;
	gateway: string | null;
}

const hexIp = (h: string) => [6, 4, 2, 0].map((i) => Number.parseInt(h.slice(i, i + 2), 16)).join("."); // little-endian, as the kernel prints it

/** `/proc/net/route`: the default route's interface and gateway, or null when there is none. */
export function parseRouteTable(text: string | null): { iface: string; gateway: string } | null {
	for (const line of (text ?? "").split("\n").slice(1)) {
		const [iface, dest, gateway, flags] = line.trim().split(/\s+/);
		// Up (1) and through a gateway (2), to everywhere.
		if (iface && dest === "00000000" && gateway && (Number.parseInt(flags ?? "0", 16) & 3) === 3)
			return { iface, gateway: hexIp(gateway) };
	}
	return null;
}

/** The link from the kernel's files. An interface counts when it is real hardware (it has a device). */
export function readLinkLinux(d: Pick<NetDeps, "readFile" | "listDir">): Link {
	const state: { wifi: Link["wifi"]; ethernet: Link["ethernet"] } = { wifi: null, ethernet: null };
	for (const name of d.listDir("/sys/class/net")) {
		if (d.readFile(`/sys/class/net/${name}/device/uevent`) === null) continue; // lo, bridges, tunnels
		const kind = /^DEVTYPE=wlan$/m.test(d.readFile(`/sys/class/net/${name}/uevent`) ?? "") ? "wifi" : "ethernet";
		const up = (d.readFile(`/sys/class/net/${name}/operstate`) ?? "").trim() === "up";
		if (up || state[kind] === null) state[kind] = up ? "up" : "down";
	}
	const route = parseRouteTable(d.readFile("/proc/net/route"));
	return { online: route !== null, ...state, iface: route?.iface ?? null, gateway: route?.gateway ?? null };
}

/** macOS: `route -n get default` and `ifconfig` (Wi-Fi and Ethernet are not told apart there: both count as ethernet). */
export function parseLinkMac(route: string, ifconfig: string): Link {
	const gateway = /gateway:\s*([\d.]+)/.exec(route)?.[1] ?? null;
	const iface = /interface:\s*(\S+)/.exec(route)?.[1] ?? null;
	const blocks = ifconfig.split(/\n(?=\S)/).filter((b) => /^en\d/.test(b));
	return {
		online: gateway !== null,
		wifi: null,
		ethernet: blocks.length === 0 ? null : blocks.some((b) => /status: active/.test(b)) ? "up" : "down",
		iface,
		gateway,
	};
}

export async function readLink(d: NetDeps): Promise<Link | null> {
	if (d.platform === "linux") return readLinkLinux(d);
	if (d.platform === "darwin")
		return parseLinkMac(
			await d.exec("/sbin/route", ["-n", "get", "default"]).catch(() => ""),
			await d.exec("/sbin/ifconfig", []).catch(() => ""),
		);
	return null;
}

/** `iw dev <interface> link`: the signal and the link rate (`/proc/net/wireless` is empty with the Spark's driver). */
export function parseIwLink(text: string): { signalDbm: number | null; rateMbit: number | null } {
	const n = (re: RegExp) => {
		const m = re.exec(text)?.[1];
		return m === undefined ? null : Number(m);
	};
	return { signalDbm: n(/signal: (-?\d+) dBm/), rateMbit: n(/tx bitrate: ([\d.]+) MBit/) };
}

// ---------------------------------------------------------------- neighbours

export interface Neighbour {
	ip: string;
	/** Null when the kernel asked and nobody answered. */
	mac: string | null;
}

/** `ip -j neigh`: IPv4 hosts; an entry that failed or never completed has no hardware address. */
export function parseNeighbours(json: string): Neighbour[] {
	let rows: { dst?: string; lladdr?: string; state?: string[] }[] = [];
	try {
		rows = JSON.parse(json) as typeof rows;
	} catch {
		return [];
	}
	return rows.flatMap((r) => {
		if (!r.dst || !/^\d+\.\d+\.\d+\.\d+$/.test(r.dst)) return [];
		const dead = (r.state ?? []).some((s) => s === "FAILED" || s === "INCOMPLETE");
		return [{ ip: r.dst, mac: !dead && r.lladdr ? r.lladdr.toLowerCase() : null }];
	});
}

/** macOS `arp -an`: "? (192.168.1.1) at 74:24:9f:a3:7c:d5 on en0 …" or "… at (incomplete) …". */
export function parseArp(text: string): Neighbour[] {
	return text.split("\n").flatMap((line) => {
		const m = /\((\d+\.\d+\.\d+\.\d+)\) at (\S+)/.exec(line);
		if (!m) return [];
		const mac = /^[0-9a-f]{1,2}(:[0-9a-f]{1,2}){5}$/i.test(m[2]!) ? m[2]!.toLowerCase() : null;
		return [{ ip: m[1]!, mac }];
	});
}

export async function readNeighbours(d: NetDeps): Promise<Neighbour[]> {
	if (d.platform === "linux") return parseNeighbours(await d.exec("ip", ["-j", "neigh"]).catch(() => "[]"));
	if (d.platform === "darwin") return parseArp(await d.exec("/usr/sbin/arp", ["-an"]).catch(() => ""));
	return [];
}

/** A host on the local network, for the records: real, private, not a broadcast or multicast address. */
export function isLanHost(n: Neighbour): n is Neighbour & { mac: string } {
	return (
		n.mac !== null &&
		n.mac !== "ff:ff:ff:ff:ff:ff" &&
		!/^(01:00:5e|33:33)/.test(n.mac) &&
		isPrivate(n.ip) &&
		!/\.255$/.test(n.ip)
	);
}

/** An opaque id of a host: its hardware address, hashed. */
export function hostId(mac: string): string {
	return createHash("sha256").update(`lan|${mac.toLowerCase()}`).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------- the active probe

/** This machine's address and prefix on an interface, when that is a private IPv4 network. */
export function localSubnet(
	interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
	iface: string | null,
): { address: string; prefix: number } | null {
	const info = (iface ? (interfaces[iface] ?? []) : []).find((i) => i.family === "IPv4" && !i.internal);
	const prefix = Number(info?.cidr?.split("/")[1]);
	return info && isPrivate(info.address) && Number.isInteger(prefix) ? { address: info.address, prefix } : null;
}

/** Every host address of the subnet but our own; none when it is wider than /22 (1,022 hosts) or not private. */
export function subnetAddresses(address: string, prefix: number): string[] {
	if (!isPrivate(address) || prefix < 22 || prefix > 30) return [];
	const toInt = (ip: string) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
	const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
	const size = 2 ** (32 - prefix);
	const base = Math.floor(toInt(address) / size) * size;
	const out: string[] = [];
	for (let n = base + 1; n < base + size - 1; n++) if (n !== toInt(address)) out.push(toIp(n));
	return out;
}

/** One echo request to one address, waiting at most a second. Whether it answered does not matter here. */
export async function pingOnce(d: NetDeps, address: string): Promise<void> {
	if (!isPrivate(address)) return;
	const args =
		d.platform === "darwin"
			? ["-c", "1", "-t", "1", "-n", "-q", address]
			: ["-c", "1", "-W", "1", "-n", "-q", address];
	await d.exec("ping", args, { timeoutMs: 3000 }).catch(() => "");
}
