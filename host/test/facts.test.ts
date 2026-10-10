// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.011 F1–F3: structured facts during the day, beliefs and the nightly
 * merge, the fact-relation shadow role. Exit gates (HLD §15): #1 continuity,
 * #2 correction, #12 growth only from independent evidence, #15 forgetting,
 * #18 label integrity.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { DecisionClient } from "../src/decisions/client.ts";
import { FACT_RELATION, FactRelation } from "../src/decisions/fact-relation.ts";
import { conflictsOf, evidenceOf, foldP, getBelief, mergeFact, searchBeliefs } from "../src/facts/beliefs.ts";
import { FactsCommand } from "../src/facts/commands.ts";
import {
	type ExtractionDoc,
	groundingProblem,
	parseFacts,
	prior,
	processFacts,
	resolveSubject,
} from "../src/facts/extract.ts";
import { type Complete, FactExtractor } from "../src/facts/extractor.ts";
import { FactNight, STRUCTURED_TAG } from "../src/facts/night.ts";
import { docsFor, knownPeople, pendingDocs, type StmFact } from "../src/facts/store.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import { forgetRecords, forgetTarget } from "../src/memory/forget.ts";
import { MemoryGateway } from "../src/memory/gateway.ts";
import { NightWork } from "../src/memory/night.ts";
import { getContact } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { recordEpisode, recordIyyeEntry, type StmEpisode } from "../src/state/stm.ts";
import { addTombstone } from "../src/state/tombstones.ts";
import { recordToolCall } from "../src/state/tool-calls.ts";
import { CHECKPOINT, FakeKev } from "./fixtures/fake-kev-http.ts";
import { FakeLtm } from "./fixtures/fake-ltm.ts";
import { waitFor } from "./model-helpers.ts";

const T0 = new Date("2026-10-07T10:00:00Z");
const DAY = 86_400_000;
let seq = 0;
const newId = () => `${(++seq).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

function freshDb(): Db {
	const db = openDb(":memory:");
	db.prepare(
		"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('jacob', 'Jacob', 'contact', 't')",
	).run();
	db.prepare(
		"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('julia', 'Julia', 'contact', 't')",
	).run();
	return db;
}

/** An answered turn in short-term memory. */
function turn(db: Db, o: { id: string; who: "owner" | "jacob" | "julia"; text: string; reply?: string; at?: Date }) {
	const at = (o.at ?? T0).toISOString();
	const scope = o.who === "owner" ? "owner" : `contact:${o.who}`;
	const channel = o.who === "owner" ? "web" : "telegram";
	const payload = o.who === "owner" ? { text: o.text } : { message: { text: o.text, chatId: 1 } };
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'answered')",
	).run(o.id, o.id, channel, o.who, scope, at, JSON.stringify(payload));
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, ?)",
	).run(`a-${o.id}`, o.id, `k-${o.id}`, at, o.reply ?? "ok");
	recordEpisode(db, getEvent(db, o.id)!, { id: `a-${o.id}`, content: o.reply ?? "" }, at);
}

const line = (f: Record<string, unknown>) =>
	JSON.stringify({ details: null, valid_from: null, hedged: false, negated: false, ...f });

/** A fake model: the JSON lines to answer for a document whose text contains the key. */
function scripted(answers: Record<string, string[]>): Complete & { calls: string[] } {
	const calls: string[] = [];
	const fn = (async (_model: string, _system: string, user: string) => {
		calls.push(user);
		const hit = Object.entries(answers).find(([k]) => user.includes(k));
		return hit ? hit[1].join("\n") : "";
	}) as unknown as Complete & { calls: string[] };
	fn.calls = calls;
	return fn;
}

const lease = () => ({ model: "small", release() {}, valid: () => true });

function extractor(db: Db, complete: Complete, opts: { blocked?: () => string | null; device?: DeviceSlot } = {}) {
	return new FactExtractor({
		db,
		log: silentLogger,
		device: opts.device ?? new DeviceSlot(),
		models: { selected: () => "small", acquire: async () => lease() as never },
		background: { blockedReason: opts.blocked ?? (() => null), yieldReason: () => null },
		complete,
		now: () => T0,
		newId,
		watchMs: 10,
	});
}

const doc = (text: string, over: Partial<ExtractionDoc> = {}): ExtractionDoc => ({
	kind: "person",
	text,
	speaker: "the owner",
	speakerId: "owner",
	at: T0.toISOString(),
	...over,
});

describe("F1: extraction, grounding and priors", () => {
	test("grounding: the quote must be in the source; numbers and names too; a Russian exonym needs a named quote", () => {
		const people = [{ id: "jacob", name: "Jacob" }];
		const f = (o: Record<string, unknown>) => ({
			subject: "Jacob",
			predicate: "age",
			object: "12",
			quote: "Jacob - 12 years old",
			...o,
		});
		const d = doc("Note that my son Jacob - 12 years old.");
		assert.equal(groundingProblem(f({}), d, people), null);
		assert.match(groundingProblem(f({ quote: "Jacob is twelve" }), d, people)!, /quote is not in the source/);
		assert.match(groundingProblem(f({ object: "13" }), d, people)!, /number 13/);
		assert.match(groundingProblem(f({ subject: "Kevin" }), d, people)!, /name Kevin/);
		// «Пекин» is Beijing: no transliteration finds it, but the quote names something.
		const ru = doc("Джулия завтра летит в Пекин на выставку роботов.");
		assert.equal(
			groundingProblem(
				{ subject: "Julia", predicate: "plans_to", object: "fly to Beijing", quote: "летит в Пекин" },
				ru,
				[],
			),
			null,
		);
		assert.match(
			groundingProblem(
				{ subject: "Julia", predicate: "plans_to", object: "fly to Paris", quote: "летит в самолёте" },
				doc("Джулия летит в самолёте."),
				[],
			)!,
			/name Paris/,
		);
		// A date resolved from "tomorrow" is not an invented number.
		assert.equal(
			groundingProblem(
				{ subject: "Julia", predicate: "plans_to", object: "fly on 2026-10-08", quote: "летит в Пекин" },
				ru,
				[],
			),
			null,
		);
	});

	test("F0 fixes: quotes match without Markdown; a relation written the other way round is turned; an unknown value is no fact", () => {
		const people = [{ id: "jacob", name: "Jacob" }];
		const reply = doc("You have **350.8 GB** of free space available (out of a total 1858.2 GB).", {
			kind: "reply",
			speaker: "Iyye",
			speakerId: null,
		});
		assert.equal(
			groundingProblem(
				{
					subject: "home folder",
					predicate: "has",
					object: "350.8 GB",
					quote: "You have 350.8 GB of free space available",
				},
				reply,
				people,
			),
			null,
		);
		const family = doc("Note that my family consists of my wife Julia and son Jacob - 12 years old.");
		const r = processFacts(
			[
				{
					subject: "the owner",
					predicate: "relation_of",
					object: "Julia",
					details: "wife",
					quote: "my wife Julia",
				},
				{ subject: "Jacob", predicate: "relation_of", object: "son of the owner", quote: "son Jacob" },
				{ subject: "Jacob", predicate: "relation_of", object: "the writer", details: "son", quote: "son Jacob" },
				{
					subject: "the owner",
					predicate: "relation_of",
					object: "Jacob",
					details: "12 years old",
					quote: "Jacob - 12 years old",
				},
				{ subject: "Jacob", predicate: "age", object: "unknown", quote: "Jacob" },
				{ subject: "Jacob", predicate: "age", object: "self", quote: "Jacob" },
			],
			family,
			people,
		);
		assert.deepEqual(
			r.kept.map((k) => [k.subject, k.key, k.object]),
			[
				["Julia", "julia|relation_of", "wife of the owner"],
				["Jacob", "contact:jacob|relation_of", "son of the owner"],
			],
			"the second statement of the same relation is the same fact (deduplicated)",
		);
		// Seen on the real night: "the writer" (the prompt's word) is the speaker; a relation needs a relation word.
		assert.deepEqual(
			r.dropped.map((d) => d.why),
			["a relation without a relation word", "an unknown value is not a fact", "an unknown value is not a fact"],
		);
	});

	test("the host sets source, modality and prior; questions, courtesies and narration are dropped", () => {
		const people = knownPeople(freshDb());
		const raw = parseFacts(
			[
				"```json",
				line({
					subject: "I",
					predicate: "lives_in",
					object: "a suburb of Munich",
					quote: "we live in a suburb of Munich",
					time_frame: "permanent",
				}),
				line({
					subject: "Jacob",
					predicate: "practises",
					object: "foil fencing",
					quote: "Jacob fences",
					hedged: true,
				}),
				line({ subject: "the owner", predicate: "asks", object: "the weather", quote: "we live" }),
				"not json at all {",
				"```",
			].join("\n"),
		);
		assert.equal(raw.facts.length, 3);
		const r = processFacts(raw.facts, doc("I think we live in a suburb of Munich, and Jacob fences."), people);
		assert.deepEqual(
			r.kept.map((k) => [k.subjectRef, k.key, k.source, k.modality, k.p.toFixed(2), k.timeFrame]),
			[
				["owner", "owner|lives_in", "owner", "stated", "0.90", "permanent"],
				[
					"contact:jacob",
					"contact:jacob|practises",
					"owner",
					"stated",
					prior("stated", { ownerSource: true, aboutSelf: false, cited: false, hedged: true }).toFixed(2),
					"recent",
				],
			],
		);
		assert.match(r.dropped[0]!.why, /question/);
		// Priors (plan §3.3), the same for every person.
		assert.equal(prior("stated", { ownerSource: false, aboutSelf: true, cited: false, hedged: false }), 0.85);
		assert.equal(prior("stated", { ownerSource: false, aboutSelf: false, cited: false, hedged: false }), 0.6);
		assert.equal(prior("told_by_iyye", { ownerSource: false, aboutSelf: false, cited: true, hedged: false }), 0.6);
		assert.equal(prior("told_by_iyye", { ownerSource: false, aboutSelf: false, cited: false, hedged: false }), 0.4);
		assert.equal(resolveSubject("me", doc("x", { speaker: "Jacob", speakerId: "jacob" }), people), "contact:jacob");
		// Seen on the real night: "the owner's mother" is not the owner.
		assert.equal(resolveSubject("the owner's mother", doc("x"), people), "owner s mother");
		const whole = processFacts(
			[
				{
					subject: "Jacob",
					predicate: "relation_of",
					object: "the owner",
					details: "son of the owner",
					quote: "son Jacob",
				},
			],
			doc("my son Jacob"),
			people,
		);
		assert.equal(whole.kept[0]!.object, "son of the owner");
		const mother = processFacts(
			[
				{
					subject: "the writer's mother",
					predicate: "lives_in",
					object: "Cheboksary",
					quote: "Моя мама живёт в Чебоксарах",
				},
				{ subject: "my mother", predicate: "lives_in", object: "Cheboksary", quote: "Моя мама живёт в Чебоксарах" },
			],
			doc("Моя мама живёт в Чебоксарах."),
			people,
		);
		assert.deepEqual(
			mother.kept.map((k) => [k.subject, k.key]),
			[["the owner's mother", "owner s mother|lives_in"]],
		);
	});

	test("documents: a turn gives the person's words and Iyye's reply; machine findings, summaries and investigations give none", () => {
		const db = freshDb();
		turn(db, { id: "e1", who: "jacob", text: "I am 12", reply: "Nice, 12!" });
		const e = db.prepare("SELECT * FROM stm_episodes WHERE event_id = 'e1'").get() as StmEpisode;
		const docs = docsFor(db, e);
		assert.deepEqual(
			docs.map((d) => [d.docId, d.doc.kind, d.doc.speakerId]),
			[
				["e1:said", "person", "jacob"],
				["e1:replied", "reply", null],
			],
		);
		assert.equal(docs[1]!.doc.recipient, "Jacob");
		recordIyyeEntry(db, {
			id: "summary:1",
			kind: "summary",
			text: "Day 1. Messages answered: 3.",
			at: T0.toISOString(),
		});
		recordIyyeEntry(db, {
			id: "self:hw",
			kind: "observation",
			text: "Iyye runs on an M3 Max with 128 GB.",
			at: T0.toISOString(),
		});
		db.prepare(
			"INSERT INTO observations (id, domain, at, result_json, result_hash, severity, change_text) VALUES ('o1', 'machine', ?, '{}', 'h', 'none', 'x')",
		).run(T0.toISOString());
		recordIyyeEntry(db, {
			id: "obs:o1",
			kind: "observation",
			text: "machine: Telegram is retrying",
			at: T0.toISOString(),
		});
		assert.deepEqual(
			pendingDocs(db, ["day"]).map((d) => d.docId),
			["e1:said", "e1:replied", "self:hw:found"],
		);
	});

	test("#1 continuity: a fact extracted in the morning is recalled in the afternoon, scoped like its conversation", async () => {
		const db = freshDb();
		turn(db, { id: "e1", who: "julia", text: "I play the violin on Tuesdays." });
		const model = scripted({
			"play the violin": [
				line({
					subject: "I",
					predicate: "plays",
					object: "the violin",
					details: "on Tuesdays",
					quote: "I play the violin",
				}),
			],
		});
		assert.equal(await extractor(db, model).drainOnce(), true);
		const gw = new MemoryGateway({ db, ltm: null, log: silentLogger });
		const forOwner = await gw.recall({ scope: "owner", principal: "owner" }, "who plays violin?");
		const fact = forOwner.items.find((i) => i.text.startsWith("Fact:"));
		assert.ok(fact, JSON.stringify(forOwner.items));
		assert.equal(fact.text, "Fact: Julia plays the violin (on Tuesdays)");
		assert.equal(fact.said, "person");
		assert.match(fact.from ?? "", /Julia/);
		const forJacob = await gw.recall({ scope: "contact:jacob", principal: "contact" }, "who plays violin?");
		assert.equal(forJacob.items.length, 0, "another contact never sees what Julia said");
		// Iyye's reply: only what Iyye told, labelled as its own words.
		// The turn searched the web (the host's own record): the source the reply names counts.
		const searched = new Date(T0.getTime() + 3_600_000);
		turn(db, {
			id: "e2",
			who: "owner",
			text: "When did Bunin win?",
			reply: "Bunin won the Nobel Prize in 1933 (web search).",
			at: searched,
		});
		recordToolCall(db, {
			id: "t1",
			scope: "owner",
			principal: "owner",
			tool: "web_search",
			toolkit: "web",
			args_json: "{}",
			outcome: "ok",
			result: "Ivan Bunin was awarded the Nobel Prize in Literature in 1933.",
			started_at: searched.toISOString(),
			finished_at: searched.toISOString(),
			event_id: "e2",
		});
		const reply = scripted({
			"Bunin won": [
				line({
					subject: "Bunin",
					predicate: "other: won",
					object: "the Nobel Prize in 1933",
					quote: "Bunin won the Nobel Prize in 1933",
					tool_ref: 1,
				}),
			],
		});
		const ex = extractor(db, reply);
		while (await ex.drainOnce()) {}
		const told = (await gw.recall({ scope: "owner", principal: "owner" }, "Bunin Nobel")).items.find(
			(i) => i.said === "iyye",
		);
		assert.ok(told);
		assert.equal(
			(
				db.prepare("SELECT modality, source, p FROM stm_facts WHERE event_id = 'e2'").get() as {
					modality: string;
					source: string;
					p: number;
				}
			).p,
			0.6,
			"a cited relay",
		);
		// The same reply with no tool call in its turn: the extraction model's label alone cites nothing.
		turn(db, {
			id: "e3",
			who: "owner",
			text: "And Pasternak?",
			reply: "Pasternak won the Nobel Prize in 1958 (verified web search).",
			at: new Date(T0.getTime() + 7_200_000),
		});
		const claimed = scripted({
			"Pasternak won": [
				line({
					subject: "Pasternak",
					predicate: "other: won",
					object: "the Nobel Prize in 1958",
					quote: "Pasternak won the Nobel Prize in 1958",
					source_named: "verified web search",
					tool_ref: 1,
				}),
			],
		});
		const ex2 = extractor(db, claimed);
		while (await ex2.drainOnce()) {}
		assert.deepEqual(
			db.prepare("SELECT cited, p FROM stm_facts WHERE event_id = 'e3'").get(),
			{ cited: null, p: 0.4 },
			"an uncited relay",
		);
	});

	test("background rules: nothing runs while blocked; a person needing the device discards the call uncharged", async () => {
		const db = freshDb();
		turn(db, { id: "e1", who: "owner", text: "Jacob is 12." });
		assert.equal(await extractor(db, scripted({}), { blocked: () => "a person is waiting" }).drainOnce(), false);
		const device = new DeviceSlot();
		let release!: () => void;
		const slow: Complete = (_m, _s, _u, signal) =>
			new Promise((resolve, reject) => {
				release = () => resolve(line({ subject: "Jacob", predicate: "age", object: "12", quote: "Jacob is 12" }));
				signal.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const ex = extractor(db, slow, { device });
		const running = ex.drainOnce();
		await new Promise((r) => setTimeout(r, 20));
		const chat = device.acquire("chat:j1"); // a person needs the device: the extraction gives way
		assert.equal(await running, true);
		(await chat)();
		release();
		assert.equal((db.prepare("SELECT count(*) AS n FROM stm_facts").get() as { n: number }).n, 0);
		assert.equal(
			(db.prepare("SELECT count(*) AS n FROM fact_extractions").get() as { n: number }).n,
			0,
			"no attempt charged",
		);
		assert.deepEqual(
			pendingDocs(db, ["day"]).map((d) => d.docId),
			["e1:said"],
		);
	});

	test("#15: a /forget that lands between a turn and its extraction keeps the facts out", async () => {
		const db = freshDb();
		turn(db, { id: "e1", who: "jacob", text: "My PIN is 4321." });
		addTombstone(db, "contact:jacob", new Date(T0.getTime() + 1000).toISOString(), "owner");
		const model = scripted({
			PIN: [line({ subject: "I", predicate: "has", object: "PIN 4321", quote: "My PIN is 4321" })],
		});
		await extractor(db, model).drainOnce();
		assert.equal((db.prepare("SELECT count(*) AS n FROM stm_facts").get() as { n: number }).n, 0);
		assert.equal(
			(db.prepare("SELECT status FROM fact_extractions WHERE doc_id = 'e1:said'").get() as { status: string })
				.status,
			"skipped",
		);
	});
});

// ------------------------------------------------------------------ F2

function fact(
	db: Db,
	o: Partial<StmFact> & { id: string; source: string; scope: string; object: string; fact_key: string },
): StmFact {
	const f: StmFact = {
		doc_id: `${o.id}:said`,
		event_id: o.id,
		modality: "stated",
		subject: o.fact_key.split("|")[0]!.replace(/^contact:/, ""),
		subject_ref: o.fact_key.split("|")[0]!,
		predicate: o.fact_key.split("|")[1]!,
		details: null,
		valid_from: T0.toISOString().slice(0, 10),
		time_frame: "permanent",
		hedged: 0,
		negated: 0,
		quote: "q",
		cited: null,
		p: o.source === "owner" ? 0.9 : 0.6,
		said_at: T0.toISOString(),
		created_at: T0.toISOString(),
		state: "day",
		merged_at: null,
		belief_id: null,
		...o,
	} as StmFact;
	db.prepare(
		`INSERT INTO stm_facts (id, doc_id, event_id, scope, modality, source, subject, subject_ref, predicate, object, details, valid_from,
			time_frame, hedged, negated, quote, cited, fact_key, p, said_at, created_at)
		 VALUES (@id, @doc_id, @event_id, @scope, @modality, @source, @subject, @subject_ref, @predicate, @object, @details, @valid_from,
			@time_frame, @hedged, @negated, @quote, @cited, @fact_key, @p, @said_at, @created_at)`,
	).run(f);
	return f;
}

const opts = (night = "n1", now = T0) => ({ night, maxStep: 2, now, newId });

describe("F2: beliefs and the nightly merge", () => {
	test("#12 growth: independent sources raise a belief; a repeat and Iyye's echo never do", () => {
		const db = freshDb();
		const key = "contact:julia|plays";
		const r1 = mergeFact(
			db,
			fact(db, { id: "f1", source: "julia", scope: "contact:julia", object: "the violin", fact_key: key, p: 0.85 }),
			opts(),
		);
		assert.equal(r1.relation, "new");
		const p1 = getBelief(db, r1.beliefId!)!.p;
		assert.ok(Math.abs(p1 - 0.85) < 1e-9);
		// Julia again, the same day: not independent.
		mergeFact(
			db,
			fact(db, { id: "f2", source: "julia", scope: "contact:julia", object: "The violin", fact_key: key, p: 0.85 }),
			opts(),
		);
		// Iyye repeating it to the owner: its own words.
		mergeFact(
			db,
			fact(db, {
				id: "f3",
				source: "iyye",
				scope: "owner",
				modality: "told_by_iyye",
				object: "the violin",
				fact_key: key,
				p: 0.6,
			}),
			opts(),
		);
		assert.ok(Math.abs(getBelief(db, r1.beliefId!)!.p - p1) < 1e-9, "unchanged");
		assert.deepEqual(
			evidenceOf(db, r1.beliefId!).map((e) => [e.source, e.relation, e.weight]),
			[
				["julia", "new", 1],
				["julia", "corroborates", 0],
				["iyye", "corroborates", 0],
			],
		);
		// The owner, independently: up.
		mergeFact(
			db,
			fact(db, { id: "f4", source: "owner", scope: "owner", object: "the violin", fact_key: key }),
			opts(),
		);
		assert.ok(getBelief(db, r1.beliefId!)!.p > p1);
	});

	test("#12: Iyye's own uncited words create no belief; a cited relay does, with its prior", () => {
		const db = freshDb();
		const uncited = mergeFact(
			db,
			fact(db, {
				id: "f1",
				source: "iyye",
				scope: "owner",
				modality: "told_by_iyye",
				object: "12 years old",
				fact_key: "contact:jacob|age",
				p: 0.4,
			}),
			opts(),
		);
		assert.equal(uncited.beliefId, null);
		assert.equal((db.prepare("SELECT count(*) AS n FROM beliefs").get() as { n: number }).n, 0);
		assert.equal(
			(db.prepare("SELECT state FROM stm_facts WHERE id = 'f1'").get() as { state: string }).state,
			"merged",
			"still stored as Iyye's words",
		);
		const cited = mergeFact(
			db,
			fact(db, {
				id: "f2",
				source: "iyye",
				scope: "owner",
				modality: "told_by_iyye",
				cited: "web search",
				object: "1933",
				fact_key: "bunin|other:won nobel prize in",
				p: 0.6,
			}),
			opts(),
		);
		assert.ok(Math.abs(getBelief(db, cited.beliefId!)!.p - 0.6) < 1e-9);
	});

	test("#2 correction: a later value of a single-valued key closes the old belief and keeps its history; the same day contradicts", () => {
		const db = freshDb();
		const key = "owner|lives_in";
		const berlin = mergeFact(
			db,
			fact(db, {
				id: "f1",
				source: "owner",
				scope: "owner",
				object: "Berlin",
				fact_key: key,
				valid_from: "2025-01-10",
			}),
			opts(),
		);
		const munich = mergeFact(
			db,
			fact(db, {
				id: "f2",
				source: "owner",
				scope: "owner",
				object: "a suburb of Munich",
				fact_key: key,
				valid_from: "2026-10-05",
			}),
			opts(),
		);
		assert.equal(munich.relation, "changes");
		const old = getBelief(db, berlin.beliefId!)!;
		assert.equal(old.state, "closed");
		assert.equal(old.valid_to, "2026-10-05");
		assert.ok(Math.abs(old.p - 0.9) < 1e-9, "history kept: lived in Berlin until then");
		// Another value said the same day: one of them is wrong, so the other is contradicted (not closed).
		const hamburg = mergeFact(
			db,
			fact(db, {
				id: "f3",
				source: "jacob",
				scope: "contact:jacob",
				object: "Hamburg",
				fact_key: key,
				valid_from: "2026-10-05",
			}),
			opts(),
		);
		// Plan 0.013 decision 1: for the same date the later-said value holds, and the disagreement stays visible.
		assert.equal(hamburg.relation, "changes");
		assert.deepEqual(
			hamburg.touched.map((t) => t.how),
			["contradicts", "changes"],
		);
		assert.ok(getBelief(db, munich.beliefId!)!.p < 0.9);
		assert.deepEqual(
			conflictsOf(db, getBelief(db, hamburg.beliefId!)!).map((c) => c.belief.object),
			["a suburb of Munich"],
		);
		// A negation contradicts the same value.
		const k2 = "contact:julia|likes";
		const likes = mergeFact(
			db,
			fact(db, { id: "f4", source: "julia", scope: "contact:julia", object: "jazz", fact_key: k2, p: 0.85 }),
			opts(),
		);
		mergeFact(
			db,
			fact(db, { id: "f5", source: "owner", scope: "owner", object: "jazz", negated: 1, fact_key: k2 }),
			opts(),
		);
		assert.ok(getBelief(db, likes.beliefId!)!.p < 0.5);
	});

	test("F0 replay: a more or less specific value corroborates; a comparison never replaces or contradicts a value", () => {
		const db = freshDb();
		const nv = mergeFact(
			db,
			fact(db, {
				id: "f1",
				source: "owner",
				scope: "owner",
				object: "Nvidia Germany",
				fact_key: "owner|works_at",
				valid_from: "2026-10-05",
			}),
			opts(),
		);
		const again = mergeFact(
			db,
			fact(db, {
				id: "f2",
				source: "jacob",
				scope: "contact:jacob",
				object: "Nvidia",
				fact_key: "owner|works_at",
				valid_from: "2026-10-06",
			}),
			opts(),
		);
		assert.equal(again.relation, "corroborates");
		assert.equal(again.beliefId, nv.beliefId);
		const age = mergeFact(
			db,
			fact(db, {
				id: "f3",
				source: "owner",
				scope: "owner",
				object: "12",
				fact_key: "contact:jacob|age",
				valid_from: "2026-10-03",
			}),
			opts(),
		);
		const older = mergeFact(
			db,
			fact(db, {
				id: "f4",
				source: "jacob",
				scope: "contact:jacob",
				object: "older than 10",
				fact_key: "contact:jacob|age",
				valid_from: "2026-10-04",
			}),
			opts(),
		);
		assert.deepEqual(older.touched, []);
		assert.equal(getBelief(db, age.beliefId!)!.state, "current");
		assert.ok(Math.abs(getBelief(db, age.beliefId!)!.p - 0.9) < 1e-9);
	});

	test("F0 replay: a comparison the model left out of the value is kept in the details and replaces nothing", () => {
		const db = freshDb();
		const [older] = processFacts(
			[{ subject: "I", predicate: "age", object: "10", quote: "Im older than 10" }],
			doc("No Im older than 10", { speaker: "Jacob", speakerId: "jacob" }),
			knownPeople(db),
		).kept;
		assert.equal(older!.details, 'said as "Im older than 10"');
		const age = mergeFact(
			db,
			fact(db, {
				id: "f1",
				source: "owner",
				scope: "owner",
				object: "12",
				fact_key: "contact:jacob|age",
				valid_from: "2026-10-03",
			}),
			opts(),
		);
		const r = mergeFact(
			db,
			fact(db, {
				id: "f2",
				source: "jacob",
				scope: "contact:jacob",
				object: "10",
				details: older!.details,
				fact_key: "contact:jacob|age",
				valid_from: "2026-10-04",
			}),
			opts(),
		);
		assert.deepEqual(r.touched, []);
		assert.equal(getBelief(db, age.beliefId!)!.state, "current");
	});

	test("the nightly cap: one night moves an existing belief by at most maxStep in log-odds", () => {
		const db = freshDb();
		const key = "contact:jacob|studies";
		const b = mergeFact(
			db,
			fact(db, { id: "f0", source: "owner", scope: "owner", object: "7th grade", fact_key: key, p: 0.6 }),
			opts("n0"),
		);
		for (const [i, src] of ["jacob", "julia"].entries())
			mergeFact(
				db,
				fact(db, {
					id: `f${i + 1}`,
					source: src,
					scope: `contact:${src}`,
					object: "7th grade",
					fact_key: key,
					p: 0.9,
				}),
				opts("n1"),
			);
		const ev = evidenceOf(db, b.beliefId!);
		const night = ev
			.filter((e) => e.night === "n1")
			.reduce((x, e) => x + e.weight * Math.log(e.source_p / (1 - e.source_p)), 0);
		assert.ok(night <= 2 + 1e-9, String(night));
		assert.equal(getBelief(db, b.beliefId!)!.p, foldP(ev));
	});

	test("#15 forgetting: a person's evidence leaves every belief, beliefs about them go, nothing returns through a merge", () => {
		const db = freshDb();
		const shared = mergeFact(
			db,
			fact(db, { id: "f1", source: "owner", scope: "owner", object: "Nvidia", fact_key: "owner|works_at" }),
			opts(),
		);
		mergeFact(
			db,
			fact(db, { id: "f2", source: "jacob", scope: "contact:jacob", object: "Nvidia", fact_key: "owner|works_at" }),
			opts(),
		);
		const aboutJacob = mergeFact(
			db,
			fact(db, { id: "f3", source: "owner", scope: "owner", object: "12", fact_key: "contact:jacob|age" }),
			opts(),
		);
		const onlyJacob = mergeFact(
			db,
			fact(db, {
				id: "f4",
				source: "jacob",
				scope: "contact:jacob",
				object: "Innsbruck airport",
				fact_key: "contact:jacob|other:builds",
			}),
			opts(),
		);
		fact(db, {
			id: "f5",
			source: "jacob",
			scope: "contact:jacob",
			object: "a secret",
			fact_key: "contact:jacob|has",
		}); // not merged yet
		const target = forgetTarget(db, getContact(db, "jacob")!);
		assert.ok(typeof target !== "string");
		forgetRecords(db, target, "owner_web", new Date(T0.getTime() + DAY).toISOString());
		assert.ok(Math.abs(getBelief(db, shared.beliefId!)!.p - 0.9) < 1e-9, "only the owner's evidence is left");
		assert.equal(getBelief(db, aboutJacob.beliefId!), null);
		assert.equal(getBelief(db, onlyJacob.beliefId!), null);
		assert.equal(
			(
				db
					.prepare("SELECT count(*) AS n FROM stm_facts WHERE source = 'jacob' OR subject_ref = 'contact:jacob'")
					.get() as { n: number }
			).n,
			0,
		);
		assert.equal(
			(db.prepare("SELECT count(*) AS n FROM belief_evidence WHERE source = 'jacob'").get() as { n: number }).n,
			0,
		);
	});

	describe("the night and the owner's commands", () => {
		const ltm = new FakeLtm();
		const kev = new FakeKev();
		before(async () => {
			await ltm.start();
			await kev.start();
		});
		after(async () => {
			await ltm.stop();
			await kev.stop();
		});
		beforeEach(() => {
			ltm.reset();
			kev.requests.length = 0;
			kev.checkpointInfo = CHECKPOINT;
			kev.up = true;
		});
		const gate = {
			run: async <T>(_label: string, fn: (model: string) => Promise<T>) => ({
				ok: true as const,
				value: await fn("memory-model"),
			}),
		};

		test("the night extracts what the day left, merges, and stores each fact verbatim in its source's bank", async () => {
			const db = freshDb();
			turn(db, { id: "e1", who: "julia", text: "I work in sales operations at a robotics company." });
			const model = scripted({
				"sales operations": [
					line({
						subject: "I",
						predicate: "works_as",
						object: "sales operations specialist",
						quote: "I work in sales operations",
					}),
				],
			});
			const n = new FactNight({
				db,
				ltm: ltm.client(),
				gate,
				complete: model,
				log: silentLogger,
				extract: true,
				merge: true,
				maxStep: 2,
				now: () => T0,
				newId,
			});
			const out = await n.run(() => false);
			assert.deepEqual(out, { extracted: 1, merged: 1, stored: 1, stopped: null });
			const stored = [...ltm.docs.values()].find((d) => d.id.startsWith("fact:"))!;
			assert.equal(stored.bank, "iyye-contact-julia");
			assert.equal(stored.content, "Julia works as sales operations specialist [stated by Julia, 2026-10-07]");
			assert.ok(stored.tags.includes(STRUCTURED_TAG) && stored.tags.includes("speaker:person"));
			assert.equal(stored.strategy, "iyye-verbatim");
			assert.equal(searchBeliefs(db, "sales").length, 1);
			// Long-term memory down: the fact is merged and its storage is retried next night.
			turn(db, { id: "e2", who: "owner", text: "Jacob is 12 years old.", at: new Date(T0.getTime() + 1000) });
			const m2 = scripted({
				"Jacob is 12": [line({ subject: "Jacob", predicate: "age", object: "12", quote: "Jacob is 12 years old" })],
			});
			ltm.down = true;
			const n2 = new FactNight({
				db,
				ltm: ltm.client(),
				gate,
				complete: m2,
				log: silentLogger,
				extract: true,
				merge: true,
				maxStep: 2,
				now: () => T0,
				newId,
			});
			assert.match((await n2.run(() => false)).stopped ?? "", /unreachable/);
			ltm.down = false;
			assert.equal((await n2.run(() => false)).stored, 1);
		});

		test("the night runs the fact ledger first; if it cannot finish, the night stops there and says why", async () => {
			const db = freshDb();
			turn(db, { id: "e1", who: "owner", text: "Remember the dentist on Monday." });
			const calls: string[] = [];
			const night = new NightWork({
				db,
				ltm: ltm.client(),
				gate: { ...gate, problem: null } as never,
				log: silentLogger,
				facts: {
					run: async () => {
						calls.push("facts");
						return { stopped: "long-term memory is unreachable: down", merged: 0, stored: 0 };
					},
				},
			});
			const out = await night.run(() => false);
			assert.deepEqual(calls, ["facts"]);
			assert.equal(out.kind, "blocked");
			assert.equal(
				(db.prepare("SELECT state FROM stm_episodes").get() as { state: string }).state,
				"day",
				"nothing transferred",
			);
		});

		test("a fact that breaks the merge is left out; a ledger that throws never stops the episodes' transfer", async () => {
			const db = freshDb();
			db.exec(
				"CREATE TRIGGER boom BEFORE INSERT ON beliefs WHEN NEW.object = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
			);
			fact(db, { id: "f1", source: "owner", scope: "owner", object: "boom", fact_key: "owner|likes" });
			fact(db, {
				id: "f2",
				source: "owner",
				scope: "owner",
				object: "jazz",
				fact_key: "owner|likes",
				said_at: new Date(T0.getTime() + 1).toISOString(),
			});
			const n = new FactNight({
				db,
				ltm: ltm.client(),
				gate,
				complete: scripted({}),
				log: silentLogger,
				extract: false,
				merge: true,
				maxStep: 2,
				now: () => T0,
				newId,
			});
			const out = await n.run(() => false);
			assert.equal(out.merged, 1);
			assert.deepEqual(
				(db.prepare("SELECT id, state FROM stm_facts ORDER BY id").all() as { id: string; state: string }[]).map(
					(r) => [r.id, r.state],
				),
				[
					["f1", "dropped"],
					["f2", "merged"],
				],
			);
			turn(db, { id: "e1", who: "owner", text: "My dentist is Dr. Weber." });
			const night = new NightWork({
				db,
				ltm: ltm.client(),
				gate: { ...gate, problem: null } as never,
				log: silentLogger,
				facts: {
					run: async () => {
						throw new Error("a bug in the ledger");
					},
				},
			});
			assert.equal((await night.run(() => false)).kind, "done");
			assert.equal(
				(db.prepare("SELECT state FROM stm_episodes WHERE event_id = 'e1'").get() as { state: string }).state,
				"completed",
			);
		});

		test("#15: a /forget that lands during the night: the person's facts are neither merged nor stored, their bank not re-created", async () => {
			const db = freshDb();
			turn(db, { id: "e1", who: "jacob", text: "I fence foil.", at: T0 });
			turn(db, { id: "e2", who: "owner", text: "Julia plays the violin.", at: new Date(T0.getTime() + 1000) });
			fact(db, {
				id: "fj",
				event_id: "e1",
				source: "jacob",
				scope: "contact:jacob",
				object: "foil fencing",
				fact_key: "contact:jacob|practises",
				said_at: T0.toISOString(),
			});
			fact(db, {
				id: "fo",
				event_id: "e2",
				source: "owner",
				scope: "owner",
				object: "the violin",
				fact_key: "julia|plays",
				said_at: new Date(T0.getTime() + 1000).toISOString(),
			});
			let forgotten = false;
			// The owner forgets Jacob while the night looks up the first fact's neighbours (before its merge).
			const client = ltm.client();
			const hooked = {
				ensureBank: client.ensureBank.bind(client),
				retain: client.retain.bind(client),
				deleteDocument: client.deleteDocument.bind(client),
				recall: async (...a: Parameters<typeof client.recall>) => {
					if (!forgotten) {
						forgotten = true;
						const t = forgetTarget(db, getContact(db, "jacob")!);
						assert.ok(typeof t !== "string");
						forgetRecords(db, t, "owner_web", new Date(T0.getTime() + 5000).toISOString());
					}
					return client.recall(...a).catch(() => []);
				},
			};
			const relation = { ask: async () => null };
			const out = await new FactNight({
				db,
				ltm: hooked,
				gate,
				complete: scripted({}),
				log: silentLogger,
				extract: false,
				merge: true,
				maxStep: 2,
				now: () => T0,
				newId,
				relation,
			}).run(() => false);
			assert.ok(forgotten);
			assert.equal(out.merged, 1);
			assert.equal(
				(db.prepare("SELECT count(*) AS n FROM belief_evidence WHERE source = 'jacob'").get() as { n: number }).n,
				0,
			);
			assert.ok(!ltm.banks.has("iyye-contact-jacob"), "their bank is not re-created");
			assert.ok(![...ltm.docs.values()].some((d) => d.bank === "iyye-contact-jacob"));
		});

		test("F3 shadow: the relation role is asked about the nearest stored belief of another key, and never changes the merge", async () => {
			const run = async (withRole: boolean) => {
				const db = freshDb();
				ltm.reset();
				turn(db, { id: "e1", who: "julia", text: "I play the violin." });
				const m1 = scripted({
					"play the violin": [
						line({ subject: "I", predicate: "plays", object: "the violin", quote: "I play the violin" }),
					],
				});
				await new FactNight({
					db,
					ltm: ltm.client(),
					gate,
					complete: m1,
					log: silentLogger,
					extract: true,
					merge: true,
					maxStep: 2,
					now: () => T0,
					newId,
				}).run(() => false);
				turn(db, { id: "e2", who: "julia", text: "I take violin lessons now.", at: new Date(T0.getTime() + DAY) });
				const m2 = scripted({
					"violin lessons": [
						line({
							subject: "I",
							predicate: "studies",
							object: "violin lessons",
							quote: "I take violin lessons",
						}),
					],
				});
				const client = new DecisionClient({ db, service: kev.service });
				const relation = withRole
					? new FactRelation({ db, client, device: new DeviceSlot(), log: silentLogger })
					: null;
				await new FactNight({
					db,
					ltm: ltm.client(),
					gate,
					complete: m2,
					log: silentLogger,
					extract: true,
					merge: true,
					maxStep: 2,
					now: () => new Date(T0.getTime() + DAY),
					newId,
					relation,
				}).run(() => false);
				const beliefs = (
					db.prepare("SELECT fact_key, object, p, state FROM beliefs ORDER BY fact_key").all() as Record<
						string,
						unknown
					>[]
				).map((b) => JSON.stringify(b));
				return { db, beliefs };
			};
			kev.answer = () => 0.95; // an overconfident "same fact"
			const shadow = await run(true);
			const plain = await run(false);
			assert.deepEqual(shadow.beliefs, plain.beliefs, "the merge is the same with or without the role");
			const d = shadow.db.prepare("SELECT * FROM decisions WHERE role = ?").all(FACT_RELATION.name) as {
				mode: string;
				status: string;
				state_json: string;
			}[];
			assert.equal(d.length, 1);
			assert.equal(d[0]!.mode, "shadow");
			assert.match(d[0]!.state_json, /Julia studies violin lessons.*Julia plays the violin/);
		});

		test("#2, #18: /facts correct adds the owner's value and labels the pair; /facts wrong deletes, and the same evidence cannot bring it back", async () => {
			const db = freshDb();
			const key = "contact:jacob|age";
			const b = mergeFact(
				db,
				fact(db, { id: "f1", source: "jacob", scope: "contact:jacob", object: "11", fact_key: key, p: 0.85 }),
				opts(),
			);
			const client = new DecisionClient({ db, service: kev.service });
			const relation = new FactRelation({ db, client, device: new DeviceSlot(), log: silentLogger });
			const cmd = new FactsCommand({
				db,
				log: silentLogger,
				ltm: ltm.client(),
				extractorStatus: () => "idle",
				relation,
				now: () => T0,
				newId,
			});
			const reply = await cmd.command(["correct", b.beliefId!.slice(0, 8), "12"], "owner_web");
			assert.match(reply, /noted: jacob's age is 12 \(p 0\.90\), from today; the old value is closed/);
			await waitFor(
				() =>
					Boolean(
						db
							.prepare("SELECT 1 FROM decisions WHERE role = ? AND outcome_json IS NOT NULL")
							.get(FACT_RELATION.name),
					),
				5000,
			);
			const label = db
				.prepare("SELECT outcome_json, label_strength FROM decisions WHERE role = ?")
				.get(FACT_RELATION.name) as {
				outcome_json: string;
				label_strength: string;
			};
			assert.equal(label.label_strength, "owner");
			assert.deepEqual(JSON.parse(label.outcome_json), { same_fact: false, contradicts: true, refines: false });
			// Wrong: the corrected belief goes outright; Jacob's earlier statement of it cannot re-create it.
			const twelve = searchBeliefs(db, "jacob age").find((x) => x.object === "12")!;
			ltm.docs.set("iyye-owner/fact:x", {
				bank: "iyye-owner",
				id: "fact:x",
				content: "",
				context: "",
				timestamp: "",
				tags: [],
				metadata: {},
				strategy: null,
				units: 1,
			});
			assert.match(await cmd.command(["wrong", twelve.id.slice(0, 8)], "owner_web"), /deleted/);
			assert.equal(getBelief(db, twelve.id), null);
			const again = mergeFact(
				db,
				fact(db, {
					id: "f2",
					source: "jacob",
					scope: "contact:jacob",
					object: "12",
					fact_key: key,
					said_at: T0.toISOString(),
				}),
				opts("n2"),
			);
			assert.equal(again.relation, "suppressed");
			const later = mergeFact(
				db,
				fact(db, {
					id: "f3",
					source: "julia",
					scope: "contact:julia",
					object: "12",
					fact_key: key,
					said_at: new Date(T0.getTime() + DAY).toISOString(),
				}),
				opts("n3"),
			);
			// New, independent evidence may raise it again: a new belief, and (said later the same date) it holds now.
			assert.equal(later.relation, "changes");
			assert.notEqual(later.beliefId, twelve.id);
			assert.equal(getBelief(db, b.beliefId!)!.state, "closed");
			assert.match(await cmd.command(["jacob"], "owner_web"), /jacob's age is 12/);
		});
	});
});
