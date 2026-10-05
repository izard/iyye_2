// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.007 S1: background work that gives way to people. Steps run on the
 * background model (fake router), in their own Pi conversations, with the
 * principal `iyye`; a person's need for the device pauses them at once, and
 * they resume later from their checkpoint (HLD §15 #10).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { Type } from "typebox";
import { createLocalModelRuntime } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { admitOwnerWebMessage } from "../src/kernel/admission.ts";
import { BackgroundWorker, RESUME_NOTE } from "../src/kernel/background.ts";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { focusReport } from "../src/kernel/focus.ts";
import { silentLogger } from "../src/log.ts";
import type { ModelManager } from "../src/models/manager.ts";
import { type BackgroundJob, getBackgroundJob, insertBackgroundJob } from "../src/state/background.ts";
import type { Db } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { forgetSession, retireSessions } from "../src/state/sessions.ts";
import { type IyyeTool, ToolBroker } from "../src/tools/broker.ts";
import { managerRig, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";
import { type Stack, startStack } from "./web-helpers.ts";

test("a preemptible holder is asked to give way, once, when someone waits for the device", async () => {
	const slot = new DeviceSlot();
	let asked = 0;
	const release = slot.tryAcquire("background:x", { onPreempt: () => asked++ })!;
	assert.equal(slot.tryAcquire("decision:y"), null, "tryAcquire never preempts");
	assert.equal(asked, 0);
	const waiting = slot.acquire("chat:1");
	const waiting2 = slot.acquire("chat:2");
	assert.equal(asked, 1, "asked once");
	assert.equal(slot.contended, true);
	release();
	(await waiting)();
	(await waiting2)();
	const plain = slot.tryAcquire("memory:z")!;
	const w = slot.acquire("chat:3");
	assert.equal(asked, 1, "a holder without onPreempt is not asked");
	plain();
	(await w)();
});

describe("background work", () => {
	let sb: Sandbox;
	let db: Db;
	let models: ModelManager;
	let stopRouter: () => Promise<void>;
	let device: DeviceSlot;
	let conv: PiConversations;
	let worker: BackgroundWorker;
	let mode: "awake" | "winding_down" | "asleep";
	let pending: boolean;
	const probeRuns: string[] = [];
	const settled: BackgroundJob[] = [];
	const requestsFile = () => join(sb.stateDir, "fake-router-requests.jsonl");
	const requests = () =>
		existsSync(requestsFile())
			? readFileSync(requestsFile(), "utf8")
					.trim()
					.split("\n")
					.map(
						(l) =>
							JSON.parse(l) as {
								model: string;
								messages: { role: string; content: unknown }[];
								tools?: { function: { name: string } }[];
							},
					)
			: [];
	const probe: IyyeTool = {
		name: "probe",
		label: "Probe",
		description: "a slow probe",
		summary: "a slow probe",
		parameters: Type.Object({}),
		run: async () => {
			probeRuns.push(new Date().toISOString());
			await new Promise((r) => setTimeout(r, 300));
			return "disk 42% free";
		},
	};
	const ownerOnly: IyyeTool = { ...probe, name: "act_thing", description: "an owner-only effect" };

	function makeWorker(opts: { quietMs?: number; gapMs?: number; maxPauses?: number } = {}) {
		return new BackgroundWorker({
			db,
			device,
			models,
			conversations: conv,
			chatPending: () => pending,
			rhythm: { mode: () => mode },
			log: silentLogger,
			onSettled: (j) => settled.push(j),
			quietMs: opts.quietMs ?? 0,
			gapMs: opts.gapMs ?? 0,
			maxPauses: opts.maxPauses ?? 5,
			pollMs: 60_000, // tests call drainOnce themselves
			watchMs: 20,
		});
	}

	before(async () => {
		sb = sandbox();
		const rig = await managerRig(sb, { defaultBackgroundModel: "small-2" });
		await rig.manager.start();
		db = rig.db;
		models = rig.manager;
		stopRouter = () => rig.manager.stop();
		conv = new PiConversations({
			db,
			runtime: await createLocalModelRuntime({ routerUrl: rig.router.url, registry: sb.registry }),
			stateDir: join(sb.stateDir, "background"),
			identity: "You are Iyye.",
			log: silentLogger,
			tools: new ToolBroker({
				db,
				log: silentLogger,
				toolkits: [
					{ name: "machine", description: "this computer", effect: "read", tools: [probe] },
					{ name: "effects", description: "owner effects", effect: "act", tools: [ownerOnly] },
				],
			}),
		});
	});
	after(async () => {
		await conv.disposeAll();
		await stopRouter();
		sb.cleanup();
	});
	beforeEach(() => {
		device = new DeviceSlot();
		mode = "awake";
		pending = false;
		probeRuns.length = 0;
		settled.length = 0;
		db.prepare("DELETE FROM background_jobs").run();
		db.prepare("DELETE FROM kv WHERE key = 'background.paused'").run();
		rmSync(requestsFile(), { force: true });
		worker = makeWorker();
	});
	afterEach(() => worker.stop());

	test("the background model is selected and loaded by day; a step runs with read-only tools as `iyye`; its result goes to its origin", async () => {
		assert.equal(models.selected("background"), "small-2");
		assert.ok((await models.status()).models.some((m) => m.name === "small-2" && m.status === "loaded"));
		const id = worker.enqueue({ origin: "test:probe", prompt: "check the disk [[tool:probe]]" });
		assert.equal(await worker.drainOnce(), true);
		const job = getBackgroundJob(db, id)!;
		assert.equal(job.status, "settled", String(job.error));
		assert.equal(job.result, "tool result: disk 42% free");
		assert.equal(job.model_name, "small-2");
		assert.deepEqual(
			settled.map((j) => j.id),
			[id],
		);
		const req = requests()[0]!;
		assert.equal(req.model, "small-2");
		assert.deepEqual(
			req.tools?.map((t) => t.function.name),
			["probe"],
			"an `act` toolkit is never declared to background work",
		);
		assert.match(
			JSON.stringify(req.messages[0]),
			/This is your own background work: no person is in this conversation/,
		);
		assert.deepEqual(db.prepare("SELECT principal, tool, outcome FROM tool_calls WHERE scope = ?").all(job.session), [
			{ principal: "iyye", tool: "probe", outcome: "ok" },
		]);
		assert.equal(device.holder, null);
	});

	test("waits while initiative is paused, asleep, a person waits, a conversation was recent, or steps need spacing; never loads a model", async () => {
		worker.enqueue({ origin: "test:wait", prompt: "hello" });
		const blocked = async (why: RegExp) => {
			assert.equal(await worker.drainOnce(), false);
			assert.match(worker.status().waiting, why);
		};
		worker.pauseInitiative("owner_web");
		await blocked(/initiative is paused/);
		worker.resumeInitiative();
		mode = "asleep";
		await blocked(/Iyye is asleep/);
		mode = "awake";
		pending = true;
		await blocked(/a person is waiting/);
		pending = false;
		db.prepare(
			"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES ('e1', 'e1', 'web', 'owner', 'owner', ?, '{}', 'answered')",
		).run(new Date().toISOString());
		db.prepare(
			"INSERT INTO jobs (id, trigger_event_id, scope, status, created_at, settled_at) VALUES ('j1', 'e1', 'owner', 'settled', ?, ?)",
		).run(new Date().toISOString(), new Date().toISOString());
		const quiet = makeWorker({ quietMs: 60_000 });
		assert.equal(await quiet.drainOnce(), false);
		assert.match(quiet.status().waiting, /a conversation was active; background work may start at \d\d:\d\d/);
		db.prepare("DELETE FROM jobs").run();
		db.prepare("DELETE FROM events").run();

		const spaced = makeWorker({ gapMs: 60_000 });
		assert.equal(await spaced.drainOnce(), true);
		spaced.enqueue({ origin: "test:wait", prompt: "again" });
		assert.equal(await spaced.drainOnce(), false);
		assert.match(spaced.status().waiting, /spacing steps/);

		assert.match((await models.unload("small-2", "test")).message, /unloaded/);
		await blocked(/the background model is not available: small-2 is not loaded/);
		assert.ok(
			(await models.status()).models.some((m) => m.name === "small-2" && m.status !== "loaded"),
			"the worker never loads it",
		);
		await models.load("small-2", "test");
	});

	test("#10: a person's turn gets the device at once; the step pauses, keeps its tool result, and resumes from its checkpoint", async () => {
		const id = worker.enqueue({ origin: "test:pause", prompt: "measure [[tool:probe]] [[slow]]" });
		const run = worker.drainOnce();
		await waitFor(() => probeRuns.length === 1, 5000);
		await new Promise((r) => setTimeout(r, 450)); // the tool finished; the model is generating (1.5 s)
		const t0 = Date.now();
		const release = await device.acquire("chat:j1");
		const waited = Date.now() - t0;
		assert.ok(waited < 1000, `waited ${waited} ms for the device`);
		assert.equal(await run, true);
		let job = getBackgroundJob(db, id)!;
		assert.deepEqual([job.status, job.pauses, job.result], ["paused", 1, null], "nothing stale committed");
		assert.deepEqual(settled, []);
		assert.equal(await worker.drainOnce(), false, "the device is held by the chat turn");
		assert.match(worker.status().waiting, /the device is busy \(chat:j1\)/);
		release();

		assert.equal(await worker.drainOnce(), true);
		job = getBackgroundJob(db, id)!;
		assert.equal(job.status, "settled");
		assert.equal(probeRuns.length, 1, "the tool was not run again");
		const resume = requests().at(-1)!;
		const texts = resume.messages.map((m) => `${m.role}:${JSON.stringify(m.content)}`);
		assert.ok(
			texts.some((t) => t.startsWith("tool:") && t.includes("disk 42% free")),
			"the checkpoint holds the tool result",
		);
		assert.match(texts.at(-1)!, /You were paused and are resuming now/);
		assert.equal(job.result, `echo: ${RESUME_NOTE}`);
	});

	test("falling asleep and /pause initiative pause a running step; a step paused too often is suspended", async () => {
		const w = makeWorker({ maxPauses: 2 });
		const id = w.enqueue({ origin: "test:sleep", prompt: "measure [[slow-always]]" });
		const run = w.drainOnce();
		await new Promise((r) => setTimeout(r, 200));
		mode = "winding_down";
		await run;
		assert.deepEqual([getBackgroundJob(db, id)!.status, getBackgroundJob(db, id)!.pauses], ["paused", 1]);
		mode = "awake";

		const ctx = {
			models: {} as never,
			db,
			issuer: "owner_web",
			focus: { report: () => "", pause: (by: string) => w.pauseInitiative(by), resume: () => w.resumeInitiative() },
		};
		const run2 = w.drainOnce();
		await new Promise((r) => setTimeout(r, 200));
		assert.match((await handleOwnerCommand("/pause initiative", ctx)).reply, /Initiative paused/);
		await run2;
		const job = getBackgroundJob(db, id)!;
		assert.equal(job.status, "suspended");
		assert.match(job.error!, /paused 2 times \(last: initiative was paused by the owner\)/);
		assert.match((await handleOwnerCommand("/resume initiative", ctx)).reply, /Initiative resumed/);
		assert.match((await handleOwnerCommand("/pause", ctx)).reply, /usage: \/pause initiative/);
	});

	test("a restart pauses a step left running; a paused step whose session is gone starts again from its prompt", async () => {
		const at = new Date().toISOString();
		insertBackgroundJob(db, {
			id: "b-crash",
			origin: "test:crash",
			session: "iyye:bg:b-crash",
			prompt: "first [[tool:probe]]",
			at,
		});
		db.prepare("UPDATE background_jobs SET status = 'running' WHERE id = 'b-crash'").run();
		const w = makeWorker();
		w.pauseInitiative("test"); // only the recovery runs at start, no step
		w.start();
		assert.equal(getBackgroundJob(db, "b-crash")!.status, "paused");
		await w.stop();
		assert.equal(await w.drainOnce(), false, "stopped");
		w.resumeInitiative();
		const fresh = makeWorker();
		assert.equal(await fresh.drainOnce(), true);
		assert.equal(getBackgroundJob(db, "b-crash")!.status, "settled");
		assert.match(
			JSON.stringify(
				requests()
					.at(-1)!
					.messages.findLast((m) => m.role === "user"),
			),
			/first \[\[tool:probe\]\]/,
			"no session: the prompt again",
		);

		// A paused step whose session was retired (the night) starts again too.
		insertBackgroundJob(db, {
			id: "b-night",
			origin: "test:night",
			session: "iyye:bg:b-night",
			prompt: "second",
			at,
		});
		db.prepare("UPDATE background_jobs SET status = 'paused' WHERE id = 'b-night'").run();
		forgetSession(db, "iyye:bg:b-night");
		assert.equal(await fresh.drainOnce(), true);
		assert.equal(getBackgroundJob(db, "b-night")!.result, "echo: second");
	});

	test("after a night (every session retired, background conversations closed) a paused step starts afresh from its prompt", async () => {
		const id = worker.enqueue({ origin: "test:night", prompt: "measure [[tool:probe]] [[slow-always]]" });
		const run = worker.drainOnce();
		await waitFor(() => probeRuns.length === 1, 5000);
		const release = await device.acquire("chat:night");
		await run;
		release();
		assert.equal(getBackgroundJob(db, id)!.status, "paused");
		// What the night does (main.ts onNightEnd): chat's resetAll retires every session row; background conversations are closed.
		retireSessions(db);
		await conv.disposeAll();
		rmSync(requestsFile(), { force: true });
		const next = worker.drainOnce();
		await waitFor(() => requests().length >= 1, 5000);
		const first = requests()[0]!.messages.map((m) => m.role);
		assert.deepEqual(first, ["system", "user"], "a fresh conversation: no earlier tool call or result");
		await next;
	});

	test("/focus shows what runs now, the order, the model, the queue and why background work waits", async () => {
		worker.enqueue({ origin: "investigation:disk", prompt: "x" });
		worker.pauseInitiative("owner_web");
		const report = focusReport({
			db,
			worker,
			deviceHolder: "chat:abc",
			queuedReplies: 1,
			backgroundModel: { name: "small-2", loaded: true },
			quietS: 180,
			gapS: 30,
		});
		assert.match(report, /^now: answering a message$/m);
		assert.match(
			report,
			/order: owner input → people waiting → owner-requested work → background work \(only after 3 min without conversation; steps at least 30 s apart\)/,
		);
		assert.match(report, /people waiting: 1 message/);
		assert.match(report, /initiative: PAUSED/);
		assert.match(report, /background model: small-2 \(loaded\)/);
		assert.match(report, /background: waiting: initiative is paused/);
		assert.match(report, /background queue: 1\n {2}[0-9a-f]{8} investigation:disk — queued/);
	});
});

describe("background work with the real scheduler", () => {
	let sb: Sandbox;
	let s: Stack | null = null;
	afterEach(async () => {
		await s?.stop();
		s = null;
		sb?.cleanup();
	});

	test("an owner message during a background step is answered first; the step resumes after the quiet period; night unloads and waking reloads the background model", async () => {
		sb = sandbox();
		const device = new DeviceSlot();
		s = await startStack(sb, { device });
		await s.models.load("small-2", "test");
		assert.equal((await s.models.select("background", "small-2", "test")).ok, true);
		const conv = new PiConversations({
			db: s.db,
			runtime: await createLocalModelRuntime({ routerUrl: s.router.url, registry: sb.registry }),
			stateDir: join(sb.stateDir, "background"),
			identity: "You are Iyye.",
			log: silentLogger,
		});
		const worker = new BackgroundWorker({
			db: s.db,
			device,
			models: s.models,
			conversations: conv,
			chatPending: () => s!.scheduler.hasRunnableJobs() || s!.scheduler.busy,
			log: silentLogger,
			quietMs: 400,
			gapMs: 0,
			pollMs: 50,
			watchMs: 20,
		});
		const id = worker.enqueue({ origin: "test:scheduler", prompt: "think [[slow]]" });
		worker.start();
		await waitFor(() => getBackgroundJob(s!.db, id)!.status === "running");
		const msg = admitOwnerWebMessage(
			{ db: s.db, now: () => new Date(), newId: () => crypto.randomUUID() },
			{ clientMsgId: "bg-msg-1", text: "hello" },
		);
		assert.ok(msg.outcome === "admitted");
		const t0 = Date.now();
		s.scheduler.wake();
		await waitFor(() => getEvent(s!.db, msg.eventId)!.status === "answered", 5000);
		assert.ok(Date.now() - t0 < 1500, `answered in ${Date.now() - t0} ms, not after the 1.5 s background generation`);
		assert.equal(getBackgroundJob(s.db, id)!.status, "paused");
		await waitFor(() => getBackgroundJob(s!.db, id)!.status === "settled", 8000);
		await worker.stop();
		await conv.disposeAll();

		// Night: only the memory model stays; waking brings the background model back.
		await s.models.restForNight([], "test");
		assert.ok(!(await s.models.status()).models.some((m) => m.status === "loaded"));
		await s.models.wakeFromNight("test");
		const loaded = (await s.models.status()).models.filter((m) => m.status === "loaded").map((m) => m.name);
		assert.deepEqual(loaded.sort(), ["small", "small-2"]);
	});
});
