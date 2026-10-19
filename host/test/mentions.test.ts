// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionsAny } from "../src/memory/mentions.ts";

test("mentionsAny: whole names in any case and script; a longer name or a word inside another is not one", () => {
	assert.ok(mentionsAny("When is Julia's birthday?", ["julia"]));
	assert.ok(mentionsAny("JULIA said hi", ["julia"]));
	assert.ok(!mentionsAny("Juliana said hi", ["julia"]));
	assert.ok(mentionsAny("Привет, Юлия!", ["юлия"]));
	assert.ok(!mentionsAny("Юлиана", ["юлия"]));
	assert.ok(mentionsAny("Alex   Komarov wrote", ["alex komarov"]), "spaces inside a name may vary");
	assert.ok(mentionsAny('{"text":"ask Jacob"}', ["jacob"]), "inside JSON text");
	assert.ok(!mentionsAny("ab", ["a.b"]), "special characters are escaped, never a pattern");
	assert.ok(mentionsAny("say a.b now", ["a.b"]));
	assert.ok(!mentionsAny("anything", []));
});
