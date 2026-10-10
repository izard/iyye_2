// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.013 E6: one fixed scenario across disclosure, date ranges,
 * correction, complete versus failed extraction, citations, independent
 * sources and forgetting, checked after every step by the same integrity
 * figures `/facts report` shows. Plan 0.009 (character) and Stage 4
 * (decision learning) start only while this passes. E5: `/facts why`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { currentOf, getBelief, mergeFact } from "../src/facts/beliefs.ts";
import { FactsCommand } from "../src/facts/commands.ts";
import { type BeliefReader, visibleEvidence } from "../src/facts/disclosure.ts";
import { factsIntegrity, recordExtractionFailure, type StmFact } from "../src/facts/store.ts";
import { silentLogger } from "../src/log.ts";
import { MemoryControl } from "../src/memory/control.ts";
import { getContact } from "../src/state/contacts.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { recordToolCall } from "../src/state/tool-calls.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
let n = 0;
const newId = () => `${String(++n).padStart(6, "0")}-${crypto.randomUUID().slice(0, 8)}`;

function contacts(db: Db): void {
	for (const [id, name, trusted] of [
		["julia", "Julia", 1],
		["jacob", "Jacob", 0],
	] as const)
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at, trusted) VALUES (?, ?, 'contact', 't', ?)",
		).run(id, name, trusted);
}

function say(db: Db, o: Partial<StmFact> & { object: string; valid_from: string }) {
	const f = {
		id: newId(),
		doc_id: "d",
		event_id: newId(),
		scope: "contact:julia",
		modality: "stated",
		source: "julia",
		subject: "Julia",
		subject_ref: "contact:julia",
		predicate: "lives_in",
		details: null,
		time_frame: "permanent",
		hedged: 0,
		negated: 0,
		quote: "q",
		cited: null,
		fact_key: "contact:julia|lives_in",
		p: 0.85,
		said_at: `${o.valid_from}T10:00:00.000Z`,
		created_at: NOW.toISOString(),
		state: "day",
		merged_at: null,
		belief_id: null,
		private: 0,
		tool_call_id: null,
		...o,
	} as StmFact & { tool_call_id: string | null };
	db.prepare(
		`INSERT INTO stm_facts (id, doc_id, event_id, scope, modality, source, subject, subject_ref, predicate, object, details, valid_from,
			time_frame, hedged, negated, quote, cited, fact_key, p, said_at, created_at, private, tool_call_id)
		 VALUES (@id, @doc_id, @event_id, @scope, @modality, @source, @subject, @subject_ref, @predicate, @object, @details, @valid_from,
			@time_frame, @hedged, @negated, @quote, @cited, @fact_key, @p, @said_at, @created_at, @private, @tool_call_id)`,
	).run(f);
	return mergeFact(db, f, { night: newId(), maxStep: 9, now: NOW, newId });
}

test("the integrity gate: one fixed scenario, every figure checked after every step", async () => {
	const db = openDb(":memory:");
	contacts(db);
	const gate = () => {
		const i = factsIntegrity(db);
		assert.equal(i.keysWithTwoCurrent, 0, "never two current values");
		assert.equal(i.relays.citedUntraced, 0, "never a citation without a traced result");
		return i;
	};
	const cmd = new FactsCommand({
		db,
		log: silentLogger,
		ltm: null,
		extractorStatus: () => "idle",
		now: () => NOW,
		newId,
	});
	const lives = "contact:julia|lives_in";

	// 1. Date ranges: Berlin, Munich, Berlin again; Jacob says Hamburg for the same day as the return.
	say(db, { object: "Berlin", valid_from: "2026-01-01" });
	say(db, { object: "Munich", valid_from: "2026-05-01" });
	say(db, { object: "Berlin", valid_from: "2026-09-01", said_at: "2026-09-01T18:00:00.000Z" });
	say(db, { object: "Hamburg", valid_from: "2026-09-01", source: "jacob", scope: "contact:jacob" });
	assert.equal(currentOf(db, lives)?.object, "Berlin");
	assert.equal(gate().conflicts, 1);

	// 2. An owner correction to Munich: it holds from today; Berlin keeps both its ranges.
	const berlin = currentOf(db, lives)!;
	assert.match(
		await cmd.command(["correct", berlin.id.slice(0, 8), "Munich"], "owner_web"),
		/^noted: .*Munich.*from today/,
	);
	assert.equal(currentOf(db, lives)?.object, "Munich");
	gate();

	// 3. Citations: one traced to this turn's search, one Iyye merely said.
	recordToolCall(db, {
		id: "call-1",
		scope: "owner",
		principal: "owner",
		tool: "web_search",
		toolkit: "web",
		args_json: "{}",
		outcome: "ok",
		result: "Bunin was awarded the Nobel Prize in 1933.",
		started_at: NOW.toISOString(),
		finished_at: NOW.toISOString(),
		event_id: "ev-1",
		result_hash: "abc123",
	});
	const relay = {
		scope: "owner",
		modality: "told_by_iyye",
		source: "iyye",
		subject: "Bunin",
		subject_ref: "bunin",
		predicate: "other: won",
		fact_key: "bunin|other:won",
	};
	const cited = say(db, {
		...relay,
		object: "the Nobel Prize in 1933",
		valid_from: "2026-10-10",
		cited: "web_search result call-1",
		tool_call_id: "call-1",
		p: 0.6,
	} as never);
	assert.ok(cited.beliefId);
	const uncited = say(db, {
		...relay,
		object: "a medal",
		fact_key: "bunin|other:got",
		valid_from: "2026-10-10",
		p: 0.4,
	} as never);
	assert.equal(uncited.beliefId, null, "Iyye's uncited words create no belief");
	// Independence: the same cited claim again adds nothing.
	const p0 = getBelief(db, cited.beliefId!)!.p;
	say(db, {
		...relay,
		object: "the Nobel Prize in 1933",
		valid_from: "2026-10-10",
		cited: "web_search result call-1",
		tool_call_id: "call-1",
		p: 0.6,
	} as never);
	assert.equal(getBelief(db, cited.beliefId!)!.p, p0);
	assert.deepEqual(gate().relays, { cited: 2, uncited: 1, citedUntraced: 0 });

	// 4. Why: the chain from the belief to the search result.
	const why = await cmd.command(["why", cited.beliefId!.slice(0, 8)], "owner_web");
	assert.match(
		why,
		/cited: web_search at 2026-10-10 12:00, result abc123: "Bunin was awarded the Nobel Prize in 1933\."/,
	);
	assert.match(why, /Traced means where a claim came from, not that it is true\./);

	// 5. Disclosure: Julia's private address reaches Julia, never Jacob, trusted or not.
	const addr = say(db, {
		object: "Hauptstraße 12",
		valid_from: "2026-10-01",
		predicate: "has",
		fact_key: "contact:julia|has",
		private: 1,
	});
	const reader = (personId: string, trusted: boolean): BeliefReader => ({
		principal: "contact",
		personId,
		ownScopes: [`contact:${personId}`],
		trusted,
	});
	const address = getBelief(db, addr.beliefId!)!;
	assert.ok(visibleEvidence(db, address, reader("julia", true)));
	assert.equal(visibleEvidence(db, address, reader("jacob", false)), null);
	assert.equal(visibleEvidence(db, address, reader("jacob", true)), null);

	// 6. Extraction: a failed attempt is retried, three are given up; neither is an empty success.
	const doc = {
		docId: "x:said",
		episode: { event_id: "x", scope: "contact:jacob" },
		doc: { kind: "person" },
	} as never;
	recordExtractionFailure(db, doc, "m", "the answer was cut off at 1200 tokens", NOW.toISOString());
	assert.deepEqual(gate().documents, { done: 0, failed: 1, givenUp: 0, skipped: 0 });
	recordExtractionFailure(db, doc, "m", "no answer text", NOW.toISOString());
	recordExtractionFailure(db, doc, "m", "no answer text", NOW.toISOString());
	assert.deepEqual(gate().documents, { done: 0, failed: 0, givenUp: 1, skipped: 0 });

	// 7. Forgetting Jacob: his evidence leaves, the ranges are rebuilt, the conflict is gone; a retry changes nothing.
	const control = new MemoryControl({
		db,
		ltm: null,
		log: silentLogger,
		mode: () => "awake",
		forgetConversations: async () => 0,
	});
	await control.forget(getContact(db, "jacob")!, "owner_web");
	const after = JSON.stringify(db.prepare("SELECT * FROM belief_intervals ORDER BY belief_id, seq").all());
	assert.ok(!db.prepare("SELECT 1 FROM beliefs WHERE object = 'Hamburg'").get());
	assert.equal(gate().conflicts, 0);
	await control.forget(getContact(db, "jacob")!, "owner_web");
	assert.equal(JSON.stringify(db.prepare("SELECT * FROM belief_intervals ORDER BY belief_id, seq").all()), after);
	assert.equal(currentOf(db, lives)?.object, "Munich");

	// The owner's report shows the same figures.
	assert.match(
		await cmd.command(["report"], "owner_web"),
		/keys with two current values: 0\n?$|keys with two current values: 0/,
	);
});
