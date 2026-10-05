#!/usr/bin/env node
// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0
//
// A stand-in for SearXNG served by granian: takes --host/--port, reads its
// instance name from SEARXNG_SETTINGS_PATH, answers /healthz, /config and
// /search?format=json (results scripted by the query: "fail" → HTTP 500,
// otherwise three results, one of them a Wikipedia page). Records argv and
// environment in $HOME/fake-searxng-env.json.

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
writeFileSync(join(process.env.HOME, "fake-searxng-env.json"), JSON.stringify({ argv, env: process.env, pid: process.pid }));
const settings = readFileSync(process.env.SEARXNG_SETTINGS_PATH, "utf8");
const instance = /instance_name:\s*(\S+)/.exec(settings)?.[1] ?? "?";
const server = createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	const json = (code, body) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (url.pathname === "/healthz") {
		res.writeHead(200, { "content-type": "text/plain" });
		return res.end("OK");
	}
	if (url.pathname === "/config") return json(200, { instance_name: instance, engines: [] });
	if (url.pathname === "/search") {
		const q = url.searchParams.get("q") ?? "";
		if (q.includes("fail")) return json(500, {});
		return json(200, {
			results: [
				{ title: `About ${q}`, url: "https://example.org/about", content: "An <b>example</b> page", engines: ["yandex", "yahoo"] },
				{ title: `${q} — Wikipedia`, url: "https://en.wikipedia.org/wiki/Kazan", content: "From the encyclopedia", engines: ["yep"] },
				{ title: "Not a web page", url: "javascript:alert(1)", content: "", engines: ["bing"] },
				{ title: "More", url: "https://example.net/more", content: "more text", engines: ["bing"] },
			],
		});
	}
	json(404, {});
});
server.listen(Number(arg("--port")), arg("--host"));
const stop = () => {
	server.closeAllConnections();
	server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
