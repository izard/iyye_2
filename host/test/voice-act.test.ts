// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.009 CH4: the voice acting. Off by default; per surface (the owner's
 * linked Telegram accounts, contacts) by an owner command, recorded. A reply
 * goes out rephrased only when the check accepts; any doubt (off, web, a tool
 * with an effect or a refused call, not loaded, failure, deadline, a stopped
 * turn, refused, a copy) delivers the original byte for byte. Every attempt
 * is a sample the shadow loop never repeats.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Character } from "../src/character/character.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { Scheduler } from "../src/kernel/scheduler.ts";
import type { ActionRow } from "../src/outbox/outbox.ts";
import { type Db, migrate, openDb } from "../src/state/db.ts";
import { type EventRow, getEvent } from "../src/state/events.ts";
import { VoiceActor } from "../src/voice/act.ts";
import { VoiceShadow } from "../src/voice/shadow.ts";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const quiet = { warn() {}, info() {}, error() {}, debug() {} } as never;

function setup() {
	const db: Db = openDb(":memory:");
	migrate(db);
	const add = (id: string, name: string) =>
		db
			.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', ?)")
			.run(id, name, NOW.toISOString());
	add("julia", "Julia");
	add("owner-tg", "Alex on Telegram");
	db.prepare(
		"INSERT INTO contact_links (account_id, person_id, linked_by, linked_at) VALUES ('owner-tg', 'owner', 'owner_web', ?)",
	).run(NOW.toISOString());
	return db;
}

let n = 0;
function event(db: Db, o: { contact?: string; scope?: string; channel?: "telegram" | "web" } = {}): EventRow {
	const id = `e${n++}`;
	const channel = o.channel ?? "telegram";
	const payload = channel === "telegram" ? { message: { chatId: 42, text: "hi" } } : { text: "hi" };
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'admitted')",
	).run(id, id, channel, o.contact ?? "julia", o.scope ?? "contact:julia", NOW.toISOString(), JSON.stringify(payload));
	return getEvent(db, id)!;
}

interface Opts {
	complete?: (system: string, user: string, signal: AbortSignal) => Promise<string> | string;
	loaded?: boolean;
	deadlineMs?: number;
}
function actor(db: Db, o: Opts = {}) {
	const character = new Character({ db, stateDir: null, now: () => NOW });
	character.init();
	let calls = 0;
	const v = new VoiceActor({
		db,
		log: quiet,
		models: {
			selected: () => "voice-m",
			acquire: async (name) =>
				o.loaded === false
					? { ok: false, message: `${name} is not loaded` }
					: { model: name, valid: () => true, release() {} },
		},
		complete: async (_m, system, user, _max, signal) => {
			calls++;
			return (o.complete ?? ((_s, u) => `Sure thing! ${/<<<\n([\s\S]*)\n>>>/.exec(u)![1]}`))(system, user, signal);
		},
		character,
		names: () => ["Julia"],
		effectToolkits: () => new Set(["reminders", "plans", "messaging"]),
		deadlineMs: o.deadlineMs ?? 1000,
		now: () => NOW,
	});
	return { v, calls: () => calls };
}
const ORIGINAL = "Your parcel arrived at 10:15, Julia.";
/** The delivered action a sample is recorded against. */
function action(db: Db, id: string, e: EventRow, content: string): string {
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, ?)",
	).run(id, e.id, `k-${id}`, NOW.toISOString(), content);
	return id;
}
const never = new AbortController().signal;
const samples = (db: Db) =>
	db
		.prepare(
			"SELECT status, problem, acting, delivered, original, candidate FROM voice_samples ORDER BY created_at, rowid",
		)
		.all() as {
		status: string;
		problem: string | null;
		acting: number;
		delivered: number;
		original: string;
		candidate: string | null;
	}[];

test("off by default; the owner turns surfaces on and off, recorded with who and when", async () => {
	const db = setup();
	const { v, calls } = actor(db);
	const r = await v.rephrase(event(db), ORIGINAL, never);
	assert.equal(r.content, ORIGINAL);
	assert.equal(calls(), 0);
	assert.match(v.report(), /your linked Telegram accounts: off\n {2}contacts on Telegram: off/);
	assert.match(
		v.command(["on", "contacts"], "owner_web"),
		/contacts on Telegram: on \(set by owner_web, 2026-10-11 12:00 UTC\)/,
	);
	assert.match(v.command(["on", "nobody"], "owner_web"), /^usage/);
	assert.match(v.command(["off", "all"], "owner_terminal"), /contacts on Telegram: off \(set by owner_terminal/);
});

test("on and accepted: the rephrasing goes out and the attempt is recorded as delivered", async () => {
	const db = setup();
	const { v } = actor(db);
	v.command(["on", "contacts"], "owner_web");
	const e = event(db);
	const r = await v.rephrase(e, ORIGINAL, never);
	assert.equal(r.content, "Sure thing! Your parcel arrived at 10:15, Julia.");
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES ('a1', ?, 'reply', '{}', 'h', 'k1', 'delivered', ?, ?)",
	).run(e.id, NOW.toISOString(), r.content);
	r.record("a1");
	assert.deepEqual(samples(db), [
		{ status: "accepted", problem: null, acting: 1, delivered: 1, original: ORIGINAL, candidate: r.content },
	]);
	// The owner's linked account is its own surface.
	const owner = await v.rephrase(event(db, { contact: "owner-tg", scope: "owner" }), ORIGINAL, never);
	assert.equal(owner.content, ORIGINAL, "your linked accounts stay off until you turn them on");
	v.command(["on", "owner"], "owner_web");
	assert.notEqual(
		(await v.rephrase(event(db, { contact: "owner-tg", scope: "owner" }), ORIGINAL, never)).content,
		ORIGINAL,
	);
});

test("any doubt delivers the original byte for byte", async () => {
	const cases: [string, Opts, (db: Db, e: EventRow) => void, RegExp | null][] = [
		["web", {}, () => {}, null],
		["not loaded", { loaded: false }, () => {}, /not available: voice-m is not loaded/],
		[
			"failure",
			{
				complete: () => {
					throw new Error("boom");
				},
			},
			() => {},
			/boom/,
		],
		[
			"deadline",
			{
				deadlineMs: 20,
				complete: (_s, _u, signal) =>
					new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
			},
			() => {},
			/took longer than 0\.02 s/,
		],
		["refused", { complete: () => "Your parcel will arrive at ⟦1⟧, ⟦2⟧." }, () => {}, /future|tense/],
		["lost placeholder", { complete: () => "Your parcel arrived, ⟦2⟧." }, () => {}, /placeholder 1 was dropped/],
		["copy", { complete: (_s, u) => /<<<\n([\s\S]*)\n>>>/.exec(u)![1]! }, () => {}, null],
		[
			"effect tool",
			{},
			(db, e) =>
				db
					.prepare(
						"INSERT INTO tool_calls (id, scope, principal, tool, toolkit, args_json, outcome, started_at, finished_at, event_id) VALUES ('t1', 'contact:julia', 'contact', 'remind', 'reminders', '{}', 'ok', ?, ?, ?)",
					)
					.run(NOW.toISOString(), NOW.toISOString(), e.id),
			/reminders, a toolkit with an effect/,
		],
		[
			"refused tool call",
			{},
			(db, e) =>
				db
					.prepare(
						"INSERT INTO tool_calls (id, scope, principal, tool, toolkit, args_json, outcome, started_at, finished_at, event_id) VALUES ('t2', 'contact:julia', 'contact', 'web_search', 'web', '{}', 'denied', ?, ?, ?)",
					)
					.run(NOW.toISOString(), NOW.toISOString(), e.id),
			/a tool call was refused/,
		],
	];
	for (const [label, o, prep, why] of cases) {
		const db = setup();
		const { v } = actor(db, o);
		v.command(["on", "all"], "owner_web");
		const e = event(db, label === "web" ? { channel: "web", contact: "owner", scope: "owner" } : {});
		prep(db, e);
		const r = await v.rephrase(e, ORIGINAL, never);
		assert.equal(r.content, ORIGINAL, label);
		r.record(action(db, `a-${label}`, e, r.content));
		const s = samples(db);
		if (label === "web") assert.equal(s.length, 0, "the web chat is never rephrased");
		else {
			assert.equal(s[0]!.delivered, 0, label);
			if (why) assert.match(s[0]!.problem ?? "", why, label);
			else assert.equal(s[0]!.status, "unchanged", label);
		}
	}
	// A stopped turn (shutdown, a lost router): the original goes out.
	const db = setup();
	const stop = new AbortController();
	const { v } = actor(db, {
		complete: (_s, _u, signal) => {
			setTimeout(() => stop.abort(), 5);
			return new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
		},
	});
	v.command(["on", "contacts"], "owner_web");
	const se = event(db);
	const r = await v.rephrase(se, ORIGINAL, stop.signal);
	assert.equal(r.content, ORIGINAL);
	r.record(action(db, "a-stop", se, r.content));
	assert.match(samples(db)[0]!.problem!, /the turn was stopped/);
});

test("the scheduler delivers the voice's content, records it against the action, and survives a voice that throws", async () => {
	for (const mode of ["voiced", "throws"] as const) {
		const db = setup();
		const e = event(db);
		db.prepare(
			"INSERT INTO jobs (id, trigger_event_id, scope, status, created_at) VALUES ('j1', ?, 'contact:julia', 'queued', ?)",
		).run(e.id, NOW.toISOString());
		const delivered: string[] = [];
		const recorded: string[] = [];
		const scheduler = new Scheduler({
			db,
			device: new DeviceSlot(),
			models: {
				selected: () => "m",
				acquire: async () => ({ model: "m", valid: () => true, release() {} }),
				onRouterLost() {},
			},
			conversations: { turn: async () => ({ ok: true, text: ORIGINAL, model: "m" }) },
			outbox: {
				deliver: async (req) => {
					delivered.push(req.content);
					db.prepare("UPDATE jobs SET status = 'settled' WHERE id = 'j1'").run();
					return { id: "act-1" } as ActionRow;
				},
			},
			log: quiet,
			pollMs: 10,
			rephrase: async (_e, text) => {
				if (mode === "throws") throw new Error("voice exploded");
				return { content: `Voiced: ${text}`, record: (id) => recorded.push(id) };
			},
		});
		scheduler.start();
		for (let i = 0; i < 200 && delivered.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
		await scheduler.stop();
		assert.deepEqual(delivered, [mode === "voiced" ? `Voiced: ${ORIGINAL}` : ORIGINAL]);
		assert.deepEqual(recorded, mode === "voiced" ? ["act-1"] : []);
	}
});

test("the shadow loop never repeats an action the acting voice already tried", async () => {
	const db = setup();
	const { v } = actor(db);
	v.command(["on", "contacts"], "owner_web");
	const e = event(db);
	const r = await v.rephrase(e, ORIGINAL, never);
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES ('a1', ?, 'reply', ?, 'h', 'k1', 'delivered', ?, ?)",
	).run(e.id, JSON.stringify({ channel: "telegram", chatId: 42 }), NOW.toISOString(), r.content);
	r.record("a1");
	const character = new Character({ db, stateDir: null, now: () => NOW });
	const shadow = new VoiceShadow({
		db,
		log: quiet,
		device: new DeviceSlot(),
		models: {
			selected: () => "voice-m",
			acquire: async (name) => ({ model: name, valid: () => true, release() {} }),
		},
		background: { blockedReason: () => null, yieldReason: () => null },
		complete: async () => {
			throw new Error("must not be called");
		},
		character,
		names: () => ["Julia"],
		now: () => NOW,
	});
	assert.equal(shadow.pending(), 0);
	assert.equal(await shadow.drainOnce(), 0);
});
