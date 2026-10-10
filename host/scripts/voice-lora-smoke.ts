// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.009 CH0/CH6: the voice LoRA round trip on the DGX Spark, on
 * synthetic data only (`decision-worker/fixtures/voice-*.jsonl`):
 *
 * 1. the GGUF is the Hugging Face checkpoint it claims to be (`gguf_match.py`);
 * 2. a few training steps (`voice_train.py`, training venv): time, peak memory;
 * 3. the adapter converted to a GGUF LoRA (llama.cpp's `convert_lora_to_gguf.py`, converter venv);
 * 4. llama.cpp in **router mode** (its own preset and port, never the live
 *    router): the same GGUF without a LoRA and with it; per-request `lora`
 *    scales 0 and 1, greedy, against the plain model; whether a changed scale
 *    reuses the prompt cache;
 * 5. parity: greedy text from Hugging Face + peft against the GGUF LoRA on the
 *    quantized base (and both bases), as exact matches and shared prefixes.
 *
 *   node scripts/voice-lora-smoke.ts <scratch-dir> [--model minicpm5-2b] [--steps 20] [--port 8192]
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { findModel, loadRegistry } from "../src/models/registry.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		model: { type: "string", default: "minicpm5-2b" },
		steps: { type: "string", default: "20" },
		port: { type: "string", default: "8192" },
	},
});
const scratch = positionals[0];
if (!scratch) {
	console.error("usage: node scripts/voice-lora-smoke.ts <scratch-dir> [--model minicpm5-2b] [--steps 20]");
	process.exit(2);
}
mkdirSync(scratch, { recursive: true });
const config = loadConfig();
const spec = findModel(loadRegistry(config.modelsRegistry), values.model!);
if (!spec?.available) throw new Error(`${values.model}: not in the registry or its file is missing`);
const root = resolve(import.meta.dirname, "..", "..");
const worker = join(root, "decision-worker");
const trainPy = join(root, "kev-train", ".venv", "bin", "python");
const convertPy = join(root, "llama-convert", ".venv", "bin", "python");
const llamaCpp = resolve(config.llamaServer, "..", "..", "..");
const env = { IYYE2_STATE_DIR: config.stateDir, PATH: process.env.PATH ?? "/usr/bin:/bin" };
const run = (python: string, args: string[]) =>
	execFileSync(python, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] });
const provisioned = JSON.parse(readFileSync(join(config.stateDir, "voice", "provisioned.json"), "utf8")) as Record<
	string,
	{ path: string }
>;
const hf = provisioned[values.model!]?.path;
if (!hf) throw new Error(`${values.model} is not provisioned: decision-worker/voice_provision.py ${values.model}`);
const trainData = join(worker, "fixtures", "voice-train-fixture.jsonl");
const evalData = join(worker, "fixtures", "voice-eval-fixture.jsonl");
const report: Record<string, unknown> = { model: values.model, gguf: spec.path };

// 1. The GGUF is this checkpoint.
const match = JSON.parse(
	execFileSync(convertPy, [join(worker, "gguf_match.py"), "--gguf", spec.path, "--hf", hf], {
		encoding: "utf8",
		env,
	}),
) as { ok: boolean; tensors: Record<string, unknown> };
report.ggufMatch = match;
console.log(`GGUF vs Hugging Face: ${match.ok ? "same model" : "DIFFERENT"} ${JSON.stringify(match.tensors)}`);
if (!match.ok) process.exit(1);

// 2. Train.
const trained = JSON.parse(
	run(trainPy, [
		join(worker, "voice_train.py"),
		"--model",
		values.model!,
		"--data",
		trainData,
		"--steps",
		values.steps!,
		"--out-root",
		join(scratch, "candidates"),
		"--label",
		"voice smoke",
	])
		.trim()
		.split("\n")
		.at(-1)!,
) as { id: string; dir: string; resources: { wall_s: number; peak_cuda_bytes: number } };
const metrics = JSON.parse(readFileSync(join(trained.dir, "run", "training_metrics.json"), "utf8")) as {
	losses: number[];
	step_seconds: number[];
	load_s: number;
	trainable_params: number;
};
report.training = { ...trained.resources, ...metrics };
console.log(
	`trained ${values.steps} steps in ${trained.resources.wall_s} s (load ${metrics.load_s} s, step median ${[...metrics.step_seconds].sort()[Math.floor(metrics.step_seconds.length / 2)]} s), peak CUDA ${(trained.resources.peak_cuda_bytes / 2 ** 30).toFixed(1)} GB; loss ${metrics.losses[0]} → ${metrics.losses.at(-1)}`,
);

// 3. Convert.
const loraGguf = join(scratch, "voice-lora.gguf");
const t0 = Date.now();
execFileSync(
	convertPy,
	[
		join(llamaCpp, "convert_lora_to_gguf.py"),
		join(trained.dir, "run"),
		"--base",
		hf,
		"--outfile",
		loraGguf,
		"--outtype",
		"f16",
	],
	{ env: { ...env, HF_HUB_OFFLINE: "1" }, stdio: ["ignore", "ignore", "pipe"] },
);
report.convertS = (Date.now() - t0) / 1000;
console.log(`converted to ${loraGguf} in ${report.convertS} s`);

// 4. Router mode.
const port = Number(values.port);
const base = `http://127.0.0.1:${port}`;
const preset = join(scratch, "preset.ini");
writeFileSync(
	preset,
	[
		"version = 1",
		"",
		"[*]",
		"c = 8192",
		"np = 1",
		"",
		"[voice-base]",
		`model = ${spec.path}`,
		"",
		"[voice-lora]",
		`model = ${spec.path}`,
		`lora = ${loraGguf}`,
		"",
	].join("\n"),
);
const router: ChildProcess = spawn(
	config.llamaServer,
	[
		"--models-preset",
		preset,
		"--no-models-autoload",
		"--models-max",
		"2",
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		...(process.platform === "linux" ? ["--load-mode", "none"] : []),
	],
	{ stdio: ["ignore", "ignore", "pipe"] },
);
let routerLog = "";
router.stderr!.on("data", (d: Buffer) => {
	routerLog = (routerLog + d.toString()).slice(-6000);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
	return JSON.parse(text) as Record<string, unknown>;
}
type Rows = { input: string; system: string }[];
const evalRows = readFileSync(evalData, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l) as { input: string; system: string }) as Rows;
const user = (input: string) => `Rewrite this message in Iyye's voice:\n<<<\n${input}\n>>>`;
async function greedy(model: string, row: Rows[number], lora?: { id: number; scale: number }[]) {
	const r = (await post("/v1/chat/completions", {
		model,
		messages: [
			{ role: "system", content: row.system },
			{ role: "user", content: user(row.input) },
		],
		temperature: 0,
		top_k: 1,
		seed: 1,
		repeat_penalty: 1.0,
		max_tokens: 200,
		chat_template_kwargs: { enable_thinking: false },
		...(lora ? { lora } : {}),
	})) as { choices: { message: { content: string } }[]; timings?: { prompt_n?: number; cache_n?: number } };
	return {
		text: r.choices[0]!.message.content.trim(),
		promptN: r.timings?.prompt_n ?? null,
		cacheN: r.timings?.cache_n ?? null,
	};
}
try {
	for (let i = 0; ; i++) {
		try {
			if ((await fetch(`${base}/health`)).ok) break;
		} catch {}
		if (i > 120) throw new Error(`router not ready\n${routerLog}`);
		await sleep(500);
	}
	for (const m of ["voice-base", "voice-lora"]) {
		await post("/models/load", { model: m });
		for (let i = 0; ; i++) {
			const list = (await (await fetch(`${base}/models`)).json()) as {
				data: { id: string; status?: { value?: string } }[];
			};
			if (list.data.find((x) => x.id === m)?.status?.value === "loaded") break;
			if (i > 240) throw new Error(`${m} did not load\n${routerLog}`);
			await sleep(500);
		}
	}
	const rows: Record<string, unknown>[] = [];
	for (const row of evalRows) {
		// The noise floor first: the same request twice, each after a request with another prompt or scale.
		const plain = await greedy("voice-base", row);
		const dflt = await greedy("voice-lora", row);
		const zero = await greedy("voice-lora", row, [{ id: 0, scale: 0 }]);
		const one = await greedy("voice-lora", row, [{ id: 0, scale: 1 }]);
		const again = await greedy("voice-lora", row, [{ id: 0, scale: 1 }]);
		const zero2 = await greedy("voice-lora", row, [{ id: 0, scale: 0 }]);
		const plain2 = await greedy("voice-base", { ...row, system: `${row.system} ` });
		const plain3 = await greedy("voice-base", row);
		rows.push({ input: row.input, plain, dflt, zero, one, again, zero2, plain2, plain3 });
	}
	const n = rows.length;
	const t = (r: Record<string, unknown>, k: string) => (r[k] as { text: string }).text;
	report.router = {
		n,
		scale0EqualsPlain: rows.filter((r) => t(r, "zero") === t(r, "plain")).length,
		scale1DiffersFromPlain: rows.filter((r) => t(r, "one") !== t(r, "plain")).length,
		noFieldEqualsScale1: rows.filter((r) => t(r, "dflt") === t(r, "one")).length,
		repeatEqual: rows.filter((r) => t(r, "again") === t(r, "one")).length,
		// Full re-evaluation each time (another scale, or another prompt in between): the noise of a full prefill.
		scale0RepeatEqual: rows.filter((r) => t(r, "zero2") === t(r, "zero")).length,
		plainRepeatEqualFullPrefill: rows.filter((r) => t(r, "plain3") === t(r, "plain")).length,
		// Prompt tokens evaluated for the same prompt right after a request with another scale (cache reuse).
		promptNAfterScaleChange: rows.map((r) => (r.one as { promptN: number | null }).promptN),
		promptNSameScaleAgain: rows.map((r) => (r.again as { promptN: number | null }).promptN),
	};
	writeFileSync(join(scratch, "router-rows.json"), `${JSON.stringify(rows, null, 1)}\n`);
	console.log(`router: ${JSON.stringify(report.router)}`);

	// 5. Parity with Hugging Face (+ peft).
	const hfOut = (name: string, adapter?: string) => {
		const out = join(scratch, `${name}.json`);
		run(trainPy, [
			join(worker, "voice_generate.py"),
			"--model",
			values.model!,
			"--data",
			evalData,
			"--out",
			out,
			...(adapter ? ["--adapter", adapter] : []),
		]);
		return (JSON.parse(readFileSync(out, "utf8")) as { rows: { text: string }[] }).rows.map((r) => r.text);
	};
	const hfBase = hfOut("hf-base");
	const hfLora = hfOut("hf-lora", trained.dir);
	const prefix = (a: string, b: string) => {
		let i = 0;
		while (i < a.length && i < b.length && a[i] === b[i]) i++;
		return i / Math.max(1, Math.max(a.length, b.length));
	};
	const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
	const compare = (a: string[], b: string[]) => ({
		exact: a.filter((x, i) => x === b[i]).length,
		sharedPrefixMedian: Math.round(median(a.map((x, i) => prefix(x, b[i]!))) * 100) / 100,
	});
	report.parity = {
		base: compare(
			hfBase,
			rows.map((r) => t(r, "plain")),
		),
		lora: compare(
			hfLora,
			rows.map((r) => t(r, "one")),
		),
		loraMovedHf: hfLora.filter((x, i) => x !== hfBase[i]).length,
	};
	console.log(`parity (Hugging Face bf16 vs llama.cpp on the quantized GGUF): ${JSON.stringify(report.parity)}`);
} finally {
	router.kill("SIGTERM");
	await new Promise((r) => (router.exitCode !== null ? r(null) : router.once("exit", r)));
	writeFileSync(join(scratch, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
