#!/usr/bin/env node
// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0
//
// A stand-in for `python -m kev.serve`: `/v1/*` only with the key from
// KEV_API_KEY; GET /v1/models reports the --run it was started with (or
// a different checkpoint when the --run ends in "@mismatch"); POST
// /v1/systemone answers every noul question with FAKE_KEV_NOUL (default 0.5).
// While $HOME/fake-kev-run exists, /v1/models reports its content as the run
// (a checkpoint swapped under a running host).
// Records its argv and environment in $HOME/fake-kev-env.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
writeFileSync(join(process.env.HOME, "fake-kev-env.json"), JSON.stringify({ argv, env: process.env, pid: process.pid }));
const key = process.env.KEV_API_KEY;
const run = arg("--run").endsWith("@mismatch") ? "someone/else@0000" : arg("--run");
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (d) => {
		body += d;
	});
	req.on("end", () => {
		const json = (code, b) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(b));
		};
		if (req.url?.startsWith("/v1") && key && req.headers.authorization !== `Bearer ${key}`) {
			return json(401, { detail: "missing or invalid API key" });
		}
		if (req.method === "GET" && req.url === "/v1/models") {
			const swapped = join(process.env.HOME, "fake-kev-run");
			const card = { run: existsSync(swapped) ? readFileSync(swapped, "utf8").trim() : run, base: "Qwen/Qwen3.5-4B-Base", lora: 16, device: "mps", backend: "mlx", dtype: "bfloat16", temperature: 2.41 };
			return json(200, { models: [{ name: "kev-latest", ...card }, { name: "jev-latest", ...card }] });
		}
		if (req.method === "POST" && req.url === "/v1/systemone") {
			const { questions } = JSON.parse(body || "{}");
			const p = Number(process.env.FAKE_KEV_NOUL ?? 0.5);
			const answers = Object.fromEntries(Object.keys(questions ?? {}).map((id) => [id, { noul: p }]));
			return json(200, { answers, usage: { input_tokens: 10, output_tokens: 2 } });
		}
		json(404, {});
	});
});
server.listen(Number(arg("--port")), arg("--host"));
const stop = () => {
	server.closeAllConnections();
	server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
