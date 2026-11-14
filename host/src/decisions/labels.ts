// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner labels (plan 0.017 N1): the only labels a test set or a promotion
 * verdict will use. One row per answered question (`decision_labels`), so a
 * toolkit selection can be labelled per toolkit and a reply review on both of
 * its owner questions without one label replacing another.
 *
 * - **What can be labelled:** only a question the row was actually asked
 *   (its `questions_json`; a schema-1 reply review was never asked
 *   `claims_arranged`, §15 #18), and only roles with an owner question.
 * - **The daily queue** (`/decisions queue [n]`) offers owner- and
 *   `iyye`-scope questions (decision 1), at most `IYYE2_LABELS_DAILY` a day:
 *   first where Kev was unsure, then where Kev and the weak label disagree,
 *   and always a share picked at random, so a test set is not only hard
 *   cases. A day's picks are stored and stay the same however often it is
 *   asked; each label records the tier that offered it (`via`).
 * - **It shows the state as the role saw it and the question word for word,
 *   never Kev's answer:** a label is the owner's judgement, not a review of
 *   the model's.
 * - **Nothing a `/forget` meant to remove comes back:** forgotten scopes'
 *   rows are already deleted; owner rows whose state names a forgotten person
 *   (`mentions.ts`) are never offered.
 *
 * For roles whose outcome is a single owner answer, the owner's yes/no labels
 * of a row are also joined as its outcome (owner strength), which the
 * `/decisions` reports read. Toolkit selection's outcome stays the weak record
 * of the tools used, and the thinking need's the record of whether the chat
 * model asked the thinking model; their owner labels live only here.
 */

import { createHash } from "node:crypto";
import { mentionsAny, personNames } from "../memory/mentions.ts";
import { getContact } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { joinOutcome } from "./client.ts";
import { INITIATIVE } from "./initiative.ts";
import { MEMORY_SALIENCE } from "./memory-salience.ts";
import { OBSERVATION_IMPORTANCE } from "./observation-importance.ts";
import { REPLY_REVIEW } from "./reply-review.ts";
import { NEED_QUESTION, THINKING_NEED } from "./thinking-need.ts";
import { TOOLKIT_SELECTION } from "./toolkit-selection.ts";

export type Via = "uncertain" | "disagree" | "random" | "direct";

/** A question the owner can answer, with what yes and no mean. */
interface OwnerQuestion {
	field: string;
	yes: string;
	no: string;
}

/** Single-question roles: the owner's question is the role's one question. */
const SINGLE: Record<string, OwnerQuestion> = {
	[MEMORY_SALIENCE.name]: {
		field: "worth_remembering",
		yes: "the message was worth remembering",
		no: "the message was not worth remembering",
	},
	[OBSERVATION_IMPORTANCE.name]: {
		field: "worth_telling",
		yes: "the change was worth telling you about",
		no: "the change was not worth telling you about",
	},
	[INITIATIVE.name]: {
		field: "worth_investigating",
		yes: "it was worth investigating",
		no: "it was not worth investigating",
	},
};

const NEEDS_THINKING: OwnerQuestion = {
	field: NEED_QUESTION.id,
	yes: "the message needed the thinking model",
	no: "the message did not need the thinking model",
};

/** Roles whose outcome is the record of what happened: an owner label is kept beside it, never in its place. */
const RECORD_OUTCOME: readonly string[] = [TOOLKIT_SELECTION.name, THINKING_NEED.name];

const CLAIMS: OwnerQuestion = {
	field: "claims_arranged",
	yes: "the reply claimed something was set up",
	no: "the reply did not claim anything was set up",
};
const PROMISES: OwnerQuestion = {
	field: "promises_future_action",
	yes: "the reply promised a future action",
	no: "the reply promised no future action",
};

/** Short names the owner may type for a reply review's questions. */
const REVIEW_ALIASES: Record<string, string> = { claims: CLAIMS.field, promises: PROMISES.field };

/**
 * The roles the queue offers (decision 8: the first adapter's roles), and since 2026-11-14 the thinking need,
 * whose only real labels are the owner's.
 */
export const QUEUE_ROLES: readonly string[] = [
	MEMORY_SALIENCE.name,
	OBSERVATION_IMPORTANCE.name,
	REPLY_REVIEW.name,
	TOOLKIT_SELECTION.name,
	THINKING_NEED.name,
];

/** Decision 1: only these scopes' decisions train, so only theirs are queued. */
export const QUEUE_SCOPES: readonly string[] = ["owner", "iyye"];

interface LabelRow {
	id: string;
	role: string;
	schema_version: number;
	scope: string | null;
	status: string;
	state_json: string;
	state_hash: string;
	questions_json: string;
	verdicts_json: string | null;
	outcome_json: string | null;
	label_strength: string | null;
	created_at: string;
}

/**
 * The owner questions of one row, the first being the default for
 * `/decisions label <id> yes|no`; empty when the role has none.
 */
export function ownerQuestions(row: { role: string; schema_version: number; questions_json: string }): OwnerQuestion[] {
	const asked = new Set((JSON.parse(row.questions_json) as { id: string }[]).map((q) => q.id));
	if (row.role === REPLY_REVIEW.name) {
		// A schema-1 review was asked only "promises or offers"; later ones lead with the claim (plan 0.006 C2).
		if (row.schema_version < 2) return [PROMISES];
		return [CLAIMS, PROMISES].filter((q) => asked.has(q.field));
	}
	if (row.role === TOOLKIT_SELECTION.name) {
		return [...asked].map((kit) => ({
			field: kit,
			yes: `the message needed the ${kit} toolkit`,
			no: `the message did not need the ${kit} toolkit`,
		}));
	}
	if (row.role === THINKING_NEED.name) return asked.has(NEEDS_THINKING.field) ? [NEEDS_THINKING] : [];
	const q = SINGLE[row.role];
	// Labelled even when the call failed: the label is about the state, not about Kev's answer.
	return q ? [q] : [];
}

/** The local calendar day (the allowance's day): the owner's day, not UTC's. */
export function localDay(at: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * `/decisions label <id> [question] yes|no|skip`. Returns the reply. The
 * question may be left out when the row has one owner question (and for a
 * reply review, whose default is `claims_arranged`).
 */
export function labelDecision(db: Db, args: readonly string[], issuer: string, at: string): string {
	const usage = "usage: /decisions label <id> [question] yes|no|skip";
	const [ref, a, b] = args;
	if (!ref || !/^[0-9a-f-]{6,36}$/i.test(ref)) return `${usage} (the id: at least 6 characters)`;
	const answer = (b ?? a ?? "").toLowerCase();
	const named = b === undefined ? null : (a ?? "");
	if (!["yes", "no", "skip"].includes(answer) || args.length > 3) return usage;
	const rows = db
		.prepare("SELECT id, role, schema_version, questions_json FROM decisions WHERE id LIKE ?")
		.all(`${ref.toLowerCase()}%`) as { id: string; role: string; schema_version: number; questions_json: string }[];
	if (rows.length === 0) return `no decision ${ref}; see /decisions <role> or /decisions queue`;
	if (rows.length > 1) return `${ref} matches ${rows.length} decisions; use more of the id`;
	const row = rows[0]!;
	const qs = ownerQuestions(row);
	if (qs.length === 0) return `${row.role} is labelled automatically, not by the owner`;
	let q: OwnerQuestion | undefined;
	if (named === null) {
		if (row.role === TOOLKIT_SELECTION.name && qs.length > 1)
			return `which toolkit? /decisions label ${row.id.slice(0, 8)} <${qs.map((x) => x.field).join("|")}> ${answer}`;
		q = qs[0];
	} else {
		const field = REVIEW_ALIASES[named] ?? named;
		q = qs.find((x) => x.field === field);
		if (!q)
			return `${row.id.slice(0, 8)} (${row.role}) was not asked ${JSON.stringify(named)}; its questions: ${qs.map((x) => x.field).join(", ")}`;
	}
	if (!q) return usage;
	const existing = db
		.prepare("SELECT value FROM decision_labels WHERE decision_id = ? AND question = ?")
		.get(row.id, q.field) as { value: number | null } | undefined;
	if (answer === "skip" && existing && existing.value !== null)
		return `${row.id.slice(0, 8)} ${q.field} is already labelled ${existing.value ? "yes" : "no"}; answer yes or no to change it`;
	const offer = db
		.prepare("SELECT via FROM decision_label_offers WHERE decision_id = ? AND question = ?")
		.get(row.id, q.field) as { via: Via } | undefined;
	const value = answer === "skip" ? null : answer === "yes" ? 1 : 0;
	db.transaction(() => {
		db.prepare(
			`INSERT INTO decision_labels (decision_id, question, value, labelled_by, labelled_at, via)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (decision_id, question) DO UPDATE SET value = excluded.value,
				labelled_by = excluded.labelled_by, labelled_at = excluded.labelled_at`,
		).run(row.id, q.field, value, issuer, at, offer?.via ?? "direct");
		if (value !== null && !RECORD_OUTCOME.includes(row.role)) {
			// The reports' view: every yes/no the owner gave this row, as its outcome.
			const all = db
				.prepare("SELECT question, value FROM decision_labels WHERE decision_id = ? AND value IS NOT NULL")
				.all(row.id) as { question: string; value: number }[];
			joinOutcome(db, row.id, Object.fromEntries(all.map((l) => [l.question, l.value === 1])), issuer, "owner", at);
		}
	})();
	if (value === null) return `skipped ${row.id.slice(0, 8)} (${row.role}, ${q.field}): it leaves the queue unlabelled`;
	return `labelled ${row.id.slice(0, 8)} (${row.role}): ${value ? q.yes : q.no}`;
}

/** Names of every person a `/forget` removed: an owner row naming one is never offered (plan 0.017 §3.2). */
export function forgottenNames(db: Db): string[] {
	const scopes = db.prepare("SELECT DISTINCT scope FROM memory_tombstones").all() as { scope: string }[];
	const names = new Set<string>();
	for (const { scope } of scopes) {
		if (!scope.startsWith("contact:")) continue;
		const c = getContact(db, scope.slice("contact:".length));
		if (c) for (const n of personNames(db, c)) names.add(n);
	}
	return [...names];
}

interface Candidate {
	row: LabelRow;
	question: string;
	tier: "uncertain" | "disagree" | "random";
	/** Stable within a day: the random arm does not reshuffle when the queue is asked again. */
	order: string;
}

/** Kev's verdict and the weak label disagree on this question (an unused toolkit is not a "no"). */
function disagrees(row: LabelRow, question: string, verdict: string | undefined): boolean {
	if (!row.outcome_json || row.label_strength !== "weak" || verdict === undefined || verdict === "abstain")
		return false;
	const o = JSON.parse(row.outcome_json) as Record<string, unknown>;
	if (row.role === MEMORY_SALIENCE.name && typeof o.worth_remembering === "boolean")
		return (verdict === "yes") !== o.worth_remembering;
	if (row.role === TOOLKIT_SELECTION.name && Array.isArray(o.used))
		return verdict === "no" && (o.used as string[]).includes(question);
	// Either way round: Kev says it was needed and the chat model did not ask, or the reverse.
	if (row.role === THINKING_NEED.name && typeof o.called === "boolean") return (verdict === "yes") !== o.called;
	// The ledger fact is not a claims label (plan 0.006 C2), only a hint where to look: a claim with no
	// reminder made, or no claim where one was made.
	if (row.role === REPLY_REVIEW.name && question === CLAIMS.field && typeof o.commitment_created === "boolean")
		return (verdict === "yes") !== o.commitment_created;
	return false;
}

/** Every question the queue could offer now, tiered. */
function candidates(db: Db, day: string): Candidate[] {
	const rows = db
		.prepare(
			`SELECT id, role, schema_version, scope, status, state_json, state_hash, questions_json, verdicts_json,
				outcome_json, label_strength, created_at
			 FROM decisions
			 WHERE status = 'ok' AND role IN (${QUEUE_ROLES.map(() => "?").join(", ")})
			 AND scope IN (${QUEUE_SCOPES.map(() => "?").join(", ")})
			 ORDER BY created_at, rowid`,
		)
		.all(...QUEUE_ROLES, ...QUEUE_SCOPES) as LabelRow[];
	// Already labelled or offered, by row and by state: one message asked twice is one example.
	const taken = new Set<string>();
	for (const r of db
		.prepare(
			`SELECT d.id, d.state_hash, x.question FROM decisions d
			 JOIN (SELECT decision_id, question FROM decision_labels
				UNION SELECT decision_id, question FROM decision_label_offers) x ON x.decision_id = d.id`,
		)
		.all() as { id: string; state_hash: string; question: string }[]) {
		taken.add(`${r.state_hash}|${r.question}`);
	}
	const names = forgottenNames(db);
	const out: Candidate[] = [];
	for (const row of rows) {
		if (names.length && mentionsAny(row.state_json, names)) continue;
		const verdicts = row.verdicts_json ? (JSON.parse(row.verdicts_json) as Record<string, string>) : {};
		for (const q of ownerQuestions(row)) {
			const key = `${row.state_hash}|${q.field}`;
			if (taken.has(key)) continue;
			taken.add(key);
			const v = verdicts[q.field];
			const tier = v === "abstain" ? "uncertain" : disagrees(row, q.field, v) ? "disagree" : "random";
			const order = createHash("sha256").update(`${day}|${row.id}|${q.field}`).digest("hex");
			out.push({ row, question: q.field, tier, order });
		}
	}
	return out;
}

/** Take up to `n`, one role at a time, so no role crowds the others out. */
function roundRobin(xs: Candidate[], n: number, byOrder: boolean): Candidate[] {
	const per = new Map<string, Candidate[]>();
	for (const role of QUEUE_ROLES) per.set(role, []);
	for (const x of xs) per.get(x.row.role)!.push(x);
	for (const list of per.values()) {
		// Hard cases newest first (closest to how Iyye talks now); the random arm by its daily hash.
		if (byOrder) list.sort((a, b) => a.order.localeCompare(b.order));
		else list.reverse();
	}
	const picked: Candidate[] = [];
	while (picked.length < n && [...per.values()].some((l) => l.length)) {
		for (const list of per.values()) {
			const next = list.shift();
			if (next && picked.length < n) picked.push(next);
		}
	}
	return picked;
}

/** Pick `need` new questions: a third at random (at least one), the rest the hardest, either filling for the other. */
function pick(all: Candidate[], need: number): Candidate[] {
	if (need <= 0) return [];
	const hard = roundRobin(
		all.filter((c) => c.tier === "uncertain"),
		need,
		false,
	);
	hard.push(
		...roundRobin(
			all.filter((c) => c.tier === "disagree"),
			need - hard.length,
			false,
		),
	);
	const hardTaken = hard.slice(
		0,
		Math.max(need - Math.max(1, Math.ceil(need / 3)), need - (all.length - hard.length)),
	);
	const taken = new Set(hardTaken);
	// A hard case the random arm draws is offered as random: that is how it was chosen.
	const random = roundRobin(
		all.filter((c) => !taken.has(c)),
		need - hardTaken.length,
		true,
	).map((c) => ({ ...c, tier: "random" as const }));
	return [...hardTaken, ...random];
}

export interface QueueItem {
	id: string;
	role: string;
	question: string;
	instructions: string;
	state: unknown;
	via: Exclude<Via, "direct">;
}

/**
 * Today's open questions, topping today's offers up to `daily`. Returns at most
 * `n` unanswered ones and the day's counts.
 */
export function labelQueue(
	db: Db,
	opts: { n: number; daily: number; now: Date },
): { items: QueueItem[]; offeredToday: number; answeredToday: number; daily: number } {
	const day = localDay(opts.now);
	const open = () =>
		db
			.prepare(
				`SELECT o.decision_id, o.question, o.via FROM decision_label_offers o
				 WHERE o.offered_day = ? AND NOT EXISTS
					(SELECT 1 FROM decision_labels l WHERE l.decision_id = o.decision_id AND l.question = o.question)
				 ORDER BY o.offered_at, o.rowid`,
			)
			.all(day) as { decision_id: string; question: string; via: QueueItem["via"] }[];
	const offeredToday = () =>
		(db.prepare("SELECT count(*) AS n FROM decision_label_offers WHERE offered_day = ?").get(day) as { n: number }).n;
	const want = Math.min(opts.n, opts.daily);
	const missing = Math.min(want - open().length, opts.daily - offeredToday());
	if (missing > 0) {
		const picked = pick(candidates(db, day), missing);
		const insert = db.prepare(
			"INSERT INTO decision_label_offers (decision_id, question, offered_day, offered_at, via) VALUES (?, ?, ?, ?, ?)",
		);
		db.transaction(() => {
			for (const c of picked) insert.run(c.row.id, c.question, day, opts.now.toISOString(), c.tier);
		})();
	}
	const items: QueueItem[] = [];
	for (const o of open().slice(0, opts.n)) {
		const r = db.prepare("SELECT role, state_json, questions_json FROM decisions WHERE id = ?").get(o.decision_id) as
			| { role: string; state_json: string; questions_json: string }
			| undefined;
		if (!r) continue;
		const q = (JSON.parse(r.questions_json) as { id: string; instructions: string }[]).find(
			(x) => x.id === o.question,
		);
		items.push({
			id: o.decision_id,
			role: r.role,
			question: o.question,
			instructions: q?.instructions ?? o.question,
			state: JSON.parse(r.state_json) as unknown,
			via: o.via,
		});
	}
	const answeredToday = (
		db
			.prepare(
				`SELECT count(*) AS n FROM decision_label_offers o JOIN decision_labels l
				 ON l.decision_id = o.decision_id AND l.question = o.question WHERE o.offered_day = ?`,
			)
			.get(day) as { n: number }
	).n;
	return { items, offeredToday: offeredToday(), answeredToday, daily: opts.daily };
}

/** The state as the role saw it, readable: a message as itself, an object field by field. */
function stateText(state: unknown, max = 600): string {
	const clip = (s: string) => {
		const t = s.replace(/\s+/g, " ").trim();
		return t.length > max ? `${t.slice(0, max)}…` : t;
	};
	if (typeof state === "string") return `    ${clip(state)}`;
	if (state && typeof state === "object")
		return Object.entries(state as Record<string, unknown>)
			.map(([k, v]) => `    ${k}: ${clip(typeof v === "string" ? v : JSON.stringify(v))}`)
			.join("\n");
	return `    ${clip(JSON.stringify(state))}`;
}

/** `/decisions queue [n]`. */
export function queueReport(db: Db, n: number, daily: number, now: Date): string {
	if (daily <= 0) return "the labelling queue is off (IYYE2_LABELS_DAILY=0)";
	const q = labelQueue(db, { n, daily, now });
	const head = `labelling queue, ${localDay(now)}: ${q.answeredToday} of ${q.offeredToday} offered today answered (at most ${q.daily} a day)`;
	if (q.items.length === 0)
		return q.offeredToday >= q.daily
			? `${head}. That is all for today.`
			: `${head}. Nothing left to ask: every owner and iyye decision is labelled or offered.`;
	const lines = [head, "Answer from the state alone, as you would have wanted it (Kev's answer is not shown):", ""];
	for (const it of q.items) {
		const kit = it.role === TOOLKIT_SELECTION.name ? `${it.question} ` : "";
		const named = it.role === REPLY_REVIEW.name && it.question === PROMISES.field ? "promises " : kit;
		lines.push(
			`${it.id.slice(0, 8)} · ${it.role} · ${it.question}`,
			stateText(it.state),
			`  question: ${it.instructions}`,
			`  answer: /decisions label ${it.id.slice(0, 8)} ${named}yes|no|skip`,
			"",
		);
	}
	return lines.join("\n").trimEnd();
}

/** Per role and question: the owner's yes, no and skipped, split by whether they count toward training (decision 1). */
export function labelCountLines(db: Db): string[] {
	const rows = db
		.prepare(
			`SELECT d.role, l.question, d.scope IN (${QUEUE_SCOPES.map(() => "?").join(", ")}) AS trains,
				count(CASE WHEN l.value = 1 THEN 1 END) AS yes, count(CASE WHEN l.value = 0 THEN 1 END) AS no,
				count(CASE WHEN l.value IS NULL THEN 1 END) AS skipped
			 FROM decision_labels l JOIN decisions d ON d.id = l.decision_id
			 GROUP BY d.role, l.question, trains ORDER BY d.role, l.question, trains DESC`,
		)
		.all(...QUEUE_SCOPES) as {
		role: string;
		question: string;
		trains: number;
		yes: number;
		no: number;
		skipped: number;
	}[];
	if (rows.length === 0) return ["your labels: none yet (/decisions queue)"];
	const out = ["your labels (yes · no · skipped; owner and iyye decisions train, contacts' do not):"];
	for (const r of rows)
		out.push(`  ${r.role} ${r.question}${r.trains ? "" : " (contacts)"}: ${r.yes} · ${r.no} · ${r.skipped}`);
	return out;
}
