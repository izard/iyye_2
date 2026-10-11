// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The voice in shadow (plan 0.009 CH3): every Telegram message Iyye
 * delivered is rephrased afterwards by the selected voice model and judged by
 * the meaning check, and the owner labels what came out. **The original was
 * delivered and stays so**: this runs from an idle loop over delivered
 * actions in SQLite and never touches the outbox.
 *
 * - **Which messages:** delivered Telegram replies (to contacts and to the
 *   owner's linked accounts alike), and the body of messages Iyye sent with
 *   `telegram_send` (never the "✉️ From Iyye" label). Not reminders (their
 *   words are the person's), failure notices, the web chat, notices or the
 *   day summary.
 * - **When:** under background work's rules (`blockedReason`: awake, not
 *   paused, nobody waiting, no conversation for the quiet period, energy
 *   above the reserve), on the selected voice model only if it is already
 *   loaded (never loads one), holding the device as preemptible; a call that
 *   gave way is discarded. Its device time is charged to adenosine as
 *   background work. Never charged to initiative's budget.
 * - **What each sample holds:** the original, masked input and placeholder
 *   mapping (never exported), the candidate, the check's verdict, model,
 *   prompt version, the character revision and mood **as of the original's
 *   delivery**, language, audience, person and scope (for `/forget`).
 * - **The sealed evaluation set:** each original is assigned `eval` (1 in 4)
 *   or `dev` by a salted hash of its action id the first time it is seen
 *   (the salt is made once and kept in kv; the table refuses changes).
 *   Reports and exports use `dev` only; `/voice eval` is the one way to read
 *   the evaluation figures, and each read is recorded.
 * - **Kev "same meaning?"** (`voice_meaning`, shadow): asked about each
 *   candidate when the device is free; journaled, never read by the check.
 * - **Labels, two kinds:** meaning (same | changed) and preference
 *   (better | worse, or the owner's own wording). "Better" needs a "same"
 *   meaning label; a "changed" label withdraws a "better".
 */

import { createHash, randomBytes } from "node:crypto";
import { type Character, controlsOf } from "../character/character.ts";
import { moodAt, moodHeader, recordMood } from "../character/mood.ts";
import { type ControlValue, VOICE_PRESET_DEFS } from "../character/policy.ts";
import type { DecisionClient, NoulQuestion, Role } from "../decisions/client.ts";
import { IdleLoop } from "../decisions/idle.ts";
import type { Logger } from "../log.ts";
import type { ModelLease, OpResult } from "../models/manager.ts";
import { type Contact, getContact, resolvePerson } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { getEvent } from "../state/events.ts";
import { getKv, setKv } from "../state/kv.ts";
import { forgottenAt } from "../state/tombstones.ts";
import { maskFixed, presetProblem, unmask, voiceProblem } from "./check.ts";
import { voiceConfig } from "./preset.ts";
import {
	changeRatio,
	styleHeader,
	VOICE_PROMPT_VERSION,
	type VoiceComplete,
	voiceLang,
	voiceMaxTokens,
	voiceSystem,
	voiceUser,
} from "./prompt.ts";

export const VOICE_MEANING: Role = {
	name: "voice_meaning",
	schemaVersion: 1,
	abstain: { low: 0.3, high: 0.7 },
	fallback: "the deterministic meaning check (src/voice/check.ts) alone decides; the voice is in shadow",
};

/** The question of `scripts/meaning-spike.ts`, unchanged (it ranked best there). */
export const SAME_QUESTION: NoulQuestion = {
	id: "same",
	instructions:
		"The state holds a message and a rewording of it. Does the rewording say exactly the same thing as the message: the same facts, times, places, people, promises, problems and certainty, only in other words or another tone?",
};

const SINCE_KEY = "voice.shadow.since";
const SALT_KEY = "voice.split_salt";
/** Changed by every `/forget`: a rephrasing in flight across one is discarded (it may name the person). */
const FORGET_EPOCH_KEY = "voice.forget_epoch";
/** How far back a model's work list reaches (a newly selected model starts with the last two weeks). */
export const VOICE_BACKLOG_DAYS = 14;
/** Longer originals are not rephrased (recorded as such). */
export const VOICE_MAX_CHARS = 2000;
/** Below this change ratio an accepted rephrasing is a copy. */
const UNCHANGED = 0.02;
const EVAL_SHARE = 0.25;
const FORGOTTEN = "[forgotten]";

type Slot = { tryAcquire(label: string, opts?: { onPreempt?: () => void }): (() => void) | null };

export interface VoiceShadowDeps {
	db: Db;
	log: Logger;
	device: Slot;
	models: { selected(key: "voice"): string | null; acquire(name: string): Promise<ModelLease | OpResult> };
	background: { blockedReason(): string | null; yieldReason(): string | null };
	complete: VoiceComplete;
	character: Pick<Character, "revisionAt" | "revision">;
	/** Every known person's name, for masking and the check. */
	names: () => string[];
	energy?: { deviceTime(kind: "background", ms: number, ref: string): void } | null;
	decisions?: { client: Pick<DecisionClient, "ask">; ready: () => boolean; chatPending: () => boolean } | null;
	now?: () => Date;
	newId?: () => string;
	pollMs?: number;
	watchMs?: number;
}

interface Subject {
	id: string;
	event_id: string | null;
	kind: string;
	content: string;
	created_at: string;
	sent_id: string | null;
	sent_text: string | null;
	sent_scope: string | null;
	recipient_contact_id: string | null;
}

export class VoiceShadow {
	private readonly d: Required<Omit<VoiceShadowDeps, "energy" | "decisions">> &
		Pick<VoiceShadowDeps, "energy" | "decisions">;
	private readonly loop: IdleLoop;
	lastReason = "not started";

	constructor(deps: VoiceShadowDeps) {
		this.d = {
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			pollMs: 30_000,
			watchMs: 250,
			...deps,
		};
		const at = this.d.now();
		if (!getKv(this.d.db, SINCE_KEY)) {
			const since = new Date(at.getTime() - VOICE_BACKLOG_DAYS * 86_400_000).toISOString();
			setKv(this.d.db, SINCE_KEY, since, at.toISOString());
		}
		this.loop = new IdleLoop({ pollMs: this.d.pollMs, drain: () => this.drainOnce() });
	}

	start(): void {
		this.loop.start();
	}

	stop(): Promise<void> {
		return this.loop.stop();
	}

	wake(): void {
		this.loop.wake();
	}

	/** Delivered messages the selected voice model has not rephrased yet. */
	pending(): number {
		const model = this.d.models.selected("voice");
		if (!model) return 0;
		const live = (
			this.d.db
				.prepare(`SELECT count(*) AS n FROM (${LIVE_SQL})`)
				.get(this.from(), model, VOICE_PROMPT_VERSION, VOICE_PROMPT_VERSION) as { n: number }
		).n;
		const x = getExperiment(this.d.db);
		if (!x) return live;
		return (
			live +
			(
				this.d.db
					.prepare(`SELECT count(*) AS n FROM (${EXPERIMENT_SQL})`)
					.get(this.from(), model, experimentKey(x)) as {
					n: number;
				}
			).n
		);
	}

	/** One pass: Kev on candidates still unasked, then rephrase what can run now. Returns samples written. */
	async drainOnce(): Promise<number> {
		await this.askKevPending();
		let done = 0;
		for (;;) {
			const r = await this.rephraseNext();
			if (r !== "written") break;
			done++;
			await this.askKevPending();
		}
		return done;
	}

	/**
	 * The split of an original: fixed the first time it is seen, sealed thereafter. Decided by its text
	 * (masked, whitespace collapsed, lower case), not its id, so the same reply or the same template with
	 * other numbers always lands on the same side: a repeated reply can never sit in both.
	 */
	split(actionId: string, text: string): "eval" | "dev" {
		return assignSplit(this.d.db, actionId, text, this.d.now());
	}

	private from(): string {
		const since = getKv(this.d.db, SINCE_KEY)!;
		const window = new Date(this.d.now().getTime() - VOICE_BACKLOG_DAYS * 86_400_000).toISOString();
		return since > window ? since : window;
	}

	private async rephraseNext(): Promise<"written" | "idle"> {
		const blocked = this.d.background.blockedReason();
		if (blocked) return this.idle(blocked);
		const model = this.d.models.selected("voice");
		if (!model) return this.idle("no voice model is selected (/use <model> voice)");
		// The delivered messages first; then, owner messages only, the experiment the owner set (if any).
		const experiment = getExperiment(this.d.db);
		let s = this.d.db
			.prepare(`${LIVE_SQL} LIMIT 1`)
			.get(this.from(), model, VOICE_PROMPT_VERSION, VOICE_PROMPT_VERSION) as Subject | undefined;
		const testing = !s && experiment !== null;
		if (!s && experiment)
			s = this.d.db.prepare(`${EXPERIMENT_SQL} LIMIT 1`).get(this.from(), model, experimentKey(experiment)) as
				| Subject
				| undefined;
		if (!s) return this.idle("nothing to rephrase");
		const who = this.subjectPerson(s);
		const original = (s.sent_id ? s.sent_text : s.content)?.trim() ?? "";
		const at = this.d.now();
		const lang = voiceLang(original);
		// The character and mood of the delivery: the turn's bound revision when it was recorded.
		const bound = s.event_id
			? (this.d.db.prepare("SELECT character_rev FROM turn_profiles WHERE event_id = ?").get(s.event_id) as
					| { character_rev: number }
					| undefined)
			: undefined;
		const rev =
			(bound && this.d.character.revision(bound.character_rev)) || this.d.character.revisionAt(s.created_at);
		const delivered = controlsOf(rev.state);
		const x = testing && experiment ? { key: experimentKey(experiment), ...experiment } : null;
		const tested = x ? { ...delivered, preset: x.preset, sarcasm: x.sarcasm } : delivered;
		const config = voiceConfig(tested, who.audience, lang, original);
		const base = {
			action: s,
			scope: who.scope,
			person: who.person,
			audience: who.audience,
			model,
			// An experiment's samples are their own identity, even where its configuration equals the delivery's.
			promptVersion: x ? `${config.version}#${x.key}` : config.version,
			profile: { rev: rev.rev, controls: delivered, plain: config.plain },
			...(x ? { experiment: x } : {}),
		};
		if (!who.scope || forgottenAt(this.d.db, who.scope) !== null || original === FORGOTTEN || original === "") {
			this.insert({ ...base, original: "", status: "forgotten", problem: "forgotten or empty" }, at);
			return "written";
		}
		if (original.length > VOICE_MAX_CHARS) {
			this.insert({ ...base, original, status: "error", problem: `longer than ${VOICE_MAX_CHARS} characters` }, at);
			return "written";
		}
		// Never loads a model: a lease is refused unless the model is already loaded.
		const lease = await this.d.models.acquire(model);
		if (!("release" in lease)) return this.idle(`the voice model is not available: ${lease.message}`);
		const again = this.d.background.blockedReason();
		if (again) {
			lease.release();
			return this.idle(again);
		}
		let gaveWay: string | null = null;
		const abort = new AbortController();
		const release = this.d.device.tryAcquire("voice:shadow", {
			onPreempt: () => {
				gaveWay ??= "a person needs the device";
				abort.abort();
			},
		});
		if (!release) {
			lease.release();
			return this.idle("the device is busy");
		}
		const watch = setInterval(() => {
			const why = this.d.background.yieldReason();
			if (why) {
				gaveWay ??= why;
				abort.abort();
			}
		}, this.d.watchMs);
		watch.unref();
		const names = this.d.names();
		const m = maskFixed(original, names);
		const mood = moodAt(this.d.db, who.scope, new Date(s.created_at));
		const system = voiceSystem(lang, styleHeader(rev.state), moodHeader(mood), config.presetText);
		const epoch = getKv(this.d.db, FORGET_EPOCH_KEY);
		const t0 = this.d.now().getTime();
		let output: string | null = null;
		let error: string | null = null;
		try {
			output = await this.d.complete(
				model,
				system,
				voiceUser(lang, m.masked),
				voiceMaxTokens(original),
				abort.signal,
			);
		} catch (err) {
			error = (err as Error).message;
		} finally {
			clearInterval(watch);
			release();
			lease.release();
			this.d.energy?.deviceTime("background", this.d.now().getTime() - t0, `voice:${s.id}:${model}`);
		}
		const ms = this.d.now().getTime() - t0;
		if (gaveWay) return this.idle(`gave way: ${gaveWay}`);
		// Someone was forgotten while the model ran: discarded, tried again from the records as they are now.
		if (getKv(this.d.db, FORGET_EPOCH_KEY) !== epoch) return this.idle("discarded: someone was forgotten meanwhile");
		// Forgotten while the model ran (`/forget`): nothing of it is written.
		const still = this.d.db.prepare("SELECT content FROM actions WHERE id = ?").get(s.id) as {
			content: string | null;
		};
		if (forgottenAt(this.d.db, who.scope) !== null || still.content === FORGOTTEN || still.content === null) {
			this.insert(
				{ ...base, original: "", status: "forgotten", problem: "forgotten while rephrasing" },
				this.d.now(),
			);
			return "written";
		}
		const moodId = recordMood(this.d.db, mood, "voice", this.d.now(), this.d.newId);
		const common = {
			...base,
			original,
			lang,
			masked: m.masked,
			segments: m.segments,
			system,
			characterRev: rev.rev,
			moodId,
			ms,
		};
		if (error !== null || output === null) {
			this.insert({ ...common, status: "error", problem: error ?? "no output" }, this.d.now());
			return "written";
		}
		const u = unmask(output, m.segments);
		if (typeof u !== "string") {
			this.insert({ ...common, output, status: "refused", problem: u.why }, this.d.now());
			return "written";
		}
		const problem = voiceProblem(original, u, names) ?? (config.presetText ? presetProblem(original, u) : null);
		const status = problem ? "refused" : changeRatio(original, u) < UNCHANGED ? "unchanged" : "accepted";
		this.insert({ ...common, output, candidate: u, status, problem }, this.d.now());
		return "written";
	}

	private idle(why: string): "idle" {
		this.lastReason = why;
		return "idle";
	}

	private subjectPerson(s: Subject): {
		scope: string | null;
		person: Contact | null;
		audience: "owner" | "trusted" | "contact";
	} {
		let person: Contact | null = null;
		let scope: string | null = null;
		if (s.sent_id) {
			person = s.recipient_contact_id ? (getContact(this.d.db, s.recipient_contact_id) ?? null) : null;
			scope = s.sent_scope;
		} else if (s.event_id) {
			const e = getEvent(this.d.db, s.event_id);
			scope = e?.scope ?? null;
			const account = e?.principal_contact_id ? getContact(this.d.db, e.principal_contact_id) : undefined;
			person = account ? resolvePerson(this.d.db, account) : null;
		}
		const audience = person?.kind === "owner" ? "owner" : person?.trusted ? "trusted" : "contact";
		return { scope, person, audience };
	}

	private insert(r: Omit<SampleRecord, "actionId" | "eventId"> & { action: Subject }, at: Date): void {
		const { action, ...rest } = r;
		insertSample(
			this.d.db,
			{ ...rest, actionId: action.id, eventId: action.event_id },
			this.d.names(),
			at,
			this.d.newId,
		);
	}

	/** Kev's "same meaning?" about candidates not yet asked (shadow: journaled, never read by the check). */
	private async askKevPending(): Promise<void> {
		const k = this.d.decisions;
		if (!k) return;
		for (;;) {
			if (!k.ready() || k.chatPending() || this.d.background.yieldReason()) return;
			const row = this.d.db
				.prepare(
					`SELECT id, scope, original, candidate FROM voice_samples
					 WHERE candidate IS NOT NULL AND kev_decision_id IS NULL AND status IN ('accepted', 'refused', 'unchanged')
					 ORDER BY created_at LIMIT 1`,
				)
				.get() as { id: string; scope: string | null; original: string; candidate: string } | undefined;
			if (!row) return;
			const release = this.d.device.tryAcquire("decision:voice_meaning");
			if (!release) return;
			try {
				const decision = await k.client.ask(VOICE_MEANING, {
					scope: row.scope,
					subjectRef: row.id,
					state: { message: row.original, rewording: row.candidate },
					questions: [SAME_QUESTION],
				});
				if (decision.status !== "ok") return; // not answered (journaled as such): asked again later
				// A sample forgotten meanwhile keeps nothing: its decision went with its scope or its id.
				this.d.db
					.prepare(
						"UPDATE voice_samples SET kev_decision_id = ?, kev_same = ? WHERE id = ? AND status != 'forgotten'",
					)
					.run(decision.id, decision.probabilities[SAME_QUESTION.id] ?? null, row.id);
			} catch (err) {
				this.d.log.warn("voice: Kev's same-meaning question failed", { error: (err as Error).message });
				return;
			} finally {
				release();
			}
		}
	}
}

/** The `/forget` epoch: work that read it before a model call and sees another after it is discarded. */
export function forgetEpoch(db: Db): string | null {
	return getKv(db, FORGET_EPOCH_KEY);
}

/**
 * The split of an original (shared by the shadow and the acting voice): fixed the first time it is seen,
 * sealed thereafter, by a salted hash of its masked text (the salt is made once per installation).
 */
export function assignSplit(db: Db, actionId: string, text: string, at: Date): "eval" | "dev" {
	const row = db.prepare("SELECT split FROM voice_split WHERE action_id = ?").get(actionId) as
		| { split: "eval" | "dev" }
		| undefined;
	if (row) return row.split;
	let salt = getKv(db, SALT_KEY);
	if (!salt) {
		salt = randomBytes(32).toString("hex");
		setKv(db, SALT_KEY, salt, at.toISOString());
	}
	const key = text.replace(/\s+/g, " ").trim().toLowerCase() || `action:${actionId}`;
	const h = createHash("sha256").update(`${salt}:${key}`).digest().readUInt32BE(0) / 2 ** 32;
	const split = h < EVAL_SHARE ? "eval" : "dev";
	db.prepare("INSERT OR IGNORE INTO voice_split (action_id, split, assigned_at) VALUES (?, ?, ?)").run(
		actionId,
		split,
		at.toISOString(),
	);
	return split;
}

export interface SampleRecord {
	actionId: string;
	eventId: string | null;
	scope: string | null;
	person: Contact | null;
	audience: string;
	model: string;
	original: string;
	status: string;
	problem?: string | null;
	lang?: string;
	masked?: string;
	segments?: string[];
	system?: string;
	characterRev?: number;
	moodId?: string;
	output?: string;
	candidate?: string;
	ms?: number;
	/** CH4: made on the turn path; `delivered`: its candidate went out instead of the original. */
	acting?: boolean;
	delivered?: boolean;
	/** Owner decision 13: the configuration identity (default: the base prompt), its profile and any experiment. */
	promptVersion?: string;
	profile?: unknown;
	experiment?: unknown;
}

/** One sample row (and the original's split), shared by the shadow and the acting voice. */
export function insertSample(
	db: Db,
	r: SampleRecord,
	names: readonly string[],
	at: Date,
	newId: () => string = () => crypto.randomUUID(),
): string {
	assignSplit(db, r.actionId, r.masked ?? (r.original ? maskFixed(r.original, names).masked : ""), at);
	const id = newId();
	db.prepare(
		`INSERT OR IGNORE INTO voice_samples (id, action_id, event_id, scope, person_id, audience, lang, original, masked,
			segments_json, model, prompt_version, system, adapter, character_rev, mood_sample_id, output, candidate,
			status, problem, ms, created_at, acting, delivered, profile_json, experiment_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		r.actionId,
		r.eventId,
		r.scope,
		r.person?.id ?? null,
		r.audience,
		r.lang ?? voiceLang(r.original),
		r.original,
		r.masked ?? "",
		JSON.stringify(r.segments ?? []),
		r.model,
		r.promptVersion ?? VOICE_PROMPT_VERSION,
		r.system ?? "",
		r.characterRev ?? null,
		r.moodId ?? null,
		r.output ?? null,
		r.candidate ?? null,
		r.status,
		r.problem ?? null,
		r.ms ?? null,
		at.toISOString(),
		r.acting ? 1 : 0,
		r.delivered ? 1 : 0,
		r.profile === undefined ? null : JSON.stringify(r.profile),
		r.experiment === undefined ? null : JSON.stringify(r.experiment),
	);
	return id;
}

/**
 * Delivered Telegram messages since `?` the model `?` with prompt `?` has not rephrased: replies, and
 * messages sent with `telegram_send` (their body only); not reminders or failure notices.
 */
const SUBJECTS_BASE = `SELECT a.id, a.event_id, a.kind, a.content, a.created_at,
		s.id AS sent_id, s.text AS sent_text, s.scope AS sent_scope, s.recipient_contact_id
	FROM actions a LEFT JOIN sent_messages s ON a.idempotency_key = 'notice:send:' || s.id
	WHERE a.state = 'delivered' AND json_extract(a.route_json, '$.channel') = 'telegram'
	AND a.content IS NOT NULL AND a.created_at >= ?
	AND (a.kind = 'reply' OR s.id IS NOT NULL)
	AND NOT EXISTS (SELECT 1 FROM voice_samples f WHERE f.action_id = a.id AND f.status = 'forgotten')`;
/**
 * Delivered messages this model has no live-configuration sample of (any preset variant of the base prompt:
 * one configuration per message, the one it was delivered under); a forgotten original never comes back.
 */
const LIVE_SQL = `${SUBJECTS_BASE}
	AND NOT EXISTS (SELECT 1 FROM voice_samples v WHERE v.action_id = a.id AND v.model = ? AND v.experiment_json IS NULL
		AND (v.prompt_version = ? OR v.prompt_version LIKE ? || '+%'))
	ORDER BY a.created_at, a.rowid`;
/** Messages to the owner the current experiment has not been run on (its own sample identity). */
const EXPERIMENT_SQL = `${SUBJECTS_BASE}
	AND coalesce(s.scope, (SELECT e.scope FROM events e WHERE e.id = a.event_id)) = 'owner'
	AND NOT EXISTS (SELECT 1 FROM voice_samples v WHERE v.action_id = a.id AND v.model = ?
		AND json_extract(v.experiment_json, '$.key') = ?)
	ORDER BY a.created_at, a.rowid`;

const EXPERIMENT_KEY = "voice.experiment";
export interface VoiceExperiment {
	preset: ControlValue<"preset">;
	sarcasm: ControlValue<"sarcasm">;
	by: string;
	at: string;
}

/** The shadow experiment the owner set (`/voice experiment`): owner messages only, never sent, no trial boundary. */
export function getExperiment(db: Db): VoiceExperiment | null {
	try {
		const v = JSON.parse(getKv(db, EXPERIMENT_KEY) ?? "null") as VoiceExperiment | null;
		return v && v.preset !== "off" ? v : null;
	} catch {
		return null;
	}
}

export function setExperiment(db: Db, v: VoiceExperiment | null, at: string): void {
	setKv(db, EXPERIMENT_KEY, JSON.stringify(v), at);
}

export function experimentKey(x: Pick<VoiceExperiment, "preset" | "sarcasm">): string {
	return `${x.preset}:${x.sarcasm}:${VOICE_PRESET_DEFS[x.preset]?.version ?? "?"}`;
}

/**
 * `/forget` (inside its transaction): the person's samples, and samples of messages to anyone else that
 * name them, keep only their ids, as `forgotten` rows (so the same message is never rephrased again);
 * their labels, Kev's answers and their conversation's mood samples go. The sealed split keeps only ids.
 */
export function forgetVoice(
	db: Db,
	scopes: readonly string[],
	personIds: readonly string[],
	names: readonly string[] = [],
	at: string = new Date().toISOString(),
): void {
	setKv(db, FORGET_EPOCH_KEY, `${at}:${crypto.randomUUID()}`, at);
	// Whole words only: a short name ("Al") must not match inside other words and forget unrelated samples.
	const named = names
		.map((n) => n.trim())
		.filter((n) => n.length >= 2)
		.map((n) => new RegExp(`(?<![\\p{L}\\d])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "iu"));
	const ids = (
		db
			.prepare("SELECT id, scope, person_id, original, candidate FROM voice_samples WHERE status != 'forgotten'")
			.all() as {
			id: string;
			scope: string | null;
			person_id: string | null;
			original: string;
			candidate: string | null;
		}[]
	)
		.filter(
			(v) =>
				(v.scope !== null && scopes.includes(v.scope)) ||
				(v.person_id !== null && personIds.includes(v.person_id)) ||
				named.some((re) => re.test(`${v.original}\n${v.candidate ?? ""}`)),
		)
		.map((v) => v.id);
	for (const id of ids) {
		db.prepare("DELETE FROM voice_labels WHERE sample_id = ?").run(id);
		db.prepare("DELETE FROM decisions WHERE role = ? AND subject_ref = ?").run(VOICE_MEANING.name, id);
		db.prepare(
			`UPDATE voice_samples SET original = '', masked = '', segments_json = '[]', system = '', output = NULL,
				candidate = NULL, mood_sample_id = NULL, kev_decision_id = NULL, kev_same = NULL,
				status = 'forgotten', problem = 'forgotten' WHERE id = ?`,
		).run(id);
	}
	if (scopes.length)
		db.prepare(`DELETE FROM mood_samples WHERE scope IN (${scopes.map(() => "?").join(", ")})`).run(...scopes);
}
