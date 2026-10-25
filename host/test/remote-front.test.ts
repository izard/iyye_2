// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { watchStall } from "../scripts/remote-front.ts";

function fakeRes() {
	const res = Object.assign(new EventEmitter(), {
		writableNeedDrain: false,
		destroyed: false,
		destroy() {
			res.destroyed = true;
			return res;
		},
	});
	return res;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("watchStall ends an answer nobody reads, and leaves a slow or quiet one alone (2026-10-19)", async () => {
	const stalled = fakeRes();
	watchStall(stalled as never, 60, 10);
	stalled.writableNeedDrain = true;
	await tick(120);
	assert.ok(stalled.destroyed);

	// Draining now and then (a slow reader) resets the clock; a server sending nothing is never ended.
	const slow = fakeRes();
	watchStall(slow as never, 60, 10);
	for (let i = 0; i < 6; i++) {
		slow.writableNeedDrain = i % 2 === 0;
		await tick(40);
	}
	assert.ok(!slow.destroyed);
	slow.emit("close");
});
