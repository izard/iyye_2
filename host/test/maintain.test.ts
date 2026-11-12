// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.018 W7: maintenance. Every test works in its own scratch state
 * directory; nothing here reads or removes anything of `~/.iyye2`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { silentLogger } from "../src/log.ts";
import { type MaintainDeps, Maintenance, sizeOf, sizeText } from "../src/self/maintain.ts";
import { openDb } from "../src/state/db.ts";

const NOW = new Date();
const DAY = 86_400_000;

/** A file of `kb` kilobytes, last written `days` ago. */
function put(path: string, kb: number, days: number): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, Buffer.alloc(kb * 1024, 7));
	age(path, days);
}

/** Sets the modification time of a path, and of everything inside it. */
function age(path: string, days: number): void {
	const at = new Date(NOW.getTime() - days * DAY);
	if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) age(join(path, name), days);
	lutimesSync(path, at, at);
}

function setup(over: Partial<MaintainDeps> = {}) {
	const state = join(mkdtempSync(join(tmpdir(), "iyye-maintain-")), "state");
	mkdirSync(state, { recursive: true });
	const db = openDb(join(state, "iyye.db"));
	const notices: { key: string; content: string }[] = [];
	let forecast: string | null = null;
	let now = NOW;
	const make = (more: Partial<MaintainDeps> = {}) =>
		new Maintenance({
			db,
			log: silentLogger,
			stateDir: state,
			dbPath: join(state, "iyye.db"),
			mode: "report",
			logDays: 14,
			leftoverDays: 30,
			memoryModels: () => ["BAAI/bge-small-en-v1.5", "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"],
			decisionsModel: () => "jaredpalmer/kev-4b@6cfce5c2",
			forecast: () => forecast,
			notifyOwner: (n) => notices.push(n),
			now: () => now,
			...over,
			...more,
		});
	return {
		state,
		db,
		notices,
		make,
		m: make(),
		setForecast: (text: string | null) => {
			forecast = text;
		},
		setNow: (at: Date) => {
			now = at;
		},
	};
}

/** A Hugging Face cache entry in the layout with one shared store: snapshot → the entry's blobs → the hub's blobs. */
function hubEntry(hub: string, entry: string, files: Record<string, string>, kb = 64): void {
	for (const [name, hash] of Object.entries(files)) {
		const store = join(hub, "blobs", hash.slice(0, 2), hash);
		if (!existsSync(store)) put(store, kb, 40);
		mkdirSync(join(hub, entry, "blobs"), { recursive: true });
		mkdirSync(join(hub, entry, "snapshots", "rev1"), { recursive: true });
		if (!existsSync(join(hub, entry, "blobs", hash)))
			symlinkSync(`../../blobs/${hash.slice(0, 2)}/${hash}`, join(hub, entry, "blobs", hash));
		symlinkSync(`../../blobs/${hash}`, join(hub, entry, "snapshots", "rev1", name));
	}
}

const du = (path: string) => Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split(/\s/)[0]) * 1024;

describe("maintenance: measuring", () => {
	test("a size is what du says: allocated blocks, directories included, a hard-linked file once, a link not followed", () => {
		const { state } = setup();
		const dir = join(state, "spikes", "run");
		put(join(dir, "a.bin"), 300, 1);
		put(join(dir, "deep", "b.bin"), 17, 1);
		linkSync(join(dir, "a.bin"), join(dir, "deep", "a-again.bin"));
		put(join(state, "elsewhere.bin"), 500, 1);
		symlinkSync(join(state, "elsewhere.bin"), join(dir, "link"));
		assert.equal(sizeOf(dir).bytes, du(dir));
		assert.ok(sizeOf(dir).bytes < 400 * 1024, "neither the second name of a file nor a link's target is counted");
	});

	test("logs: the old ones, never the newest of a service nor one a service appends to", () => {
		const { state, m } = setup();
		put(join(state, "logs", "router-2026-09-01T06-40-58-765Z.log"), 40, 60);
		put(join(state, "logs", "router-2026-10-01T06-40-58-765Z.log"), 40, 30);
		put(join(state, "logs", "router-2026-11-10T06-40-58-765Z.log"), 40, 1);
		// A service that was not restarted for a long time: its one log is old, and still the one it writes.
		put(join(state, "web", "logs", "searxng-2026-08-01T00-00-00-000Z.log"), 40, 90);
		put(join(state, "memory", "logs", "postgres.log"), 40, 90);
		put(join(state, "memory", "logs", "hindsight-2026-11-01T00-00-00-000Z.log"), 40, 10);
		put(join(state, "memory", "logs", "hindsight-2026-11-09T00-00-00-000Z.log"), 40, 2);
		put(join(state, "decisions", "logs", "kev-spike.log"), 12, 31);
		put(join(state, "logs", "notes.txt"), 12, 90);
		const logs = m.measureOne("logs");
		assert.deepEqual(logs.items.map((i) => i.name).sort(), [
			"decisions/logs/kev-spike.log",
			"logs/router-2026-09-01T06-40-58-765Z.log",
			"logs/router-2026-10-01T06-40-58-765Z.log",
		]);
		assert.equal(logs.bytes, du(join(state, "decisions", "logs", "kev-spike.log")) + 2 * 40 * 1024);
	});

	test("spikes: what nothing wrote to for the leftover days; a recent one waits, a repository is left alone", () => {
		const { state, m } = setup();
		put(join(state, "spikes", "voice", "out", "items.jsonl"), 200, 45);
		put(join(state, "spikes", "voice-run.log"), 12, 45);
		put(join(state, "spikes", "n0", "old.bin"), 100, 45);
		put(join(state, "spikes", "n0", "new.bin"), 100, 5);
		put(join(state, "spikes", "clone", "x.txt"), 10, 45);
		mkdirSync(join(state, "spikes", "clone", ".git"));
		age(join(state, "spikes", "clone"), 45);
		age(join(state, "spikes", "voice"), 45);
		const spikes = m.measureOne("spikes");
		assert.deepEqual(
			spikes.items.map((i) => i.name),
			["spikes/voice", "spikes/voice-run.log"],
		);
		assert.equal(spikes.bytes, du(join(state, "spikes", "voice")) + du(join(state, "spikes", "voice-run.log")));
		assert.ok(spikes.notes.some((n) => n.startsWith("spikes/n0:") && n.includes("kept until")));
		assert.ok(spikes.notes.some((n) => n === "spikes/clone: a repository; left alone"));
	});

	test("sandbox: the archive and unfinished attempts once it is provisioned; never its root or a workspace", () => {
		const { state, m } = setup();
		const archive = join(state, "sandbox", "alpine-minirootfs-3.24.2-aarch64.tar.gz");
		put(archive, 400, 40);
		put(join(state, "sandbox", "rootfs.partial", "bin", "sh"), 50, 40);
		put(join(state, "sandbox", "provision-Ab12", "work", "x"), 20, 40);
		put(join(state, "sandbox", "rootfs", "bin", "sh"), 50, 40);
		put(join(state, "sandbox", "work", "scope", "notes.txt"), 20, 40);
		age(join(state, "sandbox"), 40);
		assert.deepEqual(
			m.measureOne("sandbox").items.map((i) => i.name),
			["sandbox/provision-Ab12", "sandbox/rootfs.partial"],
			"not provisioned: the archive is what provisioning starts from",
		);
		assert.ok(m.measureOne("sandbox").notes.some((n) => n.includes("not provisioned")));
		put(join(state, "sandbox", "provisioned.json"), 1, 40);
		assert.deepEqual(
			m.measureOne("sandbox").items.map((i) => i.name),
			["sandbox/alpine-minirootfs-3.24.2-aarch64.tar.gz", "sandbox/provision-Ab12", "sandbox/rootfs.partial"],
		);
	});

	test("the database: its free pages", () => {
		const { db, m } = setup();
		db.exec("CREATE TABLE filler (x TEXT)");
		const insert = db.prepare("INSERT INTO filler (x) VALUES (?)");
		db.transaction(() => {
			for (let i = 0; i < 4000; i++) insert.run("x".repeat(4000));
		})();
		assert.equal(m.measureOne("database").bytes, 0);
		db.exec("DELETE FROM filler");
		const free = m.measureOne("database");
		assert.ok(free.bytes > 12 * 1024 * 1024, sizeText(free.bytes));
		assert.match(free.notes[0]!, /^iyye\.db: .* in all$/);
	});
});

describe("maintenance: the model caches", () => {
	const used = "models--cross-encoder--mmarco-mMiniLMv2-L12-H384-v1";
	const old = "models--cross-encoder--ms-marco-MiniLM-L-6-v2";

	function caches(state: string) {
		const hub = join(state, "memory", "hf", "hub");
		hubEntry(hub, used, { "model.onnx": "aa11", "config.json": "cc33" });
		hubEntry(hub, old, { "model.onnx": "bb22", "config.json": "cc33", "vocab.txt": "dd44" });
		hubEntry(hub, "models--BAAI--bge-small-en-v1.5", { "model.onnx": "ee55" });
		put(join(hub, ".locks", old, "x.lock"), 1, 40);
		return hub;
	}

	test("an entry no configuration names waits the leftover days from when it was first seen unused", () => {
		const { state, m, setNow } = setup();
		caches(state);
		const first = m.measureOne("model-cache");
		assert.deepEqual(first.items, []);
		assert.ok(
			first.notes.some((n) => n.startsWith(`memory/hf/hub/${old}:`) && n.includes("unused since")),
			first.notes.join("\n"),
		);
		setNow(new Date(NOW.getTime() + 29 * DAY));
		assert.deepEqual(m.measureOne("model-cache").items, []);
		setNow(new Date(NOW.getTime() + 31 * DAY));
		assert.deepEqual(
			m.measureOne("model-cache").items.map((i) => i.name),
			[`memory/hf/hub/${old}`],
		);
	});

	test("removing it takes its own files and the stored files only it links to", () => {
		const { state, m, setNow } = setup();
		const hub = caches(state);
		m.measure();
		setNow(new Date(NOW.getTime() + 31 * DAY));
		const item = m.measureOne("model-cache").items[0]!;
		// Its entry and lock, and the two stored files nothing else uses (64 KB each); `cc33` is shared with a used entry.
		const own = du(join(hub, old)) + du(join(hub, ".locks", old));
		assert.equal(item.bytes, own + 2 * 64 * 1024);
		assert.match(m.command(["run", "model-cache", "confirm"]), /^model-cache: removed 1 item, /);
		assert.equal(existsSync(join(hub, old)), false);
		assert.equal(existsSync(join(hub, ".locks", old)), false);
		assert.equal(existsSync(join(hub, "blobs", "bb", "bb22")), false);
		assert.equal(existsSync(join(hub, "blobs", "dd", "dd44")), false);
		assert.equal(existsSync(join(hub, "blobs", "cc", "cc33")), true);
		// What is configured still reads through its links.
		assert.equal(readFileSync(join(hub, used, "snapshots", "rev1", "config.json")).length, 64 * 1024);
		assert.equal(readFileSync(join(hub, used, "snapshots", "rev1", "model.onnx")).length, 64 * 1024);
		assert.deepEqual(m.measureOne("model-cache").items, []);
	});

	test("a stored file stays while anything in the hub links to it, an entry that is itself a link included", () => {
		const { state, m, setNow } = setup();
		const hub = caches(state);
		// An entry that lives elsewhere and is linked in: never Iyye's to remove, and what it links to stays.
		const linked = join(dirname(state), "linked-entry");
		mkdirSync(join(linked, "snapshots", "rev1"), { recursive: true });
		symlinkSync(join(hub, "blobs", "dd", "dd44"), join(linked, "snapshots", "rev1", "vocab.txt"));
		symlinkSync(linked, join(hub, "models--linked--in"));
		// A dataset entry links to another of its files.
		hubEntry(hub, "datasets--someone--suite", { "suite.jsonl": "bb22" });
		m.measure();
		setNow(new Date(NOW.getTime() + 31 * DAY));
		const item = m.measureOne("model-cache").items[0]!;
		assert.equal(
			item.bytes,
			du(join(hub, old)) + du(join(hub, ".locks", old)),
			"every stored file it links to is still needed",
		);
		m.command(["run", "model-cache", "confirm"]);
		assert.equal(existsSync(join(hub, old)), false);
		assert.equal(readFileSync(join(linked, "snapshots", "rev1", "vocab.txt")).length, 64 * 1024);
		assert.equal(lstatSync(join(hub, "models--linked--in")).isSymbolicLink(), true);
		for (const hash of ["bb22", "cc33", "dd44"])
			assert.equal(existsSync(join(hub, "blobs", hash.slice(0, 2), hash)), true);
	});

	test("an entry that is configured again starts its wait afresh", () => {
		const { state, make, setNow } = setup();
		caches(state);
		make().measure();
		setNow(new Date(NOW.getTime() + 20 * DAY));
		// The owner switches back for a while.
		make({ memoryModels: () => ["BAAI/bge-small-en-v1.5", "cross-encoder/ms-marco-MiniLM-L-6-v2"] }).measure();
		setNow(new Date(NOW.getTime() + 40 * DAY));
		const again = make().measureOne("model-cache");
		assert.deepEqual(again.items, [], "40 days after the first sight, but only just unused again");
	});

	test("a cache with no record of what it is there for is left alone; one with a record is judged by it", () => {
		const { state, m, setNow } = setup();
		const voice = join(state, "voice", "hf", "hub");
		hubEntry(voice, "models--openbmb--MiniCPM5-2B", { "model.safetensors": "aa11" });
		hubEntry(voice, "models--some--experiment", { "model.safetensors": "bb22" });
		const kev = join(state, "decisions", "hf", "hub");
		hubEntry(kev, "models--jaredpalmer--kev-4b", { "adapter.safetensors": "aa11" });
		hubEntry(kev, "models--Qwen--Qwen3.5-4B-Base", { "model.safetensors": "bb22" });
		hubEntry(kev, "datasets--jaredpalmer--kev-suites", { "suite.jsonl": "cc33" });
		writeFileSync(
			join(state, "decisions", "provisioned.json"),
			JSON.stringify({ run: "jaredpalmer/kev-4b@6cfce5c2", base: "Qwen/Qwen3.5-4B-Base" }),
		);
		m.measure();
		setNow(new Date(NOW.getTime() + 31 * DAY));
		const first = m.measureOne("model-cache");
		assert.deepEqual(first.items, []);
		assert.ok(first.notes.includes("voice/hf/hub: no record of what it is there for; left alone"));
		writeFileSync(
			join(state, "voice", "provisioned.json"),
			JSON.stringify({ "minicpm5-2b": { repo: "openbmb/MiniCPM5-2B", revision: "f974" } }),
		);
		m.measure();
		setNow(new Date(NOW.getTime() + 62 * DAY));
		assert.deepEqual(
			m.measureOne("model-cache").items.map((i) => i.name),
			["voice/hf/hub/models--some--experiment"],
		);
	});
});

describe("maintenance: removing", () => {
	test("report only: a night measures and removes nothing, whatever the forecast and whatever is allowed", () => {
		const { state, m, notices, setForecast, db } = setup();
		put(join(state, "spikes", "voice", "items.jsonl"), 2000, 45);
		age(join(state, "spikes", "voice"), 45);
		setForecast("free disk falls by 3 GB a day: about 12 days until it is full (40 GB free)");
		assert.match(
			m.command(["allow", "spikes"]),
			/noted\. Iyye runs allowed actions only with IYYE2_MAINTAIN=allowed/,
		);
		assert.deepEqual(m.nightly(), []);
		assert.equal(existsSync(join(state, "spikes", "voice")), true);
		assert.deepEqual(notices, []);
		assert.equal((db.prepare("SELECT count(*) AS n FROM maintenance_runs").get() as { n: number }).n, 0);
		assert.equal(m.line(), "maintenance could remove 2.0 MB (spikes 2.0 MB)");
	});

	test("the owner runs an action by hand: shown first, removed on confirm, recorded with what went", async () => {
		const { state, m, db } = setup();
		put(join(state, "spikes", "voice", "items.jsonl"), 2000, 45);
		put(join(state, "spikes", "meaning-run1.log"), 12, 45);
		put(join(state, "spikes", "n0", "new.bin"), 100, 5);
		age(join(state, "spikes", "voice"), 45);
		const expected = du(join(state, "spikes", "voice")) + du(join(state, "spikes", "meaning-run1.log"));
		const ctx = { models: null as never, db, issuer: "owner_web", maintain: m };
		const shown = (await handleOwnerCommand("/maintain run spikes", ctx)).reply;
		assert.match(shown, /spikes\/voice — 2\.0 MB/);
		assert.match(shown, /\/maintain run spikes confirm — remove these now/);
		assert.equal(existsSync(join(state, "spikes", "voice")), true);
		const done = (await handleOwnerCommand("/maintain run spikes confirm", ctx)).reply;
		assert.equal(done, `spikes: removed 2 items, ${sizeText(expected)}`);
		assert.deepEqual(readdirSync(join(state, "spikes")), ["n0"]);
		const row = db.prepare("SELECT * FROM maintenance_runs").get() as Record<string, unknown>;
		assert.equal(row.action, "spikes");
		assert.equal(row.by, "owner");
		assert.equal(row.freed_bytes, expected);
		assert.deepEqual(
			(JSON.parse(String(row.removed_json)) as { name: string }[]).map((x) => x.name),
			["spikes/meaning-run1.log", "spikes/voice"],
		);
		assert.match((await handleOwnerCommand("/maintain runs", ctx)).reply, /spikes: removed 2 items.*\[you asked\]/);
		assert.match((await handleOwnerCommand("/maintain", ctx)).reply, /spikes — .*nothing to remove; last run/);
		assert.equal(
			(await handleOwnerCommand("/maintain run spikes confirm", ctx)).reply,
			"spikes: there was nothing to remove",
		);
	});

	test("allowed: at the end of a night only the owner's actions run, files only when the forecast asks", () => {
		const { state, make, notices, setForecast, db } = setup();
		const m = make({ mode: "allowed" });
		put(join(state, "spikes", "voice", "items.jsonl"), 200, 45);
		age(join(state, "spikes", "voice"), 45);
		put(join(state, "logs", "router-2026-09-01T06-40-58-765Z.log"), 40, 60);
		put(join(state, "logs", "router-2026-11-10T06-40-58-765Z.log"), 40, 1);
		assert.match(
			m.command(["allow", "spikes"]),
			/Iyye may run it on its own, at the end of a night, when the disk forecast/,
		);
		assert.deepEqual(m.nightly(), [], "no forecast asks for room");
		assert.equal(existsSync(join(state, "spikes", "voice")), true);
		setForecast("free disk falls by 3 GB a day: about 12 days until it is full (40 GB free)");
		const runs = m.nightly();
		assert.deepEqual(
			runs.map((r) => [r.action, r.by, r.removed.map((x) => x.name)]),
			[["spikes", "iyye", ["spikes/voice"]]],
		);
		assert.equal(existsSync(join(state, "spikes", "voice")), false);
		assert.equal(
			existsSync(join(state, "logs", "router-2026-09-01T06-40-58-765Z.log")),
			true,
			"logs were not allowed",
		);
		assert.equal(notices.length, 1);
		assert.match(
			notices[0]!.content,
			/^Maintenance tonight \(free disk falls by 3 GB a day.*\):\n {2}spikes: removed 1 item, /,
		);
		assert.equal(
			(db.prepare("SELECT reason FROM maintenance_runs").get() as { reason: string }).reason.slice(0, 15),
			"free disk falls",
		);
		assert.deepEqual(m.nightly(), [], "nothing is left of it");
		assert.equal(notices.length, 1);
		assert.equal(m.command(["disallow", "spikes"]), "spikes: Iyye will not run it on its own");
		assert.equal(m.allowed().size, 0);
	});

	test("the database is compacted only at the end of a night, when allowed and enough of it is free", () => {
		const { state, make, db, notices } = setup();
		const m = make({ mode: "allowed" });
		db.exec("CREATE TABLE filler (x TEXT)");
		const insert = db.prepare("INSERT INTO filler (x) VALUES (?)");
		db.transaction(() => {
			for (let i = 0; i < 4000; i++) insert.run("x".repeat(4000));
		})();
		db.exec("DELETE FROM filler");
		db.pragma("wal_checkpoint(TRUNCATE)");
		const before = statSync(join(state, "iyye.db")).size;
		assert.match(m.command(["run", "database", "confirm"]), /only at the end of a night/);
		assert.deepEqual(m.nightly(), [], "not allowed yet");
		m.command(["allow", "database"]);
		const runs = m.nightly();
		assert.equal(runs.length, 1);
		assert.equal(runs[0]!.error, null);
		const after = statSync(join(state, "iyye.db")).size;
		assert.ok(after < before / 4, `${before} → ${after}`);
		assert.equal(runs[0]!.freedBytes, before - after);
		assert.match(notices[0]!.content, /database: compacted, \d+\.\d MB smaller/);
		assert.equal((db.prepare("SELECT count(*) AS n FROM maintenance_runs").get() as { n: number }).n, 1);
		assert.deepEqual(m.nightly(), [], "nothing is free now");
	});

	test("nothing is reached through a link: a linked directory is left alone, a linked entry loses only its link", () => {
		const { state, m } = setup();
		const outside = join(dirname(state), "outside");
		put(join(outside, "precious", "data.bin"), 100, 90);
		put(join(outside, "old.log"), 10, 90);
		age(outside, 90);
		// The owner's own log directory, linked in: not Iyye's to clean.
		mkdirSync(join(state, "web"), { recursive: true });
		symlinkSync(outside, join(state, "web", "logs"));
		// A spike entry that is a link to something elsewhere.
		mkdirSync(join(state, "spikes"));
		symlinkSync(join(outside, "precious"), join(state, "spikes", "borrowed"));
		lutimesSync(
			join(state, "spikes", "borrowed"),
			new Date(NOW.getTime() - 90 * DAY),
			new Date(NOW.getTime() - 90 * DAY),
		);
		const logs = m.measureOne("logs");
		assert.deepEqual(logs.items, []);
		assert.ok(logs.notes.includes("web/logs: not a directory; left alone"));
		assert.deepEqual(
			m.measureOne("spikes").items.map((i) => i.name),
			["spikes/borrowed"],
		);
		m.command(["run", "spikes", "confirm"]);
		m.command(["run", "logs", "confirm"]);
		assert.equal(existsSync(join(state, "spikes", "borrowed")), false);
		assert.equal(readFileSync(join(outside, "precious", "data.bin")).length, 100 * 1024);
		assert.equal(existsSync(join(outside, "old.log")), true);
	});

	test("a state directory whose own parts lead elsewhere: left alone", () => {
		const { state, m } = setup();
		const outside = join(dirname(state), "big-disk");
		put(join(outside, "spikes", "voice", "items.jsonl"), 100, 90);
		age(outside, 90);
		symlinkSync(join(outside, "spikes"), join(state, "spikes"));
		const spikes = m.measureOne("spikes");
		assert.deepEqual(spikes.items, []);
		assert.match(spikes.notes[0]!, /^spikes: .*left alone$/);
		assert.equal(m.command(["run", "spikes", "confirm"]), "spikes: there was nothing to remove");
		assert.equal(existsSync(join(outside, "spikes", "voice", "items.jsonl")), true);
	});

	test("off: nothing is measured, said or removed", () => {
		const { state, make } = setup();
		const m = make({ mode: "off" });
		put(join(state, "spikes", "voice", "items.jsonl"), 200, 45);
		age(join(state, "spikes", "voice"), 45);
		assert.equal(m.command([]), "maintenance is off (IYYE2_MAINTAIN=off)");
		assert.equal(m.command(["run", "spikes", "confirm"]), "maintenance is off (IYYE2_MAINTAIN=off)");
		assert.deepEqual(m.nightly(), []);
		assert.equal(m.line(), null);
		assert.equal(existsSync(join(state, "spikes", "voice")), true);
	});

	test("the report: every action with its figure, and the line the disk report quotes", () => {
		const { state, m } = setup();
		put(join(state, "spikes", "voice", "items.jsonl"), 3000, 45);
		age(join(state, "spikes", "voice"), 45);
		const text = m.command([]);
		assert.match(text, /^maintenance: report only; nothing is removed unless you run an action/);
		for (const a of ["logs", "spikes", "sandbox", "model-cache", "database"])
			assert.match(text, new RegExp(`\\n {2}${a} — `));
		assert.match(text, /spikes — spike leftovers nothing wrote to for 30 days: 1 item, 2\.9 MB/);
		assert.match(text, /in all: 2\.9 MB/);
		assert.equal(m.line(), "maintenance could remove 2.9 MB (spikes 2.9 MB)");
		assert.match(m.command(["spikes"]), /spikes\/voice — 2\.9 MB/);
		assert.match(m.command(["nonsense"]), /^\/maintain \| /);
		assert.match(m.command(["allow", "everything"]), /^no such action/);
	});
});
