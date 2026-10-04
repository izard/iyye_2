// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * S5 check (plan 0.007): a real investigation end to end. The real llama.cpp
 * router on a free port with scratch state (never ~/.iyye2), the background
 * model, a real BackgroundWorker and PiConversations with the read-only
 * `project` toolkit on a scratch repository, and Investigations deciding
 * whether each answer is grounded.
 *
 *   node scripts/spike-0007-investigation.ts <scratch-dir> [model]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createLocalModelRuntime } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { BackgroundWorker } from "../src/kernel/background.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { consoleLogger, silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import { loadRegistry } from "../src/models/registry.ts";
import { RouterProcess } from "../src/models/router.ts";
import { Investigations } from "../src/observe/investigations.ts";
import { ensureWorkspace } from "../src/observe/workspace.ts";
import { openDb } from "../src/state/db.ts";
import { ToolBroker } from "../src/tools/broker.ts";
import { projectToolkit } from "../src/tools/project.ts";

const [scratch, modelArg] = process.argv.slice(2);
if (!scratch) {
	console.error("usage: node scripts/spike-0007-investigation.ts <scratch-dir> [model]");
	process.exit(2);
}
const model = modelArg ?? "gemma-4-E4B";
const config = loadConfig();
const stateDir = join(scratch, "state");
mkdirSync(stateDir, { recursive: true });
const full = loadRegistry(config.modelsRegistry);
const registry = { ...full, models: full.models.filter((m) => m.name === model) };
writeFileSync(join(stateDir, "models.ini"), renderPreset(registry));
const port = await new Promise<number>((resolve) => {
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const p = (s.address() as { port: number }).port;
		s.close(() => resolve(p));
	});
});
const router = new RouterProcess({
	command: config.llamaServer,
	argsPrefix: config.llamaServerArgsPrefix,
	port,
	presetPath: join(stateDir, "models.ini"),
	stateDir,
	startTimeoutMs: 60_000,
	stopGraceMs: 30_000,
	log: consoleLogger(),
});
for (const sig of ["SIGINT", "SIGTERM"] as const)
	process.on(sig, () => void router.stop().finally(() => process.exit(130)));

// A workspace with history and one stale uncommitted change.
const ws = join(scratch, "workspace");
ensureWorkspace(ws, silentLogger);
const env = {
	PATH: process.env.PATH,
	HOME: ws,
	GIT_AUTHOR_NAME: "Iyye",
	GIT_AUTHOR_EMAIL: "i@l",
	GIT_COMMITTER_NAME: "Iyye",
	GIT_COMMITTER_EMAIL: "i@l",
};
const commit = (file: string, body: string, msg: string) => {
	writeFileSync(join(ws, file), body);
	execFileSync("git", ["-C", ws, "add", file], { env });
	execFileSync("git", ["-C", ws, "commit", "-q", "-m", msg], { env });
};
commit(
	"disk_watch.py",
	"THRESHOLD_GB = 50\n\ndef low(free_gb):\n    return free_gb < THRESHOLD_GB\n",
	"Add a disk watch helper",
);
commit(
	"disk_watch.py",
	"THRESHOLD_GB = 80\n\ndef low(free_gb):\n    return free_gb < THRESHOLD_GB\n",
	"Raise the disk threshold to 80 GB",
);
commit("notes.md", "Weather probe idea: compare with yesterday.\n", "Add notes");
writeFileSync(join(ws, "draft.py"), "# unfinished\ndef compare_weather(today, yesterday):\n    pass  # TODO\n");
const old = new Date(Date.now() - 2 * 86_400_000);
utimesSync(join(ws, "draft.py"), old, old);

const FINDINGS = [
	'3 new commit(s) in workspace: "Add a disk watch helper", "Raise the disk threshold to 80 GB", "Add notes"',
	"uncommitted changes in workspace for more than a day: draft.py",
];

await router.start();
const results: unknown[] = [];
try {
	const client = new RouterClient(router.url);
	await client.load(model);
	while ((await client.listModels()).get(model)?.value !== "loaded") await new Promise((r) => setTimeout(r, 500));
	for (const [i, change] of FINDINGS.entries()) {
		const db = openDb(join(scratch, `iyye-${i}.db`));
		db.prepare(
			"INSERT INTO observations (id, domain, at, result_json, result_hash, severity, change_text, decided_by, finding) VALUES ('o1', 'workspace', ?, '{}', 'h', 'threshold', ?, 'kev', 1)",
		).run(new Date().toISOString(), change);
		const conv = new PiConversations({
			db,
			runtime: await createLocalModelRuntime({ routerUrl: router.url, registry }),
			stateDir: join(scratch, `bg-${i}`),
			identity: "You are Iyye, a personal assistant.",
			log: silentLogger,
			tools: new ToolBroker({ db, log: silentLogger, toolkits: [projectToolkit({ workspace: ws })] }),
		});
		let inv: Investigations | null = null;
		const worker = new BackgroundWorker({
			db,
			device: new DeviceSlot(),
			models: { selected: () => model, acquire: async () => ({ model, valid: () => true, release: () => {} }) },
			conversations: conv,
			chatPending: () => false,
			log: silentLogger,
			onSettled: (job) => inv!.onStepSettled(job),
			quietMs: 0,
			gapMs: 0,
			pollMs: 60_000,
		});
		inv = new Investigations({ db, worker, mode: () => "awake", log: silentLogger, cooldownMs: 0 });
		const t0 = Date.now();
		for (let n = 0; n < 12; n++) {
			await inv.tick();
			const ran = await worker.drainOnce();
			const o = db.prepare("SELECT status, attempts, fruitless, steps, answer FROM opportunities").get() as Record<
				string,
				unknown
			>;
			const job = db
				.prepare("SELECT result, status FROM background_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1")
				.get() as { result: string | null; status: string } | undefined;
			if (ran) console.log(`  step: ${job?.status} → ${String(job?.result).replace(/\s+/g, " ").slice(0, 220)}`);
			if (o.status === "settled" || o.status === "suspended") break;
		}
		const o = db.prepare("SELECT status, attempts, fruitless, steps, answer FROM opportunities").get() as Record<
			string,
			unknown
		>;
		const tools = (
			db.prepare("SELECT tool, args_json, outcome FROM tool_calls").all() as {
				tool: string;
				args_json: string;
				outcome: string;
			}[]
		).map((t) => `${t.tool}(${t.args_json}):${t.outcome}`);
		console.log(
			`finding ${i}: ${o.status} after ${o.attempts} attempt(s), ${o.fruitless} fruitless, ${Math.round((Date.now() - t0) / 1000)} s; tools: ${tools.join(" ")}`,
		);
		results.push({ change, ...o, tools, seconds: Math.round((Date.now() - t0) / 1000) });
		await conv.disposeAll();
		db.close();
	}
} finally {
	await router.stop();
	writeFileSync(join(scratch, "investigation-results.json"), JSON.stringify(results, null, 2));
}
