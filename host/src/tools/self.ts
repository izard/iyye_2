// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Iyye's own records about its body (plan 0.018 W4): what the self model
 * holds on memory, disk, load, the link, the host's runs, what is normal and
 * the models. Read-only, and the facet is one of a fixed list, so the model
 * cannot point it at anything else.
 *
 * Effect `private`: the owner and Iyye's own work, never contacts. Nothing
 * here is about the owner's place, the people Iyye knows or the hosts of the
 * local network, so a session that can read the web may have it too (owner
 * decision 7).
 */

import { Type } from "typebox";
import type { IyyeTool, Toolkit } from "./broker.ts";

export const SELF_TOOLKIT = "self";
export const SELF_FACETS = ["memory", "disk", "compute", "network", "runs", "normal", "models"] as const;
export type SelfFacet = (typeof SELF_FACETS)[number];

export interface SelfToolDeps {
	/** One facet as text, fresh where a fresh look is cheap. */
	facet: (facet: SelfFacet) => Promise<string>;
	/** Measure Iyye's own directories now and report the disk. */
	diskUsage: () => Promise<string>;
}

const NO_ARGS = Type.Object({}, { additionalProperties: false });
/**
 * A word, not a closed list in the schema: a call the schema rejects teaches a small model nothing (2026-11-10:
 * gemma-4-E4B gave up on the tool after one rejected facet), while an answer that names the facets does. The
 * word still only chooses among them.
 */
const FACET = Type.Object({ facet: Type.String() }, { additionalProperties: false });

const ALIASES: Record<string, SelfFacet> = {
	ram: "memory",
	mem: "memory",
	processes: "memory",
	storage: "disk",
	filesystem: "disk",
	filesystems: "disk",
	cpu: "compute",
	gpu: "compute",
	load: "compute",
	temperature: "compute",
	pressure: "compute",
	link: "network",
	wifi: "network",
	lifecycle: "runs",
	nights: "runs",
	uptime: "runs",
	baseline: "normal",
	baselines: "normal",
	regularities: "normal",
	forecast: "normal",
	model: "models",
};

/** The facet a word names, or null. */
export function facetOf(word: string): SelfFacet | null {
	const w = word.trim().toLowerCase();
	return (SELF_FACETS as readonly string[]).includes(w) ? (w as SelfFacet) : (ALIASES[w] ?? null);
}

export function selfToolkit(deps: SelfToolDeps): Toolkit {
	const model: IyyeTool<typeof FACET> = {
		name: "self_model",
		label: "Self model",
		description:
			"What you know about your own body, from your own records. facet is one word: memory (what is available, what each of your own processes holds and usually holds, what other programs hold), disk (the filesystems, your directories' sizes), compute (load, pressure, GPU, temperature), network (the link), runs (when you were running, your nights), normal (what is usual for each reading, what is unusual now, regularities, the disk forecast), models (each model's size and memory).",
		summary: "your own records about your memory, disk, load, link, runs and what is normal for you",
		parameters: FACET,
		run: async ({ facet }) => {
			const f = facetOf(String(facet));
			return f
				? deps.facet(f)
				: `no facet ${JSON.stringify(String(facet).slice(0, 40))}; the facets are: ${SELF_FACETS.join(", ")}`;
		},
	};
	const disk: IyyeTool<typeof NO_ARGS> = {
		name: "disk_usage",
		label: "Disk usage",
		description:
			"Measure the sizes of your own directories now (state, models, caches) and report the filesystems you live on with their free space.",
		summary: "the sizes of your own directories, measured now",
		parameters: NO_ARGS,
		run: async () => deps.diskUsage(),
	};
	return {
		name: SELF_TOOLKIT,
		description: "your own records about the machine you are (memory, disk, load, link, runs, what is normal)",
		effect: "private",
		tools: [model as IyyeTool, disk as IyyeTool],
	};
}
