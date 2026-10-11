// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Which voice configuration one message gets (owner decision 13), shared by
 * the acting voice, the shadow and experiments: the preset applies only to a
 * message to the owner (by the established audience classification, never a
 * guess from the route), speaks plainly about failures and private matters,
 * and is otherwise ordinary CH4 expression.
 */

import { type Controls, renderVoicePreset } from "../character/policy.ts";
import { privateTextReason } from "../facts/extract.ts";
import { reportsFailure } from "./check.ts";
import { type VoiceLang, voiceConfigVersion } from "./prompt.ts";

export interface VoiceConfig {
	/** The preset's instructions for the system prompt, or null (ordinary expression). */
	presetText: string | null;
	presetVersion: string | null;
	/** The sample's identity part: `prompt_version`. */
	version: string;
	/** The preset was asked to speak plainly (a failure, a private matter). */
	plain: boolean;
}

export function voiceConfig(
	controls: Controls | null,
	audience: "owner" | "trusted" | "contact",
	lang: VoiceLang,
	original: string,
): VoiceConfig {
	if (!controls || controls.preset === "off" || audience !== "owner" || controls.audience !== "owner-only")
		return { presetText: null, presetVersion: null, version: voiceConfigVersion(null), plain: false };
	const plain = reportsFailure(original) || privateTextReason(original) !== null;
	const p = renderVoicePreset(controls, lang, plain)!;
	return { presetText: p.text, presetVersion: p.version, version: voiceConfigVersion(p.version), plain };
}
