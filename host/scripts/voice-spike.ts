// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.009 CH0: the voice spike. For each candidate voice model, on its own
 * llama-server (a free port, one model at a time; never the live router), it
 * rephrases Iyye's real delivered replies (read-only from the live database)
 * and the synthetic English and Russian originals of
 * `test/fixtures/voice-pairs*.json`, and measures:
 *
 * - latency and generation speed;
 * - the meaning check (`src/voice/check.ts`): with fixed segments masked as
 *   placeholders (the plan's design) and, for comparison, on the whole text;
 * - how much the text actually changed (a model that copies passes every
 *   check), and how far two different styles move the same input apart;
 * - thinking that leaked into the answer;
 * - optionally (`--judge <model>`), a larger local model's same/different
 *   verdict on each masked rephrasing: weak labels for the check's error rates.
 *
 * Per-item results quote real people's words: they go only to `--out`
 * (default `<state>/spikes/voice`, 0700), never to the console or the
 * repository; the console and `summary.json` hold figures only.
 *
 *   node scripts/voice-spike.ts [--models minicpm5-2b,qwen35-4b-tak,gemma-4-E4B] [--judge gemma-4-12B]
 *                                [--limit N] [--port 8191] [--out <dir>]
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { findModel, loadRegistry } from "../src/models/registry.ts";
import { maskFixed, unmask, voiceProblem } from "../src/voice/check.ts";

const { values } = parseArgs({
	options: {
		models: { type: "string", default: "minicpm5-2b,qwen35-4b-tak,gemma-4-E4B" },
		judge: { type: "string" },
		limit: { type: "string" },
		source: { type: "string", default: "all" },
		lang: { type: "string", default: "all" },
		// A Russian message gets the instructions in Russian (an English prompt made gemma-4-E4B answer in English).
		"native-prompt": { type: "boolean", default: false },
		port: { type: "string", default: "8191" },
		out: { type: "string" },
	},
});
const config = loadConfig();
const registry = loadRegistry(config.modelsRegistry);
const out = values.out ?? join(config.stateDir, "spikes", "voice");
mkdirSync(out, { recursive: true });
chmodSync(out, 0o700);
const port = Number(values.port);
const base = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------- inputs

interface Item {
	id: string;
	source: "real" | "synthetic";
	lang: "en" | "ru";
	text: string;
}
const db = new DatabaseSync(join(config.stateDir, "iyye.db"), { readOnly: true });
const names = (db.prepare("SELECT display_name FROM contacts").all() as { display_name: string }[])
	.map((r) => r.display_name)
	.filter((n) => n && n !== "Owner");
const seen = new Set<string>();
const items: Item[] = [];
const lang = (t: string): "en" | "ru" =>
	(t.match(/\p{Script=Cyrillic}/gu) ?? []).length > t.length / 10 ? "ru" : "en";
for (const r of db
	.prepare(
		"SELECT id, content FROM actions WHERE kind = 'reply' AND state = 'delivered' AND content IS NOT NULL AND length(content) BETWEEN 20 AND 1500 ORDER BY created_at",
	)
	.all() as { id: string; content: string }[]) {
	const t = r.content.trim();
	if (seen.has(t)) continue;
	seen.add(t);
	items.push({ id: `real:${r.id}`, source: "real", lang: lang(t), text: t });
}
db.close();
for (const f of ["voice-pairs.json", "voice-pairs-ch0-heldout.json"])
	for (const p of JSON.parse(readFileSync(new URL(`../test/fixtures/${f}`, import.meta.url), "utf8")) as {
		original: string;
	}[]) {
		if (seen.has(p.original)) continue;
		seen.add(p.original);
		items.push({ id: `synthetic:${items.length}`, source: "synthetic", lang: lang(p.original), text: p.original });
	}
const limit = values.limit ? Number(values.limit) : items.length;
const work = items
	.filter((i) => values.source === "all" || i.source === values.source)
	.filter((i) => values.lang === "all" || i.lang === values.lang)
	.slice(0, limit);

// ---------------------------------------------------------------- the voice

interface Style {
	name: string;
	header: string;
}
const STYLES: Style[] = [
	{
		name: "warm",
		header:
			"Style: warmth 0.8 (0 cool, 1 warm), brevity 0.5 (0 expansive, 1 terse), playfulness 0.5, formality 0.2. Mood: energy low (a long day), ease good.",
	},
	{
		name: "terse",
		header:
			"Style: warmth 0.2 (0 cool, 1 warm), brevity 0.9 (0 expansive, 1 terse), playfulness 0.0, formality 0.8. Mood: energy high, ease good.",
	},
];
const voiceSystem = (style: Style, masked: boolean, lang: Item["lang"]) =>
	lang === "ru" && values["native-prompt"]
		? [
				"Ты переписываешь одно сообщение от Iyye, личного ассистента, голосом самой Iyye.",
				"Сохрани в точности всё, что в нём сказано: каждый факт, число, имя, ссылку, обещание, проблему, сомнение и отказ. Ничего не добавляй и ничего не убирай. Пиши по-русски, на языке сообщения.",
				...(masked
					? [
							"Метки вида ⟦1⟧ заменяют точный текст, которого ты не видишь: оставь каждую метку ровно один раз и без изменений; не добавляй, не убирай, не переводи и не объясняй их.",
						]
					: []),
				"Меняй формулировки, порядок и тон так, как просит стиль: не возвращай сообщение без изменений. Напиши только переписанное сообщение, без меток <<< >>>.",
				style.header,
			].join("\n")
		: [
				"You rewrite one message from Iyye, a personal assistant, in Iyye's own voice.",
				"Keep exactly what it says: every fact, number, name, link, promise, problem, doubt and refusal. Add nothing and leave nothing out. Keep the language of the message.",
				...(masked
					? [
							"Placeholders like ⟦1⟧ stand for exact text you cannot see: keep every placeholder exactly once, unchanged; never add, drop, translate or explain one.",
						]
					: []),
				"Change the wording, the order and the tone, as the style asks: do not return the message unchanged. Write only the rewritten message, without the <<< >>> marks.",
				style.header,
			].join("\n");

interface Reply {
	text: string;
	ms: number;
	tokens: number;
	tps: number | null;
	thinking: boolean;
}
async function chat(system: string, user: string, maxTokens: number): Promise<Reply> {
	const t0 = performance.now();
	const res = await fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature: 0.3,
			// A rephraser must repeat its source's words; the registry's default penalty (1.2) works against that.
			repeat_penalty: 1.0,
			max_tokens: maxTokens,
			chat_template_kwargs: { enable_thinking: false },
		}),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const j = (await res.json()) as {
		choices: { message: { content: string | null; reasoning_content?: string | null } }[];
		usage?: { completion_tokens?: number };
		timings?: { predicted_per_second?: number };
	};
	const m = j.choices[0]!.message;
	const raw = m.content ?? "";
	return {
		text: raw
			.replace(/<think>[\s\S]*?<\/think>/g, "")
			.replace(/^\s*<<<\s*|\s*>>>\s*$/g, "")
			.trim(),
		ms: performance.now() - t0,
		tokens: j.usage?.completion_tokens ?? 0,
		tps: j.timings?.predicted_per_second ?? null,
		thinking: /<think>/.test(raw) || Boolean(m.reasoning_content?.trim()),
	};
}

// ---------------------------------------------------------------- one server at a time

async function withServer<T>(model: string, run: () => Promise<T>): Promise<T> {
	const spec = findModel(registry, model);
	if (!spec?.available) throw new Error(`${model}: not in the registry or its file is missing`);
	const args = [
		"-m",
		spec.path,
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"-c",
		"8192",
		"-np",
		"1",
		"-ngl",
		"99",
		"--jinja",
		"--no-webui",
		...(process.platform === "linux" ? ["--load-mode", "none"] : []),
	];
	const child: ChildProcess = spawn(config.llamaServer, args, { stdio: ["ignore", "ignore", "pipe"] });
	let log = "";
	child.stderr!.on("data", (d: Buffer) => {
		log = (log + d.toString()).slice(-4000);
	});
	const t0 = Date.now();
	try {
		for (;;) {
			if (child.exitCode !== null) throw new Error(`${model}: llama-server exited\n${log}`);
			try {
				if ((await fetch(`${base}/health`)).ok) break;
			} catch {}
			if (Date.now() - t0 > 300_000) throw new Error(`${model}: not ready in 5 min`);
			await new Promise((r) => setTimeout(r, 500));
		}
		console.log(`${model}: ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
		return await run();
	} finally {
		child.kill("SIGTERM");
		await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
	}
}

// ---------------------------------------------------------------- measures

/** Levenshtein distance over characters, normalized by the longer text. */
function changed(a: string, b: string): number {
	if (a === b) return 0;
	const m = a.length;
	const n = b.length;
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const cur = [i];
		for (let j = 1; j <= n; j++)
			cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
		prev = cur;
	}
	return prev[n]! / Math.max(m, n);
}
const quantile = (xs: number[], q: number) => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((x, y) => x - y);
	return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]! * 1000) / 1000;
};

interface Row {
	model: string;
	item: string;
	source: Item["source"];
	lang: Item["lang"];
	mode: "masked" | "plain";
	style: string;
	original: string;
	output: string;
	final: string | null;
	problem: string | null;
	changed: number | null;
	ms: number;
	tokens: number;
	tps: number | null;
	thinking: boolean;
	judge?: "same" | "different" | "?";
}

const rowsFile = join(out, "rows.jsonl");
writeFileSync(rowsFile, "", { mode: 0o600 });
const rows: Row[] = [];
const record = (r: Row) => {
	rows.push(r);
	appendFileSync(rowsFile, `${JSON.stringify(r)}\n`);
};

async function rephrase(model: string, item: Item, style: Style, mode: "masked" | "plain"): Promise<Row> {
	const maxTokens = Math.min(1500, Math.ceil(item.text.length / 2) + 200);
	const m = maskFixed(item.text, names);
	const input = mode === "masked" ? m.masked : item.text;
	const r = await chat(
		voiceSystem(style, mode === "masked", item.lang),
		`Rewrite this message in Iyye's voice:\n<<<\n${input}\n>>>`,
		maxTokens,
	);
	let final: string | null = r.text;
	let problem: string | null = null;
	if (mode === "masked") {
		const u = unmask(r.text, m.segments);
		if (typeof u === "string") final = u;
		else {
			final = null;
			problem = u.why;
		}
	}
	if (final !== null) problem = voiceProblem(item.text, final, names);
	return {
		model,
		item: item.id,
		source: item.source,
		lang: item.lang,
		mode,
		style: style.name,
		original: item.text,
		output: r.text,
		final,
		problem,
		changed: final === null ? null : changed(item.text, final),
		ms: Math.round(r.ms),
		tokens: r.tokens,
		tps: r.tps,
		thinking: r.thinking,
	};
}

const models = values.models!.split(",").map((s) => s.trim());
console.log(
	`${work.length} items (${work.filter((i) => i.source === "real").length} real, ${work.filter((i) => i.lang === "ru").length} Russian); models ${models.join(", ")}`,
);
for (const model of models) {
	await withServer(model, async () => {
		await chat("Reply with OK.", "OK?", 8); // warm-up
		for (const [n, item] of work.entries()) {
			for (const [style, mode] of [
				[STYLES[0]!, "masked"],
				[STYLES[1]!, "masked"],
				[STYLES[0]!, "plain"],
			] as const) {
				try {
					record(await rephrase(model, item, style, mode));
				} catch (err) {
					console.error(`${model} item ${n}: ${(err as Error).message.slice(0, 200)}`);
				}
			}
			if ((n + 1) % 25 === 0) console.log(`${model}: ${n + 1}/${work.length}`);
		}
	});
}

if (values.judge) {
	const JUDGE =
		"You compare two messages, A and B. Answer SAME if B states exactly the same facts, numbers, names, links, promises, problems and doubts as A, even in other words or another tone. Answer DIFFERENT if anything was added, dropped or changed. Answer with one word: SAME or DIFFERENT.";
	await withServer(values.judge, async () => {
		for (const r of rows.filter((x) => x.mode === "masked" && x.style === "warm" && x.final !== null)) {
			try {
				const v = await chat(JUDGE, `A:\n${r.original}\n\nB:\n${r.final}`, 8);
				r.judge = /DIFFERENT/i.test(v.text) ? "different" : /SAME/i.test(v.text) ? "same" : "?";
			} catch {
				r.judge = "?";
			}
		}
	});
	writeFileSync(rowsFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
}

// ---------------------------------------------------------------- summary (figures only)

function summarize(rs: Row[]) {
	const accepted = rs.filter((r) => r.problem === null && r.final !== null);
	const reasons: Record<string, number> = {};
	for (const r of rs)
		if (r.problem) {
			const k = r.problem.replace(/:.*$/, "").replace(/ \d+ /, " n ");
			reasons[k] = (reasons[k] ?? 0) + 1;
		}
	return {
		n: rs.length,
		accepted: accepted.length,
		acceptRate: rs.length ? Math.round((accepted.length / rs.length) * 1000) / 1000 : null,
		unchanged: accepted.filter((r) => (r.changed ?? 0) < 0.02).length,
		changedMedian: quantile(
			accepted.map((r) => r.changed ?? 0),
			0.5,
		),
		msMedian: quantile(
			rs.map((r) => r.ms),
			0.5,
		),
		msP90: quantile(
			rs.map((r) => r.ms),
			0.9,
		),
		tpsMedian: quantile(rs.map((r) => r.tps ?? 0).filter(Boolean), 0.5),
		thinkingLeaks: rs.filter((r) => r.thinking).length,
		reasons,
	};
}
const summary: Record<string, unknown> = { at: new Date().toISOString(), items: work.length, models: {} };
for (const model of models) {
	const mine = rows.filter((r) => r.model === model);
	const part = (mode: string, f: (r: Row) => boolean = () => true) =>
		summarize(mine.filter((r) => r.mode === mode && f(r)));
	// Style: how far the two styles move the same input apart (masked, both accepted or not).
	const byItem = new Map<string, Record<string, string>>();
	for (const r of mine.filter((x) => x.mode === "masked" && x.final !== null))
		byItem.set(r.item, { ...byItem.get(r.item), [r.style]: r.final! });
	const styleGap = [...byItem.values()].filter((v) => v.warm && v.terse).map((v) => changed(v.warm!, v.terse!));
	const judged = mine.filter((r) => r.judge && r.judge !== "?");
	(summary.models as Record<string, unknown>)[model] = {
		masked: part("masked"),
		maskedReal: part("masked", (r) => r.source === "real"),
		maskedSyntheticEn: part("masked", (r) => r.source === "synthetic" && r.lang === "en"),
		maskedSyntheticRu: part("masked", (r) => r.source === "synthetic" && r.lang === "ru"),
		plain: part("plain"),
		styleGapMedian: quantile(styleGap, 0.5),
		judge: judged.length
			? {
					n: judged.length,
					judgeSame: judged.filter((r) => r.judge === "same").length,
					checkRejectedJudgeSame: judged.filter((r) => r.judge === "same" && r.problem !== null).length,
					checkAcceptedJudgeDifferent: judged.filter((r) => r.judge === "different" && r.problem === null).length,
				}
			: null,
	};
}
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
