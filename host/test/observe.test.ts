// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.007 S4: observation domains, the workspace repository, the Kev
 * importance check (acting, with a fallback), findings (STM scope `iyye`,
 * web chat messages within limits), and how they are remembered and recalled.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { DecisionClient } from "../src/decisions/client.ts";
import { OBSERVATION_IMPORTANCE, ObservationImportance } from "../src/decisions/observation-importance.ts";
import { labelDecision } from "../src/decisions/report.ts";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { buildDigest } from "../src/kernel/day-summary.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import type { GateResult } from "../src/memory/gate.ts";
import { formatRecalled, MemoryGateway } from "../src/memory/gateway.ts";
import { VERBATIM_STRATEGY } from "../src/memory/hindsight.ts";
import { NightWork } from "../src/memory/night.ts";
import { type Domain, gitDomain, machineDomain, type ProbeResult } from "../src/observe/domains.ts";
import { Observer } from "../src/observe/observer.ts";
import { ensureWorkspace } from "../src/observe/workspace.ts";
import { type Db, openDb } from "../src/state/db.ts";
import { recordIyyeEntry } from "../src/state/stm.ts";
import { CHECKPOINT, FakeKev } from "./fixtures/fake-kev-http.ts";
import { FakeLtm } from "./fixtures/fake-ltm.ts";

describe("domains and their change rules", () => {
	const machine = machineDomain({ memoryGb: () => 50, loadedModels: async () => [], services: () => ({}) });
	const m = (o: Partial<Record<string, unknown>>): ProbeResult => ({
		diskFreeGb: 200,
		diskTotalGb: 1000,
		diskFreePct: 20,
		memAvailableGb: 50,
		swapUsedGb: 0,
		loadedModels: ["gemma-4-26B"],
		services: { "long-term memory": "up" },
		...o,
	});
	const now = new Date();

	test("machine: a crossing is a finding once, a fall of 5 points is one, small drift is nothing", () => {
		assert.deepEqual(
			machine.compare(null, m({}), now),
			{ severity: "none", text: null },
			"the first look is a baseline",
		);
		assert.equal(machine.compare(m({}), m({ diskFreePct: 19.6, diskFreeGb: 196 }), now).severity, "none");
		assert.deepEqual(machine.compare(m({}), m({ diskFreePct: 9, diskFreeGb: 90 }), now), {
			severity: "threshold",
			text: "free disk space is 9% (90 GB), low",
		});
		assert.equal(
			machine.compare(m({ diskFreePct: 9, diskFreeGb: 90 }), m({ diskFreePct: 8.5, diskFreeGb: 85 }), now).severity,
			"none",
			"still low: not again",
		);
		assert.equal(
			machine.compare(null, m({ diskFreePct: 8.5, diskFreeGb: 157, diskTotalGb: 1858 }), now).severity,
			"none",
			"8.5% of a large disk (157 GB) is not low",
		);
		assert.match(
			machine.compare(m({}), m({ diskFreePct: 14, diskFreeGb: 140 }), now).text!,
			/fell from 200 GB to 140 GB/,
		);
		assert.match(machine.compare(m({}), m({ memAvailableGb: 3 }), now).text!, /only 3 GB of memory/);
		assert.match(
			machine.compare(m({ swapUsedGb: 1 }), m({ swapUsedGb: 6 }), now).text!,
			/swap use grew from 1 GB to 6 GB/,
		);
		assert.deepEqual(machine.compare(m({}), m({ services: { "long-term memory": "retrying" } }), now), {
			severity: "threshold",
			text: "long-term memory is retrying",
		});
		assert.equal(
			machine.compare(m({ services: { "long-term memory": "retrying" } }), m({}), now).severity,
			"minor",
			"back up is minor",
		);
		assert.deepEqual(machine.compare(m({}), m({ loadedModels: [] }), now), {
			severity: "minor",
			text: "loaded models: none",
		});
		// A restart: services start up; the first look is a baseline, and starting/restarting are no change.
		const booting = m({ services: { "long-term memory": "starting", Telegram: "starting" } });
		assert.equal(machine.compare(null, booting, now).severity, "none", "no finding at every restart");
		assert.equal(
			machine.compare(booting, m({ services: { "long-term memory": "up", Telegram: "connected" } }), now).severity,
			"none",
		);
		assert.equal(machine.compare(m({}), m({ services: { "long-term memory": "restarting" } }), now).severity, "none");
		const broken = m({ services: { "long-term memory": "retrying" } });
		assert.equal(machine.compare(broken, broken, now).severity, "none", "still broken: not again");
	});

	test("the workspace is created once with a first commit; new commits and day-old uncommitted changes are findings", async () => {
		const dir = join(mkdtempSync(join(tmpdir(), "iyye-ws-")), "workspace");
		try {
			assert.equal(ensureWorkspace(dir, silentLogger), true);
			assert.equal(ensureWorkspace(dir, silentLogger), false, "never twice");
			const git = (...a: string[]) =>
				execFileSync("git", ["-C", dir, ...a], {
					encoding: "utf8",
					env: {
						PATH: process.env.PATH,
						HOME: dir,
						GIT_AUTHOR_NAME: "t",
						GIT_AUTHOR_EMAIL: "t@t",
						GIT_COMMITTER_NAME: "t",
						GIT_COMMITTER_EMAIL: "t@t",
					},
				});
			assert.match(git("log", "--format=%an %s"), /^Iyye Start Iyye's workspace$/m);
			const ws = gitDomain("workspace", dir, "the workspace", 3_600_000);
			const first = await ws.probe();
			assert.deepEqual(ws.compare(null, first, new Date()), { severity: "none", text: null });
			writeFileSync(join(dir, "disk_watch.py"), "THRESHOLD = 80\n");
			git("add", "disk_watch.py");
			git("commit", "-q", "-m", "Add a disk watch");
			const second = await ws.probe();
			assert.deepEqual(ws.compare(first, second, new Date()), {
				severity: "threshold",
				text: '1 new commit(s) in workspace: "Add a disk watch"',
			});
			writeFileSync(join(dir, "notes.md"), "draft\n");
			const third = await ws.probe();
			assert.equal(ws.compare(second, third, new Date()).severity, "minor", "a fresh uncommitted file is minor");
			const old = new Date(Date.now() - 2 * 86_400_000);
			utimesSync(join(dir, "notes.md"), old, old);
			const fourth = await ws.probe();
			assert.match(
				ws.compare(third, fourth, new Date()).text!,
				/uncommitted changes in workspace for more than a day: notes\.md/,
			);
			assert.equal(ws.compare(fourth, await ws.probe(), new Date()).severity, "none", "reported once");
			const missing = gitDomain("project", join(dir, "nope"), "x", 1);
			assert.equal(missing.compare(null, await missing.probe(), new Date()).severity, "threshold");
		} finally {
			rmSync(join(dir, ".."), { recursive: true, force: true });
		}
	});
});

describe("the observer", () => {
	let db: Db;
	let clock: { now: Date };
	let mode: "awake" | "asleep";
	let reading: ProbeResult;
	let probes: number;
	const sent: { key: string; text: string }[] = [];
	let answer: (o: {
		severity: string;
	}) =>
		| { kind: "decided"; finding: boolean; by: "kev" | "fallback"; decisionId: string | null }
		| { kind: "deferred" };
	const domain: Domain = {
		name: "machine",
		description: "test machine",
		stalenessMs: 3_600_000,
		probe: async () => {
			probes++;
			return reading;
		},
		compare: (prev, cur) =>
			prev && prev.disk !== cur.disk
				? { severity: cur.disk === "low" ? "threshold" : "minor", text: `disk is ${cur.disk}` }
				: { severity: "none", text: null },
	};
	const make = (findingsPerDay = 5) =>
		new Observer({
			db,
			domains: [domain],
			defaultEnabled: ["machine"],
			importance: { decide: async (o) => answer(o) },
			notifyOwner: async (key, text) => {
				sent.push({ key, text });
			},
			mode: () => mode,
			log: silentLogger,
			findingsPerDay,
			quietMs: 60_000,
			now: () => clock.now,
		});
	const later = (min: number) => {
		clock.now = new Date(clock.now.getTime() + min * 60_000);
	};

	beforeEach(() => {
		db = openDb(":memory:");
		clock = { now: new Date(2026, 9, 4, 12, 0) };
		mode = "awake";
		reading = { disk: "ok" };
		probes = 0;
		sent.length = 0;
		answer = () => ({ kind: "decided", finding: true, by: "kev", decisionId: "d1" });
	});

	test("probes a stale domain while awake only; a change Kev calls important is a finding in STM and one web message", async () => {
		const o = make();
		mode = "asleep";
		await o.tick();
		assert.equal(probes, 0, "asleep: no probes");
		mode = "awake";
		await o.tick();
		assert.equal(probes, 1, "the first look");
		await o.tick();
		assert.equal(probes, 1, "not stale yet");
		later(61);
		reading = { disk: "low" };
		await o.tick();
		const row = db.prepare("SELECT * FROM observations WHERE severity != 'none'").get() as Record<string, unknown>;
		assert.deepEqual(
			[row.change_text, row.decided_by, row.finding, row.decision_id],
			["disk is low", "kev", 1, "d1"],
		);
		assert.deepEqual(db.prepare("SELECT kind, scope, user_text, contact_id, channel FROM stm_episodes").all(), [
			{ kind: "observation", scope: "iyye", user_text: "machine: disk is low", contact_id: null, channel: null },
		]);
		assert.deepEqual(sent, [{ key: `finding:${row.id}`, text: "I noticed (machine): disk is low" }]);
		await o.tick();
		assert.equal(sent.length, 1, "once");
		assert.match(
			o.report(),
			/machine — enabled · every 1 h · test machine\n {4}last look \d\d:\d\d: disk is low \(finding\)/,
		);
		assert.match(o.report(), /findings today: 1 of at most 5 messages/);
	});

	test("Kev's 'no' records the change only; a busy device defers the decision to a later tick", async () => {
		const o = make();
		await o.tick();
		later(61);
		reading = { disk: "low" };
		answer = () => ({ kind: "deferred" });
		await o.tick();
		assert.equal(
			(
				db.prepare("SELECT decided_by FROM observations WHERE severity != 'none'").get() as {
					decided_by: string | null;
				}
			).decided_by,
			null,
		);
		answer = () => ({ kind: "decided", finding: false, by: "kev", decisionId: "d2" });
		await o.tick();
		assert.deepEqual(db.prepare("SELECT decided_by, finding FROM observations WHERE severity != 'none'").get(), {
			decided_by: "kev",
			finding: 0,
		});
		assert.equal((db.prepare("SELECT count(*) AS n FROM stm_episodes").get() as { n: number }).n, 0);
		assert.deepEqual(sent, []);
	});

	test("a finding waits while a conversation is active, and the daily cap holds even if every change is called important (#16)", async () => {
		const o = make(1);
		await o.tick();
		db.prepare(
			"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('e1', 'e1', 'web', 'owner', 'owner', 't', '{}', 'answered')",
		).run();
		db.prepare(
			"INSERT INTO jobs (id, trigger_event_id, scope, status, created_at, settled_at) VALUES ('j1', 'e1', 'owner', 'settled', ?, ?)",
		).run(clock.now.toISOString(), new Date(clock.now.getTime() + 61 * 60_000).toISOString());
		later(61);
		reading = { disk: "low" };
		await o.tick();
		assert.deepEqual(sent, [], "held: the owner was just talking");
		later(2);
		await o.tick();
		assert.equal(sent.length, 1, "sent once the conversation is quiet");
		later(61);
		reading = { disk: "ok" };
		await o.tick();
		later(61);
		reading = { disk: "low" };
		await o.tick();
		assert.equal(sent.length, 1, "the cap");
		assert.equal(
			(db.prepare("SELECT count(*) AS n FROM observations WHERE notified_at LIKE 'cap:%'").get() as { n: number }).n,
			2,
			"kept, not sent",
		);
		assert.equal(
			(db.prepare("SELECT count(*) AS n FROM stm_episodes").get() as { n: number }).n,
			3,
			"every finding is in STM",
		);
	});

	test("the owner enables and disables domains", async () => {
		const o = make();
		assert.match(o.setEnabled("machine", false), /machine disabled/);
		await o.tick();
		assert.equal(probes, 0);
		assert.match(o.setEnabled("weather", true), /no domain "weather"; domains: machine/);
		const ctx = {
			models: {} as never,
			db,
			issuer: "owner_web",
			domains: { report: () => o.report(), set: (n: string, on: boolean) => o.setEnabled(n, on) },
		};
		assert.match((await handleOwnerCommand("/domain enable machine", ctx)).reply, /machine enabled/);
		assert.match((await handleOwnerCommand("/domains", ctx)).reply, /machine — enabled/);
		assert.match(
			(await handleOwnerCommand("/domain on machine", ctx)).reply,
			/usage: \/domain enable\|disable <name>/,
		);
	});
});

describe("the importance check on Kev", () => {
	const kev = new FakeKev();
	before(() => kev.start());
	after(() => kev.stop());
	beforeEach(() => {
		kev.up = true;
		kev.checkpointInfo = CHECKPOINT;
	});

	test("yes and no come from Kev; unsure or Kev down falls back to the rule; a busy device defers; every answer is journaled and labellable", async () => {
		const db = openDb(":memory:");
		const device = new DeviceSlot();
		const imp = new ObservationImportance({ client: new DecisionClient({ db, service: kev.service }), device });
		const ask = (severity: "minor" | "threshold") =>
			imp.decide({
				observationId: `o-${severity}`,
				domain: "machine",
				change: "free disk space fell from 412 GB to 38 GB",
				severity,
			});
		kev.answer = () => 0.9;
		assert.deepEqual(await ask("minor"), { kind: "decided", finding: true, by: "kev", decisionId: await lastId() });
		kev.answer = () => 0.1;
		assert.equal(((await ask("threshold")) as { finding: boolean }).finding, false, "Kev's no wins over the rule");
		kev.answer = () => 0.4; // unsure
		assert.deepEqual(
			[(await ask("threshold")) as { finding: boolean; by: string }].map((r) => [r.finding, r.by]),
			[[true, "fallback"]],
		);
		assert.equal(((await ask("minor")) as { finding: boolean }).finding, false);
		kev.up = false;
		assert.equal(((await ask("threshold")) as { by: string }).by, "fallback");
		const release = device.tryAcquire("chat:x")!;
		assert.deepEqual(await ask("threshold"), { kind: "deferred" });
		release();
		const rows = db.prepare("SELECT role, scope, state_json FROM decisions").all() as {
			role: string;
			scope: string;
			state_json: string;
		}[];
		assert.ok(rows.every((r) => r.role === OBSERVATION_IMPORTANCE.name && r.scope === "iyye"));
		assert.deepEqual(JSON.parse(rows[0]!.state_json), {
			domain: "machine",
			change: "free disk space fell from 412 GB to 38 GB",
		});
		const id = (db.prepare("SELECT id FROM decisions LIMIT 1").get() as { id: string }).id;
		assert.match(labelDecision(db, id.slice(0, 8), "no", "owner_web", "t"), /not worth telling you about/);
		db.close();
		async function lastId() {
			return (db.prepare("SELECT id FROM decisions ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
		}
	});
});

describe("findings and day summaries in memory", () => {
	const ltm = new FakeLtm();
	before(() => ltm.start());
	after(() => ltm.stop());

	const openGate = {
		problem: null as string | null,
		async run<T>(_l: string, fn: (model: string) => Promise<T>): Promise<GateResult<T>> {
			return { ok: true, value: await fn("m"), model: "m" };
		},
	};

	test("rule 1: an investigation's answer is Iyye's own words, never recalled as a measurement", async () => {
		ltm.reset();
		const db = openDb(":memory:");
		db.prepare(
			"INSERT INTO observations (id, domain, at, result_json, result_hash, severity, change_text, decided_by, finding) VALUES ('inv1', 'investigation', ?, '{}', 'h', 'threshold', 'draft.py → the draft is unfinished, it has a TODO', 'kev', 1)",
		).run(new Date().toISOString());
		recordIyyeEntry(db, {
			id: "obs:inv1",
			kind: "observation",
			text: "investigation: draft.py → the draft is unfinished, it has a TODO",
			at: new Date().toISOString(),
		});
		const today = await new MemoryGateway({ db, ltm: null, log: silentLogger }).recall(
			{ scope: "owner", principal: "owner" },
			"draft unfinished",
		);
		assert.match(today.items[0]!.text, /^Your own investigation found: investigation: draft\.py/);
		await new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger }).run(() => false);
		const doc = ltm.docs.get("iyye-self/obs:inv1:observed")!;
		assert.ok(
			doc.tags.includes("speaker:iyye") && doc.tags.includes("investigation") && !doc.tags.includes("speaker:probe"),
		);
		assert.match(doc.context, /Iyye's own investigation/);
		const gw = new MemoryGateway({ db, ltm: ltm.client(), log: silentLogger, bankCacheMs: 0 });
		const perTurn = await gw.recall({ scope: "owner", principal: "owner" }, "draft unfinished TODO", {
			includeIyye: false,
		});
		assert.deepEqual(perTurn.items, [], "never a measurement: left out with the people's evidence");
		const search = await gw.recall({ scope: "owner", principal: "owner" }, "draft unfinished TODO", {
			includeIyye: true,
		});
		assert.deepEqual(
			search.items.map((i) => i.said),
			["iyye"],
			"memory_search shows it, as Iyye's own words",
		);
		db.close();
	});

	test("the owner recalls them labelled as Iyye's own; contacts never; the night keeps only durable ones, verbatim in iyye-self", async () => {
		const db = openDb(":memory:");
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('c1', 'Julia', 'contact', 't')",
		).run();
		recordIyyeEntry(db, {
			id: "obs:1",
			kind: "observation",
			text: "machine: free disk space is 9% (90 GB), below 10%",
			at: new Date().toISOString(),
		});
		recordIyyeEntry(db, {
			id: "summary:4",
			kind: "summary",
			text: "Day 4: a quiet day; free disk space was low.",
			at: new Date().toISOString(),
		});
		assert.equal(
			recordIyyeEntry(db, { id: "obs:1", kind: "observation", text: "again", at: "t" }),
			false,
			"idempotent",
		);
		const gw = new MemoryGateway({ db, ltm: null, log: silentLogger });
		const owner = await gw.recall({ scope: "owner", principal: "owner" }, "free disk space");
		assert.deepEqual(owner.items.map((i) => [i.from, i.text]).sort(), [
			["your own records", "Your day summary: Day 4: a quiet day; free disk space was low."],
			["your own records", "Your own probe observed: machine: free disk space is 9% (90 GB), below 10%"],
		]);
		const julia = await gw.recall({ scope: "contact:c1", principal: "contact" }, "free disk space");
		assert.deepEqual(julia.items, [], "contacts never read Iyye's own records");
		assert.match(
			buildDigest(db, { day: 4, from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z", outcome: null }),
			/^Day 4\./,
		);

		// A repository finding is knowledge; the machine finding and the day summary are not (2026-10-06).
		db.prepare(
			"INSERT INTO observations (id, domain, at, result_json, result_hash, severity, change_text, decided_by, finding) VALUES ('1', 'machine', ?, '{}', 'h', 'threshold', 'x', 'kev', 1), ('2', 'workspace', ?, '{}', 'h2', 'threshold', 'y', 'kev', 1)",
		).run(new Date().toISOString(), new Date().toISOString());
		recordIyyeEntry(db, {
			id: "obs:2",
			kind: "observation",
			text: 'workspace: 1 new commit(s): "add the free disk space probe below 10%"',
			at: new Date().toISOString(),
		});
		const out = await new NightWork({ db, ltm: ltm.client(), gate: openGate, log: silentLogger }).run(() => false);
		assert.equal(out.kind, "done");
		assert.equal(ltm.docs.get("iyye-self/obs:1:observed"), undefined, "a machine state is not kept");
		assert.equal(ltm.docs.get("iyye-self/summary:4:summary"), undefined, "nor the day summary");
		const obs = ltm.docs.get("iyye-self/obs:2:observed")!;
		assert.deepEqual([obs.strategy, obs.tags.includes("speaker:probe")], [VERBATIM_STRATEGY, true]);
		assert.deepEqual(
			Object.fromEntries(
				(db.prepare("SELECT event_id, state FROM stm_episodes").all() as { event_id: string; state: string }[]).map(
					(r) => [r.event_id, r.state],
				),
			),
			{ "obs:1": "completed_empty", "summary:4": "completed_empty", "obs:2": "completed" },
			"all leave short-term memory",
		);
		assert.equal(ltm.banks.get("iyye-self")!.observations, false, "Iyye's own bank builds no observations");

		// Recalled from long-term memory: a measurement is evidence, labelled as such.
		const gw2 = new MemoryGateway({ db, ltm: ltm.client(), log: silentLogger, bankCacheMs: 0 });
		const r = await gw2.recall({ scope: "owner", principal: "owner" }, "free disk space probe below");
		assert.ok(
			r.items.some((i) => i.said === "probe"),
			"the probe's finding is in the per-turn evidence",
		);
		assert.match(formatRecalled(r), /measured by your own probe\] workspace: 1 new commit/);
		const asJulia = await gw2.recall({ scope: "contact:c1", principal: "contact" }, "free disk space below");
		assert.deepEqual(asJulia.items, []);
		db.close();
	});
});
