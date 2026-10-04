// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * A long-running local service the host owns: the llama.cpp router (M2), the
 * Hindsight memory server (0.002 L1) and the Kev decision server (0.003 K1).
 *
 * Process rules, each one a lesson from the 1.x scripts:
 * - The host signals only the pid it spawned, or a pid it adopted after
 *   verifying its command line. Nothing is ever killed by port: the 1.x
 *   `lsof`-based stray kill could SIGKILL the Iyye process itself.
 * - If the port is taken by anything else, start fails and names the listener.
 * - The service runs in its own process group with output to a log file, so a
 *   terminal Ctrl-C reaches only the host (which stops the service in order)
 *   and a crashed host leaves a service that the next start can adopt.
 * - Its environment is exactly what the caller passes: nothing is inherited,
 *   so tokens and credentials in the host's environment never reach it.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { Logger } from "../log.ts";

export interface SupervisedOptions {
	/** Short name: pid file `<name>.pid.json`, logs `logs/<name>-<time>.log`, log messages. */
	name: string;
	command: string;
	args: string[];
	/**
	 * The complete child environment, or a function building it just before each
	 * spawn (for secrets created at startup). Nothing from the host's environment is added.
	 */
	env: Record<string, string> | (() => Record<string, string>);
	port: number;
	stateDir: string;
	healthUrl: string;
	/** Headers for the health check, e.g. a bearer key (built at each check). */
	healthHeaders?: () => Record<string, string>;
	/** Substrings that must all appear in a process's command line before it is adopted or signalled. */
	identity: string[];
	startTimeoutMs: number;
	stopGraceMs: number;
	log: Logger;
	/** Logs kept on disk, newest first. */
	keepLogs?: number;
}

interface PidRecord {
	pid: number;
	command: string;
	port: number;
	startedAt: string;
}

export class ProcessStartError extends Error {}

export class SupervisedProcess {
	private readonly opts: SupervisedOptions;
	private child: ChildProcess | null = null;
	private ownedPid: number | null = null;
	private exited = true;
	private lastLog: string | null = null;

	constructor(opts: SupervisedOptions) {
		this.opts = opts;
	}

	get pid(): number | null {
		return this.ownedPid;
	}

	get logPath(): string | null {
		return this.lastLog;
	}

	private get pidFile(): string {
		return join(this.opts.stateDir, `${this.opts.name}.pid.json`);
	}

	/** True while the process this host owns is running. */
	isAlive(): boolean {
		if (this.ownedPid === null) return false;
		if (this.child) return !this.exited;
		return pidAlive(this.ownedPid);
	}

	/**
	 * Adopt the process a previous host run left behind, if the pid file names a
	 * live process whose command line is ours. A stale or foreign pid file is
	 * removed without signalling anything. Returns true when adopted.
	 */
	tryAdopt(): boolean {
		let rec: PidRecord;
		try {
			rec = JSON.parse(readFileSync(this.pidFile, "utf8")) as PidRecord;
		} catch {
			return false;
		}
		if (Number.isInteger(rec.pid) && rec.pid > 1 && pidAlive(rec.pid) && this.commandLineIsOurs(rec.pid)) {
			this.ownedPid = rec.pid;
			this.child = null;
			this.exited = false;
			this.opts.log.info(`${this.opts.name}: adopted running process`, { pid: rec.pid });
			return true;
		}
		this.opts.log.warn(`${this.opts.name}: ignoring stale pid file`, { pid: rec.pid });
		rmSync(this.pidFile, { force: true });
		return false;
	}

	/** Spawn the service and wait until its health URL answers. */
	async start(): Promise<void> {
		const name = this.opts.name;
		if (this.isAlive()) throw new ProcessStartError(`${name} already running`);
		const listener = await portListener(this.opts.port);
		if (listener) {
			throw new ProcessStartError(`port ${this.opts.port} is already in use by ${listener}; not touching it`);
		}
		const logPath = this.openLogPath();
		this.lastLog = logPath;
		const fd = openSync(logPath, "a");
		let child: ChildProcess;
		try {
			child = spawn(this.opts.command, this.opts.args, {
				detached: true,
				stdio: ["ignore", fd, fd],
				env: typeof this.opts.env === "function" ? this.opts.env() : this.opts.env,
			});
		} finally {
			closeSync(fd);
		}
		const spawnError = new Promise<Error>((resolve) => child.once("error", resolve));
		child.once("exit", () => {
			this.exited = true;
		});
		child.unref();
		this.child = child;
		this.exited = false;
		const pid = await Promise.race([
			new Promise<number | undefined>((resolve) => child.once("spawn", () => resolve(child.pid))),
			spawnError.then((e) => {
				throw new ProcessStartError(`cannot start ${this.opts.command}: ${e.message}`);
			}),
		]);
		if (!pid) throw new ProcessStartError(`${name} spawned without a pid`);
		this.ownedPid = pid;
		const rec: PidRecord = {
			pid,
			command: this.opts.command,
			port: this.opts.port,
			startedAt: new Date().toISOString(),
		};
		writeFileSync(this.pidFile, JSON.stringify(rec));
		this.opts.log.info(`${name}: started`, { pid, port: this.opts.port, log: logPath });

		const deadline = Date.now() + this.opts.startTimeoutMs;
		while (Date.now() < deadline) {
			if (!this.isAlive()) {
				this.forget();
				throw new ProcessStartError(`${name} exited during startup (see ${logPath})`);
			}
			if (await httpOk(this.opts.healthUrl, this.opts.healthHeaders?.())) return;
			await sleep(200);
		}
		await this.stop();
		throw new ProcessStartError(
			`${name} did not become healthy within ${this.opts.startTimeoutMs} ms (see ${logPath})`,
		);
	}

	/** SIGTERM, then SIGKILL after the grace period. A no-op when the host owns no process. */
	async stop(): Promise<void> {
		const pid = this.ownedPid;
		if (pid === null) return;
		if (!this.child && !(pidAlive(pid) && this.commandLineIsOurs(pid))) {
			// An adopted pid that died or was reused by another program: never signal it.
			this.forget();
			return;
		}
		if (this.isAlive()) {
			trySignal(pid, "SIGTERM");
			const deadline = Date.now() + this.opts.stopGraceMs;
			while (this.isAlive() && Date.now() < deadline) await sleep(100);
			if (this.isAlive()) {
				this.opts.log.warn(`${this.opts.name}: did not exit after SIGTERM, sending SIGKILL`, { pid });
				trySignal(pid, "SIGKILL");
				const killDeadline = Date.now() + 5000;
				while (this.isAlive() && Date.now() < killDeadline) await sleep(50);
			}
		}
		this.opts.log.info(`${this.opts.name}: stopped`, { pid });
		this.forget();
	}

	private forget(): void {
		this.ownedPid = null;
		this.child = null;
		this.exited = true;
		rmSync(this.pidFile, { force: true });
	}

	private commandLineIsOurs(pid: number): boolean {
		const cmd = processCommandLine(pid);
		return cmd !== null && this.opts.identity.every((part) => cmd.includes(part));
	}

	private openLogPath(): string {
		const dir = join(this.opts.stateDir, "logs");
		mkdirSync(dir, { recursive: true });
		const keep = this.opts.keepLogs ?? 5;
		const old = readdirSync(dir)
			.filter((f) => f.startsWith(`${this.opts.name}-`) && f.endsWith(".log"))
			.sort()
			.reverse();
		for (const f of old.slice(keep - 1)) unlinkSync(join(dir, f));
		return join(dir, `${this.opts.name}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
	}
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// already gone
	}
}

function processCommandLine(pid: number): string | null {
	try {
		return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
}

/** "pid 123 (llama-server)" when something listens on the port, else null. */
export async function portListener(port: number): Promise<string | null> {
	const open = await new Promise<boolean>((resolve) => {
		const sock = createConnection({ host: "127.0.0.1", port });
		sock.once("connect", () => {
			sock.destroy();
			resolve(true);
		});
		sock.once("error", () => resolve(false));
	});
	if (!open) return null;
	try {
		const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { encoding: "utf8" });
		const pid = /^p(\d+)$/m.exec(out)?.[1];
		const name = /^c(.+)$/m.exec(out)?.[1];
		if (pid) return `pid ${pid}${name ? ` (${name})` : ""}`;
	} catch {
		// lsof unavailable or no permission
	}
	return "another process";
}

async function httpOk(url: string, headers?: Record<string, string>): Promise<boolean> {
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
		await res.body?.cancel();
		return res.ok;
	} catch {
		return false;
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
