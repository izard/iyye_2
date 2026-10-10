// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The local decision service (plan 0.003 K1): Kev's own server
 * (`kev/.venv/bin/python -m kev.serve`), run and watched by the host.
 *
 * - The checkpoint is pinned (`repo@revision`) and provisioned once by an
 *   explicit owner step (`scripts/provision-decisions.ts`), which records what
 *   it downloaded. The running host never downloads anything: Kev runs with
 *   `HF_HUB_OFFLINE`.
 * - Its environment is built from scratch: no inherited tokens (an HF_TOKEN,
 *   a Modal key) can reach it. 127.0.0.1 only; every `/v1` request needs
 *   Iyye's key (0600 file).
 * - Startup runs in the background with an honest status; a health loop
 *   restarts it with backoff; after a host crash a running Kev is adopted
 *   only if it answers with our key and serves the pinned checkpoint.
 * - In 0.003 every answer is shadow-only (plan §3.1): nothing here can change
 *   what Iyye does.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import { SupervisedProcess } from "../process/supervised.ts";

export type DecisionState =
	| "disabled"
	| "not installed"
	| "needs provisioning"
	| "starting"
	| "up"
	| "retrying"
	| "stopped";

export interface DecisionStatus {
	state: DecisionState;
	detail: string;
}

/** What the provisioning script recorded: exactly what the host may serve. */
export interface Provisioned {
	run: string;
	path: string;
	base: string;
	baseRevision: string;
	at: string;
}

/** The loaded checkpoint as Kev reports it (`GET /v1/models`): recorded with every decision. */
export interface CheckpointInfo {
	run: string;
	base: string;
	lora: number | null;
	temperature: number;
	backend: string;
	dtype: string;
}

export interface DecisionServiceOptions {
	/** `iyye_2/kev`: holds `.venv`. */
	installDir: string;
	/** `<IYYE2_STATE_DIR>/decisions`: model cache, secrets, logs, pid file. */
	stateDir: string;
	port: number;
	/** Pinned `repo@revision`. */
	model: string;
	log: Logger;
	enabled?: boolean;
	healthIntervalMs?: number;
	startTimeoutMs?: number;
	restartBackoffMs?: number[];
	/** Defaults to `<installDir>/.venv/bin/python -m kev.serve`; another Python (IYYE2_DECISIONS_PYTHON), or a test fake. */
	command?: string[];
}

export class DecisionService {
	private readonly o: Required<Omit<DecisionServiceOptions, "command">> & { command: string[] };
	private readonly kev: SupervisedProcess;
	private current: DecisionStatus = { state: "stopped", detail: "not started" };
	private running = false;
	private loop: Promise<void> = Promise.resolve();
	private wake: (() => void) | null = null;
	private info: CheckpointInfo | null = null;

	constructor(opts: DecisionServiceOptions) {
		this.o = {
			enabled: true,
			healthIntervalMs: 30_000,
			startTimeoutMs: 120_000,
			restartBackoffMs: [5000, 30_000, 120_000],
			...opts,
			command: opts.command ?? [join(opts.installDir, ".venv", "bin", "python"), "-m", "kev.serve"],
		};
		const [command, ...prefix] = this.o.command;
		this.kev = new SupervisedProcess({
			name: "kev",
			command: command!,
			args: [...prefix, "--run", opts.model, "--host", "127.0.0.1", "--port", String(opts.port)],
			env: () => this.env(),
			port: opts.port,
			stateDir: opts.stateDir,
			healthUrl: `${this.baseUrl}/v1/models`,
			healthHeaders: () => ({ authorization: `Bearer ${this.apiKey()}` }),
			// "-m kev.serve" for the real server; the script path for a test fake. The Python too: a Kev left
			// running by another build (IYYE2_DECISIONS_PYTHON changed) is not adopted.
			identity: [command!, prefix.join(" ") || command!, `--port ${opts.port}`],
			startTimeoutMs: this.o.startTimeoutMs,
			stopGraceMs: 10_000,
			log: opts.log,
		});
	}

	get status(): DecisionStatus {
		return this.current;
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.o.port}`;
	}

	/** The checkpoint Kev reported at the last health check; null until it is up. */
	get checkpoint(): CheckpointInfo | null {
		return this.current.state === "up" ? this.info : null;
	}

	get modelCacheDir(): string {
		return join(this.o.stateDir, "hf");
	}

	/** The key every `/v1` request needs (0600 file, created once). Only the host holds it. */
	apiKey(): string {
		const file = join(this.o.stateDir, "secrets", "kev_api_key");
		if (!existsSync(file)) {
			mkdirSync(join(this.o.stateDir, "secrets"), { recursive: true, mode: 0o700 });
			writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
		}
		chmodSync(file, 0o600);
		return readFileSync(file, "utf8").trim();
	}

	/**
	 * What `provision-decisions.ts` downloaded, if it matches the configured model. A state dir moved from
	 * another machine (2026-10-09, Mac → DGX Spark) records that machine's absolute path: the same snapshot
	 * is then looked for in this state dir's own model cache.
	 */
	provisioned(): Provisioned | null {
		try {
			const p = JSON.parse(readFileSync(join(this.o.stateDir, "provisioned.json"), "utf8")) as Provisioned;
			if (p.run !== this.o.model) return null;
			if (existsSync(p.path)) return p;
			const i = p.path.lastIndexOf("/hf/");
			const here = i >= 0 ? join(this.modelCacheDir, p.path.slice(i + 4)) : null;
			return here && existsSync(here) ? { ...p, path: here } : null;
		} catch {
			return null;
		}
	}

	start(): void {
		if (this.running) return;
		if (!this.o.enabled) {
			this.set("disabled", "IYYE2_DECISIONS_ENABLED=0");
			return;
		}
		if (!existsSync(this.o.command[0]!)) {
			this.set("not installed", `missing ${this.o.command[0]}`);
			return;
		}
		if (!this.provisioned()) {
			this.set("needs provisioning", "run: cd host && node scripts/provision-decisions.ts");
			return;
		}
		this.running = true;
		mkdirSync(this.o.stateDir, { recursive: true, mode: 0o700 });
		this.loop = this.supervise();
	}

	async stop(): Promise<void> {
		this.running = false;
		this.wake?.();
		await this.loop;
		await this.kev.stop();
		if (
			this.current.state !== "disabled" &&
			this.current.state !== "not installed" &&
			this.current.state !== "needs provisioning"
		) {
			this.set("stopped", "stopped");
		}
	}

	/** The exact environment Kev runs with (exposed for tests). */
	env(): Record<string, string> {
		const home = join(this.o.stateDir, "home");
		mkdirSync(home, { recursive: true });
		return {
			PATH: "/usr/bin:/bin",
			HOME: home,
			HF_HOME: this.modelCacheDir,
			HF_HUB_OFFLINE: "1",
			TRANSFORMERS_OFFLINE: "1",
			HF_HUB_DISABLE_TELEMETRY: "1",
			KEV_API_KEY: this.apiKey(),
		};
	}

	// ---------------------------------------------------------------- internals

	private async supervise(): Promise<void> {
		let failures = 0;
		while (this.running) {
			try {
				if (!(await this.healthy())) {
					this.set("starting", failures === 0 ? `loading ${this.o.model}` : "restarting");
					await this.bringUp();
				}
				failures = 0;
				this.set(
					"up",
					`${this.info?.run ?? this.o.model} on 127.0.0.1:${this.o.port} (${this.info?.backend ?? "?"})`,
				);
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
		if (this.kev.isAlive() || this.kev.tryAdopt()) {
			// Adopted after a host crash: trust it only if it accepts our key and serves the pinned checkpoint.
			if (await this.healthy()) return;
			this.o.log.warn("decisions: running Kev did not answer with our key and checkpoint; restarting it");
			await this.kev.stop();
		}
		await this.kev.start();
		if (!(await this.healthy())) throw new Error("Kev started but did not serve the pinned checkpoint with our key");
	}

	private async healthy(): Promise<boolean> {
		if (!this.kev.isAlive()) return false;
		try {
			const res = await fetch(`${this.baseUrl}/v1/models`, {
				headers: { authorization: `Bearer ${this.apiKey()}` },
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok) {
				await res.body?.cancel();
				return false;
			}
			const body = (await res.json()) as { models?: Partial<CheckpointInfo & { name: string }>[] };
			const m = body.models?.find((x) => x.name === "kev-latest") ?? body.models?.[0];
			if (!m || m.run !== this.o.model) return false; // another checkpoint must never be used silently (§15 #17)
			this.info = {
				run: String(m.run),
				base: String(m.base ?? ""),
				lora: typeof m.lora === "number" ? m.lora : null,
				temperature: Number(m.temperature ?? Number.NaN),
				backend: String(m.backend ?? ""),
				dtype: String(m.dtype ?? ""),
			};
			return true;
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

	private set(state: DecisionState, detail: string): void {
		if (this.current.state !== state || this.current.detail !== detail) {
			this.o.log[state === "retrying" ? "warn" : "info"](`decisions: ${state}`, { detail });
		}
		this.current = { state, detail };
	}
}
