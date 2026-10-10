// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Structured fact extraction (plan 0.011 §3.1–3.3): the prompt, the parser,
 * the host's grounding check and filters, fact keys and priors. Pure logic,
 * no I/O: the F0 spike and the day-time extractor (F1) share it.
 *
 * - The model fills only the text fields and flags hedges and negations. It
 *   never sets the source, the modality or the probability: the host does,
 *   from the document (provenance by construction).
 * - **Grounding on a verbatim quote:** stored facts are English, but half the
 *   turns are Russian, so English words cannot be checked against the source.
 *   The model copies the exact span it read (`quote`), which must be in the
 *   source; numbers must be in the source (resolved dates near the turn's
 *   time excepted), and names in the source (either script) or among known
 *   people.
 * - Iyye's replies yield only `told_by_iyye` facts: what it told whom. They
 *   never count as the person's statement.
 */

export type Modality = "stated" | "measured" | "told_by_iyye" | "inferred";

/** 1.x's durability scale, least durable first. */
export const TIME_FRAMES = ["ephemeral", "session", "today", "recent", "dated", "permanent"] as const;
export type TimeFrame = (typeof TIME_FRAMES)[number];

/**
 * A small closed predicate vocabulary (plan 0.011 §5: "plays violin" vs
 * "takes violin lessons"): two statements of the same thing get the same
 * key, so the nightly merge can classify them without a model. Anything else
 * is `other: <phrase>`.
 */
export const PREDICATES = [
	"is_named",
	"lives_in",
	"located_in",
	"from",
	"works_at",
	"works_as",
	"studies",
	"relation_of",
	"age",
	"born_on",
	"likes",
	"dislikes",
	"prefers",
	"owns",
	"plays",
	"practises",
	"speaks",
	"has_appointment",
	"plans_to",
	"did",
	"has",
	"is",
] as const;

/** One document to extract from: a person's words, Iyye's reply, or Iyye's own finding. */
export interface ExtractionDoc {
	kind: "person" | "reply" | "finding";
	text: string;
	/** Who wrote it, as the prompt names them: "the owner", "Jacob", "Iyye", "Iyye's probe". */
	speaker: string;
	/** The speaker's contact id ("owner" for the owner); null for Iyye and probes. */
	speakerId: string | null;
	/** For a reply: whom Iyye answered, and what they had written. */
	recipient?: string;
	asked?: string;
	/** When it was said (ISO): relative dates resolve against it. */
	at: string;
	/**
	 * For a reply: the successful tool results of its own turn (plan 0.013 E3), numbered for the model. A fact
	 * is cited only when the host resolves the number the model gives to one of them and finds the fact's
	 * figures or words in it; the model's word alone never cites.
	 */
	tools?: DocTool[];
}

/** One tool result of a reply's turn, as the extraction sees it. */
export interface DocTool {
	/** The number the model refers to it by (1, 2, …). */
	ref: number;
	/** `tool_calls.id`. */
	id: string;
	tool: string;
	/**
	 * True for a tool that observes the world (web, the machine, the repositories); false for another model's
	 * answer (`ask_thinking_model`, `look_at_image`: owner decision 2), whose provenance is kept but which
	 * gives no observation weight.
	 */
	observes: boolean;
	text: string;
}

/** What the model returns for one fact (only text fields and two flags). */
export interface RawFact {
	subject: string;
	predicate: string;
	object: string;
	details?: string | null;
	valid_from?: string | null;
	time_frame?: string | null;
	hedged?: boolean;
	negated?: boolean;
	/** The exact words of the source this fact was read from. */
	quote: string;
	/** For a reply: the source Iyye named for it (a web search, a measurement), or null. Never trusted alone. */
	source_named?: string | null;
	/** For a reply: the number of the turn's tool result the fact was taken from, or null (plan 0.013 E3). */
	tool_ref?: number | null;
}

/** A fact after the host's checks: the record of plan §3.1 without its evidence ids. */
export interface ExtractedFact {
	subject: string;
	/** The resolved subject: "owner", "contact:<id>", "iyye", or the normalized text. */
	subjectRef: string;
	predicate: string;
	object: string;
	details: string | null;
	validFrom: string;
	timeFrame: TimeFrame;
	modality: Modality;
	/** "owner", a contact id, "iyye" or "probe". */
	source: string;
	hedged: boolean;
	negated: boolean;
	quote: string;
	cited: string | null;
	/** The turn's tool result the fact was traced to (plan 0.013 E3): provenance, also for another model's answer. */
	toolCallId: string | null;
	key: string;
	p: number;
	/** Why it reaches only its speaker and the owner (plan §3.6), or null when it may be shared. */
	private: string | null;
}

export interface KnownPerson {
	id: string;
	name: string;
}

const FORMAT = [
	"Reply with JSON lines only: one JSON object per line, nothing else. If there is nothing to extract, reply with nothing.",
	'Each object: {"subject": ..., "predicate": ..., "object": ..., "details": ... or null, "valid_from": "YYYY-MM-DD" or null, "time_frame": ..., "hedged": true|false, "negated": true|false, "quote": ...}.',
	'subject: the person, place or thing the fact is about, by name when the text gives one. object: the value, keeping any comparison or estimate in it ("older than 10", "about 40 metres"). details: qualifiers, at most one short sentence, or null.',
	'valid_from: when it became true, if the text says (resolve "tomorrow", "on Monday" against the date given); otherwise null.',
	"time_frame: how long it stays true: ephemeral (minutes), session (this conversation), today, recent (days or weeks), dated (tied to a date), permanent (a lasting fact about someone or something).",
	'hedged: true when the speaker is unsure ("I think", "maybe", "probably", "кажется", "наверное"). negated: true when the statement denies it ("does not like"); keep the predicate positive.',
	"quote: copy the exact words of the text the fact comes from, in the text's own language, character for character, as short as possible.",
	"Write subject, predicate, object and details in English, whatever the language of the text.",
].join("\n");

const CLOSED = [
	`predicate: one of ${PREDICATES.join(", ")}; or "other: <a short verb phrase>" only when none fits.`,
	"Use the list whenever it fits: how old someone is → age; a sport, an instrument or a hobby someone does → practises or plays; a job → works_as; an employer → works_at; a school or a grade → studies.",
	'relation_of: the subject is the person the relation is about, the object says the relation and to whom ("wife of the owner", "son of Julia").',
].join("\n");
const FREE = 'predicate: a short verb phrase ("lives in", "is the son of", "plays").';

/** The system prompt for one document kind. `predicates` chooses the closed vocabulary (default) or free phrases. */
export function extractionPrompt(kind: ExtractionDoc["kind"], predicates: "closed" | "free" = "closed"): string {
	const intro =
		kind === "person"
			? [
					"You extract facts from one message a person wrote to Iyye, a personal assistant.",
					"Extract what the message states about the writer, the people they mention, places, plans, preferences, appointments, dates and things they own or do, including corrections of earlier facts.",
					'When the writer speaks about themselves ("I", "me", "my"), the subject is the writer, by the name given below.',
					'A question, a request or an instruction to Iyye states no fact: extract nothing from it, unless it also states something about someone ("Send Jacob, my son, a greeting" states that Jacob is the writer\'s son).',
					"Do not extract greetings, thanks or small talk, and nothing about the conversation itself.",
				]
			: kind === "reply"
				? [
						"You extract facts from one reply Iyye, a personal assistant, gave to a person.",
						"Extract only facts Iyye told them that later conversations may depend on: answers to their questions, figures, dates, names, and things Iyye confirmed it did or set up. A short answer is a fact too: extract its figure, date or name.",
						'Each fact is what Iyye said, not proof of it. Add "tool_ref": when the input lists tool results and the fact was taken from one of them, its number; otherwise null.',
						"Ignore greetings, apologies, offers, questions back, and Iyye's statements about its own feelings.",
					]
				: [
						"You extract facts from one finding of Iyye's own probe of its computer or its code.",
						"Extract the measured values (with their units) and what they describe.",
					];
	return [...intro, FORMAT, predicates === "closed" ? CLOSED : FREE].join("\n");
}

/** The user message: the document with what the model needs to resolve it. */
export function extractionInput(doc: ExtractionDoc): string {
	const lines = [`Date: ${doc.at.slice(0, 10)} (${weekday(doc.at)})`, `Writer: ${doc.speaker}`];
	if (doc.kind === "reply") {
		lines.push(`Iyye replied to: ${doc.recipient ?? "?"}`);
		if (doc.asked) lines.push(`They had written: ${JSON.stringify(doc.asked.slice(0, 400))}`);
	}
	lines.push("Text:", doc.text);
	if (doc.kind === "reply" && doc.tools?.length) {
		lines.push("", "Tool results Iyye had in this turn (to say which one a fact was taken from):");
		for (const t of doc.tools)
			lines.push(`[${t.ref}] ${t.tool}: ${t.text.replace(/\s+/g, " ").slice(0, TOOL_EXCERPT_CHARS)}`);
	}
	return lines.join("\n");
}

/** A whole number (or decimal) and the word or sign right after it, if any: "12 gb", "5%", "1933". */
const FIGURE = /(?<![\d.,])(\d+(?:[.,]\d+)?)(?![\d]|[.,]\d) ?([a-zа-яё%°]+)?/giu;

function sameNumber(a: string, b: string): boolean {
	return a.replace(",", ".") === b.replace(",", ".");
}

/** Byte units by their magnitude ("g", "gb", "gib" are one); other units as written, a plural "s" aside. */
function unitKey(u: string): string {
	const bytes = /^([kmgtp])(?:i?b)?$/i.exec(u);
	if (bytes) return `bytes:${bytes[1]!.toLowerCase()}`;
	return u.toLowerCase().replace(/s$/, "");
}

/** A value's unit against the result's: no unit on either side matches; otherwise they must be one unit. */
function sameUnit(valueUnit: string | null, resultUnit: string | null): boolean {
	if (!valueUnit || !resultUnit) return true;
	return unitKey(valueUnit) === unitKey(resultUnit);
}

/** How much of each tool result the extraction model is shown. */
const TOOL_EXCERPT_CHARS = 700;

/**
 * Whether a tool result carries a fact (plan 0.013 E3): every figure of its value (as a whole number, with
 * a unit only where the result has the same one or none), and, for a value without figures, one of its
 * content words. Traceability, not truth (owner decision 2): the result may still say something else.
 */
export function traceable(result: string, f: Pick<RawFact, "object" | "details">): boolean {
	const text = ` ${normalizeText(result)} `;
	const value = `${f.object} ${f.details ?? ""}`;
	const figures = [...value.toLowerCase().matchAll(FIGURE)];
	if (figures.length) {
		// Each figure with its unit (2026-10-10 review: "12 MB free" carried "12 GB free"): the result must have
		// the number as a whole number, followed by the same unit or by none.
		const found = [...result.toLowerCase().replace(/\s+/g, " ").matchAll(FIGURE)];
		return figures.every((m) => found.some((r) => sameNumber(r[1]!, m[1]!) && sameUnit(m[2] ?? null, r[2] ?? null)));
	}
	const words = normalizeText(f.object)
		.split(/[^\p{L}]+/u)
		.filter((w) => w.length >= 4);
	return words.some((w) => text.includes(w.slice(0, Math.max(4, w.length - 2))));
}

/** Parse the model's JSON lines (fences, a JSON array, or stray prose tolerated). */
export function parseFacts(output: string): { facts: RawFact[]; bad: number } {
	const facts: RawFact[] = [];
	let bad = 0;
	const text = output.replace(/```(?:json|jsonl)?/g, "").trim();
	if (!text) return { facts, bad };
	const take = (v: unknown) => {
		if (isRaw(v)) facts.push(v);
		else bad++;
	};
	if (text.startsWith("[")) {
		try {
			for (const v of JSON.parse(text) as unknown[]) take(v);
			return { facts, bad };
		} catch {
			// fall through to lines
		}
	}
	for (const line of text.split("\n")) {
		const l = line.trim().replace(/,$/, "");
		if (!l.startsWith("{")) continue;
		try {
			take(JSON.parse(l));
		} catch {
			bad++;
		}
	}
	return { facts, bad };
}

function isRaw(v: unknown): v is RawFact {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.subject === "string" &&
		typeof o.predicate === "string" &&
		typeof o.object === "string" &&
		typeof o.quote === "string"
	);
}

// ------------------------------------------------------------------ grounding

/** Lowercase, one space, plain quotes and dashes, no edge punctuation. */
export function normalizeText(s: string): string {
	return s
		.toLowerCase()
		.replace(/\*\*|__|`|(?<=\s|^)[*_](?=\S)|(?<=\S)[*_](?=\s|$|[.,;:!?])/g, "") // Markdown emphasis: models quote without it
		.replace(/[«»“”„"'’]/g, "")
		.replace(/[‐-―−]/g, "-")
		.replace(/ё/g, "е")
		.replace(/\s+/g, " ")
		.replace(/^[\s.,;:!?-]+|[\s.,;:!?-]+$/g, "")
		.trim();
}

const CYR: Record<string, string> = {
	а: "a",
	б: "b",
	в: "v",
	г: "g",
	д: "d",
	е: "e",
	ж: "zh",
	з: "z",
	и: "i",
	й: "y",
	к: "k",
	л: "l",
	м: "m",
	н: "n",
	о: "o",
	п: "p",
	р: "r",
	с: "s",
	т: "t",
	у: "u",
	ф: "f",
	х: "kh",
	ц: "ts",
	ч: "ch",
	ш: "sh",
	щ: "sch",
	ъ: "",
	ы: "y",
	ь: "",
	э: "e",
	ю: "yu",
	я: "ya",
};

/** A rough Latin spelling of Russian text, enough to find a transliterated name («Джулия» → "juliya"). */
export function transliterate(s: string): string {
	return s
		.toLowerCase()
		.replace(/ё/g, "е")
		.replace(/дж/g, "j")
		.replace(/[а-я]/g, (c) => CYR[c] ?? c);
}

/** Capitalized words that are not names. */
const NOT_NAMES = new Set([
	"i",
	"iyye",
	"the",
	"a",
	"an",
	"user",
	"owner",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
	"sunday",
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
	"english",
	"russian",
	"german",
	"gb",
	"mb",
	"ram",
	"cpu",
	"gpu",
	"ssd",
	"utc",
]);

/** Why a fact is not grounded in its document, or null when it is. */
export function groundingProblem(f: RawFact, doc: ExtractionDoc, people: readonly KnownPerson[]): string | null {
	const source = normalizeText(doc.text);
	const quote = normalizeText(f.quote);
	if (quote.length < 2) return "no quote";
	if (!source.includes(quote)) return "the quote is not in the source";
	const claims = [f.subject, f.object, f.details ?? ""].join(" ");
	// Numbers: in the source, except dates resolved near the time it was said ("tomorrow" → a date).
	const digits = doc.text.replace(/\s/g, "");
	const at = Date.parse(doc.at);
	for (const d of claims.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []) {
		const t = Date.parse(d);
		if (!digits.includes(d) && !(Number.isFinite(t) && Math.abs(t - at) < 400 * 86_400_000))
			return `the date ${d} is not in the source`;
	}
	const rest = claims.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ");
	for (const n of rest.match(/\d+(?:[.,]\d+)?/g) ?? []) {
		if (!digits.includes(n) && !digits.includes(n.replace(".", ","))) return `the number ${n} is not in the source`;
	}
	// Names: a capitalized word must be in the source (either script), or a known person, or the speaker.
	const latin = `${source} ${transliterate(source)}`;
	const known = people.flatMap((p) => [p.name.toLowerCase(), transliterate(p.name)]);
	for (const word of `${f.subject} ${f.object}`.split(/[^\p{L}'-]+/u)) {
		if (!/^\p{Lu}/u.test(word)) continue;
		const w = word.toLowerCase().replace(/'s$/, "");
		if (NOT_NAMES.has(w) || w.length < 2) continue;
		const stem = w.slice(0, Math.min(4, w.length));
		const tw = transliterate(w).slice(0, 4);
		if (latin.includes(stem) || latin.includes(tw)) continue;
		if (known.some((k) => k.startsWith(stem) || k.startsWith(tw))) continue;
		if (doc.speaker.toLowerCase().includes(w)) continue;
		// A Russian name may have an English form of its own (Пекин → Beijing, Мюнхен → Munich) that no
		// transliteration finds: then the quote must at least name something (a capitalized Cyrillic word).
		if (/[а-яё]/i.test(f.quote) && /(^|[^\p{L}])[А-ЯЁ][а-яё]/u.test(f.quote)) continue;
		return `the name ${word} is not in the source`;
	}
	return null;
}

/** Process narration, questions and talk about the conversation: never facts (1.x's concept filters, as rules). */
export function filterProblem(f: RawFact): string | null {
	const p = f.predicate.toLowerCase();
	const o = f.object.toLowerCase();
	if (!f.subject.trim() || !f.object.trim()) return "empty";
	if (f.object.length > 200) return "too long";
	if (
		/\b(ask(s|ed|ing)?|wants? to know|inquir(es|ed)|request(s|ed)|greet(s|ed)|thank(s|ed)|said hello|is asking)\b/.test(
			p,
		)
	)
		return "a question or a courtesy, not a fact";
	if (/\b(this|the) (message|conversation|text|document|reply|chat)\b/.test(`${p} ${o}`))
		return "about the conversation itself";
	if (/\b(no (facts|information)|nothing to extract|not (mentioned|stated|specified))\b/.test(`${p} ${o}`))
		return "the model narrating its task";
	if (/^(unknown|not (known|given|stated)|none|n\/a|\?+|self|me|myself|him|her|them|it|i)$/.test(o.trim()))
		return "an unknown value is not a fact";
	return null;
}

// ------------------------------------------------------------------ keys and priors

export function normalizeTerm(s: string): string {
	return s
		.toLowerCase()
		.replace(/\b(the|a|an)\b/g, " ")
		.replace(/[^\p{L}\p{N}:_ -]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const SELF_WORDS = new Set(["i", "me", "myself", "the writer", "writer", "я"]);
/** Words of a comparison or an estimate, in English and Russian. */
export const COMPARISON =
	/(\b(older|younger|more|less|over|under|about|around|than|approximately|roughly|at least|at most|nearly|almost|between)\b|~|старше|младше|больше|меньше|около|примерно|почти)/i;
const OWNER_WORDS = new Set(["the owner", "owner", "the user", "user"]);
/** Words that name a relation between people (a `relation_of` detail must have one to be turned). */
const RELATION_WORDS =
	/\b(wife|husband|partner|spouse|son|daughter|child|kid|father|dad|mother|mom|mum|brother|sister|sibling|grand(mother|father|son|daughter|ma|pa)|uncle|aunt|cousin|nephew|niece|friend|colleague|team ?mate|boss|manager|neighbou?r|relative)s?\b/i;

/** The subject as a reference: a known person's id, the owner, Iyye, or the normalized text. */
export function resolveSubject(subject: string, doc: ExtractionDoc, people: readonly KnownPerson[]): string {
	const s = subject.trim().toLowerCase();
	const speakerRef = doc.speakerId === "owner" ? "owner" : doc.speakerId ? `contact:${doc.speakerId}` : null;
	if (speakerRef && (SELF_WORDS.has(s) || doc.speaker.toLowerCase() === s)) return speakerRef;
	if (OWNER_WORDS.has(s)) return "owner";
	if (s === "iyye" || s === "the assistant") return "iyye";
	const first = s.split(/\s+/)[0] ?? "";
	// A person by full name, or by first name; never by a word like "the" ("the owner's mother" is not the owner).
	const hit = people.find((p) => {
		const n = p.name.toLowerCase();
		return n === s || (p.id !== "owner" && first.length >= 3 && n.split(/\s+/)[0] === first);
	});
	if (hit) return hit.id === "owner" ? "owner" : `contact:${hit.id}`;
	return normalizeTerm(subject);
}

/** The fact key (plan §3.1): two facts with the same key are about the same thing. */
export function factKey(subjectRef: string, predicate: string): string {
	return `${subjectRef}|${normalizeTerm(predicate).replace(/^other: ?/, "other:")}`;
}

export function logit(p: number): number {
	return Math.log(p / (1 - p));
}

export function sigmoid(x: number): number {
	return 1 / (1 + Math.exp(-x));
}

/**
 * The prior (plan §3.3), the same for every person (owner decision 3). A
 * hedge halves the odds; a negation is a negated fact, not a lower `p`.
 */
export function prior(
	modality: Modality,
	opts: { ownerSource: boolean; aboutSelf: boolean; cited: boolean; hedged: boolean },
): number {
	const base =
		modality === "measured"
			? 0.95
			: modality === "inferred"
				? 0.4
				: modality === "told_by_iyye"
					? opts.cited
						? 0.6
						: 0.4
					: opts.ownerSource
						? 0.9
						: opts.aboutSelf
							? 0.85
							: 0.6;
	return opts.hedged ? sigmoid(logit(base) + Math.log(0.5)) : base;
}

/**
 * Check, filter, resolve and score one document's raw facts. Returns the
 * kept facts and why each other one was dropped (counted by the caller).
 */
export function processFacts(
	raw: readonly RawFact[],
	doc: ExtractionDoc,
	people: readonly KnownPerson[],
): { kept: ExtractedFact[]; dropped: { fact: RawFact; why: string }[] } {
	const kept: ExtractedFact[] = [];
	const dropped: { fact: RawFact; why: string }[] = [];
	const seen = new Set<string>();
	const speakerRef = doc.speakerId === "owner" ? "owner" : doc.speakerId ? `contact:${doc.speakerId}` : null;
	for (const f of raw) {
		const why = filterProblem(f) ?? groundingProblem(f, doc, people);
		if (why) {
			dropped.push({ fact: f, why });
			continue;
		}
		speakerInObject(f, doc);
		// "Im older than 10" came out as "age 10" despite the prompt: the comparison is kept in the details, so
		// the merge treats the value as an approximation, never as another value of the key.
		if (COMPARISON.test(f.quote) && !COMPARISON.test(`${f.object} ${f.details ?? ""}`))
			f.details = `said as "${f.quote.trim().slice(0, 120)}"`;
		const relation = turnRelation(f, doc, people);
		if (relation) {
			dropped.push({ fact: f, why: relation });
			continue;
		}
		const subjectRef = resolveSubject(f.subject, doc, people);
		const modality: Modality = doc.kind === "reply" ? "told_by_iyye" : doc.kind === "finding" ? "measured" : "stated";
		const source = doc.kind === "person" ? (doc.speakerId ?? "unknown") : doc.kind === "reply" ? "iyye" : "probe";
		// Plan 0.013 E3: a citation is the host's: the model's number must name a result of this turn that carries
		// the fact; only an observation cites (owner decision 2), another model's answer is kept as provenance.
		const result =
			doc.kind === "reply" && typeof f.tool_ref === "number"
				? doc.tools?.find((t) => t.ref === f.tool_ref)
				: undefined;
		const traced = result && traceable(result.text, f) ? result : undefined;
		const cited = traced?.observes ? `${traced.tool} result ${traced.id.slice(0, 8)}` : null;
		const timeFrame = (TIME_FRAMES as readonly string[]).includes(f.time_frame ?? "")
			? (f.time_frame as TimeFrame)
			: doc.kind === "finding"
				? "today"
				: "recent"; // durability is earned, not defaulted (1.x lesson)
		const key = factKey(subjectRef, f.predicate);
		const dedup = `${key}|${normalizeTerm(f.object)}|${Boolean(f.negated)}`;
		if (seen.has(dedup)) continue;
		seen.add(dedup);
		kept.push({
			// "I" in the stored sentence would be nobody: the speaker's own name stands in.
			subject:
				speakerRef && subjectRef === speakerRef && SELF_WORDS.has(f.subject.trim().toLowerCase())
					? doc.speaker
					: f.subject.trim(),
			subjectRef,
			predicate: f.predicate.trim(),
			object: f.object.trim(),
			details: f.details?.trim() || null,
			validFrom: /^\d{4}-\d{2}-\d{2}/.test(f.valid_from ?? "") ? f.valid_from!.slice(0, 10) : doc.at.slice(0, 10),
			timeFrame,
			modality,
			source,
			hedged: Boolean(f.hedged),
			negated: Boolean(f.negated),
			quote: f.quote.trim(),
			cited,
			toolCallId: traced?.id ?? null,
			key,
			private: privateReason(f, doc.text),
			p: prior(modality, {
				ownerSource: source === "owner",
				aboutSelf: speakerRef !== null && subjectRef === speakerRef,
				cited: cited !== null,
				hedged: Boolean(f.hedged),
			}),
		});
	}
	return { kept, dropped };
}

/**
 * The speaker named in a value ("Jacob | relation_of | the writer", seen on
 * the real night): the prompt calls the speaker the writer, and models echo
 * that word. It is the speaker, by name.
 */
function speakerInObject(f: RawFact, doc: ExtractionDoc): void {
	if (!doc.speakerId) return;
	// "the writer's mother", "my mother" → "the owner's mother": one subject however it was put.
	f.subject = f.subject
		.trim()
		.replace(/^(the writer's|my)\s+/i, `${doc.speaker}'s `)
		.replace(/^the writer$/i, doc.speaker);
	const o = f.object.trim().toLowerCase();
	if (SELF_WORDS.has(o) || (doc.speakerId === "owner" && OWNER_WORDS.has(o))) f.object = doc.speaker;
	else f.object = f.object.replace(/\bthe writer\b/gi, doc.speaker);
}

/**
 * `relation_of` is about the related person ("Julia | relation_of | wife of
 * the owner"); models often write it the other way round ("the owner |
 * relation_of | Julia", details "wife"). Turned around, both statements of
 * one relation get one key.
 */
function turnRelation(f: RawFact, doc: ExtractionDoc, people: readonly KnownPerson[]): string | null {
	if (normalizeTerm(f.predicate) !== "relation_of") return null;
	const object = f.object.trim();
	const role = (f.details ?? "").trim();
	// A relation names one ("12 years old" is not a relation, seen on the real night).
	if (!RELATION_WORDS.test(`${object} ${role}`)) return "a relation without a relation word";
	if (!RELATION_WORDS.test(role)) return null; // the object says it already ("son of the owner")
	const named = /^\p{Lu}[\p{L}'-]*( \p{Lu}[\p{L}'-]*)?$/u.test(object) || /^the (owner|user)$/i.test(object);
	const objectRef = resolveSubject(object, doc, people);
	const subjectRef = resolveSubject(f.subject, doc, people);
	if (!named && !objectRef.startsWith("contact:") && objectRef !== "owner") return null;
	const plain = role.replace(/^(his|her|my|their|the)\s+/i, "");
	// The detail may already say it whole ("son of the owner").
	if (/\sof\s/i.test(plain)) {
		f.object = plain;
		f.details = null;
		return null;
	}
	const speakerRef = doc.speakerId === "owner" ? "owner" : doc.speakerId ? `contact:${doc.speakerId}` : null;
	if ((speakerRef !== null && subjectRef === speakerRef) || SELF_WORDS.has(f.subject.trim().toLowerCase())) {
		// "the owner | relation_of | Julia (wife)" → "Julia | relation_of | wife of the owner".
		const holder = f.subject.trim();
		f.subject = object;
		f.object = `${plain} of ${SELF_WORDS.has(holder.toLowerCase()) ? doc.speaker : holder}`;
	} else {
		// "Jacob | relation_of | the owner (son)" → "Jacob | relation_of | son of the owner".
		f.object = `${plain} of ${object}`;
	}
	f.details = null;
	return null;
}

/** The speaker asked to keep it to Iyye. */
const ASKED_PRIVATE =
	/\b(don'?t|do not|please don'?t) (tell|share|mention)\b|\bbetween (us|you and me)\b|\bkeep (it|this|that) (secret|private|to yourself)\b|\b(confidential|in confidence|secret)\b|никому не (говори|рассказывай|сообщай)|не (рассказывай|говори) (никому|об этом)|между нами|по секрету|это секрет/i;
const CREDENTIAL =
	/\b(password|passcode|passphrase|pin( code)?|login|username|account number|iban|bic|swift|card number|credit card|cvv|passport|id (card|number)|social security|tax (id|number)|license number|licence number|api key|token)\b|пароль|пин-?код|номер (карты|счёта|счета|паспорта)|паспорт|логин/i;
const HEALTH =
	/\b(health|ill|illness|sick|disease|diagnos\w*|symptom\w*|doctor|dentist|clinic|hospital|surgery|operation|therapy|therapist|medication|medicine|pills?|prescription|allerg\w*|pregnan\w*|injur\w*|depress\w*|anxiety|disorder|blood pressure|diabetes|cancer|covid)\b|здоров|болезн|болен|больна|болит|врач|доктор|стоматолог|больниц|лекарств|диагноз|аллерг|беремен|операци/i;
const MONEY =
	/\b(salary|income|wage|earns?|earning|debt|loan|mortgage|credit|savings|bank account|money|paid|price paid|costs? him|costs? her|net worth|bonus|tax(es)?|invest\w*|stocks?|shares in)\b|[€$£]\s?\d|\d\s?(€|eur|euro|usd|dollars?)\b|зарплат|доход|долг|кредит|ипотек|деньг|накоплен|сбережен|налог/i;
const ADDRESS =
	/\b(street|road|avenue|lane|boulevard|apartment|house number|postcode|postal code|zip( code)?)\b|\w*(straße|strasse|str\.)(\s|$)|\b\w+(weg|platz|allee|gasse|ring|damm)\s+\d+|\bflat \d|\b\d{5}\b|улиц|проспект|переулок|квартир|дом \d|индекс/i;

/**
 * Why a fact is private (owner decision 1, revised 2026-10-07): it then
 * reaches only its speaker and the owner. Rules, never a model's judgement:
 * the speaker asked for it anywhere in the message; a credential; health;
 * money; an address (where someone lives counts as one).
 */
export function privateReason(
	f: Pick<RawFact, "subject" | "predicate" | "object" | "details" | "quote">,
	docText: string,
): string | null {
	if (ASKED_PRIVATE.test(docText)) return "the speaker asked to keep it private";
	const claim = `${f.subject} ${f.predicate.replace(/_/g, " ")} ${f.object} ${f.details ?? ""} ${f.quote}`;
	if (CREDENTIAL.test(claim)) return "a credential";
	if (HEALTH.test(claim)) return "health";
	if (MONEY.test(claim)) return "money";
	if (normalizeTerm(f.predicate) === "lives_in" || ADDRESS.test(claim)) return "an address";
	return null;
}

/** One structured sentence for storage and recall: "Julia plays the violin". */
export function factSentence(
	f: Pick<ExtractedFact, "subject" | "predicate" | "object" | "negated" | "details">,
): string {
	const key = normalizeTerm(f.predicate);
	const phrase = PHRASES[key];
	let body: string;
	if (key === "age") body = `${possessive(f.subject)} age ${f.negated ? "is not" : "is"} ${f.object}`;
	else if (phrase) body = `${f.subject} ${f.negated ? phrase[1] : phrase[0]} ${f.object}`;
	else {
		const p = f.predicate.replace(/^other:\s*/, "").replace(/_/g, " ");
		body = `${f.subject} ${f.negated ? `does not ${p}` : p} ${f.object}`;
	}
	body = body.replace(/\s+/g, " ").trim();
	return f.details ? `${body} (${f.details})` : body;
}

/** The closed predicates in plain English: [affirmed, negated]. */
const PHRASES: Record<string, [string, string]> = {
	is_named: ["is named", "is not named"],
	lives_in: ["lives in", "does not live in"],
	located_in: ["is in", "is not in"],
	from: ["is from", "is not from"],
	works_at: ["works at", "does not work at"],
	works_as: ["works as", "does not work as"],
	studies: ["studies", "does not study"],
	relation_of: ["is the", "is not the"],
	born_on: ["was born on", "was not born on"],
	likes: ["likes", "does not like"],
	dislikes: ["dislikes", "does not dislike"],
	prefers: ["prefers", "does not prefer"],
	owns: ["owns", "does not own"],
	plays: ["plays", "does not play"],
	practises: ["practises", "does not practise"],
	speaks: ["speaks", "does not speak"],
	has_appointment: ["has an appointment:", "has no appointment:"],
	plans_to: ["plans to", "does not plan to"],
	did: ["did", "did not do"],
	has: ["has", "does not have"],
	is: ["is", "is not"],
};

function possessive(name: string): string {
	return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function weekday(iso: string): string {
	return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(iso).getUTCDay()]!;
}
