// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The day summary (plan 0.007 S3, HLD §8.3 phase 7; owner decision 4: built
 * from records, post-processed by a model).
 *
 * 1. A **digest** of the day from records only: conversations per person,
 *    what the night stored, tool use, background work, energy, failures.
 * 2. The memory model rewrites it as a short note, at the end of the night
 *    (under the memory gate, thinking off).
 * 3. A deterministic **check**: every number (digits or words) and every
 *    name in the note must be in the digest, it must be no longer than the
 *    digest (or 500 characters), and it must not promise anything. Otherwise
 *    the digest itself is sent. It cannot catch a misreading that keeps the
 *    record's numbers, so the digest is worded to leave little to misread.
 *
 * Nothing in the note can be new: the model only rephrases.
 */

import type { NightOutcome } from "../memory/night.ts";
import type { Db } from "../state/db.ts";

export interface DayWindow {
	day: number;
	/** The previous night's end (or the first record) and this night's start. */
	from: string;
	to: string;
	outcome: NightOutcome | null;
}

/** The day's facts, as plain English lines, from records only. */
export function buildDigest(db: Db, w: DayWindow): string {
	// No dates or times: a model rewrites them in its own words, which the check cannot verify.
	const lines = [`Day ${w.day}.`];
	const convo = db
		.prepare(
			`SELECT e.scope, coalesce(c.display_name, '?') AS name, count(*) AS n
			 FROM events e LEFT JOIN contacts c ON c.id = e.principal_contact_id
			 WHERE e.status = 'answered' AND e.received_at >= ? AND e.received_at < ?
			 AND json_extract(e.payload_json, '$.remember') IS NULL
			 GROUP BY e.scope ORDER BY e.scope = 'owner' DESC, n DESC`,
		)
		.all(w.from, w.to) as { scope: string; name: string; n: number }[];
	if (convo.length === 0) lines.push("Nobody wrote to Iyye.");
	else {
		const total = convo.reduce((n, c) => n + c.n, 0);
		const parts = convo.map((c) => `${c.n} from ${c.scope === "owner" ? "the owner" : c.name}`).join(", ");
		// The total is stated, so a note that adds them up says nothing new.
		lines.push(convo.length > 1 ? `Messages answered: ${total} in all, ${parts}.` : `Messages answered: ${parts}.`);
	}
	const remembered = count(
		db,
		"SELECT count(*) AS n FROM stm_episodes WHERE kind = 'remember' AND said_at >= ? AND said_at < ?",
		w,
	);
	if (remembered) lines.push(`The owner asked Iyye to remember ${remembered} thing(s).`);
	const o = w.outcome;
	if (o) {
		// Two separate groups, worded so they cannot be read as one inside the other.
		lines.push(`Tonight Iyye stored ${o.completed} conversation(s) in long-term memory.`);
		if (o.empty) lines.push(`Another ${o.empty} conversation(s) were checked and had nothing worth keeping.`);
		if (o.failed) lines.push(`${o.failed} conversation(s) could not be stored.`);
		if (o.kind === "blocked") lines.push(`The night's memory work stopped early: ${o.reason}.`);
	}
	const tools = db
		.prepare(
			"SELECT tool, count(*) AS n FROM tool_calls WHERE principal != 'iyye' AND started_at >= ? AND started_at < ? GROUP BY tool ORDER BY n DESC",
		)
		.all(w.from, w.to) as { tool: string; n: number }[];
	if (tools.length)
		lines.push(`Tools used in conversations: ${tools.map((t) => `${t.tool} ${t.n} time(s)`).join(", ")}.`);
	const bg = db
		.prepare(
			"SELECT status, count(*) AS n FROM background_jobs WHERE settled_at >= ? AND settled_at < ? GROUP BY status",
		)
		.all(w.from, w.to) as { status: string; n: number }[];
	if (bg.length) lines.push(`Background steps: ${bg.map((b) => `${b.n} ${b.status}`).join(", ")}.`);
	const findings = db
		// Probe findings only: investigations are Iyye's own answers, counted on their own line below.
		.prepare(
			"SELECT domain, change_text FROM observations WHERE finding = 1 AND domain != 'investigation' AND at >= ? AND at < ? ORDER BY at",
		)
		.all(w.from, w.to) as { domain: string; change_text: string }[];
	if (findings.length) {
		lines.push(
			`Iyye's own probes found ${findings.length} thing(s) worth telling: ${findings
				.slice(0, 3)
				.map((f) => `${f.domain}: ${f.change_text}`)
				.join("; ")}${findings.length > 3 ? "; and more" : ""}.`,
		);
	}
	const inv = db
		.prepare(
			"SELECT count(*) FILTER (WHERE status = 'settled') AS settled, count(*) FILTER (WHERE status != 'settled') AS other FROM opportunities WHERE updated_at >= ? AND updated_at < ? AND attempts > 0",
		)
		.get(w.from, w.to) as { settled: number; other: number };
	if (inv.settled || inv.other) {
		lines.push(`Investigations: ${inv.settled} answered${inv.other ? `, ${inv.other} without an answer yet` : ""}.`);
	}
	// Reminders (plan 0.006 C3): counts and whose, never their text (a person's words; /forget finds names, not texts).
	const rem = db
		.prepare(
			`SELECT c.state, CASE WHEN c.recipient_contact_id = 'owner' THEN 'the owner' ELSE coalesce(p.display_name, '?') END AS who
			 FROM commitments c LEFT JOIN contacts p ON p.id = c.recipient_contact_id
			 WHERE c.state IN ('fulfilled', 'failed', 'unknown') AND coalesce(c.settled_at, c.due_at) >= ? AND coalesce(c.settled_at, c.due_at) < ?`,
		)
		.all(w.from, w.to) as { state: string; who: string }[];
	if (rem.length) {
		const group = (state: string) => {
			const by = new Map<string, number>();
			for (const r of rem.filter((x) => x.state === state)) by.set(r.who, (by.get(r.who) ?? 0) + 1);
			return [...by].map(([who, n]) => `${n} to ${who}`).join(", ");
		};
		const parts = [
			group("fulfilled") ? `delivered ${group("fulfilled")}` : "",
			group("failed") ? `could not be delivered ${group("failed")}` : "",
			group("unknown") ? `may not have arrived ${group("unknown")}` : "",
		].filter(Boolean);
		lines.push(`Reminders: ${parts.join("; ")}.`);
	}
	// Messages Iyye sent to people (plan 0.008): counts, to whom and who asked, never the words.
	const sent = db
		.prepare(
			`SELECT a.state, CASE WHEN s.recipient_contact_id = 'owner' THEN 'the owner' ELSE coalesce(c.display_name, '?') END AS who,
				CASE s.requested_by WHEN 'owner' THEN 'the owner' WHEN 'iyye' THEN 'Iyye on its own' ELSE coalesce(r.display_name, '?') END AS asker
			 FROM sent_messages s
			 LEFT JOIN contacts r ON r.id = s.requester_contact_id
			 JOIN actions a ON a.idempotency_key = 'notice:send:' || s.id LEFT JOIN contacts c ON c.id = s.recipient_contact_id
			 WHERE s.created_at >= ? AND s.created_at < ?`,
		)
		.all(w.from, w.to) as { state: string; who: string; asker: string }[];
	if (sent.length) {
		const group = (states: string[]) => {
			const by = new Map<string, number>();
			for (const r of sent.filter((x) => states.includes(x.state))) by.set(r.who, (by.get(r.who) ?? 0) + 1);
			return [...by].map(([who, n]) => `${n} to ${who}`).join(", ");
		};
		const parts = [
			group(["delivered"]) ? `delivered ${group(["delivered"])}` : "",
			group(["terminal_failure"]) ? `could not be delivered ${group(["terminal_failure"])}` : "",
			group(["unknown"]) ? `may not have arrived ${group(["unknown"])}` : "",
			group(["queued", "sending", "failed", "prepared"])
				? `still on the way ${group(["queued", "sending", "failed", "prepared"])}`
				: "",
		].filter(Boolean);
		const askers = new Map<string, number>();
		for (const r of sent) askers.set(r.asker, (askers.get(r.asker) ?? 0) + 1);
		lines.push(
			`Messages Iyye sent to people: ${parts.join("; ")} (asked by ${[...askers].map(([a, n]) => `${a} ${n}`).join(", ")}).`,
		);
	}
	const low = db
		.prepare("SELECT min(level_after) AS low FROM energy_ledger WHERE at >= ? AND at < ? AND amount < 0")
		.get(w.from, w.to) as { low: number | null };
	if (low.low !== null) lines.push(`Lowest energy (adenosine) during the day: ${low.low.toFixed(2)}.`);
	const failedReplies = count(
		db,
		"SELECT count(*) AS n FROM jobs WHERE status = 'failed' AND created_at >= ? AND created_at < ?",
		w,
	);
	const unknown = count(
		db,
		"SELECT count(*) AS n FROM actions WHERE state IN ('unknown', 'terminal_failure') AND created_at >= ? AND created_at < ?",
		w,
	);
	if (failedReplies || unknown) {
		lines.push(
			`Problems: ${[failedReplies ? `${failedReplies} message(s) could not be answered` : "", unknown ? `${unknown} message(s) may not have been delivered` : ""].filter(Boolean).join("; ")}.`,
		);
	} else lines.push("No messages failed.");
	return lines.join("\n");
}

export const SUMMARY_PROMPT = [
	"Below is the record of a day in the life of Iyye, a personal assistant.",
	"Rewrite it as a short, friendly note from Iyye to its owner: two to five sentences, in English, in the first person.",
	"Use only the facts and numbers in the record. Do not add, guess or round anything. Make no promises or plans.",
	"Reply with the note only.",
].join(" ");

/** Why a model's note may not replace the digest, or null when it may. */
export function summaryProblem(note: string, digest: string, contactNames: readonly string[]): string | null {
	const text = note.trim();
	if (!text) return "empty";
	if (text.length > Math.max(digest.length, 500)) return "longer than the record";
	// A problem in the record must not vanish from the note.
	if (PROBLEM.test(unproblem(digest)) && !PROBLEM.test(unproblem(text)))
		return "it leaves out a problem in the record";
	const numbers = new Set(digest.match(/\d+(?:[.,]\d+)?/g) ?? []);
	for (const n of text.match(/\d+(?:[.,]\d+)?/g) ?? []) {
		if (!numbers.has(n)) return `the number ${n} is not in the record`;
	}
	// Numbers written as words count too ("two messages").
	for (const w of text.toLowerCase().match(WORD_NUMBERS) ?? []) {
		if (!numbers.has(String(NUMBER_WORDS.indexOf(w) + 1))) return `the number "${w}" is not in the record`;
	}
	const lower = digest.toLowerCase();
	for (const name of contactNames) {
		if (name.length >= 2 && text.toLowerCase().includes(name.toLowerCase()) && !lower.includes(name.toLowerCase()))
			return `the name ${name} is not in the record`;
	}
	// Any other name: a capitalized word that does not start a sentence must be in the record too.
	for (const sentence of text.split(/(?<=[.!?])\s+/)) {
		for (const word of sentence.split(/\s+/).slice(1)) {
			const w = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
			if (/^\p{Lu}/u.test(w) && w !== "I" && w !== "Iyye" && !lower.includes(w.toLowerCase()))
				return `the name ${w} is not in the record`;
		}
	}
	if (/\b(I will|I'll|I am going to|I'm going to|I plan to|I shall|tomorrow I)\b/i.test(text))
		return "it promises something";
	return null;
}

/** Words that mark a problem, in the digest's wording and in a note's. */
const PROBLEM =
	/stopped early|stopp(ed|ing)|could not|couldn't|cannot|can't|fail|problem|unreachable|not be (answered|delivered|stored)|may not have arrived/i;

/** Negated mentions ("No messages failed", "without any problems") are not problems. */
function unproblem(text: string): string {
	return text.replace(
		/\b(no|without( any)?|nothing)\s+(\w+\s+)?(failed|failures?|fail|problems?|issues?)\b|\bnothing failed\b/gi,
		"",
	);
}

const NUMBER_WORDS = [
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
];
const WORD_NUMBERS = new RegExp(`\\b(${NUMBER_WORDS.join("|")})\\b`, "g");

export interface SummaryModel {
	/** One completion from the memory model with thinking off; null when it could not run. */
	complete(system: string, user: string): Promise<string | null>;
}

/** The day summary: the model's note when it passes the check, otherwise the digest. */
export async function composeDaySummary(
	db: Db,
	w: DayWindow,
	model: SummaryModel | null,
): Promise<{ text: string; source: "model" | "digest"; problem: string | null }> {
	const digest = buildDigest(db, w);
	if (!model) return { text: digest, source: "digest", problem: "no model" };
	let note: string | null = null;
	try {
		note = await model.complete(SUMMARY_PROMPT, digest);
	} catch {
		note = null;
	}
	if (note === null) return { text: digest, source: "digest", problem: "the model did not answer" };
	const names = (
		db.prepare("SELECT display_name FROM contacts WHERE kind = 'contact'").all() as { display_name: string }[]
	).map((c) => c.display_name);
	const problem = summaryProblem(note, digest, names);
	return problem ? { text: digest, source: "digest", problem } : { text: note.trim(), source: "model", problem: null };
}

function count(db: Db, sql: string, w: DayWindow): number {
	return (db.prepare(sql).get(w.from, w.to) as { n: number }).n;
}
