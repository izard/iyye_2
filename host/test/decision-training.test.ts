// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** Plan 0.017 N3: the offline training session, with a fake trainer and a fake scorer (no model, no GPU). */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { datasetPolicy, planDataset } from "../src/decisions/dataset.ts";
import { localDay } from "../src/decisions/labels.ts";
import { fitTemperature, marginOf, meanNll } from "../src/decisions/temperature.ts";
import {
	candidatesDir,
	learningReport,
	runTrainingSession,
	type SessionDeps,
	TRAINING_HOLDER,
	type TrainingSettings,
	trainable,
	trainingSteps,
} from "../src/decisions/training.ts";
import { acquireHostLock, HOST, releaseHostLock } from "../src/process/host-lock.ts";
import { type Db, openDb } from "../src/state/db.ts";

const FAKE_TRAINER = fileURLToPath(new URL("./fixtures/fake-trainer.mjs", import.meta.url));
const FAKE_PREDICT = fileURLToPath(new URL("./fixtures/fake-predict.mjs", import.meta.url));
const PARENT = "jaredpalmer/kev-4b@6cfce5c2fa4b4bd64026336ab649c5ca78857d52";
const at = (day: number, hour = 12) => new Date(2026, 10, day, hour);

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let seq = 0;
/** One answered owner decision with the owner's label, labelled on the day it was made. */
function labelled(
	db: Db,
	day: number,
	value: boolean,
	role = "memory_salience",
	question = "worth_remembering",
): string {
	seq++;
	const id = `${seq.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
	const state = JSON.stringify(`a message, number ${seq}`);
	db.prepare(
		`INSERT INTO decisions (id, role, schema_version, mode, scope, subject_ref, state_json, state_hash, questions_json, status, created_at)
		 VALUES (?, ?, 1, 'shadow', 'owner', ?, ?, ?, ?, 'ok', ?)`,
	).run(
		id,
		role,
		`s${seq}`,
		state,
		createHash("sha256").update(state).digest("hex"),
		JSON.stringify([{ id: question, instructions: `Is it ${question}?` }]),
		at(day).toISOString(),
	);
	db.prepare(
		"INSERT INTO decision_labels (decision_id, question, value, labelled_by, labelled_at, via) VALUES (?, ?, ?, 'owner_web', ?, 'random')",
	).run(id, question, value ? 1 : 0, at(day, 13).toISOString());
	return id;
}

interface Rig {
	stateDir: string;
	dbPath: string;
	log: string;
	lines: string[];
	deps: (
		over?: Partial<SessionDeps>,
		settings?: Partial<TrainingSettings>,
		env?: Record<string, string>,
	) => SessionDeps;
	db: () => Db;
	calls: () => { tool: string; args: string[] }[];
}

/**
 * A state directory with twelve days of labels: memory salience 4 yes · 4 no a day, and reply review one
 * of each, so the sealed test set is the last four days and memory salience has 24 · 24 in training.
 */
function rig(days = 12): Rig {
	const stateDir = mkdtempSync(join(tmpdir(), "iyye-train-"));
	dirs.push(stateDir);
	const dbPath = join(stateDir, "iyye.db");
	const db = openDb(dbPath);
	for (let d = 1; d <= days; d++) {
		for (let i = 0; i < 4; i++) {
			labelled(db, d, true);
			labelled(db, d, false);
		}
		labelled(db, d, d % 2 === 0, "reply_review", "claims_arranged");
	}
	db.close();
	const log = join(stateDir, "fake.log");
	const lines: string[] = [];
	const suite = join(stateDir, "suite");
	mkdirSync(suite);
	return {
		stateDir,
		dbPath,
		log,
		lines,
		db: () => openDb(dbPath),
		calls: () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.map((l) => JSON.parse(l) as { tool: string; args: string[] })
				: [],
		deps: (over = {}, settings = {}, env = {}) => ({
			stateDir,
			settings: {
				policy: "on",
				minNewLabels: 30,
				minPerClass: 20,
				maxMinutes: 30,
				minFreeGb: 64,
				epochs: 3,
				replayPerExample: 2,
				maxState: 0,
				testLooks: 5,
				parent: PARENT,
				...settings,
			},
			openDb: () => openDb(dbPath),
			ports: [{ name: "the model router", port: 1 }],
			listening: async () => false,
			availableGb: () => 100,
			trainCommand: [process.execPath, FAKE_TRAINER],
			predictCommand: [process.execPath, FAKE_PREDICT],
			suiteDir: suite,
			env: { FAKE_LOG: log, ...env },
			now: () => at(12, 20),
			say: (l) => lines.push(l),
			...over,
		}),
	};
}

const sessions = (db: Db) =>
	db.prepare("SELECT * FROM decision_training_sessions ORDER BY started_at, rowid").all() as Record<
		string,
		string | null
	>[];
const artifacts = (db: Db) =>
	db.prepare("SELECT * FROM decision_artifacts ORDER BY created_at, rowid").all() as Record<
		string,
		string | number | null
	>[];
const count = (db: Db, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const unlocked = (r: Rig) =>
	!existsSync(join(r.stateDir, "host.lock")) && !existsSync(join(r.stateDir, "host.lock.who"));
const exportsLeft = (r: Rig) => {
	const d = join(r.stateDir, "decisions", "training", "sessions");
	return existsSync(d) ? readdirSync(d) : [];
};
const candidateDirs = (r: Rig) => (existsSync(candidatesDir(r.stateDir)) ? readdirSync(candidatesDir(r.stateDir)) : []);

test("with the policy off nothing is touched: no lock, no database, no trainer", async () => {
	const r = rig();
	const res = await runTrainingSession(
		r.deps({
			settings: { ...r.deps().settings, policy: "off" },
			openDb: () => {
				throw new Error("the database must not be opened");
			},
		}),
	);
	assert.deepEqual([res.outcome, res.exitCode, res.sessionId], ["off", 0, null]);
	assert.ok(unlocked(r));
	assert.deepEqual(r.calls(), []);
});

test("refused while a host holds the lock or one of Iyye's services still listens; the database is not opened", async () => {
	const r = rig();
	const never = () => {
		throw new Error("the database must not be opened");
	};
	const host = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	writeFileSync(join(r.stateDir, "host.lock"), String(host.pid));
	const held = await runTrainingSession(r.deps({ openDb: never }));
	assert.deepEqual([held.outcome, held.exitCode], ["refused", 3]);
	assert.match(held.reason!, new RegExp(`the Iyye host \\(pid ${host.pid}\\) is using .*: stop Iyye first`));
	assert.equal(readFileSync(join(r.stateDir, "host.lock"), "utf8"), String(host.pid), "the host's lock is left alone");
	host.kill("SIGKILL");
	await new Promise((x) => host.once("exit", x));

	// The host is gone (its lock is stale), but its router still answers on its port.
	const busy = await runTrainingSession(r.deps({ openDb: never, listening: async (port) => port === 1 }));
	assert.deepEqual([busy.outcome, busy.exitCode], ["refused", 3]);
	assert.match(busy.reason!, /the model router is still listening on port 1: stop Iyye's services first/);
	assert.ok(unlocked(r), "a refused session gives the lock back");
	assert.deepEqual(r.calls(), []);
});

test("a session that would not help is recorded as skipped, with the reason, and freezes no dataset", async () => {
	const few = rig(3); // 27 labels: no sealed test set can be made
	const a = await runTrainingSession(few.deps());
	assert.deepEqual([a.outcome, a.exitCode], ["skipped", 0]);
	assert.match(a.reason!, /too few owner labels for a sealed test set: 27, and 30 are needed/);

	const r = rig();
	const cases: [Partial<SessionDeps>, Partial<TrainingSettings>, RegExp][] = [
		[{}, { minNewLabels: 500 }, /108 owner label\(s\) since the start; 500 are needed/],
		[
			{},
			{ minPerClass: 25 },
			/no question has 25 labels of each class in training \(closest: memory_salience worth_remembering, 24 yes · 24 no\)/,
		],
		[{ suiteDir: null }, {}, /Kev's replay suite is not provisioned/],
		[{ availableGb: () => 41.26 }, {}, /41\.3 GB of memory available; 64 GB are needed/],
		[
			{ checkOnly: true },
			{},
			/a check only: a session would train on memory_salience worth_remembering \(24 yes · 24 no\); 100\.0 GB of memory available/,
		],
	];
	for (const [over, settings, reason] of cases) {
		const res = await runTrainingSession(r.deps(over, settings));
		assert.deepEqual([res.outcome, res.exitCode, res.artifactId], ["skipped", 0, null]);
		assert.match(res.reason!, reason);
		assert.ok(unlocked(r));
	}
	const db = r.db();
	assert.deepEqual(
		sessions(db).map((s) => [s.outcome, s.ended_at !== null, s.dataset_id]),
		cases.map(() => ["skipped", true, null]),
	);
	assert.equal(count(db, "decision_datasets"), 0);
	assert.equal(count(db, "decision_test_sets"), 0, "no test set is sealed for a session that does not train");
	assert.equal(count(db, "decision_artifacts"), 0);
	db.close();
	assert.deepEqual(r.calls(), [], "the trainer never ran");
	assert.deepEqual(candidateDirs(r), []);
});

test("a session: the dataset frozen, only the questions with enough labels trained from the released pin with replay, a temperature fitted on validation, one candidate registered", async () => {
	const r = rig();
	const res = await runTrainingSession(r.deps());
	assert.deepEqual([res.outcome, res.exitCode, res.reason], ["candidate", 0, null]);
	const db = r.db();
	const [a] = artifacts(db);
	const [s] = sessions(db);
	assert.equal(a!.id, res.artifactId);
	assert.deepEqual(
		[a!.state, a!.parent, a!.session_id, s!.outcome, s!.artifact_id, s!.dataset_id],
		["candidate", PARENT, res.sessionId, "candidate", a!.id, a!.dataset_id],
	);
	const ds = db
		.prepare("SELECT manifest_hash, manifest_json FROM decision_datasets WHERE id = ?")
		.get(a!.dataset_id) as {
		manifest_hash: string;
		manifest_json: string;
	};
	assert.equal(a!.dataset_hash, ds.manifest_hash);
	assert.deepEqual(JSON.parse(String(a!.trained_json)), [
		{ role: "memory_salience", question: "worth_remembering", yes: 24, no: 24 },
	]);

	// What the trainer was given.
	const [train, predict] = r.calls();
	const arg = (c: { args: string[] }, name: string) => c.args[c.args.indexOf(name) + 1];
	assert.equal(train!.tool, "train");
	assert.equal(arg(train!, "--parent"), PARENT, "always the released pin, never an earlier candidate");
	assert.equal(arg(train!, "--out-root"), candidatesDir(r.stateDir));
	assert.equal(arg(train!, "--suite"), join(r.stateDir, "suite"));
	// 48 own examples and two of Kev's own per example: three passes over 144 records, 8 a step.
	assert.deepEqual(
		[arg(train!, "--replay"), arg(train!, "--steps"), arg(train!, "--max-minutes")],
		["96", "54", "30"],
	);
	assert.equal(train!.args.includes("--max-state"), false);
	assert.deepEqual(JSON.parse(String(a!.training_json)).resources, {
		status: "ok",
		wall_s: 1.5,
		peak_cuda_bytes: 31_000_000_000,
	});

	// The candidate is the directory the trainer wrote, and the registry holds its manifest's hash.
	const dir = join(candidatesDir(r.stateDir), String(a!.id));
	assert.deepEqual(candidateDirs(r), [a!.id]);
	const manifestText = readFileSync(join(dir, "manifest.json"), "utf8");
	assert.equal(a!.manifest_sha256, createHash("sha256").update(manifestText).digest("hex"));
	// It was trained on memory salience's training examples only: no other question, nothing of the test days.
	const manifest = JSON.parse(ds.manifest_json) as { rows: { id: string; role: string; split: string }[] };
	const trainIds = manifest.rows.filter((x) => x.split === "train" && x.role === "memory_salience").map((x) => x.id);
	assert.equal((JSON.parse(manifestText) as { data: { records: number } }).data.records, trainIds.length);
	assert.equal(trainIds.length, 48);

	// Calibration: the scorer saw the candidate and the validation file, raw; the fit is Kev's rule on its answers.
	assert.deepEqual([predict!.tool, arg(predict!, "--run"), predict!.args.includes("--raw")], ["predict", dir, true]);
	const validation = manifest.rows.filter((x) => x.split === "validation");
	const labels = validation.map(
		(x) =>
			(db.prepare("SELECT value FROM decision_labels WHERE decision_id = ?").get(x.id) as { value: number })
				.value === 1,
	);
	const expected = fitTemperature(labels.map((label) => ({ margin: 2, label })))!;
	assert.equal(a!.temperature, expected.temperature);
	assert.deepEqual(JSON.parse(String(a!.calibration_json)), expected);
	assert.equal(expected.n, validation.length);
	assert.ok(expected.temperature > 1, "an overconfident scorer is cooled");
	assert.doesNotMatch(manifestText, /temperature/, "never written into the candidate");

	// The sealed test set was created, and not read: no look.
	assert.equal(count(db, "decision_test_sets"), 1);
	assert.equal(count(db, "decision_test_looks"), 0);
	// Nothing that people said is left on disk, and the lock is free for the host.
	assert.deepEqual(exportsLeft(r), []);
	assert.ok(unlocked(r));
	assert.match(
		r.lines.at(-1)!,
		/^candidate \S+ registered: 54 step\(s\).*temperature \d\.\d\d fitted on \d+ validation label\(s\).*It is not evaluated, served or active\.$/,
	);

	const report = learningReport(db, r.deps().settings, at(12, 21));
	assert.match(report, /^decision learning: on; a session runs only while Iyye is stopped/);
	assert.match(report, /a session now would be skipped: 0 owner label\(s\) since the last candidate; 30 are needed/);
	assert.match(
		report,
		new RegExp(
			`candidate ${a!.id}: trained on memory_salience worth_remembering \\(24 yes · 24 no\\); 54 step\\(s\\), [\\d.]+ min; temperature \\d\\.\\d\\d on ${expected.n} validation label\\(s\\)`,
		),
	);
	assert.match(report, /registry: 1 candidate\. A candidate is not evaluated, served or active/);
	db.close();

	// The next session needs new labels: the same ones do not train a second candidate.
	const again = await runTrainingSession(r.deps({ now: () => at(12, 22) }));
	assert.deepEqual(
		[again.outcome, again.reason],
		["skipped", "0 owner label(s) since the last candidate; 30 are needed"],
	);
	assert.equal(r.calls().length, 2);
});

test("a stop during training ends the session within a second, with nothing registered and nothing left (§15 #19)", async () => {
	const r = rig();
	const stop = new AbortController();
	const running = runTrainingSession(r.deps({ signal: stop.signal }, {}, { FAKE_TRAINER: "hang" }));
	const marker = join(candidatesDir(r.stateDir), "training-now");
	while (!existsSync(marker)) await new Promise((x) => setTimeout(x, 20));
	// While it trains, the lock is the session's: a host would be told so.
	assert.equal(readFileSync(join(r.stateDir, "host.lock"), "utf8"), String(process.pid));
	assert.equal(readFileSync(join(r.stateDir, "host.lock.who"), "utf8").trim(), TRAINING_HOLDER);
	assert.equal(exportsLeft(r).length, 1, "the training file exists only while the run needs it");
	const t0 = Date.now();
	stop.abort();
	const res = await running;
	assert.ok(Date.now() - t0 < 1000, `stopped in ${Date.now() - t0} ms`);
	assert.deepEqual([res.outcome, res.exitCode, res.artifactId], ["stopped", 143, null]);
	const db = r.db();
	assert.equal(count(db, "decision_artifacts"), 0);
	assert.deepEqual(
		sessions(db).map((s) => [s.outcome, s.reason, s.artifact_id]),
		[["stopped", "asked to stop during training", null]],
	);
	db.close();
	assert.deepEqual(candidateDirs(r), ["training-now"], "the partial run is gone");
	assert.deepEqual(exportsLeft(r), []);
	assert.ok(unlocked(r));
});

test("a failed, killed or dishonest run, or a stop during calibration, leaves the registry and the active bundle as they were", async () => {
	const r = rig();
	// Something already in the registry, standing for a bundle that is in use.
	const seed = r.db();
	seed
		.prepare(
			"INSERT INTO decision_test_sets (id, from_day, to_day, created_at) VALUES ('t0', '2026-01-01', '2026-01-02', 't')",
		)
		.run();
	seed.prepare("UPDATE decision_test_sets SET retired_at = 't', retired_reason = 'superseded' WHERE id = 't0'").run();
	seed
		.prepare(
			"INSERT INTO decision_datasets (id, created_at, created_by, test_set_id, policy_json, manifest_json, manifest_hash) VALUES ('d0', '2026-01-03', 'x', 't0', '{}', '{}', 'h')",
		)
		.run();
	seed
		.prepare(
			"INSERT INTO decision_training_sessions (id, started_at, ended_at, outcome) VALUES ('s0', '2026-01-03', '2026-01-03', 'candidate')",
		)
		.run();
	seed
		.prepare(
			`INSERT INTO decision_artifacts (id, state, parent, dataset_id, dataset_hash, manifest_sha256, trained_json, training_json, session_id, created_at)
			 VALUES ('20260103T020000Z-abcdef', 'active', ?, 'd0', 'h', 'm', '[]', '{}', 's0', '2026-01-03')`,
		)
		.run(PARENT);
	const before = JSON.stringify(artifacts(seed));
	seed.close();
	mkdirSync(join(candidatesDir(r.stateDir), "20260103T020000Z-abcdef"), { recursive: true });

	const stop = new AbortController();
	const runs: [Record<string, string>, AbortSignal | undefined, string, number, RegExp][] = [
		[{ FAKE_TRAINER: "fail" }, undefined, "failed", 1, /the trainer exited 1: .*CUDA out of memory/],
		[{ FAKE_TRAINER: "die" }, undefined, "failed", 1, /the trainer exited null/],
		[{ FAKE_TRAINER: "nothing" }, undefined, "failed", 1, /did not name a candidate/],
		[
			{ FAKE_TRAINER: "wrong-data" },
			undefined,
			"failed",
			1,
			/manifest does not name this session's parent and training file/,
		],
		[
			{ FAKE_PREDICT: "fail" },
			undefined,
			"failed",
			1,
			/the scorer exited 4: predict: the candidate does not match its manifest/,
		],
		[{ FAKE_PREDICT: "hang" }, stop.signal, "stopped", 143, /asked to stop during calibration/],
	];
	for (const [env, signal, outcome, code, reason] of runs) {
		const earlier = r.calls().length;
		const running = runTrainingSession(r.deps(signal ? { signal } : {}, {}, env));
		if (signal) {
			// Stop once this session's scorer is running (the trainer's call, then the scorer's, are logged).
			while (r.calls().length < earlier + 2) await new Promise((x) => setTimeout(x, 20));
			stop.abort();
		}
		const res = await running;
		assert.deepEqual([res.outcome, res.exitCode, res.artifactId], [outcome, code, null], JSON.stringify(env));
		assert.match(res.reason!, reason);
		const db = r.db();
		assert.equal(JSON.stringify(artifacts(db)), before, "the registry is as it was");
		db.close();
		// No candidate of this session is kept; the registered one's directory is untouched; a failure log may stay.
		assert.deepEqual(
			candidateDirs(r).filter((n) => !n.startsWith(".failed-") && n !== "training-now"),
			["20260103T020000Z-abcdef"],
			JSON.stringify(env),
		);
		assert.deepEqual(exportsLeft(r), []);
		assert.ok(unlocked(r));
	}
	const db = r.db();
	assert.deepEqual(
		sessions(db)
			.slice(1)
			.map((s) => s.outcome),
		runs.map((x) => x[2]),
	);
	db.close();
});

test("what a killed session left behind is cleaned by the next one: unregistered candidates, partial runs, exported files, its record", async () => {
	const r = rig();
	const cdir = candidatesDir(r.stateDir);
	const stray = join(cdir, "20261110T020000Z-aaaaaa");
	const partial = join(cdir, ".partial-20261110T020500Z-bbbbbb");
	const oldLog = join(cdir, ".failed-20261001T020000Z-cccccc");
	const newLog = join(cdir, ".failed-20261111T020000Z-dddddd");
	const other = join(cdir, "notes"); // not a candidate's name: not ours to delete
	for (const d of [stray, partial, oldLog, newLog, other]) mkdirSync(join(d, "run"), { recursive: true });
	utimesSync(oldLog, at(1).getTime() / 1000 - 30 * 86_400, at(1).getTime() / 1000 - 30 * 86_400);
	utimesSync(newLog, at(11).getTime() / 1000, at(11).getTime() / 1000);
	// A link with a candidate's name must not be followed.
	const outside = mkdtempSync(join(tmpdir(), "iyye-outside-"));
	dirs.push(outside);
	writeFileSync(join(outside, "keep.txt"), "x");
	symlinkSync(outside, join(cdir, "20261110T030000Z-eeeeee"));
	const left = join(r.stateDir, "decisions", "training", "sessions", "dead-session");
	mkdirSync(left, { recursive: true });
	writeFileSync(join(left, "train.jsonl"), '{"state":"what someone said"}\n');
	const db0 = r.db();
	db0.prepare(
		"INSERT INTO decision_training_sessions (id, started_at) VALUES ('dead-session', '2026-11-10T02:00:00.000Z')",
	).run();
	db0.close();

	const res = await runTrainingSession(r.deps());
	assert.equal(res.outcome, "candidate");
	assert.match(
		r.lines[0]!,
		/cleaned up after an unfinished session: 1 unregistered candidate\(s\), 1 partial run\(s\), 1 exported file set\(s\), 1 session record\(s\) closed, 1 old failure log\(s\)/,
	);
	assert.deepEqual(
		candidateDirs(r).sort(),
		[".failed-20261111T020000Z-dddddd", "20261110T030000Z-eeeeee", "notes", res.artifactId!].sort(),
	);
	assert.ok(existsSync(join(outside, "keep.txt")), "a link is never followed");
	assert.deepEqual(exportsLeft(r), []);
	const db = r.db();
	assert.deepEqual(
		sessions(db).map((s) => [s.id === "dead-session", s.outcome, s.reason]),
		[
			[true, "failed", "the session did not finish (killed, or the machine went down)"],
			[false, "candidate", null],
		],
	);
	db.close();
});

test("the lock: one holder, named; a dead holder's lock is taken over; only the holder gives it back", async () => {
	const dir = mkdtempSync(join(tmpdir(), "iyye-lock-"));
	dirs.push(dir);
	assert.deepEqual(acquireHostLock(dir, TRAINING_HOLDER), { ok: true });
	assert.equal(readFileSync(join(dir, "host.lock"), "utf8"), String(process.pid));
	assert.equal(readFileSync(join(dir, "host.lock.who"), "utf8").trim(), TRAINING_HOLDER);
	releaseHostLock(dir);
	assert.equal(existsSync(join(dir, "host.lock")) || existsSync(join(dir, "host.lock.who")), false);

	const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	writeFileSync(join(dir, "host.lock"), String(other.pid)); // a lock from before `host.lock.who` existed
	assert.deepEqual(acquireHostLock(dir, TRAINING_HOLDER), { ok: false, pid: other.pid, who: HOST });
	writeFileSync(join(dir, "host.lock.who"), `${TRAINING_HOLDER}\n`);
	assert.deepEqual(acquireHostLock(dir), { ok: false, pid: other.pid, who: TRAINING_HOLDER });
	releaseHostLock(dir);
	assert.equal(readFileSync(join(dir, "host.lock"), "utf8"), String(other.pid), "not ours to release");
	other.kill("SIGKILL");
	await new Promise((x) => other.once("exit", x));
	assert.deepEqual(acquireHostLock(dir), { ok: true });
	assert.equal(readFileSync(join(dir, "host.lock.who"), "utf8").trim(), HOST);
	releaseHostLock(dir);
	writeFileSync(join(dir, "host.lock"), ""); // an empty lock file is stale
	assert.deepEqual(acquireHostLock(dir), { ok: true });
	releaseHostLock(dir);
});

test("the temperature is Kev's fit: the grid point with the lowest mean NLL, from raw margins", () => {
	assert.equal(fitTemperature([]), null);
	// Confident and right: sharper is better, down to the grid's lowest point.
	assert.equal(
		fitTemperature([
			{ margin: 3, label: true },
			{ margin: -3, label: false },
		])!.temperature,
		0.25,
	);
	// Confident and half wrong: flatter is better, up to the highest.
	const wrong = fitTemperature([
		{ margin: 3, label: true },
		{ margin: 3, label: false },
	])!;
	assert.ok(Math.abs(wrong.temperature - 4) < 1e-9);
	assert.ok(wrong.nll_fitted < wrong.nll_raw);
	// In between: the fit is the best of the 121 grid points, checked by brute force.
	const rows = [3, 2.5, 4, 1, -2, 3.5, -3, 2, 0.5, -1].map((margin, i) => ({ margin, label: i % 3 !== 0 }));
	const fit = fitTemperature(rows)!;
	const grid = Array.from({ length: 121 }, (_, i) => Math.exp(Math.log(0.25) + (Math.log(16) * i) / 120));
	const best = grid.reduce((b, t) => (meanNll(rows, t) < meanNll(rows, b) ? t : b));
	assert.equal(fit.temperature, best);
	assert.ok(fit.temperature > 0.25 && fit.temperature < 4);
	assert.equal(fit.n, 10);
	// A probability's margin is its log-odds, floored away from 0 and 1.
	assert.ok(Math.abs(marginOf(1 / (1 + Math.exp(-2))) - 2) < 1e-9);
	assert.ok(Number.isFinite(marginOf(0)) && Number.isFinite(marginOf(1)));
});

test("steps follow the mix and stay within the trainer's bounds; a question trains only with enough of each class", () => {
	assert.equal(trainingSteps(48, 96, 3), 54);
	assert.equal(trainingSteps(1, 0, 1), 1);
	assert.equal(trainingSteps(5000, 20000, 3), 2000);
	const r = rig();
	const db = r.db();
	const plan = planDataset(db, { policy: datasetPolicy(), now: at(12, 20) });
	db.close();
	assert.deepEqual(trainable(plan, 20).questions, [
		{ role: "memory_salience", question: "worth_remembering", yes: 24, no: 24 },
	]);
	assert.deepEqual(
		trainable(plan, 1).questions.map((q) => q.role),
		["memory_salience", "reply_review"],
	);
	assert.deepEqual(trainable(plan, 100), {
		questions: [],
		closest: { role: "memory_salience", question: "worth_remembering", yes: 24, no: 24 },
	});
	assert.equal(localDay(at(12)), "2026-11-12");
});
