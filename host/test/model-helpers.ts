// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { ModelManager, type ModelManagerDeps } from "../src/models/manager.ts";
import { loadRegistry, type Registry } from "../src/models/registry.ts";
import { RouterProcess } from "../src/models/router.ts";
import { openDb } from "../src/state/db.ts";

export const FAKE_ROUTER = fileURLToPath(new URL("./fixtures/fake-llama-server.mjs", import.meta.url));

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as { port: number }).port;
			srv.close(() => resolve(port));
		});
	});
}

/** Models used by the fake router tests; the fake's behaviour follows the name prefix. */
export const TEST_MODELS = [
	{ name: "small", ram: 1 },
	{ name: "small-2", ram: 1 },
	{ name: "small-3", ram: 1 },
	{ name: "huge", ram: 999 },
	{ name: "broken-x", ram: 1 },
	{ name: "slow-x", ram: 1 },
	{ name: "mute-x", ram: 1 },
];

export interface Sandbox {
	dir: string;
	stateDir: string;
	registryPath: string;
	registry: Registry;
	cleanup(): void;
}

/** A temp dir with empty GGUF files, a registry naming them, and a state dir. */
export function sandbox(): Sandbox {
	const dir = mkdtempSync(join(tmpdir(), "iyye-models-"));
	const stateDir = join(dir, "state");
	mkdirSync(stateDir);
	const models = TEST_MODELS.map((m) => {
		writeFileSync(join(dir, `${m.name}.gguf`), "");
		return {
			name: m.name,
			file: `${m.name}.gguf`,
			ram_required_gb: m.ram,
			startup_s: 1,
			roles: ["chat"],
			description: `test model ${m.name}`,
			server_args: {},
		};
	});
	models.push({
		name: "missing",
		file: "missing.gguf",
		ram_required_gb: 1,
		startup_s: 1,
		roles: [],
		description: "file absent",
		server_args: {},
	});
	const registryPath = join(dir, "models.json");
	writeFileSync(registryPath, JSON.stringify({ models_dir: dir, defaults: { c: 4096 }, models }));
	return {
		dir,
		stateDir,
		registryPath,
		registry: loadRegistry(registryPath),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export function fakeRouterProcess(sb: Sandbox, port: number): RouterProcess {
	return new RouterProcess({
		command: FAKE_ROUTER,
		argsPrefix: [],
		port,
		presetPath: join(sb.stateDir, "models.ini"),
		stateDir: sb.stateDir,
		startTimeoutMs: 10_000,
		stopGraceMs: 5_000,
		log: silentLogger,
	});
}

export interface ManagerRig {
	manager: ModelManager;
	router: RouterProcess;
	db: ReturnType<typeof openDb>;
	ram: { gb: number };
}

export async function managerRig(
	sb: Sandbox,
	overrides: Partial<ModelManagerDeps> = {},
	dbPath = ":memory:",
): Promise<ManagerRig> {
	const port = await freePort();
	const router = fakeRouterProcess(sb, port);
	const db = openDb(dbPath);
	const ram = { gb: 64 };
	const manager = new ModelManager({
		db,
		registry: sb.registry,
		router,
		client: new RouterClient(router.url),
		memory: () => ram.gb,
		stateDir: sb.stateDir,
		modelsMax: 2,
		defaultModel: "small",
		log: silentLogger,
		healthIntervalMs: 60_000,
		pollIntervalMs: 20,
		minLoadTimeoutMs: 1500,
		loadTimeoutFactor: 0,
		unloadTimeoutMs: 2000,
		restartBackoffMs: [50],
		...overrides,
	});
	return { manager, router, db, ram };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cond()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("condition not met in time");
}
