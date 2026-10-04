// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.007 S5: opportunities and investigations (HLD §15 #9): a finding
 * that raises a question creates at most one investigation; a grounded answer
 * settles it; fruitless attempts cool down and suspend it, across restarts;
 * Iyye's own text is never evidence; the initiative role is shadow (#16).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { DecisionClient } from "../src/decisions/client.ts";
import { InitiativeShadow } from "../src/decisions/initiative.ts";
import { BackgroundWorker } from "../src/kernel/background.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import { checkCitations } from "../src/observe/citations.ts";
import { Investigations, questionFor } from "../src/observe/investigations.ts";
import { ensureWorkspace } from "../src/observe/workspace.ts";
import { type BackgroundJob, getBackgroundJob, insertBackgroundJob } from "../src/state/background.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { recordIyyeEntry } from "../src/state/stm.ts";
import { projectToolkit } from "../src/tools/project.ts";
import { FakeKev } from "./fixtures/fake-kev-http.ts";

describe("the project toolkit", () => {
	const root = mkdtempSync(join(tmpdir(), "iyye-proj-"));
	const ws = join(root, "workspace");
	before(() => {
		ensureWorkspace(ws, silentLogger);
		writeFileSync(join(ws, "disk_watch.py"), "THRESHOLD_GB = 80\n");
		writeFileSync(join(ws, ".env"), "TOKEN=secret\n");
		mkdirSync(join(ws, "sub"));
		writeFileSync(join(ws, "sub", "big.txt"), "x".repeat(10_000));
		writeFileSync(join(root, "outside.txt"), "outside\n");
		symlinkSync(join(root, "outside.txt"), join(ws, "escape.txt"));
		execFileSync("git", ["-C", ws, "add", "disk_watch.py"], { env: { PATH: process.env.PATH, HOME: ws } });
		execFileSync("git", ["-C", ws, "commit", "-q", "-m", "Add a disk watch"], {
			env: {
				PATH: process.env.PATH,
				HOME: ws,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	});
	after(() => rmSync(root, { recursive: true, force: true }));
	const tool = (name: string) => projectToolkit({ workspace: ws }).tools.find((t) => t.name === name)!;
	const ctx = { scope: "iyye:inv:x", principal: "iyye" as const };

	test("reads commits, a commit, the status and files of a named repository only", async () => {
		const log = await tool("git_log").run({ repo: "workspace" }, ctx, undefined);
		assert.match(log, /^[0-9a-f]{7,} \d{4}-\d\d-\d\d Add a disk watch$/m);
		const hash = log.split(" ")[0]!;
		assert.match(
			await tool("git_show").run({ repo: "workspace", commit: hash }, ctx, undefined),
			/disk_watch\.py[\s\S]*THRESHOLD_GB = 80/,
		);
		assert.match(
			await tool("git_show").run({ repo: "workspace", commit: "abcdef1" }, ctx, undefined),
			/no commit abcdef1/,
		);
		assert.match(await tool("git_status").run({ repo: "workspace" }, ctx, undefined), /\?\? sub\//);
		assert.equal(
			await tool("read_file").run({ repo: "workspace", path: "disk_watch.py" }, ctx, undefined),
			"THRESHOLD_GB = 80\n",
		);
		assert.match(
			await tool("read_file").run({ repo: "workspace", path: "sub/big.txt" }, ctx, undefined),
			/cut at 4000 characters\)$/,
		);
		assert.match(await tool("git_log").run({ repo: "project" }, ctx, undefined), /no repository named "project"/);
		const toolkit = projectToolkit({ workspace: ws });
		assert.equal(toolkit.effect, "read");
		assert.deepEqual(
			toolkit.tools.map((t) => t.name),
			["git_log", "git_show", "git_status", "read_file"],
		);
	});

	test("refuses paths outside the repository, its internals, likely secrets and symlink escapes", async () => {
		const read = (path: string) => tool("read_file").run({ repo: "workspace", path }, ctx, undefined);
		assert.match(await read("../outside.txt"), /refused: give a path inside the repository/);
		assert.match(await read(join(root, "outside.txt")), /refused: give a path inside the repository/);
		assert.match(await read(".git/config"), /refused: the repository's internals/);
		assert.match(await read(".env"), /refused: this looks like a secret/);
		assert.match(await read("escape.txt"), /refused: outside the repository/);
		assert.match(await read("sub"), /not a file/);
		assert.match(await read("nope.py"), /no such file/);
	});
});

test("the citation check: what the answer names must come from the tools or the evidence", () => {
	const tools = "a1b2c3d 2026-10-04 Raise the disk threshold to 80 GB\ndisk_watch.py | 2 +-\nDisk: 157.9 GB free";
	assert.deepEqual(
		checkCitations("Commit `a1b2c3d` changed **disk_watch.py**: the threshold is now $80\\text{ GB}$.", tools),
		{
			cited: ["a1b2c3d", "80GB", "disk_watch.py"],
			invented: [],
		},
	);
	assert.deepEqual(checkCitations("Commit 9f8e7d6 changed config.py.", tools).invented, ["9f8e7d6", "config.py"]);
	assert.deepEqual(
		checkCitations("The workspace looks fine and nothing decayed.", tools).cited,
		[],
		"plain words are not hashes",
	);
	assert.deepEqual(checkCitations("There is 157.9 GB free.", tools), { cited: ["157.9GB"], invented: [] });
});

test("only repository findings raise a question", () => {
	assert.match(
		questionFor("workspace", '2 new commit(s) in workspace: "A", "B"')!,
		/What do the new commits in the workspace repository change\?/,
	);
	assert.match(
		questionFor("project", "uncommitted changes in project for more than a day: a.py")!,
		/uncommitted changes in the project repository/,
	);
	assert.equal(
		questionFor("machine", "free disk space fell from 400 GB to 38 GB"),
		null,
		"no read-only tool can say what uses the disk",
	);
	assert.equal(questionFor("workspace", "something else"), null);
});

describe("investigations", () => {
	let db: Db;
	let enqueued: { origin: string; prompt: string; session?: string }[];
	let paused: boolean;
	let energyOk: boolean;
	let mode: "awake" | "asleep";
	let clock: { now: Date };
	let asked: string[];
	let outcomes: [string, boolean][];
	let seq = 0;

	function finding(domain: string, change: string, finding = 1): string {
		const id = `obs-${++seq}`;
		db.prepare(
			"INSERT INTO observations (id, domain, at, result_json, result_hash, severity, change_text, decided_by, finding) VALUES (?, ?, ?, '{}', 'h', 'threshold', ?, 'kev', ?)",
		).run(id, domain, clock.now.toISOString(), change, finding);
		return id;
	}
	function make() {
		return new Investigations({
			db,
			worker: {
				enqueue: (step) => {
					// Like the real worker: the step exists as a queued background job at once.
					enqueued.push(step);
					const id = `job-${enqueued.length}-q${seq++}`;
					insertBackgroundJob(db, {
						id,
						origin: step.origin,
						session: step.session!,
						prompt: step.prompt,
						at: clock.now.toISOString(),
					});
					return id;
				},
				initiativePaused: () => paused,
			},
			energy: { backgroundAllowed: () => energyOk },
			mode: () => mode,
			initiative: {
				ask: async (o) => {
					asked.push(o.id);
					return `d-${o.id}`;
				},
				outcome: (id, fruitful) => {
					outcomes.push([id, fruitful]);
				},
			},
			log: silentLogger,
			now: () => clock.now,
			cooldownMs: 3_600_000,
		});
	}
	/** A step of the current attempt settles with `answer`, after tools returned `toolResult`. */
	function settle(inv: Investigations, answer: string, toolResult: string | null) {
		const step = enqueued.at(-1)!;
		const job = `job-${enqueued.length}-${seq++}`;
		if (toolResult !== null) {
			db.prepare(
				"INSERT INTO tool_calls (id, scope, principal, tool, args_json, outcome, result, started_at, finished_at) VALUES (?, ?, 'iyye', 'git_show', '{}', 'ok', ?, ?, ?)",
			).run(`tc-${job}`, step.session, toolResult, clock.now.toISOString(), clock.now.toISOString());
		}
		insertBackgroundJob(db, {
			id: job,
			origin: step.origin,
			session: step.session!,
			prompt: step.prompt,
			at: clock.now.toISOString(),
		});
		db.prepare("UPDATE background_jobs SET status = 'settled', result = ?, settled_at = ? WHERE id = ?").run(
			answer,
			clock.now.toISOString(),
			job,
		);
		inv.onStepSettled(getBackgroundJob(db, job)!);
	}
	const opps = () =>
		db.prepare("SELECT status, attempts, fruitless, steps FROM opportunities").all() as Record<string, unknown>[];

	beforeEach(() => {
		db = openDb(":memory:");
		enqueued = [];
		paused = false;
		energyOk = true;
		mode = "awake";
		clock = { now: new Date(2026, 9, 4, 12, 0) };
		asked = [];
		outcomes = [];
	});

	test("#9: a repository finding becomes one opportunity; one investigation at a time; a grounded answer settles it for good", async () => {
		const inv = make();
		const evidence = finding("workspace", '1 new commit(s) in workspace: "Raise the disk threshold to 80 GB"');
		finding("workspace", '1 new commit(s) in workspace: "Add notes"');
		finding("machine", "free disk space fell from 400 GB to 38 GB");
		finding("workspace", '1 new commit(s) in workspace: "Routine"', 0); // not a finding
		await inv.tick();
		await inv.tick();
		assert.equal(
			(db.prepare("SELECT count(*) AS n FROM opportunities").get() as { n: number }).n,
			2,
			"one per repository finding, once",
		);
		assert.equal(enqueued.length, 1, "one investigation at a time");
		assert.match(enqueued[0]!.prompt, /^Investigation: What do the new commits in the workspace repository change\?/);
		assert.match(
			enqueued[0]!.prompt,
			/Evidence, observed by Iyye's workspace probe: 1 new commit\(s\) in workspace: "Raise the disk threshold to 80 GB"/,
		);
		assert.equal(asked.length, 1, "the initiative role was asked (shadow)");

		settle(
			inv,
			"Commit a1b2c3d raised THRESHOLD_GB in disk_watch.py from 50 to 80.",
			"a1b2c3d Raise the disk threshold\n disk_watch.py | 2 +-\n-THRESHOLD_GB = 50\n+THRESHOLD_GB = 80",
		);
		const settled = db
			.prepare("SELECT * FROM opportunities WHERE cluster = ?")
			.get(`observation:${evidence}`) as Record<string, string>;
		assert.equal(settled.status, "settled");
		const obs = db
			.prepare("SELECT domain, severity, change_text, decided_by FROM observations WHERE id = ?")
			.get(settled.finding_id) as Record<string, unknown>;
		assert.deepEqual(
			[obs.domain, obs.severity, obs.decided_by],
			["investigation", "threshold", null],
			"a new finding, for the importance check",
		);
		assert.match(String(obs.change_text), /→ Commit a1b2c3d raised THRESHOLD_GB in disk_watch\.py/);
		assert.deepEqual(outcomes, [[`d-${settled.id}`, true]]);
		await inv.tick();
		assert.equal(enqueued.length, 2, "the next opportunity starts");
		await inv.tick();
		assert.equal(
			(db.prepare("SELECT count(*) AS n FROM opportunities").get() as { n: number }).n,
			2,
			"a settled finding never qualifies again",
		);
	});

	test("an ungrounded answer is asked again in the same session; three steps without one is a fruitless attempt; cooldown, then suspension across restarts", async () => {
		let inv = make();
		finding("workspace", '1 new commit(s) in workspace: "X"');
		for (let attempt = 1; attempt <= 3; attempt++) {
			await inv.tick();
			const session = enqueued.at(-1)!.session;
			settle(inv, "I looked and everything seems fine.", null); // no tool, no citation
			assert.equal(enqueued.at(-1)!.session, session, "the next step continues the attempt");
			assert.match(enqueued.at(-1)!.prompt, /not accepted: it used no tool/);
			assert.match(
				enqueued.at(-1)!.prompt,
				/\n\nInvestigation: What do the new commits/,
				"self-contained if its session is lost",
			);
			settle(inv, "Commit 9f8e7d6 changed config.py.", "a1b2c3d X\n notes.md | 1 +");
			assert.match(enqueued.at(-1)!.prompt, /it names 9f8e7d6, config\.py, which the tools did not return/);
			settle(inv, "Nothing to report.", "a1b2c3d X");
			assert.equal(opps()[0]!.fruitless, attempt);
			if (attempt < 3) {
				const before = enqueued.length;
				await inv.tick();
				assert.equal(enqueued.length, before, "cooldown");
				clock.now = new Date(clock.now.getTime() + 61 * 60_000);
				inv = make(); // a restart in between: the counters are in SQLite
			}
		}
		assert.deepEqual(opps(), [{ status: "suspended", attempts: 3, fruitless: 3, steps: 3 }]);
		clock.now = new Date(clock.now.getTime() + 24 * 3_600_000);
		const before = enqueued.length;
		await make().tick();
		assert.equal(enqueued.length, before, "suspended: no more attempts");
		assert.deepEqual(
			outcomes.map(([, f]) => f),
			[false, false, false],
		);
	});

	test("waits while initiative is paused, energy is low, or asleep; a failed step, or one settled before a restart, is reconciled", async () => {
		const inv = make();
		finding("workspace", '1 new commit(s) in workspace: "X"');
		paused = true;
		await inv.tick();
		paused = false;
		energyOk = false;
		await inv.tick();
		energyOk = true;
		mode = "asleep";
		await inv.tick();
		assert.equal(enqueued.length, 0);
		mode = "awake";
		await inv.tick();
		assert.equal(enqueued.length, 1);
		const step = enqueued[0]!;
		insertBackgroundJob(db, {
			id: "j-failed",
			origin: step.origin,
			session: step.session!,
			prompt: step.prompt,
			at: clock.now.toISOString(),
		});
		db.prepare(
			"UPDATE background_jobs SET status = 'failed', error = 'the model stopped' WHERE id = 'j-failed'",
		).run();
		await inv.tick();
		assert.deepEqual(opps()[0], { status: "open", attempts: 1, fruitless: 1, steps: 1 });

		clock.now = new Date(clock.now.getTime() + 61 * 60_000);
		await inv.tick();
		const s2 = enqueued.at(-1)!;
		// The step settled, then the host stopped before evaluating it: the next sweep does.
		insertBackgroundJob(db, {
			id: "j-done",
			origin: s2.origin,
			session: s2.session!,
			prompt: s2.prompt,
			at: clock.now.toISOString(),
		});
		db.prepare(
			"INSERT INTO tool_calls (id, scope, principal, tool, args_json, outcome, result, started_at, finished_at) VALUES ('tc', ?, 'iyye', 'git_log', '{}', 'ok', 'b4c5d6e X', 't', 't')",
		).run(s2.session);
		db.prepare(
			"UPDATE background_jobs SET status = 'settled', result = 'Commit b4c5d6e did X.' WHERE id = 'j-done'",
		).run();
		await make().tick();
		assert.equal(opps()[0]!.status, "settled");
	});

	test("rule 1: Iyye's own text never creates an opportunity", async () => {
		const inv = make();
		recordIyyeEntry(db, {
			id: "summary:1",
			kind: "summary",
			text: "CRITICAL FAILURE: 3 new commit(s) in workspace",
			at: clock.now.toISOString(),
		});
		insertBackgroundJob(db, { id: "narr", origin: "test", session: "s", prompt: "p", at: clock.now.toISOString() });
		db.prepare(
			"UPDATE background_jobs SET status = 'settled', result = '1 new commit(s) in workspace: critical failure' WHERE id = 'narr'",
		).run();
		db.prepare(
			"INSERT INTO observations (id, domain, at, result_json, result_hash, severity, change_text, decided_by, finding) VALUES ('inv-1', 'investigation', 't', '{}', 'h', 'threshold', '1 new commit(s) in workspace: x → y', 'kev', 1)",
		).run();
		await inv.tick();
		assert.equal((db.prepare("SELECT count(*) AS n FROM opportunities").get() as { n: number }).n, 0);
		assert.equal(enqueued.length, 0);
	});
});

describe("#16: the initiative role is shadow", () => {
	const kev = new FakeKev();
	before(() => kev.start());
	after(() => kev.stop());

	test("Kev answering always yes or always no changes nothing that happens", async () => {
		const runs: string[] = [];
		for (const p of [1.0, 0.0]) {
			kev.answer = () => p;
			const db = openDb(":memory:");
			db.prepare(
				"INSERT INTO observations (id, domain, at, result_json, result_hash, severity, change_text, decided_by, finding) VALUES ('o1', 'workspace', 't', '{}', 'h', 'threshold', '1 new commit(s) in workspace: \"X\"', 'kev', 1)",
			).run();
			const enq: string[] = [];
			const inv = new Investigations({
				db,
				worker: {
					enqueue: (s) => {
						enq.push(s.prompt);
						insertBackgroundJob(db, {
							id: `j${enq.length}`,
							origin: s.origin,
							session: s.session!,
							prompt: s.prompt,
							at: "t",
						});
						return `j${enq.length}`;
					},
					initiativePaused: () => false,
				},
				mode: () => "awake",
				initiative: new InitiativeShadow({
					client: new DecisionClient({ db, service: kev.service }),
					device: new DeviceSlot(),
				}),
				log: silentLogger,
			});
			await inv.tick();
			const d = db.prepare("SELECT role, status, verdicts_json FROM decisions").get() as Record<string, string>;
			assert.equal(d.role, "initiative");
			runs.push(JSON.stringify({ enq, opps: db.prepare("SELECT status, attempts FROM opportunities").all() }));
			db.close();
		}
		assert.equal(runs[0], runs[1]);
	});
});

test("end to end with the background worker: the step's result reaches the investigation through onSettled", async () => {
	const db = openDb(":memory:");
	db.prepare(
		"INSERT INTO observations (id, domain, at, result_json, result_hash, severity, change_text, decided_by, finding) VALUES ('o1', 'workspace', 't', '{}', 'h', 'threshold', '1 new commit(s) in workspace: \"Add notes\"', 'kev', 1)",
	).run();
	let inv: Investigations | null = null;
	const worker = new BackgroundWorker({
		db,
		device: new DeviceSlot(),
		models: { selected: () => "m", acquire: async () => ({ model: "m", valid: () => true, release: () => {} }) },
		conversations: {
			sessionFile: () => null,
			turn: async (req) => {
				// The model looked with a tool, then answered citing it.
				db.prepare(
					"INSERT INTO tool_calls (id, scope, principal, tool, args_json, outcome, result, started_at, finished_at) VALUES (?, ?, 'iyye', 'git_log', '{}', 'ok', 'c0ffee1 Add notes\n notes.md | 1 +', 't', 't')",
				).run(crypto.randomUUID(), req.scope);
				return { ok: true, text: "Commit c0ffee1 added notes.md.", model: "m" };
			},
		},
		chatPending: () => false,
		log: silentLogger,
		onSettled: (job: BackgroundJob) => inv!.onStepSettled(job),
		quietMs: 0,
		gapMs: 0,
		pollMs: 60_000,
	});
	inv = new Investigations({ db, worker, mode: () => "awake", log: silentLogger });
	await inv.tick();
	assert.equal(await worker.drainOnce(), true);
	assert.equal(
		(db.prepare("SELECT status FROM opportunities").get() as { status: string }).status,
		"settled",
		"the answer cites the hash and file the tool returned",
	);
	db.close();
});
