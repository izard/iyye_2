// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The real smoke of the social follow-up's composition (plan 0.010 M3, after
 * 2026-11-14: a request that named a day was followed up with "how did your
 * date go?"). The real background model, on a scratch router on a free port
 * (never the owner's), gets the follow-up prompt for messages that tell of an
 * event and messages that do not; the host's check then judges each answer.
 * Nothing is sent anywhere and nothing of `~/.iyye2` is read.
 *
 *   node scripts/followup-smoke.ts <scratch-dir> [model] [more.json]
 *
 * `more.json`: further samples, `[{ "said": "...", "name": "...", "event": true }]`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { routerComplete } from "../src/facts/extractor.ts";
import { consoleLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import { loadRegistry } from "../src/models/registry.ts";
import { RouterProcess } from "../src/models/router.ts";
import { checkFollowUp, followUpInput, followUpSystem } from "../src/motivation/actor.ts";
import { eventDate } from "../src/motivation/detectors.ts";

interface Sample {
	said: string;
	name: string | null;
	/** Whether the message tells of something of the person's own that a follow-up may ask about. */
	event: boolean;
}

const SAMPLES: Sample[] = [
	{ said: "I have my driving exam tomorrow, wish me luck", name: "Jacob", event: true },
	{
		said: "Alas, the parcel is delayed by the carrier for one day, should arrive tomorrow now",
		name: null,
		event: true,
	},
	{ said: "Сегодня у меня собеседование в новой компании", name: "Julia", event: true },
	{ said: "Завтра показываю презентацию начальству, волнуюсь", name: "Julia", event: true },
	{ said: "We fly to Lisbon on Friday, finally a holiday", name: null, event: true },
	{ said: "My sister visits us tomorrow with the kids", name: "Jacob", event: true },
	{ said: "В субботу у сына школьный концерт", name: "Julia", event: true },
	{ said: "The plumber comes today to fix the boiler", name: null, event: true },
	// No event: a request, a question, a remark about when Iyye may do something.
	{ said: "Можешь прислать хоть сегодня, когда сможешь, или завтра.", name: "Julia", event: false },
	{ said: "Good morning Iyye, what are news today? And localllama reddit", name: null, event: false },
	{ said: "AI news today? Generic, not in depth.", name: null, event: false },
	{ said: "yes, check tomorrow morning please.", name: null, event: false },
	{ said: "Nothing has changed today", name: "Jacob", event: false },
	{ said: "Спасибо, сегодня мне уже лучше", name: "Julia", event: false },
	{ said: "Today is a nice day", name: "Jacob", event: false },
	{ said: "Пришли вторую часть завтра утром", name: "Julia", event: false },
];

const [scratch, modelArg, more] = process.argv.slice(2);
if (!scratch) {
	console.error("usage: node scripts/followup-smoke.ts <scratch-dir> [model] [more.json]");
	process.exit(2);
}
const MODEL = modelArg ?? "gemma-4-E4B";
const samples = [...SAMPLES, ...(more ? (JSON.parse(readFileSync(more, "utf8")) as Sample[]) : [])];
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
const tally = { asked: 0, events: 0, others: 0, byDetector: 0, byModel: 0, byCheck: 0, sent: 0 };
try {
	const client = new RouterClient(router.url);
	const t0 = Date.now();
	await client.load(MODEL);
	while ((await client.listModels()).get(MODEL)?.value !== "loaded") {
		if (Date.now() - t0 > 300_000) throw new Error(`${MODEL} did not load`);
		await new Promise((r) => setTimeout(r, 500));
	}
	const complete = routerComplete(router.url, 600);
	const saidAt = new Date(Date.now() - 86_400_000);
	for (const s of samples) {
		const raw = await complete(
			MODEL,
			followUpSystem(s.name),
			followUpInput({ said_at: saidAt.toISOString(), user_text: s.said }),
			new AbortController().signal,
		);
		const checked = checkFollowUp(raw, [], s.said, s.name ? [s.name] : []);
		const verdict =
			typeof checked === "string"
				? checked
					? "would send"
					: "empty"
				: checked.none
					? "NONE"
					: `refused: ${checked.why}`;
		const opens = eventDate(s.said, saidAt) !== null;
		if (s.event) {
			tally.events++;
			if (opens && verdict === "would send") tally.asked++;
		} else {
			tally.others++;
			// Three layers, in the order the host applies them.
			if (!opens) tally.byDetector++;
			else if (verdict === "NONE") tally.byModel++;
			else if (verdict !== "would send") tally.byCheck++;
			else tally.sent++;
		}
		console.log(
			JSON.stringify({
				event: s.event,
				detector: opens ? "opens" : "ignores",
				verdict,
				said: s.said.slice(0, 70),
				wrote: raw.replace(/\s+/g, " ").slice(0, 200),
			}),
		);
	}
} finally {
	await router.stop();
}
console.log(
	`${MODEL}: ${tally.asked} of ${tally.events} events would be asked about; of ${tally.others} messages with no event, the detector stopped ${tally.byDetector}, the model ${tally.byModel}, the check ${tally.byCheck}, and ${tally.sent} would be sent`,
);
if (tally.sent > 0) process.exitCode = 1;
