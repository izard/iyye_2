// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision datasets (plan 0.017 N2, HLD §10.2–10.4): what a training session
 * trains and judges a candidate on, cut from the decision journal and the
 * owner's labels, and frozen before the session starts.
 *
 * - **Whose rows (decision 1):** owner and `iyye` scope only. A contact's
 *   decision never enters a dataset.
 * - **What is left out, with its reason:** rows of a forgotten scope, rows
 *   whose state names a forgotten person (`mentions.ts`), rows Kev did not
 *   answer, states the host clipped, a question the owner labelled both ways.
 *   The manifest keeps ids and reasons, never a name and never the text.
 * - **One message is one example:** rows of a role with the same state are
 *   merged, and every example whose message is the same text, in any role and
 *   on any day, belongs to the day that message was first seen. So the same
 *   words are never on both sides of a split.
 * - **Labels (decisions 2, 8):** the owner's, per question (`decision_labels`).
 *   Weak labels enter only where the policy names their source, only in
 *   training, marked weak, and never where the owner answered. The model's own
 *   answers are never labels; a toolkit that went unused is not a "no"; the
 *   commitments ledger's fact is never a `claims_arranged` label.
 * - **Splits:** by whole days, in time order. The latest days are the sealed
 *   test set; validation is whole days of the training period. A training or
 *   validation example is always older than every test example.
 * - **The test set is sealed (`decision_test_sets`):** a range of days that
 *   never changes. While it is active its days are test in every dataset, the
 *   days after it are held out (they are later than the test), and each time
 *   its rows leave the database is a recorded look. It is retired when it has
 *   been looked at `testLooks` times, or as soon as the days after it hold
 *   enough labels for a fresh one; only then do its days join the training
 *   period, and the fresh set starts strictly after it.
 * - **Frozen:** `freezeDataset` writes the manifest and its hash in one
 *   transaction (`decision_datasets`); nothing changes it afterwards. The
 *   JSONL a run trains on is written from it (`writeDataset`) and deleted after
 *   the run; a dataset holding a row that a `/forget` has since removed, or
 *   that now names a forgotten person, is refused.
 *
 * Nothing here trains, scores or activates anything.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mentionsAny } from "../memory/mentions.ts";
import type { Db } from "../state/db.ts";
import { isForgotten } from "../state/tombstones.ts";
import { forgottenNames, localDay, QUEUE_SCOPES } from "./labels.ts";
import { MEMORY_SALIENCE } from "./memory-salience.ts";
import { OBSERVATION_IMPORTANCE } from "./observation-importance.ts";
import { REPLY_REVIEW } from "./reply-review.ts";
import { TOOLKIT_SELECTION } from "./toolkit-selection.ts";

/** The first adapter's roles (decision 8). */
export const DATASET_ROLES: readonly string[] = [
	MEMORY_SALIENCE.name,
	OBSERVATION_IMPORTANCE.name,
	REPLY_REVIEW.name,
	TOOLKIT_SELECTION.name,
];

/** The weak labels decision 2 names as possible later: Hindsight kept something; the turn used the toolkit. */
export type WeakSource = "memory_salience.transfer" | "toolkit_selection.used";

export interface DatasetPolicy {
	version: 1;
	scopes: string[];
	roles: string[];
	/** Weak label sources allowed into training (decision 2: none). */
	weak: WeakSource[];
	/** The test set's share of the owner's labels, and the fewest it may hold. */
	testFraction: number;
	testMinLabels: number;
	/** Validation's share of the training period's owner labels. */
	validationFraction: number;
	/** How often a test set may be looked at before it is retired (IYYE2_TEST_LOOKS). */
	testLooks: number;
}

export function datasetPolicy(over: Partial<DatasetPolicy> = {}): DatasetPolicy {
	return {
		version: 1,
		scopes: [...QUEUE_SCOPES],
		roles: [...DATASET_ROLES],
		weak: [],
		testFraction: 0.2,
		testMinLabels: 30,
		validationFraction: 0.15,
		testLooks: 5,
		...over,
	};
}

export type Split = "train" | "validation" | "test" | "held";

export type Exclusion =
	| "scope"
	| "forgotten"
	| "names_forgotten_person"
	| "not_answered"
	| "clipped"
	| "conflicting_labels"
	| "owner_skipped"
	| "weak_outside_training";

export interface ManifestLabel {
	label: boolean;
	strength: "owner" | "weak";
	/** Who or what said so: the owner surface that labelled it, or the weak source. */
	source: string;
	/** How the question reached the owner (the queue's tier, or `direct`); absent for a weak label. */
	via?: string;
}

export interface ManifestRow {
	/** The decision the example is exported from (the earliest with this state). */
	id: string;
	role: string;
	schema: number;
	scope: string;
	state_hash: string;
	/** The local day the example's message was first seen: what the splits are made of. */
	day: string;
	split: Split;
	questions: Record<string, ManifestLabel>;
	/** Other decisions with the same state, merged into this example. */
	merged: string[];
}

export interface TestSetInfo {
	id: string;
	from_day: string;
	to_day: string;
	/** Looks recorded when the dataset was cut. */
	looks: number;
	/** `new`: created with this dataset; `kept`: the active one, used again. */
	origin: "new" | "kept";
}

export interface DatasetManifest {
	version: 1;
	cut_at: string;
	policy: DatasetPolicy;
	/** Null only in a cut that could not be frozen (`problem`). */
	test_set: TestSetInfo | null;
	/** Test sets this cut retires, so their days join the training period. */
	retires: { id: string; reason: "looks" | "superseded" }[];
	rows: ManifestRow[];
	/** Labelled rows left out, by decision id; contacts' rows are only counted. */
	excluded: { id: string; reason: Exclusion; question?: string }[];
	excluded_counts: Partial<Record<Exclusion, number>>;
	/** Answered rows in scope that nobody labelled. */
	unlabelled: number;
	/** Why this cut cannot be frozen, if it cannot. */
	problem: string | null;
}

interface DecisionRow {
	id: string;
	role: string;
	schema_version: number;
	scope: string | null;
	subject_ref: string | null;
	state_json: string;
	state_hash: string;
	questions_json: string;
	status: string;
	outcome_json: string | null;
	label_strength: string | null;
	created_at: string;
}

interface LabelRow {
	decision_id: string;
	question: string;
	value: number | null;
	labelled_by: string;
	labelled_at: string;
	via: string;
}

export interface TestSetRow {
	id: string;
	from_day: string;
	to_day: string;
	created_at: string;
	retired_at: string | null;
	retired_reason: string | null;
}

/** The host clips a turn's message at this length (toolkit selection): a state of exactly that length was cut. */
const MESSAGE_CLIP = 4000;

function hasTable(db: Db, name: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** Keys sorted at every level: the same content always gives the same text, and so the same hash. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const o = value as Record<string, unknown>;
		return `{${Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function manifestHash(manifest: DatasetManifest): string {
	return createHash("sha256").update(canonical(manifest)).digest("hex");
}

/** The message a state is about, as one key: the same words in another role or on another day give the same key. */
function textKey(stateJson: string): string {
	const s = JSON.parse(stateJson) as unknown;
	const text =
		typeof s === "string"
			? s
			: s && typeof s === "object" && typeof (s as { message?: unknown }).message === "string"
				? (s as { message: string }).message
				: stateJson;
	return createHash("sha256").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
}

function clipped(stateJson: string): boolean {
	const s = JSON.parse(stateJson) as unknown;
	const m = s && typeof s === "object" ? (s as { message?: unknown }).message : null;
	return typeof m === "string" && m.length >= MESSAGE_CLIP;
}

/**
 * When the thing a decision is about happened, from its lineage: a turn's start, the message a night's
 * salience question or a reply review goes back to. A question asked after midnight about yesterday's
 * message belongs to yesterday. Without a lineage, when the decision was made.
 */
function eventTimes(db: Db): (row: DecisionRow) => string {
	const eventAt = db.prepare("SELECT received_at FROM events WHERE id = ?");
	const actionEventAt = db.prepare(
		"SELECT coalesce(e.received_at, a.created_at) AS at FROM actions a LEFT JOIN events e ON e.id = a.event_id WHERE a.id = ?",
	);
	return (row) => {
		const ref = row.subject_ref ?? "";
		if (ref.startsWith("turn@")) {
			const t = Date.parse(ref.slice("turn@".length));
			if (Number.isFinite(t)) return new Date(t).toISOString();
		}
		if (ref && row.role === MEMORY_SALIENCE.name) {
			const e = eventAt.get(ref) as { received_at: string } | undefined;
			if (e) return e.received_at;
		}
		if (ref && row.role === REPLY_REVIEW.name) {
			const a = actionEventAt.get(ref) as { at: string } | undefined;
			if (a) return a.at;
		}
		return row.created_at;
	};
}

/** A row's weak labels under the policy (plan §3.1: never equal, and only these). */
function weakLabels(row: DecisionRow, policy: DatasetPolicy): Record<string, ManifestLabel> {
	const out: Record<string, ManifestLabel> = {};
	if (!row.outcome_json || row.label_strength !== "weak") return out;
	const o = JSON.parse(row.outcome_json) as Record<string, unknown>;
	const asked = new Set((JSON.parse(row.questions_json) as { id: string }[]).map((q) => q.id));
	if (
		policy.weak.includes("memory_salience.transfer") &&
		row.role === MEMORY_SALIENCE.name &&
		typeof o.worth_remembering === "boolean" &&
		asked.has("worth_remembering")
	)
		out.worth_remembering = { label: o.worth_remembering, strength: "weak", source: "memory_salience.transfer" };
	if (policy.weak.includes("toolkit_selection.used") && row.role === TOOLKIT_SELECTION.name && Array.isArray(o.used))
		// A positive only: an unused toolkit is not a "no".
		for (const kit of o.used as unknown[])
			if (typeof kit === "string" && asked.has(kit))
				out[kit] = { label: true, strength: "weak", source: "toolkit_selection.used" };
	return out;
}

export interface TestSetChoice {
	/** The test set's days, or null when there is none to use. */
	range: { from_day: string; to_day: string } | null;
	/** The active set kept (`range` is its days), or null when a new one is to be created. */
	keep: TestSetRow | null;
	retires: { id: string; reason: "looks" | "superseded" }[];
	problem: string | null;
}

/**
 * Which days are the test set (pure). `counts`: owner labels per day; `today` closes a new set's range.
 *
 * - The active set is kept while it has looks left and the days after it do not yet hold a full fresh one.
 * - Otherwise it is retired, and the fresh set is the latest days, strictly after every earlier set, that hold
 *   the target number of labels (`testFraction` of all, at least `testMinLabels`).
 * - With too few labels after the last set there is no test set, and so no dataset.
 */
export function chooseTestSet(
	counts: ReadonlyMap<string, number>,
	sets: readonly TestSetRow[],
	looks: ReadonlyMap<string, number>,
	policy: DatasetPolicy,
	today: string,
): TestSetChoice {
	const days = [...counts.keys()].sort();
	const total = days.reduce((n, d) => n + counts.get(d)!, 0);
	const target = Math.max(policy.testMinLabels, Math.ceil(policy.testFraction * total));
	const after = (day: string | null) => days.filter((d) => day === null || d > day);
	const sum = (ds: readonly string[]) => ds.reduce((n, d) => n + counts.get(d)!, 0);
	const retires: TestSetChoice["retires"] = [];
	const active = sets.find((s) => s.retired_at === null) ?? null;
	if (active) {
		const spent = (looks.get(active.id) ?? 0) >= policy.testLooks;
		if (!spent && sum(after(active.to_day)) < target)
			return { range: { from_day: active.from_day, to_day: active.to_day }, keep: active, retires, problem: null };
		retires.push({ id: active.id, reason: spent ? "looks" : "superseded" });
	}
	const floor = sets.reduce<string | null>((m, s) => (m === null || s.to_day > m ? s.to_day : m), null);
	const fresh = after(floor);
	const available = sum(fresh);
	if (available < policy.testMinLabels)
		return {
			range: null,
			keep: null,
			retires,
			problem:
				floor === null
					? `too few owner labels for a sealed test set: ${available}, and ${policy.testMinLabels} are needed`
					: `no fresh test set yet: ${available} owner label(s) on days after ${floor}, and ${policy.testMinLabels} are needed`,
		};
	// The latest days that reach the target (or all of the fresh days, when they hold less than the target).
	let from = fresh[0]!;
	let n = 0;
	for (let i = fresh.length - 1; i >= 0; i--) {
		n += counts.get(fresh[i]!)!;
		from = fresh[i]!;
		if (n >= target) break;
	}
	if (sum(days.filter((d) => d < from)) === 0)
		return {
			range: null,
			keep: null,
			retires,
			problem: "every owner label falls in the test set's days: nothing would be left to train on",
		};
	const last = days.at(-1)!;
	return { range: { from_day: from, to_day: today > last ? today : last }, keep: null, retires, problem: null };
}

/**
 * Which days of the training period are validation (pure: the same period gives the same days; the order they
 * are taken in is a hash of the day, not its place in time, so validation is not just the oldest or newest days).
 */
export function chooseValidationDays(counts: ReadonlyMap<string, number>, fraction: number): Set<string> {
	const days = [...counts.keys()].filter((d) => counts.get(d)! > 0);
	const total = days.reduce((n, d) => n + counts.get(d)!, 0);
	const want = Math.ceil(fraction * total);
	const order = days
		.map((d) => ({ d, h: createHash("sha256").update(`iyye-validation|${d}`).digest("hex") }))
		.sort((a, b) => a.h.localeCompare(b.h));
	const out = new Set<string>();
	let n = 0;
	for (const { d } of order) {
		// Never the whole period: something must be left to train on.
		if (n >= want || out.size >= days.length - 1) break;
		out.add(d);
		n += counts.get(d)!;
	}
	return out;
}

/**
 * Cut a dataset from the records as they are now, without writing anything (so it works on a database opened
 * read-only). `testSetId` names the test set a freeze would create.
 */
export function planDataset(db: Db, opts: { policy: DatasetPolicy; now: Date; testSetId?: string }): DatasetManifest {
	const { policy, now } = opts;
	const marks = policy.roles.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT id, role, schema_version, scope, subject_ref, state_json, state_hash, questions_json, status,
				outcome_json, label_strength, created_at
			 FROM decisions WHERE role IN (${marks}) ORDER BY created_at, rowid`,
		)
		.all(...policy.roles) as DecisionRow[];
	const labels = new Map<string, LabelRow[]>();
	for (const l of db
		.prepare(
			`SELECT l.decision_id, l.question, l.value, l.labelled_by, l.labelled_at, l.via FROM decision_labels l
			 JOIN decisions d ON d.id = l.decision_id WHERE d.role IN (${marks}) ORDER BY l.labelled_at, l.rowid`,
		)
		.all(...policy.roles) as LabelRow[])
		labels.set(l.decision_id, [...(labels.get(l.decision_id) ?? []), l]);
	const names = forgottenNames(db);
	const eventAt = eventTimes(db);

	const excluded: DatasetManifest["excluded"] = [];
	const excludedCounts: Partial<Record<Exclusion, number>> = {};
	const exclude = (id: string | null, reason: Exclusion, question?: string) => {
		excludedCounts[reason] = (excludedCounts[reason] ?? 0) + 1;
		if (id) excluded.push({ id, reason, ...(question ? { question } : {}) });
	};

	// 1. Which rows may be used at all. Only a row somebody labelled is listed when it is left out.
	const usable: DecisionRow[] = [];
	for (const r of rows) {
		const labelled = (labels.get(r.id) ?? []).some((l) => l.value !== null);
		const reason: Exclusion | null =
			r.scope === null || !policy.scopes.includes(r.scope)
				? "scope"
				: isForgotten(db, r.scope, r.created_at)
					? "forgotten"
					: r.status !== "ok"
						? "not_answered"
						: clipped(r.state_json)
							? "clipped"
							: names.length && mentionsAny(r.state_json, names)
								? "names_forgotten_person"
								: null;
		if (reason === null) usable.push(r);
		// A contact's row is counted, never listed: the manifest holds nothing of theirs.
		else if (labelled) exclude(reason === "scope" ? null : r.id, reason);
	}

	// 2. The day of every message: the earliest day its words were seen, in any role.
	const firstDay = new Map<string, string>();
	const keyOf = new Map<string, string>();
	for (const r of usable) {
		const key = textKey(r.state_json);
		keyOf.set(r.id, key);
		const day = localDay(new Date(eventAt(r)));
		const seen = firstDay.get(key);
		if (seen === undefined || day < seen) firstDay.set(key, day);
	}

	// 3. One example per role and state; the labels of every row with that state, the owner's over a weak one.
	interface Example {
		row: DecisionRow;
		merged: string[];
		questions: Record<string, ManifestLabel>;
		conflicts: Set<string>;
	}
	const examples = new Map<string, Example>();
	let unlabelled = 0;
	for (const r of usable) {
		const asked = new Set((JSON.parse(r.questions_json) as { id: string }[]).map((q) => q.id));
		const mine: Record<string, ManifestLabel> = weakLabels(r, policy);
		for (const l of labels.get(r.id) ?? []) {
			if (!asked.has(l.question)) continue;
			if (l.value === null) {
				exclude(r.id, "owner_skipped", l.question);
				delete mine[l.question]; // the owner looked and could not tell: a weak label does not decide it
				continue;
			}
			mine[l.question] = { label: l.value === 1, strength: "owner", source: l.labelled_by, via: l.via };
		}
		if (Object.keys(mine).length === 0) {
			unlabelled++;
			continue;
		}
		const key = `${r.role}|${r.state_hash}`;
		const ex = examples.get(key) ?? { row: r, merged: [], questions: {}, conflicts: new Set<string>() };
		if (ex.row !== r) ex.merged.push(r.id);
		for (const [q, l] of Object.entries(mine)) {
			const have = ex.questions[q];
			if (!have || (have.strength === "weak" && l.strength === "owner")) ex.questions[q] = l;
			else if (have.strength === "owner" && l.strength === "owner" && have.label !== l.label) ex.conflicts.add(q);
		}
		examples.set(key, ex);
	}
	for (const ex of examples.values())
		for (const q of ex.conflicts) {
			// The owner answered the same state both ways: neither answer is used.
			delete ex.questions[q];
			for (const id of [ex.row.id, ...ex.merged]) exclude(id, "conflicting_labels", q);
		}
	const kept = [...examples.values()].filter((ex) => Object.keys(ex.questions).length > 0);
	const dayOf = (ex: Example) => firstDay.get(keyOf.get(ex.row.id)!)!;
	const ownerLabels = (ex: Example) => Object.values(ex.questions).filter((l) => l.strength === "owner").length;

	// 4. The test set: whole days, the latest; sealed for as long as it is active.
	const perDay = new Map<string, number>();
	for (const ex of kept) {
		const n = ownerLabels(ex);
		if (n) perDay.set(dayOf(ex), (perDay.get(dayOf(ex)) ?? 0) + n);
	}
	const stored = hasTable(db, "decision_test_sets");
	const sets = stored ? (db.prepare("SELECT * FROM decision_test_sets ORDER BY from_day").all() as TestSetRow[]) : [];
	const looks = new Map(
		stored
			? (
					db.prepare("SELECT test_set_id, count(*) AS n FROM decision_test_looks GROUP BY test_set_id").all() as {
						test_set_id: string;
						n: number;
					}[]
				).map((l) => [l.test_set_id, l.n] as const)
			: [],
	);
	const choice = chooseTestSet(perDay, sets, looks, policy, localDay(now));
	const range = choice.range;

	// 5. Validation: whole days of the training period.
	const trainDays = new Map([...perDay].filter(([d]) => range !== null && d < range.from_day));
	const validation = chooseValidationDays(trainDays, policy.validationFraction);

	const manifestRows: ManifestRow[] = [];
	for (const ex of kept) {
		const day = dayOf(ex);
		const split: Split =
			range === null || day < range.from_day
				? validation.has(day)
					? "validation"
					: "train"
				: day <= range.to_day
					? "test"
					: "held";
		const questions: Record<string, ManifestLabel> = {};
		for (const [q, l] of Object.entries(ex.questions)) {
			// A weak label trains, and nothing else: never validation, never test, never a day held for a test.
			if (l.strength === "weak" && split !== "train") exclude(ex.row.id, "weak_outside_training", q);
			else questions[q] = l;
		}
		if (Object.keys(questions).length === 0) continue;
		manifestRows.push({
			id: ex.row.id,
			role: ex.row.role,
			schema: ex.row.schema_version,
			scope: ex.row.scope!,
			state_hash: ex.row.state_hash,
			day,
			split,
			questions,
			merged: [...ex.merged].sort(),
		});
	}
	manifestRows.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
	excluded.sort(
		(a, b) =>
			a.id.localeCompare(b.id) ||
			a.reason.localeCompare(b.reason) ||
			(a.question ?? "").localeCompare(b.question ?? ""),
	);
	return {
		version: 1,
		cut_at: now.toISOString(),
		policy,
		test_set: range
			? {
					id: choice.keep?.id ?? opts.testSetId ?? "(not created)",
					from_day: range.from_day,
					to_day: range.to_day,
					looks: choice.keep ? (looks.get(choice.keep.id) ?? 0) : 0,
					origin: choice.keep ? "kept" : "new",
				}
			: null,
		retires: choice.retires,
		rows: manifestRows,
		excluded,
		excluded_counts: excludedCounts,
		unlabelled,
		problem: choice.problem,
	};
}

export type FreezeResult =
	| { ok: true; id: string; hash: string; manifest: DatasetManifest }
	| { ok: false; reason: string; manifest: DatasetManifest };

/**
 * Cut and freeze a dataset in one transaction: the test sets it retires, the one it creates, and the manifest
 * with its hash. A cut that has no test set, or nothing to train on, writes nothing and says why.
 */
export function freezeDataset(
	db: Db,
	opts: { policy: DatasetPolicy; now: Date; by: string; newId?: () => string },
): FreezeResult {
	const newId = opts.newId ?? (() => crypto.randomUUID());
	return db
		.transaction((): FreezeResult => {
			const manifest = planDataset(db, { policy: opts.policy, now: opts.now, testSetId: newId() });
			if (manifest.problem || !manifest.test_set)
				return { ok: false, reason: manifest.problem ?? "no test set", manifest };
			if (!manifest.rows.some((r) => r.split === "train"))
				return { ok: false, reason: "nothing to train on: every example is validation, test or held", manifest };
			const at = opts.now.toISOString();
			for (const r of manifest.retires)
				db.prepare(
					"UPDATE decision_test_sets SET retired_at = ?, retired_reason = ? WHERE id = ? AND retired_at IS NULL",
				).run(at, r.reason, r.id);
			const t = manifest.test_set;
			if (t.origin === "new")
				db.prepare("INSERT INTO decision_test_sets (id, from_day, to_day, created_at) VALUES (?, ?, ?, ?)").run(
					t.id,
					t.from_day,
					t.to_day,
					at,
				);
			const id = newId();
			const hash = manifestHash(manifest);
			db.prepare(
				`INSERT INTO decision_datasets (id, created_at, created_by, test_set_id, policy_json, manifest_json, manifest_hash)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(id, at, opts.by, t.id, canonical(manifest.policy), canonical(manifest), hash);
			return { ok: true, id, hash, manifest };
		})
		.immediate();
}

export function getDataset(db: Db, id: string): { manifest: DatasetManifest; hash: string; created_at: string } | null {
	const r = db
		.prepare("SELECT manifest_json, manifest_hash, created_at FROM decision_datasets WHERE id = ?")
		.get(id) as { manifest_json: string; manifest_hash: string; created_at: string } | undefined;
	if (!r) return null;
	const manifest = JSON.parse(r.manifest_json) as DatasetManifest;
	if (manifestHash(manifest) !== r.manifest_hash)
		throw new Error(`dataset ${id}: the manifest does not match its hash`);
	return { manifest, hash: r.manifest_hash, created_at: r.created_at };
}

/**
 * The manifest's rows that may no longer be used: gone (a `/forget`, a deletion), changed, no longer answered,
 * of a forgotten scope, or naming a person forgotten since. Ids only.
 */
export function staleRows(db: Db, manifest: DatasetManifest): string[] {
	const names = forgottenNames(db);
	const get = db.prepare("SELECT scope, state_json, state_hash, status, created_at FROM decisions WHERE id = ?");
	const stale: string[] = [];
	for (const row of manifest.rows) {
		for (const id of [row.id, ...row.merged]) {
			const d = get.get(id) as
				| { scope: string | null; state_json: string; state_hash: string; status: string; created_at: string }
				| undefined;
			if (
				!d ||
				d.state_hash !== row.state_hash ||
				d.status !== "ok" ||
				d.scope === null ||
				!manifest.policy.scopes.includes(d.scope) ||
				isForgotten(db, d.scope, d.created_at) ||
				(names.length > 0 && mentionsAny(d.state_json, names))
			)
				stale.push(id);
		}
	}
	return stale;
}

/** One example as Kev's labelled JSONL: the state exactly as it was sent, the questions as they were asked. */
interface KevRecord {
	state: unknown;
	questions: Record<string, { type: "noul"; instructions: string; label: boolean }>;
	_meta: { id: string; source: string; group_id: string; weak?: string[] };
}

/**
 * The records of some splits, read from the journal by the manifest's ids. The input is the pre-decision state
 * and nothing else: no answer, no outcome, nothing that happened afterwards (HLD §10.2).
 */
export function datasetRecords(db: Db, manifest: DatasetManifest, splits: readonly Split[]): Map<Split, KevRecord[]> {
	const get = db.prepare("SELECT state_json, questions_json FROM decisions WHERE id = ?");
	const out = new Map<Split, KevRecord[]>(splits.map((s) => [s, []]));
	for (const row of manifest.rows) {
		const list = out.get(row.split);
		if (!list) continue;
		const d = get.get(row.id) as { state_json: string; questions_json: string } | undefined;
		if (!d) throw new Error(`dataset row ${row.id} is gone`);
		// The wording each question was asked in: the example's own row first, then the rows merged into it
		// (the same state may have been asked different questions at different times).
		const asked = new Map<string, string>();
		for (const id of [row.id, ...row.merged]) {
			const m = id === row.id ? d : (get.get(id) as { questions_json: string } | undefined);
			if (!m) throw new Error(`dataset row ${id} is gone`);
			for (const q of JSON.parse(m.questions_json) as { id: string; instructions: string }[])
				if (!asked.has(q.id)) asked.set(q.id, q.instructions);
		}
		const questions: KevRecord["questions"] = {};
		for (const [q, l] of Object.entries(row.questions)) {
			const instructions = asked.get(q);
			if (instructions === undefined) throw new Error(`dataset row ${row.id} was never asked ${q}`);
			questions[q] = { type: "noul", instructions, label: l.label };
		}
		const weak = Object.entries(row.questions)
			.filter(([, l]) => l.strength === "weak")
			.map(([q]) => q);
		list.push({
			state: JSON.parse(d.state_json) as unknown,
			questions,
			_meta: {
				id: `iyye/${row.id}`,
				source: `iyye_${row.role}`,
				group_id: `iyye/${row.day}`,
				...(weak.length ? { weak } : {}),
			},
		});
	}
	return out;
}

export class DatasetRefused extends Error {}

/** Looks at a test set so far. */
export function testLooks(db: Db, testSetId: string): number {
	return (
		db.prepare("SELECT count(*) AS n FROM decision_test_looks WHERE test_set_id = ?").get(testSetId) as { n: number }
	).n;
}

/**
 * Write a frozen dataset's JSONL into `dir` (0700; files 0600): `train.jsonl` and `validation.jsonl`, and
 * `test.jsonl` only when asked, which is a look and is recorded as one before the file exists. Refused when
 * the manifest holds a row that may no longer be used, or when the test set is retired or has no looks left.
 * The caller deletes the files after the run (`deleteDatasetFiles`).
 */
export function writeDataset(
	db: Db,
	id: string,
	dir: string,
	opts: {
		test?: { by: string; purpose: string };
		/** Which questions the training file holds (a session trains only the questions with enough labels). */
		train?: (role: string, question: string) => boolean;
		now?: Date;
	} = {},
): { files: Partial<Record<Split, string>>; counts: Partial<Record<Split, number>> } {
	const ds = getDataset(db, id);
	if (!ds) throw new DatasetRefused(`no dataset ${id}`);
	const { manifest } = ds;
	const stale = staleRows(db, manifest);
	if (stale.length)
		throw new DatasetRefused(
			`dataset ${id.slice(0, 8)} holds ${stale.length} row(s) that were since removed or may no longer be used: cut a new one`,
		);
	const splits: Split[] = ["train", "validation"];
	if (opts.test) {
		const t = manifest.test_set!;
		const set = db.prepare("SELECT retired_at FROM decision_test_sets WHERE id = ?").get(t.id) as
			| { retired_at: string | null }
			| undefined;
		if (!set || set.retired_at !== null)
			throw new DatasetRefused(`dataset ${id.slice(0, 8)}: its test set is retired; cut a new dataset`);
		const looks = testLooks(db, t.id);
		if (looks >= manifest.policy.testLooks)
			throw new DatasetRefused(
				`dataset ${id.slice(0, 8)}: its test set has been looked at ${looks} time(s), the most allowed; cut a new dataset`,
			);
		db.prepare(
			"INSERT INTO decision_test_looks (test_set_id, dataset_id, at, by, purpose) VALUES (?, ?, ?, ?, ?)",
		).run(t.id, id, (opts.now ?? new Date()).toISOString(), opts.test.by, opts.test.purpose);
		splits.push("test");
	}
	const records = datasetRecords(db, manifest, splits);
	const keep = opts.train;
	if (keep)
		records.set(
			"train",
			records
				.get("train")!
				.map((r) => ({
					...r,
					questions: Object.fromEntries(
						Object.entries(r.questions).filter(([q]) => keep(r._meta.source.replace(/^iyye_/, ""), q)),
					),
				}))
				.filter((r) => Object.keys(r.questions).length > 0),
		);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const files: Partial<Record<Split, string>> = {};
	const counts: Partial<Record<Split, number>> = {};
	for (const s of splits) {
		const path = join(dir, `${s}.jsonl`);
		const list = records.get(s)!;
		writeFileSync(path, list.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
		chmodSync(path, 0o600);
		files[s] = path;
		counts[s] = list.length;
	}
	return { files, counts };
}

/** Remove a run's JSONL (and the directory when nothing else is in it): the content stays only in SQLite. */
export function deleteDatasetFiles(dir: string): void {
	for (const s of ["train", "validation", "test"]) rmSync(join(dir, `${s}.jsonl`), { force: true });
	if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

/** Owner labels per role, question, split and class: what eligibility (N3) and the owner read. */
export function labelCounts(
	manifest: DatasetManifest,
): { role: string; question: string; split: Split; yes: number; no: number; weak: number }[] {
	const m = new Map<string, { role: string; question: string; split: Split; yes: number; no: number; weak: number }>();
	for (const r of manifest.rows)
		for (const [q, l] of Object.entries(r.questions)) {
			const k = `${r.role}|${q}|${r.split}`;
			const c = m.get(k) ?? { role: r.role, question: q, split: r.split, yes: 0, no: 0, weak: 0 };
			if (l.strength === "weak") c.weak++;
			else if (l.label) c.yes++;
			else c.no++;
			m.set(k, c);
		}
	const order: Split[] = ["train", "validation", "test", "held"];
	return [...m.values()].sort(
		(a, b) =>
			a.role.localeCompare(b.role) ||
			a.question.localeCompare(b.question) ||
			order.indexOf(a.split) - order.indexOf(b.split),
	);
}

const REASONS: Record<Exclusion, string> = {
	scope: "a contact's decision (never trained on)",
	forgotten: "of a forgotten scope",
	names_forgotten_person: "names a forgotten person",
	not_answered: "Kev did not answer it",
	clipped: "the message was cut at the host's limit",
	conflicting_labels: "labelled both ways for the same state",
	owner_skipped: "you could not tell (skipped)",
	weak_outside_training: "a weak label on a validation, test or held day",
};

/** The dataset in words: counts only, nothing anyone said. */
export function describeDataset(manifest: DatasetManifest, hash?: string): string {
	const lines: string[] = [];
	const rows = manifest.rows;
	const n = (s: Split) => rows.filter((r) => r.split === s).length;
	const labels = (s: Split) =>
		rows.filter((r) => r.split === s).reduce((k, r) => k + Object.keys(r.questions).length, 0);
	lines.push(
		`dataset cut ${manifest.cut_at.slice(0, 16).replace("T", " ")}Z${hash ? ` · ${hash.slice(0, 12)}` : " (not frozen)"}: ${rows.length} examples from ${manifest.policy.scopes.join(" and ")} decisions; roles ${manifest.policy.roles.join(", ")}`,
	);
	if (manifest.problem) lines.push(`cannot be frozen: ${manifest.problem}`);
	const t = manifest.test_set;
	if (t)
		lines.push(
			`test set ${t.origin === "new" ? "(new)" : t.id.slice(0, 8)}: ${t.from_day} to ${t.to_day}, sealed; looked at ${t.looks} of ${manifest.policy.testLooks} time(s)`,
		);
	for (const r of manifest.retires)
		lines.push(
			`retires test set ${r.id.slice(0, 8)} (${r.reason === "looks" ? "no looks left" : "a fresh one can be made from later days"}): its days join the training period`,
		);
	const days = (s: Split) => new Set(rows.filter((r) => r.split === s).map((r) => r.day)).size;
	lines.push(
		`splits (examples · labels · days): train ${n("train")} · ${labels("train")} · ${days("train")}; validation ${n("validation")} · ${labels("validation")} · ${days("validation")}; test ${n("test")} · ${labels("test")} · ${days("test")}` +
			(n("held") ? `; held for the next test set ${n("held")} · ${labels("held")} · ${days("held")}` : ""),
	);
	lines.push("owner labels, yes · no (train | validation | test):");
	const counts = labelCounts(manifest);
	const keys = [...new Set(counts.map((c) => `${c.role} ${c.question}`))];
	for (const k of keys) {
		const of = (s: Split) => counts.find((c) => `${c.role} ${c.question}` === k && c.split === s);
		const cell = (s: Split) => {
			const c = of(s);
			return c ? `${c.yes} · ${c.no}${c.weak ? ` (+${c.weak} weak)` : ""}` : "0 · 0";
		};
		const held = of("held");
		lines.push(
			`  ${k}: ${cell("train")} | ${cell("validation")} | ${cell("test")}${held ? ` | held ${held.yes} · ${held.no}` : ""}`,
		);
	}
	const via = new Map<string, number>();
	for (const r of rows.filter((x) => x.split === "test"))
		for (const l of Object.values(r.questions)) via.set(l.via ?? "weak", (via.get(l.via ?? "weak") ?? 0) + 1);
	if (via.size)
		lines.push(
			`test labels by how they reached you: ${[...via]
				.sort()
				.map(([k, v]) => `${k} ${v}`)
				.join(", ")}`,
		);
	const merged = rows.reduce((k, r) => k + r.merged.length, 0);
	const out = Object.entries(manifest.excluded_counts) as [Exclusion, number][];
	lines.push(
		`left out: ${out.length ? out.map(([r, k]) => `${k} ${REASONS[r]}`).join("; ") : "nothing labelled"}` +
			`; ${merged} repeat(s) of a state merged; ${manifest.unlabelled} answered decision(s) nobody labelled`,
	);
	return lines.join("\n");
}
