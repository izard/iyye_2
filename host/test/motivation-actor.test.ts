// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Plan 0.010 M1: the motivations act (notices, the owner's self-model questions, maintenance, pausing). */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { silentLogger } from "../src/log.ts";
import { MotivationActor, type Opening } from "../src/motivation/actor.ts";
import { cleanError, recordServices, serviceStatuses } from "../src/motivation/services.ts";
import { collectSignals, type Signal } from "../src/motivation/signals.ts";
import { MotivationTracker } from "../src/motivation/tracker.ts";
import { Investigations } from "../src/observe/investigations.ts";
import { SelfModel } from "../src/self/model.ts";
import { type Db, openDb } from "../src/state/db.ts";

const T0 = new Date("2026-10-07T10:00:00Z");
const after = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const H = 3_600_000;

/** A self model in memory: only what the actor reads and writes. */
function fakeSelf() {
	const facts = new Map<string, unknown>();
	return {
		facts,
		value: <T>(facet: string, field: string) => (facts.get(`${facet}.${field}`) ?? null) as T | null,
		setFacet: (facet: string, fields: Record<string, unknown>) => {
			for (const [k, v] of Object.entries(fields)) facts.set(`${facet}.${k}`, v);
		},
	};
}

function rig(opts: { facts?: string[]; retry?: boolean } = {}) {
	const db = openDb(":memory:");
	const clock = { now: T0 };
	const mode = { m: "awake" as "awake" | "asleep" };
	const sent: { key: string; content: string }[] = [];
	const retried: string[] = [];
	const self = fakeSelf();
	let seq = 0;
	const actor = new MotivationActor({
		db,
		log: silentLogger,
		mode: () => mode.m,
		// Like the outbox: a key is sent once.
		notifyOwner: async (r) => {
			if (!sent.some((x) => x.key === r.key)) sent.push(r);
		},
		self: self as never,
		ownerFactsAbout: opts.facts ? async () => opts.facts! : null,
		retryModel: (n) => {
			retried.push(n);
			return opts.retry ?? true;
		},
		now: () => clock.now,
		newId: () => `${String(++seq).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`,
	});
	return { db, clock, mode, sent, retried, self, actor };
}

const signal = (s: Partial<Signal> & Pick<Signal, "motivation" | "kind" | "cluster">): Signal => ({
	evidence: ["x"],
	weight: 0.8,
	observedAt: T0.toISOString(),
	text: s.kind,
	...s,
});
const opening = (s: Signal): Opening => ({ motivation: s.motivation, signal: s });
const rows = (db: Db) =>
	db
		.prepare("SELECT cluster, status, action_kind, motivation, answer FROM opportunities ORDER BY created_at")
		.all() as {
		cluster: string;
		status: string;
		action_kind: string;
		motivation: string;
		answer: string | null;
	}[];
function ownerSays(db: Db, id: string, text: string, at: Date): void {
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'web', 'owner', 'owner', ?, ?, 'answered')",
	).run(id, id, at.toISOString(), JSON.stringify({ text }));
}

describe("service status", () => {
	test("a state change resets since; a new detail does not; errors keep no token and no countdown", () => {
		const db = openDb(":memory:");
		const state = { s: "up", detail: "" };
		const probe = () => ({ Telegram: { state: state.s, detail: state.detail } });
		recordServices(db, probe, T0);
		state.s = "retrying";
		state.detail =
			"getUpdates failed: fetch https://api.telegram.org/bot123456:AAH-secret_token/getUpdates; retrying in 12 s";
		recordServices(db, probe, after(MIN));
		state.detail = "getUpdates failed: socket hang up; retrying in 30 s";
		recordServices(db, probe, after(2 * MIN));
		const [t] = serviceStatuses(db);
		assert.equal(t!.state, "retrying");
		assert.equal(t!.since, after(MIN).toISOString(), "since the change of state");
		assert.equal(t!.last_error, "getUpdates failed: socket hang up");
		assert.doesNotMatch(cleanError(state.detail.replace("socket hang up", "bot123456:AAH-secret_token")), /secret/);
		state.s = "connected";
		state.detail = "";
		recordServices(db, probe, after(3 * MIN));
		const [u] = serviceStatuses(db);
		assert.equal(u!.since, after(3 * MIN).toISOString());
		assert.equal(u!.last_error, "getUpdates failed: socket hang up", "the last error stays for the record");
	});

	test("an outage becomes a self-preservation signal that grows with its duration, one episode per outage", () => {
		const db = openDb(":memory:");
		const state = { s: "retrying" };
		const probe = () => ({ Telegram: { state: state.s, detail: "timeout" } });
		recordServices(db, probe, T0);
		const down = (now: Date) =>
			collectSignals({ db, now, selfGaps: () => [], healing: () => [], sleep: () => null }).filter(
				(s) => s.kind === "service_down",
			);
		const [early] = down(after(MIN));
		const [late] = down(after(8 * H));
		assert.equal(early!.motivation, "self_preservation");
		assert.equal(early!.cluster, `service:Telegram@${T0.toISOString()}`);
		assert.ok(late!.weight > early!.weight && late!.weight <= 0.9);
		assert.match(late!.text, /Telegram has been retrying for 8\.0 h: timeout/);
		state.s = "connected";
		recordServices(db, probe, after(9 * H));
		assert.deepEqual(down(after(9 * H)), []);
	});
});

describe("the actor", () => {
	test("a steady signal at 0.6 opens at the 0.55 threshold, and the actor notifies once", async () => {
		const r = rig();
		recordServices(r.db, () => ({ Telegram: { state: "retrying", detail: "timeout" } }), T0);
		r.clock.now = after(4 * H);
		const tracker = new MotivationTracker({
			db: r.db,
			log: silentLogger,
			actor: r.actor,
			mode: () => "awake",
			sources: { selfGaps: () => [], healing: () => [], sleep: () => null },
			now: () => r.clock.now,
			alpha: 0.5,
			threshold: 0.55,
			sustain: 2,
		});
		for (let i = 0; i < 6; i++) {
			r.clock.now = after(4 * H + i * 10 * MIN);
			await tracker.sweep();
		}
		const opened = rows(r.db);
		assert.equal(opened.length, 1);
		assert.equal(opened[0]!.action_kind, "notify");
		assert.equal(r.sent.length, 1);
		assert.match(r.sent[0]!.content, /^Self-preservation: Telegram has been retrying for 4\.\d h: timeout\./);
	});

	test("notices: a cooldown per kind of trouble, a daily cap, held while asleep and while the owner talks", async () => {
		const r = rig();
		const outage = (since: string) =>
			signal({ motivation: "self_preservation", kind: "service_down", cluster: `service:Telegram@${since}` });
		// Asleep: opened, not sent.
		r.mode.m = "asleep";
		await r.actor.act([opening(outage("a"))], new Set(["service:Telegram@a"]));
		assert.equal(r.sent.length, 0);
		// The owner just wrote: held.
		r.mode.m = "awake";
		ownerSays(r.db, "e1", "hello", after(-MIN));
		await r.actor.act([], new Set(["service:Telegram@a"]));
		assert.equal(r.sent.length, 0);
		r.clock.now = after(5 * MIN);
		await r.actor.act([], new Set(["service:Telegram@a"]));
		assert.equal(r.sent.length, 1);
		assert.equal(
			r.sent[0]!.key,
			`motivation:${"1".padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd:${T0.toISOString()}`,
		);
		// Cleared, then a new outage within the cooldown: no second notice (a flapping service notifies once).
		await r.actor.act([], new Set());
		assert.equal(rows(r.db)[0]!.status, "settled");
		r.clock.now = after(H);
		await r.actor.act([opening(outage("b"))], new Set(["service:Telegram@b"]));
		assert.equal(r.sent.length, 1);
		// After the cooldown a new outage notifies again.
		r.clock.now = after(7 * H);
		await r.actor.act([opening(outage("c"))], new Set(["service:Telegram@c"]));
		assert.equal(r.sent.length, 2);
		// The daily cap: three notices a motivation.
		for (const k of ["d1", "d2", "d3"]) {
			const s = signal({ motivation: "self_preservation", kind: "disk_low", cluster: `disk:${k}` });
			await r.actor.act([opening(s)], new Set(["service:Telegram@c", `disk:${k}`]));
		}
		assert.equal(r.sent.length, 3);
		assert.equal(rows(r.db).find((x) => x.cluster === "disk:d3")!.answer, "over the daily cap");
	});

	test("an agency notice for a plan waiting for approval says how to approve it; social only journals", async () => {
		const r = rig();
		const plan = signal({
			motivation: "agency",
			kind: "plan_awaiting_approval",
			cluster: "plan:f9236bfb",
			text: "a plan waits",
		});
		const social = signal({ motivation: "social", kind: "person_unanswered", cluster: "person:c1" });
		await r.actor.act([opening(plan), opening(social)], new Set(["plan:f9236bfb", "person:c1"]));
		assert.equal(r.sent.length, 1);
		assert.match(r.sent[0]!.content, /\/plan approve <id>/);
		assert.deepEqual(
			rows(r.db).map((x) => x.cluster),
			["plan:f9236bfb"],
		);
	});

	test("a plan due within a day weighs enough to open; a reopened plan notice goes out again", async () => {
		const r = rig();
		r.db
			.prepare(
				`INSERT INTO plans (id, intent, proposer_contact_id, scope, route_json, proposed_via, steps_json, state, created_at, updated_at)
			 VALUES ('f9236bfb', 'greet Jacob', 'owner', 'owner', '{}', 'telegram', ?, 'proposed', ?, ?)`,
			)
			.run(
				JSON.stringify([{ kind: "remind", text: "hi", due_at: after(2 * H).toISOString(), status: "pending" }]),
				after(-2 * H).toISOString(),
				after(-2 * H).toISOString(),
			);
		const agency = () =>
			collectSignals({
				db: r.db,
				now: r.clock.now,
				selfGaps: () => [],
				healing: () => [],
				sleep: () => null,
			}).filter((x) => x.motivation === "agency");
		const [p] = agency();
		assert.equal(p!.weight, 0.8, "proposed two hours ago, due in two: urgent, not a 0.3 wait");
		assert.match(p!.text, /its first step is due 2026-10-07 12:00 UTC/);
		const current = new Set([p!.cluster]);
		await r.actor.act([opening(p!)], current);
		assert.equal(r.sent.length, 1);
		// Cleared (say, approved and then suspended again), and after the cooldown it opens again: a new notice.
		await r.actor.act([], new Set());
		r.clock.now = after(7 * H);
		await r.actor.act([opening(p!)], current);
		assert.equal(r.sent.length, 2, "the same row reopened, a new key");
	});

	test("an opening motivation queues every question it could ask, not just its strongest signal", async () => {
		const r = rig();
		for (const x of ["a", "b"])
			r.db
				.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', 't')")
				.run(x, x);
		const gaps = [
			{
				facet: "place" as const,
				field: "stated",
				kind: "contradicted" as const,
				why: "Berlin vs Munich",
				episode: "n1",
			},
			{ facet: "social" as const, field: "relation:a", kind: "missing" as const, why: "a" },
			{ facet: "social" as const, field: "relation:b", kind: "missing" as const, why: "b" },
		];
		const tracker = new MotivationTracker({
			db: r.db,
			log: silentLogger,
			actor: r.actor,
			mode: () => "awake",
			sources: { selfGaps: () => gaps, healing: () => [], sleep: () => null },
			now: () => r.clock.now,
			alpha: 1,
			threshold: 0.55,
			sustain: 1,
		});
		await tracker.sweep();
		assert.deepEqual(
			rows(r.db)
				.map((x) => x.cluster)
				.sort(),
			["self:place:stated@n1", "self:social:relation:a", "self:social:relation:b"],
		);
		assert.equal(r.sent.length, 1, "asked one at a time");
	});

	test("maintenance reloads a model self-healing gave up on, once a day, never past the owner's unload", async () => {
		const r = rig({ retry: false });
		const gaveUp = signal({
			motivation: "self_preservation",
			kind: "model_gave_up",
			cluster: "model:gemma-4-26B@2026-10-07",
		});
		await r.actor.act([opening(gaveUp)], new Set([gaveUp.cluster]));
		assert.deepEqual(r.retried, ["gemma-4-26B"]);
		assert.match(rows(r.db)[0]!.answer!, /owner's choice/);
		await r.actor.act([opening(gaveUp)], new Set([gaveUp.cluster]));
		assert.deepEqual(r.retried, ["gemma-4-26B"], "the same day's cluster acts once");
		assert.equal(r.sent.length, 0, "maintenance is not a notice");
	});

	test("questions: one at a time, the answer is pending until the owner accepts it, then applied", async () => {
		const r = rig();
		const where = signal({ motivation: "curiosity", kind: "self_missing", cluster: "self:place:stated" });
		await r.actor.act([opening(where)], new Set([where.cluster]));
		assert.equal(r.sent.length, 1);
		assert.match(r.sent[0]!.content, /where am I\?.*\/self accept 00000002/);
		assert.match(r.actor.noteFor("owner")!, /<open_question>/);
		assert.equal(r.actor.noteFor("contact:c1"), null, "only the owner's turns");
		// A second question waits while one is open.
		r.db
			.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Jacob', 'contact', 't')")
			.run();
		const who = signal({ motivation: "curiosity", kind: "self_missing", cluster: "self:social:relation:c1" });
		await r.actor.act([opening(who)], new Set([where.cluster, who.cluster]));
		assert.equal(r.sent.length, 1);
		// The owner's next message (not a command) is the pending answer; nothing changes until they accept.
		ownerSays(r.db, "e1", "/models", after(MIN));
		ownerSays(r.db, "e2", "a south-eastern suburb of Munich", after(2 * MIN));
		r.clock.now = after(10 * MIN);
		await r.actor.act([], new Set([where.cluster, who.cluster]));
		assert.equal(r.self.value("place", "stated"), null);
		assert.match(r.actor.questionsReport(), /answered · answer: "a south-eastern suburb of Munich"/);
		assert.equal(r.actor.accept("00000002", "", "owner_web"), "noted: a south-eastern suburb of Munich");
		assert.equal(r.self.value("place", "stated"), "a south-eastern suburb of Munich");
		assert.equal(r.actor.noteFor("owner"), null);
		// Now the next question goes out.
		await r.actor.act([], new Set([who.cluster]));
		assert.equal(r.sent.length, 2);
		assert.match(r.sent[1]!.content, /who is "Jacob" to you\?/);
		assert.match(r.actor.accept("zz", "", "x"), /give a question id/);
	});

	test("a relation the owner already stated is taken from their words, not asked", async () => {
		const r = rig({ facts: ["Alex lives with his wife, Julia, and son Jacob."] });
		r.db
			.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Jacob', 'contact', 't')")
			.run();
		const who = signal({ motivation: "curiosity", kind: "self_missing", cluster: "self:social:relation:c1" });
		await r.actor.act([opening(who)], new Set([who.cluster]));
		assert.equal(r.sent.length, 0);
		assert.equal(r.self.value("social", "relation:c1"), "son");
	});

	test("the daily cap of questions, and a dismissed field is not asked again for a week", async () => {
		const r = rig();
		const fields = ["a", "b", "c", "d"].map((x) =>
			signal({ motivation: "curiosity", kind: "self_missing", cluster: `self:social:relation:${x}` }),
		);
		for (const x of ["a", "b", "c", "d"])
			r.db
				.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', 't')")
				.run(x, x);
		const all = new Set(fields.map((f) => f.cluster));
		await r.actor.act(fields.map(opening), all);
		for (let i = 0; i < 4; i++) {
			const q = r.db.prepare("SELECT id FROM self_questions WHERE status = 'asked'").get() as
				| { id: string }
				| undefined;
			if (q) r.actor.dismiss(q.id.slice(0, 8));
			await r.actor.act([], all);
		}
		assert.equal(r.sent.length, 3, "three questions a day");
		// A week later the dismissed fields may be asked again: the settled row reopens.
		r.clock.now = after(8 * 86_400_000);
		await r.actor.act(fields.map(opening), all);
		assert.equal(r.sent.length, 4);
	});

	test("pausing a motivation: it opens nothing and acts on nothing; resume", async () => {
		const r = rig();
		assert.match(r.actor.pause("self_preservation", "owner_web"), /paused/);
		const s = signal({ motivation: "self_preservation", kind: "disk_low", cluster: "disk:x" });
		await r.actor.act([opening(s)], new Set([s.cluster]));
		assert.equal(rows(r.db).length, 0);
		assert.match(r.actor.resume("self_preservation"), /resumed/);
		await r.actor.act([opening(s)], new Set([s.cluster]));
		assert.equal(r.sent.length, 1);
	});
});

describe("around the actor", () => {
	test("investigations never pick the motivations' acting rows, and stop while curiosity is paused", async () => {
		const db = openDb(":memory:");
		const enqueued: string[] = [];
		let curiosityPaused = true;
		const at = T0.toISOString();
		const add = (id: string, action: string) =>
			db
				.prepare(
					`INSERT INTO opportunities (id, cluster, domain, evidence_json, evidence_text, question, status, created_at, updated_at, motivation, action_kind)
					 VALUES (?, ?, 'workspace', '[]', 'e', 'q', 'open', ?, ?, 'curiosity', ?)`,
				)
				.run(id, `c-${id}`, at, at, action);
		add("ask-1", "ask");
		add("inv-1", "investigate");
		const inv = new Investigations({
			db,
			worker: {
				enqueue: (s) => {
					enqueued.push(s.origin);
					return `j${enqueued.length}`;
				},
				initiativePaused: () => false,
			},
			mode: () => "awake",
			log: silentLogger,
			now: () => T0,
			curiosityPaused: () => curiosityPaused,
		});
		await inv.tick();
		assert.deepEqual(enqueued, []);
		curiosityPaused = false;
		await inv.tick();
		assert.deepEqual(enqueued, ["investigation:inv-1"]);
	});

	test("the owner says the network location is misleading: the contradiction is gone on this network only", () => {
		const db = openDb(":memory:");
		const model = new SelfModel({
			db,
			log: silentLogger,
			mode: () => "awake",
			repoDir: "/repo",
			hostDir: "/nonexistent",
			llamaServer: "/x/llama-server",
			geoHttp: { get: async () => ({ status: 500, body: "" }) },
			now: () => T0,
			timezone: "Europe/Berlin",
		});
		model.setFacet("place", { stated: "a suburb of Munich", estimate_city: "Berlin" }, "owner", "t", T0);
		model.setFacet("network", { networkId: "starlink" }, "probe", null, T0);
		const contradictions = () => model.gaps().filter((g) => g.kind === "contradicted");
		assert.equal(contradictions()[0]!.episode, "starlink");
		model.setFacet("place", { estimate_misleading: "starlink" }, "owner", "t", T0);
		assert.deepEqual(contradictions(), []);
		model.setFacet("network", { networkId: "hotel-wifi" }, "probe", null, T0);
		assert.equal(contradictions().length, 1, "a new network is checked afresh");
	});

	test("the owner's linked accounts are the owner, never a person whose relation is unknown", () => {
		const db = openDb(":memory:");
		const model = new SelfModel({
			db,
			log: silentLogger,
			mode: () => "awake",
			repoDir: "/repo",
			hostDir: "/nonexistent",
			llamaServer: "/x/llama-server",
			geoHttp: null,
			now: () => T0,
		});
		for (const [id, name] of [
			["tg-alex", "Alex"],
			["tg-jacob", "Jacob"],
		])
			db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', 't')").run(
				id,
				name,
			);
		// Events from before the link name the account.
		for (const id of ["tg-alex", "tg-jacob"])
			db.prepare(
				"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'telegram', ?, ?, ?, '{}', 'answered')",
			).run(`e-${id}`, `e-${id}`, id, `contact:${id}`, after(-H).toISOString());
		db.prepare(
			"INSERT INTO contact_links (account_id, person_id, linked_by, linked_at) VALUES ('tg-alex', 'owner', 'owner_terminal', 't')",
		).run();
		assert.deepEqual(
			model.people(30).map((p) => p.name),
			["Jacob"],
		);
		assert.deepEqual(
			model
				.gaps()
				.filter((g) => g.facet === "social")
				.map((g) => g.field),
			["relation:tg-jacob"],
		);
	});
});
