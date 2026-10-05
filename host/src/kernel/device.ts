// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The one device-consuming task at a time (HLD §5.1). A model lease only
 * protects a model from being unloaded; this slot is what keeps a chat turn
 * and memory work (Hindsight extraction or consolidation) from running on the
 * device together. Holders queue in arrival order.
 *
 * A **preemptible** holder (background work, plan 0.007) gives way: when
 * anyone waits for the slot, its `onPreempt` is called once, and it pauses at
 * its next safe checkpoint and releases the slot.
 */
export class DeviceSlot {
	private holderLabel: string | null = null;
	private preempt: (() => void) | null = null;
	private readonly waiters: { label: string; grant: () => void }[] = [];

	/** Who holds the slot now, if anyone. */
	get holder(): string | null {
		return this.holderLabel;
	}

	/** Wait for the slot; resolves to its release function (safe to call twice). */
	acquire(label: string): Promise<() => void> {
		return new Promise((resolve) => {
			const grant = () => {
				this.holderLabel = label;
				resolve(this.releaser());
			};
			if (this.holderLabel === null) grant();
			else {
				this.waiters.push({ label, grant });
				const yieldNow = this.preempt;
				this.preempt = null; // once per holder
				yieldNow?.();
			}
		});
	}

	/** True while someone waits for the slot. */
	get contended(): boolean {
		return this.waiters.length > 0;
	}

	/**
	 * Take the slot only if it is free right now. With `onPreempt`, the holder
	 * is preemptible: a later `acquire` asks it to give way.
	 */
	tryAcquire(label: string, opts: { onPreempt?: () => void } = {}): (() => void) | null {
		if (this.holderLabel !== null) return null;
		this.holderLabel = label;
		this.preempt = opts.onPreempt ?? null;
		return this.releaser();
	}

	private releaser(): () => void {
		let done = false;
		return () => {
			if (done) return;
			done = true;
			this.holderLabel = null;
			this.preempt = null;
			this.waiters.shift()?.grant();
		};
	}
}
