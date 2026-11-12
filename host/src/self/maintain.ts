// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.018 W7: maintenance. A fixed list of typed actions, each confined to
 * its own directories inside the state directory (`~/.iyye2`):
 *
 * - `logs`: Iyye's own service logs older than `logDays`, never the newest
 *   log of a service;
 * - `spikes`: entries of `spikes/` nothing has written to for `leftoverDays`;
 * - `sandbox`: what provisioning the sandbox left behind (the downloaded
 *   archive, unfinished attempts), never its root or a workspace;
 * - `model-cache`: Hugging Face cache entries that neither the configuration
 *   nor a provisioning record names, once they went unused for `leftoverDays`;
 * - `database`: the free pages of the SQLite database, compacted only at the
 *   end of a night.
 *
 * Report first (owner decision 6): every action measures what it would free
 * and removes nothing. Something is removed only when the owner runs an
 * action by hand (`/maintain run <action> confirm`), or, with
 * `IYYE2_MAINTAIN=allowed`, at the end of a night for the actions the owner
 * allowed (`/maintain allow <action>`) when the disk forecast asks for room.
 * Every run is a `maintenance_runs` row with what it removed, and Iyye's own
 * runs are told to the owner.
 *
 * Never: a path outside the state directory, a path reached through a link,
 * anything in a repository, a restart, an install. `remove` is the one place
 * a path is deleted, and it checks each of these again.
 */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import { getKv, setKv } from "../state/kv.ts";

export const MAINTAIN_ACTIONS = ["logs", "spikes", "sandbox", "model-cache", "database"] as const;
export type MaintainAction = (typeof MAINTAIN_ACTIONS)[number];

const DAY = 86_400_000;
const MB = 1024 * 1024;
/** The database is compacted when at least this much of it is free pages, in bytes and as a share. */
const COMPACT_MIN_BYTES = 8 * MB;
const COMPACT_MIN_SHARE = 0.1;
/** How long a measurement is quoted (the disk report, the forecast) before measuring again. */
const SNAPSHOT_MAX_AGE_MS = DAY;
const SNAPSHOT_KEY = "maintain.measured";
const UNUSED_PREFIX = "maintain.unused:";
/** Where the host's supervisors write their logs, relative to the state directory. */
const LOG_DIRS = ["logs", "memory/logs", "decisions/logs", "web/logs"];
/** `<service>-<ISO time>.log`, as `process/supervised.ts` names them. */
const STAMPED_LOG = /^(.+)-\d{4}-\d{2}-\d{2}T[\d-]+Z\.log$/;
/** Logs a running service appends to under one fixed name. */
const LIVE_LOGS = new Set(["postgres.log"]);

/** One thing an action would remove: what it is called, what it holds, and the paths that go with it. */
export interface Item {
	name: string;
	bytes: number;
	/** The directory the paths must lie in. */
	root: string;
	paths: string[];
}

export interface Measured {
	action: MaintainAction;
	items: Item[];
	bytes: number;
	/** What was looked at and is not counted, and why. */
	notes: string[];
}

export interface MaintenanceRun {
	id: string;
	action: MaintainAction;
	by: "owner" | "iyye";
	reason: string;
	at: string;
	freedBytes: number;
	removed: { name: string; bytes: number }[];
	error: string | null;
}

export interface MaintainDeps {
	db: Db;
	log: Logger;
	stateDir: string;
	/** The database's own file; null (in memory) leaves `database` unmeasured. */
	dbPath: string | null;
	mode: "off" | "report" | "allowed";
	logDays: number;
	leftoverDays: number;
	/** The Hugging Face ids long-term memory is configured with. */
	memoryModels: () => string[];
	/** The decision model's Hugging Face id, without its revision. */
	decisionsModel: () => string | null;
	/** Why the disk needs room now (the forecast's own words), or null. */
	forecast: () => string | null;
	notifyOwner: (n: { key: string; content: string }) => void;
	now?: () => Date;
}

const DESCRIPTIONS: Record<MaintainAction, (d: MaintainDeps) => string> = {
	logs: (d) => `Iyye's own service logs older than ${d.logDays} days`,
	spikes: (d) => `spike leftovers nothing wrote to for ${d.leftoverDays} days`,
	sandbox: (d) => `what provisioning the sandbox left behind, older than ${d.leftoverDays} days`,
	"model-cache": (d) => `downloaded models no configuration names, unused for ${d.leftoverDays} days`,
	database: () => "free pages of the SQLite database (compacted only at the end of a night)",
};

export function isMaintainAction(word: string | undefined): word is MaintainAction {
	return MAINTAIN_ACTIONS.includes(word as MaintainAction);
}

/** Sizes as `du` counts them (allocated blocks, a hard-linked file once), in the units the self model uses. */
export function sizeText(bytes: number): string {
	if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
	if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
	return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
}

interface Sized {
	bytes: number;
	/** The newest modification time anywhere inside, in ms. */
	newest: number;
}

/** What a path holds on disk, never following a link. `seen` counts a hard-linked file once. */
export function sizeOf(path: string, seen: Set<string> = new Set()): Sized {
	const st = lstatSync(path);
	let bytes = st.blocks * 512;
	let newest = st.mtimeMs;
	if (st.isDirectory()) {
		for (const name of readdirSync(path)) {
			const inner = sizeOf(join(path, name), seen);
			bytes += inner.bytes;
			newest = Math.max(newest, inner.newest);
		}
	} else if (st.nlink > 1) {
		const key = `${st.dev}:${st.ino}`;
		if (seen.has(key)) bytes = 0;
		seen.add(key);
	}
	return { bytes, newest };
}

function inside(dir: string, path: string): boolean {
	return path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

export class Maintenance {
	private readonly d: MaintainDeps & { now: () => Date };

	constructor(deps: MaintainDeps) {
		this.d = { now: () => new Date(), ...deps };
	}

	// ---- measuring: nothing below this line and above `run` changes a file

	/** What each action would remove now. Remembers the totals for the disk report and the forecast. */
	measure(): Measured[] {
		if (this.d.mode === "off") return [];
		const out = MAINTAIN_ACTIONS.map((a) => this.measureOne(a));
		const at = this.d.now().toISOString();
		setKv(
			this.d.db,
			SNAPSHOT_KEY,
			JSON.stringify({ at, actions: Object.fromEntries(out.map((m) => [m.action, m.bytes])) }),
			at,
		);
		return out;
	}

	measureOne(action: MaintainAction): Measured {
		const m: Measured = { action, items: [], bytes: 0, notes: [] };
		try {
			if (action === "logs") this.logs(m);
			else if (action === "spikes") this.spikes(m);
			else if (action === "sandbox") this.sandbox(m);
			else if (action === "model-cache") this.modelCache(m);
			else this.database(m);
		} catch (err) {
			// A directory that changed under the walk: say so, and count nothing of it.
			m.items = [];
			m.notes.push(`could not be measured: ${(err as Error).message}`);
		}
		m.bytes = m.items.reduce((sum, i) => sum + i.bytes, 0);
		return m;
	}

	/** A directory of the state directory that an action may look into: there, a real directory, and inside. */
	private root(rel: string, m: Measured): string | null {
		const dir = join(this.d.stateDir, rel);
		if (!existsSync(dir)) return null;
		const why = this.rootProblem(dir);
		if (why) {
			m.notes.push(`${rel}: ${why}; left alone`);
			return null;
		}
		return dir;
	}

	private rootProblem(dir: string): string | null {
		const state = realpathSync(this.d.stateDir);
		if (state === "/" || state === realpathSync(homedir()))
			return "the state directory is not a directory of its own";
		if (!lstatSync(dir).isDirectory()) return "not a directory";
		if (!inside(state, realpathSync(dir))) return "it leads outside the state directory";
		return null;
	}

	private rel(path: string): string {
		return path.slice(this.d.stateDir.length + 1);
	}

	private oldEnough(ms: number, days: number): boolean {
		return this.d.now().getTime() - ms >= days * DAY;
	}

	private logs(m: Measured): void {
		for (const rel of LOG_DIRS) {
			const dir = this.root(rel, m);
			if (!dir) continue;
			const names = readdirSync(dir)
				.filter((f) => f.endsWith(".log"))
				.sort();
			// The newest log of each service is the one it may still be writing.
			const newest = new Map<string, string>();
			for (const f of names) {
				const service = STAMPED_LOG.exec(f)?.[1];
				if (service) newest.set(service, f);
			}
			for (const f of names) {
				const service = STAMPED_LOG.exec(f)?.[1];
				if (LIVE_LOGS.has(f) || (service && newest.get(service) === f)) continue;
				const path = join(dir, f);
				const st = lstatSync(path);
				if (!st.isFile() || !this.oldEnough(st.mtimeMs, this.d.logDays)) continue;
				m.items.push({ name: this.rel(path), bytes: st.blocks * 512, root: dir, paths: [path] });
			}
		}
	}

	private spikes(m: Measured): void {
		const dir = this.root("spikes", m);
		if (!dir) return;
		const seen = new Set<string>();
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (existsSync(join(path, ".git"))) {
				m.notes.push(`${this.rel(path)}: a repository; left alone`);
				continue;
			}
			const s = sizeOf(path, seen);
			if (!this.oldEnough(s.newest, this.d.leftoverDays)) {
				m.notes.push(
					`${this.rel(path)}: ${sizeText(s.bytes)}, written to ${this.day(s.newest)}; kept until ${this.day(s.newest + this.d.leftoverDays * DAY)}`,
				);
				continue;
			}
			m.items.push({ name: this.rel(path), bytes: s.bytes, root: dir, paths: [path] });
		}
	}

	private sandbox(m: Measured): void {
		const dir = this.root("sandbox", m);
		if (!dir) return;
		const provisioned = existsSync(join(dir, "provisioned.json")) && existsSync(join(dir, "rootfs"));
		for (const name of readdirSync(dir).sort()) {
			const archive = /^alpine-minirootfs-.*\.tar\.gz$/.test(name);
			const unfinished = name.endsWith(".partial") || name.startsWith("provision-");
			if (!archive && !unfinished) continue;
			const path = join(dir, name);
			if (archive && !provisioned) {
				m.notes.push(`${this.rel(path)}: the sandbox is not provisioned from it yet; kept`);
				continue;
			}
			const s = sizeOf(path);
			if (!this.oldEnough(s.newest, this.d.leftoverDays)) continue;
			m.items.push({ name: this.rel(path), bytes: s.bytes, root: dir, paths: [path] });
		}
	}

	/** The model caches and the Hugging Face ids each one is there for; null: nothing says, so nothing is judged. */
	private caches(): { rel: string; used: string[] | null }[] {
		const record = (rel: string): unknown => {
			try {
				return JSON.parse(readFileSync(join(this.d.stateDir, rel), "utf8"));
			} catch {
				return null;
			}
		};
		const ids = (list: unknown[]): string[] =>
			list.filter((x): x is string => typeof x === "string" && x.includes("/")).map((x) => x.split("@")[0]!);
		const kev = record("decisions/provisioned.json") as { run?: unknown; base?: unknown } | null;
		const voice = record("voice/provisioned.json") as Record<string, { repo?: unknown }> | null;
		return [
			{ rel: "memory/hf/hub", used: ids(this.d.memoryModels()) },
			{
				rel: "decisions/hf/hub",
				used: kev && typeof kev.run === "string" ? ids([kev.run, kev.base, this.d.decisionsModel()]) : null,
			},
			{
				rel: "voice/hf/hub",
				used: voice && typeof voice === "object" ? ids(Object.values(voice).map((v) => v?.repo)) : null,
			},
		];
	}

	private modelCache(m: Measured): void {
		const now = this.d.now();
		const stillUnused = new Set<string>();
		for (const cache of this.caches()) {
			const hub = this.root(cache.rel, m);
			if (!hub) continue;
			if (!cache.used || cache.used.length === 0) {
				m.notes.push(`${cache.rel}: no record of what it is there for; left alone`);
				continue;
			}
			const used = new Set(cache.used.map((id) => `models--${id.replaceAll("/", "--")}`));
			// Every entry but the store and the locks keeps the stored files it links to, a linked entry too; only a
			// `models--` entry that is a directory of the hub's own can be unused.
			const entries = readdirSync(hub)
				.filter((n) => n !== "blobs" && n !== ".locks")
				.sort();
			const due: string[] = [];
			for (const name of entries) {
				if (!name.startsWith("models--") || used.has(name) || !lstatSync(join(hub, name)).isDirectory()) continue;
				const key = `${UNUSED_PREFIX}${cache.rel}/${name}`;
				stillUnused.add(key);
				const since = getKv(this.d.db, key) ?? now.toISOString();
				if (getKv(this.d.db, key) === null) setKv(this.d.db, key, since, since);
				if (this.oldEnough(Date.parse(since), this.d.leftoverDays)) due.push(name);
				else {
					const blobs = this.reach(hub, [name]);
					const bytes =
						sizeOf(join(hub, name)).bytes + this.blobBytes(blobs, this.reachOthers(hub, entries, [name]));
					m.notes.push(
						`${cache.rel}/${name}: ${sizeText(bytes)}, unused since ${this.day(Date.parse(since))}; kept until ${this.day(Date.parse(since) + this.d.leftoverDays * DAY)}`,
					);
				}
			}
			// A file of the shared store goes only if nothing that stays links to it.
			const kept = this.reachOthers(hub, entries, due);
			const taken = new Set<string>();
			for (const name of due) {
				const paths = [join(hub, name)];
				if (existsSync(join(hub, ".locks", name))) paths.push(join(hub, ".locks", name));
				let bytes = paths.reduce((sum, p) => sum + sizeOf(p).bytes, 0);
				for (const blob of this.reach(hub, [name])) {
					if (kept.has(blob) || taken.has(blob)) continue;
					taken.add(blob);
					paths.push(blob);
					bytes += lstatSync(blob).blocks * 512;
				}
				m.items.push({ name: `${cache.rel}/${name}`, bytes, root: hub, paths });
			}
		}
		// An entry that is used again, or gone, starts its wait afresh the next time it is unused.
		const rows = this.d.db.prepare("SELECT key FROM kv WHERE key LIKE ?").all(`${UNUSED_PREFIX}%`) as {
			key: string;
		}[];
		for (const r of rows) if (!stillUnused.has(r.key)) this.d.db.prepare("DELETE FROM kv WHERE key = ?").run(r.key);
	}

	/** The files of the hub's shared store (`blobs/`) that these entries link to. An entry's own files are not in it. */
	private reach(hub: string, entries: string[]): Set<string> {
		const store = join(realpathSync(hub), "blobs");
		const out = new Set<string>();
		const walk = (path: string) => {
			const st = lstatSync(path);
			if (st.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
			else if (st.isSymbolicLink()) {
				let real: string;
				try {
					real = realpathSync(path);
				} catch {
					return; // a link to nothing
				}
				if (inside(store, real) && statSync(real).isFile()) out.add(real);
			}
		};
		for (const name of entries) {
			try {
				walk(realpathSync(join(hub, name)));
			} catch {
				// a link to nothing
			}
		}
		return out;
	}

	private reachOthers(hub: string, entries: string[], except: string[]): Set<string> {
		return this.reach(
			hub,
			entries.filter((n) => !except.includes(n)),
		);
	}

	private blobBytes(blobs: Set<string>, kept: Set<string>): number {
		let bytes = 0;
		for (const b of blobs) if (!kept.has(b)) bytes += lstatSync(b).blocks * 512;
		return bytes;
	}

	private database(m: Measured): void {
		if (!this.d.dbPath) {
			m.notes.push("the database is in memory");
			return;
		}
		const free = Number(this.d.db.pragma("freelist_count", { simple: true }));
		const page = Number(this.d.db.pragma("page_size", { simple: true }));
		const size = statSync(this.d.dbPath).size;
		m.notes.push(`${this.rel(this.d.dbPath)}: ${sizeText(size)} in all`);
		if (free > 0)
			m.items.push({
				name: `${this.rel(this.d.dbPath)} (free pages)`,
				bytes: free * page,
				root: dirname(this.d.dbPath),
				paths: [],
			});
	}

	private worthCompacting(m: Measured): boolean {
		if (!this.d.dbPath || m.bytes < COMPACT_MIN_BYTES) return false;
		return m.bytes >= statSync(this.d.dbPath).size * COMPACT_MIN_SHARE;
	}

	private day(ms: number): string {
		return new Date(ms).toISOString().slice(0, 10);
	}

	// ---- removing

	/**
	 * Deletes one path. It must lie inside `root`, which must itself lie inside the state directory; neither may
	 * be reached through a link, and nothing on the way may be a repository. A link is removed, never followed.
	 */
	private remove(root: string, path: string): void {
		const why = this.rootProblem(root);
		if (why) throw new Error(`${root}: ${why}`);
		const state = realpathSync(this.d.stateDir);
		const realRoot = realpathSync(root);
		const parent = realpathSync(dirname(path));
		if (parent !== realRoot && !inside(realRoot, parent)) throw new Error(`${path} is not inside ${root}`);
		const target = join(parent, basename(path));
		if (existsSync(join(target, ".git"))) throw new Error(`${path} is a repository`);
		for (let dir = parent; ; dir = dirname(dir)) {
			if (existsSync(join(dir, ".git"))) throw new Error(`${path} is in a repository`);
			if (dir === state || dir === dirname(dir)) break;
		}
		rmSync(target, { recursive: true, force: true });
	}

	/** Runs one action now and records what it removed. Measures again first: nothing is removed from an old list. */
	run(action: MaintainAction, by: "owner" | "iyye", reason: string): MaintenanceRun {
		if (this.d.mode === "off") throw new Error("maintenance is off");
		const at = this.d.now().toISOString();
		const run: MaintenanceRun = { id: randomUUID(), action, by, reason, at, freedBytes: 0, removed: [], error: null };
		const errors: string[] = [];
		try {
			if (action === "database") this.compact(run);
			else
				for (const item of this.measureOne(action).items) {
					try {
						for (const path of item.paths) this.remove(item.root, path);
						run.removed.push({ name: item.name, bytes: item.bytes });
						run.freedBytes += item.bytes;
					} catch (err) {
						errors.push(`${item.name}: ${(err as Error).message}`);
					}
				}
		} catch (err) {
			errors.push((err as Error).message);
		}
		run.error = errors.length ? errors.join("; ").slice(0, 2000) : null;
		this.d.db
			.prepare(
				"INSERT INTO maintenance_runs (id, action, by, reason, at, freed_bytes, removed_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(run.id, action, by, reason, at, run.freedBytes, JSON.stringify(run.removed), run.error);
		this.d.log[run.error ? "warn" : "info"]("maintenance: ran", {
			action,
			by,
			removed: run.removed.length,
			freedBytes: run.freedBytes,
			...(run.error ? { error: run.error } : {}),
		});
		return run;
	}

	private compact(run: MaintenanceRun): void {
		const path = this.d.dbPath;
		if (!path) throw new Error("the database is in memory");
		const before = statSync(path).size;
		const fs = statfsSync(dirname(path));
		// VACUUM writes the whole database again beside itself before the old pages go.
		if (fs.bavail * fs.bsize < before * 2) throw new Error("not enough free disk to compact the database");
		this.d.db.pragma("wal_checkpoint(TRUNCATE)");
		this.d.db.exec("VACUUM");
		this.d.db.pragma("wal_checkpoint(TRUNCATE)");
		const freed = Math.max(0, before - statSync(path).size);
		run.removed.push({ name: `${this.rel(path)} (free pages)`, bytes: freed });
		run.freedBytes = freed;
	}

	/**
	 * The end of a completed night: measure, and with `allowed`, run what the owner allowed. Files go only when
	 * the disk forecast asks for room; the database is compacted when enough of it is free pages.
	 */
	nightly(): MaintenanceRun[] {
		if (this.d.mode === "off") return [];
		const measured = this.measure();
		if (this.d.mode !== "allowed") return [];
		const allowed = this.allowed();
		const why = this.d.forecast();
		const runs: MaintenanceRun[] = [];
		for (const m of measured) {
			if (!allowed.has(m.action) || m.bytes === 0) continue;
			if (m.action === "database") {
				if (this.worthCompacting(m)) runs.push(this.run("database", "iyye", "enough of it is free pages"));
			} else if (why) runs.push(this.run(m.action, "iyye", why));
		}
		if (runs.length === 0) return runs;
		this.measure();
		const lines = runs.map((r) => `  ${runLine(r)}`);
		this.d.notifyOwner({
			key: `maintain:${runs[0]!.id}`,
			content: [
				`Maintenance tonight${why ? ` (${why})` : ""}:`,
				...lines,
				"`/maintain runs` shows the record.",
			].join("\n"),
		});
		return runs;
	}

	// ---- the owner's side

	allowed(): Set<MaintainAction> {
		const rows = this.d.db.prepare("SELECT action FROM maintenance_allowed").all() as { action: string }[];
		return new Set(rows.map((r) => r.action).filter(isMaintainAction));
	}

	recentRuns(limit = 10): MaintenanceRun[] {
		const rows = this.d.db.prepare("SELECT * FROM maintenance_runs ORDER BY at DESC LIMIT ?").all(limit) as {
			id: string;
			action: MaintainAction;
			by: "owner" | "iyye";
			reason: string;
			at: string;
			freed_bytes: number;
			removed_json: string;
			error: string | null;
		}[];
		return rows.map((r) => ({
			id: r.id,
			action: r.action,
			by: r.by,
			reason: r.reason,
			at: r.at,
			freedBytes: r.freed_bytes,
			removed: JSON.parse(r.removed_json) as { name: string; bytes: number }[],
			error: r.error,
		}));
	}

	/** One line for the disk report and the forecast: what maintenance could remove, from a measurement a day old at most. */
	line(): string | null {
		if (this.d.mode === "off") return null;
		let snap = this.snapshot();
		if (!snap || this.d.now().getTime() - Date.parse(snap.at) > SNAPSHOT_MAX_AGE_MS) {
			this.measure();
			snap = this.snapshot();
		}
		if (!snap) return null;
		const parts = Object.entries(snap.actions).filter(([, bytes]) => bytes >= MB);
		const total = parts.reduce((sum, [, bytes]) => sum + bytes, 0);
		if (total === 0) return null;
		return `maintenance could remove ${sizeText(total)} (${parts.map(([a, bytes]) => `${a} ${sizeText(bytes)}`).join(", ")})`;
	}

	private snapshot(): { at: string; actions: Record<string, number> } | null {
		try {
			return JSON.parse(getKv(this.d.db, SNAPSHOT_KEY) ?? "null") as { at: string; actions: Record<string, number> };
		} catch {
			return null;
		}
	}

	report(): string {
		if (this.d.mode === "off") return "maintenance is off (IYYE2_MAINTAIN=off)";
		const measured = this.measure();
		const allowed = this.allowed();
		const last = new Map<string, MaintenanceRun>();
		for (const r of this.recentRuns(50)) if (!last.has(r.action)) last.set(r.action, r);
		const lines = [
			this.d.mode === "allowed"
				? "maintenance: the actions you allowed run on their own at the end of a night, files only when the disk forecast asks for room"
				: "maintenance: report only; nothing is removed unless you run an action",
		];
		for (const m of measured) {
			const what = m.items.length
				? `${m.items.length} ${m.items.length === 1 ? "item" : "items"}, ${sizeText(m.bytes)}`
				: "nothing to remove";
			const r = last.get(m.action);
			lines.push(
				`  ${m.action} — ${DESCRIPTIONS[m.action](this.d)}: ${what}${allowed.has(m.action) ? " [allowed]" : ""}${r ? `; last run ${r.at.slice(0, 10)} (${sizeText(r.freedBytes)})` : ""}`,
			);
		}
		const total = measured.reduce((sum, m) => sum + m.bytes, 0);
		lines.push(`in all: ${sizeText(total)}`);
		const why = this.d.forecast();
		if (why) lines.push(`the forecast: ${why}`);
		lines.push(
			"/maintain <action> — what exactly; /maintain run <action> confirm — remove it now; /maintain allow | disallow <action>; /maintain runs",
		);
		return lines.join("\n");
	}

	private detail(action: MaintainAction): string {
		const m = this.measureOne(action);
		const lines = [`${action} — ${DESCRIPTIONS[action](this.d)}:`];
		if (m.items.length === 0) lines.push("  nothing to remove");
		for (const i of m.items.slice(0, 30)) lines.push(`  ${i.name} — ${sizeText(i.bytes)}`);
		if (m.items.length > 30) lines.push(`  … and ${m.items.length - 30} more`);
		if (m.items.length > 1) lines.push(`  in all: ${sizeText(m.bytes)}`);
		for (const n of m.notes.slice(0, 20)) lines.push(`  (${n})`);
		return lines.join("\n");
	}

	private runsReport(): string {
		const runs = this.recentRuns(10);
		if (runs.length === 0) return "maintenance has not removed anything yet";
		const lines = ["maintenance runs (newest first):"];
		for (const r of runs) {
			lines.push(
				`  ${r.at.slice(0, 16).replace("T", " ")} — ${runLine(r)} [${r.by === "owner" ? "you asked" : r.reason}]`,
			);
			for (const x of r.removed.slice(0, 8)) lines.push(`      ${x.name} — ${sizeText(x.bytes)}`);
			if (r.removed.length > 8) lines.push(`      … and ${r.removed.length - 8} more`);
		}
		return lines.join("\n");
	}

	/** `/maintain [<action> | allow <action> | disallow <action> | run <action> [confirm] | runs]`. */
	command(args: string[]): string {
		if (this.d.mode === "off") return "maintenance is off (IYYE2_MAINTAIN=off)";
		const [verb, name, word] = args;
		const usage =
			"/maintain | /maintain <action> | /maintain run <action> confirm | /maintain allow <action> | /maintain disallow <action> | /maintain runs";
		const unknown = `no such action; the actions are ${MAINTAIN_ACTIONS.join(", ")}`;
		if (!verb) return this.report();
		if (verb === "runs") return this.runsReport();
		if (isMaintainAction(verb)) return this.detail(verb);
		if (verb === "allow" || verb === "disallow") {
			if (!isMaintainAction(name)) return name ? unknown : usage;
			if (verb === "disallow") {
				this.d.db.prepare("DELETE FROM maintenance_allowed WHERE action = ?").run(name);
				return `${name}: Iyye will not run it on its own`;
			}
			this.d.db
				.prepare("INSERT INTO maintenance_allowed (action, at) VALUES (?, ?) ON CONFLICT (action) DO NOTHING")
				.run(name, this.d.now().toISOString());
			const when =
				name === "database"
					? "at the end of a night, when enough of the database is free pages"
					: "at the end of a night, when the disk forecast asks for room";
			return this.d.mode === "allowed"
				? `${name}: Iyye may run it on its own, ${when}, and will tell you what it removed`
				: `${name}: noted. Iyye runs allowed actions only with IYYE2_MAINTAIN=allowed (now: ${this.d.mode}); then ${when}`;
		}
		if (verb === "run") {
			if (!isMaintainAction(name)) return name ? unknown : usage;
			if (name === "database")
				return "the database is compacted only at the end of a night: /maintain allow database (with IYYE2_MAINTAIN=allowed)";
			if (word !== "confirm") return `${this.detail(name)}\n/maintain run ${name} confirm — remove these now`;
			const r = this.run(name, "owner", "the owner asked");
			this.measure();
			return r.removed.length === 0 && !r.error ? `${name}: there was nothing to remove` : runLine(r);
		}
		return usage;
	}
}

function runLine(r: MaintenanceRun): string {
	const what =
		r.action === "database"
			? `database: compacted, ${sizeText(r.freedBytes)} smaller`
			: `${r.action}: removed ${r.removed.length} ${r.removed.length === 1 ? "item" : "items"}, ${sizeText(r.freedBytes)}`;
	return r.error ? `${what}; not everything went: ${r.error}` : what;
}
