// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.009 CH0: the voice's meaning check. Every original passes as its own
 * rephrasing, faithful paraphrases pass, and every kind of meaning change is
 * refused. The labelled sets (synthetic, English and Russian):
 * `voice-pairs.json` and `voice-pairs-ch0-heldout.json` developed the check
 * (the second was CH0's held-out set and has been tuned on since);
 * `voice-pairs-heldout.json` was written before the second revision and is
 * never used to tune it.
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

test("dates in words: weekdays, months and relative days, compared by what they name", () => {
	const s = fixedSegments(
		"Tuesday's meetings moved to May 3; may I remind you tomorrow? Во вторник, 5 мая, завтракаем.",
		NAMES,
	)
		.filter((x) => x.kind === "date")
		.map((x) => x.text);
	assert.deepEqual(s, ["Tuesday's", "May", "tomorrow", "вторник", "мая"]);
	assert.equal(fixedSegments("May I ask?", NAMES).length, 0);
	assert.equal(voiceProblem("I can't see Tuesday's meetings.", "I can't see the meetings on Tuesday.", NAMES), null);
	assert.equal(voiceProblem("Встреча во вторник.", "Вторник: встреча.", NAMES), null);
	assert.match(voiceProblem("Встреча во вторник.", "Встреча в среду.", NAMES) ?? "", /date:wd:tue/);
	assert.match(voiceProblem("Оплата до 25 августа.", "Оплата до 25 сентября.", NAMES) ?? "", /date:mo:8/);
	assert.match(voiceProblem("It rained yesterday.", "It rained today.", NAMES) ?? "", /date:day:-1/);
	assert.match(
		voiceProblem("Good morning! I'm here if you need anything.", "Good morning! I'm busy today.", NAMES) ?? "",
		/added date/,
	);
});

test("a possessive is the same name", () => {
	assert.equal(voiceProblem("Julia's flight lands at 9.", "The flight Julia is on lands at 9.", NAMES), null);
	assert.equal(voiceProblem("Anna's cat is fine.", "The cat of Anna is fine.", NAMES), null);
});

test("tense: a past event may not become a future one, nor the reverse", () => {
	assert.match(
		voiceProblem("Anna said the parcel arrived.", "Anna said the parcel will arrive.", NAMES) ?? "",
		/past event became a future/,
	);
	assert.match(
		voiceProblem("Julia will be late, she wrote.", "Julia was late, she wrote.", NAMES) ?? "",
		/future event became a past/,
	);
	assert.match(
		voiceProblem("Добавила молоко в список.", "Добавлю молоко в список.", NAMES) ?? "",
		/tense of "добавила"/,
	);
	assert.match(
		voiceProblem("The router restarted twice.", "The router restarts twice.", NAMES) ?? "",
		/tense of "restarted"/,
	);
	// Not a change: the same act in the passive, "she'd" as the future seen from the past, present to future.
	assert.equal(voiceProblem("Добавила молоко в список.", "Молоко добавлено в список.", NAMES), null);
	assert.equal(voiceProblem("Julia wrote that she will be late.", "Julia wrote she'd be late.", NAMES), null);
	assert.equal(
		voiceProblem("The train leaves from platform 4.", "The train will leave from platform 4.", NAMES),
		null,
	);
});

test("a replaced reason that keeps one negation is refused", () => {
	assert.match(
		voiceProblem(
			"I don't have access to your calendar, so I can't see Tuesday's meetings.",
			"I checked your calendar: Tuesday has no meetings.",
			NAMES,
		) ?? "",
		/dropped a negation/,
	);
});

test("the development pairs: every one judged as labelled", () => {
	assert.deepEqual(errors("voice-pairs.json"), { falseAccepts: [], falseRejects: [] });
});

test("CH0's held-out pairs (development since the second revision): the known misses", () => {
	assert.deepEqual(errors("voice-pairs-ch0-heldout.json"), {
		// A Russian future without a marker, from another stem ("пришла" → "придёт").
		falseAccepts: ["Анна сказала, что посылка придёт в понедельник."],
		// A report of something done said as a state, or with a verb the check does not know as one.
		falseRejects: ["Milk and eggs are now on the shopping list.", "I put milk and eggs on the shopping list."],
	});
});

test("the held-out pairs (never used to tune the check): no worse than measured", () => {
	// Second revision (2026-10-10), measured once: 4 of 24 changed rephrasings accepted (a tense change of a
	// verb without a past form, a question reported as an answer, a future without a past beside it, a state
	// read as a deadline), 5 of 24 faithful ones refused (negations added or dropped by idioms: "don't forget",
	// "rather than", "не позже", "молчит"; a passive report said actively). The CH0 check on this set: 14 and 5.
	// A regression bound, not a target.
	const e = errors("voice-pairs-heldout.json");
	assert.ok(e.falseAccepts.length <= 4, `false accepts: ${e.falseAccepts.join(" | ")}`);
	assert.ok(e.falseRejects.length <= 5, `false rejects: ${e.falseRejects.join(" | ")}`);
});

test("units and currencies belong to their number: another unit, or none, is refused", () => {
	assert.match(voiceProblem("It costs 12 euros.", "It costs 12 dollars.", NAMES) ?? "", /number:12 eur/);
	assert.match(voiceProblem("It costs 12 euros.", "It costs 12.", NAMES) ?? "", /number:12 eur/);
	assert.match(voiceProblem("It costs 12.", "It costs 12 euros.", NAMES) ?? "", /dropped number:12$/);
	assert.match(voiceProblem("Disk is 85% full.", "Disk is 85 GB full.", NAMES) ?? "", /number:85 percent/);
	assert.match(voiceProblem("Wait 5 minutes.", "Wait 5 hours.", NAMES) ?? "", /number:5 minute/);
	assert.match(voiceProblem("Подожди 5 минут.", "Подожди 5 часов.", NAMES) ?? "", /number:5 minute/);
	assert.match(voiceProblem("Это стоит 300 рублей.", "Это стоит 300 долларов.", NAMES) ?? "", /number:300 rub/);
	// The same unit in another form is the same.
	assert.equal(voiceProblem("It costs 12 euros.", "The price is €12.", NAMES), null);
	assert.equal(voiceProblem("Disk is 85% full.", "The disk is 85 percent full.", NAMES), null);
	assert.equal(voiceProblem("It took 3h.", "It took 3 hours.", NAMES), null);
	assert.equal(voiceProblem("Это стоит 300 рублей.", "Цена: 300 руб.", NAMES), null);
	// …nor can it name another currency beside the placeholder.
	assert.match(voiceProblem("It costs 12 euros.", "It costs 12 euros dollars.", NAMES) ?? "", /added a currency/);
	// The unit travels inside the placeholder, so the voice cannot change it.
	assert.deepEqual(maskFixed("Send Julia 12 euros.", NAMES).segments, ["Julia", "12 euros"]);
});

test("a negation inside a word is a negation: dropping or adding its prefix is refused", () => {
	assert.match(
		voiceProblem("Это неверно: в феврале 29 дней.", "Это верно: в феврале 29 дней.", NAMES) ?? "",
		/неверно/,
	);
	assert.match(voiceProblem("That is incorrect.", "That is correct.", NAMES) ?? "", /incorrect/);
	assert.match(voiceProblem("The fix is possible today.", "The fix is impossible today.", NAMES) ?? "", /impossible/);
	assert.equal(voiceProblem("That is incorrect.", "That's incorrect, I'm afraid.", NAMES), null);
});
