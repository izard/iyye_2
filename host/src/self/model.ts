// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The extended self model (plan 0.010 M0b, §3.1): what Iyye knows about
 * what and where it is, field by field, each with its source and age.
 *
 * - **Facets:** hardware, power, sleep (the last day's sleep history),
 *   versions, network, place (an estimate from the network, and the place
 *   the owner stated), and the owner's statements about people (social).
 *   Disk, memory and services are not probed again here: they come from the
 *   latest `machine` observation (one source of truth). The social circle
 *   itself (who writes, how often, trust) is derived live from records.
 * - **Observe and record only (M0b):** probes run on their own while Iyye is
 *   awake, when a facet is due; nothing here notifies anyone or asks a
 *   question (questions to the owner come in M1).
 * - **History and memory:** stable fields (hardware, versions, network,
 *   place) keep their changes in `self_changes`; volatile ones (battery,
 *   lid, sleep counts) just update. A stable change of hardware, versions
 *   or place is retained once in short-term memory (scope `iyye`, so the
 *   bank `iyye-self` at night) under a deterministic id. The owner's
 *   statements about people are never retained: `/forget` deletes them here,
 *   and they must not live on in a bank it does not delete.
 * - **Privacy:** place, network and people are owner-only; `aboutMe` is for
 *   the owner's turns only.
 */

import { createHash } from "node:crypto";
import type { Logger } from "../log.ts";
import { accountsOf, findContacts, getContact, OWNER_CONTACT_ID, resolvePerson } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { recordIyyeEntry } from "../state/stm.ts";
import {
	type Exec,
	execAsync,
	type Hardware,
	type ListDir,
	listSysDir,
	type Network,
	type Power,
	probeHardware,
	probeHardwareLinux,
	probeNetwork,
	probeNetworkLinux,
	probePlace,
	probePower,
	probePowerLinux,
	probeSleep,
	probeSleepLinux,
	probeVersions,
	type ReadFile,
	readSysFile,
	type SleepHistory,
	solarTimes,
	type Versions,
} from "./probes.ts";

export type Facet = "hardware" | "power" | "sleep" | "versions" | "network" | "place" | "social";
export type Source = "probe" | "owner" | "estimate";

export interface SelfFact {
	facet: Facet;
	field: string;
	value_json: string;
	source: Source;
	source_ref: string | null;
	observed_at: string;
}

/** How often each probed facet is refreshed while awake. */
export const WINDOWS_MS: Record<"hardware" | "power" | "sleep" | "versions" | "network" | "place", number> = {
	hardware: 24 * 3_600_000,
	versions: 24 * 3_600_000,
	power: 10 * 60_000,
	sleep: 30 * 60_000,
	network: 30 * 60_000,
	place: 24 * 3_600_000,
};

/**
 * Facets probed with each platform's own tools: on macOS `system_profiler`, `sw_vers`, `pmset`, `ioreg`; on
 * Linux (the DGX Spark, 2026-10-10) DMI, `lscpu`, `nvidia-smi`, `/sys/class/power_supply`, the ACPI lid and the
 * kernel journal. Elsewhere they are not probed at all: no failing probe every few minutes, no "stale" gap.
 */
const PLATFORM_PROBED: ReadonlySet<Facet> = new Set(["hardware", "power", "sleep"]);

const STABLE: ReadonlySet<Facet> = new Set(["hardware", "versions", "network", "place"]);
const RETAINED: ReadonlySet<Facet> = new Set(["hardware", "versions", "place"]);

export interface SelfModelDeps {
	db: Db;
	log: Logger;
	mode: () => "awake" | "winding_down" | "asleep";
	/** The iyye_2 repository, the host directory, and the llama-server path (for versions). */
	repoDir: string;
	hostDir: string;
	llamaServer: string;
	/** The guarded HTTP client, for the IP-geolocation estimate; null switches it off. */
	geoHttp: { get(url: string): Promise<{ status: number; body: string }> } | null;
	exec?: Exec;
	/** The platform the probes run on (tests); `process.platform` by default. */
	platform?: NodeJS.Platform;
	/** Linux system files and directories (tests replace them). */
	readFile?: ReadFile;
	listDir?: ListDir;
	now?: () => Date;
	newId?: () => string;
	tickMs?: number;
	timezone?: string;
	/** Live facts the host already knows, for the about-me block. */
	/** `models`: each role's selected model; `loaded`: what the router has loaded now (one copy each). */
	live?: () => { models: Record<string, string | null>; loaded: string[]; mode: string; day: number | null };
}

export interface Gap {
	facet: Facet;
	field: string;
	kind: "missing" | "stale" | "contradicted";
	why: string;
	/** For a contradiction seen on a network: that network (a new network is a new episode). */
	episode?: string;
}

/** Relation words recognised in the owner's own statements (plan 0.010 M1). */
const RELATIONS = [
	"son",
	"daughter",
	"wife",
	"husband",
	"partner",
	"father",
	"dad",
	"mother",
	"mom",
	"brother",
	"sister",
	"friend",
	"colleague",
	"boss",
	"grandmother",
	"grandfather",
	"grandson",
	"granddaughter",
	"uncle",
	"aunt",
	"cousin",
	"nephew",
	"niece",
];

/**
 * A relation the owner stated about a person, from the owner's own facts
 * (2026-10-07: the owner's bank said "his wife, Julia, and son Jacob" while
 * the self model still asked who Jacob is): the relation word nearest before
 * the name, within a few words, in one sentence. Null when none.
 */
export function relationIn(name: string, facts: readonly string[]): string | null {
	const n = name.trim().split(/\s+/)[0]!.toLowerCase();
	for (const fact of facts) {
		for (const sentence of fact.split(/[.;!?]/)) {
			const t = sentence.toLowerCase();
			const at = t.search(new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "u"));
			if (at < 0) continue;
			const before = t.slice(Math.max(0, at - 40), at);
			let best: { word: string; pos: number } | null = null;
			for (const w of RELATIONS) {
				const m = [...before.matchAll(new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "gu"))].at(-1);
				if (m && (!best || m.index! > best.pos)) best = { word: w, pos: m.index! };
			}
			if (best) return best.word;
		}
	}
	return null;
}

export class SelfModel {
	private readonly d: Required<SelfModelDeps>;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	/** Why a facet's last probe failed, until it succeeds. */
	private readonly errors = new Map<Facet, string>();

	constructor(deps: SelfModelDeps) {
		this.d = {
			exec: execAsync,
			platform: process.platform,
			readFile: readSysFile,
			listDir: listSysDir,
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			tickMs: 60_000,
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			live: () => ({ models: {}, loaded: [], mode: "awake", day: null }),
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
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.running;
	}

	/** Refresh every due facet (awake only). Public for tests. */
	tick(force: readonly Facet[] = []): Promise<void> {
		if (this.running) return this.running;
		this.running = this.refreshDue(force).finally(() => {
			this.running = null;
		});
		return this.running;
	}

	/** After waking (the rhythm's `afterWake`): power, last night's sleep and the network, at once. */
	afterWake(): Promise<void> {
		return this.tick(["power", "sleep", "network"]);
	}

	private async refreshDue(force: readonly Facet[]): Promise<void> {
		if (this.d.mode() !== "awake") return;
		const now = this.d.now();
		const due = (Object.keys(WINDOWS_MS) as (keyof typeof WINDOWS_MS)[]).filter(
			(f) =>
				this.probeable(f) &&
				(force.includes(f) || this.ageMs(f, now) === null || this.ageMs(f, now)! >= WINDOWS_MS[f]),
		);
		const order: (keyof typeof WINDOWS_MS)[] = ["hardware", "versions", "power", "sleep", "network", "place"];
		for (const facet of order.filter((f) => due.includes(f))) {
			try {
				await this.refresh(facet, now);
				this.errors.delete(facet);
			} catch (err) {
				this.errors.set(facet, (err as Error).message.slice(0, 200));
				this.d.log.warn("self: probe failed", { facet, error: (err as Error).message });
			}
		}
	}

	private async refresh(facet: keyof typeof WINDOWS_MS, now: Date): Promise<void> {
		switch (facet) {
			case "hardware":
				return this.setFacet(
					"hardware",
					{
						...(await (this.linux
							? probeHardwareLinux(this.d.exec, this.d.readFile)
							: probeHardware(this.d.exec))),
					},
					"probe",
					null,
					now,
				);
			case "power":
				return this.setFacet(
					"power",
					{ ...(this.linux ? probePowerLinux(this.d.readFile, this.d.listDir) : await probePower(this.d.exec)) },
					"probe",
					null,
					now,
				);
			case "sleep":
				return this.setFacet(
					"sleep",
					{ ...(await (this.linux ? probeSleepLinux(this.d.exec, now) : probeSleep(this.d.exec, now))) },
					"probe",
					null,
					now,
				);
			case "versions":
				return this.setFacet(
					"versions",
					{
						...(await probeVersions(this.d.exec, {
							repoDir: this.d.repoDir,
							hostDir: this.d.hostDir,
							llamaServer: this.d.llamaServer,
						})),
					},
					"probe",
					null,
					now,
				);
			case "network": {
				const before = this.value<Network["networkId"]>("network", "networkId");
				await this.setFacet(
					"network",
					{ ...(await (this.linux ? probeNetworkLinux(this.d.exec) : probeNetwork(this.d.exec))) },
					"probe",
					null,
					now,
				);
				const after = this.value<Network["networkId"]>("network", "networkId");
				// A new network: the place estimate is due again (once a day otherwise).
				if (before && after && before !== after) await this.refresh("place", now);
				return;
			}
			case "place": {
				if (!this.d.geoHttp) return;
				const p = await probePlace(this.d.geoHttp);
				const { service, ...fields } = p;
				return this.setFacet("place", prefix("estimate_", fields), "estimate", service, now);
			}
		}
	}

	/** Record a facet's fields; stable fields keep their changes, and a stable facet's change is retained once. */
	setFacet(facet: Facet, fields: Record<string, unknown>, source: Source, ref: string | null, now: Date): void {
		const at = now.toISOString();
		const changed: string[] = [];
		this.d.db.transaction(() => {
			for (const [field, v] of Object.entries(fields)) {
				const json = JSON.stringify(v ?? null);
				const old = this.d.db
					.prepare("SELECT value_json FROM self_facts WHERE facet = ? AND field = ?")
					.get(facet, field) as { value_json: string } | undefined;
				this.d.db
					.prepare(
						`INSERT INTO self_facts (facet, field, value_json, source, source_ref, observed_at) VALUES (?, ?, ?, ?, ?, ?)
						 ON CONFLICT (facet, field) DO UPDATE SET value_json = excluded.value_json, source = excluded.source,
							source_ref = excluded.source_ref, observed_at = excluded.observed_at`,
					)
					.run(facet, field, json, source, ref, at);
				if (STABLE.has(facet) && old?.value_json !== json) {
					changed.push(field);
					this.d.db
						.prepare(
							"INSERT INTO self_changes (id, facet, field, old_json, new_json, source, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
						)
						.run(this.d.newId(), facet, field, old?.value_json ?? null, json, source, at);
				}
			}
		})();
		if (changed.length && RETAINED.has(facet)) this.retain(facet, now);
	}

	/** One short dated statement of a stable facet in short-term memory, once per distinct content. */
	private retain(facet: Facet, now: Date): void {
		const text = this.describeFacet(facet);
		if (!text) return;
		const id = `self:${facet}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
		recordIyyeEntry(this.d.db, {
			id,
			kind: "observation",
			text: `${now.toISOString().slice(0, 10)}, Iyye's self model: ${text}`,
			at: now.toISOString(),
		});
	}

	// ---------------------------------------------------------------- owner statements

	/** `/self set place|expected-hardware <text>` and `/self relation <contact> <text>`. */
	command(args: string[], by: string): string {
		const [sub, ...rest] = args;
		const now = this.d.now();
		if (!sub) return this.report();
		if (sub === "set" && (rest[0] === "place" || rest[0] === "expected-hardware")) {
			const text = rest.slice(1).join(" ").trim().slice(0, 300);
			if (!text) return `usage: /self set ${rest[0]} <text>`;
			const [facet, field] =
				rest[0] === "place" ? (["place", "stated"] as const) : (["hardware", "expected"] as const);
			this.setFacet(facet, { [field]: text }, "owner", by, now);
			return `noted: ${rest[0] === "place" ? "Iyye is at" : "expected hardware:"} ${text}`;
		}
		if (sub === "relation" && rest.length >= 2) {
			const people = new Map(findContacts(this.d.db, rest[0]!).map((c) => [resolvePerson(this.d.db, c).id, c]));
			if (people.size !== 1)
				return people.size
					? `${rest[0]} matches ${people.size} people; use an id (see /contacts)`
					: `no contact matches ${rest[0]}`;
			const person = resolvePerson(this.d.db, [...people.values()][0]!);
			if (person.id === OWNER_CONTACT_ID) return "that is you";
			const text = rest.slice(1).join(" ").trim().slice(0, 200);
			this.setFacet("social", { [`relation:${person.id}`]: text }, "owner", by, now);
			return `noted: ${person.display_name} — ${text}`;
		}
		if (sub === "estimate" && rest[0] === "misleading") {
			const network = this.value<string>("network", "networkId");
			if (!network) return "the network is not known yet; try again in a few minutes";
			this.setFacet("place", { estimate_misleading: network }, "owner", by, now);
			return "noted: on this network the location estimate is misleading; it no longer contradicts what you said (a new network is checked afresh)";
		}
		if (sub === "clear" && rest[0]) {
			let field: [Facet, string] | null = null;
			if (rest[0] === "place") field = ["place", "stated"];
			else if (rest[0] === "expected-hardware") field = ["hardware", "expected"];
			else if (rest[0] === "relation" && rest[1]) {
				const c = findContacts(this.d.db, rest[1])[0];
				if (!c) return `no contact matches ${rest[1]}`;
				field = ["social", `relation:${resolvePerson(this.d.db, c).id}`];
			}
			if (!field) return "usage: /self clear place | expected-hardware | relation <contact>";
			const n = this.d.db
				.prepare("DELETE FROM self_facts WHERE facet = ? AND field = ?")
				.run(field[0], field[1]).changes;
			return n ? "cleared" : "nothing to clear";
		}
		return "usage: /self · /self set place <text> · /self set expected-hardware <text> · /self relation <contact> <text> · /self clear …";
	}

	// ---------------------------------------------------------------- reading

	value<T>(facet: Facet, field: string): T | null {
		const r = this.d.db
			.prepare("SELECT value_json FROM self_facts WHERE facet = ? AND field = ?")
			.get(facet, field) as { value_json: string } | undefined;
		return r ? (JSON.parse(r.value_json) as T) : null;
	}

	private facts(facet: Facet): SelfFact[] {
		return this.d.db.prepare("SELECT * FROM self_facts WHERE facet = ? ORDER BY field").all(facet) as SelfFact[];
	}

	/** Age of a probed facet (its newest probe), or null if never probed. */
	/** Whether this machine can probe a facet at all (`PLATFORM_PROBED`: macOS and Linux). */
	private probeable(facet: Facet): boolean {
		return this.d.platform === "darwin" || this.d.platform === "linux" || !PLATFORM_PROBED.has(facet);
	}

	private get linux(): boolean {
		return this.d.platform === "linux";
	}

	ageMs(facet: Facet, now: Date): number | null {
		const r = this.d.db
			.prepare("SELECT max(observed_at) AS at FROM self_facts WHERE facet = ? AND source != 'owner'")
			.get(facet) as { at: string | null };
		return r.at ? now.getTime() - Date.parse(r.at) : null;
	}

	/**
	 * Gaps, the curiosity signals of M0 (§3.1): a facet never probed or
	 * stale (twice its window, so a failing probe), the stated place missing,
	 * people who write but whose relation the owner never stated, and a
	 * network estimate that contradicts the stated place or the timezone.
	 */
	gaps(): Gap[] {
		const now = this.d.now();
		const gaps: Gap[] = [];
		for (const [facet, window] of Object.entries(WINDOWS_MS) as [keyof typeof WINDOWS_MS, number][]) {
			if (facet === "place" && !this.d.geoHttp) continue;
			if (!this.probeable(facet)) continue;
			const age = this.ageMs(facet, now);
			if (age === null) gaps.push({ facet, field: "*", kind: "missing", why: `${facet} was never probed` });
			else if (age > 2 * window)
				gaps.push({
					facet,
					field: "*",
					kind: "stale",
					why: `${facet} is ${Math.round(age / 3_600_000)} h old${this.errors.has(facet) ? ` (${this.errors.get(facet)})` : ""}`,
				});
		}
		const stated = this.value<string>("place", "stated");
		if (!stated)
			gaps.push({ facet: "place", field: "stated", kind: "missing", why: "the owner never said where Iyye is" });
		const city = this.value<string>("place", "estimate_city");
		// The owner said this network's location is misleading (M1): its estimate contradicts nothing.
		const network = this.value<string>("network", "networkId") ?? "unknown";
		const trusted = this.value<string>("place", "estimate_misleading") !== network;
		if (trusted && stated && city && !stated.toLowerCase().includes(city.toLowerCase()))
			gaps.push({
				facet: "place",
				field: "stated",
				kind: "contradicted",
				why: `the network places Iyye in ${city}, the owner said ${JSON.stringify(stated)}`,
				episode: network,
			});
		const tz = this.value<string>("place", "estimate_timezone");
		if (trusted && tz && tz !== this.d.timezone)
			gaps.push({
				facet: "place",
				field: "estimate_timezone",
				kind: "contradicted",
				why: `the network says ${tz}, the computer uses ${this.d.timezone}`,
				episode: network,
			});
		for (const p of this.people(30).filter((p) => !p.relation))
			gaps.push({
				facet: "social",
				field: `relation:${p.id}`,
				kind: "missing",
				why: `who ${p.name} is to the owner is unknown`,
			});
		return gaps;
	}

	/** People who wrote in the last `days` days (accounts folded into their person), most recent first. */
	people(
		days: number,
	): { id: string; name: string; lastSeen: string; messages: number; trusted: boolean; relation: string | null }[] {
		const since = new Date(this.d.now().getTime() - days * 86_400_000).toISOString();
		const rows = this.d.db
			.prepare(
				`SELECT principal_contact_id AS id, max(received_at) AS last, count(*) AS n FROM events
				 WHERE principal_contact_id IS NOT NULL AND principal_contact_id != ? AND received_at >= ? AND status != 'dropped'
				 GROUP BY principal_contact_id ORDER BY last DESC LIMIT 20`,
			)
			.all(OWNER_CONTACT_ID, since) as { id: string; last: string; n: number }[];
		// An account is its person (2026-10-07: the owner's linked Telegram accounts, whose older events name the
		// account, were "people whose relation is unknown"); a person with several accounts appears once.
		const seen = new Set<string>();
		return rows.flatMap((r) => {
			const account = getContact(this.d.db, r.id);
			const c = account && resolvePerson(this.d.db, account);
			if (!c || c.kind === "owner" || seen.has(c.id)) return [];
			seen.add(c.id);
			return [
				{
					id: c.id,
					name: c.display_name,
					lastSeen: r.last,
					messages: r.n,
					trusted: c.trusted === 1,
					relation: this.value<string>("social", `relation:${c.id}`),
				},
			];
		});
	}

	/** One line per stable facet, for memory and the about-me block; null when nothing is known. */
	describeFacet(facet: Facet): string | null {
		if (facet === "hardware") {
			const h = Object.fromEntries(
				this.facts("hardware").map((f) => [f.field, JSON.parse(f.value_json)]),
			) as Partial<Hardware & { expected: string }>;
			const parts = [
				h.machine && `${h.machine}${h.model ? ` (${h.model})` : ""}`,
				h.chip,
				h.cores && `${h.cores} cores`,
				h.memoryGb && `${h.memoryGb} GB memory`,
				h.os,
			].filter(Boolean);
			const expected = h.expected ? ` Expected (the owner said): ${h.expected}.` : "";
			return parts.length || expected
				? `Iyye runs on ${parts.join(", ") || "an unknown machine"}.${expected}`
				: null;
		}
		if (facet === "versions") {
			const v = Object.fromEntries(
				this.facts("versions").map((f) => [f.field, JSON.parse(f.value_json)]),
			) as Partial<Versions>;
			if (!v.iyye && !v.node) return null;
			return `Iyye's code is at commit ${v.iyye ?? "?"}, on Node ${v.node ?? "?"}, Pi ${v.pi ?? "?"}, llama.cpp ${v.llamaBuild ?? "?"}.`;
		}
		if (facet === "place") {
			const stated = this.value<string>("place", "stated");
			const city = [
				this.value("place", "estimate_city"),
				this.value("place", "estimate_region"),
				this.value("place", "estimate_country"),
			]
				.filter(Boolean)
				.join(", ");
			if (!stated && !city) return null;
			return [stated && `The owner says Iyye is at ${stated}.`, city && `The network places it in ${city}.`]
				.filter(Boolean)
				.join(" ");
		}
		return null;
	}

	/**
	 * The owner's about-me block (request-local, owner turns only): each line
	 * with its age, and live figures sent to `system_status`.
	 */
	aboutMe(machine: { result: Record<string, unknown>; at: string } | null): string {
		const now = this.d.now();
		const age = (at: string | null | undefined) => {
			if (!at) return "never checked";
			const min = Math.round((now.getTime() - Date.parse(at)) / 60_000);
			return min < 1 ? "just now" : min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
		};
		const facetAt = (facet: Facet) =>
			(
				this.d.db.prepare("SELECT max(observed_at) AS at FROM self_facts WHERE facet = ?").get(facet) as {
					at: string | null;
				}
			).at;
		const lines: string[] = [];
		const hw = this.describeFacet("hardware");
		if (hw) lines.push(`- Hardware: ${hw} [${age(facetAt("hardware"))}]`);
		const p = Object.fromEntries(
			this.facts("power").map((f) => [f.field, JSON.parse(f.value_json)]),
		) as Partial<Power>;
		if (p.source)
			lines.push(
				`- Power: on ${p.source === "AC" ? "the power adapter" : "battery"}${p.batteryPct !== null && p.batteryPct !== undefined ? `, battery ${p.batteryPct}%` : ""}${p.lidClosed === true ? ", lid closed" : p.lidClosed === false ? ", lid open" : ""} [${age(facetAt("power"))}]`,
			);
		const s = Object.fromEntries(
			this.facts("sleep").map((f) => [f.field, JSON.parse(f.value_json)]),
		) as Partial<SleepHistory>;
		if (s.sleeps !== undefined)
			lines.push(
				`- The computer's sleep, last 24 h: asleep ${Math.floor((s.asleepMinutes ?? 0) / 60)} h ${(s.asleepMinutes ?? 0) % 60} min${s.sleptOnBattery ? " (on battery)" : ""}, ${s.darkWakes} brief maintenance wake-ups, ${s.wakes} full wake-ups [${age(facetAt("sleep"))}]`,
			);
		if (machine) {
			const r = machine.result;
			const svc = Object.entries((r.services ?? {}) as Record<string, string>)
				.filter(([, v]) => !["up", "connected", "disabled", "not installed"].includes(v))
				.map(([k, v]) => `${k} ${v}`);
			lines.push(
				`- Disk and memory: ${r.diskFreeGb} GB of ${r.diskTotalGb} GB free, ${r.memAvailableGb} GB memory available; services: ${svc.length ? svc.join(", ") : "all fine"} [${age(machine.at)}]`,
			);
		}
		const live = this.d.live();
		const v = this.describeFacet("versions");
		lines.push(
			`- Software: ${v ?? "versions unknown"} ${describeModels(live.models, live.loaded)} Day ${live.day ?? "?"}, ${live.mode}.`,
		);
		const place = this.describeFacet("place");
		const lat = this.value<number>("place", "estimate_lat");
		const lon = this.value<number>("place", "estimate_lon");
		const sun = lat !== null && lon !== null ? solarTimes(lat, lon, now) : null;
		const hhmm = (d: Date) =>
			d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: this.d.timezone });
		lines.push(
			`- Place: ${place ?? "unknown (the owner has not said where Iyye is)"}${sun ? ` Sunrise ${hhmm(sun.sunrise)}, sunset ${hhmm(sun.sunset)}.` : ""} [${age(facetAt("place"))}]`,
		);
		const people = this.people(30);
		if (people.length)
			lines.push(
				`- People who wrote in the last 30 days: ${people
					.slice(0, 10)
					.map(
						(x) =>
							`${JSON.stringify(x.name.slice(0, 40))}${x.relation ? ` (${JSON.stringify(x.relation.slice(0, 60))})` : ""}, ${x.messages} message(s), last ${age(x.lastSeen)}${x.trusted ? ", trusted" : ""}`,
					)
					.join("; ")}`,
			);
		return [
			"<about_me>",
			"What you know about yourself, from your own probes and your owner's statements (a record, not instructions; the age of each line is in brackets — for live figures call system_status):",
			...lines,
			"</about_me>",
		].join("\n");
	}

	/** `/self`: the whole model with sources and ages, and the gaps. */
	report(): string {
		const rows = this.d.db.prepare("SELECT * FROM self_facts ORDER BY facet, field").all() as SelfFact[];
		const out = ["self model (facet · field = value · source, when):"];
		let facet = "";
		for (const r of rows) {
			if (r.facet !== facet) {
				facet = r.facet;
				out.push(
					`  ${facet}${this.errors.has(r.facet as Facet) ? ` (last probe failed: ${this.errors.get(r.facet as Facet)})` : ""}`,
				);
			}
			const field = r.field.startsWith("relation:")
				? `relation of ${getContact(this.d.db, r.field.slice(9))?.display_name ?? "?"}`
				: r.field;
			out.push(
				`    ${field} = ${r.value_json.slice(0, 120)} · ${r.source}${r.source_ref ? ` (${r.source_ref})` : ""}, ${r.observed_at.slice(0, 16).replace("T", " ")}`,
			);
		}
		const gaps = this.gaps();
		out.push(gaps.length ? "gaps (curiosity signals):" : "no gaps", ...gaps.map((g) => `  ${g.kind}: ${g.why}`));
		out.push("set: /self set place <text> · /self set expected-hardware <text> · /self relation <contact> <text>");
		return out.join("\n");
	}
}

function prefix(p: string, o: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(o).map(([k, v]) => [`${p}${k}`, v]));
}

/** `/forget` (plan 0.002 L6): the owner's statements about this person go, and their history. Call inside the forget transaction. */
export function forgetSelfFacts(db: Db, personIds: readonly string[]): void {
	for (const id of personIds) {
		for (const a of [id, ...accountsOf(db, id).map((c) => c.id)]) {
			db.prepare("DELETE FROM self_facts WHERE facet = 'social' AND field = ?").run(`relation:${a}`);
			db.prepare("DELETE FROM self_changes WHERE facet = 'social' AND field = ?").run(`relation:${a}`);
		}
	}
}

/** The latest `machine` observation (disk, memory, services): the self model's low-level figures come from it, not a second probe. */
export function latestMachine(db: Db): { result: Record<string, unknown>; at: string } | null {
	const r = db
		.prepare("SELECT result_json, at FROM observations WHERE domain = 'machine' ORDER BY at DESC LIMIT 1")
		.get() as { result_json: string; at: string } | undefined;
	return r ? { result: JSON.parse(r.result_json) as Record<string, unknown>, at: r.at } : null;
}

/** The about-me note for a turn: the owner's scope only (place, network and people are owner-only). */
const ROLE_NAMES: Record<string, string> = { web: "web chat", telegram: "Telegram", background: "background work" };

/**
 * Loaded models with what each serves, then selected ones that are not loaded. Grouped by model: a list of
 * roles ("web gemma-4-26B, telegram gemma-4-26B") read as two loaded copies (2026-10-23).
 */
export function describeModels(selected: Record<string, string | null>, loaded: readonly string[]): string {
	const roles = new Map<string, string[]>();
	for (const [role, m] of Object.entries(selected))
		if (m) roles.set(m, [...(roles.get(m) ?? []), ROLE_NAMES[role] ?? role]);
	const serves = (m: string) => {
		const r = roles.get(m) ?? [];
		return r.length === 0 ? "no role" : r.length === 1 ? r[0]! : `${r.slice(0, -1).join(", ")} and ${r.at(-1)}`;
	};
	const out = [
		`Models loaded (one copy each): ${loaded.length ? loaded.map((m) => `${m} (${serves(m)})`).join(", ") : "none"}.`,
	];
	const missing = [...roles.keys()].filter((m) => !loaded.includes(m));
	if (missing.length) out.push(`Selected but not loaded: ${missing.map((m) => `${m} (${serves(m)})`).join(", ")}.`);
	return out.join(" ");
}

export function selfNoteFor(scope: string, model: Pick<SelfModel, "aboutMe">, db: Db): string | null {
	return scope === "owner" ? model.aboutMe(latestMachine(db)) : null;
}
