// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The real smoke of the thinking model's away note (`Toolkit.note`,
 * `tools/thinking.ts`): does the chat model, told before the turn that the
 * thinking model cannot be asked, leave the tool alone, say so when the person
 * asked for it, and keep quiet about it otherwise?
 *
 * The real chat model on a scratch router (a free port, never the owner's),
 * the real identity prompt, real Pi turns. The thinking toolkit is the real
 * one over a machine that refuses every lease, as the pass-through does while
 * the other machine is unreachable; nothing is sent anywhere else. Every
 * message runs twice, each in a fresh conversation: without the note (how it
 * went before 2026-11-14) and with it.
 *
 *   node scripts/thinking-away-smoke.ts <scratch-dir> [model]
 *
 * Prints per message and arm: the calls to `ask_thinking_model`, whether the
 * reply says the thinking model is unavailable, and the reply. Exit code 1
 * when, with the note, the tool was called, a reply to someone who asked for
 * the thinking model does not say it is unavailable, or a reply to someone who
 * did not ask brings it up.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createLocalModelRuntime, thinkingLevelFor } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { consoleLogger, silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import { loadRegistry } from "../src/models/registry.ts";
import { RouterProcess } from "../src/models/router.ts";
import { openDb } from "../src/state/db.ts";
import { ToolBroker } from "../src/tools/broker.ts";
import { currentTimeTool } from "../src/tools/probes.ts";
import { ASK_THINKING_TOOL, thinkingToolkit } from "../src/tools/thinking.ts";

const [scratch, modelArg] = process.argv.slice(2);
if (!scratch) {
	console.error("usage: node scripts/thinking-away-smoke.ts <scratch-dir> [model]");
	process.exit(2);
}
const MODEL = modelArg ?? "gemma-4-26B";
const MACHINE = "mbp";

/** `asks`: the person asks for the thinking model in so many words. */
const MESSAGES: { id: string; asks: boolean; text: string }[] = [
	{
		id: "asks-en",
		asks: true,
		text: "Ask the thinking model: a bat and a ball cost 1.10 together, and the bat costs 1.00 more than the ball. What does the ball cost?",
	},
	{
		id: "asks-ru",
		asks: true,
		text: "Спроси думающую модель: у Салли три брата, у каждого брата по две сестры. Сколько сестёр у Салли?",
	},
	{
		id: "asks-think-hard",
		asks: true,
		text: "Use the thinking model for this one, I want a careful answer: compare state-space models like Mamba with decoder-only transformers for long-context language modelling.",
	},
	{
		id: "hard-puzzle",
		asks: false,
		text: "Three people check into a hotel room that costs 30. Each pays 10. The clerk returns 5; the bellboy keeps 2 and gives each person 1 back. So each paid 9, 27 in all, plus the bellboy's 2 makes 29. Where is the missing one?",
	},
	{ id: "easy", asks: false, text: "What is the capital of France?" },
	{ id: "small-talk-ru", asks: false, text: "Привет! Как дела?" },
];
/**
 * The reply tells the person the thinking model cannot be used now. Generous on purpose (the model words it
 * freely, in either language); it is only asked of replies to someone who asked for the thinking model.
 */
const SAYS_AWAY =
	/unreachable|unavailable|n[o']t (?:currently |presently )?(?:available|reachable|responding)|(?:could(?: not|n't)|can(?:not|'t)|unable to) (?:reach|ask|consult|get through|send|pass)|недоступ|не\s+(?:могу|смогу|удалось|получилось|получится)|нет\s+(?:связи|доступа)|связь[^.!?\n]*(?:прервал|оборвал)|не отвечает/i;
/** The reply brings the thinking model or its machine up at all. */
const NAMES_IT = /(?:thinking|reasoning|stronger) model|думающ\S* модел|\bmbp\b|other (?:computer|machine)/i;

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

const db = openDb(join(stateDir, "smoke.db"));
let note = false;
// The real toolkit over a machine that is away: the lease is refused in the pass-through's own words.
const thinking = thinkingToolkit({
	db,
	model: `qwen38-27b-tak@${MACHINE}`,
	machine: MACHINE,
	models: {
		acquire: async () => ({
			ok: false,
			busy: true,
			message: `${MACHINE} is unreachable: connect ECONNREFUSED`,
		}),
	},
	device: new DeviceSlot(),
	complete: async () => {
		throw new Error("the smoke's thinking model must never be reached");
	},
	dailyMax: 50,
	away: () => (note ? "unreachable" : null),
});

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
let bad = 0;
try {
	const client = new RouterClient(router.url);
	const t0 = Date.now();
	await client.load(MODEL);
	while ((await client.listModels()).get(MODEL)?.value !== "loaded") {
		if (Date.now() - t0 > 600_000) throw new Error(`${MODEL} did not load`);
		await new Promise((r) => setTimeout(r, 500));
	}
	console.log(`${MODEL} loaded after ${Math.round((Date.now() - t0) / 1000)} s`);
	const conv = new PiConversations({
		db,
		runtime: await createLocalModelRuntime({ routerUrl: router.url, registry }),
		thinkingLevel: (m) => thinkingLevelFor(registry, m),
		stateDir: join(scratch, "pi"),
		identity: readFileSync(config.identityFile, "utf8"),
		log: silentLogger,
		clockNote: true,
		tools: new ToolBroker({
			db,
			log: silentLogger,
			toolkits: [{ name: "core", description: "the time", effect: "read", tools: [currentTimeTool()] }, thinking],
		}),
	});
	const tally = { off: { called: 0, saysAway: 0 }, on: { called: 0, saysAway: 0, wrong: 0 } };
	for (const m of MESSAGES) {
		for (const arm of ["off", "on"] as const) {
			note = arm === "on";
			const scope = `owner-${m.id}-${arm}`;
			const started = Date.now();
			const r = await conv.turn({ scope, view: { kind: "owner", channel: "web" }, model: MODEL, text: m.text });
			const calls = (
				db
					.prepare("SELECT count(*) AS n FROM tool_calls WHERE scope = ? AND tool = ?")
					.get(scope, ASK_THINKING_TOOL) as {
					n: number;
				}
			).n;
			const reply = r.ok ? r.text : `[no reply: ${r.reason}]`;
			const saysAway = SAYS_AWAY.test(reply);
			const namesIt = NAMES_IT.test(reply);
			let verdict = "";
			if (arm === "on") {
				const problems = [
					calls > 0 ? "called the tool" : null,
					!r.ok ? "no reply" : null,
					m.asks && !saysAway ? "did not say it is unavailable" : null,
					!m.asks && namesIt ? "brought the thinking model up unasked" : null,
				].filter(Boolean);
				if (problems.length) {
					bad++;
					tally.on.wrong++;
				}
				verdict = problems.length ? `WRONG: ${problems.join("; ")}` : "ok";
			}
			tally[arm].called += calls > 0 ? 1 : 0;
			tally[arm].saysAway += saysAway ? 1 : 0;
			console.log(
				JSON.stringify(
					{
						message: m.id,
						asks: m.asks,
						note: arm,
						calls,
						saysAway,
						...(verdict ? { verdict } : {}),
						seconds: Math.round((Date.now() - started) / 1000),
						reply: reply.replace(/\s+/g, " ").slice(0, 400),
					},
					null,
					1,
				),
			);
		}
	}
	await conv.disposeAll();
	console.log(
		`\n${MESSAGES.length} messages (${MESSAGES.filter((m) => m.asks).length} ask for the thinking model). ` +
			`Without the note: the tool was called in ${tally.off.called}, ${tally.off.saysAway} replies say it is unavailable. ` +
			`With the note: called in ${tally.on.called}, ${tally.on.saysAway} say it is unavailable, ${tally.on.wrong} wrong.`,
	);
} finally {
	await router.stop();
}
process.exit(bad ? 1 : 0);
