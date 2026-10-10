// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.009 CH0: the voice's meaning check. Every original passes as its own
 * rephrasing, faithful paraphrases pass, and every kind of meaning change is
 * refused. `test/fixtures/voice-pairs.json` is the labelled set the spike
 * measures the check's error rates on (synthetic, English and Russian).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fixedSegments, maskFixed, unmask, voiceProblem } from "../src/voice/check.ts";

const NAMES = ["Julia", "Jacob", "Юля"];

test("fixed segments: numbers, times, URLs, files, hashes, quotes, mentions, names", () => {
	const s = fixedSegments(
		'Julia, the build 3f2a9c1 failed at 14:30 on 12.10.2026; see https://example.org/x and host/src/main.ts, @iyye_bot said "retry later". Ask Paris office.',
		NAMES,
	).map((x) => `${x.kind}:${x.text}`);
	assert.deepEqual(s, [
		"name:Julia",
		"hash:3f2a9c1",
		"number:14:30",
		"number:12.10.2026",
		"url:https://example.org/x",
		"path:host/src/main.ts",
		"mention:@iyye_bot",
		'quote:"retry later"',
		"name:Paris",
	]);
});

test("an original passes as its own rephrasing; faithful paraphrases pass", () => {
	for (const t of [
		"I could not reach the weather service, so I don't know if it will rain in Lisbon tomorrow.",
		"Готово: напоминание на 18:00 записано.",
		"Jacob asked me to tell you the meeting moved to 3 pm.",
	])
		assert.equal(voiceProblem(t, t, NAMES), null, t);
	assert.equal(
		voiceProblem(
			"The disk has 120 GB free and the backup finished at 02:10.",
			"Backup done at 02:10, and there are 120 GB of free disk space.",
			NAMES,
		),
		null,
	);
	assert.equal(
		voiceProblem("Julia wrote that she will be late.", "Just so you know, Julia wrote she'd be late.", NAMES),
		null,
	);
});

test("every kind of meaning change is refused", () => {
	const o = "I sent the reminder to Julia for 18:00, but the weather lookup failed.";
	const cases: [string, RegExp][] = [
		["I sent the reminder to Julia for 19:00, but the weather lookup failed.", /number/],
		["I sent the reminder for 18:00, but the weather lookup failed.", /dropped name:julia/],
		["I sent the reminder to Julia and Anna for 18:00, but the weather lookup failed.", /added name:anna/],
		["I sent the reminder to Julia for 18:00, and the weather lookup worked.", /failure/],
		["I sent the reminder to Julia for 18:00 and I'll check the weather again, but the lookup failed.", /promise/],
		["Напоминание для Julia на 18:00 отправлено, но погода не загрузилась.", /language/],
		["Reminder sent.", /too short|dropped/],
	];
	for (const [r, why] of cases) assert.match(voiceProblem(o, r, NAMES) ?? "accepted", why, r);
	assert.match(voiceProblem("It is not raining in Oslo.", "It is raining in Oslo.", NAMES) ?? "", /negation/);
	assert.match(voiceProblem("It will probably rain.", "It will rain.", NAMES) ?? "", /hedge/);
	assert.match(
		voiceProblem("Не удалось отправить сообщение.", "Сообщение отправлено.", NAMES) ?? "",
		/failure|negation/,
	);
});

test("placeholders: masked, put back, and refused when lost, repeated, invented or damaged", () => {
	const t = "Julia: the build 3f2a9c1 finished at 14:30.";
	const { masked, segments } = maskFixed(t, NAMES);
	assert.equal(masked, "⟦1⟧: the build ⟦2⟧ finished at ⟦3⟧.");
	assert.equal(unmask("At ⟦3⟧, ⟦1⟧, build ⟦2⟧ was done.", segments), "At 14:30, Julia, build 3f2a9c1 was done.");
	assert.deepEqual(unmask("Build ⟦2⟧ done at ⟦3⟧.", segments), { why: "placeholder 1 was dropped" });
	assert.deepEqual(unmask("⟦1⟧ ⟦1⟧ ⟦2⟧ ⟦3⟧", segments), { why: "placeholder 1 was repeated" });
	assert.deepEqual(unmask("⟦1⟧ ⟦2⟧ ⟦3⟧ ⟦4⟧", segments), { why: "placeholder 4 was invented" });
	assert.deepEqual(unmask("⟦1⟧ ⟦2⟧ ⟦3⟧ ⟦", segments), { why: "a placeholder was damaged" });
	assert.equal(voiceProblem(t, "⟦1⟧ build done", NAMES), "a placeholder was left in");
});

type Pair = { original: string; rephrased: string; same: boolean; lang: string };
const errors = (file: string) => {
	const pairs = JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as Pair[];
	const wrong = pairs.filter((p) => (voiceProblem(p.original, p.rephrased, NAMES) === null) !== p.same);
	return {
		falseAccepts: wrong.filter((p) => !p.same).map((p) => p.rephrased),
		falseRejects: wrong.filter((p) => p.same).map((p) => p.rephrased),
	};
};

test("the development pairs: the one known false accept is added content with nothing fixed in it", () => {
	assert.deepEqual(errors("voice-pairs.json"), {
		falseAccepts: ["Good morning! I'm busy today."],
		falseRejects: [],
	});
});

test("the held-out pairs (never used to tune the check): no worse than measured at CH0", () => {
	// CH0 (2026-10-10): 5 of 24 changed rephrasings accepted (a tense, a lowercase Russian weekday, a negation
	// count), 3 of 24 faithful ones refused (a possessive name, a passive report). A regression bound, not a target.
	const e = errors("voice-pairs-heldout.json");
	assert.ok(e.falseAccepts.length <= 5, `false accepts: ${e.falseAccepts.join(" | ")}`);
	assert.ok(e.falseRejects.length <= 3, `false rejects: ${e.falseRejects.join(" | ")}`);
});
