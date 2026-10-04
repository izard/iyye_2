// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Observation domains (plan 0.007 S4, HLD §5.3, §9.1): what Iyye may look at
 * on its own. Each has a typed read-only probe (fixed commands and system
 * calls, never a shell, never a model), a staleness window, and a
 * deterministic change rule.
 *
 * A change rule fires on a **crossing**, not on a state: disk below 10% is a
 * finding once, when it gets there, not on every probe while it stays there.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Severity = "none" | "minor" | "threshold";

export interface Change {
	severity: Severity;
	text: string | null;
}

export type ProbeResult = Record<string, unknown>;

export interface Domain {
	name: string;
	description: string;
	stalenessMs: number;
	probe(): Promise<ProbeResult>;
	compare(prev: ProbeResult | null, cur: ProbeResult, now: Date): Change;
}

const RANK: Record<Severity, number> = { none: 0, minor: 1, threshold: 2 };

/** The most severe of several changes, their texts joined. */
export function combine(changes: Change[]): Change {
	const real = changes.filter((c) => c.severity !== "none" && c.text);
	if (real.length === 0) return { severity: "none", text: null };
	const severity = real.reduce<Severity>((s, c) => (RANK[c.severity] > RANK[s] ? c.severity : s), "none");
	return { severity, text: real.map((c) => c.text).join("; ") };
}

// ---------------------------------------------------------------- machine

export interface MachineDeps {
	memoryGb: () => number;
	loadedModels: () => Promise<string[]>;
	/** Service name → state ("up", "connected", "retrying", …). */
	services: () => Record<string, string>;
	swapUsedGb?: () => number | null;
	path?: string;
}

const OK_STATES = new Set(["up", "connected", "disabled", "not installed"]);
/** States every restart passes through: neither fine nor a problem. */
const TRANSITIONAL = new Set(["starting", "restarting"]);

export function machineDomain(deps: MachineDeps): Domain {
	return {
		name: "machine",
		description: "this computer: free disk, memory, swap, loaded models, Iyye's services",
		stalenessMs: 2 * 3_600_000,
		probe: async () => {
			const s = statfsSync(deps.path ?? homedir());
			const gb = (blocks: number) => Math.round(((blocks * s.bsize) / 2 ** 30) * 10) / 10;
			const free = gb(s.bavail);
			const total = gb(s.blocks);
			return {
				diskFreeGb: free,
				diskTotalGb: total,
				diskFreePct: total > 0 ? Math.round((free / total) * 1000) / 10 : 0,
				memAvailableGb: Math.round(deps.memoryGb() * 10) / 10,
				swapUsedGb: (deps.swapUsedGb ?? macSwapUsedGb)(),
				loadedModels: (await deps.loadedModels()).sort(),
				services: deps.services(),
			};
		},
		compare: (prev, cur) => {
			const n = (r: ProbeResult | null, k: string) => (r && typeof r[k] === "number" ? (r[k] as number) : null);
			const changes: Change[] = [];
			const pct = n(cur, "diskFreePct");
			const prevPct = n(prev, "diskFreePct");
			// Low means little in both senses: under 10% *and* under 100 GB (8% of a 2 TB disk is plenty).
			const low = (r: ProbeResult | null) =>
				r !== null && (n(r, "diskFreePct") ?? 100) < 10 && (n(r, "diskFreeGb") ?? Infinity) < 100;
			if (low(cur) && (prev === null || !low(prev))) {
				changes.push({ severity: "threshold", text: `free disk space is ${pct}% (${cur.diskFreeGb} GB), low` });
			} else if (pct !== null && prevPct !== null && prevPct - pct >= 5) {
				changes.push({
					severity: "threshold",
					text: `free disk space fell from ${prev!.diskFreeGb} GB to ${cur.diskFreeGb} GB`,
				});
			}
			const mem = n(cur, "memAvailableGb");
			const prevMem = n(prev, "memAvailableGb");
			if (mem !== null && mem < 4 && (prevMem === null || prevMem >= 4)) {
				changes.push({ severity: "threshold", text: `only ${mem} GB of memory is available` });
			}
			const swap = n(cur, "swapUsedGb");
			const prevSwap = n(prev, "swapUsedGb");
			if (swap !== null && prevSwap !== null && swap - prevSwap >= 4) {
				changes.push({ severity: "threshold", text: `swap use grew from ${prevSwap} GB to ${swap} GB` });
			}
			// Services: only a move between fine and broken counts. The first look is a baseline, and
			// starting/restarting are neither (every restart passes through them).
			const svc = (cur.services ?? {}) as Record<string, string>;
			const prevSvc = (prev?.services ?? {}) as Record<string, string>;
			for (const [name, state] of Object.entries(svc)) {
				const was = prevSvc[name];
				if (was === undefined || TRANSITIONAL.has(state) || TRANSITIONAL.has(was)) continue;
				if (!OK_STATES.has(state) && OK_STATES.has(was)) {
					changes.push({ severity: "threshold", text: `${name} is ${state}` });
				} else if (OK_STATES.has(state) && !OK_STATES.has(was)) {
					changes.push({ severity: "minor", text: `${name} is ${state} again` });
				}
			}
			const models = (cur.loadedModels ?? []) as string[];
			const prevModels = (prev?.loadedModels ?? null) as string[] | null;
			if (prevModels && models.join(",") !== prevModels.join(",")) {
				changes.push({ severity: "minor", text: `loaded models: ${models.join(", ") || "none"}` });
			}
			return combine(changes);
		},
	};
}

/** macOS: `sysctl vm.swapusage` ("total = 2048.00M  used = 1124.25M  free = …"); null elsewhere or on error. */
function macSwapUsedGb(): number | null {
	if (process.platform !== "darwin") return null;
	try {
		const out = execFileSync("/usr/sbin/sysctl", ["-n", "vm.swapusage"], { encoding: "utf8", timeout: 5000 });
		const m = /used = ([\d.]+)M/.exec(out);
		return m ? Math.round((Number(m[1]) / 1024) * 10) / 10 : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- git repositories

interface Commit {
	hash: string;
	date: string;
	subject: string;
}

/** A read-only look at a repository: the latest commits and uncommitted changes. Fixed git arguments only. */
export function gitState(repo: string, now: Date): ProbeResult {
	if (!existsSync(join(repo, ".git"))) return { error: `${repo} is not a git repository` };
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repo, ...args], {
			encoding: "utf8",
			timeout: 10_000,
			env: { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: repo },
		});
	let commits: Commit[] = [];
	try {
		commits = git("log", "-n", "20", "--format=%h%x09%cI%x09%s")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				const [hash, date, ...rest] = l.split("\t");
				return { hash: hash!, date: date!, subject: rest.join("\t").slice(0, 120) };
			});
	} catch {
		commits = []; // a repository with no commits yet
	}
	const dirty = git("status", "--porcelain")
		.split("\n")
		.filter(Boolean)
		.slice(0, 20)
		.map((l) => l.slice(3));
	let oldestDirty: string | null = null;
	for (const path of dirty) {
		try {
			const m = statSync(join(repo, path)).mtime.toISOString();
			if (!oldestDirty || m < oldestDirty) oldestDirty = m;
		} catch {
			// deleted file
		}
	}
	const staleDirty = oldestDirty !== null && now.getTime() - Date.parse(oldestDirty) > 86_400_000;
	return { commits, dirty, oldestDirty, staleDirty };
}

export function gitDomain(
	name: "workspace" | "project",
	repo: string,
	description: string,
	stalenessMs: number,
): Domain {
	return {
		name,
		description,
		stalenessMs,
		probe: async () => gitState(repo, new Date()),
		compare: (prev, cur) => {
			if (cur.error)
				return { severity: prev?.error ? "none" : "threshold", text: prev?.error ? null : String(cur.error) };
			const commits = (cur.commits ?? []) as Commit[];
			if (!prev || prev.error) return { severity: "none", text: null }; // the first look is the baseline
			const seen = new Set(((prev.commits ?? []) as Commit[]).map((c) => c.hash));
			const fresh = commits.filter((c) => !seen.has(c.hash));
			const changes: Change[] = [];
			if (fresh.length) {
				changes.push({
					severity: "threshold",
					text: `${fresh.length} new commit(s) in ${name}: ${fresh
						.slice(0, 3)
						.map((c) => `"${c.subject}"`)
						.join(", ")}${fresh.length > 3 ? ", …" : ""}`,
				});
			}
			if (cur.staleDirty && !prev.staleDirty) {
				const dirty = (cur.dirty ?? []) as string[];
				changes.push({
					severity: "threshold",
					text: `uncommitted changes in ${name} for more than a day: ${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", …" : ""}`,
				});
			} else if (
				JSON.stringify(cur.dirty) !== JSON.stringify(prev.dirty) &&
				((cur.dirty ?? []) as string[]).length
			) {
				changes.push({
					severity: "minor",
					text: `uncommitted changes in ${name}: ${((cur.dirty ?? []) as string[]).slice(0, 3).join(", ")}`,
				});
			}
			return combine(changes);
		},
	};
}
