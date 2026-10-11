// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.009 CH1a: the character's records. Revisions are immutable, every
 * change (undo and reset too) is a new one, `character.json` always mirrors
 * the active revision (rebuilt when missing or stale), and the owner commands
 * report, undo, freeze and reset. Nothing reads the values yet.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Character, changesBetween, STYLE_NAMES, startState, styleWord } from "../src/character/character.ts";
import { handleOwnerCommand, isKnownCommand } from "../src/kernel/commands.ts";
import { type Db, migrate, openDb } from "../src/state/db.ts";

const T0 = new Date("2026-10-11T10:00:00Z");

function setup() {
	const db: Db = openDb(":memory:");
	migrate(db);
	const dir = mkdtempSync(join(tmpdir(), "iyye-character-"));
	let t = T0.getTime();
	const now = () => {
		t += 60_000;
		return new Date(t);
	};
	const c = new Character({ db, stateDir: dir, now });
	const file = () => JSON.parse(readFileSync(join(dir, "character.json"), "utf8"));
	return { db, dir, c, file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the first start creates revision 0: temperament 1.0, style unset, no interests; character.json mirrors it", () => {
	const { db, c, file, done } = setup();
	try {
		const r = c.init();
		assert.equal(r.rev, 0);
		assert.equal(r.kind, "start");
		assert.deepEqual(file(), {
			revision: 0,
			kind: "start",
			created_at: r.created_at,
			frozen: false,
			watermark: null,
			temperament: { curiosity: 1, agency: 1, social: 1 },
			style: { length: null, warmth: null, playfulness: null, formality: null, observations: null, emoji: null },
			interests: [],
			controls: { critique: "off", perspective: "off", preset: "off", sarcasm: "off", audience: "owner-only" },
			sources: {
				temperament: { curiosity: "default", agency: "default", social: "default" },
				style: Object.fromEntries(STYLE_NAMES.map((d) => [d, "default"])),
				controls: {
					critique: "default",
					perspective: "default",
					preset: "default",
					sarcasm: "default",
					audience: "default",
				},
			},
		});
		// A restart adds nothing.
		c.init();
		assert.equal((db.prepare("SELECT count(*) AS n FROM character_revisions").get() as { n: number }).n, 1);
	} finally {
		done();
	}
});

test("revisions are immutable: the table refuses updates and deletes", () => {
	const { db, c, done } = setup();
	try {
		c.init();
		assert.throws(() => db.prepare("UPDATE character_revisions SET by = 'x'").run(), /immutable/);
		assert.throws(() => db.prepare("DELETE FROM character_revisions").run(), /immutable/);
	} finally {
		done();
	}
});

test("character.json is rebuilt at startup when missing, stale or damaged, and written atomically after every change", () => {
	const { dir, c, file, done } = setup();
	try {
		c.init();
		const path = join(dir, "character.json");
		rmSync(path);
		c.init();
		assert.equal(file().revision, 0);
		writeFileSync(path, "{ not json");
		c.init();
		assert.equal(file().revision, 0);
		const r1 = c.commit("owner", "owner_web", "test", (s, at) => {
			s.style.length = { value: 0.2, source: "owner", since: at };
		});
		assert.equal(file().revision, r1.rev);
		assert.equal(file().style.length, 0.2);
		writeFileSync(path, JSON.stringify({ ...file(), revision: 0 })); // stale
		c.init();
		assert.equal(file().revision, r1.rev);
		assert.deepEqual(readdirSync(dir), ["character.json"], "the temporary file was renamed, none left behind");
	} finally {
		done();
	}
});

test("a damaged snapshot with the right revision, frozen flag and watermark is still rebuilt", () => {
	const { dir, c, file, done } = setup();
	try {
		c.init();
		const path = join(dir, "character.json");
		const good = readFileSync(path, "utf8");
		const bad = file();
		bad.temperament.curiosity = 99;
		delete bad.style;
		writeFileSync(path, JSON.stringify(bad));
		c.init();
		assert.equal(readFileSync(path, "utf8"), good);
		writeFileSync(path, good.replace("\n}", ', "extra": 1\n}'));
		c.init();
		assert.equal(readFileSync(path, "utf8"), good, "any difference at all is rebuilt");
	} finally {
		done();
	}
});

test("reset commits its revision and its watermark together, even when the snapshot cannot be written", () => {
	const { dir, c, done } = setup();
	try {
		c.init();
		c.commit("review", "night", "night review", (s, at) => {
			s.temperament.agency = { value: 1.1, source: "review", since: at };
		});
		rmSync(dir, { recursive: true, force: true }); // the snapshot write fails
		assert.throws(() => c.command(["reset", "confirm"], "owner_web"));
		assert.equal(c.active().kind, "reset");
		assert.equal(c.watermark(), c.active().created_at);
	} finally {
		done();
	}
});

test("undo is a new revision back to the state before; undo twice puts it back; the start cannot be undone", () => {
	const { db, c, file, done } = setup();
	try {
		c.init();
		assert.match(c.command(["undo"], "owner_web"), /nothing to undo/);
		const r1 = c.commit("owner", "owner_web", "warmer", (s, at) => {
			s.style.warmth = { value: 0.8, source: "owner", since: at };
		});
		const undo = c.command(["undo"], "owner_web");
		assert.match(undo, /undone: revision 1; revision 2 is active\n {2}style warmth: warm \(0\.80\) → unset/);
		assert.equal(c.active().state.style.warmth.value, null);
		assert.equal(file().style.warmth, null);
		assert.match(c.command(["undo"], "owner_web"), /revision 3 is active\n {2}style warmth: unset → warm/);
		assert.equal(c.active().state.style.warmth.value, 0.8);
		assert.deepEqual(
			(db.prepare("SELECT rev, parent_rev, kind FROM character_revisions ORDER BY rev").all() as object[]).map(
				(r) => ({
					...r,
				}),
			),
			[
				{ rev: 0, parent_rev: null, kind: "start" },
				{ rev: r1.rev, parent_rev: 0, kind: "owner" },
				{ rev: 2, parent_rev: 1, kind: "undo" },
				{ rev: 3, parent_rev: 2, kind: "undo" },
			],
		);
		const diff = c.command(["diff", "2"], "owner_web");
		assert.match(
			diff,
			/^revision 3 \(active\): undo by owner_web, .* — undid revision 2\n {2}style warmth: unset → warm \(0\.80\) \(owner\)\nrevision 2: undo/,
		);
		assert.ok(!diff.includes("revision 1:"), "only the last two");
	} finally {
		done();
	}
});

test("freeze and unfreeze are recorded and mirrored; reset is shown first, keeps the owner's values and sets a watermark", () => {
	const { c, file, done } = setup();
	try {
		c.init();
		assert.match(c.command(["freeze"], "owner_web"), /^frozen/);
		assert.equal(file().frozen, true);
		assert.match(c.command(["freeze"], "owner_web"), /already frozen/);
		assert.match(c.report(), /frozen by owner_web/);
		assert.match(c.command(["unfreeze"], "owner_web"), /^unfrozen/);
		assert.equal(file().frozen, false);
		assert.match(c.command(["unfreeze"], "owner_web"), /not frozen/);

		// The owner's value, and (as CH5 will write them) learned ones.
		c.commit("owner", "owner_web", "the starting answer", (s, at) => {
			s.style.length = { value: 0.2, source: "owner", since: at };
		});
		c.commit("review", "night", "night review", (s, at) => {
			s.temperament.curiosity = { value: 1.02, source: "review", since: at };
			s.style.emoji = { value: 0.8, source: "review", since: at };
			s.interests.push({ text: "checks the workspace repository after commits", since: at });
		});
		const before = c.active().rev;
		const ask = c.command(["reset"], "owner_web");
		assert.match(
			ask,
			/keeps your own values; what Iyye learned goes \(temperament curiosity, style emoji, interest "checks the workspace repository after commits"\).*\/character reset confirm/,
		);
		assert.equal(c.active().rev, before, "nothing changes without confirm");
		assert.match(c.command(["reset", "confirm"], "owner_web"), /3 learned value\(s\) removed, your own values kept/);
		const s = c.active().state;
		assert.equal(c.active().kind, "reset");
		assert.equal(s.style.length.value, 0.2);
		assert.equal(s.style.length.source, "owner");
		assert.equal(s.style.emoji.value, null);
		assert.equal(s.temperament.curiosity.value, 1);
		assert.deepEqual(s.interests, []);
		assert.equal(c.watermark(), c.active().created_at);
		assert.equal(file().watermark, c.watermark());
		assert.equal(file().revision, c.active().rev);
	} finally {
		done();
	}
});

test("/character is an owner command with a report and usage; nothing else changes it", async () => {
	const { db, c, done } = setup();
	try {
		c.init();
		assert.ok(isKnownCommand("/character diff"));
		const out = await handleOwnerCommand("/character", {
			db,
			models: {} as never,
			issuer: "owner_web",
			character: c,
		});
		assert.match(out.reply, /character: revision 0 \(start/);
		assert.match(out.reply, /curiosity: 1\.00 \(default, since 2026-10-11\)/);
		assert.match(out.reply, /warmth: unset — Iyye will ask you/);
		assert.match(out.reply, /never in the chat model's prompt/);
		for (const bad of [["nonsense"], ["undo", "now"], ["reset", "please"], ["diff", "0"], ["diff", "x"]])
			assert.match(c.command(bad, "owner_web"), /^usage/, bad.join(" "));
		assert.equal((db.prepare("SELECT count(*) AS n FROM character_revisions").get() as { n: number }).n, 1);
	} finally {
		done();
	}
});

test("words for values and the differences between states", () => {
	assert.equal(styleWord("length", null), "unset");
	assert.equal(styleWord("length", 0.2), "short");
	assert.equal(styleWord("length", 0.5), "medium");
	assert.equal(styleWord("emoji", 0.8), "more");
	const a = startState(T0.toISOString());
	const b = structuredClone(a);
	b.temperament.social = { value: 0.98, source: "review", since: "x" };
	b.interests.push({ text: "likes Alpine geography questions", since: "x" });
	assert.deepEqual(changesBetween(a, b), [
		"temperament social: 1.00 → 0.98 (review)",
		"interest added: likes Alpine geography questions",
	]);
});
