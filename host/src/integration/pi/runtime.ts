// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * A Pi model runtime that can only reach the host's own llama.cpp router
 * (plan M3, HLD §2.2 / §9.3: local-only inference, no hosted fallback).
 *
 * Pi 1.0.0 always registers its built-in hosted providers, and their
 * credentials can come from environment variables or ambient files (for
 * example ~/.aws or gcloud ADC), so emptying the credential store is not
 * enough. Three layers make the router the only reachable model:
 * 1. Pi's model-catalog network refresh is off (`PI_OFFLINE`, no refresh on
 *    create), with an empty in-memory credential store and no models.json.
 * 2. The Iyye provider is registered with one model per available registry
 *    entry, pointing at the router's OpenAI-compatible endpoint.
 * 3. Every inference entry point of this runtime instance refuses any model
 *    whose provider is not the Iyye provider (`lockToLocalProvider`). This is
 *    the enforcement layer; 1 and 2 only keep Pi from looking elsewhere.
 */

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelSpec, Registry, ServerArgs } from "../../models/registry.ts";

export const IYYE_PROVIDER = "iyye-local";

/** Output tokens a reply may use; replies are conversational, not documents. */
/** Output tokens per model reply; a thinking model needs room for its reasoning and its answer. */
const MAX_OUTPUT_TOKENS = 4096;
const MAX_OUTPUT_TOKENS_THINKING = 16_384;

export class LocalOnlyViolation extends Error {}

export interface LocalRuntimeOptions {
	routerUrl: string;
	registry: Registry;
}

export async function createLocalModelRuntime(opts: LocalRuntimeOptions): Promise<ModelRuntime> {
	// Read by ModelRuntime.create when it decides whether model catalogs may use the network.
	process.env.PI_OFFLINE = "1";
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runtime.registerProvider(IYYE_PROVIDER, {
		name: "Iyye local router",
		baseUrl: `${opts.routerUrl.replace(/\/$/, "")}/v1`,
		api: "openai-completions",
		// The router listens on 127.0.0.1 without an API key; Pi requires some key to consider the provider usable.
		apiKey: "iyye-local",
		models: opts.registry.models
			.filter((m) => m.available)
			.map((m) => ({
				id: m.name,
				name: m.name,
				// A remote model (plan 0.012) goes through the host's own pass-through on 127.0.0.1, never to
				// the other machine directly: the provider, and so this runtime's guard, are the same.
				...(m.remote ? { baseUrl: `${m.remote.proxyUrl.replace(/\/$/, "")}/v1` } : {}),
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				// Declared as a reasoning model only so Pi sends the switch: `enable_thinking` goes out
				// explicitly on every request. Some templates (Qwen's) think by default; left unsaid, a reply
				// can spend its whole output budget thinking. It follows the session's thinking level
				// (`thinkingLevelFor`: "medium" for a registry "on", else "off"), so Pi's own summaries
				// (compaction) can go out with thinking off (2026-10-05: an 11-minute thinking summary).
				reasoning: true,
				compat: {
					thinkingFormat: "chat-template" as const,
					chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" as const } },
					// A reasoning model would otherwise get its system prompt as role "developer",
					// which llama.cpp chat templates may not know.
					supportsDeveloperRole: false,
				},
				contextWindow: slotContext(opts.registry.defaults, m),
				maxTokens: outputCap(opts.registry.defaults, m),
				// Pi sends no output cap by default; without one a reply can run until the context is full.
				// With it, `length` below the cap means the context ran out (Pi compacts and retries once),
				// and `length` at the cap is a reply that ran long (the host's recovery step).
				samplingParams: { max_tokens: outputCap(opts.registry.defaults, m) },
			})),
	});
	lockToLocalProvider(runtime);
	return runtime;
}

/** Output tokens per reply: room for reasoning and the answer when the model thinks. */
export function outputCap(defaults: ServerArgs, m: ModelSpec): number {
	return m.thinking === "on"
		? Math.min(MAX_OUTPUT_TOKENS_THINKING, Math.floor(slotContext(defaults, m) / 2))
		: MAX_OUTPUT_TOKENS;
}

/**
 * llama-server splits its context (`c`) across `np` parallel slots, so one
 * conversation gets c / np tokens.
 */
export function slotContext(defaults: ServerArgs, m: ModelSpec): number {
	const args = { ...defaults, ...m.serverArgs };
	const c = Number(args.c ?? args["ctx-size"] ?? 4096);
	const np = Number(args.np ?? args.parallel ?? 1);
	return Math.max(1024, Math.floor(c / Math.max(1, np)));
}

const GUARDED_METHODS = [
	"stream",
	"complete",
	"streamSimple",
	"completeSimple",
	"streamDeferred",
	"fetchDeferred",
	"cancelDeferred",
	"generateImages",
	"classify",
] as const;

/**
 * Make every inference method of this runtime instance refuse a model from
 * any provider other than the Iyye router. The refusal is an exception, which
 * Pi turns into a failed assistant message: it never falls back elsewhere.
 */
export function lockToLocalProvider(runtime: ModelRuntime): void {
	const target = runtime as unknown as Record<string, (...args: unknown[]) => unknown>;
	for (const name of GUARDED_METHODS) {
		const original = target[name];
		if (typeof original !== "function") continue;
		target[name] = (model: unknown, ...rest: unknown[]) => {
			const provider = (model as { provider?: unknown } | undefined)?.provider;
			if (provider !== IYYE_PROVIDER) {
				throw new LocalOnlyViolation(
					`refused ${name} on provider ${String(provider)}: only the local Iyye router may be used`,
				);
			}
			return original.call(runtime, model, ...rest);
		};
	}
}

export function localModel(runtime: ModelRuntime, name: string) {
	const model = runtime.getModel(IYYE_PROVIDER, name);
	if (!model) throw new Error(`model ${name} is not registered with the local runtime`);
	return model;
}

/** The session thinking level for a registry model: Pi turns it into `enable_thinking` on each request. */
export function thinkingLevelFor(registry: Registry, model: string): "medium" | "off" {
	return registry.models.find((m) => m.name === model)?.thinking === "on" ? "medium" : "off";
}
