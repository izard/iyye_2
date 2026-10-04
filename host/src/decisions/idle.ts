// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The background loop of a shadow role (plan 0.003 §3.4): drain what can run
 * now, then wait for a wake-up or the poll interval. The drain itself decides
 * whether the device is free and no chat is waiting.
 */

export class IdleLoop {
	private running = false;
	private loop: Promise<void> = Promise.resolve();
	private wakeUp: (() => void) | null = null;

	private readonly opts: { pollMs: number; drain: () => Promise<unknown> };

	constructor(opts: { pollMs: number; drain: () => Promise<unknown> }) {
		this.opts = opts;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.loop = this.run();
	}

	async stop(): Promise<void> {
		this.running = false;
		this.wakeUp?.();
		await this.loop;
	}

	wake(): void {
		this.wakeUp?.();
	}

	private async run(): Promise<void> {
		while (this.running) {
			await this.opts.drain();
			// stop() may have come during the drain, when there was no wait to wake: do not start one.
			if (!this.running) break;
			await new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					this.wakeUp = null;
					resolve();
				};
				const timer = setTimeout(done, this.opts.pollMs);
				timer.unref();
				this.wakeUp = done;
			});
		}
	}
}
