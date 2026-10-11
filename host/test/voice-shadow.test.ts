// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.009 CH3: the voice in shadow. The original is delivered and stays
 * exactly as delivered whatever the voice does; only delivered Telegram
 * messages are rephrased; the voice model is never loaded by the host; each
 * sample carries its lineage, the mood and character as of the delivery; the
 * evaluation split is sealed; the owner's two labels stay apart; the training
 * export takes only trustworthy, masked, screened dev examples; `/forget`
 * reaches samples and in-flight work; and style and mood never reach Pi.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { Character } from "../src/character/character.ts";
import { handleOwnerCommand, isKnownCommand } from "../src/kernel/commands.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { forgetRecords } from "../src/memory/forget.ts";
import { getContact } from "../src/state/contacts.ts";
import { type Db, migrate, openDb } from "../src/state/db.ts";
import { VoiceCommands } from "../src/voice/commands.ts";
import { exportVoice, remask } from "../src/voice/export.ts";
import { routerVoice, VOICE_PROMPT_VERSION } from "../src/voice/prompt.ts";
import { forgetVoice, VoiceShadow } from "../src/voice/shadow.ts";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const quiet = { warn() {}, info() {}, error() {}, debug() {} } as never;

function setup() {
	const db: Db = openDb(":memory:");
	migrate(db);
	const add = (id: string, name: string, trusted = 0) =>
		db
			.prepare("INSERT INTO contacts (id, display_name, kind, created_at, trusted) VALUES (?, ?, 'contact', ?, ?)")
			.run(id, name, ago(10_000), trusted);
	add("julia", "Julia", 1);
	add("jacob", "Jacob");
	return db;
}

let n = 0;
/** A message from a person and Iyye's reply to it, on the person's route. */
function reply(
	db: Db,
	o: { contact: string; scope: string; text: string; at?: string; channel?: "telegram" | "web"; state?: string },
): string {
	const id = `e${n++}`;
	const at = o.at ?? ago(30);
	const channel = o.channel ?? "telegram";
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, '{}', 'answered')",
	).run(id, id, channel, o.contact, o.scope, at);
	const route = channel === "telegram" ? { channel, chatId: 100 + n } : { channel, contact: "owner" };
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', ?, 'h', ?, ?, ?, ?)",
	).run(`a-${id}`, id, JSON.stringify(route), `k-${id}`, o.state ?? "delivered", at, o.text);
	return `a-${id}`;
}
/** A message Iyye sent with telegram_send: the action carries the label, sent_messages the body. */
function sent(db: Db, contact: string, body: string): string {
	const id = `s${n++}`;
	db.prepare(
		"INSERT INTO actions (id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, 'status', ?, 'h', ?, 'delivered', ?, ?)",
	).run(
		`a-${id}`,
		JSON.stringify({ channel: "telegram", chatId: 7 }),
		`notice:send:${id}`,
		ago(20),
		`✉️ From Iyye:\n\n${body}`,
	);
	db.prepare(
		"INSERT INTO sent_messages (id, dedup_key, recipient_contact_id, scope, route_json, text, action_id, requested_via, created_at) VALUES (?, ?, ?, ?, '{}', ?, ?, 'tool', ?)",
	).run(id, id, contact, `contact:${contact}`, body, `a-${id}`, ago(20));
	return `a-${id}`;
}

interface Opts {
	complete?: (system: string, user: string) => Promise<string> | string;
	loaded?: boolean;
	selected?: string | null;
	blocked?: string | null;
	device?: DeviceSlot;
	kev?: boolean;
}
function voice(db: Db, o: Opts = {}) {
	const calls: { system: string; user: string }[] = [];
	const character = new Character({ db, stateDir: null, now: () => NOW });
	character.init();
	const kevAsked: unknown[] = [];
	const shadow = new VoiceShadow({
		db,
		log: quiet,
		device: o.device ?? new DeviceSlot(),
		models: {
			selected: () => (o.selected === undefined ? "voice-m" : o.selected),
			acquire: async (name) =>
				o.loaded === false
					? { ok: false, message: `${name} is not loaded` }
					: { model: name, valid: () => true, release() {} },
		},
		background: { blockedReason: () => o.blocked ?? null, yieldReason: () => null },
		complete: async (_m, system, user, _max, signal) => {
			calls.push({ system, user });
			const out = await (o.complete ?? ((_s, u) => echoMasked(u)))(system, user);
			if (signal.aborted) throw new Error("aborted");
			return out;
		},
		character,
		names: () => ["Julia", "Jacob"],
		decisions: o.kev
			? {
					client: {
						ask: async (role, input) => {
							kevAsked.push({ role: role.name, ...input });
							db.prepare(
								`INSERT INTO decisions (id, role, schema_version, mode, scope, subject_ref, state_json, state_hash, questions_json, status, created_at)
								 VALUES (?, ?, 1, 'shadow', ?, ?, ?, 'h', '[]', 'ok', ?)`,
							).run(`d${n}`, role.name, input.scope, input.subjectRef, JSON.stringify(input.state), ago(0));
							return { id: `d${n++}`, status: "ok", error: null, probabilities: { same: 0.9 }, verdicts: {} };
						},
					},
					ready: () => true,
					chatPending: () => false,
				}
			: null,
		now: () => NOW,
	});
	return { shadow, calls, kevAsked, character };
}
/** The masked input back with a friendlier opening: placeholders kept. */
function echoMasked(user: string): string {
	const body = /<<<\n([\s\S]*)\n>>>/.exec(user)![1]!;
	return `Sure thing! ${body}`;
}
const actionsSnapshot = (db: Db) =>
	JSON.stringify(db.prepare("SELECT id, state, content, content_hash, attempts FROM actions ORDER BY id").all());
// biome-ignore lint/suspicious/noExplicitAny: test rows read by column name
type Sample = Record<string, any>;
const samples = (db: Db) => db.prepare("SELECT * FROM voice_samples ORDER BY created_at, action_id").all() as Sample[];

test("only delivered Telegram replies and telegram_send bodies are rephrased; the label line never is", async () => {
	const db = setup();
	const a = reply(db, {
		contact: "julia",
		scope: "contact:julia",
		text: "Julia, the train leaves at 9:40 from platform 3.",
	});
	reply(db, { contact: "owner", scope: "owner", text: "Web reply.", channel: "web" });
	reply(db, { contact: "jacob", scope: "contact:jacob", text: "Not delivered yet.", state: "failed" });
	db.prepare(
		"INSERT INTO actions (id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES ('rem', 'status', ?, 'h', 'reminder:1', 'delivered', ?, '⏰ call mum')",
	).run(JSON.stringify({ channel: "telegram", chatId: 5 }), ago(10));
	const s = sent(db, "jacob", "Julia asked me to tell you the meeting moved to Friday.");
	const { shadow } = voice(db);
	assert.equal(shadow.pending(), 2);
	assert.equal(await shadow.drainOnce(), 2);
	const rows = samples(db);
	assert.deepEqual(rows.map((r) => r.action_id).sort(), [a, s].sort());
	const body = rows.find((r) => r.action_id === s)!;
	assert.equal(body.original, "Julia asked me to tell you the meeting moved to Friday.");
	assert.ok(!body.masked.includes("From Iyye"));
	assert.equal(body.audience, "contact");
	assert.equal(body.person_id, "jacob");
	assert.equal(rows.find((r) => r.action_id === a)!.audience, "trusted");
	assert.equal(shadow.pending(), 0);
});

test("the original stays exactly as delivered: accepted, refused, failing or giving way", async () => {
	for (const [label, complete] of [
		["accepted", undefined],
		["refused", () => "It costs ⟦1⟧ dollars, ⟦2⟧."],
		[
			"error",
			() => {
				throw new Error("model down");
			},
		],
	] as const) {
		const db = setup();
		reply(db, { contact: "julia", scope: "contact:julia", text: "It costs 12 euros, Julia." });
		const before = actionsSnapshot(db);
		const { shadow } = voice(db, { complete: complete as never });
		await shadow.drainOnce();
		assert.equal(actionsSnapshot(db), before, label);
		assert.equal(samples(db).length, 1, label);
	}
	// Giving way to a person: nothing is written, nothing delivered changes, and it is tried again later.
	const db = setup();
	reply(db, { contact: "julia", scope: "contact:julia", text: "See you at 9, Julia." });
	const before = actionsSnapshot(db);
	const device = new DeviceSlot();
	let release: (() => void) | null = null;
	const { shadow } = voice(db, {
		device,
		complete: async (_s, u) => {
			const got = device.acquire("chat");
			void got.then((r) => {
				release = r;
			});
			await new Promise((r) => setTimeout(r, 5));
			return echoMasked(u);
		},
	});
	await shadow.drainOnce();
	assert.equal(samples(db).length, 0);
	assert.match(shadow.lastReason, /gave way: a person needs the device/);
	assert.equal(actionsSnapshot(db), before);
	(release as unknown as () => void)?.();
});

test("the voice model is never loaded: not selected, not loaded or background work blocked means waiting", async () => {
	const db = setup();
	reply(db, { contact: "julia", scope: "contact:julia", text: "Hello Julia." });
	for (const [o, why] of [
		[{ selected: null }, /no voice model is selected/],
		[{ loaded: false }, /the voice model is not available: voice-m is not loaded/],
		[{ blocked: "Iyye is asleep" }, /Iyye is asleep/],
	] as const) {
		const { shadow, calls } = voice(db, o as Opts);
		assert.equal(await shadow.drainOnce(), 0);
		assert.match(shadow.lastReason, why);
		assert.equal(calls.length, 0);
	}
	assert.equal(samples(db).length, 0, "waiting, not skipped: the work list is the delivered messages");
});

test("a sample holds the masked input, the check's verdict, and the character and mood as of the delivery", async () => {
	const db = setup();
	const at = ago(90);
	// Energy at the delivery was 0.3; later it was refilled to 1 (the voice must be given the earlier mood).
	db.prepare(
		"INSERT INTO energy_ledger (at, kind, amount, level_after, ref) VALUES (?, 'awake', -0.7, 0.3, 'x'), (?, 'refill_night', 0.7, 1, 'y')",
	).run(ago(100), ago(10));
	reply(db, { contact: "julia", scope: "contact:julia", text: "It costs 12 euros, Julia.", at });
	reply(db, { contact: "jacob", scope: "contact:jacob", text: "Your parcel arrived at 10:15.", at });
	reply(db, { contact: "jacob", scope: "contact:jacob", text: "Fine, see you at 8.", at });
	const outputs = ["It costs ⟦1⟧ dollars, ⟦2⟧.", "Good news: your parcel arrived at ⟦1⟧!", "Fine, see you at ⟦1⟧."];
	const { shadow, calls } = voice(db, { complete: () => outputs.shift()! });
	await shadow.drainOnce();
	const rows = samples(db);
	const euros = rows.find((r) => r.original.startsWith("It costs"))!;
	assert.equal(euros.masked, "It costs ⟦1⟧, ⟦2⟧.");
	assert.deepEqual(JSON.parse(euros.segments_json), ["12 euros", "Julia"]);
	assert.equal(euros.status, "refused");
	assert.match(euros.problem, /a placeholder was left in|dropped|added/);
	assert.equal(rows.find((r) => r.original.startsWith("Your parcel"))!.status, "accepted");
	assert.equal(rows.find((r) => r.original.startsWith("Fine"))!.status, "unchanged");
	for (const r of rows) {
		assert.equal(r.prompt_version, VOICE_PROMPT_VERSION);
		assert.equal(r.character_rev, 0);
		const mood = db.prepare("SELECT * FROM mood_samples WHERE id = ?").get(r.mood_sample_id) as Record<
			string,
			unknown
		>;
		assert.equal(mood.as_of, at);
		assert.equal(mood.energy, 0.3);
		assert.equal(mood.scope, r.scope);
	}
	assert.match(calls[0]!.system, /Mood: energy tired, /);
	assert.match(calls[0]!.system, /Style: not chosen yet/);
	assert.ok(
		!calls.some((c) => c.user.includes("Julia") || c.user.includes("12 euros")),
		"fixed segments never reach the voice",
	);
});

test("Russian messages get the instructions in Russian", async () => {
	const db = setup();
	reply(db, { contact: "julia", scope: "contact:julia", text: "Поезд уходит в 9:40 с третьей платформы." });
	const { shadow, calls } = voice(db);
	await shadow.drainOnce();
	assert.match(calls[0]!.system, /^Ты переписываешь/);
	assert.match(calls[0]!.user, /^Перепиши/);
	assert.equal(samples(db)[0]!.lang, "ru");
});

test("the evaluation split is fixed the first time an original is seen and sealed", async () => {
	const db = setup();
	const { shadow } = voice(db);
	const splits = Array.from({ length: 400 }, (_, i) => shadow.split(`x${i}`, `message number ${i}`));
	const share = splits.filter((s) => s === "eval").length / splits.length;
	assert.ok(share > 0.18 && share < 0.32, `${share}`);
	assert.equal(shadow.split("x1", "anything else"), splits[1], "fixed at first sight");
	// The same text (or template), however spaced or cased, lands on the same side: never in both.
	for (let i = 0; i < 40; i++) assert.equal(shadow.split(`dup${i}`, `  MESSAGE   number ${i} `), splits[i], `${i}`);
	assert.throws(() => db.prepare("UPDATE voice_split SET split = 'dev'").run(), /sealed/);
	assert.throws(() => db.prepare("DELETE FROM voice_split").run(), /sealed/);
	// Another installation's salt gives another split: it cannot be chosen after the fact.
	const other = voice(setup()).shadow;
	assert.notDeepEqual(
		Array.from({ length: 40 }, (_, i) => other.split(`x${i}`, `message number ${i}`)),
		splits.slice(0, 40),
	);
});

/** Samples with a known split, by forcing the action's split row before the voice sees it. */
async function labelled(db: Db, texts: { text: string; split: "eval" | "dev"; out?: string }[]) {
	const ids: string[] = [];
	for (const t of texts) {
		const a = reply(db, { contact: "jacob", scope: "contact:jacob", text: t.text });
		db.prepare("INSERT INTO voice_split (action_id, split, assigned_at) VALUES (?, ?, ?)").run(a, t.split, ago(0));
		ids.push(a);
	}
	const outs = texts.map((t) => t.out);
	const { shadow } = voice(db, {
		complete: (_s, u) => {
			const o = outs.shift();
			return o ?? echoMasked(u);
		},
	});
	await shadow.drainOnce();
	return ids.map((a) => (db.prepare("SELECT id FROM voice_samples WHERE action_id = ?").get(a) as { id: string }).id);
}
function commands(db: Db) {
	return new VoiceCommands({
		db,
		names: () => ["Julia", "Jacob"],
		status: () => ({ model: "voice-m", pending: 0, waiting: "nothing to rephrase" }),
		now: () => NOW,
	});
}

test("two labels kept apart: better needs a same meaning; changed withdraws better; the owner's wording must pass the check", async () => {
	const db = setup();
	const [a] = await labelled(db, [
		{ text: "The parcel may not have arrived; I could not check at 10:15.", split: "dev" },
	]);
	const v = commands(db);
	const id = a!.slice(0, 8);
	assert.match(v.command(["better", id], "owner_web"), /label its meaning first/);
	assert.match(v.command(["same", id], "owner_web"), /meaning of .*: same/);
	assert.match(v.command(["better", id], "owner_web"), /preference of .*: better/);
	assert.match(v.command(["changed", id], "owner_web"), /your "better" was withdrawn/);
	assert.equal(
		(db.prepare("SELECT count(*) AS n FROM voice_labels WHERE kind = 'preference'").get() as { n: number }).n,
		0,
	);
	assert.match(
		v.command(["correct", id, "The", "parcel", "arrived", "at", "10:15."], "owner_web"),
		/not kept: your wording does not pass the meaning check/,
	);
	assert.match(
		v.command(
			[
				"correct",
				id,
				"I",
				"could",
				"not",
				"check",
				"at",
				"10:15,",
				"so",
				"the",
				"parcel",
				"may",
				"not",
				"have",
				"arrived.",
			],
			"owner_web",
		),
		/kept your wording/,
	);
	assert.match(v.command(["show", id], "owner_web"), /your wording: "I could not check at 10:15/);
});

test("/voice next hides the check and Kev until labelled; /voice eval is recorded; the main report shows dev figures only", async () => {
	const db = setup();
	await labelled(db, [
		{ text: "Your parcel arrived at 10:15.", split: "eval" },
		{ text: "The meeting is at 9.", split: "dev" },
	]);
	const v = commands(db);
	const next = v.command(["next", "eval"], "owner_web");
	assert.match(next, /sealed evaluation set/);
	assert.match(next, /hidden until you label it/);
	assert.ok(!/check: /.test(next) && !/Kev "same meaning\?": \d/.test(next));
	const report = v.command([], "owner_web");
	assert.match(report, /2 \(1 dev, 1 in the sealed evaluation set\)/);
	assert.match(report, /dev split:\n {2}check: 1 accepted/);
	assert.ok(!report.includes("Your parcel"), "evaluation samples are not listed in the report");
	assert.match(v.command(["eval"], "owner_web"), /read 1 time\(s\)/);
	assert.match(v.command(["eval"], "owner_web"), /read 2 time\(s\)/);
	assert.equal((db.prepare("SELECT count(*) AS n FROM voice_eval_reads").get() as { n: number }).n, 2);
	assert.ok(isKnownCommand("/voice next"));
	assert.ok(isKnownCommand("/mood"));
	const out = await handleOwnerCommand("/voice", { db, models: {} as never, issuer: "owner_web", voice: v });
	assert.match(out.reply, /^voice \(rephrasings/);
});

test("the export: refused until the sealed set has labels; dev only; approved or owner-worded; masked and screened; with lineage", async () => {
	const db = setup();
	const [ev, good, worse, unlabelled, privy, owned] = await labelled(db, [
		{ text: "Your parcel arrived at 10:15.", split: "eval" },
		{ text: "The meeting moved to 9:30 in room 4.", split: "dev" },
		{ text: "I found 3 results for that.", split: "dev" },
		{ text: "Nothing new since 8.", split: "dev" },
		{ text: "Your doctor appointment is at 11.", split: "dev" },
		{ text: "The build finished at 14:02 with 2 warnings.", split: "dev" },
	]);
	const v = commands(db);
	const s = (id: string) => id.slice(0, 8);
	for (const id of [good!, worse!, privy!]) v.command(["same", s(id)], "owner_web");
	v.command(["better", s(good!)], "owner_web");
	v.command(["worse", s(worse!)], "owner_web");
	v.command(["better", s(privy!)], "owner_web");
	v.command(["correct", s(owned!), "Build done at 14:02, with 2 warnings."], "owner_web");
	const names = ["Julia", "Jacob"];
	assert.match((exportVoice(db, names) as { refused: string }).refused, /sealed evaluation set has no owner labels/);
	v.command(["same", s(ev!)], "owner_web");
	const ex = exportVoice(db, names);
	assert.ok(ex.ok);
	assert.deepEqual(
		ex.lineage.map((l) => l.sample_id),
		[good, owned],
	);
	assert.deepEqual(ex.examples[0], {
		system: (db.prepare("SELECT system FROM voice_samples WHERE id = ?").get(good) as { system: string }).system,
		input: "The meeting moved to ⟦1⟧ in room ⟦2⟧.",
		output: "Sure thing! The meeting moved to ⟦1⟧ in room ⟦2⟧.",
	});
	assert.equal(ex.examples[1]!.output, "Build done at ⟦1⟧, with ⟦2⟧ warnings.");
	assert.equal(ex.lineage[1]!.source, "owner wording");
	assert.equal(ex.lineage[0]!.person_id, "jacob");
	assert.deepEqual(ex.dropped, { "not preferred": 1, "private: health": 1 });
	assert.ok(!ex.lineage.some((l) => l.sample_id === unlabelled || l.sample_id === ev));
	assert.ok(!JSON.stringify(ex.examples).includes("14:02"), "the mapping never leaves");
	assert.equal(remask("Done at 14:02 on 3 servers.", ["3", "14:02"], []), "Done at ⟦2⟧ on ⟦1⟧ servers.");
	assert.equal(remask("Done at 15:00.", ["14:02"], []), null);
});

test("/forget: the person's samples and those naming them keep only ids, are never rephrased again; in-flight work is discarded", async () => {
	const db = setup();
	reply(db, { contact: "jacob", scope: "contact:jacob", text: "Your parcel arrived at 10:15." });
	reply(db, { contact: "owner", scope: "owner", text: "Jacob says the parcel arrived." });
	reply(db, { contact: "julia", scope: "contact:julia", text: "See you at 9." });
	const { shadow } = voice(db, { kev: true });
	await shadow.drainOnce();
	commands(db).command(["same", (samples(db)[0]!.id as string).slice(0, 8)], "owner_web");
	forgetRecords(db, { person: getContact(db, "jacob")!, scopes: ["contact:jacob"] } as never, "owner_web", ago(0));
	const rows = samples(db);
	const gone = rows.filter((r) => r.status === "forgotten");
	assert.equal(gone.length, 2);
	for (const r of gone) {
		assert.equal(r.original, "");
		assert.equal(r.candidate, null);
		assert.equal(r.mood_sample_id, null);
	}
	assert.equal(rows.find((r) => r.scope === "contact:julia")!.status, "accepted");
	assert.equal((db.prepare("SELECT count(*) AS n FROM voice_labels").get() as { n: number }).n, 0);
	assert.equal(
		(db.prepare("SELECT count(*) AS n FROM mood_samples WHERE scope = 'contact:jacob'").get() as { n: number }).n,
		0,
	);
	assert.equal(
		(
			db
				.prepare("SELECT count(*) AS n FROM decisions WHERE role = 'voice_meaning' AND state_json LIKE '%parcel%'")
				.get() as { n: number }
		).n,
		0,
	);
	assert.equal(shadow.pending(), 0, "never rephrased again");
	// In flight across a /forget: discarded.
	const db2 = setup();
	reply(db2, { contact: "julia", scope: "contact:julia", text: "See you at 9." });
	const { shadow: s2 } = voice(db2, {
		complete: (_s, u) => {
			forgetVoice(db2, ["contact:jacob"], ["jacob"], ["Jacob"]);
			return echoMasked(u);
		},
	});
	assert.equal(await s2.drainOnce(), 0);
	assert.match(s2.lastReason, /discarded: someone was forgotten meanwhile/);
	assert.equal(samples(db2).length, 0);
	// A short name forgets only whole-word mentions, never every sample containing its letters.
	const db3 = setup();
	reply(db3, { contact: "julia", scope: "contact:julia", text: "Also, Al will call at 9." });
	reply(db3, { contact: "julia", scope: "contact:julia", text: "All done at 9, totally normal." });
	await voice(db3).shadow.drainOnce();
	forgetVoice(db3, ["contact:al"], ["al"], ["Al"]);
	assert.deepEqual(
		samples(db3).map((r) => r.status),
		["forgotten", "accepted"],
	);
});

test("repeated replies (same masked text, other numbers) fall on one side of the sealed split", async () => {
	const db = setup();
	for (let i = 0; i < 12; i++)
		reply(db, {
			contact: "jacob",
			scope: "contact:jacob",
			text: `Your parcel arrives at ${8 + i}:00.`,
			at: ago(60 - i),
		});
	await voice(db).shadow.drainOnce();
	const sides = db.prepare("SELECT DISTINCT split FROM voice_split").all();
	assert.equal(sides.length, 1);
});

test("Kev's same-meaning question is asked in shadow about each candidate, under the sample's scope", async () => {
	const db = setup();
	reply(db, { contact: "julia", scope: "contact:julia", text: "Your parcel arrived at 10:15." });
	const { shadow, kevAsked } = voice(db, { kev: true });
	await shadow.drainOnce();
	assert.equal(kevAsked.length, 1);
	const k = kevAsked[0] as { role: string; scope: string; state: { message: string; rewording: string } };
	assert.equal(k.role, "voice_meaning");
	assert.equal(k.scope, "contact:julia");
	assert.equal(k.state.message, "Your parcel arrived at 10:15.");
	assert.equal(samples(db)[0]!.kev_same, 0.9);
	assert.equal(samples(db)[0]!.status, "accepted", "Kev's answer never changes the check's verdict");
});

test("the router call uses CH0's settings and accepts only a finished answer", async () => {
	const bodies: Record<string, unknown>[] = [];
	let finish = "stop";
	const server = createServer((req, res) => {
		let b = "";
		req.on("data", (c) => {
			b += c;
		});
		req.on("end", () => {
			bodies.push(JSON.parse(b));
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ choices: [{ message: { content: "<<< Hi ⟦1⟧ >>>" }, finish_reason: finish }] }));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	try {
		const call = routerVoice(url);
		assert.equal(await call("m", "sys", "user", 300, new AbortController().signal), "Hi ⟦1⟧");
		assert.equal(bodies[0]!.temperature, 0.3);
		assert.equal(bodies[0]!.repeat_penalty, 1);
		assert.equal(bodies[0]!.max_tokens, 300);
		assert.deepEqual(bodies[0]!.chat_template_kwargs, { enable_thinking: false });
		finish = "length";
		await assert.rejects(call("m", "sys", "user", 300, new AbortController().signal), /cut off/);
	} finally {
		server.close();
	}
});

test("style and mood never reach Pi: nothing under integration/pi or the turn path reads the character, mood or voice", () => {
	const dir = join(import.meta.dirname, "..", "src", "integration", "pi");
	for (const f of readdirSync(dir)) {
		const src = readFileSync(join(dir, f), "utf8");
		assert.ok(!/character\/|voice\//.test(src), `${f} imports the character or the voice`);
	}
	for (const f of ["kernel/scheduler.ts", "tools/broker.ts", "outbox/outbox.ts"]) {
		const src = readFileSync(join(import.meta.dirname, "..", "src", f), "utf8");
		assert.ok(!/character\/|voice\//.test(src), `${f} imports the character or the voice`);
	}
});
