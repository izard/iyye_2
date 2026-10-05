// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Plan 0.003 K1: the supervised Kev decision service, against a fake Kev server. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DecisionClient } from "../src/decisions/client.ts";
import { DecisionService } from "../src/decisions/service.ts";
import { silentLogger } from "../src/log.ts";
import { openDb } from "../src/state/db.ts";
import { freePort, waitFor } from "./model-helpers.ts";

const FAKE_KEV = fileURLToPath(new URL("./fixtures/fake-kev.mjs", import.meta.url));
const MODEL = "jaredpalmer/kev-4b@6cfce5c2fa4b4bd64026336ab649c5ca78857d52";

describe("decision service", () => {
	const services: DecisionService[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		for (const s of services.splice(0)) await s.stop();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function provision(stateDir: string, run = MODEL) {
		const snap = join(stateDir, "hf", "hub", "models--jaredpalmer--kev-4b", "snapshots", "6cfce5c");
		mkdirSync(snap, { recursive: true });
		writeFileSync(
			join(stateDir, "provisioned.json"),
			JSON.stringify({ run, path: snap, base: "Qwen/Qwen3.5-4B-Base", baseRevision: "1001bb4", at: "t" }),
		);
	}

	async function service(opts: { stateDir?: string; port?: number; model?: string; installDir?: string } = {}) {
		const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "iyye-dec-"));
		if (!opts.stateDir) dirs.push(stateDir);
		const s = new DecisionService({
			installDir: opts.installDir ?? "/unused",
			stateDir,
			port: opts.port ?? (await freePort()),
			model: opts.model ?? MODEL,
			log: silentLogger,
			healthIntervalMs: 150,
			restartBackoffMs: [100],
			startTimeoutMs: 10_000,
			command: opts.installDir ? undefined : [process.execPath, FAKE_KEV],
		});
		services.push(s);
		return { s, stateDir };
	}

	test("reports 'not installed' and 'needs provisioning' honestly instead of starting", async () => {
		const missing = (await service({ installDir: "/nonexistent/kev" })).s;
		missing.start();
		assert.equal(missing.status.state, "not installed");
		const { s, stateDir } = await service();
		s.start();
		assert.equal(s.status.state, "needs provisioning");
		assert.match(s.status.detail, /provision-decisions\.ts/);
		provision(stateDir, "jaredpalmer/kev-0.8b@abc"); // provisioned for another model: not good enough
		s.start();
		assert.equal(s.status.state, "needs provisioning");
	});

	test("starts Kev with exactly Iyye's environment: pinned checkpoint, offline, key, no inherited secrets", async () => {
		process.env.HF_TOKEN = "hf_must_not_leak";
		try {
			const { s, stateDir } = await service();
			provision(stateDir);
			s.start();
			await waitFor(() => s.status.state === "up", 10_000);
			const { argv, env } = JSON.parse(readFileSync(join(stateDir, "home", "fake-kev-env.json"), "utf8")) as {
				argv: string[];
				env: Record<string, string>;
			};
			assert.deepEqual(argv.slice(argv.indexOf("--run"), argv.indexOf("--run") + 2), ["--run", MODEL]);
			assert.deepEqual(argv.slice(argv.indexOf("--host"), argv.indexOf("--host") + 2), ["--host", "127.0.0.1"]);
			assert.equal(env.HF_TOKEN, undefined);
			assert.equal(env.HF_HUB_OFFLINE, "1");
			assert.equal(env.HF_HOME, join(stateDir, "hf"));
			assert.equal(env.KEV_API_KEY, s.apiKey());
			assert.equal(statSync(join(stateDir, "secrets", "kev_api_key")).mode & 0o777, 0o600);
			const extra = Object.keys(env).filter((k) => !k.startsWith("__CF"));
			assert.deepEqual(extra.sort(), [
				"HF_HOME",
				"HF_HUB_DISABLE_TELEMETRY",
				"HF_HUB_OFFLINE",
				"HOME",
				"KEV_API_KEY",
				"PATH",
				"TRANSFORMERS_OFFLINE",
			]);
			assert.deepEqual(s.checkpoint, {
				run: MODEL,
				base: "Qwen/Qwen3.5-4B-Base",
				lora: 16,
				temperature: 2.41,
				backend: "mlx",
				dtype: "bfloat16",
			});
			const noKey = await fetch(`${s.baseUrl}/v1/models`);
			assert.equal(noKey.status, 401);
		} finally {
			delete process.env.HF_TOKEN;
		}
	});

	test("a server reporting another checkpoint is never treated as up (§15 #17)", async () => {
		const { s, stateDir } = await service({ model: "jaredpalmer/kev-4b@mismatch" });
		provision(stateDir, "jaredpalmer/kev-4b@mismatch");
		s.start();
		await waitFor(() => s.status.state === "retrying", 10_000);
		assert.match(s.status.detail, /did not serve the pinned checkpoint/);
		assert.equal(s.checkpoint, null);
	});

	test("a checkpoint swapped under a running host is detected: the service leaves 'up' and calls are journaled as skipped (§15 #17)", async () => {
		const { s, stateDir } = await service();
		provision(stateDir);
		s.start();
		await waitFor(() => s.status.state === "up", 10_000);
		assert.equal(s.checkpoint?.run, MODEL);
		writeFileSync(join(stateDir, "home", "fake-kev-run"), "jaredpalmer/kev-4b@swapped");
		await waitFor(() => s.status.state !== "up", 10_000);
		assert.equal(s.checkpoint, null, "never silently used");
		const db = openDb(":memory:");
		const d = await new DecisionClient({ db, service: s }).ask(
			{ name: "probe", schemaVersion: 1, abstain: { low: 0.4, high: 0.6 } },
			{ scope: null, subjectRef: null, state: "x", questions: [{ id: "q", instructions: "?" }] },
		);
		assert.deepEqual([d.status, d.error], ["skipped", "the decision service is not up"]);
		assert.deepEqual(db.prepare("SELECT status, checkpoint FROM decisions").all(), [
			{ status: "skipped", checkpoint: null },
		]);
		db.close();
	});

	test("after a host crash a new host adopts the running Kev; if it dies, the health loop restarts it", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "iyye-dec-"));
		dirs.push(stateDir);
		provision(stateDir);
		const port = await freePort();
		const first = (await service({ stateDir, port })).s;
		first.start();
		await waitFor(() => first.status.state === "up", 10_000);
		const pid = JSON.parse(readFileSync(join(stateDir, "kev.pid.json"), "utf8")).pid as number;
		services.splice(services.indexOf(first), 1); // the "crashed" host: dropped without stopping anything
		(first as unknown as { running: boolean }).running = false;

		const second = (await service({ stateDir, port })).s;
		second.start();
		await waitFor(() => second.status.state === "up", 10_000);
		assert.equal(JSON.parse(readFileSync(join(stateDir, "kev.pid.json"), "utf8")).pid, pid, "adopted, not respawned");

		process.kill(pid, "SIGKILL");
		await waitFor(() => {
			try {
				return JSON.parse(readFileSync(join(stateDir, "kev.pid.json"), "utf8")).pid !== pid;
			} catch {
				return false;
			}
		}, 10_000);
		await waitFor(() => second.status.state === "up", 10_000);
		await second.stop();
		assert.equal(second.status.state, "stopped");
	});
});
