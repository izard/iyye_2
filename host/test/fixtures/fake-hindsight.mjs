#!/usr/bin/env node
// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0
//
// A stand-in for `hindsight-api`: answers /health, and /v1/default/banks only
// with the key from HINDSIGHT_API_TENANT_API_KEY. Records its argv and
// environment in $HOME/fake-hindsight-env.json so tests can check exactly
// what the host passed.

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
writeFileSync(join(process.env.HOME, "fake-hindsight-env.json"), JSON.stringify({ argv, env: process.env, pid: process.pid }));
const key = process.env.HINDSIGHT_API_TENANT_API_KEY;
const server = createServer((req, res) => {
	const json = (code, body) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (req.url === "/health") return json(200, { status: "healthy", database: "connected" });
	if (req.url?.startsWith("/v1/")) {
		if (req.headers.authorization !== `Bearer ${key}`) return json(401, { detail: "unauthorized" });
		return json(200, { banks: [] });
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
