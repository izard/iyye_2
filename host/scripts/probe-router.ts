// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-probe the llama.cpp router behaviour the host relies on (host/PINS.md).
 * Run it after every llama.cpp upgrade, before pointing the host at the new
 * build:
 *
 *   node scripts/probe-router.ts <llama-server> [--port 8189] [--tools gemma-4-E4B]
 *
 * It starts its own routers on a free port with an empty LLAMA_CACHE, uses two
 * small GGUFs plus a deliberately broken file, never touches ~/.iyye2 or any
 * running host, and stops everything it started. `--tools <registry model>`
 * also checks tool calling with that model from config/models.json.
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";
import { loadRegistry } from "../src/models/registry.ts";

const args = process.argv.slice(2);
const binary = args[0];
if (!binary) {
	console.error("usage: node scripts/probe-router.ts <llama-server> [--port N] [--tools <model>]");
	process.exit(2);
}
const opt = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(opt("--port") ?? 8189);
const toolsModel = opt("--tools");
const MODELS_DIR = `${process.env.HOME}/Downloads/llama.cpp/models`;
const SMALL_A = { name: "probe-a", file: `${MODELS_DIR}/MiniCPM5-2B-Q6_K_L.gguf` };
const SMALL_B = { name: "probe-b", file: `${MODELS_DIR}/qwen3.5-4b-tak-reasoning.gguf` };
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), "iyye-probe-"));
const results: Record<string, unknown> = {};
let router: ChildProcess | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function portBusy(p: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createConnection({ host: "127.0.0.1", port: p });
		s.once("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.once("error", () => resolve(false));
	});
}

async function req(method: string, path: string, body?: unknown, timeoutMs = 10_000) {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let json: unknown = text;
	try {
		json = JSON.parse(text);
	} catch {
		// keep text
	}
	return { status: res.status, json, type: res.headers.get("content-type") };
}

async function statuses(): Promise<Record<string, unknown>> {
	const r = await req("GET", "/models");
	const out: Record<string, unknown> = {};
	for (const m of (r.json as { data: { id: string; status: Record<string, unknown> }[] }).data) {
		const { args: _args, preset: _preset, ...rest } = m.status;
		out[m.id] = rest;
	}
	return out;
}

async function waitStatus(model: string, want: (s: Record<string, unknown>) => boolean, timeoutMs: number) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const s = (await statuses())[model] as Record<string, unknown> | undefined;
		if (s && want(s)) return { ms: Date.now() - t0, status: s };
		await sleep(250);
	}
	return { ms: Date.now() - t0, status: "timeout" };
}

async function startRouter(modelsMax: number, extra: { name: string; file: string; args?: string }[] = []) {
	const preset = join(dir, `models-${modelsMax}.ini`);
	const sections = [SMALL_A, SMALL_B, { name: "probe-bogus", file: join(dir, "bogus.gguf") }, ...extra].map(
		(m) =>
			`[${m.name}]\nmodel = ${m.file}\nc = 4096\nnp = 1\nstop-timeout = 5\n${"args" in m && m.args ? `${m.args}\n` : ""}`,
	);
	writeFileSync(preset, `version = 1\n\n${sections.join("\n")}`);
	router = spawn(
		binary!,
		[
			"--models-preset",
			preset,
			"--no-models-autoload",
			"--models-max",
			String(modelsMax),
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
		],
		{
			stdio: ["ignore", "ignore", "ignore"],
			env: { PATH: process.env.PATH, HOME: process.env.HOME, LLAMA_CACHE: join(dir, "cache") },
		},
	);
	for (let i = 0; i < 60; i++) {
		try {
			if ((await req("GET", "/health", undefined, 1000)).status === 200) return;
		} catch {
			// not up yet
		}
		await sleep(250);
	}
	throw new Error("router did not become healthy");
}

async function stopRouter(signal: NodeJS.Signals = "SIGTERM"): Promise<number[]> {
	if (!router?.pid) return [];
	const children = childPids(router.pid);
	const r = router;
	router = null;
	const exited = new Promise((resolve) => r.once("exit", resolve));
	r.kill(signal);
	await Promise.race([exited, sleep(40_000)]);
	await sleep(3000);
	return children.filter(alive);
}

function childPids(pid: number): number[] {
	try {
		return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(Number);
	} catch {
		return [];
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	if (await portBusy(port)) throw new Error(`port ${port} is in use; pick another with --port`);
	// A missing file never loads: every wait would run to its timeout (minutes, with no output).
	const missing = [SMALL_A, SMALL_B].map((m) => m.file).filter((f) => !existsSync(f));
	if (missing.length) throw new Error(`the probe needs these models: ${missing.join(", ")}`);
	writeFileSync(join(dir, "bogus.gguf"), Buffer.alloc(1_000_000, 7));
	// llama-server prints its version on stderr.
	const v = spawnSync(binary!, ["--version"], { encoding: "utf8" });
	results.version = `${v.stdout}${v.stderr}`.match(/version: .*/)?.[0] ?? "unknown";

	// Pass 1: --models-max 1 (does the router evict?)
	await startRouter(1);
	results.ids = Object.keys(await statuses());
	results.chatUnloaded = await req("POST", "/v1/chat/completions", {
		model: SMALL_A.name,
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 1,
	});
	results.loadAck = await req("POST", "/models/load", { model: SMALL_A.name });
	results.loadA = await waitStatus(SMALL_A.name, (s) => s.value === "loaded", 120_000);
	results.loadAgain = await req("POST", "/models/load", { model: SMALL_A.name });
	results.loadUnknown = await req("POST", "/models/load", { model: "no-such-model" });
	results.probeCompletion = await req("POST", "/v1/chat/completions", {
		model: SMALL_A.name,
		messages: [{ role: "user", content: "Reply OK." }],
		max_tokens: 1,
	});
	await req("POST", "/models/load", { model: SMALL_B.name });
	results.loadBAtMax1 = await waitStatus(SMALL_B.name, (s) => s.value === "loaded", 120_000);
	results.afterLoadBAtMax1 = await statuses();
	await req("POST", "/models/load", { model: "probe-bogus" });
	results.bogus = await waitStatus("probe-bogus", (s) => s.value === "unloaded" && s.failed === true, 60_000);
	results.afterBogusAtMax1 = await statuses();
	try {
		const ctrl = new AbortController();
		const res = await fetch(`${base}/models/sse`, { signal: ctrl.signal });
		results.sse = { status: res.status, type: res.headers.get("content-type") };
		ctrl.abort();
	} catch (err) {
		results.sse = { error: (err as Error).message };
	}
	const t0 = Date.now();
	results.unloadAck = await req("POST", "/models/unload", { model: SMALL_B.name });
	results.unload = {
		...(await waitStatus(SMALL_B.name, (s) => s.value === "unloaded", 60_000)),
		sinceAckMs: Date.now() - t0,
	};
	results.unloadAgain = await req("POST", "/models/unload", { model: SMALL_B.name });
	results.survivorsAfterSigterm = await stopRouter("SIGTERM");

	// Pass 2: --models-max 0 (no cap), then SIGKILL with models loaded
	await startRouter(0);
	for (const m of [SMALL_A, SMALL_B]) {
		await req("POST", "/models/load", { model: m.name });
		await waitStatus(m.name, (s) => s.value === "loaded", 120_000);
	}
	await req("POST", "/models/load", { model: "probe-bogus" });
	await waitStatus("probe-bogus", (s) => s.value === "unloaded" && s.failed === true, 60_000);
	results.afterBogusAtMax0 = await statuses();
	results.survivorsAfterSigkill = await stopRouter("SIGKILL");

	// Optional pass 3: tool calling with a registry model
	if (toolsModel) {
		const spec = loadRegistry(join(PROJECT_ROOT, "config/models.json")).models.find((m) => m.name === toolsModel);
		if (!spec?.available) throw new Error(`${toolsModel} is not an available registry model`);
		const extraArgs = Object.entries(spec.serverArgs)
			.map(([k, v]) => `${k} = ${v}`)
			.join("\n");
		await startRouter(0, [{ name: spec.name, file: spec.path, args: extraArgs }]);
		await req("POST", "/models/load", { model: spec.name });
		results.toolsModelLoad = await waitStatus(spec.name, (s) => s.value === "loaded", 300_000);
		const tool = (name: string, description: string) => ({
			type: "function",
			function: { name, description, parameters: { type: "object", properties: {}, additionalProperties: false } },
		});
		const r = await req(
			"POST",
			"/v1/chat/completions",
			{
				model: spec.name,
				messages: [{ role: "user", content: "What time is it, and how much free disk space is there?" }],
				tools: [tool("current_time", "Get the current local time."), tool("system_status", "Get free disk space.")],
				max_tokens: 512,
			},
			300_000,
		);
		const choice = (
			r.json as {
				choices?: {
					finish_reason: string;
					message: { tool_calls?: { function: { name: string; arguments: string } }[] };
				}[];
			}
		).choices?.[0];
		results.toolCalls = {
			finish: choice?.finish_reason,
			calls: choice?.message.tool_calls?.map((c) => `${c.function.name}(${c.function.arguments})`),
		};
		await stopRouter("SIGTERM");
	}
}

main()
	.catch((err) => {
		results.error = (err as Error).message;
		process.exitCode = 1;
	})
	.finally(async () => {
		await stopRouter("SIGTERM").catch(() => []);
		rmSync(dir, { recursive: true, force: true });
		console.log(JSON.stringify(results, null, 2));
	});
