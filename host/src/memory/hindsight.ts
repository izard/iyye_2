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
}

/** The retain strategy that stores text verbatim, with no model call (Hindsight `chunks` mode). */
export const VERBATIM_STRATEGY = "iyye-verbatim";

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
		opts: { excludeIyye?: boolean } = {},
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
			},
			this.o.recallTimeoutMs,
		)) as { results?: Partial<LtmResult>[] };
		return (body.results ?? []).map((r) => ({
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
	 * Create or update a bank with Iyye's settings, including the verbatim
	 * strategy used for Iyye's own words. Idempotent (PUT, PATCH).
	 */
	async ensureBank(bank: string, settings: { retainMission: string }): Promise<void> {
		const path = `/v1/default/banks/${encodeURIComponent(bank)}`;
		await this.call(
			"PUT",
			path,
			{ retain_mission: settings.retainMission, enable_observations: true },
			this.o.writeTimeoutMs,
		);
		await this.call(
			"PATCH",
			`${path}/config`,
			{ updates: { retain_strategies: { [VERBATIM_STRATEGY]: { retain_extraction_mode: "chunks" } } } },
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
