// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.018 W7, its exit check by hand: what each maintenance action would
 * remove from a state directory, item by item, to compare with `du`. It only
 * reads names, sizes and the two provisioning records; its own database is in
 * memory, so nothing is written anywhere and nothing is removed (a model-cache
 * entry therefore always shows as first seen now).
 *
 *   node scripts/maintain-measure.ts [state-dir]
 */

import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { MAINTAIN_ACTIONS, Maintenance, sizeText } from "../src/self/maintain.ts";
import { openDb } from "../src/state/db.ts";

const config = loadConfig();
const stateDir = process.argv[2] ?? config.stateDir;
const m = new Maintenance({
	db: openDb(":memory:"),
	log: silentLogger,
	stateDir,
	dbPath: null,
	mode: "report",
	logDays: config.self.maintainLogDays,
	leftoverDays: config.self.maintainLeftoverDays,
	memoryModels: () => [config.memory.embeddingsModel, config.memory.rerankerModel],
	decisionsModel: () => config.decisions.model,
	forecast: () => null,
	notifyOwner: () => undefined,
});
console.log(`state directory: ${stateDir}`);
for (const action of MAINTAIN_ACTIONS) {
	const r = m.measureOne(action);
	console.log(`${action}: ${r.items.length} to remove, ${sizeText(r.bytes)} (${r.bytes} bytes)`);
	for (const i of r.items)
		console.log(`  ${i.name} — ${sizeText(i.bytes)} (${i.bytes} bytes, ${i.paths.length} paths)`);
	for (const n of r.notes) console.log(`  (${n})`);
}
