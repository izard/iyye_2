// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The long-term memory service (plan 0.002 L1): Iyye's PostgreSQL cluster and
 * the Hindsight server, run and watched by the host.
 *
 * - Hindsight's environment is built from scratch: it uses Iyye's Postgres
 *   (never its embedded pg0), local embedding and reranking models, no network
 *   (`HF_HUB_OFFLINE`), its model calls go to the host's memory pass-through
 *   (L2), automatic consolidation and background sweeps are off, and every
 *   request needs Iyye's API key. Nothing from the host's own environment
 *   (an `OPENAI_API_KEY`, say) can reach it.
 * - Model files are provisioned once by an explicit owner step
 *   (`scripts/provision-memory.ts`); the running host never downloads them.
 * - Startup runs in the background: chat works while memory comes up, and the
 *   owner sees an honest status. A health loop restarts what died, with backoff.
 * - Shutdown stops Hindsight, then Postgres: Postgres outlives a killed
 *   Hindsight, so it must be stopped explicitly (spike finding).
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import { SupervisedProcess } from "../process/supervised.ts";
import { DB_NAME, PostgresCluster } from "./postgres.ts";

export type MemoryState =
	| "disabled"
	| "not installed"
	| "needs provisioning"
	| "starting"
	| "up"
	| "retrying"
	| "failed"
	| "stopped";

export interface MemoryStatus {
	state: MemoryState;
	detail: string;
}

/** What the service needs from the database cluster (a fake in some tests). */
export interface MemoryDatabase {
	installed(): boolean;
	start(): Promise<"started" | "adopted">;
	stop(): Promise<void>;
	running(): Promise<boolean>;
	url(): string;
	/** Run SQL in a database (the real cluster; fakes may leave it out). */
	psql?(database: string, sql: string): Promise<string>;
}

export interface MemoryModels {
	embeddings: string;
	reranker: string;
	/** PostgreSQL text-search dictionary for keyword recall. */
	textSearchLanguage: string;
	/** Language every stored fact, observation and reflection is written in (owner decision: English). */
	storedLanguage: string;
}

export interface MemoryServiceOptions {
	/** `iyye_2/memory`: holds `.venv` (Hindsight) and `pg` (PostgreSQL). */
	installDir: string;
	/** `<IYYE2_STATE_DIR>/memory`: database, secrets, model cache, logs. */
	stateDir: string;
	hindsightPort: number;
	dbPort: number;
	/** Where Hindsight sends its model calls: the host's lease-gated pass-through (L2). */
	passthroughPort: number;
	models: MemoryModels;
	log: Logger;
	enabled?: boolean;
	healthIntervalMs?: number;
	startTimeoutMs?: number;
	/** Tests: run a fake hindsight-api; defaults to `<installDir>/.venv/bin/hindsight-api`. */
	hindsightCommand?: string[];
	/** Tests: a fake database; defaults to the conda PostgreSQL in `<installDir>/pg`. */
	database?: MemoryDatabase;
	restartBackoffMs?: number[];
}

export const DEFAULT_MEMORY_MODELS: MemoryModels = {
	embeddings: "BAAI/bge-small-en-v1.5",
	reranker: "cross-encoder/ms-marco-MiniLM-L-6-v2",
	textSearchLanguage: "english",
	storedLanguage: "English",
};

export class MemoryService {
	private readonly o: Required<Omit<MemoryServiceOptions, "database" | "hindsightCommand">> & {
		hindsightCommand: string[];
	};
	private readonly db: MemoryDatabase;
	private readonly hindsight: SupervisedProcess;
	private current: MemoryStatus = { state: "stopped", detail: "not started" };
	private running = false;
	private loop: Promise<void> = Promise.resolve();
	private wake: (() => void) | null = null;

	constructor(opts: MemoryServiceOptions) {
		this.o = {
			enabled: true,
			healthIntervalMs: 30_000,
			startTimeoutMs: 180_000,
			restartBackoffMs: [5000, 30_000, 120_000],
			...opts,
			hindsightCommand: opts.hindsightCommand ?? [join(opts.installDir, ".venv", "bin", "hindsight-api")],
		};
		this.db =
			opts.database ??
			new PostgresCluster({
				binDir: join(opts.installDir, "pg", "bin"),
				stateDir: opts.stateDir,
				port: opts.dbPort,
				log: opts.log,
			});
		const [command, ...prefix] = this.o.hindsightCommand;
		this.hindsight = new SupervisedProcess({
			name: "hindsight",
			command: command!,
			args: [...prefix, "--host", "127.0.0.1", "--port", String(opts.hindsightPort)],
			env: () => this.hindsightEnv(), // built at each start: needs the database URL and key
			port: opts.hindsightPort,
			stateDir: opts.stateDir,
			healthUrl: `${this.baseUrl}/health`,
			identity: [prefix[0] ?? command!, `--port ${opts.hindsightPort}`],
			startTimeoutMs: this.o.startTimeoutMs,
			stopGraceMs: 20_000,
			log: opts.log,
		});
	}

	get status(): MemoryStatus {
		return this.current;
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.o.hindsightPort}`;
	}

	/** The key every Hindsight request needs (0600 file, created once). Only the host holds it. */
	apiKey(): string {
		return this.secret("hindsight_api_key");
	}

	/** The key Hindsight sends to the host's memory pass-through (0600 file, created once). */
	passthroughKey(): string {
		return this.secret("passthrough_key");
	}

	private secret(name: string): string {
		const file = join(this.o.stateDir, "secrets", name);
		if (!existsSync(file)) {
			mkdirSync(join(this.o.stateDir, "secrets"), { recursive: true, mode: 0o700 });
			writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
		}
		chmodSync(file, 0o600);
		return readFileSync(file, "utf8").trim();
	}

	/** The model cache Hindsight reads (offline) and the provisioning script fills. */
	get modelCacheDir(): string {
		return join(this.o.stateDir, "hf");
	}

	/** True when both local models are in the cache. */
	provisioned(): boolean {
		return [this.o.models.embeddings, this.o.models.reranker].every((m) => hasCachedModel(this.modelCacheDir, m));
	}

	/**
	 * Delete Hindsight's stored model-request traces: one bank's (after `/forget`)
	 * or all of them (at startup: tracing is off, so nothing should remain).
	 * Best-effort; returns how many rows went, or null when it could not run.
	 */
	async purgeTraces(bank?: string): Promise<number | null> {
		if (!this.db.psql) return null;
		if (bank !== undefined && !/^[a-z0-9-]+$/.test(bank)) throw new Error(`not a bank id: ${bank}`);
		try {
			const schemas = (
				await this.db.psql(
					DB_NAME,
					"SELECT table_schema FROM information_schema.tables WHERE table_name = 'llm_requests'",
				)
			)
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => /^[A-Za-z0-9_]+$/.test(l));
			let n = 0;
			for (const schema of schemas) {
				const out = await this.db.psql(
					DB_NAME,
					`WITH d AS (DELETE FROM "${schema}".llm_requests${bank === undefined ? "" : ` WHERE bank_id = '${bank}'`} RETURNING 1) SELECT count(*) FROM d`,
				);
				n += Number.parseInt(out.trim(), 10) || 0;
			}
			return n;
		} catch (err) {
			this.o.log.warn("memory: purging stored model traces failed", { error: (err as Error).message });
			return null;
		}
	}

	/** Start in the background; returns at once. Check `status` for progress. */
	start(): void {
		if (this.running) return;
		if (!this.o.enabled) {
			this.set("disabled", "IYYE2_MEMORY_ENABLED=0");
			return;
		}
		if (!existsSync(this.o.hindsightCommand[0]!) || !this.db.installed()) {
			this.set(
				"not installed",
				`missing ${existsSync(this.o.hindsightCommand[0]!) ? "memory/pg (PostgreSQL)" : "memory/.venv (Hindsight)"}`,
			);
			return;
		}
		if (!this.provisioned()) {
			this.set("needs provisioning", "run: cd host && node scripts/provision-memory.ts");
			return;
		}
		this.running = true;
		mkdirSync(this.o.stateDir, { recursive: true, mode: 0o700 });
		this.loop = this.supervise();
	}

	/** Stop Hindsight, then PostgreSQL. */
	async stop(): Promise<void> {
		this.running = false;
		this.wake?.();
		await this.loop;
		await this.hindsight.stop();
		try {
			await this.db.stop();
		} catch (err) {
			this.o.log.error("memory: stopping PostgreSQL failed", { error: (err as Error).message });
		}
		if (
			this.current.state !== "disabled" &&
			this.current.state !== "not installed" &&
			this.current.state !== "needs provisioning"
		) {
			this.set("stopped", "stopped");
		}
	}

	/** The exact environment Hindsight runs with (exposed for tests). */
	hindsightEnv(): Record<string, string> {
		const url = this.db.url();
		if (!/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/\w+$/.test(url)) {
			// Never let Hindsight fall back to its embedded pg0 or reach a remote database.
			throw new Error("refusing to start Hindsight without Iyye's local PostgreSQL URL");
		}
		const home = join(this.o.stateDir, "home");
		mkdirSync(home, { recursive: true });
		return {
			PATH: "/usr/bin:/bin",
			HOME: home,
			HF_HOME: this.modelCacheDir,
			HF_HUB_OFFLINE: "1",
			TRANSFORMERS_OFFLINE: "1",
			HINDSIGHT_API_DATABASE_URL: url,
			HINDSIGHT_API_DB_POOL_MIN_SIZE: "2",
			HINDSIGHT_API_DB_POOL_MAX_SIZE: "10",
			HINDSIGHT_API_LLM_PROVIDER: "openai",
			HINDSIGHT_API_LLM_BASE_URL: `http://127.0.0.1:${this.o.passthroughPort}/v1`,
			HINDSIGHT_API_LLM_API_KEY: this.passthroughKey(),
			HINDSIGHT_API_LLM_MODEL: "iyye-memory", // the pass-through always substitutes the admitted model
			HINDSIGHT_API_LLM_MAX_CONCURRENT: "1",
			// Hindsight's per-bank request tracing stores every prompt (people's words) outside the banks,
			// where deleting a bank does not reach it (plan 0.002 L6). Iyye keeps no such copies.
			HINDSIGHT_API_LLM_TRACE_ENABLED: "false",
			// A 503 means "not admitted now": fail fast, Iyye retries the whole operation in a later idle window.
			HINDSIGHT_API_LLM_MAX_RETRIES: "1",
			HINDSIGHT_API_LLM_INITIAL_BACKOFF: "0.5",
			// The startup probe would only ever meet the gated pass-through (503) or spend device time.
			HINDSIGHT_API_SKIP_LLM_VERIFICATION: "true",
			HINDSIGHT_API_LLM_TIMEOUT: "900",
			HINDSIGHT_API_REFLECT_LLM_TIMEOUT: "900",
			HINDSIGHT_API_EMBEDDINGS_PROVIDER: "local",
			HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: this.o.models.embeddings,
			HINDSIGHT_API_RERANKER_PROVIDER: "local",
			HINDSIGHT_API_RERANKER_LOCAL_MODEL: this.o.models.reranker,
			HINDSIGHT_API_TEXT_SEARCH_EXTENSION: "native",
			HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE: this.o.models.textSearchLanguage,
			// Facts from a Russian conversation are stored in English too, matching the English-only embedder.
			HINDSIGHT_API_LLM_OUTPUT_LANGUAGE: this.o.models.storedLanguage,
			HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION: "false",
			HINDSIGHT_API_CONSOLIDATION_RECONCILE_INTERVAL_SECONDS: "0",
			HINDSIGHT_API_MENTAL_MODEL_REFRESH_TICK_SECONDS: "0",
			HINDSIGHT_API_TENANT_EXTENSION: "hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension",
			HINDSIGHT_API_TENANT_API_KEY: this.apiKey(),
		};
	}

	// ---------------------------------------------------------------- internals

	private async supervise(): Promise<void> {
		let failures = 0;
		while (this.running) {
			try {
				if (!(await this.healthy())) {
					this.set("starting", failures === 0 ? "starting PostgreSQL and Hindsight" : "restarting");
					await this.bringUp();
				}
				failures = 0;
				this.set("up", `Hindsight on 127.0.0.1:${this.o.hindsightPort}`);
				await this.pause(this.o.healthIntervalMs);
			} catch (err) {
				if (!this.running) break;
				failures++;
				const backoff = this.o.restartBackoffMs[Math.min(failures - 1, this.o.restartBackoffMs.length - 1)]!;
				this.set("retrying", `${(err as Error).message}; retrying in ${Math.round(backoff / 1000)} s`);
				await this.pause(backoff);
			}
		}
	}

	private async bringUp(): Promise<void> {
		await this.db.start();
		if (this.hindsight.isAlive() || this.hindsight.tryAdopt()) {
			// Adopted after a host crash: trust it only if it answers with our key.
			if (await this.authenticatedOk()) return;
			this.o.log.warn("memory: running Hindsight did not accept our key; restarting it");
			await this.hindsight.stop();
		}
		await this.hindsight.start();
		if (!(await this.authenticatedOk())) throw new Error("Hindsight started but rejected our API key");
	}

	private async healthy(): Promise<boolean> {
		if (!this.hindsight.isAlive() || !(await this.db.running())) return false;
		return this.authenticatedOk();
	}

	private async authenticatedOk(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/v1/default/banks`, {
				headers: { authorization: `Bearer ${this.apiKey()}` },
				signal: AbortSignal.timeout(5000),
			});
			await res.body?.cancel();
			return res.ok;
		} catch {
			return false;
		}
	}

	private pause(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.wake = null;
				resolve();
			};
			const timer = setTimeout(done, ms);
			timer.unref();
			this.wake = done;
		});
	}

	private set(state: MemoryState, detail: string): void {
		if (this.current.state !== state || this.current.detail !== detail) {
			const level = state === "failed" || state === "retrying" ? "warn" : "info";
			this.o.log[level](`memory: ${state}`, { detail });
		}
		this.current = { state, detail };
	}
}

/** Hugging Face cache layout: `<HF_HOME>/hub/models--org--name/snapshots/<rev>/`. */
export function hasCachedModel(hfHome: string, model: string): boolean {
	const dir = join(hfHome, "hub", `models--${model.replace("/", "--")}`, "snapshots");
	try {
		return readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}
