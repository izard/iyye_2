// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic local model management (plan M2): load, unload, select, and
 * keep the router alive. No LLM is involved in any of these decisions.
 *
 * - One model operation at a time. Every operation, including refusals, is
 *   recorded in `model_ops`.
 * - No automatic eviction: a load that does not fit (RAM or model count) is
 *   refused with a reason, and the owner decides what to unload.
 * - A model in use by a job (an acquired lease) cannot be unloaded.
 * - Selection changes take effect at the next job boundary: a job binds its
 *   model when it starts (M7), and a running job keeps its lease.
 * - If the router dies, every lease is invalidated, listeners are told, and
 *   the router is restarted with backoff and the selected models reloaded.
 *   Failing the affected jobs is the scheduler's job (M7).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import {
	abandonRunningModelOps,
	DAY_KEYS,
	finishModelOp,
	getSelectedModel,
	MODEL_CHANNELS,
	type ModelOpKind,
	type ModelOpRow,
	recentModelOps,
	SELECTION_KEYS,
	type SelectionKey,
	seedSelectedModel,
	setSelectedModel,
	startModelOp,
} from "../state/models.ts";
import { type RouterClient, type RouterModelStatus, RouterUnreachable } from "./client.ts";
import type { MemoryProbe } from "./memory.ts";
import { renderPreset } from "./preset.ts";
import { findModel, type ModelSpec, type Registry } from "./registry.ts";
import type { RemoteModels } from "./remote.ts";

/** The parts of RouterProcess the manager uses (a fake in tests). */
export interface RouterHandle {
	readonly pid: number | null;
	isAlive(): boolean;
	tryAdopt(): boolean;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface ModelManagerDeps {
	db: Db;
	registry: Registry;
	router: RouterHandle;
	client: RouterClient;
	memory: MemoryProbe;
	stateDir: string;
	modelsMax: number;
	defaultModel: string;
	/** Initial model for long-term memory work (0.002 L2); loaded on demand by the memory gate, not at startup. */
	defaultMemoryModel?: string;
	/** Initial model for background work (0.007); loaded by day like the chat models. */
	defaultBackgroundModel?: string;
	/** llama.cpp `--load-mode` for every model (IYYE2_LLAMA_LOAD_MODE). */
	loadMode?: string | null;
	/** A model another of the owner's machines serves (plan 0.012), for background work only. */
	remote?: Pick<RemoteModels, "has" | "acquire" | "status" | "endpoint"> | null;
	log: Logger;
	now?: () => Date;
	newId?: () => string;
	healthIntervalMs?: number;
	pollIntervalMs?: number;
	/** Load deadline = max(startup_s × factor, minimum). */
	loadTimeoutFactor?: number;
	minLoadTimeoutMs?: number;
	unloadTimeoutMs?: number;
	/** Delays between router restart attempts; the last one repeats. */
	restartBackoffMs?: number[];
	/**
	 * Self-healing (2026-10-05 incident): delays before each attempt to load a
	 * day-selected model that is not loaded; its length is the number of
	 * attempts before Iyye gives up and says so.
	 */
	healBackoffMs?: number[];
	/** The clock load and unload deadlines are measured with (see `AwakeStopwatch`); for tests. */
	monotonicMs?: () => number;
}

export interface OpResult {
	ok: boolean;
	message: string;
	/** A refusal that will clear by itself (e.g. a model is loading): callers should wait, not fail. */
	busy?: boolean;
}

export type RouterState = "stopped" | "starting" | "up" | "restarting";

export interface ModelLease {
	readonly model: string;
	/** False once the lease was released or the router was lost after it was taken. */
	valid(): boolean;
	release(): void;
}

export interface ModelStatusView {
	name: string;
	available: boolean;
	status: string;
	failed: boolean;
	inUse: number;
	ramRequiredGb: number;
	selectedFor: SelectionKey[];
	description: string;
}

export interface ManagerStatus {
	router: RouterState;
	routerPid: number | null;
	availableRamGb: number | null;
	modelsMax: number;
	models: ModelStatusView[];
	recentOps: ModelOpRow[];
}

const LOADED_LIKE = new Set(["loaded", "loading", "sleeping"]);

export class ModelManager {
	private readonly d: Required<ModelManagerDeps>;
	private routerState: RouterState = "stopped";
	private statuses = new Map<string, RouterModelStatus>();
	private readonly inUse = new Map<string, number>();
	private readonly changing = new Set<string>();
	/** Models being loaded. A load uses the device, so no inference is admitted meanwhile (HLD §5.1). */
	private readonly loading = new Set<string>();
	private generation = 0;
	private opChain: Promise<unknown> = Promise.resolve();
	private healthTimer: NodeJS.Timeout | null = null;
	private healthRunning = false;
	private stopping = false;
	private readonly lostListeners: ((lostModels: string[]) => void)[] = [];
	/** Asleep (plan 0.002): only these models may stay loaded; reloads after a router restart load only them. */
	private nightKeep: Set<string> | null = null;
	/** Day-selected models that failed to load: attempts so far, when the next one may start, why the last failed. */
	private readonly heal = new Map<string, { attempts: number; nextAt: number; lastError: string }>();
	/** Models the owner unloaded by hand today: never reloaded behind their back (until waking or /load). */
	private readonly ownerUnloaded = new Set<string>();
	private healRunning = false;

	constructor(deps: ModelManagerDeps) {
		this.d = {
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			healthIntervalMs: 30_000,
			pollIntervalMs: 500,
			loadTimeoutFactor: 3,
			minLoadTimeoutMs: 60_000,
			unloadTimeoutMs: 45_000,
			restartBackoffMs: [1000, 5000, 30_000],
			healBackoffMs: [0, 60_000, 120_000, 300_000, 600_000, 900_000],
			monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n), // counts sleep on macOS: see AwakeStopwatch
			defaultMemoryModel: "",
			defaultBackgroundModel: "",
			...deps,
			loadMode: deps.loadMode ?? null,
			remote: deps.remote ?? null,
		};
	}

	/** Called with the models that were loaded when the router was lost. */
	onRouterLost(listener: (lostModels: string[]) => void): void {
		this.lostListeners.push(listener);
	}

	get state(): RouterState {
		return this.routerState;
	}

	/**
	 * Write the preset, adopt or start the router, load the selected models,
	 * and begin health checks. A model that cannot load (missing file, no RAM)
	 * does not stop the host; the reason is recorded and shown.
	 */
	async start(): Promise<void> {
		const at = this.iso();
		abandonRunningModelOps(this.d.db, at);
		for (const channel of MODEL_CHANNELS) {
			if (findModel(this.d.registry, this.d.defaultModel)) {
				seedSelectedModel(this.d.db, channel, this.d.defaultModel, at);
			}
		}
		const memoryModel = this.d.defaultMemoryModel;
		if (memoryModel && findModel(this.d.registry, memoryModel))
			seedSelectedModel(this.d.db, "memory", memoryModel, at);
		const backgroundModel = this.d.defaultBackgroundModel;
		if (backgroundModel && findModel(this.d.registry, backgroundModel))
			seedSelectedModel(this.d.db, "background", backgroundModel, at);
		if (!findModel(this.d.registry, this.d.defaultModel)) {
			this.d.log.warn("models: default model is not in the registry", { model: this.d.defaultModel });
		}
		const presetPath = join(this.d.stateDir, "models.ini");
		const preset = renderPreset(this.d.registry, { loadMode: this.d.loadMode });
		let previous: string | null = null;
		try {
			previous = readFileSync(presetPath, "utf8");
		} catch {
			// first start
		}
		// Reuse a router left by a previous host run only if it was started with
		// this exact preset and still answers; otherwise stop it (it is verified ours).
		let reuse = false;
		if (this.d.router.tryAdopt()) {
			reuse = previous === preset && (await this.refresh());
			if (!reuse) {
				await this.recordOp("router_stop", null, "system", async () => {
					await this.d.router.stop();
					return { ok: true, message: "stopped adopted router: registry changed or not answering" };
				});
			}
		}
		writeFileSync(presetPath, preset);
		this.routerState = "starting";
		if (!reuse) {
			const started = await this.startRouter("system");
			if (!started.ok) {
				// Health checks keep retrying with backoff; the host stays up and says why.
				this.routerState = "restarting";
				this.scheduleHealth();
				return;
			}
		}
		if (this.stopping) return;
		this.routerState = "up";
		await this.loadSelected("system");
		this.scheduleHealth();
	}

	/** Stop health checks and the router (its model processes exit with it). */
	async stop(): Promise<void> {
		this.stopping = true;
		if (this.healthTimer) clearTimeout(this.healthTimer);
		this.healthTimer = null;
		await this.exclusive(async () => {
			if (this.d.router.pid !== null) {
				await this.recordOp("router_stop", null, "system", async () => {
					await this.d.router.stop();
					return { ok: true, message: "stopped" };
				});
			}
			this.routerState = "stopped";
			this.invalidateLeases();
			this.statuses.clear();
		});
	}

	load(name: string, requestedBy: string): Promise<OpResult> {
		return this.exclusive(() => this.doLoad(name, requestedBy));
	}

	unload(name: string, requestedBy: string): Promise<OpResult> {
		return this.exclusive(async () => {
			const r = await this.doUnload(name, requestedBy);
			// The owner unloaded it on purpose: self-healing leaves it alone until waking or /load.
			if (r.ok && requestedBy.startsWith("owner")) this.ownerUnloaded.add(name);
			return r;
		});
	}

	/** Restart the router; loaded models are reloaded if they are selected. */
	restartRouter(requestedBy: string): Promise<OpResult> {
		return this.exclusive(async () => {
			const lost = this.loadedModels();
			this.invalidateLeases();
			await this.recordOp("router_stop", null, requestedBy, async () => {
				await this.d.router.stop();
				return { ok: true, message: "stopped for restart" };
			});
			this.notifyLost(lost);
			this.routerState = "restarting";
			const started = await this.startRouter(requestedBy);
			if (!started.ok) return started;
			this.routerState = "up";
			await this.loadSelectedLocked(requestedBy);
			return { ok: true, message: "router restarted" };
		});
	}

	/**
	 * Select the model a channel's next jobs use (it must be loaded), or the
	 * model for memory work (it only needs to be available: the memory gate
	 * loads it on demand, as device work).
	 */
	async select(channel: SelectionKey, name: string, setBy: string): Promise<OpResult> {
		if (!SELECTION_KEYS.includes(channel)) return { ok: false, message: `unknown channel ${channel}` };
		const spec = findModel(this.d.registry, name);
		if (!spec) return { ok: false, message: `unknown model ${name}` };
		if (spec.remote) {
			// Plan 0.012, owner decision 1: another machine's model takes background work only.
			if (channel !== "background")
				return {
					ok: false,
					message: `${name} runs on ${spec.remote.endpoint}: it can be used for background work only`,
				};
			setSelectedModel(this.d.db, channel, name, setBy, this.iso());
			const s = this.d.remote?.status;
			return {
				ok: true,
				message: `background work now uses ${name}${s && s.state !== "up" ? ` (${spec.remote.endpoint} is ${s.state}: it waits until it is up)` : ""}`,
			};
		}
		if (channel === "memory") {
			if (!spec.available) return { ok: false, message: `${name}: GGUF file missing` };
			setSelectedModel(this.d.db, "memory", name, setBy, this.iso());
			return { ok: true, message: `memory work now uses ${name} (loaded when memory work needs it)` };
		}
		if (!(await this.refresh())) return { ok: false, message: "the model router is not responding" };
		if (this.changing.has(name) || this.statuses.get(name)?.value !== "loaded") {
			return { ok: false, message: `${name} is not loaded; /load it first` };
		}
		setSelectedModel(this.d.db, channel, name, setBy, this.iso());
		return { ok: true, message: `${channel} now uses ${name} from its next message` };
	}

	/** Models loaded as of the last router check (every lease and status refreshes it); none while the router is not up. */
	loadedNow(): string[] {
		if (this.routerState !== "up") return [];
		return this.d.registry.models.filter((m) => this.statuses.get(m.name)?.value === "loaded").map((m) => m.name);
	}

	selected(channel: SelectionKey): string | null {
		return getSelectedModel(this.d.db, channel);
	}

	/**
	 * Take a lease on a loaded model for one job. Refused while the router is
	 * down or the model is not loaded, loading or being unloaded: the caller
	 * waits or fails the job; it never substitutes another model.
	 */
	async acquire(name: string): Promise<ModelLease | OpResult> {
		// Another machine's model: its own availability, untouched by this router, its loads and its health.
		if (this.isRemote(name))
			return (
				this.d.remote?.acquire(name) ?? { ok: false, busy: true, message: `${name}: its machine is not configured` }
			);
		if (this.routerState !== "up") return { ok: false, message: "the model router is not running" };
		if (this.loading.size > 0) return this.busyLoading();
		if (this.changing.has(name)) return { ok: false, message: `${name} is being loaded or unloaded` };
		// Never lease on cached status: if the router does not answer now, the model is not usable.
		if (!(await this.refresh())) return { ok: false, message: "the model router is not responding" };
		// Re-check after the await: an unload or a load may have started meanwhile.
		if (this.routerState !== "up") return { ok: false, message: "the model router is not running" };
		if (this.loading.size > 0) return this.busyLoading();
		if (this.changing.has(name)) return { ok: false, message: `${name} is being loaded or unloaded` };
		if (this.statuses.get(name)?.value !== "loaded") {
			// A day-selected model that should be loaded is being loaded again: callers wait, as for a load.
			const h = this.healingState(name);
			if (h?.retrying) {
				this.healSelected();
				return { ok: false, busy: true, message: `${name} is not loaded; ${h.message}` };
			}
			return { ok: false, message: h ? `${name} is not loaded: ${h.message}` : `${name} is not loaded` };
		}
		const gen = this.generation;
		let released = false;
		this.inUse.set(name, (this.inUse.get(name) ?? 0) + 1);
		return {
			model: name,
			valid: () => !released && gen === this.generation,
			release: () => {
				if (released) return;
				released = true;
				if (gen !== this.generation) return;
				const n = (this.inUse.get(name) ?? 1) - 1;
				if (n <= 0) this.inUse.delete(name);
				else this.inUse.set(name, n);
			},
		};
	}

	/**
	 * Self-preservation's maintenance (plan 0.010 M1): after self-healing gave
	 * up on a selected model, start its attempts afresh. Never for a model the
	 * owner unloaded or while asleep; the actor allows it once a day per model.
	 */
	retryHeal(name: string): boolean {
		const h = this.healingState(name);
		if (!h || h.retrying) return false;
		this.heal.delete(name);
		this.healSelected();
		return true;
	}

	/** Self-healing as it stands (read-only, plan 0.010 signals): each model being brought back, and whether Iyye gave up. */
	healingReport(): { model: string; attempts: number; gaveUp: boolean; lastError: string }[] {
		return [...this.heal].map(([model, h]) => ({
			model,
			attempts: h.attempts,
			gaveUp: h.attempts >= this.d.healBackoffMs.length,
			lastError: h.lastError,
		}));
	}

	private busyLoading(): OpResult {
		return { ok: false, busy: true, message: `waiting for ${[...this.loading].join(", ")} to finish loading` };
	}

	async status(): Promise<ManagerStatus> {
		if (this.routerState === "up") await this.refresh();
		let availableRamGb: number | null = null;
		try {
			availableRamGb = this.d.memory();
		} catch {
			// shown as unknown
		}
		const selections = new Map<string, SelectionKey[]>();
		for (const channel of SELECTION_KEYS) {
			const m = getSelectedModel(this.d.db, channel);
			if (m) selections.set(m, [...(selections.get(m) ?? []), channel]);
		}
		return {
			router: this.routerState,
			routerPid: this.d.router.pid,
			availableRamGb,
			modelsMax: this.d.modelsMax,
			models: this.d.registry.models.map((m) => {
				const s = this.statuses.get(m.name);
				return {
					name: m.name,
					available: m.available,
					status: m.remote
						? `on ${m.remote.endpoint}: ${this.d.remote?.status.state ?? "not configured"}`
						: !m.available
							? "unavailable"
							: this.routerState !== "up"
								? "unknown"
								: (s?.value ?? "unknown"),
					failed: s?.failed ?? false,
					inUse: this.inUse.get(m.name) ?? 0,
					ramRequiredGb: m.ramRequiredGb,
					selectedFor: selections.get(m.name) ?? [],
					description: m.description,
				};
			}),
			recentOps: recentModelOps(this.d.db),
		};
	}

	// ---------------------------------------------------------------- internals

	private async doLoad(name: string, requestedBy: string): Promise<OpResult> {
		const spec = findModel(this.d.registry, name);
		if (!spec) return this.refuse("load", name, requestedBy, `unknown model ${name}`);
		if (spec.remote)
			return this.refuse(
				"load",
				name,
				requestedBy,
				`${name} is served by ${spec.remote.endpoint}; Iyye never loads it`,
			);
		if (!spec.available) return this.refuse("load", name, requestedBy, `${name}: GGUF file missing (${spec.path})`);
		if (this.routerState !== "up") return this.refuse("load", name, requestedBy, "the model router is not running");
		if (!(await this.refresh())) return this.refuse("load", name, requestedBy, "the model router is not responding");
		const current = this.statuses.get(name);
		if (current?.value === "loaded") return { ok: true, message: `${name} is already loaded` };
		const loaded = this.loadedModels().filter((m) => m !== name);
		if (loaded.length >= this.d.modelsMax) {
			return this.refuse(
				"load",
				name,
				requestedBy,
				`at most ${this.d.modelsMax} model(s) may be loaded; unload one of: ${loaded.join(", ")}`,
			);
		}
		let reclaimable: number;
		try {
			reclaimable = this.d.memory();
		} catch (err) {
			return this.refuse("load", name, requestedBy, `cannot measure free memory: ${(err as Error).message}`);
		}
		// The OS figure does not fully reflect models already loaded: llama.cpp maps its
		// weights from the file, and on macOS those pages largely still count as
		// reclaimable (measured: loading gemma-4-E4B, 8.9 GB resident, lowered the
		// figure by only 2.7 GB). Subtract each loaded model's registry size as well;
		// this over-reserves somewhat, which is the safe direction.
		const heldGb = loaded.reduce((sum, m) => sum + (findModel(this.d.registry, m)?.ramRequiredGb ?? 0), 0);
		const available = reclaimable - heldGb;
		if (spec.ramRequiredGb > available) {
			const held = loaded.map((m) => `${m} (${findModel(this.d.registry, m)?.ramRequiredGb ?? "?"} GB)`);
			return this.refuse(
				"load",
				name,
				requestedBy,
				`${name} needs ${spec.ramRequiredGb} GB but only ${Math.max(available, 0).toFixed(1)} GB is available` +
					(held.length > 0
						? ` (${reclaimable.toFixed(1)} GB reclaimable minus ${heldGb} GB for loaded models); loaded: ${held.join(", ")}`
						: ""),
			);
		}
		const r = await this.recordOp("load", name, requestedBy, () => this.loadAndVerify(spec));
		if (r.ok) {
			this.heal.delete(name);
			this.ownerUnloaded.delete(name);
		}
		return r;
	}

	private async loadAndVerify(spec: ModelSpec): Promise<OpResult> {
		const name = spec.name;
		this.changing.add(name);
		this.loading.add(name);
		try {
			if (this.statuses.get(name)?.value !== "loading") {
				const reply = await this.d.client.load(name);
				if (!reply.ok) {
					// Decide from the reported status, not the error text ("already running" while loading is fine).
					await this.refresh();
					const v = this.statuses.get(name)?.value;
					if (v !== "loading" && v !== "loaded") return { ok: false, message: `router refused: ${reply.message}` };
				}
			}
			const timeoutMs = Math.max(spec.startupS * 1000 * this.d.loadTimeoutFactor, this.d.minLoadTimeoutMs);
			// Awake time, not wall time: a sleeping computer must not make a load "time out".
			const awake = new AwakeStopwatch(this.d.monotonicMs, this.awakeStepMs());
			let sawLoading = false;
			while (awake.elapsed() < timeoutMs) {
				await sleep(this.d.pollIntervalMs);
				if (this.stopping) return { ok: false, message: `${name}: load abandoned because the host is stopping` };
				const s = (await this.d.client.listModels()).get(name);
				this.statuses.set(name, s ?? { value: "unknown", failed: false, exitCode: null });
				if (s?.value === "loaded") {
					const probe = await this.d.client.probeCompletion(name);
					if (probe.ok) return { ok: true, message: `${name} loaded` };
					await this.d.client.unload(name).catch(() => undefined);
					return { ok: false, message: `${name} loaded but did not answer a test request: ${probe.message}` };
				}
				if (s?.value === "loading") sawLoading = true;
				// A stale `failed` flag from an earlier attempt can linger for a moment after the POST.
				if (s?.value === "unloaded" && (sawLoading || (s.failed && awake.elapsed() > 2000))) {
					return {
						ok: false,
						message: `${name} failed to load${s.exitCode !== null ? ` (exit code ${s.exitCode})` : ""}; see the router log`,
					};
				}
			}
			await this.d.client.unload(name).catch(() => undefined);
			return { ok: false, message: `${name} did not finish loading within ${Math.round(timeoutMs / 1000)} s` };
		} finally {
			this.changing.delete(name);
			this.loading.delete(name);
			await this.refresh();
		}
	}

	private async doUnload(name: string, requestedBy: string): Promise<OpResult> {
		if (!findModel(this.d.registry, name)) return this.refuse("unload", name, requestedBy, `unknown model ${name}`);
		if (this.isRemote(name))
			return this.refuse("unload", name, requestedBy, `${name} is served by another machine; Iyye never unloads it`);
		const busy = this.inUse.get(name) ?? 0;
		if (busy > 0) return this.refuse("unload", name, requestedBy, `${name} is in use by ${busy} running job(s)`);
		if (this.routerState !== "up") return this.refuse("unload", name, requestedBy, "the model router is not running");
		if (!(await this.refresh()))
			return this.refuse("unload", name, requestedBy, "the model router is not responding");
		if (!LOADED_LIKE.has(this.statuses.get(name)?.value ?? "")) return { ok: true, message: `${name} is not loaded` };
		// Check for leases and mark the model as changing in one synchronous step,
		// so an acquire that raced the awaits above cannot slip a lease in.
		const stillBusy = this.inUse.get(name) ?? 0;
		if (stillBusy > 0)
			return this.refuse("unload", name, requestedBy, `${name} is in use by ${stillBusy} running job(s)`);
		this.changing.add(name);
		return this.recordOp("unload", name, requestedBy, async () => {
			try {
				const reply = await this.d.client.unload(name);
				const awake = new AwakeStopwatch(this.d.monotonicMs, this.awakeStepMs());
				while (awake.elapsed() < this.d.unloadTimeoutMs && !this.stopping) {
					const s = (await this.d.client.listModels()).get(name);
					if (!s || s.value === "unloaded") {
						const selectedBy = DAY_KEYS.filter((c) => getSelectedModel(this.d.db, c) === name);
						return {
							ok: true,
							message:
								`${name} unloaded` +
								(selectedBy.length > 0 ? `; ${selectedBy.join(" and ")} now has no loaded model` : ""),
						};
					}
					if (!reply.ok && s.value === "loaded") return { ok: false, message: `router refused: ${reply.message}` };
					await sleep(this.d.pollIntervalMs);
				}
				return { ok: false, message: `${name} did not unload within ${this.d.unloadTimeoutMs / 1000} s` };
			} finally {
				this.changing.delete(name);
				await this.refresh();
			}
		});
	}

	/**
	 * Falling asleep: unload every model except `keep` (the memory model), so
	 * the night has the device and RAM to itself. A model still in use is left
	 * loaded and reported. Owner `/load` still works at night.
	 */
	restForNight(keep: string[], requestedBy: string): Promise<OpResult> {
		return this.exclusive(async () => {
			this.nightKeep = new Set(keep);
			await this.refresh();
			const unloaded: string[] = [];
			const kept: string[] = [];
			for (const name of this.loadedModels()) {
				if (this.nightKeep.has(name)) continue;
				const r = await this.doUnload(name, requestedBy);
				(r.ok ? unloaded : kept).push(r.ok ? name : `${name} (${r.message})`);
			}
			return {
				ok: kept.length === 0,
				message: `unloaded for the night: ${unloaded.join(", ") || "nothing"}${kept.length ? `; still loaded: ${kept.join(", ")}` : ""}`,
			};
		});
	}

	/**
	 * Waking: unload what only the night needed (a model no day selection
	 * picks), then load the chat channels' and background work's models again.
	 */
	wakeFromNight(requestedBy: string): Promise<OpResult> {
		return this.exclusive(async () => {
			this.nightKeep = null;
			this.ownerUnloaded.clear();
			this.heal.clear();
			await this.refresh();
			const chat = new Set(this.daySelected());
			for (const name of this.loadedModels()) {
				if (!chat.has(name)) await this.doUnload(name, requestedBy);
			}
			await this.loadSelectedLocked(requestedBy);
			const missing = [...chat].filter((m) => this.statuses.get(m)?.value !== "loaded");
			return missing.length
				? { ok: false, message: `not loaded after waking: ${missing.join(", ")}` }
				: { ok: true, message: `loaded for the day: ${[...chat].join(", ")}` };
		});
	}

	private async loadSelected(requestedBy: string): Promise<void> {
		await this.exclusive(() => this.loadSelectedLocked(requestedBy));
	}

	/** Load each day selection's model once (chat channels, background); failures are recorded, not thrown. */
	private async loadSelectedLocked(requestedBy: string): Promise<void> {
		const wanted = new Set(this.daySelected());
		if (this.nightKeep) {
			// Asleep: the chat models come back at waking; the memory model is loaded on demand by the gate.
			this.d.log.info("models: asleep, not reloading chat models", { wanted: [...wanted] });
			return;
		}
		for (const name of wanted) {
			if (this.stopping) return;
			const r = await this.doLoad(name, requestedBy);
			if (!r.ok) {
				this.d.log.warn("models: selected model not loaded", { model: name, reason: r.message });
				this.noteHealFailure(name, r.message);
			}
		}
	}

	private async startRouter(requestedBy: string): Promise<OpResult> {
		return this.recordOp("router_start", null, requestedBy, async () => {
			await this.d.router.start();
			if (!(await this.refresh())) return { ok: false, message: "router started but GET /models failed" };
			return { ok: true, message: "started" };
		});
	}

	/**
	 * Self-healing: by day, a model a chat channel or background work is
	 * selected to use, that is not loaded, is loaded again with backoff
	 * (`healBackoffMs`), unless the owner unloaded it by hand. Runs from the
	 * health check and when a job asks for the model; one attempt at a time,
	 * through the same exclusive chain as every model operation.
	 */
	private healSelected(): void {
		if (this.healRunning || this.stopping || this.nightKeep || this.routerState !== "up") return;
		const now = this.d.monotonicMs();
		const due = this.daySelected().filter((name) => {
			const h = this.healingState(name);
			return h?.retrying && (this.heal.get(name)?.nextAt ?? 0) <= now;
		});
		if (due.length === 0) return;
		this.healRunning = true;
		void this.exclusive(async () => {
			for (const name of due) {
				if (this.stopping || this.nightKeep) return;
				await this.refresh();
				if (LOADED_LIKE.has(this.statuses.get(name)?.value ?? "") || this.changing.has(name)) continue;
				// Decided before the queue reached this step: the owner may have unloaded it meanwhile, or the
				// selection changed. Ask again now.
				if (!this.healingState(name)?.retrying) continue;
				this.d.log.warn("models: a selected model is not loaded; loading it again", {
					model: name,
					attempt: (this.heal.get(name)?.attempts ?? 0) + 1,
				});
				const r = await this.doLoad(name, "self_heal");
				if (!r.ok) this.noteHealFailure(name, r.message);
			}
		})
			.catch((err) => this.d.log.error("models: self-healing failed", { error: (err as Error).message }))
			.finally(() => {
				this.healRunning = false;
			});
	}

	/** The most one poll may add to a deadline: a longer gap means the process was frozen (the computer slept). */
	private awakeStepMs(): number {
		return Math.max(5000, this.d.pollIntervalMs * 10);
	}

	private noteHealFailure(name: string, message: string): void {
		const attempts = (this.heal.get(name)?.attempts ?? 0) + 1;
		const delay = this.d.healBackoffMs[attempts] ?? 0;
		this.heal.set(name, { attempts, nextAt: this.d.monotonicMs() + delay, lastError: message });
	}

	/**
	 * The models the day needs loaded on this machine: the chat channels' and background work's selections.
	 * Another machine's model is not among them: never loaded, unloaded at night or healed here.
	 */
	private daySelected(): string[] {
		return [
			...new Set(
				DAY_KEYS.map((c) => getSelectedModel(this.d.db, c)).filter(
					(m): m is string => m !== null && !this.isRemote(m),
				),
			),
		];
	}

	/** Whether a model is served by another of the owner's machines (plan 0.012). */
	isRemote(name: string): boolean {
		return findModel(this.d.registry, name)?.remote !== undefined;
	}

	/**
	 * Whether Iyye is bringing a model back: null for a model it is not
	 * responsible for (not selected by day, asleep, or unloaded by the owner);
	 * otherwise `retrying`, or given up after every attempt failed.
	 */
	private healingState(name: string): { retrying: boolean; message: string } | null {
		if (this.nightKeep || this.ownerUnloaded.has(name) || !this.daySelected().includes(name)) return null;
		const h = this.heal.get(name);
		const max = this.d.healBackoffMs.length;
		if (!h) return { retrying: true, message: "loading it again" };
		if (h.attempts >= max)
			return {
				retrying: false,
				message: `it could not be loaded after ${h.attempts} attempts (last: ${h.lastError}); /load it`,
			};
		return {
			retrying: true,
			message: `loading it again (attempt ${h.attempts + 1} of ${max}; last: ${h.lastError})`,
		};
	}

	/** Refresh cached statuses from the router. Returns false if it did not answer. */
	private async refresh(): Promise<boolean> {
		try {
			const all = await this.d.client.listModels();
			// The router also lists ids that are not ours (e.g. a "default" entry); keep registry models only.
			this.statuses = new Map([...all].filter(([id]) => findModel(this.d.registry, id) !== undefined));
			return true;
		} catch (err) {
			if (err instanceof RouterUnreachable) return false;
			throw err;
		}
	}

	private loadedModels(): string[] {
		return [...this.statuses].filter(([, s]) => LOADED_LIKE.has(s.value)).map(([id]) => id);
	}

	private scheduleHealth(): void {
		if (this.stopping) return;
		this.healthTimer = setTimeout(() => void this.healthTick(), this.d.healthIntervalMs);
		this.healthTimer.unref();
	}

	private async healthTick(): Promise<void> {
		if (this.stopping || this.healthRunning) return;
		this.healthRunning = true;
		try {
			const healthy = this.routerState === "up" && this.d.router.isAlive() && (await this.refresh());
			if (!healthy) await this.recoverRouter();
			else this.healSelected();
		} catch (err) {
			this.d.log.error("models: health check failed", { error: (err as Error).message });
		} finally {
			this.healthRunning = false;
			this.scheduleHealth();
		}
	}

	/** The router died or stopped answering: invalidate leases, restart with backoff, reload selections. */
	private async recoverRouter(): Promise<void> {
		const lost = this.loadedModels();
		if (this.routerState === "up") {
			this.d.log.warn("models: router lost", { pid: this.d.router.pid, lostModels: lost });
			this.invalidateLeases();
			this.statuses.clear();
			this.notifyLost(lost);
		}
		this.routerState = "restarting";
		await this.exclusive(async () => {
			await this.d.router.stop(); // a hung router we own; a no-op if it is already gone
			for (let attempt = 0; !this.stopping; attempt++) {
				const r = await this.startRouter("health");
				if (r.ok) {
					this.routerState = "up";
					await this.loadSelectedLocked("health");
					return;
				}
				const backoff = this.d.restartBackoffMs;
				await sleep(backoff[Math.min(attempt, backoff.length - 1)]!);
			}
		});
	}

	private invalidateLeases(): void {
		this.generation++;
		this.inUse.clear();
	}

	private notifyLost(lost: string[]): void {
		for (const l of this.lostListeners) {
			try {
				l(lost);
			} catch (err) {
				this.d.log.error("models: router-lost listener failed", { error: (err as Error).message });
			}
		}
	}

	private refuse(op: ModelOpKind, model: string, requestedBy: string, message: string): OpResult {
		const id = this.d.newId();
		const at = this.iso();
		startModelOp(this.d.db, { id, op, modelName: model, requestedBy, at });
		finishModelOp(this.d.db, id, "refused", message, at);
		return { ok: false, message };
	}

	private async recordOp(
		op: ModelOpKind,
		model: string | null,
		requestedBy: string,
		fn: () => Promise<OpResult>,
	): Promise<OpResult> {
		const id = this.d.newId();
		startModelOp(this.d.db, { id, op, modelName: model, requestedBy, at: this.iso() });
		let result: OpResult;
		try {
			result = await fn();
		} catch (err) {
			result = { ok: false, message: (err as Error).message };
		}
		finishModelOp(this.d.db, id, result.ok ? "done" : "failed", result.ok ? null : result.message, this.iso());
		if (!result.ok) this.d.log.warn(`models: ${op} failed`, { model, reason: result.message });
		return result;
	}

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.opChain.then(fn, fn);
		this.opChain = run.catch(() => undefined);
		return run;
	}

	private iso(): string {
		return this.d.now().toISOString();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Elapsed time that skips system sleep (2026-10-05: a 90 s load deadline
 * expired across 18 minutes of macOS sleep). Node's monotonic clock counts
 * sleep on macOS (measured: process.hrtime equals the wall time since boot
 * after a night asleep), so each step between two reads is capped at
 * `maxStepMs`: a frozen process sees one huge gap, which counts as one step.
 */
export class AwakeStopwatch {
	private readonly clock: () => number;
	private readonly maxStepMs: number;
	private last: number;
	private total = 0;

	constructor(clock: () => number, maxStepMs: number) {
		this.clock = clock;
		this.maxStepMs = maxStepMs;
		this.last = clock();
	}

	elapsed(): number {
		const now = this.clock();
		this.total += Math.min(Math.max(now - this.last, 0), this.maxStepMs);
		this.last = now;
		return this.total;
	}
}
