// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * 2026-10-13: a person's message is extracted with Iyye's previous message as
 * context, so "All 4 are important, I'll add 1-3 today" can be written out as
 * the four things Iyye had listed. The quote stays the writer's own words;
 * names and figures may come from the context only for a quote that points
 * back at it; Iyye's message is never a fact by itself.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExtractionDoc, extractionInput, extractionPrompt, groundingProblem } from "../src/facts/extract.ts";
import { docsFor } from "../src/facts/store.ts";
import { openDb } from "../src/state/db.ts";
import type { StmEpisode } from "../src/state/stm.ts";

const LIST =
	"Tools I could use: 1. Execution (a sandbox), 2. Write Access, 3. Active Monitoring, 4. Visual Continuity.";
const doc: ExtractionDoc = {
	kind: "person",
	text: "All 4 are important, I'll try to add 1-3 today evening after work.",
	speaker: "the owner",
	speakerId: "owner",
	at: "2026-10-12T08:55:31.157Z",
	context: LIST,
};
const fact = (object: string, quote: string) => ({
	subject: "the owner",
	predicate: "plans_to",
	object,
	quote,
});

test("a quote that points back may take names from Iyye's previous message; any other may not", () => {
	assert.equal(
		groundingProblem(fact("add Execution, Write Access and Active Monitoring", "I'll try to add 1-3 today"), doc, []),
		null,
	);
	assert.equal(groundingProblem(fact("consider Visual Continuity", "All 4 are important"), doc, []), null);
	// No reference word in the quote: the context lends nothing.
	const plain: ExtractionDoc = { ...doc, text: "I'll work on my tools after work." };
	assert.match(
		groundingProblem(fact("add Write Access", "I'll work on my tools after work"), plain, []) ?? "",
		/the name Write is not in the source/,
	);
	// The quote itself must still be the writer's words, never the context's.
	assert.match(groundingProblem(fact("x", "Visual Continuity"), doc, []) ?? "", /quote is not in the source/);
	// Without context, as before.
	const none: ExtractionDoc = { ...doc, context: undefined };
	assert.match(groundingProblem(fact("add Write Access", "I'll try to add 1-3 today"), none, []) ?? "", /Write/);
});

test("the model sees the context labelled as such, with the rule to write references out", () => {
	const input = extractionInput(doc);
	assert.match(
		input,
		/Iyye's message just before \(context only, to resolve what the writer refers to; never a fact itself\): "Tools I could use/,
	);
	assert.ok(input.indexOf("Iyye's message just before") < input.indexOf("Text:"));
	assert.match(extractionPrompt("person"), /write out what it refers to in the object or the details/);
	assert.ok(!extractionInput({ ...doc, context: undefined }).includes("just before"));
});

test("the context is Iyye's reply delivered just before in the same conversation, within 12 hours", () => {
	const db = openDb(":memory:");
	const at = (h: number) => new Date(Date.parse("2026-10-12T08:55:00Z") + h * 3_600_000).toISOString();
	const turn = (id: string, scope: string, contact: string, reply: string, t: string) => {
		db.prepare(
			"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'telegram', ?, ?, ?, '{}', 'answered')",
		).run(id, id, contact, scope, t);
		db.prepare(
			"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, ?)",
		).run(`a-${id}`, id, `k-${id}`, t, reply);
	};
	db.prepare(
		"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('julia', 'Julia', 'contact', 't')",
	).run();
	turn("e0", "owner", "owner", "an old reply", at(-20));
	turn("e1", "owner", "owner", LIST, at(-2));
	turn("j1", "contact:julia", "julia", "Julia's reply, not this conversation's", at(-0.5));
	const episode = {
		event_id: "e2",
		kind: "turn",
		scope: "owner",
		channel: "telegram",
		contact_id: "owner",
		action_id: null,
		user_text: doc.text,
		reply_text: "",
		said_at: at(0),
		answered_at: at(0),
		state: "day",
		attempts: 0,
		last_error: null,
		transferred_at: null,
	} as StmEpisode;
	const person = docsFor(db, episode).find((d) => d.doc.kind === "person")!;
	assert.equal(person.doc.context, LIST);
	db.prepare("UPDATE actions SET created_at = ? WHERE id = 'a-e1'").run(at(-13));
	assert.equal(docsFor(db, episode).find((d) => d.doc.kind === "person")!.doc.context, undefined, "too old");
});
