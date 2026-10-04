// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-service smoke test for long-term memory (plan 0.002 L1): the conda
 * PostgreSQL and the Hindsight venv, supervised by MemoryService, on scratch
 * ports and a scratch state directory. Never touches ~/.iyye2 or a running host.
 *
 *   node scripts/memory-smoke.ts <scratch-dir> [--models-from <provisioned HF_HOME>]
 *
 * Without --models-from the scratch dir must already be provisioned (hf/).
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";
import { consoleLogger } from "../src/log.ts";
import { DEFAULT_MEMORY_MODELS, MemoryService } from "../src/memory/service.ts";

const [scratch, flag, modelsFrom] = process.argv.slice(2);
if (!scratch) {
	console.error("usage: node scripts/memory-smoke.ts <scratch-dir> [--models-from <HF_HOME>]");
	process.exit(2);
}
const stateDir = join(scratch, "memory");
mkdirSync(stateDir, { recursive: true });
if (flag === "--models-from" && modelsFrom && !existsSync(join(stateDir, "hf"))) {
	cpSync(modelsFrom, join(stateDir, "hf"), { recursive: true });
}

const freePort = () =>
	new Promise<number>((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});

const log = consoleLogger();
const memory = new MemoryService({
	installDir: join(PROJECT_ROOT, "memory"),
	stateDir,
	hindsightPort: await freePort(),
	dbPort: await freePort(),
	passthroughPort: await freePort(),
	models: DEFAULT_MEMORY_MODELS,
	log,
	healthIntervalMs: 5000,
});

const t0 = Date.now();
memory.start();
try {
	while (!["up", "not installed", "needs provisioning"].includes(memory.status.state)) {
		if (Date.now() - t0 > 240_000)
			throw new Error(`not up after 240 s: ${memory.status.state}: ${memory.status.detail}`);
		await new Promise((r) => setTimeout(r, 1000));
	}
	console.log(
		`status: ${memory.status.state} after ${Math.round((Date.now() - t0) / 1000)} s — ${memory.status.detail}`,
	);
	if (memory.status.state !== "up") process.exit(1);
	const h = { authorization: `Bearer ${memory.apiKey()}`, "content-type": "application/json" };
	const bank = await fetch(`${memory.baseUrl}/v1/default/banks/smoke`, {
		method: "PUT",
		headers: h,
		body: JSON.stringify({ name: "smoke" }),
	});
	console.log(`create bank: HTTP ${bank.status}`);
	const recall = await fetch(`${memory.baseUrl}/v1/default/banks/smoke/memories/recall`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ query: "anything", max_tokens: 100 }),
	});
	console.log(`recall on an empty bank: HTTP ${recall.status}`);
	const noKey = await fetch(`${memory.baseUrl}/v1/default/banks`);
	console.log(`request without the key: HTTP ${noKey.status}`);
} finally {
	await memory.stop();
	console.log(`stopped: ${memory.status.state}`);
}
