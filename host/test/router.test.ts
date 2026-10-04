// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { silentLogger } from "../src/log.ts";
import { renderPreset } from "../src/models/preset.ts";
import { pidAlive, RouterProcess, RouterStartError } from "../src/models/router.ts";
import { FAKE_ROUTER, fakeRouterProcess, freePort, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";

describe("router process", () => {
	const sb: Sandbox = sandbox();
	writeFileSync(join(sb.stateDir, "models.ini"), renderPreset(sb.registry));
	const cleanups: (() => void | Promise<void>)[] = [];
	after(async () => {
		for (const c of cleanups.reverse()) await c();
		sb.cleanup();
	});

	test("starts with host-owned flags and a minimal environment, then stops", async () => {
		const argsFile = join(sb.stateDir, "fake-router-args.json");
		process.env.SECRET_TOKEN_FOR_TEST = "do-not-leak";
		const port = await freePort();
		const r = fakeRouterProcess(sb, port);
		cleanups.push(() => r.stop());
		try {
			await r.start();
		} finally {
			delete process.env.SECRET_TOKEN_FOR_TEST;
		}
		assert.ok(r.isAlive());
		const pid = r.pid!;
		const { argv, env } = JSON.parse(readFileSync(argsFile, "utf8")) as {
			argv: string[];
			env: Record<string, string>;
		};
		assert.deepEqual(argv.slice(argv.indexOf("--no-models-autoload"), argv.indexOf("--no-models-autoload") + 3), [
			"--no-models-autoload",
			"--models-max",
			"0",
		]);
		assert.equal(argv[argv.indexOf("--host") + 1], "127.0.0.1");
		assert.equal(env.SECRET_TOKEN_FOR_TEST, undefined);
		assert.equal(env.LLAMA_CACHE, join(sb.stateDir, "llama-cache"));
		assert.ok(existsSync(join(sb.stateDir, "router.pid.json")));

		await r.stop();
		assert.equal(r.isAlive(), false);
		assert.equal(pidAlive(pid), false);
		assert.equal(existsSync(join(sb.stateDir, "router.pid.json")), false);
	});

	test("a new host instance adopts its own running router (crash recovery)", async () => {
		const port = await freePort();
		const first = fakeRouterProcess(sb, port);
		await first.start();
		const pid = first.pid!;
		cleanups.push(() => {
			if (pidAlive(pid)) process.kill(pid, "SIGKILL");
		});
		const second = fakeRouterProcess(sb, port);
		assert.equal(second.tryAdopt(), true);
		assert.equal(second.pid, pid);
		await second.stop();
		await waitFor(() => !pidAlive(pid));
	});

	test("A14: a pid file naming an unrelated process is neither adopted nor signalled", async () => {
		const bystander = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
		cleanups.push(() => {
			bystander.kill("SIGKILL");
		});
		const port = await freePort();
		writeFileSync(
			join(sb.stateDir, "router.pid.json"),
			JSON.stringify({ pid: bystander.pid, command: "x", port, preset: "x", startedAt: "x" }),
		);
		const r = fakeRouterProcess(sb, port);
		assert.equal(r.tryAdopt(), false);
		assert.equal(r.pid, null);
		await r.stop();
		assert.equal(pidAlive(bystander.pid!), true);
		assert.equal(existsSync(join(sb.stateDir, "router.pid.json")), false);
	});

	test("refuses to start when another process holds the port, and leaves it alone", async () => {
		const port = await freePort();
		const other = createServer((_, res) => res.end("not llama"));
		await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", resolve));
		cleanups.push(() => new Promise<void>((resolve) => other.close(() => resolve())));
		const r = fakeRouterProcess(sb, port);
		await assert.rejects(r.start(), (err: Error) => {
			assert.ok(err instanceof RouterStartError);
			assert.match(err.message, new RegExp(`port ${port} is already in use by pid ${process.pid}`));
			return true;
		});
		assert.equal(other.listening, true);
	});

	test("reports a router that exits during startup", async () => {
		const r = new RouterProcess({
			command: FAKE_ROUTER,
			argsPrefix: [],
			port: await freePort(),
			presetPath: join(sb.dir, "no-such.ini"), // the fake router crashes reading it
			stateDir: sb.stateDir,
			startTimeoutMs: 10_000,
			stopGraceMs: 1000,
			log: silentLogger,
		});
		await assert.rejects(r.start(), /exited during startup/);
		assert.equal(r.pid, null);
	});
});
