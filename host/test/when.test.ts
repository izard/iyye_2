// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Plan 0.006 C0/C1: the host resolves reminder times; the prompt allows only recorded promises. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { operatingNote } from "../src/integration/pi/prompt.ts";
import { describeAt, parseWhen } from "../src/kernel/when.ts";

const NOW = new Date(2026, 9, 4, 14, 0); // Sunday 4 October 2026, 14:00 local
const at = (s: string) => {
	const r = parseWhen(s, NOW);
	return r.ok ? `${describeAt(r.at)}${r.defaulted ? " (default)" : ""}` : `ERR ${r.error}`;
};

test("the forms the reminder tool accepts, in local time", () => {
	assert.equal(at("tomorrow 9:00"), "Monday, 5 October 2026 09:00");
	assert.equal(at("tomorrow"), "Monday, 5 October 2026 09:00 (default)");
	assert.equal(at("in 2 hours"), "Sunday, 4 October 2026 16:00");
	assert.equal(at("in an hour"), "Sunday, 4 October 2026 15:00");
	assert.equal(at("in 20 minutes"), "Sunday, 4 October 2026 14:20");
	assert.equal(at("monday 18:30"), "Monday, 5 October 2026 18:30");
	assert.equal(at("sunday 10:00"), "Sunday, 11 October 2026 10:00", "a weekday is never today");
	assert.equal(at("next sunday"), "Sunday, 11 October 2026 09:00 (default)");
	assert.equal(at("18:30"), "Sunday, 4 October 2026 18:30");
	assert.equal(at("13:00"), "Monday, 5 October 2026 13:00", "a time already past is tomorrow");
	assert.equal(at("at 9:30 pm"), "Sunday, 4 October 2026 21:30");
	assert.equal(at("noon"), "Monday, 5 October 2026 12:00");
	assert.equal(at("12 October 12:00"), "Monday, 12 October 2026 12:00");
	assert.equal(at("october 12th at noon"), "Monday, 12 October 2026 12:00");
	assert.equal(at("3 october"), "Sunday, 3 October 2027 09:00 (default)", "no year: the next such date");
	assert.equal(at("2026-10-06 09:00"), "Tuesday, 6 October 2026 09:00");
	assert.equal(at("2026-10-06T09:00"), "Tuesday, 6 October 2026 09:00");
});

test("the past, impossible dates, more than a year ahead and unreadable forms are refused", () => {
	assert.match(at("2025-10-12 12:00"), /is in the past/);
	assert.match(at("today 10:00"), /is in the past/);
	assert.match(at("31 november"), /no such date/);
	assert.match(at("2026-02-30"), /no such date/);
	assert.match(at("in 400 days"), /more than a year ahead/);
	assert.match(at("yesterday"), /cannot read "yesterday": use a form like/);
	assert.match(at("tomorrow at teatime"), /not a time of day/);
});

test("with the reminders toolkit, a future action may exist only as a tool's record", () => {
	const kit = (name: string) => ({ name, description: name, effect: "read" as const, tools: [`${name}_tool: x`] });
	assert.match(operatingNote([kit("core"), kit("reminders")]), /A future action exists only if a tool created it/);
	assert.doesNotMatch(operatingNote([kit("core"), kit("reminders")]), /You cannot schedule anything/);
	assert.match(operatingNote([kit("core")]), /You cannot schedule anything or act outside this conversation/);
});
