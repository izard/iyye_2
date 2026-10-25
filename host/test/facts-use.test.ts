// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.011 F4 and F5: beliefs in recall with how sure Iyye is and who said
 * it; who may be told them (owner decision 1, revised 2026-10-07: trusted
 * contacts get other people's facts with provenance, private facts reach only
 * their speaker and the owner, untrusted contacts only their own and facts
 * tied to no person); curiosity from important uncertain beliefs; the
 * switch that retires Hindsight's own turn extraction.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { mergeFact } from "../src/facts/beliefs.ts";
import { FactsCommand } from "../src/facts/commands.ts";
import { type BeliefReader, beliefQuery, offerBeliefs } from "../src/facts/disclosure.ts";
import { privateReason, processFacts } from "../src/facts/extract.ts";
import type { StmFact } from "../src/facts/store.ts";
import { silentLogger } from "../src/log.ts";
import { forgetRecords, forgetTarget } from "../src/memory/forget.ts";
import { MemoryGateway } from "../src/memory/gateway.ts";
import { NightWork } from "../src/memory/night.ts";
import { collectSignals } from "../src/motivation/signals.ts";
import { MotivationTracker } from "../src/motivation/tracker.ts";
import { getContact } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { recordEpisode } from "../src/state/stm.ts";
import { FakeLtm } from "./fixtures/fake-ltm.ts";

const T0 = new Date("2026-10-07T10:00:00Z");
let seq = 0;
const newId = () => `${(++seq).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

function freshDb(): Db {
	const db = openDb(":memory:");
	for (const [id, name, trusted] of [
		["julia", "Julia", 1],
		["anna", "Anna", 1],
		["jacob", "Jacob", 0],
	] as const)
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at, trusted) VALUES (?, ?, 'contact', 't', ?)",
		).run(id, name, trusted);
	return db;
}

function fact(
	db: Db,
	o: Partial<StmFact> & { id: string; source: string; scope: string; object: string; fact_key: string },
): StmFact {
	const f = {
		doc_id: `${o.id}:said`,
		event_id: o.id,
		modality: "stated",
		subject: o.fact_key.split("|")[0]!.replace(/^contact:/, ""),
		subject_ref: o.fact_key.split("|")[0]!,
		predicate: o.fact_key.split("|")[1]!,
		details: null,
		valid_from: "2026-10-05",
		time_frame: "permanent",
		hedged: 0,
		negated: 0,
		quote: "q",
		cited: null,
		p: o.source === "owner" ? 0.9 : 0.85,
		said_at: T0.toISOString(),
		created_at: T0.toISOString(),
		state: "day",
		merged_at: null,
		belief_id: null,
		private: 0,
		...o,
	} as StmFact;
	db.prepare(
		`INSERT INTO stm_facts (id, doc_id, event_id, scope, modality, source, subject, subject_ref, predicate, object, details, valid_from,
			time_frame, hedged, negated, quote, cited, fact_key, p, said_at, created_at, private)
		 VALUES (@id, @doc_id, @event_id, @scope, @modality, @source, @subject, @subject_ref, @predicate, @object, @details, @valid_from,
			@time_frame, @hedged, @negated, @quote, @cited, @fact_key, @p, @said_at, @created_at, @private)`,
	).run(f);
	return mergeFact(db, f, { night: "n1", maxStep: 2, now: T0, newId }).beliefId ? f : f;
}

const reader = (personId: string, trusted: boolean): BeliefReader =>
	personId === "owner"
		? { principal: "owner", personId: "owner", ownScopes: ["owner"], trusted: true }
		: { principal: "contact", personId, ownScopes: [`contact:${personId}`], trusted };
const offered = (db: Db, r: BeliefReader, q: string) =>
	offerBeliefs(db, r, q, { minP: 0.3, limit: 10, now: new Date(T0.getTime() + 3 * 86_400_000) }).map((b) => b.text);

/** Julia's violin (shareable), Julia's dentist (health: private), the owner's home (an address: private), Jacob's own game, a cited relay. */
function world(db: Db) {
	fact(db, {
		id: "f1",
		source: "julia",
		scope: "contact:julia",
		object: "the violin",
		fact_key: "julia|plays",
		subject: "Julia",
	});
	fact(db, {
		id: "f2",
		source: "julia",
		scope: "contact:julia",
		object: "a dentist appointment on Friday",
		fact_key: "julia|has_appointment",
		subject: "Julia",
		private: 1,
	});
	fact(db, {
		id: "f3",
		source: "owner",
		scope: "owner",
		object: "a suburb of Munich",
		fact_key: "owner|lives_in",
		subject: "the owner",
		private: 1,
	});
	fact(db, {
		id: "f4",
		source: "jacob",
		scope: "contact:jacob",
		object: "Roblox Studio",
		fact_key: "jacob|plays",
		subject: "Jacob",
	});
	fact(db, {
		id: "f5",
		source: "iyye",
		scope: "owner",
		modality: "told_by_iyye",
		cited: "web search",
		object: "the Nobel Prize in 1933",
		fact_key: "bunin|other:won",
		subject: "Bunin",
		p: 0.6,
	});
	fact(db, {
		id: "f6",
		source: "probe",
		scope: "iyye",
		modality: "measured",
		object: "128 GB memory",
		fact_key: "iyye|has",
		subject: "Iyye",
		p: 0.95,
	});
}

describe("F4: who may be told what (owner decision 1, revised)", () => {
	test("private by rule: the speaker asked, credentials, health, money, addresses; other facts are shareable", () => {
		const f = (object: string, predicate = "has") => ({ subject: "Julia", predicate, object, quote: object });
		assert.equal(privateReason(f("the violin", "plays"), "I play the violin."), null);
		assert.match(privateReason(f("the violin", "plays"), "I play the violin, but don't tell Jacob.")!, /asked/);
		assert.match(privateReason(f("a new job"), "Между нами: у меня новая работа.")!, /asked/);
		assert.equal(privateReason(f("PIN 4321"), "x"), "a credential");
		assert.equal(privateReason(f("an appointment with the dentist"), "x"), "health");
		assert.equal(privateReason(f("a salary of 5000 €"), "x"), "money");
		assert.equal(privateReason(f("Munich", "lives_in"), "x"), "an address");
		assert.equal(privateReason(f("Hauptstraße 12"), "x"), "an address");
		assert.equal(privateReason(f("Am Lindenweg 7"), "x"), "an address");
		assert.equal(privateReason(f("Wegner's book"), "x"), null);
		// Set at extraction, carried into the belief's evidence.
		const [kept] = processFacts(
			[{ subject: "I", predicate: "plays", object: "the violin", quote: "I play the violin" }],
			{
				kind: "person",
				text: "I play the violin, but don't tell Jacob.",
				speaker: "Julia",
				speakerId: "julia",
				at: T0.toISOString(),
			},
			[{ id: "julia", name: "Julia" }],
		).kept;
		assert.match(kept!.private ?? "", /asked/);
	});

	test("the owner sees everything; a trusted contact gets others' shareable facts with provenance; private ones never", () => {
		const db = freshDb();
		world(db);
		const owner = offered(db, reader("owner", true), "Julia violin dentist plays lives Munich Roblox Bunin memory");
		assert.equal(owner.length, 6);
		assert.ok(owner.some((t) => /Julia said · 3 days ago\] Julia plays the violin/.test(t)));
		const anna = offered(db, reader("anna", true), "Julia violin dentist lives Munich Roblox Bunin memory");
		assert.deepEqual(anna.sort(), [
			"[possibly 0.60 · Iyye relayed a source · 3 days ago] Bunin won the Nobel Prize in 1933",
			"[very likely 0.85 · Jacob said · 3 days ago] Jacob plays Roblox Studio",
			"[very likely 0.85 · Julia said · 3 days ago] Julia plays the violin",
		]);
		// Julia's own private fact reaches Julia; the owner's address does not.
		const julia = offered(db, reader("julia", true), "dentist Munich");
		assert.deepEqual(julia, [
			"[very likely 0.85 · you said · 3 days ago] Julia has an appointment: a dentist appointment on Friday",
		]);
	});

	test("an untrusted contact gets only what it said itself and facts tied to no person; Iyye's own records stay the owner's", () => {
		const db = freshDb();
		world(db);
		const jacob = offered(db, reader("jacob", false), "Julia violin Roblox Bunin memory");
		assert.deepEqual(jacob.sort(), [
			"[possibly 0.60 · Iyye relayed a source · 3 days ago] Bunin won the Nobel Prize in 1933",
			"[very likely 0.85 · you said · 3 days ago] Jacob plays Roblox Studio",
		]);
		assert.ok(!offered(db, reader("anna", true), "memory 128").some((t) => /128 GB/.test(t)));
	});

	test("the owner overrides: /facts share and /facts private; beliefs below minP are not offered", async () => {
		const db = freshDb();
		world(db);
		const cmd = new FactsCommand({
			db,
			log: silentLogger,
			ltm: null,
			extractorStatus: () => "idle",
			now: () => T0,
			newId,
		});
		const dentist = db.prepare("SELECT id FROM beliefs WHERE fact_key = 'julia|has_appointment'").get() as {
			id: string;
		};
		const violin = db.prepare("SELECT id FROM beliefs WHERE fact_key = 'julia|plays'").get() as { id: string };
		assert.match(await cmd.command(["share", dentist.id.slice(0, 8)], "owner_web"), /shareable/);
		assert.match(await cmd.command(["private", violin.id.slice(0, 8)], "owner_web"), /private/);
		const anna = offered(db, reader("anna", true), "Julia violin dentist");
		assert.deepEqual(anna, [
			"[very likely 0.85 · Julia said · 3 days ago] Julia has an appointment: a dentist appointment on Friday",
		]);
		assert.match(await cmd.command(["julia"], "owner_web"), /shareable with trusted contacts \(your choice\)/);
		db.prepare("UPDATE beliefs SET p = 0.25 WHERE id = ?").run(dentist.id);
		assert.deepEqual(offered(db, reader("anna", true), "dentist"), []);
	});

	test("#15: after /forget, nothing the person said is offered to anyone", () => {
		const db = freshDb();
		world(db);
		const t = forgetTarget(db, getContact(db, "julia")!);
		assert.ok(typeof t !== "string");
		forgetRecords(db, t, "owner_web", new Date(T0.getTime() + 86_400_000).toISOString());
		for (const r of [reader("owner", true), reader("anna", true), reader("jacob", false)])
			assert.ok(!offered(db, r, "Julia violin dentist").some((x) => /Julia/.test(x)), JSON.stringify(r));
	});

	test("an unrelated question gets no beliefs: stopwords and the rewrite's words never match", () => {
		const db = freshDb();
		world(db);
		assert.deepEqual(offered(db, reader("owner", true), "What did the user say about the weekend?"), []);
		assert.deepEqual(offered(db, reader("owner", true), "Что ты помнишь про это?"), []);
		assert.equal(beliefQuery("What did the user say about the weekend?"), '"weeke"*');
	});

	test("recall: beliefs come labelled; a stored structured fact found by Hindsight is offered as its belief, filtered", async () => {
		const db = freshDb();
		world(db);
		const ltm = new FakeLtm();
		await ltm.start();
		try {
			const c = ltm.client();
			await c.ensureBank("iyye-contact-julia", { retainMission: "m", replyMission: "r", observations: true });
			const violin = db.prepare("SELECT id FROM stm_facts WHERE id = 'f1'").get() as { id: string };
			await c.retain("iyye-contact-julia", {
				documentId: `fact:${violin.id}`,
				content: "Julia plays the violin [stated by Julia, 2026-10-07]",
				context: "c",
				timestamp: T0.toISOString(),
				tags: ["speaker:person", "structured-fact"],
				metadata: {},
			});
			const gw = new MemoryGateway({
				db,
				ltm: c,
				log: silentLogger,
				now: () => new Date(T0.getTime() + 3 * 86_400_000),
			});
			const forAnna = await gw.recall(
				{ scope: "contact:anna", principal: "contact" },
				"Does Julia play an instrument?",
			);
			assert.ok(
				forAnna.items.every((i) => i.source === "belief"),
				JSON.stringify(forAnna.items),
			);
			assert.ok(
				forAnna.items.some((i) => i.text === "[very likely 0.85 · Julia said · 3 days ago] Julia plays the violin"),
			);
			assert.ok(!forAnna.items.some((i) => /dentist|Munich/.test(i.text)), "nothing private");
			const forOwner = await gw.recall({ scope: "owner", principal: "owner" }, "Does Julia play an instrument?");
			assert.ok(
				!forOwner.items.some((i) => i.source === "memory" && /structured|stated by Julia/.test(i.text)),
				"never as raw text",
			);
			assert.ok(db.prepare("SELECT recalled_at FROM beliefs WHERE fact_key = 'julia|plays'").get());
		} finally {
			await ltm.stop();
		}
	});
});

describe("F4: curiosity from important uncertain beliefs", () => {
	test("an uncertain belief about someone who matters is a signal; Iyye's own words or a stranger's subject are not", () => {
		const db = freshDb();
		fact(db, {
			id: "g1",
			source: "jacob",
			scope: "contact:jacob",
			object: "a trip to Rome",
			fact_key: "contact:julia|plans_to",
			subject: "Julia",
			p: 0.6,
		});
		fact(db, {
			id: "g2",
			source: "julia",
			scope: "contact:julia",
			object: "a cat",
			fact_key: "kevin|owns",
			subject: "Kevin",
			p: 0.6,
		});
		const sig = () =>
			collectSignals({ db, now: T0, selfGaps: () => [], healing: () => [], sleep: () => null }).filter(
				(s) => s.kind === "belief_uncertain",
			);
		// A request caught by the "other:" catch-all is never asked about as a fact (2026-10-20).
		fact(db, {
			id: "g4",
			source: "jacob",
			scope: "contact:jacob",
			object: "telegram account",
			fact_key: "contact:julia|other: try sending acknowledgement",
			subject: "Julia",
			p: 0.6,
		});
		assert.ok(
			db.prepare("SELECT p FROM beliefs WHERE predicate LIKE 'other:%' AND p BETWEEN 0.3 AND 0.7").get(),
			"it is an uncertain belief like the others",
		);
		assert.deepEqual(
			sig().map((s) => s.text),
			["unsure (p 0.60) whether Julia plans to a trip to Rome"],
		);
		// Settled by new independent evidence: out of the band, no signal.
		fact(db, {
			id: "g3",
			source: "owner",
			scope: "owner",
			object: "a trip to Rome",
			fact_key: "contact:julia|plans_to",
			subject: "Julia",
		});
		assert.equal(sig().length, 0);
	});

	test("an uncertain belief counts (0.010 M2 gave it an action): it is asked about, under its own cluster", async () => {
		const db = freshDb();
		fact(db, {
			id: "g1",
			source: "jacob",
			scope: "contact:jacob",
			object: "a trip to Rome",
			fact_key: "contact:julia|plans_to",
			subject: "Julia",
			p: 0.6,
		});
		const gaps = [
			{ facet: "place" as const, field: "stated", kind: "missing" as const, why: "no place" },
			{ facet: "social" as const, field: "relation:jacob", kind: "missing" as const, why: "who is Jacob" },
		];
		const opened: string[] = [];
		const tracker = new MotivationTracker({
			db,
			log: silentLogger,
			mode: () => "awake",
			sources: { selfGaps: () => gaps, healing: () => [], sleep: () => null },
			now: () => T0,
			alpha: 1,
			threshold: 0.55,
			sustain: 1,
			actor: {
				act: async (o) => {
					opened.push(...o.map((x) => x.signal.cluster));
				},
			},
		});
		await tracker.sweep();
		const belief = db.prepare("SELECT id FROM beliefs WHERE fact_key = 'contact:julia|plans_to'").get() as {
			id: string;
		};
		assert.ok(opened.includes(`belief:${belief.id}`), JSON.stringify(opened));
	});
});

describe("F5: the switch that retires Hindsight's own turn extraction", () => {
	const ltm = new FakeLtm();
	before(() => ltm.start());
	after(() => ltm.stop());
	beforeEach(() => ltm.reset());
	const gate = {
		run: async <T>(_l: string, fn: (m: string) => Promise<T>) => ({
			ok: true as const,
			value: await fn("m"),
			model: "m",
		}),
		problem: null,
	};

	function turn(db: Db, id: string, text: string) {
		const at = T0.toISOString();
		db.prepare(
			"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'web', 'owner', 'owner', ?, ?, 'answered')",
		).run(id, id, at, JSON.stringify({ text }));
		db.prepare(
			"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, 'ok')",
		).run(`a-${id}`, id, `k-${id}`, at);
		recordEpisode(db, getEvent(db, id)!, { id: `a-${id}`, content: "" }, at);
	}

	test("ledger: a turn leaves STM once its documents are extracted and stored; Hindsight never gets the turn itself", async () => {
		const db = freshDb();
		turn(db, "e1", "Julia plays the violin.");
		turn(db, "e2", "Jacob likes Roblox.");
		// e1 is extracted and its fact merged and stored; e2 is not extracted yet.
		db.prepare(
			"INSERT INTO fact_extractions (doc_id, event_id, scope, kind, status, at) VALUES ('e1:said', 'e1', 'owner', 'person', 'done', 't')",
		).run();
		fact(db, {
			id: "x1",
			event_id: "e1",
			source: "owner",
			scope: "owner",
			object: "the violin",
			fact_key: "julia|plays",
		});
		db.prepare("UPDATE stm_facts SET stored_at = 't' WHERE id = 'x1'").run();
		const night = new NightWork({
			db,
			ltm: ltm.client(),
			gate: gate as never,
			log: silentLogger,
			turnExtraction: "ledger",
		});
		const out = await night.run(() => false);
		assert.equal(out.kind, "done");
		const states = Object.fromEntries(
			(db.prepare("SELECT event_id, state FROM stm_episodes").all() as { event_id: string; state: string }[]).map(
				(r) => [r.event_id, r.state],
			),
		);
		assert.deepEqual(states, { e1: "completed", e2: "day" }, "e2 waits for its extraction");
		assert.deepEqual(ltm.retains, [], "no turn was retained");
	});

	test("hindsight (the default) is unchanged; ledger without the ledger's extraction and merge is refused", () => {
		assert.equal(loadConfig({}).facts.turns, "hindsight");
		assert.equal(loadConfig({ IYYE2_FACTS_TURNS: "ledger" }).facts.turns, "ledger");
		assert.throws(
			() => loadConfig({ IYYE2_FACTS_TURNS: "ledger", IYYE2_FACTS_MERGE: "0" }),
			/needs IYYE2_FACTS_EXTRACT/,
		);
	});
});
