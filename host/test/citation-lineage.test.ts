// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.013 E3: a reply's fact is cited only when the host resolves the
 * model's number to a successful observation of the same turn that carries
 * the fact. Another model's answer is provenance, never an observation
 * (owner decision 2). Citations stored before this are audited to uncited.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Type } from "typebox";
import { auditUntracedCitations, getBelief, mergeFact } from "../src/facts/beliefs.ts";
import { type DocTool, type ExtractionDoc, extractionInput, processFacts, type RawFact } from "../src/facts/extract.ts";
import { docsFor, type StmFact } from "../src/facts/store.ts";
import { admitOwnerWebMessage, admitTelegramUpdate } from "../src/kernel/admission.ts";
import { silentLogger } from "../src/log.ts";
import { openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import type { StmEpisode } from "../src/state/stm.ts";
import { ToolBroker } from "../src/tools/broker.ts";
import { FakeTelegram } from "./fixtures/fake-telegram.ts";
import { sandbox, waitFor } from "./model-helpers.ts";
import { startStack } from "./web-helpers.ts";

const AT = "2026-10-10T12:00:00.000Z";
const search: DocTool = {
	ref: 1,
	id: "call-search-1",
	tool: "web_search",
	observes: true,
	text: "Wikipedia: Ivan Bunin was awarded the Nobel Prize in Literature in 1933. He died in Paris in 1953.",
};
const thinker: DocTool = {
	ref: 2,
	id: "call-think-2",
	tool: "ask_thinking_model",
	observes: false,
	text: "Sally's parents have 5 children.",
};
const reply = (text: string, tools: DocTool[] = [search, thinker]): ExtractionDoc => ({
	kind: "reply",
	text,
	speaker: "Iyye",
	speakerId: null,
	recipient: "the owner",
	asked: "q",
	at: AT,
	tools,
});
const raw = (o: Partial<RawFact>): RawFact => ({
	subject: "Bunin",
	predicate: "other: won",
	object: "the Nobel Prize in 1933",
	quote: "Bunin won the Nobel Prize in 1933",
	...o,
});
const one = (doc: ExtractionDoc, f: RawFact) => {
	const r = processFacts([f], doc, []);
	assert.equal(r.kept.length, 1, JSON.stringify(r.dropped));
	return r.kept[0]!;
};

describe("citations are the host's", () => {
	const doc = reply("Bunin won the Nobel Prize in 1933, and Sally's parents have 5 children.");

	test("a number naming this turn's search that carries the figure cites it, with the result's id", () => {
		const f = one(doc, raw({ tool_ref: 1 }));
		assert.equal(f.cited, "web_search result call-sea");
		assert.equal(f.toolCallId, "call-search-1");
		assert.equal(f.p, 0.6);
	});

	test("a result without the fact's figure, a number naming no result, or a named source alone cites nothing", () => {
		for (const f of [
			// Iyye said 1935; the search it names says 1933.
			one(
				reply("Bunin won the Nobel Prize in 1935."),
				raw({ object: "the Nobel Prize in 1935", quote: "Bunin won the Nobel Prize in 1935", tool_ref: 1 }),
			),
			one(doc, raw({ tool_ref: 7 })),
			one(doc, raw({ source_named: "verified web search" })),
		]) {
			assert.equal(f.cited, null);
			assert.equal(f.p, 0.4);
		}
		// The unit too: a result saying 12 MB does not carry 12 GB.
		const mb = reply("You have 12 GB free.", [{ ...search, text: "Avail: 12 MB free" }]);
		assert.equal(
			one(mb, raw({ subject: "the disk", object: "12 GB free", quote: "You have 12 GB free", tool_ref: 1 })).cited,
			null,
		);
		const gb = reply("You have 12 GB free.", [{ ...search, text: "Avail: 12G free" }]);
		assert.match(
			one(gb, raw({ subject: "the disk", object: "12 GB free", quote: "You have 12 GB free", tool_ref: 1 })).cited ??
				"",
			/^web_search/,
		);
		// "12" is not in "512", nor 12GB in a result that only says 512.
		const disk = reply("You have 12 GB free.", [{ ...search, text: "Avail 512G" }]);
		const d = one(
			disk,
			raw({ subject: "the disk", object: "12 GB free", quote: "You have 12 GB free", tool_ref: 1 }),
		);
		assert.equal(d.cited, null);
	});

	test("another model's answer is kept as provenance, never as an observation", () => {
		const f = one(
			doc,
			raw({
				subject: "Sally's parents",
				predicate: "has",
				object: "5 children",
				quote: "Sally's parents have 5 children",
				tool_ref: 2,
			}),
		);
		assert.equal(f.cited, null);
		assert.equal(f.toolCallId, "call-think-2");
		assert.equal(f.p, 0.4);
	});

	test("the extraction model sees the turn's results by number", () => {
		const input = extractionInput(doc);
		assert.match(input, /\n\[1\] web_search: Wikipedia: Ivan Bunin was awarded/);
		assert.match(input, /\n\[2\] ask_thinking_model: Sally's parents have 5 children\./);
		assert.ok(!extractionInput(reply("x", [])).includes("Tool results"));
	});
});

test("a tool call records its turn's event (from the host) and a hash of what the model saw", async () => {
	const db = openDb(":memory:");
	const tools = new ToolBroker({
		db,
		log: silentLogger,
		toolkits: [
			{
				name: "t",
				description: "t",
				effect: "read",
				tools: [
					{
						name: "probe",
						label: "Probe",
						description: "d",
						summary: "s",
						parameters: Type.Object({}),
						run: async () => "free: 512 GB",
					},
				],
			},
		],
	}).forSession({ scope: "owner", principal: "owner" });
	tools.beginTurn({ route: { channel: "web", contact: "owner" }, contactId: "owner", eventId: "ev-42" });
	const exec = tools.definitions[0]!.execute as unknown as (...a: unknown[]) => Promise<unknown>;
	await exec("c", {}, undefined, undefined, undefined);
	const row = db.prepare("SELECT event_id, result_hash FROM tool_calls").get() as {
		event_id: string;
		result_hash: string;
	};
	assert.equal(row.event_id, "ev-42");
	assert.equal(row.result_hash, createHash("sha256").update("free: 512 GB").digest("hex"));
});

test("the audit: citations stored without a traced result become uncited, and a belief they alone made goes", () => {
	const db = openDb(":memory:");
	let n = 0;
	const newId = () => `id-${++n}`;
	const store = (o: Partial<StmFact>) => {
		const f = {
			id: newId(),
			doc_id: "d",
			event_id: "e",
			scope: "owner",
			modality: "told_by_iyye",
			source: "iyye",
			subject: "Bunin",
			subject_ref: "bunin",
			predicate: "other: won",
			object: "the Nobel Prize in 1933",
			details: null,
			valid_from: "2026-10-01",
			time_frame: "permanent",
			hedged: 0,
			negated: 0,
			quote: "q",
			cited: "web search",
			fact_key: "bunin|other:won",
			p: 0.6,
			said_at: AT,
			created_at: AT,
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
		return mergeFact(db, f, { night: "n", maxStep: 9, now: new Date(AT), newId }).beliefId!;
	};
	const alone = store({});
	// A person also said the second one: the belief stays, without Iyye's weight.
	const shared = store({ object: "a medal", fact_key: "bunin|other:got", subject_ref: "bunin" });
	store({ object: "a medal", fact_key: "bunin|other:got", modality: "stated", source: "owner", cited: null, p: 0.9 });
	assert.ok(getBelief(db, alone) && getBelief(db, shared));
	assert.equal(auditUntracedCitations(db, AT), 2);
	assert.equal(getBelief(db, alone), null);
	assert.ok(Math.abs(getBelief(db, shared)!.p - 0.9) < 1e-9);
	assert.equal(
		(db.prepare("SELECT count(*) AS n FROM stm_facts WHERE cited IS NOT NULL").get() as { n: number }).n,
		0,
	);
	assert.equal(auditUntracedCitations(db, AT), 0, "once");
});

describe("a real turn", () => {
	const fake = new FakeTelegram();
	before(() => fake.start());
	after(() => fake.stop());

	test("the tool call's event is the turn's own event, on the web chat and on Telegram, and the reply's document offers it", async () => {
		const sb = sandbox();
		const searchKit = {
			name: "web",
			description: "the web",
			effect: "read" as const,
			tools: [
				{
					name: "web_search",
					label: "Search",
					description: "search",
					summary: "search",
					parameters: Type.Object({}),
					run: async () => "Bunin was awarded the Nobel Prize in 1933.",
				},
			],
		};
		const s = await startStack(sb, {}, { telegramApiBase: fake.apiBase, toolkits: () => [searchKit] });
		try {
			const deps = { db: s.db, now: () => new Date(), newId: () => crypto.randomUUID() };
			const web = admitOwnerWebMessage(deps, {
				clientMsgId: "lineage-1",
				text: "[[tool:web_search]] when did Bunin win?",
			});
			assert.ok(web.outcome === "admitted");
			const tg = admitTelegramUpdate(deps, {
				updateId: 7001,
				message: {
					messageId: 1,
					chatId: 4401,
					chatType: "private",
					fromUserId: 4401,
					fromIsBot: false,
					username: null,
					firstName: "Julia",
					text: "[[tool:web_search]] and when?",
					dateUnix: Math.floor(Date.now() / 1000),
				},
			});
			assert.ok(tg.outcome === "admitted");
			s.scheduler.wake();
			for (const id of [web.eventId, tg.eventId])
				await waitFor(() => getEvent(s.db, id)!.status === "answered", 10_000);
			for (const id of [web.eventId, tg.eventId]) {
				const call = s.db.prepare("SELECT event_id, result_hash FROM tool_calls WHERE event_id = ?").get(id) as
					| { event_id: string; result_hash: string }
					| undefined;
				assert.ok(call?.result_hash, `a tool call recorded with event ${id}`);
				const episode = s.db.prepare("SELECT * FROM stm_episodes WHERE event_id = ?").get(id) as StmEpisode;
				assert.ok(episode, "the same event id in short-term memory");
				const tools = docsFor(s.db, episode).find((d) => d.doc.kind === "reply")?.doc.tools ?? [];
				assert.deepEqual(
					tools.map((t) => [t.ref, t.tool, t.observes]),
					[[1, "web_search", true]],
				);
			}
		} finally {
			await s.stop();
			sb.cleanup();
		}
	});
});
