// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import type { DecisionService } from "../../src/decisions/client.ts";
import { freePort } from "../model-helpers.ts";

export const CHECKPOINT = {
	run: "jaredpalmer/kev-4b@6cfce5c",
	base: "Qwen/Qwen3.5-4B-Base",
	lora: 16,
	temperature: 2.41,
	backend: "mlx",
	dtype: "bfloat16",
};

/** An in-process Kev /v1/systemone (plus the `DecisionService` view of it): answers every question with `answer(id)`, or a scripted failure. */
export class FakeKev {
	answer: (questionId: string) => unknown = () => 0.5;
	/** Mark every answer as from a state the server cut (Kev with KEV_TRUNCATE_STATES=1). */
	truncated = false;
	/** Called while a request is being answered (e.g. to swap the checkpoint mid-call). */
	during: (() => void) | null = null;
	/** The checkpoint the service reports while up. */
	checkpointInfo: typeof CHECKPOINT = CHECKPOINT;
	status = 200;
	delayMs = 0;
	readonly requests: { state: unknown; questions: Record<string, { type: string; instructions: string }> }[] = [];
	private server: Server | null = null;
	port = 0;
	up = true;
	readonly service: DecisionService = {
		get checkpoint() {
			return null;
		},
		baseUrl: "",
		apiKey: () => "kev-key",
	};

	async start(): Promise<void> {
		this.port = await freePort();
		this.server = createServer((req, res) => {
			let body = "";
			req.on("data", (d) => {
				body += d;
			});
			req.on("end", async () => {
				if (req.headers.authorization !== "Bearer kev-key") {
					res.writeHead(401).end();
					return;
				}
				const r = JSON.parse(body);
				this.requests.push(r);
				if (this.delayMs) await new Promise((x) => setTimeout(x, this.delayMs));
				this.during?.();
				res.writeHead(this.status, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						...(this.truncated ? { truncated: true } : {}),
						answers: Object.fromEntries(
							Object.keys(r.questions).map((id) => [id, { type: "noul", noul: this.answer(id) }]),
						),
					}),
				);
			});
		});
		await new Promise<void>((r) => this.server!.listen(this.port, "127.0.0.1", r));
		Object.defineProperties(this.service, {
			checkpoint: { get: () => (this.up ? this.checkpointInfo : null) },
			baseUrl: { value: `http://127.0.0.1:${this.port}` },
		});
	}

	async stop(): Promise<void> {
		this.server?.closeAllConnections();
		await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
	}
}
