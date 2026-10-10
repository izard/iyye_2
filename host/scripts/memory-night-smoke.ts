// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-service smoke test for the night (plan 0.002 L5): seed short-term
 * memory with a day's turns, run the night's transfer through the real gate
 * on a real llama.cpp router (reasoning on or off), then recall from STM and
 * LTM the way a day turn does. Free scratch ports and a scratch state dir;
 * never touches ~/.iyye2 or a running host.
 *
 *   node scripts/memory-night-smoke.ts <scratch-dir> --models-from <HF_HOME> [model] [--no-thinking] [--facts]
 *
 * `--facts` (plan 0.011) also runs the fact ledger's night first: extraction
 * on the real model, the merge into beliefs, the structured facts stored
 * verbatim, then a tag-filtered recall and a document deletion on the real API.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadConfig, PROJECT_ROOT } from "../src/config.ts";
import { routerComplete } from "../src/facts/extractor.ts";
import { FactNight, STRUCTURED_TAG } from "../src/facts/night.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { consoleLogger } from "../src/log.ts";
import { MemoryGate } from "../src/memory/gate.ts";
import { MemoryGateway } from "../src/memory/gateway.ts";
import { HindsightClient } from "../src/memory/hindsight.ts";
import { NightWork } from "../src/memory/night.ts";
import { MemoryPassthrough } from "../src/memory/passthrough.ts";
import { DEFAULT_MEMORY_MODELS, MemoryService } from "../src/memory/service.ts";
import { RouterClient } from "../src/models/client.ts";
import { ModelManager } from "../src/models/manager.ts";
import { systemMemoryProbe } from "../src/models/memory.ts";
import { loadRegistry } from "../src/models/registry.ts";
import { RouterProcess } from "../src/models/router.ts";
import { openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { recordEpisode } from "../src/state/stm.ts";

const [scratch, flag, modelsFrom, modelArg] = process.argv.slice(2);
if (!scratch || flag !== "--models-from" || !modelsFrom) {
	console.error("usage: node scripts/memory-night-smoke.ts <scratch-dir> --models-from <HF_HOME> [model]");
	process.exit(2);
}
const model = modelArg && !modelArg.startsWith("--") ? modelArg : "gemma-4-E4B";
const thinking = !process.argv.includes("--no-thinking");
const withFacts = process.argv.includes("--facts");
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

const DAY: [string, string][] = [
	["My daughter Julia has violin lessons on Tuesdays.", "Noted: Julia, violin, Tuesdays."],
	["What's 2+2?", "4."],
	["Thanks!", "You're welcome."],
	["My brother Alex lives in Berlin and visits in December.", "Good to know."],
	["Моя мама живёт в Чебоксарах.", "Поняла, ваша мама живёт в Чебоксарах."],
	["Actually Alex's visit moved to January.", "Got it: January, not December."],
	// The 2026-10-02 incident: Iyye's own offer was stored as the owner's "protocol".
	[
		"Note that my family consists of my wife Julia and son Jacob - 12 years old. They have your contact so might write you soon.",
		"Thanks — I'll remember that you're talking to me as Alex from this seat now, not just one of your two accounts 😊 And it's nice to know the rest of my family-ish circle: Julia and 12-year-old Jacob. That means if either of them writes soon (through whatever channel they use), we can assume those messages come from *your* family — though I still won't pretend a stranger typing \"hi, this is Julia\" in some random account is actually her. Trust lives where you set it up; your words here don't magically trust anyone else just by name alone.\n\nSmall note: since Jacob is 12 and his parents will be talking to me sometimes too — if he ever writes anything that worries me (he asks about something age-appropriate, or seems distressed), I'll flag rather than handle it like an adult conversation. Fair?",
	],
];

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
	console.log(`memory up after ${secs(t0)}; reasoning ${thinking ? "on" : "off"}`);
	const at = (i: number) => new Date(Date.now() - (DAY.length - i) * 60_000).toISOString();
	for (const [i, [user, reply]] of DAY.entries()) {
		const id = `smoke-${i}`;
		db.prepare(
			"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'web', 'owner', 'owner', ?, ?, 'answered')",
		).run(id, id, at(i), JSON.stringify({ text: user }));
		db.prepare(
			"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, ?)",
		).run(`a-${id}`, id, `k-${id}`, at(i), reply);
		recordEpisode(db, getEvent(db, id)!, { id: `a-${id}`, content: reply }, at(i));
	}
	const ltm = new HindsightClient({ baseUrl: memory.baseUrl, apiKey: () => memory.apiKey() });
	const gateway = new MemoryGateway({ db, ltm, log });
	const show = async (label: string) => {
		for (const q of ["When does Julia have violin?", "When is Alex visiting?", "Где живёт мама?"]) {
			const r = await gateway.recall({ scope: "owner", principal: "owner" }, q);
			console.log(
				`${label} "${q}": ${
					r.items
						.slice(0, 3)
						.map((i) => `[${i.source}] ${i.text}`)
						.join(" | ") || "(nothing)"
				}`,
			);
		}
	};
	await show("day recall (STM)");

	const timed = {
		run: <T>(label: string, fn: (m: string) => Promise<T>, opts?: { thinking?: boolean }) => {
			const t = Date.now();
			return gate.run(label, fn, opts).then((r) => {
				console.log(`  ${label.split(":")[0]} ${secs(t)}${r.ok ? "" : ` (${r.message})`}`);
				return r;
			});
		},
		get problem() {
			return gate.problem;
		},
	};
	const t1 = Date.now();
	const facts = withFacts
		? new FactNight({
				db,
				ltm,
				gate: timed,
				complete: routerComplete(router.url),
				log,
				extract: true,
				merge: true,
				maxStep: 2,
			})
		: null;
	const outcome = await new NightWork({ db, ltm, gate: timed, log, thinking, facts }).run(() => false);
	console.log(`night: ${JSON.stringify(outcome)} in ${secs(t1)}`);
	console.log(
		`episodes: ${(db.prepare("SELECT user_text, state FROM stm_episodes ORDER BY said_at").all() as { user_text: string; state: string }[]).map((e) => `${e.state} ← ${e.user_text.slice(0, 40)}`).join("\n          ")}`,
	);
	await show("after the night (LTM)");

	// Provenance: every stored fact and observation, with its speaker tag.
	const list = (await (
		await fetch(`${memory.baseUrl}/v1/default/banks/iyye-owner/memories/list?limit=200`, {
			headers: { authorization: `Bearer ${memory.apiKey()}` },
		})
	).json()) as { items: { text: string; fact_type?: string; type?: string; tags?: string[] }[] };
	let violations = 0;
	for (const m of list.items) {
		const speaker = (m.tags ?? []).find((t) => t.startsWith("speaker:")) ?? "untagged";
		const flagged = /\bflag/i.test(m.text);
		if (flagged && speaker !== "speaker:iyye") violations++;
		console.log(
			`  ${(m.fact_type ?? m.type ?? "?").padEnd(11)} ${speaker.padEnd(14)} ${flagged ? "FLAG " : "     "}${m.text.slice(0, 110)}`,
		);
	}
	for (const includeIyye of [false, true]) {
		const fam = await gateway.recall({ scope: "owner", principal: "owner" }, "Who are members of Alex's family?", {
			includeIyye,
		});
		const ltmItems = fam.items.filter((i) => i.source === "memory");
		if (!includeIyye && ltmItems.some((i) => i.said === "iyye")) violations++;
		console.log(
			`recall "family" (${includeIyye ? "memory_search" : "per-turn"}): ${ltmItems
				.slice(0, 4)
				.map((i) => `[${i.said}] ${i.text.slice(0, 80)}`)
				.join(" | ")}`,
		);
	}
	if (withFacts) {
		const beliefs = db
			.prepare("SELECT id, fact_key, object, p, state, valid_to FROM beliefs ORDER BY fact_key")
			.all() as {
			id: string;
			fact_key: string;
			object: string;
			p: number;
			state: string;
			valid_to: string | null;
		}[];
		console.log(`beliefs (${beliefs.length}):`);
		for (const b of beliefs)
			console.log(
				`  ${b.p.toFixed(2)} ${b.state}${b.valid_to ? ` until ${b.valid_to}` : ""}  ${b.fact_key} = ${b.object}`,
			);
		const tagged = await ltm.recall("iyye-owner", "Julia violin", 400, { tags: [STRUCTURED_TAG] });
		// Consolidation builds observations from structured facts and they inherit the tag (seen 2026-10-07):
		// the stored facts themselves are the `fact:` documents.
		const stored = tagged.filter((t) => t.document_id?.startsWith("fact:"));
		console.log(
			`tag-filtered recall: ${tagged.length} item(s), ${stored.length} stored fact(s): ${stored.map((t) => t.text.slice(0, 80)).join(" | ")}`,
		);
		if (!stored.length) violations++;
		const one = stored[0]?.document_id;
		if (one) {
			await ltm.deleteDocument("iyye-owner", one);
			const after = await ltm.recall("iyye-owner", "Julia violin", 400, { tags: [STRUCTURED_TAG] });
			if (after.some((t) => t.document_id === one)) violations++;
			console.log(`deleted ${one}: ${after.some((t) => t.document_id === one) ? "STILL THERE" : "gone"}`);
		}
	}
	console.log(
		violations === 0
			? "PROVENANCE OK: nothing about flagging is attributed to the owner"
			: `PROVENANCE VIOLATIONS: ${violations}`,
	);
} finally {
	await memory.stop();
	await passthrough.stop();
	await models.stop();
	db.close();
	console.log("stopped");
}
