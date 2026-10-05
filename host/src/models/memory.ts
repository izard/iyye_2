// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { freemem } from "node:os";

/** Returns the RAM, in GiB, that a new model load could use without forcing swap. */
export type MemoryProbe = () => number;

/**
 * Reclaimable memory on macOS: free + inactive + speculative pages.
 * `os.freemem()` reports only the free pages, which on macOS is a small
 * fraction of what is reclaimable (1.8 GiB vs ~53 GiB measured on the
 * owner's 128 GiB machine), and would refuse every load.
 */
export function parseVmStat(text: string): number {
	const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
	const pages = (label: string): number => {
		const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m").exec(text);
		if (!m) throw new Error(`vm_stat output has no "Pages ${label}" line`);
		return Number(m[1]);
	};
	if (!Number.isFinite(pageSize) || pageSize <= 0) throw new Error("vm_stat output has no page size");
	return ((pages("free") + pages("inactive") + pages("speculative")) * pageSize) / 2 ** 30;
}

/** Linux `MemAvailable` from /proc/meminfo, in GiB. */
export function parseMemInfo(text: string): number {
	const m = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
	if (!m) throw new Error("/proc/meminfo has no MemAvailable line");
	return Number(m[1]) / 2 ** 20;
}

export const systemMemoryProbe: MemoryProbe = () => {
	if (process.platform === "darwin") return parseVmStat(execFileSync("/usr/bin/vm_stat", { encoding: "utf8" }));
	if (process.platform === "linux") return parseMemInfo(readFileSync("/proc/meminfo", "utf8"));
	return freemem() / 2 ** 30;
};
