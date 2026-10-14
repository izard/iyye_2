// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The voice acting (plan 0.009 CH4): a Telegram reply is rephrased between
 * Pi's answer and the outbox, inside the turn's device hold, and the
 * rephrasing goes out instead of the original only when the meaning check
 * accepts it. Off until the owner turns a surface on (`/voice act on owner|contacts`).
 *
 * The original goes out, unchanged, whenever anything is not right:
 * - the surface is off, the channel is not Telegram, or it is not a reply
 *   (failure notices are never rephrased);
 * - the turn used a tool with an effect (reminders, plans, messaging, any
 *   "act" toolkit) or had a tool call refused: receipts, arrangements and
 *   refusals keep their exact words;
 * - the voice model is not loaded (never loaded or waited for here), the call
 *   fails, takes longer than the deadline, or the turn is stopped;
 * - the placeholders do not come back, the check refuses it, or it is a copy.
 *
 * A slow answer still beats a timed-out one: the deadline only decides
 * between two versions of the same, finished answer. Every attempt is a
 * sample (`acting` 1; `delivered` 1 when its candidate went out), so the
 * shadow loop never repeats it, the owner labels it like any other, and
 * Kev's "same meaning?" is asked about it later, in shadow. What was
 * delivered is what everything downstream sees (memory, facts, reviews); the
 * original stays in the sample, and in Pi's session.
 */

import { type Character, type CharacterState, controlsOf } from "../character/character.ts";
import { moodAt, moodHeader, recordMood } from "../character/mood.ts";
import type { Logger } from "../log.ts";
import type { ModelLease, OpResult } from "../models/manager.ts";
import { type Contact, getContact, resolvePerson } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import type { EventRow } from "../state/events.ts";
import { getKv, setKv } from "../state/kv.ts";
import { maskFixed, presetProblem, unmask, voiceProblem } from "./check.ts";
import { voiceConfig } from "./preset.ts";
import {
	changeRatio,
	styleHeader,
	type VoiceComplete,
	voiceLang,
	voiceMaxTokens,
	voiceSystem,
	voiceUser,
} from "./prompt.ts";
import { forgetEpoch, insertSample, VOICE_MAX_CHARS } from "./shadow.ts";

export const ACT_KEY = "voice.act";
export const SURFACES = ["owner", "contacts"] as const;
export type Surface = (typeof SURFACES)[number];
type ActSettings = Record<Surface, { on: boolean; by: string; at: string } | undefined>;

const UNCHANGED = 0.02;

export interface Rephrased {
	content: string;
	/** Call with the delivered action's id to record the attempt (or nothing, when none was made). */
	record: (actionId: string) => void;
}

export interface VoiceActorDeps {
	db: Db;
	log: Logger;
	models: { selected(key: "voice"): string | null; acquire(name: string): Promise<ModelLease | OpResult> };
	complete: VoiceComplete;
	character: Pick<Character, "active">;
	names: () => string[];
	/** Toolkits whose effect reaches beyond reading (self, reach, act): a turn that used one is not rephrased. */
	effectToolkits: () => ReadonlySet<string>;
	deadlineMs?: number;
	now?: () => Date;
	newId?: () => string;
}

export class VoiceActor {
	private readonly d: Required<VoiceActorDeps>;

	constructor(deps: VoiceActorDeps) {
		this.d = { deadlineMs: 15_000, now: () => new Date(), newId: () => crypto.randomUUID(), ...deps };
	}

	settings(): ActSettings {
		try {
			const v = JSON.parse(getKv(this.d.db, ACT_KEY) ?? "{}") as Partial<ActSettings>;
			return { owner: v.owner, contacts: v.contacts };
		} catch {
			return { owner: undefined, contacts: undefined };
		}
	}

	/** `/voice act [on|off owner|contacts|all]` (owner surfaces only; recorded with who and when). */
	command(args: string[], by: string): string {
		const usage = "usage: /voice act [on|off owner|contacts|all]";
		const s = this.settings();
		if (args.length === 0) return this.report();
		const [onOff, which] = args;
		if (args.length !== 2 || (onOff !== "on" && onOff !== "off")) return usage;
		const targets: Surface[] =
			which === "all" ? [...SURFACES] : SURFACES.includes(which as Surface) ? [which as Surface] : [];
		if (!targets.length) return usage;
		const at = this.d.now().toISOString();
		for (const t of targets) s[t] = { on: onOff === "on", by, at };
		setKv(this.d.db, ACT_KEY, JSON.stringify(s), at);
		return this.report();
	}

	report(): string {
		const s = this.settings();
		const line = (t: Surface, label: string) =>
			`  ${label}: ${s[t]?.on ? "on" : "off"}${s[t] ? ` (set by ${s[t]!.by}, ${s[t]!.at.slice(0, 16).replace("T", " ")} UTC)` : ""}`;
		const sent = this.d.db
			.prepare("SELECT count(*) AS n, sum(delivered) AS d FROM voice_samples WHERE acting = 1")
			.get() as { n: number; d: number | null };
		return [
			"the voice acting (a Telegram reply goes out rephrased only when the meaning check accepts it; otherwise as written):",
			line("owner", "your linked Telegram accounts"),
			line("contacts", "contacts on Telegram"),
			`  so far: ${sent.d ?? 0} of ${sent.n} attempt(s) sent rephrased`,
			"/voice act on|off owner|contacts|all",
		].join("\n");
	}

	/** The content to deliver for a finished reply: the rephrasing when everything allows it, else the original. */
	/**
	 * `profile`: the character as bound when the turn started (owner decision 13): its style and controls
	 * shape this message even if the owner changes them meanwhile. Without one, the active revision.
	 */
	async rephrase(
		event: EventRow,
		original: string,
		signal: AbortSignal,
		profile: { rev: number; state: CharacterState } | null = null,
	): Promise<Rephrased> {
		const keep: Rephrased = { content: original, record: () => {} };
		try {
			if (event.channel !== "telegram" || !event.scope) return keep;
			const person = this.person(event);
			const surface: Surface = person?.kind === "owner" ? "owner" : "contacts";
			if (!this.settings()[surface]?.on) return keep;
			const model = this.d.models.selected("voice");
			if (!model) return keep;
			const audience = person?.kind === "owner" ? "owner" : person?.trusted ? "trusted" : "contact";
			const rev = profile ?? this.d.character.active();
			const controls = controlsOf(rev.state);
			const lang = voiceLang(original);
			const config = voiceConfig(controls, audience, lang, original);
			const base = {
				eventId: event.id,
				scope: event.scope,
				person,
				audience,
				model,
				original,
				acting: true,
				promptVersion: config.version,
				profile: { rev: rev.rev, controls, plain: config.plain },
				characterRev: rev.rev,
			};
			const skip = (why: string): Rephrased => ({
				content: original,
				record: (actionId) =>
					insertSample(
						this.d.db,
						{ ...base, actionId, status: "error", problem: why },
						this.d.names(),
						this.d.now(),
						this.d.newId,
					),
			});
			const why = this.effectReason(event.id);
			if (why) return skip(why);
			if (original.length > VOICE_MAX_CHARS) return skip(`longer than ${VOICE_MAX_CHARS} characters`);
			const lease = await this.d.models.acquire(model); // never loads: refused unless already loaded
			if (!("release" in lease)) return skip(`the voice model is not available: ${lease.message}`);
			const names = this.d.names();
			const m = maskFixed(original, names);
			const at = this.d.now();
			const mood = moodAt(this.d.db, event.scope, at);
			const system = voiceSystem(lang, styleHeader(rev.state), moodHeader(mood), config.presetText);
			const epoch = forgetEpoch(this.d.db);
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), this.d.deadlineMs);
			const onStop = () => abort.abort();
			signal.addEventListener("abort", onStop);
			const t0 = Date.now();
			let output: string | null = null;
			let error: string | null = null;
			try {
				output = await this.d.complete(
					model,
					system,
					voiceUser(lang, m.masked),
					voiceMaxTokens(original),
					AbortSignal.any([abort.signal, signal]),
				);
			} catch (err) {
				error = signal.aborted
					? "the turn was stopped"
					: abort.signal.aborted
						? `took longer than ${this.d.deadlineMs / 1000} s`
						: (err as Error).message;
			} finally {
				clearTimeout(timer);
				signal.removeEventListener("abort", onStop);
				lease.release();
			}
			const ms = Date.now() - t0;
			const moodId = recordMood(this.d.db, mood, "voice", this.d.now(), this.d.newId);
			const common = {
				...base,
				lang,
				masked: m.masked,
				segments: m.segments,
				system,
				moodId,
				ms,
			};
			const sample =
				(
					extra: { status: string; problem?: string | null; output?: string; candidate?: string },
					delivered: boolean,
				) =>
				(actionId: string) =>
					insertSample(
						this.d.db,
						{ ...common, ...extra, actionId, delivered },
						this.d.names(),
						this.d.now(),
						this.d.newId,
					);
			// Someone was forgotten while the voice ran: the original goes out and nothing of this is kept.
			if (forgetEpoch(this.d.db) !== epoch) return keep;
			if (error !== null || output === null)
				return { content: original, record: sample({ status: "error", problem: error ?? "no output" }, false) };
			const u = unmask(output, m.segments);
			if (typeof u !== "string")
				return { content: original, record: sample({ status: "refused", problem: u.why, output }, false) };
			const problem = voiceProblem(original, u, names) ?? (config.presetText ? presetProblem(original, u) : null);
			if (problem)
				return { content: original, record: sample({ status: "refused", problem, output, candidate: u }, false) };
			if (changeRatio(original, u) < UNCHANGED)
				return { content: original, record: sample({ status: "unchanged", output, candidate: u }, false) };
			return { content: u, record: sample({ status: "accepted", output, candidate: u }, true) };
		} catch (err) {
			this.d.log.warn("voice: acting failed, the original goes out", { error: (err as Error).message });
			return keep;
		}
	}

	private person(event: EventRow): Contact | null {
		const account = event.principal_contact_id ? getContact(this.d.db, event.principal_contact_id) : undefined;
		return account ? resolvePerson(this.d.db, account) : null;
	}

	/** Why this turn's reply keeps its exact words: a tool with an effect, or a refused tool call. */
	private effectReason(eventId: string): string | null {
		const calls = this.d.db.prepare("SELECT toolkit, outcome FROM tool_calls WHERE event_id = ?").all(eventId) as {
			toolkit: string | null;
			outcome: string;
		}[];
		if (calls.some((c) => c.outcome === "denied")) return "a tool call was refused in this turn";
		const effect = this.d.effectToolkits();
		const used = calls.find((c) => c.toolkit !== null && effect.has(c.toolkit));
		return used ? `the turn used ${used.toolkit}, a toolkit with an effect` : null;
	}
}
