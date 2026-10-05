// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * C0 spike (plan 0.006): reminder tool use by the chat model. Runs the real
 * llama.cpp router on a free port with scratch state (never ~/.iyye2, never
 * the owner's router), and 20 phrasings (English and Russian, recurring,
 * ambiguous, and requests that must not create a reminder) through
 * PiConversations with the real identity prompt, in two variants:
 *
 * - A: `when` in a simple form ("in 2 hours", "tomorrow 09:00"), parsed by the host (kernel/when.ts);
 * - B: `when` as an ISO local time the model computes (it can call current_time).
 *
 * The clock is fixed (current_time answers Sunday 4 October 2026 14:00).
 *
 *   node scripts/spike-0006-reminders.ts <scratch-dir> [model]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Type } from "typebox";
import { loadConfig } from "../src/config.ts";
import { createLocalModelRuntime } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { describeAt, parseWhen } from "../src/kernel/when.ts";
import { consoleLogger, silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import { loadRegistry } from "../src/models/registry.ts";
import { RouterProcess } from "../src/models/router.ts";
import { openDb } from "../src/state/db.ts";
import { type IyyeTool, ToolBroker } from "../src/tools/broker.ts";
import { currentTimeTool } from "../src/tools/probes.ts";

const [scratch, modelArg] = process.argv.slice(2);
if (!scratch) {
	console.error("usage: node scripts/spike-0006-reminders.ts <scratch-dir> [model]");
	process.exit(2);
}
const model = modelArg ?? "gemma-4-26B";
const config = loadConfig();
const NOW = new Date(2026, 9, 4, 14, 0); // Sunday
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);

interface Case {
	say: string;
	/** null: no reminder should be created (or the model should ask first). */
	due: Date | null;
	/** For a default time: only the day must match. */
	dayOnly?: boolean;
	recurrence?: "daily" | "weekly";
	text?: RegExp;
	/** Either a reminder or a question is fine. */
	lenient?: boolean;
}

const CASES: Case[] = [
	{ say: "Remind me tomorrow at 9 to call Julia", due: at(5, 9), text: /julia/i },
	{ say: "remind me in 2 hours to take the laundry out", due: at(4, 16), text: /laundry/i },
	{ say: "In 20 minutes remind me to check the oven", due: at(4, 14, 20), text: /oven/i },
	{ say: "Please remind me on Wednesday at 18:30 about the dentist", due: at(7, 18, 30), text: /dentist/i },
	{ say: "remind me at 9pm to take my pills", due: at(4, 21), text: /pill/i },
	{ say: "Remind me every day at 8:00 to stretch", due: at(5, 8), recurrence: "daily", text: /stretch/i },
	{
		say: "Remind me every Monday at 10 to send the weekly report",
		due: at(5, 10),
		recurrence: "weekly",
		text: /report/i,
	},
	{ say: "remind me next Sunday to water the plants", due: at(11, 9), dayOnly: true, text: /plant/i },
	{ say: "remind me on 12 October at noon to renew the passport", due: at(12, 12), text: /passport/i },
	{ say: "Напомни мне завтра в 9 позвонить Юлии", due: at(5, 9), text: /юли|julia/i },
	{ say: "Напомни через два часа вынуть бельё", due: at(4, 16), text: /бель|laundry/i },
	{ say: "Напомни в среду в 18:30 про стоматолога", due: at(7, 18, 30), text: /стомат|dentist/i },
	{
		say: "Каждый день в 8 утра напоминай мне сделать зарядку",
		due: at(5, 8),
		recurrence: "daily",
		text: /заряд|exercis|workout/i,
	},
	{ say: "напомни через 15 минут проверить духовку", due: at(4, 14, 15), text: /духов|oven/i },
	{ say: "Remind me in an hour", due: at(4, 15), lenient: true },
	{ say: "Remind me later about the call", due: null, lenient: true },
	{ say: "Can you remind me how photosynthesis works?", due: null },
	{ say: "I need to remember to call mom tomorrow", due: null, lenient: true },
	{ say: "What time is it?", due: null },
	{ say: "Thanks for the reminder yesterday!", due: null },
];

type Created = { text: string; at: Date; recurrence: string; raw: string };

function reminderTool(variant: "A" | "B", created: Created[]): IyyeTool {
	const params =
		variant === "A"
			? Type.Object({
					text: Type.String({
						minLength: 1,
						maxLength: 300,
						description: "What to remind about, in the person's words",
					}),
					when: Type.String({
						description:
							'When, in one of these forms: "in 20 minutes", "in 2 hours", "tomorrow 09:00", "monday 18:30", "18:30", "noon", "12 October 12:00" or "2026-10-12 12:00". Iyye resolves it in the owner\'s timezone.',
					}),
					recurrence: Type.Optional(
						Type.Union([Type.Literal("none"), Type.Literal("daily"), Type.Literal("weekly")], {
							description:
								'"daily" for "every day", "weekly" for "every Monday" and the like; otherwise leave it out',
						}),
					),
				})
			: Type.Object({
					text: Type.String({
						minLength: 1,
						maxLength: 300,
						description: "What to remind about, in the person's words",
					}),
					when: Type.String({
						pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$",
						description:
							"The local date and time, e.g. 2026-10-12T12:00. Call current_time first to know today's date.",
					}),
					recurrence: Type.Optional(
						Type.Union([Type.Literal("none"), Type.Literal("daily"), Type.Literal("weekly")]),
					),
				});
	return {
		name: "reminder_create",
		label: "Set a reminder",
		description:
			"Set a reminder: at the given time Iyye sends the text to this chat. Use it only when the person asks to be reminded; if the time or what to remind about is missing, ask them first instead of choosing. Returns the exact day and time, and whether it repeats; tell the person exactly that.",
		summary: "set a reminder that Iyye sends to this chat at a given time",
		parameters: params,
		run: async (p: { text: string; when: string; recurrence?: string }) => {
			const when = variant === "A" ? parseWhen(p.when, NOW) : parseWhen(p.when.replace("T", " "), NOW);
			if (!when.ok)
				return `Not set: ${when.error}. Ask the person what they meant; do not choose another time yourself.`;
			created.push({ text: p.text, at: when.at, recurrence: p.recurrence ?? "none", raw: p.when });
			const rec =
				p.recurrence === "daily"
					? ", then every day"
					: p.recurrence === "weekly"
						? ", then every week"
						: ", once (it does not repeat)";
			return `Reminder set for ${describeAt(when.at)}${rec} (Europe/Berlin): ${p.text}${when.defaulted ? " (no time was given, so 09:00)" : ""}`;
		},
	} as IyyeTool;
}

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
	startTimeoutMs: 120_000,
	stopGraceMs: 30_000,
	log: consoleLogger(),
});
for (const sig of ["SIGINT", "SIGTERM"] as const)
	process.on(sig, () => void router.stop().finally(() => process.exit(130)));
const identity = readFileSync(config.identityFile, "utf8");

await router.start();
const rows: unknown[] = [];
try {
	const client = new RouterClient(router.url);
	await client.load(model);
	const t0 = Date.now();
	while ((await client.listModels()).get(model)?.value !== "loaded") {
		if (Date.now() - t0 > 300_000) throw new Error("model did not load");
		await new Promise((r) => setTimeout(r, 1000));
	}
	for (const variant of (process.env.VARIANTS ?? "A,B").split(",") as ("A" | "B")[]) {
		const db = openDb(":memory:");
		const created: Created[] = [];
		const conv = new PiConversations({
			db,
			runtime: await createLocalModelRuntime({ routerUrl: router.url, registry }),
			stateDir: join(scratch, `pi-${variant}`),
			identity,
			log: silentLogger,
			tools: new ToolBroker({
				db,
				log: silentLogger,
				toolkits: [
					{ name: "core", description: "the time", effect: "read", tools: [currentTimeTool(() => NOW)] },
					{ name: "reminders", description: "reminders", effect: "act", tools: [reminderTool(variant, created)] },
				],
			}),
		});
		const score = {
			reminders: 0,
			due: 0,
			recurrence: 0,
			text: 0,
			quoted: 0,
			falsePromise: 0,
			wrongTool: 0,
			checked: 0,
		};
		for (const [i, c] of CASES.entries()) {
			created.length = 0;
			const t = Date.now();
			const r = await conv.turn({
				scope: `${variant}-${i}`,
				view: { kind: "owner", channel: "web" },
				model,
				text: c.say,
			});
			const reply = r.ok ? r.text : `(${r.reason})`;
			const made = created.at(-1) ?? null;
			const calls = (
				db.prepare("SELECT tool, args_json, result FROM tool_calls WHERE scope = ?").all(`${variant}-${i}`) as {
					tool: string;
					args_json: string;
					result: string;
				}[]
			).map((x) => `${x.tool}(${x.args_json}) → ${String(x.result).slice(0, 80)}`);
			const verdict: string[] = [];
			if (c.due === null) {
				if (made && !c.lenient) {
					score.wrongTool++;
					verdict.push("REMINDER WHERE NONE WAS ASKED");
				}
				if (!made && /\b(i'?ll|i will) remind\b|напомню/i.test(reply)) {
					score.falsePromise++;
					verdict.push("PROMISE WITHOUT A RECORD");
				}
			} else {
				score.checked++;
				if (made) {
					score.reminders++;
					const dueOk = c.dayOnly
						? made.at.toDateString() === c.due.toDateString()
						: made.at.getTime() === c.due.getTime();
					if (dueOk) score.due++;
					else verdict.push(`DUE ${describeAt(made.at)} ≠ ${describeAt(c.due)}`);
					if ((c.recurrence ?? "none") === made.recurrence) score.recurrence++;
					else verdict.push(`RECURRENCE ${made.recurrence}`);
					if (!c.text || c.text.test(made.text)) score.text++;
					else verdict.push(`TEXT "${made.text}"`);
					const hhmm = made.at.toTimeString().slice(0, 5);
					if (reply.includes(hhmm) || reply.includes(hhmm.replace(/^0/, ""))) score.quoted++;
					else verdict.push("REPLY DOES NOT QUOTE THE TIME");
				} else if (!c.lenient) verdict.push("NO REMINDER");
				if (!made && /\b(i'?ll|i will) remind\b|напомню/i.test(reply)) {
					score.falsePromise++;
					verdict.push("PROMISE WITHOUT A RECORD");
				}
			}
			const row = { variant, i, say: c.say, ms: Date.now() - t, made, calls, reply, verdict };
			rows.push(row);
			console.log(
				`${variant}${String(i).padStart(2)} ${verdict.length ? verdict.join("; ") : "ok"} — ${c.say}\n     ${reply.replace(/\s+/g, " ").slice(0, 160)}`,
			);
		}
		console.log(`variant ${variant}: ${JSON.stringify(score)}`);
		rows.push({ variant, score });
		await conv.disposeAll();
		db.close();
	}
} finally {
	await router.stop();
	writeFileSync(join(scratch, "reminder-results.json"), JSON.stringify(rows, null, 2));
}
