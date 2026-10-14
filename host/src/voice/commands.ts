// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * `/voice` (plan 0.009 CH3, owner surfaces only): the shadow voice's samples
 * and the owner's two labels.
 *
 * - `/voice`: status, coverage and the dev split's figures;
 * - `/voice next [eval|dev]`: the next sample without a meaning label, shown
 *   **without** the check's verdict or Kev's answer, so the label is the
 *   owner's own; `/voice show <id>`: everything about one sample;
 * - `/voice same|changed <id>`: meaning; `/voice better|worse <id>`:
 *   preference (better only after "same"; "changed" withdraws a "better");
 *   `/voice correct <id> <text>`: the owner's own wording, refused unless it
 *   passes the meaning check against the original;
 * - `/voice eval`: the sealed evaluation set's figures. The one way to read
 *   them; each read is recorded and counted.
 */

import { easeWord, energyWord, engagementWord } from "../character/mood.ts";
import { isControlValue } from "../character/policy.ts";
import type { Db } from "../state/db.ts";
import { voiceProblem } from "./check.ts";
import { experimentKey, getExperiment, setExperiment } from "./shadow.ts";

interface SampleRow {
	id: string;
	action_id: string;
	scope: string | null;
	audience: string;
	lang: string;
	original: string;
	candidate: string | null;
	model: string;
	prompt_version: string;
	character_rev: number | null;
	mood_sample_id: string | null;
	status: string;
	problem: string | null;
	ms: number | null;
	kev_same: number | null;
	created_at: string;
	acting: number;
	delivered: number;
	experiment_json: string | null;
	split: "eval" | "dev";
	meaning: string | null;
	preference: string | null;
	correction: string | null;
}

const SAMPLE_SQL = `SELECT v.*, s.split, m.value AS meaning, p.value AS preference, p.correction
	FROM voice_samples v JOIN voice_split s ON s.action_id = v.action_id
	LEFT JOIN voice_labels m ON m.sample_id = v.id AND m.kind = 'meaning'
	LEFT JOIN voice_labels p ON p.sample_id = v.id AND p.kind = 'preference'`;

export interface VoiceCommandsDeps {
	db: Db;
	/** CH4: `/voice act …` (absent: acting is not available here). */
	act?: { command(args: string[], by: string): string; report(): string } | null;
	names: () => string[];
	status: () => { model: string | null; pending: number; waiting: string };
	now?: () => Date;
}

export class VoiceCommands {
	private readonly d: Required<VoiceCommandsDeps>;

	constructor(deps: VoiceCommandsDeps) {
		this.d = { now: () => new Date(), act: null, ...deps };
	}

	command(args: string[], by: string): string {
		const [sub, ...rest] = args;
		const usage =
			"usage: /voice [next [eval|dev] | show <id> | same|changed <id> | better|worse <id> | correct <id> <text> | eval | act [on|off owner|contacts|all] | experiment affectionate-skeptic [off|dry|pointed] | experiment off]";
		if (!sub) return this.report();
		if (sub === "act") return this.d.act ? this.d.act.command(rest, by) : "the acting voice is not available here";
		if (sub === "experiment") return this.experiment(rest, by);
		if (sub === "next" && rest.length <= 1 && (!rest[0] || rest[0] === "eval" || rest[0] === "dev"))
			return this.next(rest[0] as "eval" | "dev" | undefined);
		if (sub === "eval" && rest.length === 0) return this.evalReport(by);
		if (sub === "show" && rest.length === 1) return this.withSample(rest[0]!, (s) => this.show(s, true));
		if ((sub === "same" || sub === "changed") && rest.length === 1)
			return this.withSample(rest[0]!, (s) => this.labelMeaning(s, sub, by));
		if ((sub === "better" || sub === "worse") && rest.length === 1)
			return this.withSample(rest[0]!, (s) => this.labelPreference(s, sub, null, by));
		if (sub === "correct" && rest.length >= 2)
			return this.withSample(rest[0]!, (s) => this.labelPreference(s, "worse", rest.slice(1).join(" "), by));
		return usage;
	}

	report(): string {
		const st = this.d.status();
		const all = this.samples("1 = 1");
		const dev = all.filter((s) => s.split === "dev");
		const evalN = all.filter((s) => s.split === "eval").length;
		const lines = [
			"voice (rephrasings of Telegram messages; the shadow ones were made after delivery and never sent)",
			...(this.d.act ? this.d.act.report().split("\n").slice(0, -1) : []),
			`  model: ${st.model ?? "none selected (/use <model> voice; it must be loaded, the host never loads it)"}; ${st.pending} message(s) waiting${st.pending ? ` (${st.waiting})` : ""}`,
			`  samples: ${all.length} (${dev.length} dev, ${evalN} in the sealed evaluation set); ${coverage(all)}`,
			`  owner labels: ${count(all, (s) => s.meaning !== null)} meaning, ${count(all, (s) => s.preference !== null)} preference${count(all, (s) => s.correction !== null) ? ` (${count(all, (s) => s.correction !== null)} in your own words)` : ""}`,
			"dev split:",
			...figures(dev).map((l) => `  ${l}`),
		];
		const recent = all.filter((s) => s.split === "dev").slice(-5);
		if (recent.length) {
			lines.push("latest dev samples:");
			for (const s of recent)
				lines.push(
					`  ${s.id.slice(0, 8)} ${s.status}${s.problem ? ` (${s.problem})` : ""}, ${s.lang}, to ${audienceWord(s.audience)}: ${clip(s.original)} → ${s.candidate ? clip(s.candidate) : "—"}`,
				);
		}
		lines.push("/voice next [eval|dev] · /voice show <id> · /voice eval (recorded)");
		return lines.join("\n");
	}

	/**
	 * `/voice experiment <preset> [sarcasm]` / `off`: the shadow also rephrases messages to the owner with this
	 * preset, as their own samples (their delivery's character and mood, the tested profile recorded apart).
	 * Never sent; not a trial boundary; labels stay with each exact sample.
	 */
	private experiment(args: string[], by: string): string {
		const at = this.d.now().toISOString();
		if (args.length === 1 && args[0] === "off") {
			setExperiment(this.d.db, null, at);
			return "no voice experiment";
		}
		const [preset, sarcasm = "dry"] = args;
		if (args.length === 0) {
			const x = getExperiment(this.d.db);
			return x
				? `voice experiment: ${experimentKey(x)} (set by ${x.by}, ${x.at.slice(0, 16).replace("T", " ")} UTC)`
				: "no voice experiment";
		}
		if (
			args.length > 2 ||
			!isControlValue("preset", preset) ||
			preset === "off" ||
			!isControlValue("sarcasm", sarcasm)
		)
			return "usage: /voice experiment affectionate-skeptic [off|dry|pointed] | /voice experiment off";
		setExperiment(this.d.db, { preset, sarcasm, by, at }, at);
		return `voice experiment: ${experimentKey({ preset, sarcasm })}; the shadow rephrases your Telegram messages with it too, as separate samples (never sent)`;
	}

	private next(split?: "eval" | "dev"): string {
		const rows = this.samples(
			`v.candidate IS NOT NULL AND m.value IS NULL${split ? " AND s.split = ?" : ""} ORDER BY v.created_at LIMIT 1`,
			...(split ? [split] : []),
		);
		const s = rows[0];
		if (!s) return `nothing to label${split ? ` in ${split}` : ""}`;
		return this.show(s, false);
	}

	private show(s: SampleRow, full: boolean): string {
		const mood = s.mood_sample_id
			? (this.d.db.prepare("SELECT energy, ease, engagement FROM mood_samples WHERE id = ?").get(s.mood_sample_id) as
					| { energy: number | null; ease: number; engagement: number | null }
					| undefined)
			: undefined;
		const lines = [
			`voice sample ${s.id.slice(0, 8)} (${s.split}${s.split === "eval" ? ", sealed evaluation set" : ""}; ${s.model}, configuration ${s.prompt_version}${s.experiment_json ? " (an experiment, never sent)" : ""}; to ${audienceWord(s.audience)}, ${s.lang}; ${s.created_at.slice(0, 16).replace("T", " ")} UTC; character revision ${s.character_rev ?? "—"}${mood ? `; mood: energy ${energyWord(mood.energy)}, ${easeWord(mood.ease)}, ${engagementWord(mood.engagement)}` : ""})`,
			s.acting && s.delivered ? "the original (not sent):" : "delivered (as written):",
			indent(s.original),
			s.acting && s.delivered ? "rephrased (sent instead of the original):" : "rephrased (never sent):",
			indent(s.candidate ?? `— (${s.status}: ${s.problem ?? ""})`),
		];
		if (full) {
			lines.push(
				`check: ${s.status}${s.problem ? `: ${s.problem}` : ""}${s.ms !== null ? `; ${(s.ms / 1000).toFixed(1)} s` : ""}`,
			);
			lines.push(
				`Kev "same meaning?": ${s.kev_same === null ? "not asked yet" : `${s.kev_same.toFixed(2)} (shadow)`}`,
			);
		} else lines.push("(the check's verdict and Kev's answer are hidden until you label it: /voice show <id>)");
		lines.push(
			`your labels: meaning ${s.meaning ?? "—"}, preference ${s.preference ?? "—"}${s.correction ? ` (your wording: ${JSON.stringify(s.correction)})` : ""}`,
			`/voice same|changed ${s.id.slice(0, 8)} · /voice better|worse ${s.id.slice(0, 8)} · /voice correct ${s.id.slice(0, 8)} <your wording>`,
		);
		return lines.join("\n");
	}

	private labelMeaning(s: SampleRow, value: "same" | "changed", by: string): string {
		if (s.candidate === null) return `sample ${s.id.slice(0, 8)} has no rephrasing to judge (${s.status})`;
		const at = this.d.now().toISOString();
		this.d.db.transaction(() => {
			this.upsert(s.id, "meaning", value, null, by, at);
			// A changed meaning is never a preferred one.
			if (value === "changed")
				this.d.db
					.prepare("DELETE FROM voice_labels WHERE sample_id = ? AND kind = 'preference' AND value = 'better'")
					.run(s.id);
		})();
		return `meaning of ${s.id.slice(0, 8)}: ${value}${value === "changed" && s.preference === "better" ? ' (your "better" was withdrawn)' : ""}`;
	}

	private labelPreference(s: SampleRow, value: "better" | "worse", correction: string | null, by: string): string {
		if (correction !== null) {
			const problem = voiceProblem(s.original, correction, this.d.names());
			if (problem) return `not kept: your wording does not pass the meaning check against the original (${problem})`;
		} else if (s.candidate === null) return `sample ${s.id.slice(0, 8)} has no rephrasing (${s.status})`;
		if (value === "better" && s.meaning !== "same")
			return `label its meaning first (/voice same ${s.id.slice(0, 8)}): only a rephrasing that kept the meaning can be the better one`;
		this.upsert(s.id, "preference", value, correction, by, this.d.now().toISOString());
		return correction !== null
			? `kept your wording for ${s.id.slice(0, 8)} (the rephrasing counts as worse)`
			: `preference of ${s.id.slice(0, 8)}: ${value}`;
	}

	private upsert(id: string, kind: string, value: string, correction: string | null, by: string, at: string): void {
		this.d.db
			.prepare(
				`INSERT INTO voice_labels (sample_id, kind, value, correction, by, at) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (sample_id, kind) DO UPDATE SET value = excluded.value, correction = excluded.correction,
					by = excluded.by, at = excluded.at`,
			)
			.run(id, kind, value, correction, by, at);
	}

	private evalReport(by: string): string {
		const rows = this.samples("s.split = 'eval'");
		const labelled = count(rows, (s) => s.meaning !== null);
		const earlier = (this.d.db.prepare("SELECT count(*) AS n FROM voice_eval_reads").get() as { n: number }).n;
		this.d.db
			.prepare("INSERT INTO voice_eval_reads (at, by, samples, labelled) VALUES (?, ?, ?, ?)")
			.run(this.d.now().toISOString(), by, rows.length, labelled);
		return [
			`the sealed evaluation set (read ${earlier + 1} time(s), each recorded; never used to tune the prompt or train):`,
			`  ${rows.length} sample(s), ${labelled} with your meaning label; ${coverage(rows)}`,
			...figures(rows).map((l) => `  ${l}`),
		].join("\n");
	}

	private withSample(ref: string, f: (s: SampleRow) => string): string {
		if (!/^[0-9a-f-]{4,36}$/i.test(ref)) return `no voice sample ${JSON.stringify(ref)}`;
		const rows = this.samples("v.id LIKE ?", `${ref.toLowerCase()}%`);
		if (rows.length === 0) return `no voice sample ${ref}`;
		if (rows.length > 1) return `${ref} matches ${rows.length} samples; give more of its id`;
		return f(rows[0]!);
	}

	private samples(where: string, ...args: unknown[]): SampleRow[] {
		return this.d.db
			.prepare(
				`${SAMPLE_SQL} WHERE v.status != 'forgotten' AND ${where}${/ORDER BY/.test(where) ? "" : " ORDER BY v.created_at"}`,
			)
			.all(...args) as SampleRow[];
	}
}

/** The figures of a set of samples: the check against the owner's meaning labels, Kev beside it, timing. */
export function figures(rows: readonly SampleRow[]): string[] {
	if (rows.length === 0) return ["no samples yet"];
	const judged = rows.filter((s) => s.candidate !== null);
	const byStatus = ["accepted", "unchanged", "refused", "error"]
		.map((k) => `${count(rows, (s) => s.status === k)} ${k}`)
		.join(", ");
	const labelled = judged.filter((s) => s.meaning !== null);
	const passed = (s: SampleRow) => s.status === "accepted" || s.status === "unchanged";
	const changed = labelled.filter((s) => s.meaning === "changed");
	const same = labelled.filter((s) => s.meaning === "same");
	const kev = labelled.filter((s) => s.kev_same !== null);
	const ms = rows
		.map((s) => s.ms)
		.filter((x): x is number => x !== null)
		.sort((a, b) => a - b);
	const pct = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((100 * n) / d)} %)` : "—");
	return [
		`check: ${byStatus}`,
		`against your meaning labels: lets through ${pct(changed.filter(passed).length, changed.length)} you called changed; refuses ${pct(same.filter((s) => !passed(s)).length, same.length)} you called same`,
		`Kev "same meaning?" (shadow) agrees with you on ${pct(kev.filter((s) => s.kev_same! >= 0.5 === (s.meaning === "same")).length, kev.length)}`,
		`preference: ${count(rows, (s) => s.preference === "better")} better, ${count(rows, (s) => s.preference === "worse")} worse`,
		`time: median ${ms.length ? `${(ms[Math.floor(ms.length / 2)]! / 1000).toFixed(1)} s` : "—"}`,
	];
}

function coverage(rows: readonly SampleRow[]): string {
	const keys = new Map<string, number>();
	for (const s of rows)
		keys.set(
			`${s.lang} to ${audienceWord(s.audience)}`,
			(keys.get(`${s.lang} to ${audienceWord(s.audience)}`) ?? 0) + 1,
		);
	return keys.size ? `coverage: ${[...keys].map(([k, n]) => `${n} ${k}`).join(", ")}` : "coverage: none";
}

function audienceWord(a: string): string {
	return a === "owner" ? "you" : a === "trusted" ? "a trusted contact" : "a contact";
}

function count<T>(rows: readonly T[], f: (r: T) => boolean): number {
	return rows.filter(f).length;
}

function clip(t: string): string {
	const one = t.replace(/\s+/g, " ").trim();
	return JSON.stringify(one.length > 60 ? `${one.slice(0, 59)}…` : one);
}

function indent(t: string): string {
	return t
		.split("\n")
		.map((l) => `  ${l}`)
		.join("\n");
}
