// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Regressions from the 2026-10-10 code review: a private belief shown to an
 * untrusted reader, a value said again after it was replaced, a truncated or
 * malformed extraction taken as complete, figures matched inside other
 * figures, and a contact prompt that contradicted the disclosure rule.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { correctBelief, getBelief, mergeFact } from "../src/facts/beliefs.ts";
import { type BeliefReader, visibleEvidence } from "../src/facts/disclosure.ts";
import { parseFacts } from "../src/facts/extract.ts";
import { extractOne, routerComplete } from "../src/facts/extractor.ts";
import { docsFor, type FactDoc, type StmFact } from "../src/facts/store.ts";
import { composeSystemPrompt } from "../src/integration/pi/prompt.ts";
import { checkCitations } from "../src/observe/citations.ts";
import { type Db, openDb } from "../src/state/db.ts";
import type { StmEpisode } from "../src/state/stm.ts";
import { recordToolCall } from "../src/state/tool-calls.ts";

const T0 = new Date("2026-10-05T10:00:00Z");
let n = 0;
const newId = () => `id-${++n}`;

function fact(db: Db, o: Partial<StmFact> & { object: string; valid_from: string }): StmFact {
	const f = {
		id: newId(),
		doc_id: "d",
		event_id: "e",
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
	return f;
}
const merge = (db: Db, f: StmFact) => mergeFact(db, f, { night: f.valid_from, maxStep: 9, now: T0, newId });
const current = (db: Db) =>
	(
		db
			.prepare("SELECT object FROM beliefs WHERE fact_key = 'contact:julia|lives_in' AND state = 'current'")
			.all() as {
			object: string;
		}[]
	).map((r) => r.object);

describe("beliefs", () => {
	test("a private belief reaches only its speakers, trusted reader or not", () => {
		const db = openDb(":memory:");
		const b = merge(db, fact(db, { object: "Hauptstraße 12", valid_from: "2026-10-01", private: 1 })).beliefId!;
		// A cited relay in someone's conversation supports it too: personless evidence, which an untrusted
		// reader used to be shown (a trusted one was not).
		db.prepare(
			`INSERT INTO belief_evidence (id, belief_id, source, scope, modality, sign, source_p, weight, relation, night, at)
			 VALUES ('relay-1', ?, 'iyye', 'owner', 'told_by_iyye', 1, 0.6, 1, 'corroborates', 'n', ?)`,
		).run(b, T0.toISOString());
		const belief = getBelief(db, b)!;
		const r = (personId: string, trusted: boolean): BeliefReader => ({
			principal: "contact",
			personId,
			ownScopes: [`contact:${personId}`],
			trusted,
		});
		assert.equal(visibleEvidence(db, belief, r("jacob", false)), null, "untrusted outsider");
		assert.equal(visibleEvidence(db, belief, r("jacob", true)), null, "trusted outsider");
		assert.deepEqual(
			visibleEvidence(db, belief, r("julia", false))!.map((e) => e.source),
			["julia"],
			"the speaker sees her own words",
		);
	});

	test("a value said again after it was replaced is current again, and what replaced it is closed", () => {
		const db = openDb(":memory:");
		merge(db, fact(db, { object: "Berlin", valid_from: "2026-01-01" }));
		merge(db, fact(db, { object: "Munich", valid_from: "2026-05-01" }));
		assert.deepEqual(current(db), ["Munich"]);
		const back = merge(db, fact(db, { object: "Berlin", valid_from: "2026-09-01" }));
		assert.equal(back.relation, "changes");
		assert.deepEqual(current(db), ["Berlin"]);
		const munich = db.prepare("SELECT state, valid_to FROM beliefs WHERE object = 'Munich'").get();
		assert.deepEqual(munich, { state: "closed", valid_to: "2026-09-01" });
		// Something said about the past (before the change) only adds history to the closed value.
		merge(db, fact(db, { object: "Munich", valid_from: "2026-06-01" }));
		assert.deepEqual(current(db), ["Berlin"]);
		// Iyye's own word never moves it back.
		merge(db, fact(db, { object: "Munich", valid_from: "2026-10-02", modality: "told_by_iyye", source: "iyye" }));
		assert.deepEqual(current(db), ["Berlin"]);
	});

	test("a late report of an earlier value is history: it never makes a second current value", () => {
		const db = openDb(":memory:");
		merge(db, fact(db, { object: "Berlin", valid_from: "2026-01-01" }));
		merge(db, fact(db, { object: "Munich", valid_from: "2026-05-01" }));
		merge(db, fact(db, { object: "Paris", valid_from: "2026-09-01" }));
		const late = merge(db, fact(db, { object: "Berlin", valid_from: "2026-07-01" }));
		assert.equal(late.relation, "corroborates");
		assert.deepEqual(current(db), ["Paris"]);
	});

	test("an owner correction to a value that was replaced before makes it current", () => {
		const db = openDb(":memory:");
		merge(db, fact(db, { object: "Berlin", valid_from: "2026-01-01" }));
		const munich = merge(db, fact(db, { object: "Munich", valid_from: "2026-05-01" })).beliefId!;
		const r = correctBelief(db, munich, "Berlin", { night: "c", maxStep: 9, now: T0, newId });
		assert.ok(typeof r !== "string");
		assert.deepEqual(current(db), ["Berlin"]);
	});
});

describe("extraction", () => {
	const doc: FactDoc = {
		docId: "e1:said",
		episode: { event_id: "e1", scope: "owner" } as FactDoc["episode"],
		doc: {
			kind: "person",
			text: "I live in Berlin.",
			speaker: "the owner",
			speakerId: "owner",
			at: T0.toISOString(),
		},
	};
	const run = (db: Db, output: string) =>
		extractOne(db, doc, {
			complete: async () => output,
			model: "m",
			signal: new AbortController().signal,
			people: [],
			now: () => T0,
			newId,
		});

	test("text that is neither empty nor fact lines is a failed attempt; an empty reply is an empty document", async () => {
		const db = openDb(":memory:");
		await assert.rejects(
			run(db, '{"subject": "I", "predicate": "lives_in", "obj'),
			/malformed line\(s\) and no fact/,
		);
		await assert.rejects(run(db, "The owner lives in Berlin."), /not JSON lines/);
		assert.equal(await run(db, ""), 0);
	});

	test("valid fact lines are kept when another line is malformed (owner decision 2026-10-10)", async () => {
		const good =
			'{"subject": "I", "predicate": "lives_in", "object": "Berlin", "details": null, "valid_from": null, "time_frame": "permanent", "hedged": false, "negated": false, "quote": "I live in Berlin"}';
		const parsed = parseFacts(`${good}\n{"subject": "I", "pre`);
		assert.deepEqual([parsed.facts.length, parsed.bad], [1, 1]);
		// Not a failed attempt: the well-formed fact goes on to be stored (the bad line is counted).
		await assert.doesNotReject(run(openDb(":memory:"), `${good}\n{"subject": "I", "pre`));
	});

	test("only a finished answer with text counts: cut off, no answer, or another ending is an error", async () => {
		let body: unknown = {};
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const ask = () => routerComplete(url, 50)("m", "s", "u", new AbortController().signal);
		try {
			body = { choices: [{ message: { content: '{"subject": "I", "pre' }, finish_reason: "length" }] };
			await assert.rejects(ask(), /cut off at 50 tokens/);
			for (const b of [{}, { choices: [] }, { choices: [{}] }, { choices: [{ message: { content: null } }] }]) {
				body = b;
				await assert.rejects(ask(), /no answer text/, JSON.stringify(b));
			}
			body = { choices: [{ message: { content: "x" }, finish_reason: "tool_calls" }] };
			await assert.rejects(ask(), /ended with "tool_calls"/);
			// No finish marker is no proof the answer is finished, not even for an empty one.
			for (const b of [
				{ choices: [{ message: { content: "" } }] },
				{ choices: [{ message: { content: "" }, finish_reason: null }] },
			]) {
				body = b;
				await assert.rejects(ask(), /ended with null, not "stop"/, JSON.stringify(b));
			}
			body = { choices: [{ message: { content: "" }, finish_reason: "stop" }] };
			assert.equal(await ask(), "", "an intentional empty answer");
		} finally {
			server.close();
		}
	});
});

test("a reply's turn offers only its own observations and model answers; the clock never", () => {
	const db = openDb(":memory:");
	const at = (m: number) => new Date(T0.getTime() + m * 60_000).toISOString();
	const episode = (id: string, said: number) =>
		({
			event_id: id,
			kind: "turn",
			scope: "owner",
			channel: "web",
			contact_id: "owner",
			action_id: `a-${id}`,
			user_text: "q",
			reply_text: "r",
			said_at: at(said),
			answered_at: at(said + 1),
		}) as unknown as StmEpisode;
	const call = (tool: string, m: number, eventId: string) =>
		recordToolCall(db, {
			id: newId(),
			scope: "owner",
			principal: "owner",
			tool,
			toolkit: "t",
			args_json: "{}",
			outcome: "ok",
			result: `${tool} result`,
			started_at: at(m),
			finished_at: at(m),
			event_id: eventId,
		});
	call("current_time", 0, "e1");
	call("ask_thinking_model", 0, "e1");
	call("web_search", 0, "e2"); // another turn's search, in the same minute
	const tools = (e: StmEpisode) =>
		docsFor(db, e)
			.find((d) => d.doc.kind === "reply")
			?.doc.tools?.map((t) => `${t.ref} ${t.tool} ${t.observes}`);
	assert.deepEqual(tools(episode("e1", 0)), ["1 ask_thinking_model false"]);
	assert.deepEqual(tools(episode("e2", 0)), ["1 web_search true"]);
});

test("an investigation's figure is found only as a whole number", () => {
	assert.deepEqual(checkCitations("12 GB free", "Avail: 512GB").invented, ["12GB"]);
	assert.deepEqual(checkCitations("1.5% load", "cpu 11.52%").invented, ["1.5%"]);
	assert.deepEqual(checkCitations("512 GB free", "Avail: 512GB").invented, []);
	assert.deepEqual(checkCitations("56.4 GB used", "used 56.4 GB of 128").invented, []);
	// …and with its own unit: another unit is another figure.
	assert.deepEqual(checkCitations("Usage is 12GB", "Usage is 12MB").invented, ["12GB"]);
	assert.deepEqual(checkCitations("5% used", "5GB used").invented, ["5%"]);
	assert.deepEqual(checkCitations("56.4 GB used", "Used: 56.4G").invented, []);
	assert.deepEqual(checkCitations("12 GB total", "total 12, free 3").invented, []);
});

test("a trusted contact's prompt allows what recall labels with its source; an untrusted one's allows nothing", () => {
	const trusted = composeSystemPrompt("I.", {
		kind: "contact",
		displayName: "Julia",
		channel: "telegram",
		trusted: true,
	});
	assert.match(trusted, /share only what the recalled memory you are given labels with who said it, and say who/);
	assert.ok(!trusted.includes("Do not share anything about your owner or other people."));
	const untrusted = composeSystemPrompt("I.", { kind: "contact", displayName: "Max", channel: "telegram" });
	assert.match(untrusted, /Do not share anything about your owner or other people\./);
});
