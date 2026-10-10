// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * What Iyye knows about a person (plan 0.005 Stage 2, Theory of Mind):
 *
 * - **Owner notes** (`/note`): the owner's own words about a person, with a
 *   visibility (owner decision 2026-10-10): `owner` notes reach only the
 *   owner's turns that name the person (through recall); `person` notes also
 *   reach that person's own turns, so they may be repeated to them.
 * - **People before they write** (`/person add`): a person with no account
 *   yet. When their account first writes, the owner is told and offered the
 *   link; nothing links on its own (HLD §6.2).
 * - **Relationship hypotheses**: the fact ledger's `relation_of` beliefs
 *   about the person (plan 0.011), each with how sure Iyye is and who said it.
 *   Revisable evidence, never established identity or trust, and never a
 *   diagnosis: only relations are shown.
 *
 * Every write here is an owner command from the local web chat or the
 * terminal; nothing arriving over Telegram reaches it.
 */

import { evidenceOf, getBelief } from "../facts/beliefs.ts";
import { beliefLine } from "../facts/disclosure.ts";
import {
	accountsOf,
	type Contact,
	findContacts,
	getContact,
	linkOf,
	OWNER_CONTACT_ID,
	resolvePerson,
} from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import {
	addNote,
	deleteNote,
	findNotes,
	NOTE_MAX_CHARS,
	type NoteVisibility,
	notesAbout,
	type PersonNote,
	setNoteVisibility,
} from "../state/notes.ts";

const OWNER_READER = { principal: "owner" as const, personId: OWNER_CONTACT_ID, ownScopes: ["owner"], trusted: true };
/** New-contact notices a day: a flood of new accounts must not flood the owner's chat. */
export const NEW_CONTACT_NOTICES_DAILY = 10;

export interface PeopleDeps {
	db: Db;
	now?: () => Date;
	newId?: () => string;
}

/** `"Mary Ann" rest` or `Jacob rest`: the first reference and what follows. */
export function splitRef(text: string): { ref: string; rest: string } {
	const t = text.trim();
	if (t.startsWith('"')) {
		const end = t.indexOf('"', 1);
		if (end > 0) return { ref: t.slice(1, end).trim(), rest: t.slice(end + 1).trim() };
	}
	const sp = t.search(/\s/);
	return sp < 0 ? { ref: t, rest: "" } : { ref: t.slice(0, sp), rest: t.slice(sp + 1).trim() };
}

function unquote(t: string): string {
	const s = t.trim();
	return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).trim() : s;
}

/** The person a reference names (a linked account counts as its person), or why there is none. */
export function onePerson(db: Db, ref: string): Contact | string {
	const matches = findContacts(db, ref);
	if (matches.length === 0) return `no contact matches ${JSON.stringify(ref)}; see /contacts`;
	const persons = [...new Map(matches.map((c) => [resolvePerson(db, c).id, resolvePerson(db, c)])).values()];
	if (persons.length > 1)
		return `${JSON.stringify(ref)} matches ${persons.length} people; use an id:\n${persons
			.map((c) => `  ${c.display_name} — id ${c.id.slice(0, 8)}`)
			.join("\n")}`;
	const p = persons[0]!;
	if (p.id === OWNER_CONTACT_ID) return `${JSON.stringify(ref)} is one of your own accounts`;
	return p;
}

const short = (id: string) => id.slice(0, 8);

export class People {
	private readonly d: Required<PeopleDeps>;

	constructor(deps: PeopleDeps) {
		this.d = { now: () => new Date(), newId: () => crypto.randomUUID(), ...deps };
	}

	/** `/person add <name> ["note"]`, `/person <person>`. */
	person(args: string, by: string): string {
		const t = args.trim();
		if (/^add(\s|$)/.test(t)) return this.add(t.slice(3).trim(), by);
		if (!t) return 'usage: /person <person> | /person add <name> ["note"]';
		const p = onePerson(this.d.db, unquote(t));
		return typeof p === "string" ? p : this.view(p);
	}

	/** `/note <person> <text>`, `/note share|private|delete <id>`. */
	note(args: string, by: string): string {
		const t = args.trim();
		const m = /^(share|private|delete)\s+(\S+)$/.exec(t);
		if (m) return this.change(m[1] as "share" | "private" | "delete", m[2]!);
		const { ref, rest } = splitRef(t);
		const text = unquote(rest);
		if (!ref || !text) return "usage: /note <person> <text> | /note share|private|delete <id>";
		const p = onePerson(this.d.db, ref);
		if (typeof p === "string") return p;
		const n = addNote(this.d.db, {
			id: this.d.newId(),
			personId: p.id,
			text,
			visibility: "owner",
			by,
			at: this.d.now().toISOString(),
		});
		return `Noted about ${p.display_name} (note ${short(n.id)}), for your conversations only: Iyye sees it when you mention them.${text.length > NOTE_MAX_CHARS ? ` (Shortened to ${NOTE_MAX_CHARS} characters.)` : ""} To let ${p.display_name} see it too (Iyye may then repeat it to them): /note share ${short(n.id)}`;
	}

	private add(rest: string, by: string): string {
		const q = rest.indexOf('"');
		const name = (q >= 0 ? rest.slice(0, q) : rest).trim();
		const noteText = q >= 0 ? unquote(rest.slice(q)) : "";
		if (!name) return 'usage: /person add <name> ["note"]';
		if (name.toLowerCase() === "owner") return 'refused: "owner" means you (as in /link <account> owner)';
		if (name.length > 64 || /[\r\n"<>]/.test(name)) return "refused: a name is at most 64 characters, without quotes";
		const same = findContacts(this.d.db, name)
			.map((c) => resolvePerson(this.d.db, c))
			.filter((c) => c.id !== OWNER_CONTACT_ID);
		if (same.length > 0)
			return `refused: ${same.map((c) => `${c.display_name} (id ${short(c.id)})`).join(", ")} already ${same.length === 1 ? "has" : "have"} that name. Add a note with /note ${short(same[0]!.id)} <text>, or use another name.`;
		const id = this.d.newId();
		const at = this.d.now().toISOString();
		this.d.db.transaction(() => {
			this.d.db
				.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', ?)")
				.run(id, name, at);
			if (noteText)
				addNote(this.d.db, { id: this.d.newId(), personId: id, text: noteText, visibility: "owner", by, at });
		})();
		return `Added ${name} (id ${short(id)}), not trusted, with no account yet${noteText ? ", and your note (for your conversations only)" : ""}. When their account first writes, you will be told, and /link <account> ${short(id)} makes it theirs.`;
	}

	private change(action: "share" | "private" | "delete", ref: string): string {
		const found = findNotes(this.d.db, ref);
		if (found.length !== 1)
			return found.length === 0
				? `no note matches ${JSON.stringify(ref)}; see /person <person>`
				: `${JSON.stringify(ref)} matches ${found.length} notes; use more of the id`;
		const n = found[0]!;
		const who = getContact(this.d.db, n.person_id)?.display_name ?? "them";
		if (action === "delete") {
			deleteNote(this.d.db, n.id);
			return `Deleted note ${short(n.id)} about ${who}.`;
		}
		const v: NoteVisibility = action === "share" ? "person" : "owner";
		setNoteVisibility(this.d.db, n.id, v, this.d.now().toISOString());
		return v === "person"
			? `Note ${short(n.id)} is now shared with ${who}: Iyye sees it in their own conversations too and may repeat it to them.`
			: `Note ${short(n.id)} is now for your conversations only.`;
	}

	/** What Iyye knows about a person, for the owner. */
	view(p: Contact): string {
		const db = this.d.db;
		const accounts = [p, ...accountsOf(db, p.id)];
		const bindings = accounts.flatMap(
			(a) =>
				db.prepare("SELECT channel, external_id FROM channel_bindings WHERE contact_id = ?").all(a.id) as {
					channel: string;
					external_id: string;
				}[],
		);
		const lastSeen = (
			db
				.prepare(
					`SELECT max(received_at) AS at FROM events WHERE principal_contact_id IN (${accounts.map(() => "?").join(", ")})`,
				)
				.get(...accounts.map((a) => a.id)) as { at: string | null }
		).at;
		const notes = notesAbout(db, p.id);
		const hypotheses = relationHypotheses(db, p, this.d.now());
		return [
			`${p.display_name} — id ${short(p.id)} · ${p.trusted ? "trusted" : "not trusted"} · ${
				bindings.length ? bindings.map((b) => `${b.channel}:${b.external_id}`).join(", ") : "no account yet"
			}${lastSeen ? ` · last message ${lastSeen.slice(0, 16).replace("T", " ")}` : ""}`,
			...(accounts.length > 1
				? [
						`accounts: ${accounts
							.slice(1)
							.map((a) => `${a.display_name} (id ${short(a.id)})`)
							.join(", ")}`,
					]
				: []),
			"",
			notes.length ? "Your notes:" : "Your notes: none (/note <person> <text>)",
			...notes.map(noteLine),
			"",
			hypotheses.length
				? "Relationship hypotheses (from conversations; revisable, not established):"
				: "Relationship hypotheses: none yet",
			...hypotheses.map((h) => `  - ${h}`),
		].join("\n");
	}
}

function noteLine(n: PersonNote): string {
	return `  - ${short(n.id)} [${n.visibility === "person" ? "shared with them" : "yours only"} · ${n.created_at.slice(0, 10)}] ${n.text}`;
}

/** The ledger's `relation_of` beliefs about a person (by reference, or by name), as the owner reads them. */
export function relationHypotheses(db: Db, p: Contact, now: Date, limit = 8): string[] {
	const refs = [p, ...accountsOf(db, p.id)].map((a) => `contact:${a.id}`);
	const first = p.display_name.trim().split(/\s+/)[0]!.toLowerCase();
	const rows = db
		.prepare(
			`SELECT id FROM beliefs WHERE state = 'current' AND predicate = 'relation_of' AND (
				subject_ref IN (${refs.map(() => "?").join(", ")}) OR lower(subject) = ? OR lower(subject) = ?
				OR (length(?) >= 3 AND (' ' || lower(object) || ' ') LIKE '% ' || ? || ' %'))
			 ORDER BY p DESC, updated_at DESC LIMIT ?`,
		)
		.all(...refs, p.display_name.toLowerCase(), first, first, first, limit) as { id: string }[];
	return rows.flatMap((r) => {
		const b = getBelief(db, r.id);
		const ev = b ? evidenceOf(db, b.id) : [];
		return b && ev.length ? [`${beliefLine(db, b, ev, OWNER_READER, now)} (belief ${short(b.id)})`] : [];
	});
}

/** A person's shared notes, for their own turns: request-local, never stored in the transcript. */
export function personNoteFor(db: Db, scope: string): string | null {
	if (!scope.startsWith("contact:")) return null;
	const notes = notesAbout(db, scope.slice("contact:".length), "person");
	if (notes.length === 0) return null;
	return [
		"<owner_notes>",
		"Your owner's notes about the person you are talking with. Take them into account; they may see them:",
		...notes.map((n) => `- ${neutral(n.text)}`),
		"</owner_notes>",
	].join("\n");
}

/** The owner's notes about the people a question names (first name or full name, whole words), for recall. */
export function notesForNamed(db: Db, text: string, limit = 6): { person: string; note: PersonNote }[] {
	const people = db
		.prepare(
			"SELECT id, display_name FROM contacts WHERE kind = 'contact' AND id NOT IN (SELECT account_id FROM contact_links)",
		)
		.all() as { id: string; display_name: string }[];
	const out: { person: string; note: PersonNote }[] = [];
	for (const p of people) {
		const names = [p.display_name, ...accountsOf(db, p.id).map((a) => a.display_name)];
		const named = names.some((n) => {
			const first = n.trim().split(/\s+/)[0] ?? "";
			return (first.length >= 2 && wordIn(first, text)) || (n.trim().length >= 2 && wordIn(n.trim(), text));
		});
		if (!named) continue;
		for (const note of notesAbout(db, p.id)) out.push({ person: p.display_name, note });
	}
	return out.slice(0, limit);
}

/** The owner-notice key of a new account (`Outbox.notifyOwner` stores it as `notice:<key>`). */
export const newContactKey = (id: string) => `new-contact:${id}`;

/** The notice for a new account, or null when there is none or today's allowance is used. */
export function newContactNoticeToday(db: Db, contactId: string, now: Date): string | null {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	const sent = (
		db
			.prepare("SELECT count(*) AS n FROM actions WHERE idempotency_key LIKE ? AND created_at >= ?")
			.get(`notice:${newContactKey("")}%`, midnight.toISOString()) as { n: number }
	).n;
	return sent < NEW_CONTACT_NOTICES_DAILY ? newContactNotice(db, contactId) : null;
}

/**
 * The owner's notice when a new Telegram account first writes (plan 0.005 Stage 2), with link suggestions:
 * people of the same name, and people the owner added who have no account yet. Suggestions only; nothing links.
 */
export function newContactNotice(db: Db, contactId: string): string | null {
	const c = getContact(db, contactId);
	if (!c || linkOf(db, c.id)) return null;
	const binding = db
		.prepare("SELECT external_id FROM channel_bindings WHERE contact_id = ? AND channel = 'telegram'")
		.get(c.id) as { external_id: string } | undefined;
	const persons = db
		.prepare(
			`SELECT c.* FROM contacts c WHERE c.kind = 'contact' AND c.id <> ?
			 AND c.id NOT IN (SELECT account_id FROM contact_links) ORDER BY c.created_at`,
		)
		.all(c.id) as Contact[];
	const firstOf = (n: string) => n.trim().replace(/^@/, "").split(/\s+/)[0]!.toLowerCase();
	const sameName = persons.filter((p) => firstOf(p.display_name) === firstOf(c.display_name)).slice(0, 3);
	const noAccount = persons
		.filter(
			(p) =>
				!sameName.includes(p) &&
				!db.prepare("SELECT 1 FROM channel_bindings WHERE contact_id = ?").get(p.id) &&
				accountsOf(db, p.id).length === 0,
		)
		.slice(0, 5);
	const name = neutral(c.display_name.slice(0, 64));
	return [
		`Someone new wrote to Iyye on Telegram: ${name}${binding ? ` (Telegram user id ${binding.external_id})` : ""}, id ${short(c.id)}, not trusted.`,
		...sameName.map(
			(p) =>
				`Possibly ${neutral(p.display_name)} (id ${short(p.id)}), same name: if so, /link ${short(c.id)} ${short(p.id)}`,
		),
		...(noAccount.length
			? [
					`People you added without an account yet: ${noAccount.map((p) => `${neutral(p.display_name)} (id ${short(p.id)})`).join(", ")}; if it is one of them, /link ${short(c.id)} <their id>`,
				]
			: []),
		...(sameName.length || noAccount.length
			? [
					"A name is no proof: link only when you know the account is theirs (a link gives it their conversation, memory and shared notes).",
				]
			: []),
		`/person ${short(c.id)} shows what Iyye knows about them; /trust ${short(c.id)} trusts them.`,
	].join("\n");
}

/** A whole word (letters on neither side), case-insensitive. */
function wordIn(word: string, text: string): boolean {
	const t = text.toLowerCase();
	const w = word.toLowerCase();
	for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + 1)) {
		const before = t[i - 1];
		const after = t[i + w.length];
		if ((!before || !/\p{L}/u.test(before)) && (!after || !/\p{L}/u.test(after))) return true;
	}
	return false;
}

function neutral(s: string): string {
	return s.replace(/</g, "‹").replace(/>/g, "›");
}
