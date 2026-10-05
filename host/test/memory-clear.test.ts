// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** scripts/memory-clear.ts and how the host copes with banks deleted under it. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { silentLogger } from "../src/log.ts";
import type { GateResult } from "../src/memory/gate.ts";
import { NightWork } from "../src/memory/night.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { getKv, setKv } from "../src/state/kv.ts";
import { recordEpisode, restageEpisodes, searchStm } from "../src/state/stm.ts";
import { FakeLtm } from "./fixtures/fake-ltm.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/memory-clear.ts", import.meta.url));
let seq = 0;

function episode(db: Db, scope: string, text: string): string {
	const id = `c${++seq}`;
	const at = new Date().toISOString();
	const contact = scope === "owner" ? "owner" : scope.slice("contact:".length);
	if (contact !== "owner") {
		db.prepare("INSERT OR IGNORE INTO contacts (id, display_name, kind, created_at) VALUES (?, ?, 'contact', ?)").run(
			contact,
			contact,
			at,
		);
	}
	db.prepare(
		"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'web', ?, ?, ?, ?, 'answered')",
	).run(id, id, contact, scope, at, JSON.stringify({ text }));
	db.prepare(
		"INSERT INTO actions (id, event_id, kind, route_json, content_hash, idempotency_key, state, created_at, content) VALUES (?, ?, 'reply', '{}', 'h', ?, 'delivered', ?, 'ok')",
	).run(`a-${id}`, id, `k-${id}`, at);
	recordEpisode(db, getEvent(db, id)!, { id: `a-${id}`, content: "ok" }, at);
	return id;
}

const openGate = {
	problem: null,
	async run<T>(_label: string, fn: (model: string) => Promise<T>): Promise<GateResult<T>> {
		return { ok: true, value: await fn("m"), model: "m" };
	},
};

const ownerContact = (db: Db) =>
	db
		.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('owner', 'Owner', 'owner', 't') ON CONFLICT DO NOTHING",
		)
		.run();

describe("clearing long-term memory", () => {
	const ltm = new FakeLtm();
	let db: Db;
	before(() => ltm.start());
	after(() => ltm.stop());
	beforeEach(() => {
		db = openDb(":memory:");
		ownerContact(db);
	});
	afterEach(() => {
		db.close();
		ltm.reset();
	});

	test("restaged conversations are queued in the transfer backlog (not today's memory) and the next night stores them in a re-created bank", async () => {
		const night = new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger });
		const e1 = episode(db, "owner", "Julia plays violin");
		const e2 = episode(db, "contact:alex", "I live in Berlin");
		await night.run(() => false);
		assert.deepEqual(searchStm(db, ["owner", "contact:alex"], "violin Berlin"), []);
		await ltm.client().deleteBank("iyye-owner"); // as the script does, with the host still running
		assert.equal(restageEpisodes(db, ["owner"]), 1, "only the cleared bank's conversations");
		assert.deepEqual(searchStm(db, ["owner"], "violin"), [], "old conversations are not today's short-term memory");
		assert.equal(db.prepare("SELECT state FROM stm_episodes WHERE event_id = ?").pluck().get(e1), "backlog");
		const r = await night.run(() => false);
		assert.equal(r.kind, "done");
		assert.equal(r.completed, 1);
		assert.ok(ltm.banks.has("iyye-owner"), "re-created with its settings");
		assert.ok(ltm.banks.get("iyye-owner")!.strategies);
		assert.ok(ltm.docs.has(`iyye-owner/${e1}:said`));
		assert.deepEqual(db.prepare("SELECT state, attempts FROM stm_episodes WHERE event_id = ?").get(e1), {
			state: "completed",
			attempts: 0,
		});
		assert.equal(db.prepare("SELECT state FROM stm_episodes WHERE event_id = ?").pluck().get(e2), "completed");
	});

	test("a bank deleted in the middle of a night is re-created, not charged as a failure", async () => {
		const night = new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger });
		episode(db, "owner", "first");
		await night.run(() => false);
		const e2 = episode(db, "owner", "second");
		ltm.banks.delete("iyye-owner"); // the night's cache still believes the bank exists
		(night as unknown as { banksReady: Set<string> }).banksReady.add("iyye-owner");
		const run = night.run.bind(night);
		(night as unknown as { banksReady: Set<string> }).banksReady.clear = () => {}; // keep the stale cache for this run
		await run(() => false);
		assert.deepEqual(db.prepare("SELECT state, attempts FROM stm_episodes WHERE event_id = ?").get(e2), {
			state: "completed",
			attempts: 0,
		});
	});

	test("a deleted bank owing consolidation is dropped from the list", async () => {
		setKv(db, "memory.banks_to_consolidate", JSON.stringify(["iyye-gone"]), "t");
		const r = await new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger }).run(() => false);
		assert.deepEqual(r, { kind: "done", completed: 0, empty: 0, failed: 0, consolidated: [] });
		assert.deepEqual(JSON.parse(getKv(db, "memory.banks_to_consolidate")!), []);
	});
});

describe("scripts/memory-clear.ts", () => {
	const ltm = new FakeLtm();
	let dir: string;
	before(() => ltm.start());
	after(() => ltm.stop());
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "iyye-clear-"));
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
			(r) => ({ code: 0, out: r.stdout + r.stderr }),
			(e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
		);

	test("deletes every bank, restages, and clears the consolidation list", async () => {
		const db = openDb(join(dir, "iyye.db"));
		ownerContact(db);
		const night = new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger });
		episode(db, "owner", "Julia plays violin");
		episode(db, "contact:alex", "I live in Berlin");
		await night.run(() => false);
		setKv(db, "memory.banks_to_consolidate", JSON.stringify(["iyye-owner", "iyye-contact-alex"]), "t");
		db.close();

		const refused = await run();
		assert.equal(refused.code, 2, "no terminal: needs --yes");
		assert.match(refused.out, /iyye-owner: 2 document\(s\)/);
		assert.equal(ltm.banks.size, 2, "nothing deleted without confirmation");

		const r = await run("--yes", "--restage");
		assert.equal(r.code, 0, r.out);
		assert.match(r.out, /deleted iyye-owner/);
		assert.match(r.out, /deleted iyye-contact-alex/);
		assert.match(r.out, /2 conversation\(s\) are queued in the transfer backlog/);
		assert.equal(ltm.banks.size, 0);
		assert.equal(ltm.docs.size, 0);
		const after = openDb(join(dir, "iyye.db"));
		assert.equal(after.prepare("SELECT count(*) FROM stm_episodes WHERE state = 'backlog'").pluck().get(), 2);
		assert.deepEqual(JSON.parse(getKv(after, "memory.banks_to_consolidate")!), []);
		after.close();
		assert.match((await run("--yes")).out, /long-term memory is already empty/);
	});

	test("--bank deletes only that bank; refuses while asleep", async () => {
		const db = openDb(join(dir, "iyye.db"));
		ownerContact(db);
		const night = new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger });
		episode(db, "owner", "Julia plays violin");
		episode(db, "contact:alex", "I live in Berlin");
		await night.run(() => false);
		setKv(db, "rhythm.mode", "asleep", "t");
		db.close();
		const asleep = await run("--yes");
		assert.equal(asleep.code, 1);
		assert.match(asleep.out, /Iyye is asleep.*\/wake first/);
		const db2 = openDb(join(dir, "iyye.db"));
		setKv(db2, "rhythm.mode", "awake", "t");
		db2.close();
		const r = await run("--bank", "iyye-contact-alex", "--yes", "--restage");
		assert.equal(r.code, 0, r.out);
		assert.deepEqual([...ltm.banks.keys()], ["iyye-owner"]);
		assert.match(r.out, /1 conversation\(s\) are queued/);
		assert.match((await run("--bank", "nope", "--yes")).out, /no bank nope/);
	});
});
