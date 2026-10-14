// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The voice's instructions and its one model call (plan 0.009 CH3).
 *
 * Prompt v1 is CH0's masked prompt, frozen (`host/SPIKE-0.009.md`): Russian
 * messages get the instructions in Russian (an English prompt made
 * gemma-4-E4B answer in English). Its version is a hash of the templates, so
 * a changed word is a new version, stored with every sample; tuning it is
 * measured on the dev split only, never on the sealed evaluation set.
 *
 * The style header carries the character's style dials in words, except
 * `observations` (whether to volunteer one is content, which the voice never
 * adds); unset dials say so. The mood header is words only. Neither ever
 * reaches Pi's prompt (owner decision 8).
 */

import { createHash } from "node:crypto";
import type { CharacterState, StyleDial } from "../character/character.ts";
import { STYLE_NAMES, styleWord } from "../character/character.ts";

const EN = [
	"You rewrite one message from Iyye, a personal assistant, in Iyye's own voice.",
	"Keep exactly what it says: every fact, number, name, link, promise, problem, doubt and refusal. Add nothing and leave nothing out. Keep the language of the message.",
	"Placeholders like ⟦1⟧ stand for exact text you cannot see: keep every placeholder exactly once, unchanged; never add, drop, translate or explain one.",
	"Change the wording, the order and the tone, as the style asks: do not return the message unchanged. Write only the rewritten message, without the <<< >>> marks.",
];
const RU = [
	"Ты переписываешь одно сообщение от Iyye, личного ассистента, голосом самой Iyye.",
	"Сохрани в точности всё, что в нём сказано: каждый факт, число, имя, ссылку, обещание, проблему, сомнение и отказ. Ничего не добавляй и ничего не убирай. Пиши по-русски, на языке сообщения.",
	"Метки вида ⟦1⟧ заменяют точный текст, которого ты не видишь: оставь каждую метку ровно один раз и без изменений; не добавляй, не убирай, не переводи и не объясняй их.",
	"Меняй формулировки, порядок и тон так, как просит стиль: не возвращай сообщение без изменений. Напиши только переписанное сообщение, без меток <<< >>>.",
];
const USER_EN = "Rewrite this message in Iyye's voice:";
const USER_RU = "Перепиши это сообщение голосом Iyye:";

/** The dials the voice is given: style only, and not whether to volunteer an observation. */
const VOICE_DIALS: StyleDial[] = STYLE_NAMES.filter((d) => d !== "observations");

export const VOICE_PROMPT_VERSION = `v1-${createHash("sha256")
	.update(JSON.stringify({ EN, RU, USER_EN, USER_RU, VOICE_DIALS }))
	.digest("hex")
	.slice(0, 8)}`;

export type VoiceLang = "en" | "ru" | "other";

export function voiceLang(text: string): VoiceLang {
	const letters = text.match(/\p{L}/gu) ?? [];
	if (letters.length === 0) return "other";
	const cyr = letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length / letters.length;
	if (cyr > 0.3) return "ru";
	const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length / letters.length;
	return latin > 0.7 ? "en" : "other";
}

export function styleHeader(state: CharacterState): string {
	const set = VOICE_DIALS.filter((d) => state.style[d].value !== null);
	if (set.length === 0) return "Style: not chosen yet; keep a natural, neutral tone.";
	return `Style: ${VOICE_DIALS.map((d) => `${d} ${state.style[d].value === null ? "neutral (not chosen yet)" : styleWord(d, state.style[d].value)}`).join(", ")}.`;
}

export function voiceSystem(lang: VoiceLang, style: string, mood: string, preset: string | null = null): string {
	return [...(lang === "ru" ? RU : EN), ...(preset ? [preset] : []), style, mood].join("\n");
}

/**
 * A sample's configuration identity: the base prompt's version, plus the preset's definition version
 * and wit level when a preset shaped it (owner decision 13). `(action_id, model, prompt_version)` stays
 * the sample's identity, so each configuration is its own sample.
 */
export function voiceConfigVersion(presetVersion: string | null): string {
	return presetVersion ? `${VOICE_PROMPT_VERSION}+${presetVersion}` : VOICE_PROMPT_VERSION;
}

export function voiceUser(lang: VoiceLang, masked: string): string {
	return `${lang === "ru" ? USER_RU : USER_EN}\n<<<\n${masked}\n>>>`;
}

export function voiceMaxTokens(text: string): number {
	return Math.min(1500, Math.ceil(text.length / 2) + 200);
}

export type VoiceComplete = (
	model: string,
	system: string,
	user: string,
	maxTokens: number,
	signal: AbortSignal,
) => Promise<string>;

/**
 * One rephrasing on the router: CH0's settings (temperature 0.3, no repeat
 * penalty, since a rephraser must repeat its source's words; thinking off;
 * explicit max_tokens). Only a finished answer counts (`finish_reason` stop).
 */
export function routerVoice(routerUrl: string | ((model: string) => string)): VoiceComplete {
	return async (model, system, user, maxTokens, signal) => {
		const base = typeof routerUrl === "string" ? routerUrl : routerUrl(model);
		const res = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model,
				stream: false,
				max_tokens: maxTokens,
				temperature: 0.3,
				repeat_penalty: 1.0,
				chat_template_kwargs: { enable_thinking: false },
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
			}),
			signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]), // a hang detector, not a latency budget
		});
		if (!res.ok) throw new Error(`the model answered HTTP ${res.status}`);
		const body = (await res.json()) as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] };
		const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
		if (choice?.finish_reason === "length") throw new Error(`the answer was cut off at ${maxTokens} tokens`);
		if (!choice || typeof choice.message?.content !== "string")
			throw new Error("the model's response had no answer text");
		if (choice.finish_reason !== "stop")
			throw new Error(`the answer ended with ${JSON.stringify(choice.finish_reason ?? null)}, not "stop"`);
		return cleanVoiceOutput(choice.message.content);
	};
}

export function cleanVoiceOutput(raw: string): string {
	return raw
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.replace(/^\s*<<<\s*|\s*>>>\s*$/g, "")
		.trim();
}

/** How much a rephrasing changed its source: edit distance over the longer length (0 = a copy). */
export function changeRatio(a: string, b: string): number {
	if (a === b) return 0;
	const m = a.length;
	const n = b.length;
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const cur = [i];
		for (let j = 1; j <= n; j++)
			cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
		prev = cur;
	}
	return prev[n]! / Math.max(m, n);
}
