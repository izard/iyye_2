// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-process stand-in for the Hindsight HTTP API, enough for the gateway
 * and the night job: banks, recall, synchronous retain (documents replaced
 * by id, like 0.10.2), document unit counts, consolidation operations.
 *
 * Recall answers a bank's scripted `recallResults` when set, otherwise its
 * stored documents that share a word (4+ letters) with the query, as
 * Hindsight would return the facts extracted from them.
 *
 * Scripting: `recallResults` per bank; `unitsFor(content)` decides how many
 * facts a retain "extracts"; `failRetain` makes retains answer HTTP 500;
 * `down` answers 503 to everything.
 */

import { createServer, type Server } from "node:http";
import { HindsightClient } from "../../src/memory/hindsight.ts";
import { freePort } from "../model-helpers.ts";

export interface FakeDoc {
	bank: string;
	id: string;
	content: string;
	context: string;
	timestamp: string;
	tags: string[];
	metadata: Record<string, string>;
	strategy: string | null;
	units: number;
}

export class FakeLtm {
	readonly key = "ltm-key";
	readonly banks = new Map<
		string,
		{
			mission: string | null;
			strategies: Record<string, unknown> | null;
			observations?: boolean;
			consolidation?: unknown[] | null;
			observationsMission?: string | null;
		}
	>();
	/** Scripted recall answers per bank; `score` is sent as Hindsight's reranker score. */
	readonly recallResults = new Map<
		string,
		{ text: string; occurred_start?: string; tags?: string[]; score?: number }[]
	>();
	readonly recalls: { bank: string; query: string }[] = [];
	readonly docs = new Map<string, FakeDoc>();
	readonly retains: string[] = [];
	readonly consolidations: string[] = [];
	readonly deletedDocs: string[] = [];
	unitsFor: (content: string) => number = (c) => (/2\+2|thanks/i.test(c) ? 0 : 1);
	failRetain = false;
	/** This bank's recalls answer HTTP 500 (one bank failing among several). */
	failRecallFor: string | null = null;
	down = false;
	port = 0;
	private server: Server | null = null;

	async start(): Promise<void> {
		this.port = await freePort();
		this.server = createServer((req, res) => {
			let body = "";
			req.on("data", (d) => {
				body += d;
			});
			req.on("end", () => this.handle(req.method ?? "GET", req.url ?? "/", req.headers.authorization, body, res));
		});
		await new Promise<void>((r) => this.server!.listen(this.port, "127.0.0.1", r));
	}

	client(): HindsightClient {
		return new HindsightClient({ baseUrl: `http://127.0.0.1:${this.port}`, apiKey: () => this.key });
	}

	reset(): void {
		this.banks.clear();
		this.recallResults.clear();
		this.recalls.length = 0;
		this.docs.clear();
		this.retains.length = 0;
		this.consolidations.length = 0;
		this.unitsFor = (c) => (/2\+2|thanks/i.test(c) ? 0 : 1);
		this.failRetain = false;
		this.failRecallFor = null;
		this.down = false;
	}

	async stop(): Promise<void> {
		this.server?.closeAllConnections();
		await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
	}

	private handle(
		method: string,
		url: string,
		auth: string | undefined,
		body: string,
		res: import("node:http").ServerResponse,
	) {
		const json = (code: number, b: unknown) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(b));
		};
		if (this.down) return json(503, { detail: "down" });
		if (auth !== `Bearer ${this.key}`) return json(401, {});
		const parts = url.split("?")[0]!.split("/").map(decodeURIComponent); // ["", "v1", "default", "banks", bank, ...]
		const bank = parts[4];
		const rest = parts.slice(5).join("/");
		const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
		if (method === "GET" && parts.length === 4) {
			return json(200, {
				banks: [...new Set([...this.banks.keys(), ...this.recallResults.keys()])].map((bank_id) => ({ bank_id })),
			});
		}
		if (!bank) return json(404, {});
		if (method === "PUT" && rest === "") {
			this.banks.set(bank, {
				...this.banks.get(bank),
				mission: (data.retain_mission as string) ?? null,
				strategies: this.banks.get(bank)?.strategies ?? null,
				observations: data.enable_observations !== false,
			});
			return json(200, { bank_id: bank });
		}
		if (method === "DELETE" && rest === "") {
			if (!this.banks.has(bank) && !this.recallResults.has(bank)) return json(404, { detail: "bank not found" });
			this.banks.delete(bank);
			this.recallResults.delete(bank);
			for (const k of [...this.docs.keys()]) if (k.startsWith(`${bank}/`)) this.docs.delete(k);
			return json(200, { success: true });
		}
		if (method === "GET" && rest === "stats") {
			const docs = [...this.docs.values()].filter((d) => d.bank === bank);
			return json(200, {
				bank_id: bank,
				total_documents: docs.length,
				total_nodes: docs.reduce((n, d) => n + d.units, 0),
				nodes_by_fact_type: { world: docs.reduce((n, d) => n + d.units, 0) },
			});
		}
		if (method === "PATCH" && rest === "config") {
			const b = this.banks.get(bank);
			if (!b) return json(404, {});
			const updates = (data.updates ?? {}) as {
				retain_strategies?: Record<string, unknown>;
				consolidation_strategies?: unknown[];
				observations_mission?: string;
			};
			b.strategies = updates.retain_strategies ?? b.strategies;
			b.consolidation = updates.consolidation_strategies ?? b.consolidation ?? null;
			b.observationsMission = updates.observations_mission ?? b.observationsMission ?? null;
			return json(200, { bank_id: bank });
		}
		if (method === "POST" && rest === "memories/recall") {
			this.recalls.push({ bank, query: String(data.query) });
			if (this.failRecallFor === bank) return json(500, { detail: "scripted recall failure" });
			if (!this.banks.has(bank) && !this.recallResults.has(bank)) return json(404, { detail: "bank not found" });
			// tags + "any": results carrying any of the tags, plus untagged ones (Hindsight's semantics).
			const want = data.tags as string[] | undefined;
			const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
			const q = words(String(data.query));
			const stored = [...this.docs.values()]
				.filter((d) => d.bank === bank && d.units > 0 && [...words(d.content)].some((w) => q.has(w)))
				.map((d) => ({
					text: d.content,
					occurred_start: d.timestamp,
					tags: d.tags,
					document_id: d.id as string | undefined,
					score: undefined as number | undefined,
				}));
			// "all_strict": only results carrying every tag; "any": any of them, plus untagged ones.
			const strict = data.tags_match === "all_strict";
			const results = (this.recallResults.get(bank) ?? stored).filter((r) =>
				!want
					? true
					: strict
						? want.every((t) => r.tags?.includes(t))
						: !r.tags?.length || r.tags.some((t) => want.includes(t)),
			);
			return json(200, {
				results: results.map(({ score, ...r }, i) => ({
					id: `f${i}`,
					...r,
					...(score === undefined ? {} : { scores: { reranker: score, final: score } }),
				})),
			});
		}
		if (method === "GET" && rest === "memories/list") {
			// One unit per stored document, newest first, as Hindsight's table view lists them.
			const q = new URLSearchParams(url.split("?")[1] ?? "");
			const all = [...this.docs.values()]
				.filter((d) => d.bank === bank)
				.filter(() => !q.get("type") || q.get("type") === "world")
				.filter((d) => !q.get("q") || d.content.toLowerCase().includes(q.get("q")!.toLowerCase()))
				.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
			const offset = Number(q.get("offset") ?? 0);
			const limit = Number(q.get("limit") ?? 100);
			return json(200, {
				items: all.slice(offset, offset + limit).map((d) => ({
					id: d.id,
					text: d.content,
					context: d.context,
					date: d.timestamp,
					fact_type: "world",
					entities: "",
					state: "valid",
					tags: d.tags,
					metadata: d.metadata,
				})),
				total: all.length,
				limit,
				offset,
			});
		}
		if (method === "POST" && rest === "memories") {
			if (this.failRetain) return json(500, { detail: "Fact extraction failed: scripted" });
			if (!this.banks.has(bank)) return json(404, { detail: "bank not found" });
			for (const item of data.items as Record<string, unknown>[]) {
				const id = String(item.document_id);
				const strategy = (item.strategy as string | undefined) ?? null;
				if (strategy && !this.banks.get(bank)!.strategies?.[strategy])
					return json(400, { detail: `unknown strategy ${strategy}` });
				this.retains.push(id);
				this.docs.set(`${bank}/${id}`, {
					bank,
					id,
					content: String(item.content),
					context: String(item.context),
					timestamp: String(item.timestamp),
					tags: item.tags as string[],
					metadata: item.metadata as Record<string, string>,
					strategy,
					// The verbatim (chunks) strategy stores the text as one unit, with no extraction.
					units:
						strategy &&
						(this.banks.get(bank)!.strategies?.[strategy] as { retain_extraction_mode?: string })
							?.retain_extraction_mode === "chunks"
							? 1
							: this.unitsFor(String(item.content)),
				});
			}
			return json(200, { success: true, bank_id: bank, items_count: 1, is_async: false });
		}
		const doc = /^documents\/(.+)$/.exec(rest);
		if (method === "DELETE" && doc) {
			if (!this.docs.delete(`${bank}/${doc[1]}`)) return json(404, { detail: "document not found" });
			this.deletedDocs.push(`${bank}/${doc[1]}`);
			return json(200, { success: true });
		}
		if (method === "GET" && doc) {
			const d = this.docs.get(`${bank}/${doc[1]}`);
			return d ? json(200, { id: d.id, memory_unit_count: d.units }) : json(404, {});
		}
		if (method === "POST" && rest === "consolidate") {
			if (!this.banks.has(bank)) return json(404, { detail: "bank not found" });
			this.consolidations.push(bank);
			return json(200, { operation_id: `op-${this.consolidations.length}` });
		}
		if (method === "GET" && rest.startsWith("operations/")) return json(200, { status: "completed" });
		json(404, {});
	}
}
