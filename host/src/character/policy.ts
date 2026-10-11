// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-selected controls of the character (plan 0.009, owner decision 13)
 * and their host-owned definitions. Three separate controls:
 *
 * - **reasoning** (`critique`): what the chat model is asked to do about the
 *   owner's claims; rendered into Pi's prompt for the owner's conversation;
 * - **perspective**: a philosophical stance, also in the owner's prompt;
 * - **voice** (`preset`, `sarcasm`): how the voice expresses content that is
 *   already established; never in Pi's prompt (decision 8 still holds for
 *   expression: style, sarcasm, mood and dials stay out).
 *
 * Every selectable value is allowlisted. The text each value stands for is an
 * immutable definition with a version; a changed word is a new version, and
 * old versions stay here so historical samples and turns can be read.
 * Selections store only the value and its definition version.
 */

import { createHash } from "node:crypto";

export const CONTROL_VALUES = {
	critique: ["off", "material-errors"],
	perspective: ["off", "berkeley-inspired"],
	preset: ["off", "affectionate-skeptic"],
	sarcasm: ["off", "dry", "pointed"],
	audience: ["owner-only"],
} as const;
export type ControlName = keyof typeof CONTROL_VALUES;
export type ControlValue<C extends ControlName> = (typeof CONTROL_VALUES)[C][number];
export const CONTROL_NAMES = Object.keys(CONTROL_VALUES) as ControlName[];

/** The definition texts, by control, value and version (immutable: add a version, never edit one). */
export const REASONING_DEFS: Record<string, { version: string; text: string }> = {
	"material-errors": {
		version: "critique-1",
		text: "Examine the owner's claims for material errors. Identify the exact claim, explain the problem, and give the correction or missing condition. Distinguish factual errors, invalid inferences, uncertain premises, ambiguity, and differences in values. Do not manufacture objections. Recognize sound arguments, check your own reasoning, and acknowledge your mistakes directly. Follow existing tool-verification rules.",
	},
};

export const PERSPECTIVE_DEFS: Record<string, { version: string; text: string }> = {
	"berkeley-inspired": {
		version: "berkeley-1",
		text: [
			"Adopt a Berkeley-inspired perspective: knowledge of the world arrives through experience and representation. Explore what observations establish when relevant. Treat this as a philosophical stance, not evidence that you create events or imagine other people into existence. Preserve evidence, other people's autonomy, causal explanations, and responsibility for your errors. Do not introduce metaphysics into unrelated practical replies.",
			"In an explicitly philosophical conversation, \"everything is imagined by me\" may be used only as an openly playful metaphor; it is never a factual belief or an excuse for a mistake, and it is not Berkeley's doctrine (Berkeley held that things exist as perceived by minds, ultimately God's, not that you create the world).",
		].join(" "),
	},
};

/** The voice preset: the rules (English and Russian, equivalent) and a sarcasm line per level. */
export const VOICE_PRESET_DEFS: Record<
	string,
	{ version: string; en: string; ru: string; sarcasm: Record<"off" | "dry" | "pointed", { en: string; ru: string }> }
> = {
	"affectionate-skeptic": {
		version: "skeptic-1",
		en: "Preserve every assertion, uncertainty, attribution, refusal, commitment, and correction. Use concise, friendly language and occasional dry wit. When the original explains an error, wit may target the faulty inference, never the person's intelligence or dignity. Add no criticism, idealist claim, insult, or conclusion. Do not force a joke into every reply.",
		ru: "Сохрани каждое утверждение, сомнение, ссылку на источник, отказ, обязательство и исправление. Пиши кратко и дружелюбно, изредка с сухим юмором. Если в сообщении объясняется ошибка, ирония может касаться неверного вывода, но никогда не ума или достоинства человека. Не добавляй критики, идеалистических утверждений, оскорблений или выводов. Не вставляй шутку в каждый ответ.",
		sarcasm: {
			off: { en: "Wit: none; plain and friendly.", ru: "Юмор: никакого; просто и дружелюбно." },
			dry: { en: "Wit: dry and light, at most one touch.", ru: "Юмор: сухой и лёгкий, не больше одного штриха." },
			pointed: {
				en: "Wit: pointed but kind, at most one touch, aimed only at the faulty reasoning.",
				ru: "Юмор: острый, но добрый, не больше одного штриха, только в адрес неверного рассуждения.",
			},
		},
	},
};

export interface Controls {
	critique: ControlValue<"critique">;
	perspective: ControlValue<"perspective">;
	preset: ControlValue<"preset">;
	sarcasm: ControlValue<"sarcasm">;
	audience: ControlValue<"audience">;
}

export const CONTROLS_OFF: Controls = {
	critique: "off",
	perspective: "off",
	preset: "off",
	sarcasm: "off",
	audience: "owner-only",
};

export function isControlValue<C extends ControlName>(c: C, v: unknown): v is ControlValue<C> {
	return (CONTROL_VALUES[c] as readonly unknown[]).includes(v);
}

/** The text that enters Pi's prompt for the owner's conversation, its definition versions and digest; null when off. */
export function renderMind(c: Controls): { text: string; versions: string[]; digest: string } | null {
	const parts: { version: string; text: string }[] = [];
	if (c.critique !== "off") parts.push(REASONING_DEFS[c.critique]!);
	if (c.perspective !== "off") parts.push(PERSPECTIVE_DEFS[c.perspective]!);
	if (parts.length === 0) return null;
	const text = parts.map((p) => p.text).join("\n\n");
	return { text, versions: parts.map((p) => p.version), digest: sha(text) };
}

/** The voice's preset instructions for one message, or null (no preset: ordinary CH4 expression). */
export function renderVoicePreset(
	c: Controls,
	lang: "en" | "ru" | "other",
	plain: boolean,
): { text: string; version: string } | null {
	if (c.preset === "off") return null;
	const def = VOICE_PRESET_DEFS[c.preset]!;
	const level = plain ? "off" : c.sarcasm;
	const l = lang === "ru" ? "ru" : "en";
	// The version names the definition and hashes it with the plain-wording rule, both languages and every level.
	const hash = sha(JSON.stringify({ def, PLAIN_RULE })).slice(0, 6);
	return { text: `${def[l]}\n${def.sarcasm[level][l]}`, version: `${def.version}.${hash}:${level}` };
}

/** When the preset speaks plainly (no wit): a reported failure, or text the fact ledger would call private. */
export const PLAIN_RULE = "plain-1: reportsFailure(original) || privateTextReason(original) !== null";

/** The live configuration's digest for the M4 trial (null when everything is off). */
export function controlsDigest(c: Controls): string | null {
	if (c.critique === "off" && c.perspective === "off" && c.preset === "off") return null;
	const mind = renderMind(c);
	const preset = c.preset === "off" ? null : VOICE_PRESET_DEFS[c.preset]!;
	return sha(
		JSON.stringify({ mind: mind?.versions ?? [], preset: preset?.version ?? null, sarcasm: c.sarcasm }),
	).slice(0, 12);
}

/** The style the preset seeds (dials the owner pinned are kept; `observations` is never touched). */
export const PRESET_STYLE_SEED: Record<
	string,
	Partial<Record<"length" | "warmth" | "playfulness" | "formality" | "emoji", number>>
> = {
	"affectionate-skeptic": { length: 0.3, warmth: 0.6, playfulness: 0.65, formality: 0.25, emoji: 0 },
};

function sha(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}
