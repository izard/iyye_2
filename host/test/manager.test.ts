// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { AwakeStopwatch, type ModelLease, type OpResult } from "../src/models/manager.ts";
import { pidAlive } from "../src/models/router.ts";
import { getSelectedModel, type ModelOpRow, setSelectedModel } from "../src/state/models.ts";
import { type ManagerRig, managerRig, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";

function ops(rig: ManagerRig): Pick<ModelOpRow, "op" | "model_name" | "state">[] {
	return (rig.db.prepare("SELECT op, model_name, state FROM model_ops ORDER BY rowid").all() as ModelOpRow[]).map(
		({ op, model_name, state }) => ({ op, model_name, state }),
	);
}

function isLease(x: ModelLease | OpResult): x is ModelLease {
	return "release" in x;
}

describe("model manager", () => {
	const sb: Sandbox = sandbox();
	let rig: ManagerRig;
	beforeEach(async () => {
		rig = await managerRig(sb);
	});
	afterEach(async () => {
		await rig.manager.stop();
		rig.db.close();
	});
	after(() => sb.cleanup());

	test("start launches the router, seeds both channels with the default, and loads it", async () => {
		await rig.manager.start();
		assert.equal(rig.manager.state, "up");
		assert.equal(getSelectedModel(rig.db, "web"), "small");
		assert.equal(getSelectedModel(rig.db, "telegram"), "small");
		const s = await rig.manager.status();
		assert.equal(s.models.find((m) => m.name === "small")!.status, "loaded");
		assert.equal(s.models.find((m) => m.name === "missing")!.status, "unavailable");
		assert.ok(!s.models.some((m) => m.name === "default"), "router-only ids are not shown");
		assert.deepEqual(ops(rig), [
			{ op: "router_start", model_name: null, state: "done" },
			{ op: "load", model_name: "small", state: "done" },
		]);
	});

	test("an owner's earlier selection survives restart; the default only seeds empty channels", async () => {
		setSelectedModel(rig.db, "telegram", "small-2", "owner", "2026-10-01T00:00:00Z");
		await rig.manager.start();
		assert.equal(getSelectedModel(rig.db, "telegram"), "small-2");
		const s = await rig.manager.status();
		assert.equal(s.models.find((m) => m.name === "small-2")!.status, "loaded");
	});

	test("a load that does not fit free RAM is refused visibly and nothing is unloaded", async () => {
		await rig.manager.start();
		rig.ram.gb = 10;
		const r = await rig.manager.load("huge", "owner");
		assert.equal(r.ok, false);
		assert.match(
			r.message,
			/huge needs 999 GB but only 9\.0 GB is available \(10\.0 GB reclaimable minus 1 GB for loaded models\); loaded: small \(1 GB\)/,
		);
		const s = await rig.manager.status();
		assert.equal(s.models.find((m) => m.name === "small")!.status, "loaded");
		assert.deepEqual(ops(rig).at(-1), { op: "load", model_name: "huge", state: "refused" });
	});

	test("RAM held by loaded models is reserved even when the OS figure does not show it", async () => {
		await rig.manager.start(); // "small" (1 GB) is loaded
		rig.ram.gb = 1.5; // the OS still reports 1.5 GB reclaimable
		const r = await rig.manager.load("small-2", "owner");
		assert.equal(r.ok, false);
		assert.match(r.message, /small-2 needs 1 GB but only 0\.5 GB is available/);
	});

	test("the host enforces the loaded-model cap instead of letting the router evict", async () => {
		await rig.manager.start();
		assert.equal((await rig.manager.load("small-2", "owner")).ok, true);
		const r = await rig.manager.load("small-3", "owner");
		assert.equal(r.ok, false);
		assert.match(r.message, /at most 2 model\(s\) may be loaded; unload one of: small, small-2/);
	});

	test("unknown and missing-file models are refused", async () => {
		await rig.manager.start();
		assert.match((await rig.manager.load("nope", "owner")).message, /unknown model nope/);
		assert.match((await rig.manager.load("missing", "owner")).message, /GGUF file missing/);
	});

	test("a failed load is reported as failed and leaves the model unloaded", async () => {
		await rig.manager.start();
		const r = await rig.manager.load("broken-x", "owner");
		assert.equal(r.ok, false);
		assert.match(r.message, /broken-x failed to load \(exit code 1\)/);
		assert.deepEqual(ops(rig).at(-1), { op: "load", model_name: "broken-x", state: "failed" });
		const s = await rig.manager.status();
		assert.equal(s.models.find((m) => m.name === "broken-x")!.status, "unloaded");
	});

	test("a load that never finishes times out and is unloaded", async () => {
		await rig.manager.start();
		const r = await rig.manager.load("slow-x", "owner");
		assert.equal(r.ok, false);
		assert.match(r.message, /slow-x did not finish loading within 2 s/);
	});

	test("a model that loads but cannot answer is not counted as loaded", async () => {
		await rig.manager.start();
		const r = await rig.manager.load("mute-x", "owner");
		assert.equal(r.ok, false);
		assert.match(r.message, /mute-x loaded but did not answer a test request/);
		await waitFor(
			async () => (await rig.manager.status()).models.find((m) => m.name === "mute-x")!.status === "unloaded",
		);
	});

	test("A11: a model in use cannot be unloaded until its lease is released", async () => {
		await rig.manager.start();
		const lease = await rig.manager.acquire("small");
		assert.ok(isLease(lease));
		const r = await rig.manager.unload("small", "owner");
		assert.equal(r.ok, false);
		assert.match(r.message, /small is in use by 1 running job/);
		lease.release();
		const r2 = await rig.manager.unload("small", "owner");
		assert.equal(r2.ok, true);
		assert.match(r2.message, /small unloaded; web and telegram now has no loaded model/);
	});

	test("A11 race: a concurrent acquire and unload never both succeed", async () => {
		await rig.manager.start();
		for (let i = 0; i < 5; i++) {
			const [lease, unloaded] = await Promise.all([
				rig.manager.acquire("small"),
				rig.manager.unload("small", "owner"),
			]);
			const leased = isLease(lease);
			assert.ok(!(leased && unloaded.ok && unloaded.message.includes("unloaded")), `round ${i}: both succeeded`);
			if (leased) lease.release();
			if ((await rig.manager.status()).models.find((m) => m.name === "small")!.status !== "loaded") {
				assert.equal((await rig.manager.load("small", "owner")).ok, true);
			}
		}
	});

	test("no inference starts while a model is loading: acquire answers busy, then succeeds", async () => {
		await rig.manager.start();
		const loading = rig.manager.load("slow-x", "owner");
		await waitFor(async () => {
			const r = await rig.manager.acquire("small");
			if ("release" in r) {
				r.release();
				return false;
			}
			assert.equal(r.busy, true);
			assert.match(r.message, /waiting for slow-x to finish loading/);
			return true;
		});
		await loading;
		const after = await rig.manager.acquire("small");
		assert.ok("release" in after);
		after.release();
	});

	test("acquire refuses a model that is not loaded instead of substituting another", async () => {
		await rig.manager.start();
		const r = await rig.manager.acquire("small-2");
		assert.ok(!isLease(r));
		assert.match(r.message, /small-2 is not loaded/);
	});

	test("A10: /use applies to the next job; a running job keeps its model", async () => {
		await rig.manager.start();
		const running = await rig.manager.acquire(getSelectedModel(rig.db, "web")!);
		assert.ok(isLease(running) && running.model === "small");
		assert.match((await rig.manager.select("web", "small-2", "owner")).message, /small-2 is not loaded/);
		await rig.manager.load("small-2", "owner");
		assert.equal((await rig.manager.select("web", "small-2", "owner")).ok, true);
		assert.equal(running.valid(), true);
		assert.equal(running.model, "small");
		assert.equal(getSelectedModel(rig.db, "web"), "small-2");
		assert.equal(getSelectedModel(rig.db, "telegram"), "small");
		running.release();
	});

	test("A13: when the router dies, leases are invalidated, it restarts, and selected models reload", async () => {
		await rig.manager.stop();
		rig.db.close();
		rig = await managerRig(sb, { healthIntervalMs: 100 });
		const lost: string[][] = [];
		rig.manager.onRouterLost((models) => lost.push(models));
		await rig.manager.start();
		const lease = await rig.manager.acquire("small");
		assert.ok(isLease(lease));
		const oldPid = rig.router.pid!;
		process.kill(oldPid, "SIGKILL");
		await waitFor(() => lost.length === 1, 5000);
		assert.deepEqual(lost[0], ["small"]);
		assert.equal(lease.valid(), false);
		// The reload is complete when its operation is recorded as done.
		await waitFor(() => ops(rig).filter((o) => o.op === "load" && o.state === "done").length === 2, 8000);
		assert.equal(rig.manager.state, "up");
		assert.notEqual(rig.router.pid, oldPid);
		assert.equal(pidAlive(oldPid), false);
		const kinds = ops(rig).map((o) => `${o.op}:${o.model_name ?? ""}:${o.state}`);
		assert.deepEqual(kinds.slice(-2), ["router_start::done", "load:small:done"]);
	});

	test("owner commands drive the manager and report refusals", async () => {
		await rig.manager.start();
		const ctx = { models: rig.manager, db: rig.db, issuer: "owner_terminal" };
		const list = await handleOwnerCommand("/models", ctx);
		assert.match(list.reply, /router: up/);
		assert.match(list.reply, /small — loaded · 1 GB · selected: web, telegram/);
		assert.match((await handleOwnerCommand("/load small-2", ctx)).reply, /small-2 loaded/);
		assert.match((await handleOwnerCommand("/use small-2 telegram", ctx)).reply, /telegram now uses small-2/);
		assert.match((await handleOwnerCommand("/use small-2 sms", ctx)).reply, /usage/);
		assert.match((await handleOwnerCommand("/load huge", ctx)).reply, /^refused: at most 2 model/);
		assert.equal((await handleOwnerCommand("/frobnicate", ctx)).handled, false);
		const row = rig.db.prepare("SELECT requested_by FROM model_ops WHERE model_name = 'small-2'").get() as {
			requested_by: string;
		};
		assert.equal(row.requested_by, "owner_terminal");
	});

	describe("self-healing and sleep (2026-10-05 incident)", () => {
		const healing = (overrides = {}) =>
			managerRig(sb, { healthIntervalMs: 50, healBackoffMs: [0, 50, 50], ...overrides });

		test("a selected chat model that is not loaded is loaded again by day; a job asking for it waits (busy), never fails", async () => {
			await rig.manager.stop();
			rig.db.close();
			rig = await healing();
			await rig.manager.start();
			// Gone without the owner asking (e.g. a failed load at waking, or a crash).
			assert.ok((await rig.manager.unload("small", "system")).ok);
			const r = await rig.manager.acquire("small");
			assert.ok(!isLease(r) && r.busy === true, "busy: the scheduler keeps the job waiting");
			assert.match((r as OpResult).message, /small is not loaded; loading it again/);
			await waitFor(async () => isLease(await rig.manager.acquire("small")), 5000);
			assert.deepEqual(ops(rig).at(-1), { op: "load", model_name: "small", state: "done" });
			assert.equal(
				(
					rig.db.prepare("SELECT requested_by FROM model_ops ORDER BY rowid DESC LIMIT 1").get() as {
						requested_by: string;
					}
				).requested_by,
				"self_heal",
			);
		});

		test("a model the owner unloaded stays unloaded, and nothing is reloaded at night", async () => {
			await rig.manager.stop();
			rig.db.close();
			rig = await healing();
			await rig.manager.start();
			assert.ok((await rig.manager.unload("small", "owner_web")).ok);
			const r = await rig.manager.acquire("small");
			assert.ok(!isLease(r) && !r.busy);
			await new Promise((x) => setTimeout(x, 300));
			assert.equal((await rig.manager.status()).models.find((m) => m.name === "small")!.status, "unloaded");
			// /load brings it back and lifts the hold.
			assert.ok((await rig.manager.load("small", "owner_web")).ok);
			// Asleep: the night unloads it, and the health check does not bring it back.
			await rig.manager.restForNight([], "night");
			await new Promise((x) => setTimeout(x, 300));
			assert.equal((await rig.manager.status()).models.find((m) => m.name === "small")!.status, "unloaded");
			// Waking loads it.
			assert.ok((await rig.manager.wakeFromNight("waking")).ok);
		});

		test("after every attempt fails Iyye gives up, says so, and the job is no longer told to wait", async () => {
			await rig.manager.stop();
			rig.db.close();
			rig = await healing();
			await rig.manager.start();
			setSelectedModel(rig.db, "web", "broken-x", "test", new Date().toISOString());
			await rig.manager.acquire("broken-x"); // starts the attempts
			await waitFor(() => ops(rig).filter((o) => o.op === "load" && o.model_name === "broken-x").length === 3, 8000);
			await new Promise((x) => setTimeout(x, 200));
			const r = await rig.manager.acquire("broken-x");
			assert.ok(!isLease(r) && !r.busy);
			assert.match(
				(r as OpResult).message,
				/could not be loaded after 3 attempts \(last: .*failed to load.*\); \/load it/,
			);
			assert.equal(
				ops(rig).filter((o) => o.op === "load" && o.model_name === "broken-x").length,
				3,
				"no fourth try",
			);
		});

		test("a load deadline does not count time the computer slept", async () => {
			await rig.manager.stop();
			rig.db.close();
			// The process is frozen while the computer sleeps: the clock jumps by an hour between two polls.
			const clock = { ms: 0 };
			rig = await managerRig(sb, { monotonicMs: () => clock.ms, minLoadTimeoutMs: 10_000 });
			await rig.manager.start();
			const load = rig.manager.load("slow-x", "owner");
			await new Promise((x) => setTimeout(x, 100));
			clock.ms += 3_600_000; // an hour asleep counts as one capped step (5 s max), not an hour
			await new Promise((x) => setTimeout(x, 300));
			let settled = false;
			void load.then(() => {
				settled = true;
			});
			await new Promise((x) => setTimeout(x, 50));
			assert.equal(settled, false, "still waiting: the hour asleep did not count");
			// Awake again: time runs in small steps until the 1.5 s deadline passes.
			const tick = setInterval(() => {
				clock.ms += 400;
			}, 20);
			const r = await load;
			clearInterval(tick);
			assert.match(r.message, /slow-x did not finish loading within 10 s/);
		});

		test("AwakeStopwatch counts small steps and caps a frozen gap", () => {
			const clock = { ms: 0 };
			const w = new AwakeStopwatch(() => clock.ms, 5000);
			clock.ms = 1000;
			assert.equal(w.elapsed(), 1000);
			clock.ms += 7 * 3_600_000;
			assert.equal(w.elapsed(), 6000);
		});
	});
});
