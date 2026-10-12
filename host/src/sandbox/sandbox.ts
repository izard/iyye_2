// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs one command in a fresh rootless runc container (owner decision
 * 2026-10-12): Iyye tests a hypothesis by running code instead of theorizing.
 *
 * - **Isolation** is `config.ts`'s: no network, a read-only Alpine root, only
 *   the conversation's `/work` from the host, no capabilities, a fixed env.
 * - **Limits:** runc runs inside a transient systemd user scope, a delegated
 *   cgroup tree in which it creates the container's own cgroup with its
 *   memory and task limits (`config.ts`), so a memory hog or a fork bomb is
 *   contained by the kernel (verified by the smoke: the scope's own limits do
 *   not reach the container, which runc moves out of it); a wall-clock limit kills the
 *   container (`runc kill`, then `runc delete --force`), and so does the
 *   caller's abort (a turn stopped, background work giving way). These are
 *   resource bounds on Iyye's own experiment, not a limit on a model's
 *   answer: the turn goes on with what the run returned.
 * - **One run at a time**; output capped (head and tail kept); runc itself is
 *   spawned with a minimal environment (the host's own holds secrets).
 * - **Workspaces:** `/work` is per conversation scope and lasts the day: it
 *   is wiped when a night completes and on `/forget`; a full one refuses new
 *   runs until then.
 * - Unavailable (and said so) without Linux, runc, systemd-run, or a
 *   provisioned root that matches its manifest.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import { runConfig } from "./config.ts";
import { checkProvisioned, sandboxPaths } from "./provision.ts";

export interface SandboxLimits {
	timeoutS: number;
	memoryMb: number;
	tasks: number;
	cpuPercent: number;
	tmpMb: number;
	fileMb: number;
	workMb: number;
	outputChars: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
	timeoutS: 60,
	memoryMb: 1024,
	tasks: 128,
	cpuPercent: 200,
	tmpMb: 256,
	fileMb: 256,
	workMb: 512,
	outputChars: 6000,
};

export interface SandboxDeps {
	stateDir: string;
	log: Logger;
	runc?: string;
	/** `systemd-run` (the limits); null runs runc directly (tests only: the fake runc). */
	systemdRun?: string | null;
	limits?: Partial<SandboxLimits>;
	/** Skips the provisioning check (tests with a fake runc and a fake root). */
	skipManifestCheck?: boolean;
	uid?: number;
	gid?: number;
	/** `process.platform` (tests run the fake runc on any platform). */
	platform?: string;
}

export interface RunResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
	stopped: boolean;
	ms: number;
}

export class Sandbox {
	private readonly d: Required<Omit<SandboxDeps, "limits">> & { limits: SandboxLimits };
	private readonly paths: ReturnType<typeof sandboxPaths>;
	private chain: Promise<unknown> = Promise.resolve();
	private problem: string | null = "not checked yet";

	constructor(deps: SandboxDeps) {
		this.d = {
			runc: "runc",
			systemdRun: "systemd-run",
			skipManifestCheck: false,
			uid: process.getuid?.() ?? 1000,
			gid: process.getgid?.() ?? 1000,
			platform: process.platform,
			...deps,
			limits: { ...DEFAULT_LIMITS, ...deps.limits },
		};
		this.paths = sandboxPaths(deps.stateDir);
	}

	get limits(): SandboxLimits {
		return this.d.limits;
	}

	/** At startup: is it usable, and clear anything a crash left (containers, run bundles). */
	init(): string | null {
		this.problem = this.check();
		if (this.problem) return this.problem;
		this.cleanupStale();
		return null;
	}

	/** Why it cannot run (null: it can). */
	status(): string | null {
		return this.problem;
	}

	/** Run `/bin/sh -c command` in `scope`'s workspace. Queued behind any run in progress. */
	run(scope: string, command: string, signal?: AbortSignal): Promise<RunResult | { refused: string }> {
		const next = this.chain.then(() => this.runNow(scope, command, signal));
		this.chain = next.catch(() => undefined);
		return next;
	}

	/** A scope's workspace on the host (created on first use). */
	workDir(scope: string): string {
		const name = createHash("sha256").update(scope).digest("hex").slice(0, 24);
		return join(this.paths.work, name);
	}

	/** Every workspace goes (a completed night, `/forget`). */
	wipeAll(): void {
		rmSync(this.paths.work, { recursive: true, force: true });
	}

	private check(): string | null {
		if (this.d.platform !== "linux") return "only on Linux (runc)";
		for (const [bin, what] of [
			[this.d.runc, "runc"],
			...(this.d.systemdRun ? [[this.d.systemdRun, "systemd-run"]] : []),
		] as const) {
			try {
				execFileSync(bin, ["--version"], { stdio: "ignore", env: minimalEnv(), timeout: 10_000 });
			} catch {
				return `${what} is not available`;
			}
		}
		if (!this.d.skipManifestCheck) return checkProvisioned(this.d.stateDir);
		return null;
	}

	private async runNow(
		scope: string,
		command: string,
		signal?: AbortSignal,
	): Promise<RunResult | { refused: string }> {
		if (this.problem) return { refused: `the sandbox is not available: ${this.problem}` };
		if (signal?.aborted) return { refused: "stopped before it started" };
		const work = this.workDir(scope);
		mkdirSync(work, { recursive: true, mode: 0o700 });
		const used = dirBytes(work);
		if (used > this.d.limits.workMb * 1024 * 1024)
			return {
				refused: `the workspace is full (${Math.round(used / 1048576)} MB of ${this.d.limits.workMb}); delete files in /work, or wait for the night`,
			};
		const id = `iyye-${randomBytes(6).toString("hex")}`;
		const bundle = join(this.paths.runs, id);
		mkdirSync(bundle, { recursive: true, mode: 0o700 });
		mkdirSync(this.paths.state, { recursive: true, mode: 0o700 });
		const config = runConfig({
			// runc refuses a root given as a symlink: the real path.
			rootfs: realpathSync(this.paths.rootfs),
			work,
			args: ["/bin/sh", "-c", command],
			uid: this.d.uid,
			gid: this.d.gid,
			tmpMb: this.d.limits.tmpMb,
			fileMb: this.d.limits.fileMb,
			memoryMb: this.d.limits.memoryMb,
			tasks: this.d.limits.tasks,
		});
		writeFileSync(join(bundle, "config.json"), JSON.stringify(config), { mode: 0o600 });
		const runcArgs = ["--root", this.paths.state, "run", "--bundle", bundle, id];
		const L = this.d.limits;
		const [bin, args] = this.d.systemdRun
			? [
					this.d.systemdRun,
					[
						"--user",
						"--scope",
						"--quiet",
						"--collect",
						"-p",
						`MemoryMax=${L.memoryMb}M`,
						"-p",
						"MemorySwapMax=0",
						"-p",
						`TasksMax=${L.tasks}`,
						"-p",
						`CPUQuota=${L.cpuPercent}%`,
						"--",
						this.d.runc,
						...runcArgs,
					],
				]
			: [this.d.runc, runcArgs];
		const t0 = Date.now();
		const out = new Capture(L.outputChars);
		let timedOut = false;
		let stopped = false;
		const child: ChildProcess = spawn(bin, args, { env: minimalEnv(), stdio: ["ignore", "pipe", "pipe"] });
		child.stdout?.on("data", (b: Buffer) => out.add(b));
		child.stderr?.on("data", (b: Buffer) => out.add(b));
		// A kill before the container exists does nothing: repeat it until the run has ended.
		let again: NodeJS.Timeout | null = null;
		const kill = () => {
			this.runc(["kill", id, "KILL"]);
			again ??= setInterval(() => this.runc(["kill", id, "KILL"]), 1000);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, L.timeoutS * 1000);
		const onAbort = () => {
			stopped = true;
			kill();
		};
		signal?.addEventListener("abort", onAbort);
		const exitCode = await new Promise<number | null>((resolve) => {
			child.on("error", (err) => {
				out.add(Buffer.from(`\n(the sandbox could not start: ${err.message})\n`));
				resolve(null);
			});
			child.on("close", (code) => resolve(code));
		});
		clearTimeout(timer);
		if (again) clearInterval(again);
		signal?.removeEventListener("abort", onAbort);
		this.runc(["delete", "--force", id]);
		rmSync(bundle, { recursive: true, force: true });
		return {
			exitCode: timedOut || stopped ? null : exitCode,
			output: out.text(),
			timedOut,
			stopped,
			ms: Date.now() - t0,
		};
	}

	private runc(args: string[]): void {
		try {
			execFileSync(this.d.runc, ["--root", this.paths.state, ...args], {
				stdio: "ignore",
				env: minimalEnv(),
				timeout: 10_000,
			});
		} catch {
			// Already gone, or never started.
		}
	}

	/** Containers and bundles a crash left behind. */
	private cleanupStale(): void {
		if (existsSync(this.paths.state)) {
			let ids: string[] = [];
			try {
				ids = execFileSync(this.d.runc, ["--root", this.paths.state, "list", "-q"], {
					encoding: "utf8",
					env: minimalEnv(),
					timeout: 10_000,
				})
					.split("\n")
					.filter(Boolean);
			} catch {
				ids = [];
			}
			for (const id of ids) {
				this.runc(["kill", id, "KILL"]);
				this.runc(["delete", "--force", id]);
			}
			if (ids.length) this.d.log.warn("sandbox: removed containers left from before", { count: ids.length });
		}
		rmSync(this.paths.runs, { recursive: true, force: true });
	}
}

/** What runc and systemd-run are started with: nothing of the host process's own environment. */
function minimalEnv(): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
		...(process.env.DBUS_SESSION_BUS_ADDRESS
			? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
			: {}),
		...(process.env.HOME ? { HOME: process.env.HOME } : {}),
	};
}

function dirBytes(dir: string): number {
	let n = 0;
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = lstatSync(p);
			if (st.isDirectory()) walk(p);
			else n += st.size;
		}
	};
	try {
		walk(dir);
	} catch {
		// counted what could be read
	}
	return n;
}

/** Output kept within a cap: the head and the tail, with how much was cut between them. */
class Capture {
	private head = "";
	private tail = "";
	private dropped = 0;
	private readonly cap: number;
	constructor(cap: number) {
		this.cap = cap;
	}
	add(b: Buffer): void {
		const s = b.toString("utf8");
		const headCap = Math.floor(this.cap * 0.6);
		if (this.head.length < headCap) {
			const take = s.slice(0, headCap - this.head.length);
			this.head += take;
			this.addTail(s.slice(take.length));
		} else this.addTail(s);
	}
	private addTail(s: string): void {
		if (!s) return;
		const tailCap = this.cap - Math.floor(this.cap * 0.6);
		this.tail += s;
		if (this.tail.length > tailCap) {
			this.dropped += this.tail.length - tailCap;
			this.tail = this.tail.slice(-tailCap);
		}
	}
	text(): string {
		return this.dropped ? `${this.head}\n… (${this.dropped} characters cut) …\n${this.tail}` : this.head + this.tail;
	}
}
