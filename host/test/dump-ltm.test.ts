// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** scripts/dump-ltm.ts against the in-process fake Hindsight (never the real one). */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FakeLtm } from "./fixtures/fake-ltm.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/dump-ltm.ts", import.meta.url));

describe("scripts/dump-ltm.ts", () => {
	const ltm = new FakeLtm();
	let dir: string;
	before(() => ltm.start());
	after(() => ltm.stop());
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "iyye-dump-"));
		mkdirSync(join(dir, "memory", "secrets"), { recursive: true });
		writeFileSync(join(dir, "memory", "secrets", "hindsight_api_key"), ltm.key);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		ltm.reset();
	});
	const run = (...args: string[]) =>
		promisify(execFile)(process.execPath, [SCRIPT, ...args], {
			env: { PATH: process.env.PATH ?? "", HOME: dir, IYYE2_STATE_DIR: dir, IYYE2_MEMORY_PORT: String(ltm.port) },
		}).then(
			(r) => ({ code: 0, out: r.stdout + r.stderr, stdout: r.stdout }),
			(e: { code: number; stdout: string; stderr: string }) => ({
				code: e.code,
				out: e.stdout + e.stderr,
				stdout: e.stdout,
			}),
		);
	const fact = (bank: string, id: string, content: string, timestamp: string) => {
		if (!ltm.banks.has(bank)) ltm.banks.set(bank, { mission: null, strategies: null });
		ltm.docs.set(`${bank}/${id}`, {
			bank,
			id,
			content,
			context: "a conversation",
			timestamp,
			tags: ["speaker:person"],
			metadata: {},
			strategy: null,
			units: 1,
		});
	};

	test("prints every bank's memories, newest first, with tags and context", async () => {
		fact("iyye-owner", "a", "Julia plays the violin", "2026-10-03T10:00:00Z");
		fact("iyye-owner", "b", "The owner lives in a south-eastern suburb of Munich", "2026-10-05T19:13:00Z");
		fact("iyye-self", "c", "Iyye runs on a MacBook Pro M3 Max with 128 GB", "2026-10-05T19:16:00Z");
		const r = await run();
		assert.equal(r.code, 0, r.out);
		assert.match(
			r.out,
			/=== iyye-owner: 2 memories\n- \[2026-10-05 19:13\] \(world\) The owner lives in a south-eastern suburb of Munich\n {4}tags: speaker:person · context: a conversation\n- \[2026-10-03 10:00\] \(world\) Julia plays the violin/,
		);
		assert.match(r.out, /=== iyye-self: 1 memory\n- \[2026-10-05 19:16\] \(world\) Iyye runs on a MacBook Pro/);
		assert.match(r.out, /3 memories in 2 bank\(s\)$/m);
	});

	test("--bank, --q, --limit and --json; pages through more than 100", async () => {
		for (let i = 0; i < 230; i++)
			fact(
				"iyye-owner",
				`f${i}`,
				`fact number ${i}`,
				`2026-10-0${1 + (i % 5)}T${String(i % 24).padStart(2, "0")}:00:00Z`,
			);
		fact("iyye-self", "s", "self fact", "2026-10-05T00:00:00Z");
		const all = await run("--bank", "iyye-owner", "--json");
		assert.equal(all.code, 0, all.out);
		const lines = all.stdout
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { bank: string; text: string });
		assert.equal(lines.length, 230, "all three pages");
		assert.ok(lines.every((l) => l.bank === "iyye-owner"));
		assert.match(
			(await run("--bank", "iyye-owner", "--limit", "5")).out,
			/=== iyye-owner: 230 memories \(showing 5\)/,
		);
		const q = await run("--q", "number 22", "--json");
		assert.deepEqual(
			q.stdout
				.trim()
				.split("\n")
				.map((l) => (JSON.parse(l) as { text: string }).text)
				.sort(),
			[
				"fact number 22",
				"fact number 220",
				"fact number 221",
				"fact number 222",
				"fact number 223",
				"fact number 224",
				"fact number 225",
				"fact number 226",
				"fact number 227",
				"fact number 228",
				"fact number 229",
			],
		);
	});

	test("an unknown bank, bad arguments and an unreachable Hindsight are reported", async () => {
		fact("iyye-owner", "a", "x", "2026-10-03T10:00:00Z");
		const unknown = await run("--bank", "iyye-nobody");
		assert.equal(unknown.code, 1);
		assert.match(unknown.out, /no bank iyye-nobody; banks: iyye-owner/);
		assert.equal((await run("--type", "facts")).code, 2);
		assert.equal((await run("--bogus")).code, 2);
		const down = await promisify(execFile)(process.execPath, [SCRIPT], {
			env: { PATH: process.env.PATH ?? "", HOME: dir, IYYE2_STATE_DIR: dir, IYYE2_MEMORY_PORT: "1" },
		}).catch((e: { code: number; stderr: string }) => e);
		assert.equal((down as { code: number }).code, 1);
		assert.match((down as { stderr: string }).stderr, /is not reachable/);
		assert.match((await run()).out, /=== iyye-owner: 1 memory/);
	});
});
