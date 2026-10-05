// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import Database from "better-sqlite3";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import { MemoryGate } from "../src/memory/gate.ts";
import { MemoryPassthrough } from "../src/memory/passthrough.ts";
import { migrate } from "../src/state/db.ts";
import { getSelectedModel, setSelectedModel } from "../src/state/models.ts";
import { freePort, type ManagerRig, managerRig, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";

const KEY = "k".repeat(64);

interface Reply {
	status: number;
	body: string;
}

/** A Hindsight-shaped model call to the pass-through. */
function call(
	port: number,
	opts: { path?: string; method?: string; key?: string; text?: string; stream?: boolean } = {},
): Promise<Reply> {
	const payload = JSON.stringify({
		model: "whatever-hindsight-says",
		stream: opts.stream ?? false,
		messages: [{ role: "user", content: opts.text ?? "extract facts" }],
	});
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path: opts.path ?? "/v1/chat/completions",
				method: opts.method ?? "POST",
				headers: { authorization: `Bearer ${opts.key ?? KEY}`, "content-type": "application/json" },
			},
			(res) => {
				let body = "";
				res.on("data", (d) => {
					body += d;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

function forwarded(sb: Sandbox): Record<string, unknown>[] {
	try {
		return readFileSync(join(sb.stateDir, "fake-router-requests.jsonl"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return [];
	}
}

describe("memory pass-through and gate", () => {
	const sb = sandbox();
	let rig: ManagerRig;
	let pt: MemoryPassthrough;
	let port: number;
	let device: DeviceSlot;
	let chatPending: boolean;
	let gate: MemoryGate;

	beforeEach(async () => {
		rig = await managerRig(sb, { defaultMemoryModel: "small-2" });
		port = await freePort();
		pt = new MemoryPassthrough({ port, routerUrl: rig.router.url, key: () => KEY, log: silentLogger });
		rig.manager.onRouterLost(() => pt.abortAll("router lost"));
		await pt.start();
		device = new DeviceSlot();
		chatPending = false;
		gate = new MemoryGate({
			device,
			models: rig.manager,
			passthrough: pt,
			chatPending: () => chatPending,
			log: silentLogger,
			drainMs: 3000,
		});
		await rig.manager.start();
	});
	afterEach(async () => {
		await pt.stop();
		await rig.manager.stop();
		rig.db.close();
	});
	after(() => sb.cleanup());

	test("only the chat endpoint, only with the key: wrong key 401, other paths 404", async () => {
		assert.equal((await call(port, { key: "wrong" })).status, 401);
		assert.equal((await call(port, { path: "/v1/completions" })).status, 404);
		assert.equal((await call(port, { path: "/models", method: "GET" })).status, 404);
		assert.equal((await call(port, { path: "/v1/models", method: "GET" })).status, 200);
		assert.equal((await call(port, { path: "/v1/models", method: "GET", key: "wrong" })).status, 401);
	});

	test("outside the gate every model call gets 503 and nothing reaches the router", async () => {
		const before = forwarded(sb).length;
		const r = await call(port);
		assert.equal(r.status, 503);
		assert.match(r.body, /not admitted/);
		assert.equal(forwarded(sb).length, before);
	});

	test("inside the gate a call is forwarded on the memory model with thinking off; the model is loaded on demand", async () => {
		assert.equal(getSelectedModel(rig.db, "memory"), "small-2", "seeded from the default memory model");
		const before = forwarded(sb).length;
		const r = await gate.run("retain", async (model) => {
			assert.equal(model, "small-2");
			return call(port, { text: "Julia plays violin" });
		});
		assert.ok(r.ok);
		assert.equal(r.value.status, 200);
		assert.match(r.value.body, /echo: Julia plays violin/);
		// The manager's own load check also asks the model once; Hindsight's call is the one with its text.
		const sent = forwarded(sb)
			.slice(before)
			.filter((b) => JSON.stringify(b).includes("Julia"));
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.model, "small-2", "Hindsight's model name is overwritten");
		assert.deepEqual(sent[0]!.chat_template_kwargs, { enable_thinking: false }, "off unless the admission asks");
		const s = await rig.manager.status();
		assert.equal(s.models.find((m) => m.name === "small-2")!.status, "loaded");
		assert.equal(s.models.find((m) => m.name === "small-2")!.inUse, 0, "lease released after the operation");
		assert.equal(device.holder, null, "device released");
		assert.equal((await call(port)).status, 503, "closed again afterwards");
	});

	test("streams responses through", async () => {
		const r = await gate.run("retain", () => call(port, { text: "stream me please", stream: true }));
		assert.ok(r.ok);
		assert.match(r.value.body, /^data: /);
		assert.match(r.value.body, /\[DONE\]/);
		const text = [...r.value.body.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("");
		assert.equal(text, "echo: stream me please");
	});

	test("memory work never waits in line: a queued chat job or a held device makes it decline at once", async () => {
		chatPending = true;
		const queued = await gate.run("retain", async () => "ran");
		assert.deepEqual(queued, { ok: false, busy: true, message: "a chat job is waiting" });
		chatPending = false;
		const release = await device.acquire("chat:job-1");
		const held = await gate.run("retain", async () => "ran");
		assert.deepEqual(held, { ok: false, busy: true, message: "the device is in use" });
		release();
		assert.equal(gate.problem, null, "being busy is not a problem for the owner");
	});

	test("a chat turn waits for the device until memory work has fully let go", async () => {
		const order: string[] = [];
		let chatGot: Promise<() => void> | null = null;
		const r = await gate.run("retain", async () => {
			chatGot = device.acquire("chat:job-2").then((rel) => {
				order.push("chat");
				return rel;
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
			order.push("memory done");
		});
		assert.ok(r.ok);
		(await chatGot!)();
		assert.deepEqual(order, ["memory done", "chat"]);
	});

	test("closing drains in-flight calls first: the memory model cannot be unloaded until they finish", async () => {
		let unloadDuring: string | null = null;
		const r = await gate.run("consolidate", async () => {
			// Hindsight fires a call and the operation "ends" before it returns.
			void call(port, { text: "[[slow]] consolidate" });
			await waitFor(() => forwarded(sb).some((b) => JSON.stringify(b).includes("consolidate")));
			setTimeout(async () => {
				unloadDuring = (await rig.manager.unload("small-2", "owner_terminal")).message;
			}, 100);
		});
		assert.ok(r.ok);
		assert.match(unloadDuring!, /in use/);
		assert.equal((await rig.manager.unload("small-2", "owner_terminal")).ok, true, "free after the drain");
	});

	test("a call whose body is still arriving when the gate closes is refused, never forwarded", async () => {
		const before = forwarded(sb).length;
		let late: Promise<Reply> | null = null;
		const r = await gate.run("retain", async () => {
			late = new Promise((resolve, reject) => {
				const req = request(
					{
						host: "127.0.0.1",
						port,
						path: "/v1/chat/completions",
						method: "POST",
						headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
					},
					(res) => {
						let body = "";
						res.on("data", (d) => {
							body += d;
						});
						res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
					},
				);
				req.on("error", reject);
				req.write('{"model":"x","messages":[{"role":"user",');
				// The rest arrives after the gate has let go of the device.
				setTimeout(() => req.end('"content":"late body"}]}'), 200);
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		assert.ok(r.ok);
		assert.equal(device.holder, null);
		assert.equal((await late!).status, 503);
		assert.equal(
			forwarded(sb)
				.slice(before)
				.filter((b) => JSON.stringify(b).includes("late body")).length,
			0,
		);
	});

	test("a call still running when the drain time is up is aborted", async () => {
		const short = new MemoryGate({
			device,
			models: rig.manager,
			passthrough: pt,
			chatPending: () => false,
			log: silentLogger,
			drainMs: 100,
		});
		let slow: Promise<Reply | Error> = Promise.resolve(new Error("not sent"));
		const t0 = Date.now();
		const r = await short.run("retain", async () => {
			slow = call(port, { text: "[[slow]] long", stream: true }).catch((e: Error) => e);
			await waitFor(() => forwarded(sb).some((b) => JSON.stringify(b).includes("long")));
		});
		assert.ok(r.ok);
		assert.ok(Date.now() - t0 < 1400, "did not wait for the slow call");
		const result = await slow;
		assert.ok(result instanceof Error || result.status === 503, "the slow call did not complete");
	});

	test("router lost: in-flight memory calls are aborted and later calls get 503", async () => {
		const r = await gate.run("retain", async () => {
			const slow = call(port, { text: "[[slow]] router dies", stream: true }).catch((e: Error) => e);
			await waitFor(() => forwarded(sb).some((b) => JSON.stringify(b).includes("router dies")));
			const restart = rig.manager.restartRouter("test");
			const outcome = await slow;
			assert.ok(outcome instanceof Error || outcome.status >= 500, "the call failed instead of completing");
			assert.equal((await call(port)).status, 503, "no new calls once the router was lost");
			await restart;
		});
		assert.ok(r.ok);
	});

	test("a full model cap is shown as a memory problem, not retried silently", async () => {
		assert.ok((await rig.manager.load("small-3", "owner_terminal")).ok); // small + small-3 = cap of 2
		const r = await gate.run("retain", async () => "ran");
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.busy, false);
		assert.match(gate.problem!, /memory model small-2 not loaded: at most 2 model/);
		assert.equal(device.holder, null);
		await rig.manager.unload("small-3", "owner_terminal");
		assert.ok((await gate.run("retain", async () => "ran")).ok);
		assert.equal(gate.problem, null, "cleared once memory work runs");
	});

	test("/use <model> memory persists without loading the model; unknown models are refused", async () => {
		const ctx = { models: rig.manager, db: rig.db, issuer: "owner_terminal" };
		assert.match((await handleOwnerCommand("/use small-3 memory", ctx)).reply, /memory work now uses small-3/);
		assert.equal(getSelectedModel(rig.db, "memory"), "small-3");
		const s = await rig.manager.status();
		assert.equal(s.models.find((m) => m.name === "small-3")!.status, "unloaded");
		assert.deepEqual(s.models.find((m) => m.name === "small-3")!.selectedFor, ["memory"]);
		assert.match((await handleOwnerCommand("/use nope memory", ctx)).reply, /unknown model nope/);
		assert.doesNotMatch((await handleOwnerCommand("/use missing memory", ctx)).reply, /now uses/);
		assert.equal(getSelectedModel(rig.db, "memory"), "small-3");
	});
});

test("migration 008 keeps the selections of a pre-008 database and then accepts 'memory'", () => {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
	const dir = new URL("../src/state/migrations/", import.meta.url);
	for (const f of readdirSync(dir)
		.filter((n) => n.endsWith(".sql") && n < "008")
		.sort()) {
		db.exec(readFileSync(new URL(f, dir), "utf8"));
		db.prepare("INSERT INTO schema_migrations VALUES (?, 'then')").run(f);
	}
	assert.throws(() => setSelectedModel(db, "memory", "b", "owner", "t"), /CHECK/);
	setSelectedModel(db, "web", "a", "owner", "2026-10-01T00:00:00Z");
	setSelectedModel(db, "telegram", "c", "owner", "2026-10-01T00:00:00Z");
	assert.ok(migrate(db).includes("008_memory_selection.sql"));
	assert.equal(getSelectedModel(db, "web"), "a");
	assert.equal(getSelectedModel(db, "telegram"), "c");
	setSelectedModel(db, "memory", "b", "owner", "2026-10-02T00:00:00Z");
	assert.equal(getSelectedModel(db, "memory"), "b");
	assert.throws(() => setSelectedModel(db, "sms" as "web", "x", "o", "t"), /CHECK/);
	db.close();
});
