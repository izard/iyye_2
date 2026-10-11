// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner decision 13 (plan 0.009): the affectionate skeptic with an idealist
 * perspective, as three separate controls. Owner-selected and allowlisted;
 * legacy revisions read as off; undo, reset and freeze behave; reasoning and
 * perspective reach only the owner's prompt, expression never; the voice
 * preset only adds refusals and speaks plainly about failures; samples keep
 * their configuration apart; the M4 fingerprint does not move while
 * everything is off.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Character, controlsOf, STYLE_NAMES, startState } from "../src/character/character.ts";
import {
	CONTROLS_OFF,
	controlsDigest,
	PERSPECTIVE_DEFS,
	REASONING_DEFS,
	renderMind,
	renderVoicePreset,
	VOICE_PRESET_DEFS,
} from "../src/character/policy.ts";
import { bindTurnProfile, liveControlsDigest } from "../src/character/profile.ts";
import { composeSystemPrompt } from "../src/integration/pi/prompt.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { behaviourFingerprint } from "../src/motivation/report.ts";
import { type Db, migrate, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { VoiceActor } from "../src/voice/act.ts";
import { presetProblem, voiceProblem } from "../src/voice/check.ts";
import { VoiceCommands } from "../src/voice/commands.ts";
import { voiceConfig } from "../src/voice/preset.ts";
import { forgetVoice, VoiceShadow } from "../src/voice/shadow.ts";

const T0 = new Date("2026-10-11T10:00:00Z");
const quiet = { warn() {}, info() {}, error() {}, debug() {} } as never;

function setup() {
	const db: Db = openDb(":memory:");
	migrate(db);
	let t = T0.getTime();
	const now = () => {
		t += 60_000;
		return new Date(t);
	};
	const changes: number[] = [];
	const c = new Character({ db, stateDir: null, now, onChange: (r) => changes.push(r.rev) });
	c.init();
	return { db, c, now, changes };
}

test("a revision written before the controls existed reads as all off; the row itself is never rewritten", () => {
	const { db, c } = setup();
	const legacy = startState(T0.toISOString()) as Partial<ReturnType<typeof startState>>;
	delete legacy.controls;
	const json = JSON.stringify(legacy);
	db.prepare(
		"INSERT INTO character_revisions (rev, created_at, parent_rev, kind, state_json, by, note) VALUES (1, ?, 0, 'owner', ?, 'owner_web', 'legacy')",
	).run(T0.toISOString(), json);
	const r = c.revision(1)!;
	assert.deepEqual(controlsOf(r.state), CONTROLS_OFF);
	assert.equal(r.state.controls.preset.source, "default");
	assert.equal(
		(db.prepare("SELECT state_json FROM character_revisions WHERE rev = 1").get() as { state_json: string })
			.state_json,
		json,
	);
});

test("the preset turns on critique and voice together, seeds unpinned dials and reports pinned ones; off puts back exactly what it seeded", () => {
	const { c, changes } = setup();
	// The owner pinned length before (a CH1b answer or /character set): the preset keeps it.
	c.commit("owner", "owner_web", "the starting answer", (s, at) => {
		s.style.length = { value: 0.8, source: "owner", since: at };
	});
	const out = c.command(["preset", "affectionate-skeptic"], "owner_web");
	assert.match(out, /the affectionate-skeptic preset is on/);
	assert.match(out, /reasoning critique: off → material-errors \(owner\)/);
	assert.match(out, /voice preset: off → affectionate-skeptic/);
	assert.match(out, /voice sarcasm: off → dry/);
	assert.match(out, /style warmth: unset → friendly \(0\.60\)/);
	assert.match(out, /kept your own dials: length long/);
	const s = c.active().state;
	assert.deepEqual(controlsOf(s), {
		critique: "material-errors",
		perspective: "off",
		preset: "affectionate-skeptic",
		sarcasm: "dry",
		audience: "owner-only",
	});
	assert.equal(s.controls.critique.definition, REASONING_DEFS["material-errors"]!.version);
	assert.equal(s.style.length.value, 0.8, "pinned");
	assert.equal(s.style.emoji.value, 0);
	assert.equal(s.style.observations.value, null, "never touched");
	assert.equal(s.temperament.curiosity.value, 1, "temperament unchanged");
	assert.match(
		c.command(["perspective", "berkeley-inspired"], "owner_web"),
		/reasoning perspective: off → berkeley-inspired/,
	);
	assert.match(c.command(["sarcasm", "pointed"], "owner_web"), /voice sarcasm: dry → pointed/);
	const off = c.command(["preset", "off"], "owner_web");
	assert.match(off, /the preset is off; ordinary voice expression/);
	const after = c.active().state;
	assert.deepEqual(controlsOf(after), {
		critique: "off",
		perspective: "berkeley-inspired",
		preset: "off",
		sarcasm: "off",
		audience: "owner-only",
	});
	for (const d of STYLE_NAMES)
		assert.deepEqual(after.style[d].value, d === "length" ? 0.8 : null, `${d} back to what it was`);
	for (const bad of [["preset", "cynic"], ["perspective", "solipsism"], ["sarcasm", "savage"], ["preset"]])
		assert.match(c.command(bad, "owner_web"), /^usage/, bad.join(" "));
	assert.ok(changes.length >= 4, "every change is reported for the trial boundary");
});

test("undo restores the selections, reset keeps the owner's, and freeze never blocks the owner", () => {
	const { c } = setup();
	assert.match(c.command(["freeze"], "owner_web"), /^frozen/);
	c.command(["preset", "affectionate-skeptic"], "owner_web");
	assert.equal(
		c.active().state.controls.preset.value,
		"affectionate-skeptic",
		"the owner's change applies while frozen",
	);
	assert.match(c.command(["undo"], "owner_web"), /voice preset: affectionate-skeptic → off/);
	assert.equal(c.active().state.controls.critique.value, "off");
	c.command(["undo"], "owner_web");
	c.command(["reset", "confirm"], "owner_web");
	assert.equal(c.active().state.controls.preset.value, "affectionate-skeptic", "the owner's selection survives reset");
	assert.match(c.report(), /voice preset: affectionate-skeptic \(skeptic-1\+tone-1\), yours since/);
	assert.match(c.command(["diff", "1"], "owner_web"), /reset by owner_web/);
});

test("reasoning and perspective reach only the owner's prompt, the same on every owner channel; expression never does", () => {
	const identity = "You are Iyye.";
	const all = {
		critique: "material-errors",
		perspective: "berkeley-inspired",
		preset: "affectionate-skeptic",
		sarcasm: "pointed",
		audience: "owner-only",
	} as const;
	const mind = renderMind(all)!;
	assert.match(mind.text, /material errors/);
	assert.match(mind.text, /Berkeley-inspired/);
	assert.deepEqual(mind.versions, ["critique-1", "berkeley-2", "tone-1:pointed"]);
	const web = composeSystemPrompt(identity, { kind: "owner", channel: "web" }, [], mind.text);
	const tg = composeSystemPrompt(identity, { kind: "owner", channel: "telegram" }, [], mind.text);
	assert.equal(web, tg);
	assert.ok(web.includes(REASONING_DEFS["material-errors"]!.text));
	assert.ok(web.includes(PERSPECTIVE_DEFS["berkeley-inspired"]!.text));
	const def = VOICE_PRESET_DEFS["affectionate-skeptic"]!;
	// Decision 14: the preset's manner in words; never the voice's own rules, the dials, the style header or the mood.
	assert.match(web, /affectionate-skeptic manner with them: friendly, with pointed, teasing sarcasm/);
	for (const forbidden of [def.en, def.ru, def.sarcasm.pointed.en, "Style:", "Mood:", "warmth", "0.65", "playfulness"])
		assert.ok(!web.includes(forbidden), forbidden);
	const contact = { kind: "contact", displayName: "Julia", channel: "telegram" } as const;
	assert.equal(composeSystemPrompt(identity, contact, [], mind.text), composeSystemPrompt(identity, contact, []));
	assert.equal(
		composeSystemPrompt(identity, { kind: "background" }, [], mind.text),
		composeSystemPrompt(identity, { kind: "background" }, []),
	);
	assert.equal(renderMind(CONTROLS_OFF), null);
	assert.deepEqual(
		renderMind({ ...CONTROLS_OFF, preset: "affectionate-skeptic", sarcasm: "dry" })?.versions,
		["tone-1:dry"],
		"the preset alone adds only its tone",
	);
	assert.equal(
		renderMind({ ...CONTROLS_OFF, preset: "affectionate-skeptic", sarcasm: "dry" }, { preset: "skeptic-1" }),
		null,
		"a selection made before decision 14 has no tone until it is selected again",
	);
});

test("the turn's profile is bound once and recorded; contacts' turns get no reasoning text", () => {
	const { db, c } = setup();
	c.command(["preset", "affectionate-skeptic"], "owner_web");
	for (const [id, scope, contact] of [
		["e1", "owner", "owner"],
		["e2", "contact:julia", "julia"],
	] as const) {
		if (contact !== "owner")
			db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES (?, 'Julia', 'contact', ?)").run(
				contact,
				T0.toISOString(),
			);
		db.prepare(
			"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'telegram', ?, ?, ?, '{}', 'admitted')",
		).run(id, id, contact, scope, T0.toISOString());
	}
	const p1 = bindTurnProfile(db, c, "j1", getEvent(db, "e1")!, T0);
	assert.match(p1.mind!, /material errors/);
	const p2 = bindTurnProfile(db, c, "j2", getEvent(db, "e2")!, T0);
	assert.equal(p2.mind, null);
	const rows = db
		.prepare("SELECT job_id, character_rev, mind_versions_json, mind_digest FROM turn_profiles ORDER BY job_id")
		.all() as {
		job_id: string;
		character_rev: number;
		mind_versions_json: string;
		mind_digest: string | null;
	}[];
	assert.deepEqual(
		rows.map((r) => [r.job_id, r.character_rev, JSON.parse(r.mind_versions_json)]),
		[
			["j1", c.active().rev, ["critique-1", "tone-1:dry"]],
			["j2", c.active().rev, []],
		],
	);
	// A change after binding does not touch the bound profile.
	c.command(["preset", "off"], "owner_web");
	assert.equal(p1.controls.preset, "affectionate-skeptic");
});

test("the M4 fingerprint is unchanged while everything is off; a selection changes it", () => {
	const { db, c } = setup();
	const settings = { threshold: 0.55, shares: { curiosity: 0.4 } };
	const off = liveControlsDigest(db);
	assert.equal(off, null);
	assert.equal(
		behaviourFingerprint({ ...settings, ...(off ? { character: off } : {}) }),
		behaviourFingerprint(settings),
	);
	c.command(["perspective", "berkeley-inspired"], "owner_web");
	const on = liveControlsDigest(db)!;
	assert.match(on, /^[0-9a-f]{12}$/);
	assert.notEqual(behaviourFingerprint({ ...settings, character: on }), behaviourFingerprint(settings));
	assert.equal(controlsDigest(CONTROLS_OFF), null);
});

test("the voice preset: owner messages only, plain about failures and private matters, and it only adds refusals", () => {
	const on = { ...CONTROLS_OFF, critique: "material-errors", preset: "affectionate-skeptic", sarcasm: "dry" } as const;
	const owner = voiceConfig(on, "owner", "en", "That follows only if both premises hold.");
	assert.ok(owner.presetText?.includes("dry wit"));
	assert.match(owner.version, /\+skeptic-1\.[0-9a-f]{6}:dry$/);
	assert.equal(voiceConfig(on, "trusted", "en", "x").presetText, null, "contacts keep their voice");
	assert.equal(voiceConfig(on, "contact", "en", "x").presetText, null);
	assert.equal(voiceConfig(CONTROLS_OFF, "owner", "en", "x").presetText, null, "preset off: ordinary expression");
	const failed = voiceConfig(on, "owner", "en", "I could not reach the server.");
	assert.ok(failed.plain && failed.presetText!.includes("Wit: none"));
	assert.ok(voiceConfig(on, "owner", "en", "Your doctor appointment is at 11.").plain, "a private matter is plain");
	assert.match(renderVoicePreset(on, "ru", false)!.text, /^Сохрани каждое утверждение/);
	// Refusals only: added criticism, metaphysics, disparagement; an idealist metaphor already there may stay.
	assert.match(presetProblem("The meeting is at 9.", "Actually, the meeting is at 9.") ?? "", /criticism/);
	assert.match(presetProblem("The meeting is at 9.", "As perceived, the meeting is at 9.") ?? "", /idealist/);
	assert.match(
		presetProblem("You missed a premise.", "You silly thing, you missed a premise.") ?? "",
		/disparagement/,
	);
	assert.equal(
		presetProblem("As Berkeley would say, it exists as perceived.", "It exists as perceived, as Berkeley would say."),
		null,
	);
	assert.match(presetProblem("Встреча в 9.", "На самом деле встреча в 9.") ?? "", /criticism/);
	// It never makes a refused rewording acceptable: the meaning check runs first and alone decides those.
	assert.ok(voiceProblem("It is not raining.", "It is raining.") !== null);
});

function telegramReply(db: Db, id: string, scope: string, contact: string, text: string, at: string) {
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'telegram', ?, ?, ?, '{}', 'answered')",
	).run(id, id, contact, scope, at);
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', ?, 'h', ?, 'delivered', ?, ?)",
	).run(`a-${id}`, id, JSON.stringify({ channel: "telegram", chatId: 1 }), `k-${id}`, at, text);
	return `a-${id}`;
}

test("acting: the bound profile's preset shapes the owner's message; a refusal is never sent; preset off is ordinary CH4", async () => {
	const { db, c } = setup();
	db.prepare(
		"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('owner-tg', 'Alex', 'contact', ?)",
	).run(T0.toISOString());
	db.prepare(
		"INSERT INTO contact_links (account_id, person_id, linked_by, linked_at) VALUES ('owner-tg', 'owner', 'owner_web', ?)",
	).run(T0.toISOString());
	const systems: string[] = [];
	let reply = (u: string) => `Right, so: ${/<<<\n([\s\S]*)\n>>>/.exec(u)![1]}`;
	const v = new VoiceActor({
		db,
		log: quiet,
		models: {
			selected: () => "voice-m",
			acquire: async (name) => ({ model: name, valid: () => true, release() {} }),
		},
		complete: async (_m, system, user) => {
			systems.push(system);
			return reply(user);
		},
		character: c,
		names: () => [],
		effectToolkits: () => new Set(),
	});
	v.command(["on", "owner"], "owner_web");
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('e1', 'e1', 'telegram', 'owner-tg', 'owner', ?, '{}', 'admitted')",
	).run(T0.toISOString());
	const e = getEvent(db, "e1")!;
	const original = "That follows only if both premises hold; the second is uncertain.";
	// Bound with the preset on; the owner turns it off mid-turn: this message still uses the bound one.
	c.command(["preset", "affectionate-skeptic"], "owner_web");
	const bound = c.active();
	c.command(["preset", "off"], "owner_web");
	const r = await v.rephrase(e, original, new AbortController().signal, bound);
	assert.ok(systems[0]!.includes("dry wit"));
	assert.equal(r.content, `Right, so: ${original}`);
	// Added criticism: refused, the reasoner's original goes out.
	reply = (u) => `Actually, ${/<<<\n([\s\S]*)\n>>>/.exec(u)![1]}`;
	const refused = await v.rephrase(e, original, new AbortController().signal, bound);
	assert.equal(refused.content, original);
	// Preset off (the active revision now): ordinary expression, no preset text.
	reply = (u) => `Right, so: ${/<<<\n([\s\S]*)\n>>>/.exec(u)![1]}`;
	await v.rephrase(e, original, new AbortController().signal, c.active());
	assert.ok(!systems.at(-1)!.includes("dry wit"));
});

test("shadow: the delivery's configuration, experiments as their own samples on owner messages, sealed split reused, forgotten never back", async () => {
	const { db, c } = setup();
	db.prepare("INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('julia', 'Julia', 'contact', ?)").run(
		T0.toISOString(),
	);
	const at = new Date(Date.now() - 3_600_000).toISOString();
	const own = telegramReply(db, "o1", "owner", "owner", "The second premise is uncertain.", at);
	telegramReply(db, "j1", "contact:julia", "julia", "See you at 9.", at);
	const systems: string[] = [];
	const shadow = new VoiceShadow({
		db,
		log: quiet,
		device: new DeviceSlot(),
		models: {
			selected: () => "voice-m",
			acquire: async (name) => ({ model: name, valid: () => true, release() {} }),
		},
		background: { blockedReason: () => null, yieldReason: () => null },
		complete: async (_m, system, user) => {
			systems.push(system);
			return `Well: ${/<<<\n([\s\S]*)\n>>>/.exec(user)![1]}`;
		},
		character: c,
		names: () => ["Julia"],
	});
	assert.equal(await shadow.drainOnce(), 2, "the delivered messages, as they were delivered (preset off then)");
	assert.ok(!systems.some((s) => s.includes("dry wit")));
	const cmds = new VoiceCommands({
		db,
		names: () => [],
		status: () => ({ model: "voice-m", pending: 0, waiting: "" }),
	});
	assert.match(
		cmds.command(["experiment", "affectionate-skeptic", "dry"], "owner_web"),
		/affectionate-skeptic:dry:skeptic-1/,
	);
	assert.equal(await shadow.drainOnce(), 1, "only the owner's message gets the experiment");
	assert.ok(systems.at(-1)!.includes("dry wit"));
	const rows = db
		.prepare("SELECT action_id, prompt_version, experiment_json FROM voice_samples ORDER BY rowid")
		.all() as {
		action_id: string;
		prompt_version: string;
		experiment_json: string | null;
	}[];
	const exp = rows.find((r) => r.experiment_json)!;
	assert.equal(exp.action_id, own);
	assert.match(exp.prompt_version, /#affectionate-skeptic:dry:skeptic-1$/);
	assert.equal(JSON.parse(exp.experiment_json!).preset, "affectionate-skeptic");
	assert.equal(
		(db.prepare("SELECT count(*) AS n FROM voice_split WHERE action_id = ?").get(own) as { n: number }).n,
		1,
		"one split per original",
	);
	assert.equal(await shadow.drainOnce(), 0, "nothing repeats");
	// A pointed experiment is another identity; a forgotten original comes back under none.
	cmds.command(["experiment", "affectionate-skeptic", "pointed"], "owner_web");
	forgetVoice(db, ["owner"], [], []);
	assert.equal(await shadow.drainOnce(), 0, "forgotten originals never reappear under another experiment");
});

test("the fixed English/Russian set: every ok rewording passes both checks, every bad one is refused, plain cases are plain", async () => {
	const { readFileSync } = await import("node:fs");
	const cases = JSON.parse(readFileSync(new URL("./fixtures/skeptic-cases.json", import.meta.url), "utf8")) as {
		reasoning: { id: string; lang: string }[];
		voice: {
			id: string;
			lang: "en" | "ru";
			original: string;
			plain?: boolean;
			ok: string[];
			bad: { text: string; why: string }[];
			known_gaps?: { text: string; why: string }[];
			known_false_rejects?: { text: string; why: string }[];
		}[];
	};
	assert.ok(cases.reasoning.some((r) => r.lang === "ru") && cases.reasoning.some((r) => r.lang === "en"));
	const on = { ...CONTROLS_OFF, critique: "material-errors", preset: "affectionate-skeptic", sarcasm: "dry" } as const;
	const names = ["Julia", "Юля"];
	const check = (o: string, r: string) => voiceProblem(o, r, names) ?? presetProblem(o, r);
	for (const c of cases.voice) {
		for (const ok of c.ok) assert.equal(check(c.original, ok), null, `${c.id}: ${ok}`);
		for (const bad of c.bad) assert.notEqual(check(c.original, bad.text), null, `${c.id}: ${bad.why}`);
		// Known gaps stay visible: when the check learns to refuse one, move it to `bad`.
		for (const gap of c.known_gaps ?? []) assert.equal(check(c.original, gap.text), null, `${c.id}: no longer a gap`);
		for (const fr of c.known_false_rejects ?? [])
			assert.notEqual(check(c.original, fr.text), null, `${c.id}: no longer refused, move it to ok`);
		assert.equal(voiceConfig(on, "owner", c.lang, c.original).plain, c.plain === true, `${c.id} plain`);
	}
});

test("decision 14: a selection renders the definition it was made under; selecting again updates it, as a recorded change", () => {
	const { db, c } = setup();
	// A berkeley-1 selection and a skeptic-1 preset, as made before decision 14 (written as the host wrote them then).
	c.commit("owner", "owner_web", "before decision 14", (s, at) => {
		s.controls.perspective = { value: "berkeley-inspired", source: "owner", since: at, definition: "berkeley-1" };
		s.controls.critique = { value: "material-errors", source: "owner", since: at, definition: "critique-1" };
		s.controls.preset = { value: "affectionate-skeptic", source: "owner", since: at, definition: "skeptic-1" };
		s.controls.sarcasm = { value: "dry", source: "owner", since: at, definition: "sarcasm:dry" };
	});
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('e1', 'e1', 'web', 'owner', 'owner', ?, '{}', 'admitted')",
	).run(T0.toISOString());
	const old = bindTurnProfile(db, c, "j1", getEvent(db, "e1")!, T0);
	assert.match(old.mind!, /Explore what observations establish when relevant/);
	assert.ok(!old.mind!.includes("affectionate-skeptic manner"), "no tone under skeptic-1");
	const before = liveControlsDigest(db);
	assert.match(c.command(["perspective", "berkeley-inspired"], "owner_web"), /now uses berkeley-2 \(was berkeley-1\)/);
	assert.match(
		c.command(["preset", "affectionate-skeptic"], "owner_web"),
		/now uses skeptic-1\+tone-1 \(was skeptic-1\)/,
	);
	assert.match(
		c.command(["diff", "1"], "owner_web"),
		/voice preset: affectionate-skeptic, definition skeptic-1 → skeptic-1\+tone-1/,
	);
	const now = bindTurnProfile(db, c, "j2", getEvent(db, "e1")!, T0);
	assert.match(now.mind!, /let it show/);
	assert.match(now.mind!, /not solipsism/);
	assert.match(now.mind!, /dry, teasing wit/);
	assert.notEqual(liveControlsDigest(db), before, "an update is a trial boundary too");
	assert.match(c.command(["preset", "affectionate-skeptic"], "owner_web"), /already on/);
});
