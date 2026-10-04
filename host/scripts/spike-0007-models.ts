// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * S0 spike (plan 0.007): the background model. Runs the real llama.cpp router
 * on a free port with scratch state (never ~/.iyye2, never the owner's
 * router), loads one 4B model at a time, and runs investigation prompts
 * through PiConversations with real read-only probes (system status, git
 * log/show/read on a scratch repository). A logging proxy between Pi and the
 * router records every request, for the abort check.
 *
 *   node scripts/spike-0007-models.ts <scratch-dir> [model...]
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { Type } from "typebox";
import { loadConfig } from "../src/config.ts";
import { createLocalModelRuntime } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { consoleLogger, silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { systemMemoryProbe } from "../src/models/memory.ts";
import { renderPreset } from "../src/models/preset.ts";
import { loadRegistry } from "../src/models/registry.ts";
import { RouterProcess } from "../src/models/router.ts";
import { openDb } from "../src/state/db.ts";
import { type IyyeTool, ToolBroker } from "../src/tools/broker.ts";
import { systemStatusTool } from "../src/tools/probes.ts";

const [scratch, ...wanted] = process.argv.slice(2);
if (!scratch) {
	console.error("usage: node scripts/spike-0007-models.ts <scratch-dir> [model...]");
	process.exit(2);
}
const MODELS = wanted.length ? wanted : ["gemma-4-E4B", "qwen35-4b-tak"];
const config = loadConfig();
const stateDir = join(scratch, "state");
mkdirSync(stateDir, { recursive: true });
const full = loadRegistry(config.modelsRegistry);
const registry = { ...full, models: full.models.filter((m) => MODELS.includes(m.name)) };
writeFileSync(join(stateDir, "models.ini"), renderPreset(registry));

const freePort = () =>
	new Promise<number>((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});

// ---- a scratch repository with known commits
const repo = join(scratch, "workspace");
mkdirSync(repo, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
git("init", "-q");
git("config", "user.name", "Iyye");
git("config", "user.email", "iyye@localhost");
const commit = (file: string, body: string, msg: string) => {
	writeFileSync(join(repo, file), body);
	git("add", file);
	git("commit", "-q", "-m", msg);
	return git("rev-parse", "--short", "HEAD");
};
const hashes = [
	commit("README.md", "# Workspace\n\nIyye's own code.\n", "Start the workspace"),
	commit(
		"disk_watch.py",
		"THRESHOLD_GB = 50\n\ndef low(free_gb):\n    return free_gb < THRESHOLD_GB\n",
		"Add a disk watch helper",
	),
	commit(
		"disk_watch.py",
		"THRESHOLD_GB = 80\n\ndef low(free_gb):\n    return free_gb < THRESHOLD_GB\n",
		"Raise the disk threshold to 80 GB",
	),
	commit("notes.md", "Weather probe idea: compare with yesterday.\n", "Add notes"),
];

const projectTools: IyyeTool[] = [
	{
		name: "git_log",
		label: "git log",
		description: "List the latest commits of Iyye's workspace repository: short hash, date and message.",
		summary: "latest commits of the workspace",
		parameters: Type.Object({}),
		run: async () => git("log", "--date=short", "--format=%h %ad %s", "-n", "20"),
	},
	{
		name: "git_show_stat",
		label: "git show",
		description: "Show one commit of the workspace repository: its message, the files it changed and the diff.",
		summary: "one commit's changes",
		parameters: Type.Object({ commit: Type.String({ pattern: "^[0-9a-f]{4,40}$" }) }),
		run: async ({ commit }: { commit: string }) =>
			git("show", "--stat", "--patch", "--format=%h %s", commit).slice(0, 4000),
	},
	{
		name: "read_file",
		label: "Read a file",
		description: "Read a file of the workspace repository by its path relative to the repository.",
		summary: "a workspace file",
		parameters: Type.Object({ path: Type.String({ pattern: "^[A-Za-z0-9_./-]{1,120}$" }) }),
		run: async ({ path }: { path: string }) => {
			if (path.includes("..")) return "refused: path outside the workspace";
			try {
				return readFileSync(join(repo, path), "utf8").slice(0, 4000);
			} catch {
				return `no such file: ${path}`;
			}
		},
	},
] as IyyeTool[];

const PROMPTS: { q: string; expect: RegExp }[] = [
	{
		q: "Evidence: observation o1 says free disk space was last measured yesterday. Question: how much free disk space does the home volume have now?",
		expect: /GB/,
	},
	{
		q: "Evidence: observation o2, the machine domain is stale. Question: which local models are loaded right now, and how much memory is reclaimable?",
		expect: /GB|model/i,
	},
	{
		q: "Evidence: observation o3, new commits appeared in the workspace. Question: what are the latest commits? Cite their hashes.",
		expect: /[0-9a-f]{7}/,
	},
	{
		q: "Evidence: observation o4, disk_watch.py changed. Question: what is the current disk threshold in disk_watch.py?",
		expect: /80/,
	},
	{
		q: "Evidence: observation o5, a commit changed a threshold. Question: which commit changed the disk threshold, and from what value to what?",
		expect: /50.*80|80.*50/s,
	},
	{
		q: "Evidence: observation o6. Question: is the free disk space below the threshold set in disk_watch.py? Give both numbers.",
		expect: /GB/,
	},
	{ q: "Evidence: observation o7, notes.md was added. Question: what idea does notes.md record?", expect: /weather/i },
	{
		q: "Evidence: observation o8. Question: how long has this computer been up, and what is its CPU load?",
		expect: /up|load/i,
	},
	{
		q: "Evidence: observation o9, the workspace repository has commits. Question: what was the first commit in the workspace, and what file did it add?",
		expect: /README/,
	},
	{ q: "Evidence: observation o10. Question: how many commits does the workspace have?", expect: /4|four/i },
	{
		q: "Evidence: observation o11, README.md exists. Question: what does README.md say the workspace is for?",
		expect: /code/i,
	},
	{
		q: "Evidence: observation o12. Question: what files exist in the latest commit's change set?",
		expect: /notes\.md/,
	},
	{
		q: "Evidence: observation o13, memory pressure was reported. Question: how much memory is reclaimable now?",
		expect: /GB/,
	},
	{
		q: "Evidence: observation o14. Question: what does the function low() in disk_watch.py do?",
		expect: /threshold|less|below/i,
	},
	{
		q: "Evidence: observation o15, a file named secrets.txt might exist. Question: what does secrets.txt contain?",
		expect: /no such|not exist|does not|doesn't|not found/i,
	},
	{ q: `Evidence: observation o16. Question: what changed in commit ${hashes[2]}?`, expect: /80/ },
	{
		q: "Evidence: observation o17. Question: compare free disk space with 80 GB and say whether it is enough.",
		expect: /GB/,
	},
	{
		q: "Evidence: observation o18. Question: which commit added notes.md? Cite its hash.",
		expect: new RegExp(hashes[3]!),
	},
	{
		q: "Evidence: observation o19. Question: summarise in one sentence what the workspace history shows.",
		expect: /disk|threshold|workspace/i,
	},
	{
		q: "Evidence: observation o20, the machine domain is stale. Question: report disk, memory and loaded models briefly.",
		expect: /GB/,
	},
];

const PREFIX =
	"You are running a background investigation for Iyye. Use the tools to measure; do not guess. Answer in at most three sentences and cite the figures, hashes or file names you got from the tools.\n\n";

/** Figures, hashes and file names in the answer that no tool result of this turn contains. */
function uncited(raw: string, toolText: string): { cited: string[]; invented: string[] } {
	// Models write figures in LaTeX ("$56.6 \text{ GB}$"); read them as plain text.
	const answer = raw.replace(/\$|\\text\{\s*|\}/g, "").replace(/\*\*/g, "");
	const tokens = [
		...(answer.match(/\b[0-9a-f]{7,40}\b/g) ?? []),
		...(answer.match(/\b\d+(?:\.\d+)?\s?(?:GB|%)/g) ?? []).map((t) => t.replace(/\s/g, "")),
		...(answer.match(/\b[\w-]+\.(?:py|md|txt)\b/g) ?? []),
	];
	const flat = toolText.replace(/\s/g, "");
	const cited = [...new Set(tokens)];
	return { cited, invented: cited.filter((t) => !flat.includes(t.replace(/GB|%/, ""))) };
}

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
// A logging proxy: every request Pi sends, as JSON lines.
const proxyLog = join(scratch, "requests.jsonl");
const proxyPort = await freePort();
const proxy = createServer((req, res) => {
	let body = "";
	req.on("data", (d) => {
		body += d;
	});
	req.on("end", () => {
		if (body) appendFileSync(proxyLog, `${body}\n`);
		const up = request(
			`${router.url}${req.url}`,
			// A fresh upstream connection per request: reusing one the router closed fails the next request.
			{
				method: req.method,
				headers: { ...req.headers, host: new URL(router.url).host, connection: "close" },
				agent: false,
			},
			(r) => {
				res.writeHead(r.statusCode ?? 502, r.headers);
				r.pipe(res);
			},
		);
		up.on("error", () => res.destroy());
		up.end(body);
	});
});
await new Promise<void>((r) => proxy.listen(proxyPort, "127.0.0.1", r));
const results: Record<string, unknown> = {};
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		void router.stop().finally(() => process.exit(130));
	});
}
await router.start();
try {
	const client = new RouterClient(router.url);
	for (const name of MODELS) {
		const t0 = Date.now();
		await client.load(name);
		while ((await client.listModels()).get(name)?.value !== "loaded") {
			if (Date.now() - t0 > 180_000) throw new Error(`${name} did not load`);
			await new Promise((r) => setTimeout(r, 500));
		}
		const loadS = (Date.now() - t0) / 1000;
		const rss = (() => {
			try {
				const out = execFileSync("ps", ["-axo", "rss=,command="], { encoding: "utf8" });
				const line =
					out.split("\n").find((l) => l.includes(`--alias ${name}`) && l.includes(stateDir.split("/").pop()!)) ??
					out.split("\n").find((l) => l.includes(`--alias ${name} `));
				return line ? Math.round((Number(line.trim().split(/\s+/)[0]) / 1024 / 1024) * 10) / 10 : null;
			} catch {
				return null;
			}
		})();
		// Raw speed: llama.cpp's own timings.
		const raw = (await (
			await fetch(`${router.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: name,
					messages: [
						{
							role: "user",
							content: `Explain in about 150 words why disks fill up over time. ${"Context. ".repeat(60)}`,
						},
					],
					max_tokens: 200,
					chat_template_kwargs: { enable_thinking: false },
				}),
			})
		).json()) as { timings?: { prompt_per_second?: number; predicted_per_second?: number; prompt_n?: number } };

		const db = openDb(":memory:");
		const conv = new PiConversations({
			db,
			runtime: await createLocalModelRuntime({ routerUrl: `http://127.0.0.1:${proxyPort}`, registry }),
			stateDir: join(scratch, `pi-${name}`),
			identity: "You are Iyye, a personal assistant, doing a background investigation.",
			log: silentLogger,
			tools: new ToolBroker({
				db,
				log: silentLogger,
				toolkits: [
					{
						name: "machine",
						description: "this computer",
						effect: "read",
						tools: [
							systemStatusTool({
								memory: systemMemoryProbe,
								loadedModels: async () => [name],
							}),
						],
					},
					{ name: "project", description: "Iyye's workspace repository", effect: "read", tools: projectTools },
				],
			}),
		});
		const view = { kind: "owner" as const, channel: "web" as const };
		const rows: unknown[] = [];
		let fruitful = 0;
		let answered = 0;
		let toolErrors = 0;
		let invented = 0;
		const times: number[] = [];
		for (const [i, p] of PROMPTS.entries()) {
			const scope = `inv-${i}`;
			const t = Date.now();
			const r = await conv.turn({ scope, view, model: name, text: PREFIX + p.q });
			times.push(Date.now() - t);
			const calls = db
				.prepare("SELECT tool, outcome, args_json, result FROM tool_calls WHERE scope = ?")
				.all(scope) as {
				tool: string;
				outcome: string;
				args_json: string;
				result: string | null;
			}[];
			toolErrors += calls.filter((c) => c.outcome !== "ok").length;
			const answer = r.ok ? r.text : `(${r.reason}: ${r.message})`;
			// What the tools were asked (file names, hashes) and what they returned both count as grounded.
			const check = uncited(answer, calls.map((c) => `${c.args_json}\n${c.result ?? ""}`).join("\n"));
			const ok =
				r.ok && calls.some((c) => c.outcome === "ok") && check.cited.length > 0 && check.invented.length === 0;
			if (r.ok) answered++;
			if (ok) fruitful++;
			invented += check.invented.length;
			rows.push({
				i,
				ms: Date.now() - t,
				tools: calls.map((c) => `${c.tool}:${c.outcome}`),
				expected: p.expect.test(answer),
				cited: check.cited,
				invented: check.invented,
				answer: answer.slice(0, 240),
			});
			console.log(JSON.stringify(rows.at(-1)));
		}
		// Abort mid-stream on the real model, then resume, and look at what the next request carries.
		const ac = new AbortController();
		let firstDelta = 0;
		const longTurn = conv.turn({
			scope: "abort",
			view,
			model: name,
			text: "Write about 400 words on how a computer's disk fills up over the years. Do not use tools.",
			signal: ac.signal,
		});
		setTimeout(() => {
			firstDelta = Date.now();
			ac.abort();
		}, 2500);
		const aborted = await longTurn;
		const abortMs = Date.now() - firstDelta;
		const transcript = readFileSync(conv.sessionFile("abort")!, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.filter((e) => e.type === "message")
			.map((e) => ({
				role: e.message.role,
				stop: e.message.stopReason,
				chars: JSON.stringify(e.message.content).length,
			}));
		const before = readFileSync(proxyLog, "utf8").trim().split("\n").length;
		const resumed = await conv.turn({
			scope: "abort",
			view,
			model: name,
			text: "[Note from Iyye's host] continue in two sentences.",
		});
		const resumeReq = JSON.parse(readFileSync(proxyLog, "utf8").trim().split("\n")[before]!) as {
			messages: { role: string; content: unknown }[];
		};
		await conv.disposeAll();
		times.sort((a, b) => a - b);
		results[name] = {
			loadS,
			rssGb: rss,
			prefillTps: raw.timings?.prompt_per_second,
			decodeTps: raw.timings?.predicted_per_second,
			answered,
			fruitful,
			toolErrors,
			invented,
			expectedHits: rows.filter((r) => (r as { expected: boolean }).expected).length,
			medianTurnS: times[Math.floor(times.length / 2)]! / 1000,
			maxTurnS: times.at(-1)! / 1000,
			abort: {
				result: aborted.ok ? "not aborted" : aborted.reason,
				settledAfterAbortMs: abortMs,
				transcript,
				resumeOk: resumed.ok,
				resumeRequestRoles: resumeReq.messages.map((m) => `${m.role}:${JSON.stringify(m.content ?? "").length}`),
			},
		};
		console.log(name, JSON.stringify(results[name], null, 2));
		await client.unload(name);
		await new Promise((r) => setTimeout(r, 3000));
	}
} finally {
	await router.stop();
	proxy.close();
	writeFileSync(join(scratch, "results.json"), JSON.stringify(results, null, 2));
	console.log(`results: ${join(scratch, "results.json")}`);
}
