// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Iyye's character (plan 0.009 CH1a, HLD §4.2): a small, interpretable state
 * kept as immutable revisions in SQLite, the active one mirrored atomically to
 * `<state>/character.json`.
 *
 * - **Temperament:** curiosity, agency and social initiative, multipliers in
 *   [0.7, 1.3], starting at 1.0. Nothing reads them yet (CH1b wires them into
 *   the kernel's dials, after plan 0.010 M4's trial).
 * - **Style:** six dials in [0, 1], unset until the owner answers Iyye's
 *   starting question (owner decision 9, CH1b). Style never reaches Pi's
 *   prompt (owner decision 8); only the voice (CH3) will read it.
 * - **Interests and habits:** empty until CH5's nightly review.
 *
 * Every change is a new revision, undo and reset included; history is never
 * rewritten (the table refuses updates and deletes). SQLite is the truth;
 * the file is a snapshot for inspection and readers outside the host, and is
 * rebuilt at startup when missing or stale.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../state/db.ts";
import { getKv, setKv } from "../state/kv.ts";

export const TEMPERAMENTS = ["curiosity", "agency", "social"] as const;
export type Temperament = (typeof TEMPERAMENTS)[number];
export const TEMPERAMENT_MIN = 0.7;
export const TEMPERAMENT_MAX = 1.3;

/** Each style dial with its three choice words, low to high (the starting question's words, CH1b). */
export const STYLE_DIALS = {
	length: ["short", "medium", "long"],
	warmth: ["reserved", "friendly", "warm"],
	playfulness: ["serious", "light", "playful"],
	formality: ["casual", "neutral", "formal"],
	observations: ["rarely", "sometimes", "often"],
	emoji: ["none", "few", "more"],
} as const;
export type StyleDial = keyof typeof STYLE_DIALS;
export const STYLE_NAMES = Object.keys(STYLE_DIALS) as StyleDial[];

/** Where a value came from: the start, the owner (their answer or a setting), or CH5's review. */
export type Source = "default" | "owner" | "review";

export interface Value {
	/** null: unset (a style dial with no preference yet). */
	value: number | null;
	source: Source;
	since: string;
}

export interface CharacterState {
	temperament: Record<Temperament, Value>;
	style: Record<StyleDial, Value>;
	/** CH5: source-linked statements; empty in CH1. */
	interests: { text: string; since: string }[];
}

export type RevisionKind = "start" | "owner" | "undo" | "reset" | "review";

export interface Revision {
	rev: number;
	created_at: string;
	parent_rev: number | null;
	kind: RevisionKind;
	state: CharacterState;
	by: string;
	note: string | null;
}

const ACTIVE_KEY = "character.active";
const FROZEN_KEY = "character.frozen";
const WATERMARK_KEY = "character.watermark";

export function startState(at: string): CharacterState {
	const v = (value: number | null): Value => ({ value, source: "default", since: at });
	return {
		temperament: Object.fromEntries(TEMPERAMENTS.map((t) => [t, v(1)])) as Record<Temperament, Value>,
		style: Object.fromEntries(STYLE_NAMES.map((d) => [d, v(null)])) as Record<StyleDial, Value>,
		interests: [],
	};
}

/** A dial's value in words: the nearest of its three choice words (0.2 / 0.5 / 0.8), or "unset". */
export function styleWord(dial: StyleDial, value: number | null): string {
	if (value === null) return "unset";
	const words = STYLE_DIALS[dial];
	return words[value < 0.35 ? 0 : value < 0.65 ? 1 : 2]!;
}

export interface CharacterDeps {
	db: Db;
	/** Where `character.json` is written; null: no snapshot (tests). */
	stateDir: string | null;
	now?: () => Date;
}

export class Character {
	private readonly d: Required<CharacterDeps>;

	constructor(deps: CharacterDeps) {
		this.d = { now: () => new Date(), ...deps };
	}

	/** At startup: revision 0 on the first start; the snapshot rebuilt when missing or stale. */
	init(): Revision {
		const at = this.d.now().toISOString();
		this.d.db.transaction(() => {
			if (!this.d.db.prepare("SELECT 1 FROM character_revisions LIMIT 1").get()) {
				this.d.db
					.prepare(
						"INSERT INTO character_revisions (rev, created_at, parent_rev, kind, state_json, by, note) VALUES (0, ?, NULL, 'start', ?, 'host', 'the starting character')",
					)
					.run(at, JSON.stringify(startState(at)));
				setKv(this.d.db, ACTIVE_KEY, "0", at);
			}
		})();
		const active = this.active();
		if (this.snapshotRevision() !== active.rev) this.writeSnapshot(active);
		return active;
	}

	active(): Revision {
		const rev = Number(getKv(this.d.db, ACTIVE_KEY) ?? "0");
		const r = this.revision(rev);
		if (!r) throw new Error(`character: the active revision ${rev} does not exist`);
		return r;
	}

	revision(rev: number): Revision | null {
		const row = this.d.db.prepare("SELECT * FROM character_revisions WHERE rev = ?").get(rev) as
			| (Omit<Revision, "state"> & { state_json: string })
			| undefined;
		if (!row) return null;
		const { state_json, ...rest } = row;
		return { ...rest, state: JSON.parse(state_json) as CharacterState };
	}

	frozen(): { by: string; at: string } | null {
		const v = getKv(this.d.db, FROZEN_KEY);
		return v ? (JSON.parse(v) as { by: string; at: string }) : null;
	}

	/** CH5: evidence older than this never counts again (set by a reset). */
	watermark(): string | null {
		return getKv(this.d.db, WATERMARK_KEY);
	}

	/**
	 * A new revision from the active one: `change` edits a copy of its state.
	 * The only way a value changes (CH1b's starting answer, `/character set`,
	 * CH5's review); undo and reset use it too.
	 */
	commit(
		kind: RevisionKind,
		by: string,
		note: string | null,
		change: (s: CharacterState, at: string) => void,
	): Revision {
		const at = this.d.now().toISOString();
		const rev = this.d.db.transaction(() => {
			const parent = this.active();
			const state = structuredClone(parent.state);
			change(state, at);
			const next = (this.d.db.prepare("SELECT max(rev) AS n FROM character_revisions").get() as { n: number }).n + 1;
			this.d.db
				.prepare(
					"INSERT INTO character_revisions (rev, created_at, parent_rev, kind, state_json, by, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(next, at, parent.rev, kind, JSON.stringify(state), by, note);
			setKv(this.d.db, ACTIVE_KEY, String(next), at);
			return next;
		})();
		const r = this.revision(rev)!;
		this.writeSnapshot(r);
		return r;
	}

	/** `/character …` (owner surfaces only). */
	command(args: string[], by: string): string {
		const [sub, ...rest] = args;
		const usage = "usage: /character [diff [n] | undo | freeze | unfreeze | reset [confirm]]";
		if (!sub) return this.report();
		if (sub === "diff" && rest.length <= 1) {
			const n = rest[0] ? Number(rest[0]) : 5;
			return Number.isInteger(n) && n > 0 ? this.diff(n) : usage;
		}
		if (rest.length > (sub === "reset" ? 1 : 0)) return usage;
		if (sub === "undo") return this.undo(by);
		if (sub === "freeze" || sub === "unfreeze") return this.setFrozen(sub === "freeze", by);
		if (sub === "reset") {
			if (rest[0] !== undefined && rest[0] !== "confirm") return usage;
			return this.reset(by, rest[0] === "confirm");
		}
		return usage;
	}

	report(): string {
		const r = this.active();
		const s = r.state;
		const since = (v: Value) =>
			`${v.source === "default" ? "default" : v.source === "owner" ? "yours" : "learned"}, since ${v.since.slice(0, 10)}`;
		const frozen = this.frozen();
		return [
			`character: revision ${r.rev} (${r.kind}, ${r.created_at.slice(0, 16).replace("T", " ")} UTC)${frozen ? `, frozen by ${frozen.by} since ${frozen.at.slice(0, 10)}` : ""}`,
			"temperament (scales how readily Iyye investigates, proposes and writes, within the kernel's limits; not yet applied):",
			...TEMPERAMENTS.map((t) => `  ${t}: ${s.temperament[t].value!.toFixed(2)} (${since(s.temperament[t])})`),
			"style (only for the voice, never in the chat model's prompt; not yet used):",
			...STYLE_NAMES.map((d) => {
				const v = s.style[d];
				return `  ${d}: ${v.value === null ? "unset — Iyye will ask you" : `${styleWord(d, v.value)} (${v.value.toFixed(2)}, ${since(v)})`}`;
			}),
			`interests and habits: ${s.interests.length ? s.interests.map((i) => i.text).join("; ") : "none yet (learned at night, later)"}`,
			"/character diff [n] · /character undo · /character freeze|unfreeze · /character reset",
		].join("\n");
	}

	/** "What changed in you?": the last n revisions, each against its parent. */
	diff(n: number): string {
		const rows = this.d.db.prepare("SELECT rev FROM character_revisions ORDER BY rev DESC LIMIT ?").all(n) as {
			rev: number;
		}[];
		const active = this.active().rev;
		const out: string[] = [];
		for (const { rev } of rows) {
			const r = this.revision(rev)!;
			const parent = r.parent_rev === null ? null : this.revision(r.parent_rev);
			const head = `revision ${r.rev}${r.rev === active ? " (active)" : ""}: ${r.kind} by ${r.by}, ${r.created_at.slice(0, 16).replace("T", " ")} UTC${r.note ? ` — ${r.note}` : ""}`;
			out.push(head);
			if (!parent) {
				out.push("  the starting character: temperament 1.00, style unset");
				continue;
			}
			const changes = changesBetween(parent.state, r.state);
			out.push(...(changes.length ? changes.map((c) => `  ${c}`) : ["  no value changed"]));
		}
		return out.join("\n");
	}

	/** Back to the state before the active revision, as a new revision (undo twice puts it back). */
	private undo(by: string): string {
		const r = this.active();
		if (r.parent_rev === null) return "nothing to undo: this is the starting character";
		const target = this.revision(r.parent_rev)!;
		const next = this.commit("undo", by, `undid revision ${r.rev}`, (s) => {
			s.temperament = structuredClone(target.state.temperament);
			s.style = structuredClone(target.state.style);
			s.interests = structuredClone(target.state.interests);
		});
		const changes = changesBetween(r.state, next.state);
		return `undone: revision ${r.rev}; revision ${next.rev} is active${changes.length ? `\n${changes.map((c) => `  ${c}`).join("\n")}` : " (no value changed)"}`;
	}

	private setFrozen(on: boolean, by: string): string {
		const at = this.d.now().toISOString();
		const was = this.frozen();
		if (on) {
			if (was) return `already frozen (by ${was.by} since ${was.at.slice(0, 10)})`;
			setKv(this.d.db, FROZEN_KEY, JSON.stringify({ by, at }), at);
		} else {
			if (!was) return "not frozen";
			this.d.db.prepare("DELETE FROM kv WHERE key = ?").run(FROZEN_KEY);
		}
		this.writeSnapshot(this.active());
		return on
			? "frozen: the nightly review will not change the character (your own changes still apply)"
			: "unfrozen: the nightly review may change the character again, within its bounds";
	}

	/**
	 * Back to the starting character, keeping the owner's own values (their
	 * answer and settings are not learned), with a watermark for CH5. Shown
	 * first; done only with `confirm`.
	 */
	private reset(by: string, confirm: boolean): string {
		const r = this.active();
		const learned = [
			...TEMPERAMENTS.filter((t) => r.state.temperament[t].source === "review").map((t) => `temperament ${t}`),
			...STYLE_NAMES.filter((d) => r.state.style[d].source === "review").map((d) => `style ${d}`),
			...r.state.interests.map((i) => `interest "${i.text}"`),
		];
		if (!confirm)
			return `reset goes back to the starting character and keeps your own values; what Iyye learned goes (${learned.length ? learned.join(", ") : "nothing learned yet"}), and what it learned from cannot bring it back. History is kept. /character reset confirm`;
		const next = this.commit("reset", by, `reset from revision ${r.rev}`, (s, at) => {
			const start = startState(at);
			for (const t of TEMPERAMENTS) if (s.temperament[t].source !== "owner") s.temperament[t] = start.temperament[t];
			for (const d of STYLE_NAMES) if (s.style[d].source !== "owner") s.style[d] = start.style[d];
			s.interests = [];
		});
		setKv(this.d.db, WATERMARK_KEY, next.created_at, next.created_at);
		this.writeSnapshot(next);
		return `reset: revision ${next.rev} is active; ${learned.length ? `${learned.length} learned value(s) removed` : "nothing learned was there"}, your own values kept`;
	}

	private snapshotPath(): string | null {
		return this.d.stateDir ? join(this.d.stateDir, "character.json") : null;
	}

	private snapshotRevision(): number | null {
		const p = this.snapshotPath();
		if (!p || !existsSync(p)) return null;
		try {
			const v = JSON.parse(readFileSync(p, "utf8")) as { revision?: unknown; frozen?: unknown; watermark?: unknown };
			// Stale also when the frozen flag or the watermark no longer match.
			if (v.frozen !== (this.frozen() !== null) || (v.watermark ?? null) !== this.watermark()) return null;
			return typeof v.revision === "number" ? v.revision : null;
		} catch {
			return null;
		}
	}

	/** The active revision as `character.json`: written to a temporary file, then renamed (never half-written). */
	private writeSnapshot(r: Revision): void {
		const p = this.snapshotPath();
		if (!p) return;
		const s = r.state;
		const body = {
			revision: r.rev,
			kind: r.kind,
			created_at: r.created_at,
			frozen: this.frozen() !== null,
			watermark: this.watermark(),
			temperament: Object.fromEntries(TEMPERAMENTS.map((t) => [t, s.temperament[t].value])),
			style: Object.fromEntries(STYLE_NAMES.map((d) => [d, s.style[d].value])),
			interests: s.interests.map((i) => i.text),
			sources: {
				temperament: Object.fromEntries(TEMPERAMENTS.map((t) => [t, s.temperament[t].source])),
				style: Object.fromEntries(STYLE_NAMES.map((d) => [d, s.style[d].source])),
			},
		};
		const tmp = `${p}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, p);
	}
}

/** The values that differ between two states, in words. */
export function changesBetween(a: CharacterState, b: CharacterState): string[] {
	const out: string[] = [];
	for (const t of TEMPERAMENTS) {
		const x = a.temperament[t].value;
		const y = b.temperament[t].value;
		if (x !== y) out.push(`temperament ${t}: ${x?.toFixed(2)} → ${y?.toFixed(2)} (${b.temperament[t].source})`);
	}
	for (const d of STYLE_NAMES) {
		const x = a.style[d].value;
		const y = b.style[d].value;
		if (x !== y)
			out.push(
				`style ${d}: ${styleWord(d, x)}${x === null ? "" : ` (${x.toFixed(2)})`} → ${styleWord(d, y)}${y === null ? "" : ` (${y.toFixed(2)})`} (${b.style[d].source})`,
			);
	}
	const before = new Set(a.interests.map((i) => i.text));
	const after = new Set(b.interests.map((i) => i.text));
	for (const i of after) if (!before.has(i)) out.push(`interest added: ${i}`);
	for (const i of before) if (!after.has(i)) out.push(`interest dropped: ${i}`);
	return out;
}
