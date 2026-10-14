// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * A minimal HTTP client for the local Hindsight API (plan 0.002). Only the
 * host holds it: the memory gateway uses it for recall, the night job for
 * retain and consolidation. It is never handed to a model-reachable worker,
 * and every call names its bank explicitly, chosen by the host from the
 * trusted scope.
 */

import { SPEAKER_PERSON, SPEAKER_PROBE } from "./provenance.ts";

export interface LtmResult {
	id: string;
	text: string;
	type: string | null;
	occurred_start: string | null;
	mentioned_at: string | null;
	document_id: string | null;
	/** The item's tags, set by the host at retain (e.g. `speaker:person`): provenance by construction. */
	tags: string[];
	/**
	 * Relevance to the query, comparable across banks (Hindsight's cross-encoder
	 * reranker score, 0–1; measured 2026-10-06: ~0.99 for a match, ~0.00001 for
	 * an unrelated bank's best). Null when the server sent none.
	 */
	score: number | null;
}

/** The retain strategy that stores text verbatim, with no model call (Hindsight `chunks` mode). */
export const VERBATIM_STRATEGY = "iyye-verbatim";
/**
 * The retain strategy for Iyye's own replies (2026-10-06, owner decision): not
 * verbatim, but the important things Iyye told someone, extracted under their
 * own mission, dated and attributed to Iyye.
 */
export const REPLY_STRATEGY = "iyye-reply";

/**
 * Consolidation never builds observations from Iyye's words or its probes'
 * measurements, in any bank (2026-10-06: Iyye's reply "my abilities are
 * limited to text" became the observation "the user's abilities are limited
 * to text"). A Hindsight consolidation strategy matched by tag, with a cap of
 * 0 observations: decided by tags the host set, not by a model.
 */
export const NO_OBSERVATIONS_FROM = ["speaker:iyye", "speaker:probe"];

export interface HindsightOptions {
	baseUrl: string;
	apiKey: () => string;
	/** Recall answers in about 0.1 s; past this the turn goes on without LTM. */
	recallTimeoutMs?: number;
	/** Retain waits for extraction (10–30 s per episode, longer with reasoning on). */
	writeTimeoutMs?: number;
}

export class HindsightError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** A stored memory as Hindsight lists it (only the fields Iyye reads). */
export interface MemoryUnit {
	id: string;
	text: string;
	context?: string | null;
	date?: string | null;
	fact_type?: string;
	entities?: string | null;
	state?: string;
	tags?: string[];
	metadata?: Record<string, unknown> | null;
	occurred_start?: string | null;
}

export class HindsightClient {
	private readonly o: Required<HindsightOptions>;

	constructor(opts: HindsightOptions) {
		this.o = { recallTimeoutMs: 3000, writeTimeoutMs: 1_200_000, ...opts };
	}

	async listBanks(): Promise<string[]> {
		const body = (await this.call("GET", "/v1/default/banks", undefined, this.o.recallTimeoutMs)) as {
			banks?: { bank_id: string }[];
		};
		return (body.banks ?? []).map((b) => b.bank_id);
	}

	/** `excludeIyye`: only the people's words and untagged (legacy) memories, never Iyye's own. */
	async recall(
		bank: string,
		query: string,
		maxTokens: number,
		opts: { excludeIyye?: boolean; tags?: string[] } = {},
	): Promise<LtmResult[]> {
		const body = (await this.call(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`,
			{
				query,
				max_tokens: maxTokens,
				budget: "low",
				prefer_observations: true,
				// "any" keeps untagged legacy memories; they are labelled "source not recorded".
				// A person's statements and Iyye's own measurements are evidence; Iyye's words are not.
				...(opts.excludeIyye ? { tags: [SPEAKER_PERSON, SPEAKER_PROBE], tags_match: "any" } : {}),
				// Only items carrying all of these tags (plan 0.011: the structured facts of earlier nights).
				...(opts.tags ? { tags: opts.tags, tags_match: "all_strict" } : {}),
			},
			this.o.recallTimeoutMs,
		)) as { results?: (Partial<LtmResult> & { scores?: { reranker?: number; final?: number } })[] };
		return (body.results ?? []).map((r) => ({
			score:
				typeof r.scores?.reranker === "number"
					? r.scores.reranker
					: typeof r.scores?.final === "number"
						? r.scores.final
						: null,
			id: String(r.id ?? ""),
			text: String(r.text ?? ""),
			type: r.type ?? null,
			occurred_start: r.occurred_start ?? null,
			mentioned_at: r.mentioned_at ?? null,
			document_id: r.document_id ?? null,
			tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
		}));
	}

	/**
	 * Create or update a bank with Iyye's settings (idempotent: PUT, PATCH):
	 * the extraction mission for people's words, the verbatim strategy for
	 * Iyye's own entries, the reply strategy with its own mission, no
	 * observations from Iyye's words or its probes, and whether the bank builds
	 * observations at all, under which mission.
	 */
	async ensureBank(
		bank: string,
		settings: { retainMission: string; replyMission: string; observations: boolean; observationsMission?: string },
	): Promise<void> {
		const path = `/v1/default/banks/${encodeURIComponent(bank)}`;
		await this.call(
			"PUT",
			path,
			{ retain_mission: settings.retainMission, enable_observations: settings.observations },
			this.o.writeTimeoutMs,
		);
		await this.call(
			"PATCH",
			`${path}/config`,
			{
				updates: {
					retain_strategies: {
						[VERBATIM_STRATEGY]: { retain_extraction_mode: "chunks" },
						[REPLY_STRATEGY]: { retain_mission: settings.replyMission },
					},
					consolidation_strategies: [
						{ scopes: NO_OBSERVATIONS_FROM.map((t) => ({ tags: [t] })), max_observations_per_scope: 0 },
					],
					...(settings.observationsMission ? { observations_mission: settings.observationsMission } : {}),
				},
			},
			this.o.writeTimeoutMs,
		);
	}

	/**
	 * Retain one episode synchronously. `documentId` makes it idempotent:
	 * Hindsight replaces a document with the same id and skips identical content.
	 */
	async retain(
		bank: string,
		doc: {
			documentId: string;
			content: string;
			context: string;
			timestamp: string;
			tags: string[];
			metadata: Record<string, string>;
			/** A named bank strategy, e.g. `VERBATIM_STRATEGY`; the bank default when absent. */
			strategy?: string;
		},
	): Promise<void> {
		await this.call(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bank)}/memories`,
			{
				items: [
					{
						content: doc.content,
						context: doc.context,
						document_id: doc.documentId,
						timestamp: doc.timestamp,
						tags: doc.tags,
						metadata: doc.metadata,
						...(doc.strategy ? { strategy: doc.strategy } : {}),
					},
				],
				async: false,
			},
			this.o.writeTimeoutMs,
		);
	}

	/** How many memory units a document produced (0: extraction found nothing). */
	async documentUnits(bank: string, documentId: string): Promise<number> {
		const body = (await this.call(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bank)}/documents/${encodeURIComponent(documentId)}`,
			undefined,
			this.o.recallTimeoutMs * 10,
		)) as { memory_unit_count?: number };
		return body.memory_unit_count ?? 0;
	}

	/** Delete a bank with everything in it: documents, facts, observations, entities, settings. */
	/**
	 * One page of a bank's stored memories, newest first (debugging,
	 * `scripts/dump-ltm.ts`). `type` is world, experience or observation; `q`
	 * a full-text filter. Makes no model call.
	 */
	async listMemories(
		bank: string,
		opts: { type?: string; q?: string; limit?: number; offset?: number } = {},
	): Promise<{ items: MemoryUnit[]; total: number }> {
		const params = new URLSearchParams({ limit: String(opts.limit ?? 100), offset: String(opts.offset ?? 0) });
		if (opts.type) params.set("type", opts.type);
		if (opts.q) params.set("q", opts.q);
		const body = (await this.call(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bank)}/memories/list?${params}`,
			undefined,
			this.o.recallTimeoutMs * 10,
		)) as { items?: MemoryUnit[]; total?: number };
		return { items: body.items ?? [], total: body.total ?? 0 };
	}

	/**
	 * One page of a bank's documents, newest first, `q` a case-insensitive
	 * substring of the document id (plan 0.011 §5: the fact ledger's orphan
	 * check lists `fact:` documents). Makes no model call.
	 */
	async listDocuments(
		bank: string,
		opts: { q?: string; limit?: number; offset?: number } = {},
	): Promise<{ items: { id: string }[]; total: number }> {
		const params = new URLSearchParams({ limit: String(opts.limit ?? 100), offset: String(opts.offset ?? 0) });
		if (opts.q) params.set("q", opts.q);
		const body = (await this.call(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bank)}/documents?${params}`,
			undefined,
			this.o.recallTimeoutMs * 10,
		)) as { items?: { id: string }[]; total?: number };
		return { items: body.items ?? [], total: body.total ?? 0 };
	}

	/** Delete one document with every memory extracted from it (plan 0.011: a structured fact `/facts wrong` removed). */
	async deleteDocument(bank: string, documentId: string): Promise<void> {
		await this.call(
			"DELETE",
			`/v1/default/banks/${encodeURIComponent(bank)}/documents/${encodeURIComponent(documentId)}`,
			undefined,
			this.o.writeTimeoutMs,
		);
	}

	async deleteBank(bank: string): Promise<void> {
		await this.call("DELETE", `/v1/default/banks/${encodeURIComponent(bank)}`, undefined, this.o.writeTimeoutMs);
	}

	async bankStats(bank: string): Promise<{ documents: number; memories: number; byType: Record<string, number> }> {
		const body = (await this.call(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bank)}/stats`,
			undefined,
			this.o.recallTimeoutMs * 10,
		)) as { total_documents?: number; total_nodes?: number; nodes_by_fact_type?: Record<string, number> };
		return {
			documents: body.total_documents ?? 0,
			memories: body.total_nodes ?? 0,
			byType: body.nodes_by_fact_type ?? {},
		};
	}

	/** Start consolidation; returns its operation id. */
	async consolidate(bank: string): Promise<string> {
		const body = (await this.call(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bank)}/consolidate`,
			{},
			this.o.writeTimeoutMs,
		)) as { operation_id: string };
		return body.operation_id;
	}

	async operationStatus(bank: string, operationId: string): Promise<string> {
		const body = (await this.call(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bank)}/operations/${encodeURIComponent(operationId)}`,
			undefined,
			this.o.recallTimeoutMs * 10,
		)) as { status?: string };
		return body.status ?? "not_found";
	}

	private async call(method: string, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
		const res = await fetch(`${this.o.baseUrl}${path}`, {
			method,
			headers: { authorization: `Bearer ${this.o.apiKey()}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		if (!res.ok)
			throw new HindsightError(res.status, `Hindsight ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
		return text ? JSON.parse(text) : {};
	}
}
