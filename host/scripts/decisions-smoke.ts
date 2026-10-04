// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-service smoke test for the decision service (plan 0.003 K1): the real
 * Kev server, supervised by DecisionService, on a free port with a scratch
 * state directory whose model cache links to the provisioned one (nothing is
 * copied or downloaded). Never touches the running host's Kev.
 *
 *   node scripts/decisions-smoke.ts <scratch-dir>
 */

import { copyFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { DecisionService } from "../src/decisions/service.ts";
import { consoleLogger } from "../src/log.ts";

const scratch = process.argv[2];
if (!scratch) {
	console.error("usage: node scripts/decisions-smoke.ts <scratch-dir>");
	process.exit(2);
}
const config = loadConfig();
const live = join(config.stateDir, "decisions");
const stateDir = join(scratch, "decisions");
mkdirSync(stateDir, { recursive: true });
if (!existsSync(join(stateDir, "hf"))) symlinkSync(join(live, "hf"), join(stateDir, "hf"));
copyFileSync(join(live, "provisioned.json"), join(stateDir, "provisioned.json"));
const port = await new Promise<number>((resolve) => {
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const p = (s.address() as { port: number }).port;
		s.close(() => resolve(p));
	});
});

const svc = new DecisionService({
	installDir: config.decisions.installDir,
	stateDir,
	port,
	model: config.decisions.model,
	log: consoleLogger(),
	healthIntervalMs: 5000,
});
const t0 = Date.now();
svc.start();
try {
	while (svc.status.state !== "up") {
		if (["not installed", "needs provisioning"].includes(svc.status.state) || Date.now() - t0 > 180_000)
			throw new Error(`not up: ${svc.status.state}: ${svc.status.detail}`);
		await new Promise((r) => setTimeout(r, 500));
	}
	console.log(`up after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(svc.checkpoint)}`);
	const ask = async (key: string) => {
		const t = Date.now();
		const res = await fetch(`${svc.baseUrl}/v1/systemone`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: "kev-latest",
				state: "Sure, I'll remind you tomorrow at 9 to call your mother.",
				questions: {
					q: {
						type: "noul",
						instructions: "Does the reply promise a future action the assistant would take later on its own?",
					},
				},
			}),
		});
		return { status: res.status, ms: Date.now() - t, body: await res.text() };
	};
	const ok = await ask(svc.apiKey());
	console.log(`decision with the key: HTTP ${ok.status} in ${ok.ms} ms: ${ok.body.slice(0, 120)}`);
	console.log(`decision without the key: HTTP ${(await ask("wrong")).status}`);
} finally {
	await svc.stop();
	console.log(`stopped: ${svc.status.state}`);
}
