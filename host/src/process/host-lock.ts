// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * One holder per state directory. The host takes `host.lock` for as long as
 * it runs: two hosts would fight over the router and the database. An offline
 * decision-training session (plan 0.017 N3) takes the same lock, so it never
 * runs beside a host and a host started by mistake refuses to start.
 *
 * `host.lock` holds the holder's pid, as it always has; `host.lock.who` says
 * what the holder is, so a refusal can name it. A lock whose process is gone
 * is stale and is taken over.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./supervised.ts";

export const HOST = "the Iyye host";

export type LockResult = { ok: true } | { ok: false; pid: number; who: string };

const lockPath = (stateDir: string) => join(stateDir, "host.lock");
const whoPath = (stateDir: string) => join(stateDir, "host.lock.who");

function holder(stateDir: string): { pid: number; who: string } | null {
	let pid: number;
	try {
		pid = Number(readFileSync(lockPath(stateDir), "utf8"));
	} catch {
		return null;
	}
	// pid <= 1 (e.g. an empty lock file) is stale: kill(0, 0) would "succeed" for our own group.
	if (!Number.isInteger(pid) || pid <= 1 || !pidAlive(pid)) return null;
	let who = HOST;
	try {
		who = readFileSync(whoPath(stateDir), "utf8").trim() || HOST;
	} catch {
		// A lock written before this file existed is a host's.
	}
	return { pid, who };
}

/** Take the lock for this process, or say who holds it. */
export function acquireHostLock(stateDir: string, who: string = HOST): LockResult {
	const mine = () => {
		writeFileSync(whoPath(stateDir), `${who}\n`);
		return { ok: true } as const;
	};
	try {
		writeFileSync(lockPath(stateDir), String(process.pid), { flag: "wx" });
		return mine();
	} catch {
		const h = holder(stateDir);
		if (h && h.pid !== process.pid) return { ok: false, pid: h.pid, who: h.who };
		writeFileSync(lockPath(stateDir), String(process.pid));
		return mine();
	}
}

/** Give the lock back, if this process holds it. */
export function releaseHostLock(stateDir: string): void {
	let pid: number;
	try {
		pid = Number(readFileSync(lockPath(stateDir), "utf8"));
	} catch {
		return;
	}
	if (pid !== process.pid) return;
	rmSync(whoPath(stateDir), { force: true });
	rmSync(lockPath(stateDir), { force: true });
}
