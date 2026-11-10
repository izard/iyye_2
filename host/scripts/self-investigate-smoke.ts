// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.018 W4, the real smoke of its exit check: a staged memory drop is
 * looked into by the real background model, through the real investigations
 * loop, the real `self` toolkit and the real citation check. The records are
 * staged in a scratch database (a model that was never loaded before holds
 * most of the memory); nothing is read from or written to `~/.iyye2`, and the
 * router is the scratch one on a free port, never the owner's.
 *
 *   node scripts/self-investigate-smoke.ts <scratch-dir> [model] [runs]
 *
 * Prints, per run: the tools called, whether each answer was accepted, and
 * the answers (about staged figures only).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createLocalModelRuntime } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { consoleLogger, silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import { loadRegistry } from "../src/models/registry.ts";
import { RouterProcess } from "../src/models/router.ts";
import { Investigations } from "../src/observe/investigations.ts";
import { SelfExpectations } from "../src/self/expectations.ts";
import { SelfModel } from "../src/self/model.ts";
import { recordReadings } from "../src/self/readings.ts";
import { SelfUpkeep } from "../src/self/upkeep.ts";
import { getBackgroundJob, insertBackgroundJob } from "../src/state/background.ts";
import { openDb } from "../src/state/db.ts";
import { ToolBroker } from "../src/tools/broker.ts";
import { selfToolkit } from "../src/tools/self.ts";

const [scratch, modelArg, runsArg] = process.argv.slice(2);
if (!scratch) {
	console.error("usage: node scripts/self-investigate-smoke.ts <scratch-dir> [model] [runs]");
	process.exit(2);
}
const MODEL = modelArg ?? "gemma-4-E4B";
const RUNS = Number(runsArg ?? 5);
const config = loadConfig();
const stateDir = join(scratch, "state");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const full = loadRegistry(config.modelsRegistry);
const registry = { ...full, models: full.models.filter((m) => m.name === MODEL) };
if (registry.models.length === 0) throw new Error(`no model ${MODEL} in the registry`);
writeFileSync(join(stateDir, "models.ini"), renderPreset(registry));
const freePort = () =>
	new Promise<number>((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});

// ---- the staged body: 9 GB of 121.7 GB available, because a model never seen before holds 63 GB.
const NOW = new Date();
const DAY = 86_400_000;
const db = openDb(join(stateDir, "smoke.db"));
const self = new SelfModel({
	db,
	log: silentLogger,
	mode: () => "awake",
	repoDir: ".",
	hostDir: ".",
	llamaServer: "x",
	geoHttp: null,
});
self.setFacet("hardware", { machine: "NVIDIA DGX Spark", chip: "GB10", memoryGb: 122 }, "probe", null, NOW);
const upkeep = new SelfUpkeep({
	db,
	log: silentLogger,
	self,
	mode: () => "awake",
	processes: () => [
		{ role: "the host", pid: 100 },
		{ role: "the model router", pid: 200, router: true },
	],
	paths: { home: "/" },
	dirs: () => ({}),
	models: () => [],
	rhythm: null,
	inRestWindow: () => false,
	process: null,
	exec: async (file, args) => {
		if (file === "nvidia-smi")
			return args[0]!.startsWith("--query-gpu") ? "3, 41, 12.5\n" : "300, 29923\n302, 61440\n";
		if (file === "ps" && args[1] === "pid=,ppid=,rss=")
			return ["  100    50  204800", "  200   100  262144", "  300   200 4194304", "  302   200 3145728"].join("\n");
		if (file === "ps") return "  300 llama-server --alias gemma-4-26B\n  302 llama-server --alias qwen38-27b-tak\n";
		return "";
	},
	readFile: (p) =>
		p === "/proc/meminfo"
			? "MemTotal:       127599740 kB\nMemAvailable:   9437184 kB\nSwapTotal:      16777212 kB\nSwapFree:       16357784 kB\n"
			: null,
	listDir: () => [],
	platform: "linux",
});
self.attach(upkeep);
const exp = new SelfExpectations({
	db,
	log: silentLogger,
	self,
	mode: () => "awake",
	needs: {},
	restWindowMinutes: 240,
});
self.attach(exp);
const machine = exp["machine" as keyof SelfExpectations] as unknown as string;
for (let d = 1; d <= 10; d++)
	for (let h = 0; h < 24; h++)
		recordReadings(
			db,
			machine,
			"memory",
			{ availableGb: 50, "resident:model gemma-4-26B": 4, "gpu:model gemma-4-26B": 29.2 },
			new Date(NOW.getTime() - d * DAY + h * 3_600_000),
		);
const kit = selfToolkit({
	facet: async (facet) => {
		if (facet === "memory") {
			await upkeep.current();
			return upkeep.memoryReport({ compare: true });
		}
		if (facet === "disk") return upkeep.diskReport();
		if (facet === "compute") return upkeep.computeReport();
		if (facet === "runs") return upkeep.runsReport();
		if (facet === "normal") return exp.report();
		if (facet === "models") return upkeep.modelsReport();
		return "network: there is a way out; Wi-Fi up";
	},
	diskUsage: () => upkeep.diskUsage(),
});

// ---- the real router and model
const router = new RouterProcess({
	command: config.llamaServer,
	argsPrefix: config.llamaServerArgsPrefix,
	port: await freePort(),
	presetPath: join(stateDir, "models.ini"),
	stateDir,
	startTimeoutMs: 60_000,
	stopGraceMs: 30_000,
	log: consoleLogger(),
});
for (const sig of ["SIGINT", "SIGTERM"] as const)
	process.on(sig, () => void router.stop().finally(() => process.exit(130)));
await router.start();
let accepted = 0;
try {
	const client = new RouterClient(router.url);
	const t0 = Date.now();
	await client.load(MODEL);
	while ((await client.listModels()).get(MODEL)?.value !== "loaded") {
		if (Date.now() - t0 > 300_000) throw new Error(`${MODEL} did not load`);
		await new Promise((r) => setTimeout(r, 500));
	}
	const conv = new PiConversations({
		db,
		runtime: await createLocalModelRuntime({ routerUrl: router.url, registry }),
		stateDir: join(scratch, "pi"),
		identity: "You are Iyye, a personal assistant, doing a background investigation of your own.",
		log: silentLogger,
		tools: new ToolBroker({ db, log: silentLogger, toolkits: [kit] }),
		backgroundNotes: () => self.aboutOwnWork(),
	});
	for (let run = 1; run <= RUNS; run++) {
		// One opportunity per run, as the motivations open it for a surprising reading.
		const id = `smoke-${run}`;
		const at = new Date().toISOString();
		db.prepare(
			`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, signal_kind, action_kind)
			 VALUES (?, ?, 'machine', '[]', ?, ?, 'open', ?, ?, 'curiosity', 'self_surprise', 'investigate')`,
		).run(
			id,
			`surprise:${id}`,
			"memory available has been unusual since today 12:00: 9 GB, usually about 50 at that hour",
			"What explains this reading? Find what holds or uses it now, and how that differs from what is usual.",
			at,
			at,
		);
		const queue: { origin: string; prompt: string; session?: string }[] = [];
		const inv = new Investigations({
			db,
			worker: {
				enqueue: (step) => {
					queue.push(step);
					return `q-${queue.length}`;
				},
				initiativePaused: () => false,
			},
			mode: () => "awake",
			log: silentLogger,
		});
		await inv.tick();
		let steps = 0;
		while (queue.length) {
			const step = queue.shift()!;
			steps++;
			const started = Date.now();
			const r = await conv.turn({
				scope: step.session!,
				view: { kind: "background" },
				model: MODEL,
				text: step.prompt,
			});
			const job = `${id}-${steps}`;
			insertBackgroundJob(db, {
				id: job,
				origin: step.origin,
				session: step.session!,
				prompt: step.prompt,
				at: new Date().toISOString(),
			});
			db.prepare("UPDATE background_jobs SET status = 'settled', result = ?, settled_at = ? WHERE id = ?").run(
				r.ok ? r.text : "",
				new Date().toISOString(),
				job,
			);
			const calls = db
				.prepare("SELECT tool, args_json, outcome FROM tool_calls WHERE scope = ?")
				.all(step.session) as {
				tool: string;
				args_json: string;
				outcome: string;
			}[];
			inv.onStepSettled(getBackgroundJob(db, job)!);
			const o = db.prepare("SELECT status, outcome FROM opportunities WHERE id = ?").get(id) as {
				status: string;
				outcome: string | null;
			};
			console.log(
				JSON.stringify({
					run,
					step: steps,
					s: Math.round((Date.now() - started) / 1000),
					tools: calls.map((c) => `${c.tool}${c.args_json === "{}" ? "" : c.args_json}:${c.outcome}`),
					accepted: o.outcome === "resolved",
					answer: r.ok ? r.text.replace(/\s+/g, " ").slice(0, 420) : `(${r.reason}: ${r.message})`,
				}),
			);
			if (o.outcome === "resolved") accepted++;
			if (o.status !== "running") break;
		}
		// A run that found nothing must not be picked up again by the next run's sweep.
		db.prepare("UPDATE opportunities SET status = 'suspended' WHERE id = ? AND status != 'settled'").run(id);
	}
} finally {
	await router.stop();
	db.close();
}
console.log(`accepted ${accepted} of ${RUNS} investigations (${MODEL})`);
