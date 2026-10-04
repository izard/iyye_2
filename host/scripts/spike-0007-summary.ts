// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * S3 check (plan 0.007): how often the memory model's day-summary note passes
 * the deterministic check. Runs the real llama.cpp router on a free port with
 * scratch state (never ~/.iyye2), loads one model, and composes summaries of
 * a few synthetic days.
 *
 *   node scripts/spike-0007-summary.ts <scratch-dir> [model]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { composeDaySummary, type DayWindow } from "../src/kernel/day-summary.ts";
import { consoleLogger } from "../src/log.ts";
import type { NightOutcome } from "../src/memory/night.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import { loadRegistry } from "../src/models/registry.ts";
import { RouterProcess } from "../src/models/router.ts";
import { openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { recordEpisode } from "../src/state/stm.ts";

const [scratch, modelArg] = process.argv.slice(2);
if (!scratch) {
	console.error("usage: node scripts/spike-0007-summary.ts <scratch-dir> [model]");
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

let seq = 0;
function day(owner: number, contacts: Record<string, number>, failed: number) {
	const db = openDb(":memory:");
	const add = (scope: string, contact: string, at: string) => {
		const id = `e${++seq}`;
		const web = scope === "owner";
		db.prepare(
			"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'answered')",
		).run(
			id,
			id,
			web ? "web" : "telegram",
			contact,
			scope,
			at,
			JSON.stringify(web ? { text: "x" } : { message: { text: "x", chatId: 1 } }),
		);
		db.prepare(
			"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, 'ok')",
		).run(`a-${id}`, id, `k-${id}`, at);
		recordEpisode(db, getEvent(db, id)!, { id: `a-${id}`, content: "ok" }, at);
	};
	for (let i = 0; i < owner; i++) add("owner", "owner", `2026-10-03T${String(8 + i).padStart(2, "0")}:00:00.000Z`);
	for (const [name, n] of Object.entries(contacts)) {
		const id = `c-${name}`;
		db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', 't')").run(
			id,
			name,
		);
		for (let i = 0; i < n; i++) add(`contact:${id}`, id, `2026-10-03T${String(9 + i).padStart(2, "0")}:30:00.000Z`);
	}
	if (owner > 3)
		db.prepare(
			"INSERT INTO tool_calls (id, scope, principal, tool, args_json, outcome, started_at, finished_at) VALUES ('t1', 'owner', 'owner', 'web_search', '{}', 'ok', '2026-10-03T10:00:01.000Z', '2026-10-03T10:00:02.000Z')",
		).run();
	for (let i = 0; i < failed; i++)
		db.prepare(
			"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'web', 'owner', 'owner', '2026-10-03T15:00:00.000Z', '{}', 'admitted')",
		).run(`f${i}`, `f${i}`);
	for (let i = 0; i < failed; i++)
		db.prepare(
			"INSERT INTO jobs (id, trigger_event_id, scope, status, created_at) VALUES (?, ?, 'owner', 'failed', '2026-10-03T15:00:00.000Z')",
		).run(`j${i}`, `f${i}`);
	db.prepare(
		"INSERT INTO energy_ledger (at, kind, amount, level_after, ref) VALUES ('2026-10-03T20:00:00.000Z', 'awake', -0.1, 0.38, NULL)",
	).run();
	return db;
}

const DAYS: [string, ReturnType<typeof day>, NightOutcome][] = [
	["quiet", day(1, {}, 0), { kind: "done", completed: 0, empty: 1, failed: 0, consolidated: [] }],
	[
		"typical",
		day(5, { Julia: 3 }, 0),
		{ kind: "done", completed: 4, empty: 4, failed: 0, consolidated: ["iyye-owner"] },
	],
	["busy", day(9, { Julia: 4, Alex: 2 }, 1), { kind: "done", completed: 9, empty: 6, failed: 0, consolidated: [] }],
	[
		"blocked",
		day(4, { Alex: 1 }, 0),
		{ kind: "blocked", reason: "long-term memory is unreachable", completed: 1, empty: 0, failed: 0 },
	],
];

await router.start();
const results: unknown[] = [];
try {
	const client = new RouterClient(router.url);
	await client.load(model);
	while ((await client.listModels()).get(model)?.value !== "loaded") await new Promise((r) => setTimeout(r, 500));
	const complete = async (system: string, user: string) => {
		const res = await fetch(`${router.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model,
				stream: false,
				max_tokens: 400,
				chat_template_kwargs: { enable_thinking: false },
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
			}),
		});
		const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		return body.choices?.[0]?.message?.content ?? null;
	};
	for (const [name, db, outcome] of DAYS) {
		for (let run = 0; run < 3; run++) {
			const w: DayWindow = { day: 4, from: "2026-10-03T00:10:00.000Z", to: "2026-10-03T23:50:00.000Z", outcome };
			let note: string | null = null;
			const r = await composeDaySummary(db, w, {
				complete: async (s, u) => {
					note = await complete(s, u);
					return note;
				},
			});
			results.push({ day: name, run, source: r.source, problem: r.problem, note });
			console.log(
				`${name}#${run}: ${r.source}${r.problem ? ` (${r.problem})` : ""}\n  ${String(note).replace(/\n/g, " ")}`,
			);
		}
	}
} finally {
	await router.stop();
	writeFileSync(join(scratch, "summary-results.json"), JSON.stringify(results, null, 2));
}
