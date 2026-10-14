// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The voice's training export (plan 0.009 CH6's data path; nothing trains
 * from it on its own). One `{system, input, output}` example per approved
 * rephrasing, the format `decision-worker/voice_train.py` reads:
 *
 * - **only the dev split**: the sealed evaluation set never leaves for
 *   training, and nothing is exported until it holds owner labels;
 * - **only trustworthy positives**: a candidate the owner labelled `same` in
 *   meaning **and** `better` in preference, whose check passed; or the owner's
 *   own wording (`/voice correct`, checked against the original when given).
 *   A stylish but inaccurate rephrasing never becomes an example; rejected
 *   outputs are not consumed (the trainer takes one output per example);
 * - **masked**: input and output carry placeholders, as the voice sees them;
 *   the placeholder mapping stays in SQLite;
 * - **screened**: an example whose masked text still names a known person or
 *   holds a private fact by the fact ledger's rules (a credential, health,
 *   money, an address, "keep it between us") is dropped;
 * - **with lineage**: a manifest maps each example to its sample, original,
 *   person and scope (what `/forget` must reach), model, prompt version,
 *   character revision and mood snapshot.
 */

import { createHash } from "node:crypto";
import { privateTextReason } from "../facts/extract.ts";
import type { Db } from "../state/db.ts";
import { maskFixed } from "./check.ts";

export interface VoiceExample {
	system: string;
	input: string;
	output: string;
}

export interface VoiceExampleLineage {
	example: number;
	sample_id: string;
	action_id: string;
	person_id: string | null;
	scope: string | null;
	model: string;
	prompt_version: string;
	character_rev: number | null;
	mood_sample_id: string | null;
	source: "approved candidate" | "owner wording";
	labelled_by: string;
	labelled_at: string;
}

export type VoiceExport =
	| { ok: false; refused: string }
	| {
			ok: true;
			examples: VoiceExample[];
			lineage: VoiceExampleLineage[];
			dropped: Record<string, number>;
			/** sha256 of the examples as JSON lines, as written. */
			hash: string;
	  };

interface Row {
	id: string;
	action_id: string;
	person_id: string | null;
	scope: string | null;
	model: string;
	prompt_version: string;
	character_rev: number | null;
	mood_sample_id: string | null;
	system: string;
	masked: string;
	segments_json: string;
	output: string | null;
	status: string;
	meaning: string | null;
	preference: string | null;
	correction: string | null;
	pref_by: string | null;
	pref_at: string | null;
}

export function exportVoice(db: Db, names: readonly string[]): VoiceExport {
	const evalLabelled = (
		db
			.prepare(
				`SELECT count(*) AS n FROM voice_samples v JOIN voice_split s ON s.action_id = v.action_id
				 JOIN voice_labels l ON l.sample_id = v.id AND l.kind = 'meaning' WHERE s.split = 'eval'`,
			)
			.get() as { n: number }
	).n;
	if (evalLabelled === 0)
		return {
			ok: false,
			refused:
				"the sealed evaluation set has no owner labels yet: label some of it first (/voice next eval), so a trained voice can be judged on messages it never saw",
		};
	const rows = db
		.prepare(
			`SELECT v.id, v.action_id, v.person_id, v.scope, v.model, v.prompt_version, v.character_rev, v.mood_sample_id,
				v.system, v.masked, v.segments_json, v.output, v.status,
				m.value AS meaning, p.value AS preference, p.correction, p.by AS pref_by, p.at AS pref_at
			 FROM voice_samples v JOIN voice_split s ON s.action_id = v.action_id
			 LEFT JOIN voice_labels m ON m.sample_id = v.id AND m.kind = 'meaning'
			 LEFT JOIN voice_labels p ON p.sample_id = v.id AND p.kind = 'preference'
			 WHERE s.split = 'dev' AND p.sample_id IS NOT NULL
			 ORDER BY v.created_at, v.rowid`,
		)
		.all() as Row[];
	const examples: VoiceExample[] = [];
	const lineage: VoiceExampleLineage[] = [];
	const dropped: Record<string, number> = {};
	const drop = (why: string) => {
		dropped[why] = (dropped[why] ?? 0) + 1;
	};
	const known = names.map((n) => n.trim()).filter((n) => n.length >= 2);
	for (const r of rows) {
		let output: string | null;
		let source: VoiceExampleLineage["source"];
		if (r.correction !== null) {
			output = remask(r.correction, JSON.parse(r.segments_json) as string[], names);
			source = "owner wording";
			if (output === null) {
				drop("the owner's wording holds text the original did not");
				continue;
			}
		} else if (r.preference === "better" && r.meaning === "same" && r.status === "accepted" && r.output) {
			output = r.output;
			source = "approved candidate";
		} else {
			drop(r.preference === "worse" ? "not preferred" : "no meaning label of same, or the check refused it");
			continue;
		}
		const both = `${r.masked}\n${output}`;
		const named = known.find((n) => new RegExp(`(?<![\\p{L}\\d])${escapeRe(n)}(?![\\p{L}\\d])`, "iu").test(both));
		if (named) {
			drop("names a person");
			continue;
		}
		const priv = privateTextReason(both);
		if (priv) {
			drop(`private: ${priv}`);
			continue;
		}
		lineage.push({
			example: examples.length,
			sample_id: r.id,
			action_id: r.action_id,
			person_id: r.person_id,
			scope: r.scope,
			model: r.model,
			prompt_version: r.prompt_version,
			character_rev: r.character_rev,
			mood_sample_id: r.mood_sample_id,
			source,
			labelled_by: r.pref_by!,
			labelled_at: r.pref_at!,
		});
		examples.push({ system: r.system, input: r.masked, output });
	}
	const hash = createHash("sha256").update(examplesJsonl(examples)).digest("hex");
	return { ok: true, examples, lineage, dropped, hash };
}

export function examplesJsonl(examples: readonly VoiceExample[]): string {
	return examples.map((e) => `${JSON.stringify(e)}\n`).join("");
}

/**
 * The owner's wording masked with the original's placeholders: each of its
 * fixed segments must be one of the original's (as the meaning check already
 * required), numbered as the original numbers them.
 */
export function remask(text: string, segments: readonly string[], names: readonly string[]): string | null {
	const m = maskFixed(text, names);
	let out = m.masked;
	const used = new Set<number>();
	for (let i = 0; i < m.segments.length; i++) {
		const idx = segments.findIndex((s, j) => s === m.segments[i] && !used.has(j));
		if (idx < 0) return null;
		used.add(idx);
		out = out.replace(`⟦${i + 1}⟧`, `⟦#${idx + 1}⟧`);
	}
	return out.replace(/⟦#(\d+)⟧/g, "⟦$1⟧");
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
