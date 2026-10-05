// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The one llama.cpp router process the host owns (plan M2). Process
 * supervision (ownership, adoption, port checks, minimal environment) is the
 * shared `SupervisedProcess`; this file adds the router's command line.
 *
 * `--models-max 0` disables the router's own model cap. With a cap, builds
 * 9542 and 11362 silently evict a loaded model (even one a job is using, and
 * even for a load that then fails). The host enforces the cap instead.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import { ProcessStartError, SupervisedProcess } from "../process/supervised.ts";

export { pidAlive } from "../process/supervised.ts";
export { ProcessStartError as RouterStartError };

export interface RouterOptions {
	command: string;
	/** Arguments placed before the router flags (tests run a fake router script through node). */
	argsPrefix: string[];
	port: number;
	presetPath: string;
	stateDir: string;
	startTimeoutMs: number;
	stopGraceMs: number;
	log: Logger;
	/** Router logs kept on disk, newest first. */
	keepLogs?: number;
}

export class RouterProcess {
	private readonly proc: SupervisedProcess;
	private readonly port: number;

	constructor(opts: RouterOptions) {
		this.port = opts.port;
		const cacheDir = join(opts.stateDir, "llama-cache");
		this.proc = new SupervisedProcess({
			name: "router",
			command: opts.command,
			args: [
				...opts.argsPrefix,
				"--models-preset",
				opts.presetPath,
				"--no-models-autoload",
				"--models-max",
				"0",
				// Proxy read/write timeout to the model servers: a slow model must never be cut off (owner
				// directive: long answers are fine; a timed-out one is not). Default 3600 s of silence.
				"--timeout",
				"86400",
				"--host",
				"127.0.0.1",
				"--port",
				String(opts.port),
			],
			// Model processes inherit this environment: keep it minimal (no tokens or credentials).
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", LLAMA_CACHE: cacheDir },
			port: opts.port,
			stateDir: opts.stateDir,
			healthUrl: `http://127.0.0.1:${opts.port}/health`,
			identity: [opts.argsPrefix[0] ?? opts.command, `--models-preset ${opts.presetPath}`, `--port ${opts.port}`],
			startTimeoutMs: opts.startTimeoutMs,
			stopGraceMs: opts.stopGraceMs,
			log: opts.log,
			keepLogs: opts.keepLogs,
		});
		this.ensureCache = () => mkdirSync(cacheDir, { recursive: true });
	}

	private readonly ensureCache: () => void;

	get pid(): number | null {
		return this.proc.pid;
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	isAlive(): boolean {
		return this.proc.isAlive();
	}

	tryAdopt(): boolean {
		return this.proc.tryAdopt();
	}

	start(): Promise<void> {
		this.ensureCache();
		return this.proc.start();
	}

	stop(): Promise<void> {
		return this.proc.stop();
	}
}
