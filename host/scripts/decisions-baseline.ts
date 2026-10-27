// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.017 N0: how the released decision model does against the owner's
 * labels, from the journal alone (no model call, no GPU). Opens the database
 * read-only; point it at a copy (`sqlite3 -readonly ~/.iyye2/iyye.db
 * ".backup <copy>"`), never at a live file opened for writing.
 *
 *   node scripts/decisions-baseline.ts <db> [--export <labels.jsonl>]
 *
 * Per role and owner question: how many owner labels (owner and iyye scope,
 * decision 1), Kev's agreement at its abstain band, Brier score and log loss
 * of the journaled probability (served at the checkpoint's temperature), and
 * the same against the weak labels where a role has them, marked weak. It
 * first checks that every answer came from one checkpoint, temperature and
 * LoRA: a baseline mixed across revisions would mean nothing.
 *
 * `--export` writes the owner-labelled rows as Kev's labelled JSONL (the
 * state exactly as sent, one `noul` per labelled question), so a checkpoint
 * can score them again (`decision-worker/predict.py`, `kev.benchmark --data`).
 * The file holds what people said: keep it in a 0700 directory on the Spark.
 */

import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";

const SCOPES = ["owner", "iyye"];
const [path, flag, out] = process.argv.slice(2);
if (!path || (flag !== undefined && (flag !== "--export" || !out))) {
	console.error("usage: node scripts/decisions-baseline.ts <db> [--export <labels.jsonl>]");
	process.exit(2);
}
const db = new Database(path, { readonly: true, fileMustExist: true });

interface Row {
	id: string;
	role: string;
	schema_version: number;
	scope: string;
	state_json: string;
	questions_json: string;
	answers_json: string | null;
	verdicts_json: string | null;
	outcome_json: string | null;
	label_strength: string | null;
	checkpoint: string | null;
	temperature: number | null;
	lora: number | null;
	status: string;
}

const rows = db
	.prepare(
		`SELECT id, role, schema_version, scope, state_json, questions_json, answers_json, verdicts_json, outcome_json,
			label_strength, checkpoint, temperature, lora, status
		 FROM decisions WHERE scope IN (${SCOPES.map(() => "?").join(", ")})`,
	)
	.all(...SCOPES) as Row[];
const byId = new Map(rows.map((r) => [r.id, r]));

// Owner labels: the table from migration 043, or (an older copy) the owner outcomes it was built from.
const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decision_labels'").get();
const labels: { id: string; question: string; value: boolean }[] = hasTable
	? (
			db.prepare("SELECT decision_id, question, value FROM decision_labels WHERE value IS NOT NULL").all() as {
				decision_id: string;
				question: string;
				value: number;
			}[]
		).map((l) => ({ id: l.decision_id, question: l.question, value: l.value === 1 }))
	: rows
			.filter((r) => r.label_strength === "owner" && r.outcome_json)
			.flatMap((r) =>
				Object.entries(JSON.parse(r.outcome_json!) as Record<string, unknown>)
					.filter(([, v]) => typeof v === "boolean")
					.map(([q, v]) => ({ id: r.id, question: q, value: v as boolean })),
			);
const owned = labels.filter((l) => byId.has(l.id));

const revisions = new Map<string, number>();
for (const r of rows.filter((r) => r.status === "ok")) {
	// Rows from before migration 015 did not record the LoRA rank (null): the same revision.
	const k = `${r.checkpoint} · T ${r.temperature}`;
	revisions.set(k, (revisions.get(k) ?? 0) + 1);
}
console.log(`database ${path} (read-only); owner and iyye scope: ${rows.length} decisions`);
console.log("answered by:", Object.fromEntries(revisions));
if (revisions.size !== 1) console.log("WARNING: more than one revision answered; a pooled baseline would mix them");

interface Point {
	p: number | null;
	verdict: string | null;
	y: boolean;
}
function summary(name: string, pts: Point[]): string {
	const n = pts.length;
	const yes = pts.filter((x) => x.y).length;
	const answered = pts.filter((x): x is Point & { p: number } => x.p !== null);
	const decided = pts.filter((x) => x.verdict === "yes" || x.verdict === "no");
	const agree = decided.filter((x) => (x.verdict === "yes") === x.y).length;
	const brier = answered.reduce((s, x) => s + (x.p - (x.y ? 1 : 0)) ** 2, 0) / (answered.length || 1);
	const eps = 1e-6;
	const nll =
		answered.reduce((s, x) => s - Math.log(Math.min(1 - eps, Math.max(eps, x.y ? x.p : 1 - x.p))), 0) /
		(answered.length || 1);
	const base = Math.max(yes, n - yes) / (n || 1);
	return (
		`  ${name}: ${n} labels (${yes} yes · ${n - yes} no) · answered ${answered.length}` +
		(answered.length
			? ` · at the band ${agree}/${decided.length} agree, ${n - decided.length} unsure · Brier ${brier.toFixed(3)} · log loss ${nll.toFixed(3)} · majority class ${(100 * base).toFixed(0)}%`
			: "")
	);
}
function point(r: Row, question: string, y: boolean): Point {
	const a = r.answers_json ? (JSON.parse(r.answers_json) as Record<string, { noul?: number }>) : {};
	const v = r.verdicts_json ? (JSON.parse(r.verdicts_json) as Record<string, string>) : {};
	return { p: typeof a[question]?.noul === "number" ? a[question]!.noul! : null, verdict: v[question] ?? null, y };
}

console.log("\nowner labels (the only labels a test set or a verdict may use):");
const groups = new Map<string, Point[]>();
for (const l of owned) {
	const r = byId.get(l.id)!;
	const k = `${r.role} ${l.question}`;
	groups.set(k, [...(groups.get(k) ?? []), point(r, l.question, l.value)]);
}
if (groups.size === 0) console.log("  none");
for (const [k, pts] of [...groups].sort()) console.log(summary(k, pts));

console.log("\nweak labels (another model or a record; never a test set):");
const weak = new Map<string, Point[]>();
const add = (k: string, p: Point) => weak.set(k, [...(weak.get(k) ?? []), p]);
for (const r of rows) {
	if (r.status !== "ok" || r.label_strength !== "weak" || !r.outcome_json) continue;
	const o = JSON.parse(r.outcome_json) as Record<string, unknown>;
	if (r.role === "memory_salience" && typeof o.worth_remembering === "boolean")
		add(
			"memory_salience worth_remembering (Hindsight kept something)",
			point(r, "worth_remembering", o.worth_remembering),
		);
	if (r.role === "reply_review" && r.schema_version >= 2 && typeof o.commitment_created === "boolean")
		add(
			"reply_review claims_arranged (the turn made a reminder: a ledger fact, not a claims label)",
			point(r, "claims_arranged", o.commitment_created),
		);
	if (r.role === "toolkit_selection" && Array.isArray(o.used))
		for (const q of JSON.parse(r.questions_json) as { id: string }[])
			if ((o.used as string[]).includes(q.id))
				add(`toolkit_selection ${q.id} (used: positives only)`, point(r, q.id, true));
}
for (const [k, pts] of [...weak].sort()) console.log(summary(k, pts));

if (out) {
	const records = new Map<string, { state: unknown; questions: Record<string, unknown>; _meta: unknown }>();
	for (const l of owned) {
		const r = byId.get(l.id)!;
		const q = (JSON.parse(r.questions_json) as { id: string; instructions: string }[]).find(
			(x) => x.id === l.question,
		);
		if (!q) continue;
		const rec = records.get(r.id) ?? {
			state: JSON.parse(r.state_json) as unknown,
			questions: {},
			_meta: { id: `iyye/${r.id}`, source: `iyye_${r.role}`, group_id: `iyye/${r.id}` },
		};
		rec.questions[l.question] = { type: "noul", instructions: q.instructions, label: l.value };
		records.set(r.id, rec);
	}
	writeFileSync(out, `${[...records.values()].map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });
	console.log(`\nexported ${records.size} labelled rows to ${out}`);
}
db.close();
