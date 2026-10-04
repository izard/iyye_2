// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-service smoke test for the memory pass-through and gate (plan 0.002
 * L2): a real llama.cpp router, the conda PostgreSQL and Hindsight, all on
 * free scratch ports with a scratch state directory. Never touches ~/.iyye2
 * or a running host.
 *
 *   node scripts/memory-l2-smoke.ts <scratch-dir> --models-from <provisioned HF_HOME> [model]
 *
 * Checks: a retain outside the gate fails fast (503, nothing reaches the
 * router); a retain inside it extracts facts on the memory model with
 * thinking off; recall then finds them.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadConfig, PROJECT_ROOT } from "../src/config.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { consoleLogger } from "../src/log.ts";
import { MemoryGate } from "../src/memory/gate.ts";
import { MemoryPassthrough } from "../src/memory/passthrough.ts";
import { DEFAULT_MEMORY_MODELS, MemoryService } from "../src/memory/service.ts";
import { RouterClient } from "../src/models/client.ts";
import { ModelManager } from "../src/models/manager.ts";
import { systemMemoryProbe } from "../src/models/memory.ts";
import { loadRegistry } from "../src/models/registry.ts";
import { RouterProcess } from "../src/models/router.ts";
import { openDb } from "../src/state/db.ts";

const [scratch, flag, modelsFrom, modelArg] = process.argv.slice(2);
if (!scratch || flag !== "--models-from" || !modelsFrom) {
	console.error("usage: node scripts/memory-l2-smoke.ts <scratch-dir> --models-from <HF_HOME> [model]");
	process.exit(2);
}
const model = modelArg ?? "gemma-4-E4B";
const stateDir = join(scratch, "state");
mkdirSync(join(stateDir, "memory"), { recursive: true });
if (!existsSync(join(stateDir, "memory", "hf")))
	cpSync(modelsFrom, join(stateDir, "memory", "hf"), { recursive: true });

const freePort = () =>
	new Promise<number>((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});

const log = consoleLogger();
const passthroughPort = await freePort();
const config = loadConfig({ ...process.env, IYYE2_STATE_DIR: stateDir });
const registry = loadRegistry(config.modelsRegistry);
const db = openDb(join(stateDir, "iyye.db"));
const router = new RouterProcess({
	command: config.llamaServer,
	argsPrefix: config.llamaServerArgsPrefix,
	port: await freePort(),
	presetPath: join(stateDir, "models.ini"),
	stateDir,
	startTimeoutMs: 30_000,
	stopGraceMs: 30_000,
	log,
});
const models = new ModelManager({
	db,
	registry,
	router,
	client: new RouterClient(router.url),
	memory: systemMemoryProbe,
	stateDir,
	modelsMax: 1,
	defaultModel: model,
	defaultMemoryModel: model,
	log,
});
const memory = new MemoryService({
	installDir: join(PROJECT_ROOT, "memory"),
	stateDir: join(stateDir, "memory"),
	hindsightPort: await freePort(),
	dbPort: await freePort(),
	passthroughPort,
	models: DEFAULT_MEMORY_MODELS,
	log,
	healthIntervalMs: 5000,
});
const passthrough = new MemoryPassthrough({
	port: passthroughPort,
	routerUrl: router.url,
	key: () => memory.passthroughKey(),
	log,
});
models.onRouterLost(() => passthrough.abortAll("router lost"));
const gate = new MemoryGate({ device: new DeviceSlot(), models, passthrough, chatPending: () => false, log });

const secs = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)} s`;

try {
	await passthrough.start();
	await models.start();
	memory.start();
	const t0 = Date.now();
	while (memory.status.state !== "up") {
		if (["not installed", "needs provisioning"].includes(memory.status.state) || Date.now() - t0 > 240_000)
			throw new Error(`memory not up: ${memory.status.state}: ${memory.status.detail}`);
		await new Promise((r) => setTimeout(r, 1000));
	}
	console.log(`memory up after ${secs(t0)}`);
	const h = { authorization: `Bearer ${memory.apiKey()}`, "content-type": "application/json" };
	const api = (path: string, body?: unknown, method = "POST") =>
		fetch(`${memory.baseUrl}/v1/default/banks/smoke${path}`, {
			method,
			headers: h,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	console.log(`create bank: HTTP ${(await api("", { name: "smoke" }, "PUT")).status}`);
	const turn = (content: string, id: string) => ({
		items: [{ content, context: "owner web chat", document_id: id, timestamp: new Date().toISOString() }],
		async: false,
	});

	let t = Date.now();
	const outside = await api("/memories", turn("Owner: My daughter Julia has violin lessons on Tuesdays.", "t0"));
	console.log(
		`retain outside the gate: HTTP ${outside.status} after ${secs(t)} — ${(await outside.text()).slice(0, 160)}`,
	);

	const turns = [
		"Owner: My daughter Julia has violin lessons on Tuesdays.\nIyye: Noted.",
		"Owner: My brother Alex lives in Berlin and visits in December.\nIyye: Good to know.",
		"Owner: What's 2+2?\nIyye: 4.",
	];
	for (const [i, text] of turns.entries()) {
		t = Date.now();
		const r = await gate.run("retain", async () => {
			const res = await api("/memories", turn(text, `t${i + 1}`));
			return { status: res.status, body: await res.text() };
		});
		console.log(`retain ${i + 1} in the gate: ${r.ok ? `HTTP ${r.value.status}` : r.message} after ${secs(t)}`);
		if (r.ok && r.value.status !== 200) console.log(r.value.body.slice(0, 300));
	}

	// One direct call through the pass-through, to see what the model returns.
	const direct = await gate.run("probe", async () => {
		const res = await fetch(`${passthrough.url}/v1/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${memory.passthroughKey()}`, "content-type": "application/json" },
			body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "Reply with one word: ok" }] }),
		});
		return (await res.json()) as { choices: { message: Record<string, unknown> }[] };
	});
	if (direct.ok) {
		const msg = direct.value.choices[0]!.message;
		console.log(
			`direct call: content=${JSON.stringify(msg.content)} reasoning_content=${JSON.stringify(msg.reasoning_content ?? null)}`,
		);
	}

	for (const q of ["When does Julia have violin?", "Where does Alex live?"]) {
		t = Date.now();
		const r = await api("/memories/recall", { query: q, max_tokens: 300 });
		const results = ((await r.json()) as { results?: { text: string }[] }).results ?? [];
		console.log(
			`recall "${q}" (${secs(t)}): ${results
				.map((x) => x.text)
				.slice(0, 3)
				.join(" | ")}`,
		);
	}
	console.log(`memory status problem: ${gate.problem ?? "none"}`);
} finally {
	await memory.stop();
	await passthrough.stop();
	await models.stop();
	db.close();
	console.log("stopped");
}
