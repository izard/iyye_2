// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only probes (plan M3b): the current time for everyone, and the
 * machine's state for the owner only. Neither takes arguments, so the model
 * cannot point them at anything else.
 */

import { statfsSync } from "node:fs";
import { homedir, loadavg, uptime } from "node:os";
import { Type } from "typebox";
import type { MemoryProbe } from "../models/memory.ts";
import type { IyyeTool } from "./broker.ts";

const NO_ARGS = Type.Object({}, { additionalProperties: false });

export function currentTimeTool(now: () => Date = () => new Date()): IyyeTool<typeof NO_ARGS> {
	return {
		name: "current_time",
		label: "Current time",
		description: "Get the current local date, time, weekday and timezone of the computer Iyye runs on.",
		summary: "the current local date, time and timezone",
		parameters: NO_ARGS,
		run: async () => describeTime(now()),
	};
}

export function describeTime(d: Date, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
	const local = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(d);
	const offset =
		new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
			.formatToParts(d)
			.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
	return `${local} (${timeZone}, ${offset === "GMT" ? "UTC+00:00" : offset.replace("GMT", "UTC")}). ISO: ${d.toISOString()}`;
}

export interface SystemStatusDeps {
	memory: MemoryProbe;
	/** Names of models currently loaded in the router. */
	loadedModels: () => Promise<string[]>;
	/** Volumes to report; the home folder's by default. */
	paths?: string[];
}

export function systemStatusTool(deps: SystemStatusDeps): IyyeTool<typeof NO_ARGS> {
	return {
		name: "system_status",
		label: "System status",
		description:
			"Get the state of the computer Iyye runs on: free disk space, reclaimable memory, uptime, CPU load and which local models are loaded.",
		summary: "free disk space, memory, uptime, CPU load and loaded models of this computer",
		parameters: NO_ARGS,
		run: async () => {
			const lines: string[] = [];
			for (const p of deps.paths ?? [homedir()]) {
				const s = statfsSync(p);
				const gb = (blocks: number) => ((blocks * s.bsize) / 2 ** 30).toFixed(1);
				lines.push(
					`Disk (volume of ${p === homedir() ? "home folder" : p}): ${gb(s.bavail)} GB free of ${gb(s.blocks)} GB`,
				);
			}
			try {
				lines.push(`Memory available for new work: ${deps.memory().toFixed(1)} GB`);
			} catch {
				lines.push("Memory: unknown");
			}
			const up = uptime();
			lines.push(`Uptime: ${Math.floor(up / 86400)} d ${Math.floor((up % 86400) / 3600)} h`);
			lines.push(
				`CPU load (1/5/15 min): ${loadavg()
					.map((l) => l.toFixed(2))
					.join(" / ")}`,
			);
			const models = await deps.loadedModels().catch(() => null);
			lines.push(`Loaded models: ${models === null ? "unknown" : models.length > 0 ? models.join(", ") : "none"}`);
			return lines.join("\n");
		},
	};
}
