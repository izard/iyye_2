// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

// S0 spike (plan 0.007): what a Pi abort leaves in the transcript, and how a paused step resumes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { createLocalModelRuntime } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import { openDb } from "../src/state/db.ts";
import { ToolBroker } from "../src/tools/broker.ts";
import { fakeRouterProcess, freePort, sandbox, waitFor } from "../test/model-helpers.ts";

const sb = sandbox();
writeFileSync(join(sb.stateDir, "models.ini"), renderPreset(sb.registry));
const router = fakeRouterProcess(sb, await freePort());
await router.start();
const client = new RouterClient(router.url);
await client.load("small");
await waitFor(async () => (await client.listModels()).get("small")?.value === "loaded");
const probeRuns: string[] = [];
const db = openDb(":memory:");
const conv = new PiConversations({
	db,
	runtime: await createLocalModelRuntime({ routerUrl: router.url, registry: sb.registry }),
	stateDir: sb.stateDir,
	identity: "You are Iyye.",
	log: silentLogger,
	tools: new ToolBroker({
		db,
		log: silentLogger,
		toolkits: [
			{
				name: "core",
				description: "probe",
				effect: "read",
				tools: [
					{
						name: "probe",
						label: "Probe",
						description: "a slow probe",
						summary: "a slow probe",
						parameters: Type.Object({}),
						run: async () => {
							probeRuns.push(new Date().toISOString());
							await new Promise((r) => setTimeout(r, 800));
							return "disk 42% free";
						},
					},
				],
			},
		],
	}),
});
const owner = { kind: "owner" as const, channel: "web" as const };
const transcript = (scope: string) =>
	readFileSync(conv.sessionFile(scope)!, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l))
		.filter((e) => e.type === "message")
		.map((e) => ({
			role: e.message.role,
			stop: e.message.stopReason,
			text: JSON.stringify(e.message.content).slice(0, 90),
		}));
const requests = () =>
	readFileSync(join(sb.stateDir, "fake-router-requests.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { messages: { role: string; content: unknown }[] });

async function pauseAt(scope: string, label: string, afterMs: number) {
	const ac = new AbortController();
	const t0 = Date.now();
	const turn = conv.turn({ scope, view: owner, model: "small", text: "[[tool:probe]] [[slow]]", signal: ac.signal });
	await new Promise((r) => setTimeout(r, afterMs));
	ac.abort();
	const r = await turn;
	console.log(
		`\n== ${label}: aborted at ${afterMs} ms → ${JSON.stringify(r)} after ${Date.now() - t0} ms; probe runs ${probeRuns.length}`,
	);
	console.log("transcript:", transcript(scope));
	// Resume: a host note continues the step.
	const before = requests().length;
	const r2 = await conv.turn({
		scope,
		view: owner,
		model: "small",
		text: "[Note from Iyye's host] continue where you stopped",
	});
	console.log("resume:", JSON.stringify(r2));
	const sent = requests().slice(before);
	console.log(
		"resume request messages:",
		sent[0]!.messages.map((m) => `${m.role}:${JSON.stringify(m.content).slice(0, 50)}`),
	);
}

// The first request waits 1.5 s, then calls the tool (0.8 s), then the second request waits 1.5 s.
await pauseAt("a-gen", "abort during the generation after the tool result", 2900);
probeRuns.length = 0;
await pauseAt("b-tool", "abort during the tool", 1900);
probeRuns.length = 0;
await pauseAt("c-first", "abort during the first generation", 500);
await conv.disposeAll();
await router.stop();
sb.cleanup();
