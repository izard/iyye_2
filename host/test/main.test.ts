// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { pidAlive } from "../src/models/router.ts";
import { FAKE_ROUTER, freePort, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

interface Host {
	child: ChildProcess;
	stderr: () => string;
	exit: Promise<number | null>;
}

async function startHost(sb: Sandbox, extraEnv: Record<string, string> = {}): Promise<Host> {
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		IYYE2_STATE_DIR: sb.stateDir,
		IYYE2_LLAMA_SERVER: FAKE_ROUTER,
		IYYE2_ROUTER_PORT: String(await freePort()),
		IYYE2_WEB_PORT: String(await freePort()),
		IYYE2_MODELS_REGISTRY: sb.registryPath,
		IYYE2_DEFAULT_MODEL: "small",
		IYYE2_MEMORY_DIR: "/nonexistent/iyye-memory", // never start the real Hindsight from a test
		IYYE2_DECISIONS_DIR: "/nonexistent/iyye-kev", // nor the real Kev
		IYYE2_SEARXNG_DIR: "/nonexistent/iyye-web", // nor the real SearXNG
		IYYE2_GEOLOCATION: "0", // nor a real geolocation service (plan 0.010 M0b)
		IYYE2_SEARXNG_PORT: String(await freePort()),
		IYYE2_DECISIONS_PORT: String(await freePort()),
		IYYE2_MEMORY_PASSTHROUGH_PORT: String(await freePort()),
		...extraEnv,
	};
	const child = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "pipe", "pipe"] });
	let err = "";
	child.stderr!.on("data", (d) => {
		err += d;
	});
	child.stdout!.resume();
	const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	return { child, stderr: () => err, exit };
}

const sb = sandbox();
after(() => sb.cleanup());

test("M0 exit: the host starts, reaches ready, and stops cleanly on SIGTERM", async () => {
	const host = await startHost(sb);
	await waitFor(() => host.stderr().includes("iyye host ready"), 15_000);
	assert.match(host.stderr(), /"router":"up"/);
	const routerPid = (JSON.parse(readFileSync(join(sb.stateDir, "router.pid.json"), "utf8")) as { pid: number }).pid;
	assert.ok(pidAlive(routerPid));
	assert.ok(existsSync(join(sb.stateDir, "iyye.db")));

	host.child.kill("SIGTERM");
	assert.equal(await host.exit, 0);
	assert.match(host.stderr(), /iyye host stopped/);
	assert.equal(pidAlive(routerPid), false);
	assert.equal(existsSync(join(sb.stateDir, "router.pid.json")), false);
	assert.equal(existsSync(join(sb.stateDir, "host.lock")), false);
});

test("a second host on the same state directory refuses to start", async () => {
	const first = await startHost(sb);
	await waitFor(() => first.stderr().includes("iyye host ready"), 15_000);
	const second = await startHost(sb);
	assert.equal(await second.exit, 3);
	assert.match(second.stderr(), /another Iyye host/);
	first.child.kill("SIGTERM");
	assert.equal(await first.exit, 0);
});

test("invalid configuration exits with code 2 and a clear message", async () => {
	const host = await startHost(sb, { IYYE2_ROUTER_PORT: "not-a-port" });
	assert.equal(await host.exit, 2);
	assert.match(host.stderr(), /IYYE2_ROUTER_PORT must be an integer/);
});
