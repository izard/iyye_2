// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The memory gate (plan 0.002 L2): the only way Hindsight work gets the
 * device. `run(label, fn)` holds, for the whole Hindsight operation:
 *
 *   device slot → memory model (loaded on demand) → model lease → pass-through admission
 *
 * and always lets go in the safe order: stop admitting, drain in-flight model
 * calls (bounded, then abort), release the lease, release the slot. So a chat
 * turn never shares the device with memory work, and the memory model cannot
 * be unloaded while Hindsight is still using it.
 *
 * Memory work is background work: it never waits in line. If a chat job is
 * queued or the device is in use, `run` declines at once (`busy`) and the
 * caller tries again in the next idle window. A refusal that needs the owner
 * (no memory model selected, the model cap is full, not enough RAM) is kept
 * in `problem` so the memory status shows it instead of memory silently
 * never happening.
 */

import type { DeviceSlot } from "../kernel/device.ts";
import type { Logger } from "../log.ts";
import type { ModelLease, OpResult } from "../models/manager.ts";
import type { Admission, PassthroughLease } from "./passthrough.ts";

export interface GateModels {
	selected(key: "memory"): string | null;
	acquire(name: string): Promise<ModelLease | OpResult>;
	load(name: string, requestedBy: string): Promise<OpResult>;
}

export interface GateDeps {
	device: DeviceSlot;
	models: GateModels;
	passthrough: { admit(lease: PassthroughLease, opts?: { thinking?: boolean }): Admission };
	/** True while a chat job waits; memory work then yields. */
	chatPending: () => boolean;
	log: Logger;
	/** How long in-flight model calls may finish after the operation ends. */
	drainMs?: number;
}

export type GateResult<T> = { ok: true; value: T; model: string } | { ok: false; busy: boolean; message: string };

export class MemoryGate {
	private readonly d: Required<GateDeps>;
	private problemText: string | null = null;

	constructor(deps: GateDeps) {
		this.d = { drainMs: 30_000, ...deps };
	}

	/** Why memory work cannot run until the owner acts, or null. */
	get problem(): string | null {
		return this.problemText;
	}

	/** `thinking`: the memory model's reasoning for this operation (off by default). */
	async run<T>(
		label: string,
		fn: (model: string) => Promise<T>,
		opts: { thinking?: boolean } = {},
	): Promise<GateResult<T>> {
		if (this.d.chatPending()) return { ok: false, busy: true, message: "a chat job is waiting" };
		const releaseDevice = this.d.device.tryAcquire(`memory:${label}`);
		if (!releaseDevice) return { ok: false, busy: true, message: "the device is in use" };
		try {
			const lease = await this.lease();
			if (!("release" in lease)) {
				if (!lease.busy) this.problemText = lease.message;
				return { ok: false, busy: lease.busy === true, message: lease.message };
			}
			this.problemText = null;
			try {
				const admission = this.d.passthrough.admit(lease, opts);
				try {
					return { ok: true, value: await fn(lease.model), model: lease.model };
				} finally {
					await admission.close(this.d.drainMs);
				}
			} finally {
				lease.release();
			}
		} finally {
			releaseDevice();
		}
	}

	/** Lease the selected memory model, loading it first if it is not loaded. */
	private async lease(): Promise<ModelLease | OpResult> {
		const name = this.d.models.selected("memory");
		if (!name) return { ok: false, message: "no memory model selected; use /use <model> memory" };
		const first = await this.d.models.acquire(name);
		if ("release" in first || first.busy || !/is not loaded/.test(first.message)) return first;
		this.d.log.info("memory: loading the memory model", { model: name });
		const loaded = await this.d.models.load(name, "memory");
		if (!loaded.ok) return { ...loaded, message: `memory model ${name} not loaded: ${loaded.message}` };
		return this.d.models.acquire(name);
	}
}
