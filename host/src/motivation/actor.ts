// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Motivations act (plan 0.010 M1): a sustained, evidenced need opens one
 * opportunity in the common queue (`opportunities`), and its action uses
 * only what exists. No new permission, nothing outward except the owner's own
 * web chat.
 *
 * | motivation        | action                                                       |
 * | self-preservation | notify the owner with the cause and duration; reload a model |
 * |                   | self-healing gave up on (once a day)                         |
 * | curiosity         | ask the owner a self-model question (a few a day); investigate |
 * |                   | findings as before (0.007 S5, its own loop)                  |
 * | agency            | notify the owner (a plan waiting for approval, stalled)      |
 * | social            | journal only in M1 (it acts in M3)                           |
 *
 * - **Episodes:** an acting cluster carries its episode ("service:Telegram@<since>"),
 *   so a later outage is a new opportunity; a notice of the same kind waits
 *   out `noticeCooldownMs` (a flapping service notifies once).
 * - **Settled by the condition:** an opportunity is settled when its cluster
 *   is no longer among the signals (the service is up, the plan approved, the
 *   field known). Running a notice is not service.
 * - **Questions** carry their context into the owner's next turns (a
 *   request-local note), and the owner's next message is recorded as a
 *   pending answer, which `/self accept` applies (a statement from Telegram
 *   is plain dialogue; only the owner's confirmation changes the self model).
 * - Held while asleep and while the owner is in a conversation; each
 *   motivation can be paused (`/pause <motivation>`).
 */

import { getBelief } from "../facts/beliefs.ts";
import { type BeliefReader, beliefLine, visibleEvidence } from "../facts/disclosure.ts";
import type { Logger } from "../log.ts";
import { relationIn, type SelfModel } from "../self/model.ts";
import { getContact } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { getKv, setKv } from "../state/kv.ts";
import { MOTIVATIONS, type Motivation, type Signal } from "./signals.ts";

const PAUSED_KEY = "motivation.paused";
/** Questions go to the owner, who sees every belief with all its evidence. */
const OWNER_READER: BeliefReader = { principal: "owner", personId: "owner", ownScopes: ["owner"], trusted: true };

export type ActionKind = "ask" | "notify" | "maintain" | "investigate";

export interface ActorDeps {
	db: Db;
	log: Logger;
	mode: () => "awake" | "winding_down" | "asleep";
	notifyOwner: (req: { key: string; content: string }) => Promise<unknown>;
	self: Pick<SelfModel, "value" | "setFacet">;
	/** The owner's own statements (owner bank, `speaker:person`) that mention a name. */
	ownerFactsAbout?: ((name: string) => Promise<string[]>) | null;
	/** Load a selected model again after self-healing gave up; false when it should not (the owner unloaded it). */
	retryModel?: ((name: string) => boolean) | null;
	now?: () => Date;
	newId?: () => string;
	quietMs?: number;
	/** Conversation investigations opened per day (M2). */
	investigationsPerDay?: number;
	noticeCooldownMs?: number;
	noticesPerDay?: number;
	questionsPerDay?: number;
	/** How long a question waits for an answer before it expires. */
	questionTtlMs?: number;
	/** A field is not asked about again within this long. */
	sameFieldMs?: number;
}

export interface Opening {
	motivation: Motivation;
	signal: Signal;
}

interface ActingRow {
	id: string;
	cluster: string;
	motivation: Motivation;
	signal_kind: string;
	action_kind: ActionKind;
	evidence_text: string;
	question: string;
	status: string;
	created_at: string;
}

export interface SelfQuestion {
	id: string;
	field: string;
	question: string;
	opportunity_id: string | null;
	asked_at: string;
	status: "asked" | "answered" | "accepted" | "dismissed" | "expired" | "resolved";
	answer_text: string | null;
	answer_event_id: string | null;
	answered_at: string | null;
	settled_at: string | null;
}

/** The action a motivation's strongest signal calls for, or null (investigations and social act elsewhere). */
export function actionFor(motivation: Motivation, kind: string): ActionKind | null {
	if (motivation === "social") return null;
	if (motivation === "curiosity") {
		if (kind === "self_missing" || kind === "self_contradicted" || kind === "belief_uncertain") return "ask";
		if (kind === "question_recurring") return "investigate"; // the investigations loop runs it (M2)
		return kind === "self_stale" ? "notify" : null;
	}
	if (motivation === "self_preservation") return kind === "model_gave_up" ? "maintain" : "notify";
	return "notify";
}

export class MotivationActor {
	private readonly d: Required<ActorDeps>;

	constructor(deps: ActorDeps) {
		this.d = {
			ownerFactsAbout: null,
			retryModel: null,
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			quietMs: 180_000,
			investigationsPerDay: 2,
			noticeCooldownMs: 6 * 3_600_000,
			noticesPerDay: 3,
			questionsPerDay: 3,
			questionTtlMs: 24 * 3_600_000,
			sameFieldMs: 7 * 86_400_000,
			...deps,
		};
	}

	// ---------------------------------------------------------------- pausing

	paused(m: Motivation): boolean {
		return this.pausedList().includes(m);
	}

	pause(m: Motivation, by: string): string {
		if (this.paused(m)) return `${m.replace("_", "-")} is already paused`;
		setKv(this.d.db, PAUSED_KEY, JSON.stringify([...this.pausedList(), m]), this.iso());
		this.d.log.info("motivation: paused", { motivation: m, by });
		return `${label(m)} paused: it opens nothing and acts on nothing until /resume ${m.replace("_", "-")}.`;
	}

	resume(m: Motivation): string {
		if (!this.paused(m)) return `${m.replace("_", "-")} is not paused`;
		setKv(this.d.db, PAUSED_KEY, JSON.stringify(this.pausedList().filter((x) => x !== m)), this.iso());
		return `${label(m)} resumed.`;
	}

	private pausedList(): Motivation[] {
		try {
			return JSON.parse(getKv(this.d.db, PAUSED_KEY) ?? "[]") as Motivation[];
		} catch {
			return [];
		}
	}

	// ---------------------------------------------------------------- one sweep

	/**
	 * After a tracker sweep: open what the sustained needs call for, settle
	 * what no longer holds, record answers, then act (outside any transaction:
	 * notices are sent one by one, and a row moves on only once its notice is
	 * recorded).
	 */
	async act(openings: readonly Opening[], current: ReadonlySet<string>): Promise<void> {
		const now = this.d.now();
		for (const o of openings) this.open(o, now);
		this.settleCleared(current, now);
		this.captureAnswers(now);
		this.expireQuestions(now);
		if (this.d.mode() !== "awake") return;
		for (const row of this.d.db
			.prepare(
				"SELECT * FROM opportunities WHERE status = 'open' AND action_kind IN ('ask', 'notify', 'maintain') ORDER BY created_at",
			)
			.all() as ActingRow[]) {
			if (this.paused(row.motivation)) continue;
			try {
				if (row.action_kind === "maintain") this.maintain(row);
				else if (this.ownerBusy(now))
					break; // held while the owner is in a conversation
				else if (row.action_kind === "notify") await this.notify(row, now);
				else await this.ask(row, now);
			} catch (err) {
				this.d.log.warn("motivation: action failed", { id: row.id, error: (err as Error).message });
			}
		}
	}

	private open(o: Opening, now: Date): void {
		const action = actionFor(o.motivation, o.signal.kind);
		if (!action || this.paused(o.motivation)) return;
		const base = o.signal.cluster.split("@")[0]!;
		if (action === "notify") {
			// One notice per kind of trouble per cooldown: a flapping service notifies once.
			const recent = this.d.db
				.prepare(
					"SELECT 1 FROM opportunities WHERE action_kind = 'notify' AND (cluster = ? OR cluster LIKE ?) AND created_at >= ?",
				)
				.get(base, `${base}@%`, new Date(now.getTime() - this.d.noticeCooldownMs).toISOString());
			if (recent) return;
		}
		const at = now.toISOString();
		if (action === "investigate") {
			this.openInvestigation(o, now);
			return;
		}
		// Clusters are unique: a settled acting row of a cluster without an episode (a plan, a self-model field)
		// opens again once its wait is over (a notice's cooldown, a question's week).
		const old = this.d.db
			.prepare("SELECT status, action_kind, updated_at FROM opportunities WHERE cluster = ?")
			.get(o.signal.cluster) as { status: string; action_kind: string; updated_at: string } | undefined;
		if (old) {
			const wait = action === "ask" ? this.d.sameFieldMs : this.d.noticeCooldownMs;
			if (
				old.status === "settled" &&
				old.action_kind !== "investigate" &&
				now.getTime() - Date.parse(old.updated_at) >= wait
			)
				this.d.db
					.prepare(
						`UPDATE opportunities SET status = 'open', answer = NULL, evidence_json = ?, evidence_text = ?, question = ?,
							signal_kind = ?, action_kind = ?, created_at = ?, updated_at = ? WHERE cluster = ?`,
					)
					.run(
						JSON.stringify(o.signal.evidence),
						o.signal.text,
						describeAction(action, o.signal),
						o.signal.kind,
						action,
						at,
						at,
						o.signal.cluster,
					);
			return;
		}
		this.d.db
			.prepare(
				`INSERT OR IGNORE INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at,
					motivation, signal_kind, action_kind)
				 VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
			)
			.run(
				this.d.newId(),
				o.signal.cluster,
				o.motivation,
				JSON.stringify(o.signal.evidence),
				o.signal.text,
				describeAction(action, o.signal),
				at,
				at,
				o.motivation,
				o.signal.kind,
				action,
			);
	}

	/**
	 * The owner's recurring question becomes an investigation (M2): the S5 loop runs it with the web toolkit
	 * and its own citation check. At most `investigationsPerDay`, so a chatty day cannot become a crawl.
	 */
	private openInvestigation(o: Opening, now: Date): void {
		const today = startOfDay(now);
		const n = (
			this.d.db
				.prepare("SELECT count(*) AS n FROM opportunities WHERE domain = 'conversation' AND created_at >= ?")
				.get(today) as { n: number }
		).n;
		if (n >= this.d.investigationsPerDay) return;
		const at = now.toISOString();
		const topic = o.signal.text.replace(/^.*?did not know: /, "");
		this.d.db
			.prepare(
				`INSERT OR IGNORE INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at,
					motivation, signal_kind, action_kind)
				 VALUES (?, ?, 'conversation', ?, ?, ?, 'open', ?, ?, 'curiosity', ?, 'investigate')`,
			)
			.run(
				this.d.newId(),
				o.signal.cluster,
				JSON.stringify(o.signal.evidence),
				o.signal.text,
				topic,
				at,
				at,
				o.signal.kind,
			);
	}

	/** The condition cleared: the cluster is no longer among the signals. */
	private settleCleared(current: ReadonlySet<string>, now: Date): void {
		for (const row of this.d.db
			.prepare(
				"SELECT * FROM opportunities WHERE status IN ('open', 'running') AND action_kind IN ('notify', 'maintain', 'ask')",
			)
			.all() as ActingRow[]) {
			if (current.has(row.cluster)) continue;
			this.update(row.id, { status: "settled", answer: `cleared at ${now.toISOString()}` });
			// A question whose condition cleared another way (/self set, a belief no longer in doubt) frees the
			// one-at-a-time slot at once, instead of waiting out its day.
			this.d.db
				.prepare(
					"UPDATE self_questions SET status = 'resolved', settled_at = ? WHERE opportunity_id = ? AND status IN ('asked', 'answered')",
				)
				.run(now.toISOString(), row.id);
		}
	}

	private async notify(row: ActingRow, now: Date): Promise<void> {
		const today = startOfDay(now);
		const sent = (
			this.d.db
				.prepare(
					"SELECT count(*) AS n FROM opportunities WHERE motivation = ? AND action_kind = 'notify' AND status IN ('running', 'settled') AND created_at >= ? AND answer IS NOT 'over the daily cap'",
				)
				.get(row.motivation, today) as { n: number }
		).n;
		if (sent >= this.d.noticesPerDay) {
			this.update(row.id, { status: "settled", answer: "over the daily cap" });
			return;
		}
		// The opening time is in the key: the outbox sends a key once, and a reopened row is a new notice.
		await this.d.notifyOwner({ key: `motivation:${row.id}:${row.created_at}`, content: row.question });
		this.update(row.id, { status: "running" });
		this.d.log.info("motivation: notified", { id: row.id, motivation: row.motivation, kind: row.signal_kind });
	}

	private maintain(row: ActingRow): void {
		const model = row.cluster.slice("model:".length).split("@")[0]!;
		const ok = this.d.retryModel?.(model) ?? false;
		this.update(row.id, {
			status: "running",
			answer: ok ? `loading ${model} again` : `not reloaded (${model} is the owner's choice now)`,
		});
		this.d.log.info("motivation: maintenance", { model, retried: ok });
	}

	// ---------------------------------------------------------------- questions

	private async ask(row: ActingRow, now: Date): Promise<void> {
		const field = fieldOf(row);
		if (!field) {
			this.update(row.id, { status: "settled", answer: "nothing to ask" });
			return;
		}
		// A relation the owner already stated in their own words is taken from there, not asked again.
		if (field.startsWith("social:relation:")) {
			const id = field.slice("social:relation:".length);
			const name = getContact(this.d.db, id)?.display_name;
			const facts = name && this.d.ownerFactsAbout ? await this.d.ownerFactsAbout(name).catch(() => []) : [];
			const relation = name ? relationIn(name, facts) : null;
			if (relation) {
				this.d.self.setFacet(
					"social",
					{ [`relation:${id}`]: relation },
					"owner",
					"owner's own words (memory)",
					now,
				);
				this.update(row.id, { status: "settled", answer: `filled from the owner's own words: ${relation}` });
				return;
			}
		}
		const day = startOfDay(now);
		const n = (q: string, ...p: string[]) => (this.d.db.prepare(q).get(...p) as { n: number }).n;
		if (n("SELECT count(*) AS n FROM self_questions WHERE asked_at >= ?", day) >= this.d.questionsPerDay) return;
		if (n("SELECT count(*) AS n FROM self_questions WHERE status IN ('asked', 'answered')") > 0) return; // one at a time
		const recently = new Date(now.getTime() - this.d.sameFieldMs).toISOString();
		if (n("SELECT count(*) AS n FROM self_questions WHERE field = ? AND asked_at >= ?", field, recently) > 0) {
			this.update(row.id, { status: "settled", answer: "asked about recently" });
			return;
		}
		const id = this.d.newId();
		const text = this.questionText(field, id);
		this.d.db
			.prepare(
				"INSERT INTO self_questions (id, field, question, opportunity_id, asked_at, status) VALUES (?, ?, ?, ?, ?, 'asked')",
			)
			.run(id, field, text, row.id, now.toISOString());
		await this.d.notifyOwner({ key: `question:${id}`, content: text });
		this.update(row.id, { status: "running" });
		this.d.log.info("motivation: asked the owner", { field });
	}

	private questionText(field: string, id: string): string {
		const ref = id.slice(0, 8);
		if (field.startsWith("belief:")) {
			const b = getBelief(this.d.db, field.slice("belief:".length));
			const ev = b ? visibleEvidence(this.d.db, b, OWNER_READER) : null;
			const line = b && ev ? beliefLine(this.d.db, b, ev, OWNER_READER, this.d.now()) : "(a belief that is gone)";
			const bref = field.slice("belief:".length, "belief:".length + 8);
			return `I am not sure about this: ${line}. Is it right? Answer with /facts confirm ${bref}, /facts correct ${bref} <the right value>, or /facts wrong ${bref}.`;
		}
		const confirm = `confirm here in the web chat with /self accept ${ref}`;
		if (field === "place:stated")
			return `A question about myself: where am I? Tell me where you live, or where this computer is (a city or an area is enough), and ${confirm}.`;
		if (field === "place:estimate") {
			const city = this.d.self.value<string>("place", "estimate_city") ?? "somewhere else";
			const stated = this.d.self.value<string>("place", "stated") ?? "?";
			return `A question about myself: my network location says ${city}, but you told me ${JSON.stringify(stated)}. Is the network location misleading here (satellite internet or a VPN)? If so, ${confirm} (or /self estimate misleading).`;
		}
		const contact = getContact(this.d.db, field.slice("social:relation:".length));
		return `A question about the people I know: who is ${JSON.stringify(contact?.display_name ?? "this person")} to you? Answer in a few words (for example "my son") and ${confirm}.`;
	}

	/** The owner's first message after a question is its pending answer (never applied without confirmation). */
	private captureAnswers(now: Date): void {
		for (const q of this.d.db
			// A belief question is answered by /facts confirm|correct|wrong, never by a chat message: capturing one
			// would hold the one-at-a-time slot for a week (an `answered` row waits for /self accept).
			.prepare("SELECT * FROM self_questions WHERE status = 'asked' AND field NOT LIKE 'belief:%'")
			.all() as SelfQuestion[]) {
			const e = this.d.db
				.prepare(
					`SELECT id, coalesce(json_extract(payload_json, '$.text'), json_extract(payload_json, '$.message.text')) AS text
					 FROM events WHERE scope = 'owner' AND received_at > ? AND status != 'dropped' ORDER BY received_at`,
				)
				.all(q.asked_at) as { id: string; text: string | null }[];
			const answer = e.find((x) => x.text && !x.text.trimStart().startsWith("/"));
			if (!answer) continue;
			this.d.db
				.prepare(
					"UPDATE self_questions SET status = 'answered', answer_text = ?, answer_event_id = ?, answered_at = ? WHERE id = ?",
				)
				.run(answer.text!.slice(0, 300), answer.id, now.toISOString(), q.id);
		}
	}

	private expireQuestions(now: Date): void {
		const asked = new Date(now.getTime() - this.d.questionTtlMs).toISOString();
		const answered = new Date(now.getTime() - this.d.sameFieldMs).toISOString();
		for (const q of this.d.db
			.prepare(
				"SELECT * FROM self_questions WHERE (status = 'asked' AND asked_at < ?) OR (status = 'answered' AND answered_at < ?)",
			)
			.all(asked, answered) as SelfQuestion[])
			this.settleQuestion(q, "expired", now);
	}

	private settleQuestion(q: SelfQuestion, status: "accepted" | "dismissed" | "expired", now: Date): void {
		this.d.db
			.prepare("UPDATE self_questions SET status = ?, settled_at = ? WHERE id = ?")
			.run(status, now.toISOString(), q.id);
		if (q.opportunity_id) this.update(q.opportunity_id, { status: "settled", answer: `question ${status}` });
	}

	/** `/self accept <id> [text]`: apply the answer (or the text given) to the self model. */
	accept(ref: string, text: string, by: string): string {
		const q = this.findQuestion(ref);
		if (typeof q === "string") return q;
		if (q.field.startsWith("belief:")) {
			const bref = q.field.slice("belief:".length, "belief:".length + 8);
			return `that question is about a belief: answer with /facts confirm ${bref}, /facts correct ${bref} <the right value>, or /facts wrong ${bref}`;
		}
		if (q.status === "accepted" || q.status === "dismissed" || q.status === "expired" || q.status === "resolved")
			return `that question is ${q.status}`;
		const now = this.d.now();
		const answer = (text || q.answer_text || "").trim().slice(0, 300);
		if (q.field === "place:estimate") {
			const network = this.d.self.value<string>("network", "networkId");
			if (!network) return "the network is not known yet; try again in a few minutes";
			this.d.self.setFacet("place", { estimate_misleading: network }, "owner", by, now);
		} else {
			if (!answer) return "there is no answer yet: write one, or give it: /self accept <id> <answer>";
			if (q.field === "place:stated") this.d.self.setFacet("place", { stated: answer }, "owner", by, now);
			else this.d.self.setFacet("social", { [q.field.slice("social:".length)]: answer }, "owner", by, now);
		}
		this.settleQuestion(q, "accepted", now);
		return q.field === "place:estimate"
			? "noted: on this network the location estimate is misleading"
			: `noted: ${answer}`;
	}

	dismiss(ref: string): string {
		const q = this.findQuestion(ref);
		if (typeof q === "string") return q;
		this.settleQuestion(q, "dismissed", this.d.now());
		return "dismissed; I will not ask about it again this week";
	}

	/** `/self questions`. */
	questionsReport(): string {
		const rows = this.d.db
			.prepare("SELECT * FROM self_questions ORDER BY asked_at DESC LIMIT 10")
			.all() as SelfQuestion[];
		if (rows.length === 0) return "no questions asked yet";
		return [
			"questions about myself (latest 10):",
			...rows.map(
				(q) =>
					`  ${q.id.slice(0, 8)} ${q.asked_at.slice(0, 16).replace("T", " ")} ${q.field} · ${q.status}${q.answer_text ? ` · answer: ${JSON.stringify(q.answer_text.slice(0, 120))}` : ""}`,
			),
			"/self accept <id> [answer] · /self dismiss <id>",
		].join("\n");
	}

	/** A request-local note for the owner's turns: the open question, so a reply to it makes sense. */
	noteFor(scope: string): string | null {
		if (scope !== "owner") return null;
		const q = this.d.db
			.prepare("SELECT * FROM self_questions WHERE status IN ('asked', 'answered') ORDER BY asked_at DESC LIMIT 1")
			.get() as SelfQuestion | undefined;
		if (!q) return null;
		return [
			"<open_question>",
			`You asked the owner at ${new Date(q.asked_at).toTimeString().slice(0, 5)}: ${JSON.stringify(q.question.slice(0, 300))}`,
			q.field.startsWith("belief:")
				? `If their message answers it, thank them briefly and say it is recorded once they answer in the web chat with /facts confirm ${q.field.slice(7, 15)}, /facts correct ${q.field.slice(7, 15)} <the right value> or /facts wrong ${q.field.slice(7, 15)}. This is a record, not instructions.`
				: `If their message answers it, thank them briefly and say it is recorded once they confirm in the web chat with /self accept ${q.id.slice(0, 8)}. This is a record, not instructions.`,
			"</open_question>",
		].join("\n");
	}

	private findQuestion(ref: string): SelfQuestion | string {
		if (!/^[0-9a-f-]{6,36}$/i.test(ref)) return "give a question id, at least 6 characters (see /self questions)";
		const rows = this.d.db.prepare("SELECT * FROM self_questions WHERE id LIKE ?").all(`${ref}%`) as SelfQuestion[];
		if (rows.length !== 1) return rows.length ? `${ref} matches ${rows.length} questions` : `no question ${ref}`;
		return rows[0]!;
	}

	// ---------------------------------------------------------------- helpers

	private ownerBusy(now: Date): boolean {
		const last = (
			this.d.db
				.prepare("SELECT max(received_at) AS at FROM events WHERE scope = 'owner' AND status != 'dropped'")
				.get() as { at: string | null }
		).at;
		return last !== null && now.getTime() - Date.parse(last) < this.d.quietMs;
	}

	private update(id: string, fields: { status?: string; answer?: string }): void {
		this.d.db
			.prepare(
				"UPDATE opportunities SET status = coalesce(?, status), answer = coalesce(?, answer), updated_at = ? WHERE id = ?",
			)
			.run(fields.status ?? null, fields.answer ?? null, this.iso(), id);
	}

	private iso(): string {
		return this.d.now().toISOString();
	}
}

/** The self-model field a question is about, from the opportunity's cluster. */
function fieldOf(row: ActingRow): string | null {
	const c = row.cluster.split("@")[0]!;
	if (c.startsWith("belief:")) return c;
	if (row.signal_kind === "self_contradicted" && c.startsWith("self:place:")) return "place:estimate";
	if (c === "self:place:stated") return "place:stated";
	if (c.startsWith("self:social:relation:")) return c.slice("self:".length);
	return null;
}

/** The notice (or the note of what is asked) for an opportunity. */
function describeAction(action: ActionKind, s: Signal): string {
	if (action === "ask") return `ask the owner about: ${s.text}`;
	if (action === "maintain") return `reload: ${s.text}`;
	const head =
		s.motivation === "self_preservation"
			? "Self-preservation"
			: s.motivation === "agency"
				? "Something to act on"
				: "Something I could not keep current";
	const hint = s.kind === "plan_awaiting_approval" ? ` (/plans to see it, /plan approve <id> to let it run)` : "";
	return `${head}: ${s.text}.${hint}`;
}

function label(m: Motivation): string {
	return { self_preservation: "Self-preservation", curiosity: "Curiosity", agency: "Agency", social: "Social" }[m];
}

function startOfDay(d: Date): string {
	const s = new Date(d);
	s.setHours(0, 0, 0, 0);
	return s.toISOString();
}

export function motivationNamed(word: string): Motivation | null {
	const m = word.replace("-", "_");
	return (MOTIVATIONS as readonly string[]).includes(m) ? (m as Motivation) : null;
}

/**
 * `/forget` (gate #15): the motivations' records that may quote a forgotten
 * person's words. Opportunities of these clusters go, with their questions;
 * the notices and questions sent about them are redacted where they were
 * sent (the actions and the web chat feed); and the signals of these clusters
 * are removed from the kept motivation samples. Call inside the forget
 * transaction.
 */
export function forgetMotivationRecords(db: Db, clusters: readonly string[], redacted: string): void {
	if (clusters.length === 0) return;
	const wanted = new Set(clusters);
	const marks = clusters.map(() => "?").join(", ");
	const rows = db.prepare(`SELECT id FROM opportunities WHERE cluster IN (${marks})`).all(...clusters) as {
		id: string;
	}[];
	for (const { id } of rows) {
		const questions = db.prepare("SELECT id FROM self_questions WHERE opportunity_id = ?").all(id) as {
			id: string;
		}[];
		const keys = [`notice:motivation:${id}:%`, ...questions.map((q) => `notice:question:${q.id}`)];
		for (const key of keys) {
			db.prepare(
				"UPDATE web_feed SET text = ? WHERE action_id IN (SELECT id FROM actions WHERE idempotency_key LIKE ?)",
			).run(redacted, key);
			db.prepare("UPDATE actions SET content = ? WHERE content IS NOT NULL AND idempotency_key LIKE ?").run(
				redacted,
				key,
			);
		}
		db.prepare("DELETE FROM self_questions WHERE opportunity_id = ?").run(id);
		db.prepare("DELETE FROM opportunities WHERE id = ?").run(id);
	}
	for (const s of db
		.prepare(
			"SELECT id, signals_json FROM motivation_samples WHERE signals_json LIKE '%belief:%' OR signals_json LIKE '%plan:%'",
		)
		.all() as { id: string; signals_json: string }[]) {
		const signals = JSON.parse(s.signals_json) as { cluster: string }[];
		const kept = signals.filter((x) => !wanted.has(x.cluster));
		if (kept.length !== signals.length)
			db.prepare("UPDATE motivation_samples SET signals_json = ? WHERE id = ?").run(JSON.stringify(kept), s.id);
	}
}
