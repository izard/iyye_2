// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { PostgresCluster } from "../src/memory/postgres.ts";
import { DEFAULT_MEMORY_MODELS, type MemoryDatabase, MemoryService } from "../src/memory/service.ts";
import { freePort, waitFor } from "./model-helpers.ts";

const FAKE_HINDSIGHT = fileURLToPath(new URL("./fixtures/fake-hindsight.mjs", import.meta.url));
const PG_BIN = join(PROJECT_ROOT, "memory", "pg", "bin");
const havePostgres = existsSync(join(PG_BIN, "pg_ctl"));

function tempDir(prefix: string) {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** A database stand-in that records calls. */
function fakeDb(url = "postgresql://iyye:pw@127.0.0.1:5999/hindsight"): MemoryDatabase & { calls: string[] } {
	let up = false;
	const calls: string[] = [];
	return {
		calls,
		installed: () => true,
		start: async () => {
			calls.push("start");
			const was = up;
			up = true;
			return was ? "adopted" : "started";
		},
		stop: async () => {
			calls.push("stop");
			up = false;
		},
		running: async () => up,
		url: () => url,
	};
}

function provision(stateDir: string) {
	for (const m of [DEFAULT_MEMORY_MODELS.embeddings, DEFAULT_MEMORY_MODELS.reranker]) {
		mkdirSync(join(stateDir, "hf", "hub", `models--${m.replace("/", "--")}`, "snapshots", "abc123"), {
			recursive: true,
		});
	}
}

describe("memory service", () => {
	const services: MemoryService[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		for (const s of services.splice(0)) await s.stop();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	async function service(opts: { stateDir?: string; db?: MemoryDatabase; port?: number; installDir?: string } = {}) {
		const stateDir = opts.stateDir ?? tempDir("iyye-mem-");
		if (!opts.stateDir) dirs.push(stateDir);
		const s = new MemoryService({
			installDir: opts.installDir ?? PROJECT_ROOT,
			stateDir,
			hindsightPort: opts.port ?? (await freePort()),
			dbPort: 5999,
			passthroughPort: 8187,
			models: DEFAULT_MEMORY_MODELS,
			log: silentLogger,
			healthIntervalMs: 150,
			restartBackoffMs: [100],
			startTimeoutMs: 10_000,
			// Launched through node: Hindsight's minimal PATH has no `node` for the script's shebang.
			hindsightCommand: [process.execPath, FAKE_HINDSIGHT],
			database: opts.db ?? fakeDb(),
		});
		services.push(s);
		return { s, stateDir };
	}

	test("reports 'not installed' and 'needs provisioning' honestly instead of starting", async () => {
		const missing = new MemoryService({
			installDir: "/nonexistent/iyye-memory",
			stateDir: tempDir("iyye-mem-"),
			hindsightPort: 1,
			dbPort: 2,
			passthroughPort: 3,
			models: DEFAULT_MEMORY_MODELS,
			log: silentLogger,
		});
		missing.start();
		assert.equal(missing.status.state, "not installed");
		const { s } = await service();
		s.start();
		assert.equal(s.status.state, "needs provisioning");
		assert.match(s.status.detail, /provision-memory\.ts/);
	});

	test("starts Hindsight with exactly Iyye's environment: local Postgres, offline, local models, no inherited secrets", async () => {
		process.env.OPENAI_API_KEY = "sk-must-not-leak";
		try {
			const { s, stateDir } = await service();
			provision(stateDir);
			s.start();
			await waitFor(() => s.status.state === "up", 10_000);
			const { argv, env } = JSON.parse(readFileSync(join(stateDir, "home", "fake-hindsight-env.json"), "utf8")) as {
				argv: string[];
				env: Record<string, string>;
			};
			assert.deepEqual(argv.slice(argv.indexOf("--host"), argv.indexOf("--host") + 2), ["--host", "127.0.0.1"]);
			assert.equal(env.OPENAI_API_KEY, undefined);
			assert.equal(env.HINDSIGHT_API_DATABASE_URL, "postgresql://iyye:pw@127.0.0.1:5999/hindsight");
			assert.equal(env.HF_HUB_OFFLINE, "1");
			assert.equal(env.HF_HOME, join(stateDir, "hf"));
			assert.equal(env.HINDSIGHT_API_EMBEDDINGS_PROVIDER, "local");
			assert.equal(env.HINDSIGHT_API_RERANKER_PROVIDER, "local");
			assert.equal(env.HINDSIGHT_API_LLM_BASE_URL, "http://127.0.0.1:8187/v1");
			assert.equal(env.HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION, "false");
			assert.equal(env.HINDSIGHT_API_LLM_TRACE_ENABLED, "false", "no stored copies of prompts outside the banks");
			assert.equal(env.HINDSIGHT_API_LLM_OUTPUT_LANGUAGE, "English");
			assert.equal(env.HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL, "BAAI/bge-small-en-v1.5");
			assert.equal(env.HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE, "english");
			assert.equal(env.HINDSIGHT_API_DB_POOL_MAX_SIZE, "10");
			assert.equal(env.HINDSIGHT_API_TENANT_API_KEY, s.apiKey());
			assert.equal(env.HINDSIGHT_API_LLM_API_KEY, s.passthroughKey());
			assert.notEqual(s.passthroughKey(), s.apiKey());
			assert.equal(statSync(join(stateDir, "secrets", "passthrough_key")).mode & 0o777, 0o600);
			assert.equal(env.HINDSIGHT_API_LLM_MAX_RETRIES, "1");
			assert.equal(env.HINDSIGHT_API_SKIP_LLM_VERIFICATION, "true");
			assert.equal(statSync(join(stateDir, "secrets", "hindsight_api_key")).mode & 0o777, 0o600);
			const extra = Object.keys(env).filter((k) => !k.startsWith("HINDSIGHT_API_") && !k.startsWith("__CF"));
			assert.deepEqual(extra.sort(), ["HF_HOME", "HF_HUB_OFFLINE", "HOME", "PATH", "TRANSFORMERS_OFFLINE"]);
		} finally {
			delete process.env.OPENAI_API_KEY;
		}
	});

	test("refuses to start Hindsight with anything but a local PostgreSQL URL (no pg0 fallback, no remote DB)", async () => {
		const { s, stateDir } = await service({ db: fakeDb("postgresql://iyye:pw@10.0.0.5:5432/hindsight") });
		provision(stateDir);
		s.start();
		await waitFor(() => s.status.state === "retrying");
		assert.match(s.status.detail, /refusing to start Hindsight without Iyye's local PostgreSQL URL/);
		assert.ok(!existsSync(join(stateDir, "home", "fake-hindsight-env.json")));
	});

	test("after a host crash a new host adopts the running Hindsight; if it dies, the health loop restarts it", async () => {
		const stateDir = tempDir("iyye-mem-");
		dirs.push(stateDir);
		provision(stateDir);
		const port = await freePort();
		const db = fakeDb();
		const first = (await service({ stateDir, port, db })).s;
		first.start();
		await waitFor(() => first.status.state === "up", 10_000);
		const pid = JSON.parse(readFileSync(join(stateDir, "hindsight.pid.json"), "utf8")).pid as number;
		// The "crashed" host: drop it without stopping anything.
		services.splice(services.indexOf(first), 1);
		(first as unknown as { running: boolean }).running = false;

		const second = (await service({ stateDir, port, db })).s;
		second.start();
		await waitFor(() => second.status.state === "up", 10_000);
		assert.equal(
			JSON.parse(readFileSync(join(stateDir, "hindsight.pid.json"), "utf8")).pid,
			pid,
			"adopted, not respawned",
		);

		process.kill(pid, "SIGKILL");
		await waitFor(() => {
			try {
				return JSON.parse(readFileSync(join(stateDir, "hindsight.pid.json"), "utf8")).pid !== pid;
			} catch {
				return false;
			}
		}, 10_000);
		await waitFor(() => second.status.state === "up", 10_000);
		await second.stop();
		assert.ok(db.calls.includes("stop"), "PostgreSQL is stopped after Hindsight");
		assert.equal(second.status.state, "stopped");
	});

	test("a busy Hindsight port is reported, and the foreign listener is left alone", async () => {
		const other = createServer((_, res) => res.end("not hindsight"));
		const port = await freePort();
		await new Promise<void>((r) => other.listen(port, "127.0.0.1", r));
		try {
			const { s, stateDir } = await service({ port });
			provision(stateDir);
			s.start();
			await waitFor(() => s.status.state === "retrying");
			assert.match(s.status.detail, new RegExp(`port ${port} is already in use by pid ${process.pid}`));
			assert.ok(other.listening);
		} finally {
			await new Promise<void>((r) => other.close(() => r()));
		}
	});
});

describe("memory PostgreSQL cluster (conda-forge build)", { skip: !havePostgres && "memory/pg not installed" }, () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	test("created once, reached only over TCP with its password, adopted after a host crash, and stopped", async () => {
		const stateDir = tempDir("iyye-pg-");
		dirs.push(stateDir);
		const port = await freePort();
		const cluster = new PostgresCluster({ binDir: PG_BIN, stateDir, port, log: silentLogger });
		try {
			assert.equal(await cluster.start(), "started");
			assert.equal(
				(await cluster.psql("hindsight", "SELECT extname FROM pg_extension WHERE extname = 'vector'")).trim(),
				"vector",
			);
			assert.equal(statSync(join(stateDir, "secrets", "db_password")).mode & 0o777, 0o600);
			assert.match(cluster.url(), new RegExp(`^postgresql://iyye:[0-9a-f]{48}@127\\.0\\.0\\.1:${port}/hindsight$`));
			assert.match(readFileSync(join(stateDir, "pgdata", "iyye.conf"), "utf8"), /unix_socket_directories = ''/);

			const wrong = await promisify(execFile)(
				join(PG_BIN, "psql"),
				["-h", "127.0.0.1", "-p", String(port), "-U", "iyye", "-d", "hindsight", "-Atc", "select 1"],
				{
					env: { PATH: "/usr/bin:/bin", PGPASSWORD: "wrong" },
				},
			).then(
				() => "connected",
				(e: { stderr: string }) => e.stderr,
			);
			assert.match(wrong, /password authentication failed/);

			const restarted = new PostgresCluster({ binDir: PG_BIN, stateDir, port, log: silentLogger });
			assert.equal(await restarted.start(), "adopted", "a new host adopts the running cluster");
			await restarted.stop();
			assert.equal(await cluster.running(), false);
		} finally {
			await cluster.stop();
		}
	});

	test("never starts on a port another process holds", async () => {
		const stateDir = tempDir("iyye-pg-");
		dirs.push(stateDir);
		const other = createServer();
		const port = await freePort();
		await new Promise<void>((r) => other.listen(port, "127.0.0.1", r));
		try {
			const cluster = new PostgresCluster({ binDir: PG_BIN, stateDir, port, log: silentLogger });
			await assert.rejects(cluster.start(), new RegExp(`port ${port} is already in use`));
			assert.equal(await cluster.running(), false);
		} finally {
			await new Promise<void>((r) => other.close(() => r()));
		}
	});
});

test("purging stored model traces: per bank or all, in every schema that has them; refuses odd bank ids", async () => {
	const sql: string[] = [];
	const db: MemoryDatabase = {
		...fakeDb(),
		psql: async (_database, q) => {
			sql.push(q);
			return q.startsWith("SELECT table_schema") ? "public\ntenant_x\n" : "3\n";
		},
	};
	const s = new MemoryService({
		installDir: "/nonexistent/iyye-memory",
		stateDir: mkdtempSync(join(tmpdir(), "iyye-mem-")),
		hindsightPort: 1,
		dbPort: 2,
		passthroughPort: 3,
		models: DEFAULT_MEMORY_MODELS,
		log: silentLogger,
		database: db,
	});
	assert.equal(await s.purgeTraces("iyye-contact-abc"), 6);
	assert.match(sql[1]!, /DELETE FROM "public"\.llm_requests WHERE bank_id = 'iyye-contact-abc'/);
	assert.match(sql[2]!, /DELETE FROM "tenant_x"\.llm_requests WHERE bank_id = 'iyye-contact-abc'/);
	assert.equal(await s.purgeTraces(), 6);
	assert.doesNotMatch(sql.at(-1)!, /WHERE/);
	await assert.rejects(s.purgeTraces("x'; DROP TABLE y; --"), /not a bank id/);
	const { psql: _, ...noSql } = db;
	const without = new MemoryService({
		installDir: "/nonexistent/iyye-memory",
		stateDir: mkdtempSync(join(tmpdir(), "iyye-mem-")),
		hindsightPort: 1,
		dbPort: 2,
		passthroughPort: 3,
		models: DEFAULT_MEMORY_MODELS,
		log: silentLogger,
		database: noSql,
	});
	assert.equal(await without.purgeTraces("iyye-owner"), null);
});
