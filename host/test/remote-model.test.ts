// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.012: a model served by another of the owner's machines, for background work. Against a fake
 * HTTPS llama-server with a test-only certificate (never the real MBP).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { createLocalModelRuntime, IYYE_PROVIDER } from "../src/integration/pi/runtime.ts";
import { BackgroundWorker } from "../src/kernel/background.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import { renderPreset, serverCliArgs } from "../src/models/preset.ts";
import { parseRegistry, type Registry } from "../src/models/registry.ts";
import { addRemoteModel, parseRemoteModel, RemoteModels } from "../src/models/remote.ts";
import { parseThinkingModel } from "../src/models/remote-config.ts";
import { getBackgroundJob, insertBackgroundJob } from "../src/state/background.ts";
import { openDb } from "../src/state/db.ts";
import { freePort, managerRig, type Sandbox, sandbox } from "./model-helpers.ts";

const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const CERT = fixture("remote-cert.pem");
const KEY = "k".repeat(64);

interface FakeEndpoint {
	url: string;
	requests: { auth: string | undefined; body: Record<string, unknown> }[];
	/** What /props reports. */
	props: { file: string; ctx: number };
	/** What /v1/models lists (an OpenAI-compatible server's models). */
	models: Record<string, unknown>[];
	/** How /v1/models answers: normally, by hanging up, or with a page that is not JSON. */
	modelsReply: "ok" | "hang-up" | "html";
	/** Drop the next completion's connection after its first chunk. */
	dropNext: boolean;
	server: Server;
	close(): Promise<void>;
}

async function fakeEndpoint(cert = "remote"): Promise<FakeEndpoint> {
	const port = await freePort();
	const ep: FakeEndpoint = {
		url: `https://127.0.0.1:${port}`,
		requests: [],
		props: { file: "tak.gguf", ctx: 8192 },
		models: [{ id: "/Users/owner/Downloads/flash-q4", reasoning_parser: "qwen3" }],
		modelsReply: "ok",
		dropNext: false,
		server: null as unknown as Server,
		close: () => new Promise((r) => ep.server.close(() => r())),
	};
	ep.server = createServer({ key: fixture(`${cert}-key.pem`), cert: fixture(`${cert}-cert.pem`) }, (req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			if (req.headers.authorization !== `Bearer ${KEY}`) {
				res.writeHead(401).end();
				return;
			}
			if (req.url === "/health") return void res.writeHead(200).end('{"status":"ok"}');
			if (req.url === "/v1/models" && ep.modelsReply === "hang-up") return void res.socket?.destroy();
			if (req.url === "/v1/models" && ep.modelsReply === "html")
				return void res.writeHead(200).end("<html>busy</html>");
			if (req.url === "/v1/models") return void res.writeHead(200).end(JSON.stringify({ data: ep.models }));
			if (req.url === "/props")
				return void res.writeHead(200).end(
					JSON.stringify({
						model_path: `/Users/owner/models/${ep.props.file}`,
						default_generation_settings: { n_ctx: ep.props.ctx },
					}),
				);
			const parsed = JSON.parse(body) as Record<string, unknown>;
			ep.requests.push({ auth: req.headers.authorization, body: parsed });
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
			if (ep.dropNext) {
				ep.dropNext = false;
				setTimeout(() => res.socket?.destroy(), 20);
				return;
			}
			res.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n');
		});
	});
	await new Promise<void>((r) => ep.server.listen(port, "127.0.0.1", () => r()));
	ep.server.keepAliveTimeout = 100;
	return ep;
}

function registry(dir: string): Registry {
	writeFileSync(join(dir, "tak.gguf"), "");
	return parseRegistry(
		{
			models_dir: dir,
			defaults: { c: 8192, np: 1, timeout: 86400, "repeat-penalty": 1.2 },
			models: [
				{
					name: "tak",
					file: "tak.gguf",
					ram_required_gb: 14,
					startup_s: 5,
					roles: ["reasoning"],
					description: "test",
					thinking: "on",
					server_args: { jinja: true },
				},
			],
		},
		"/",
	);
}

/** POST through the pass-through (plain HTTP on 127.0.0.1, as Pi and the host's completions do). */
function post(port: number, body: unknown): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port,
				method: "POST",
				path: "/v1/chat/completions",
				headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (c) => {
					text += c;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
				res.on("error", () => resolve({ status: res.statusCode ?? 0, text }));
				res.on("aborted", () => resolve({ status: res.statusCode ?? 0, text }));
			},
		);
		req.on("error", (err) =>
			err.message.includes("socket hang up") ? resolve({ status: 0, text: "" }) : reject(err),
		);
		req.end(data);
	});
}

test("IYYE2_REMOTE_MODEL names a registry model, a machine and an https URL", () => {
	assert.deepEqual(parseRemoteModel("qwen38-27b-tak@mbp=https://192.168.1.177:8190"), {
		kind: "llama",
		model: "qwen38-27b-tak",
		endpoint: "mbp",
		url: "https://192.168.1.177:8190",
	});
	assert.equal(parseRemoteModel(""), null);
	assert.throws(() => parseRemoteModel("tak@mbp=http://192.168.1.177:8190"), /must look like/); // never plain HTTP
	assert.throws(() => parseRemoteModel("tak=https://192.168.1.177:8190"), /must look like/);
});

test("the remote model is the registry model's twin, out of the preset; the server gets the same arguments", () => {
	const dir = mkdtempSync(join(tmpdir(), "iyye-remote-"));
	try {
		const reg = registry(dir);
		const before = renderPreset(reg);
		const spec = addRemoteModel(reg, parseRemoteModel("tak@mbp=https://127.0.0.1:1")!, "http://127.0.0.1:8183");
		assert.equal(spec.name, "tak@mbp");
		assert.equal(spec.thinking, "on");
		assert.deepEqual(spec.remote, { endpoint: "mbp", proxyUrl: "http://127.0.0.1:8183" });
		assert.equal(renderPreset(reg), before, "never in the router's preset");
		assert.deepEqual(serverCliArgs(reg, reg.models[0]!), [
			"-c",
			"8192",
			"-np",
			"1",
			"--timeout",
			"86400",
			"--repeat-penalty",
			"1.2",
			"--jinja",
		]);
		assert.throws(
			() => addRemoteModel(reg, parseRemoteModel("nope@mbp=https://127.0.0.1:1")!, "http://x"),
			/not in the model registry/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Pi reaches the remote model only through the pass-through, under the one local provider", async () => {
	const dir = mkdtempSync(join(tmpdir(), "iyye-remote-"));
	try {
		const reg = registry(dir);
		addRemoteModel(reg, parseRemoteModel("tak@mbp=https://127.0.0.1:1")!, "http://127.0.0.1:8183");
		const runtime = await createLocalModelRuntime({ routerUrl: "http://127.0.0.1:8180", registry: reg });
		const remote = runtime.getModel(IYYE_PROVIDER, "tak@mbp") as { baseUrl?: string; provider?: string } | undefined;
		assert.equal(remote?.provider, IYYE_PROVIDER);
		assert.equal(remote?.baseUrl, "http://127.0.0.1:8183/v1");
		const local = runtime.getModel(IYYE_PROVIDER, "tak") as { baseUrl?: string } | undefined;
		assert.equal(local?.baseUrl, "http://127.0.0.1:8180/v1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("the pass-through to another machine", () => {
	let dir: string;
	let reg: Registry;
	let ep: FakeEndpoint;
	let remote: RemoteModels;
	let port: number;

	async function start(endpoint: FakeEndpoint, cert = CERT) {
		ep = endpoint;
		dir = mkdtempSync(join(tmpdir(), "iyye-remote-"));
		reg = registry(dir);
		const c = parseRemoteModel(`tak@mbp=${ep.url}`)!;
		port = await freePort();
		addRemoteModel(reg, c, `http://127.0.0.1:${port}`);
		remote = new RemoteModels({
			config: c,
			registry: reg,
			port,
			cert: () => cert,
			key: () => KEY,
			log: silentLogger,
			healthIntervalMs: 60_000,
			healthTimeoutMs: 2000,
		});
		await remote.start();
	}

	afterEach(async () => {
		await remote?.stop();
		await ep?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("forwards a leased call with the key added and the endpoint's own model name, streaming", async () => {
		await start(await fakeEndpoint());
		assert.equal(remote.status.state, "up");
		const lease = remote.acquire("tak@mbp");
		assert.ok("release" in lease);
		const r = await post(port, { model: "tak@mbp", stream: true, messages: [{ role: "user", content: "hi" }] });
		assert.equal(r.status, 200);
		assert.match(r.text, /"hel"[\s\S]*"lo"[\s\S]*\[DONE\]/);
		assert.equal(ep.requests.length, 1);
		assert.equal(ep.requests[0]!.auth, `Bearer ${KEY}`);
		assert.equal(ep.requests[0]!.body.model, "tak");
		lease.release();
	});

	test("refuses without a lease, another model, and any other path", async () => {
		await start(await fakeEndpoint());
		assert.equal((await post(port, { model: "tak@mbp", messages: [] })).status, 503, "no lease: nothing goes out");
		const lease = remote.acquire("tak@mbp");
		assert.ok("release" in lease);
		assert.equal((await post(port, { model: "tak", messages: [] })).status, 400);
		assert.equal(ep.requests.length, 0);
		lease.release();
	});

	test("another certificate at the address is refused: the pin holds", async () => {
		await start(await fakeEndpoint("other"));
		assert.equal(remote.status.state, "unreachable");
		assert.match(remote.status.detail, /certificate/i);
		const lease = remote.acquire("tak@mbp");
		assert.ok(!("release" in lease) && lease.busy, "not now: callers wait");
	});

	test("an endpoint serving another file or context is misconfigured, not up", async () => {
		const e = await fakeEndpoint();
		e.props.file = "other.gguf";
		await start(e);
		assert.equal(remote.status.state, "misconfigured");
		assert.match(remote.status.detail, /serves other\.gguf, not tak\.gguf/);
		e.props = { file: "tak.gguf", ctx: 4096 };
		await remote.check();
		assert.match(remote.status.detail, /context per slot is 4096, the registry says 8192/);
		e.props.ctx = 8192;
		await remote.check();
		assert.equal(remote.status.state, "up");
	});

	test("a dropped connection makes the endpoint unreachable and earlier leases invalid (work waits, not fails)", async () => {
		await start(await fakeEndpoint());
		const lease = remote.acquire("tak@mbp");
		assert.ok("release" in lease);
		ep.dropNext = true;
		await post(port, { model: "tak@mbp", stream: true, messages: [] });
		assert.equal(remote.status.state, "unreachable");
		assert.equal(lease.valid(), false);
		const again = remote.acquire("tak@mbp");
		assert.ok(!("release" in again) && again.busy);
		await remote.check(); // the machine is back
		assert.equal(remote.status.state, "up");
		lease.release();
	});
});

describe("the model manager and another machine's model", () => {
	let sb: Sandbox;
	before(() => {
		sb = sandbox();
	});
	after(() => sb.cleanup());

	test("background only; never loaded, unloaded or healed; its leases come from its machine", async () => {
		const reg = sb.registry;
		const base = reg.models.find((m) => m.available)!;
		addRemoteModel(reg, parseRemoteModel(`${base.name}@mbp=https://127.0.0.1:1`)!, "http://127.0.0.1:1");
		const name = `${base.name}@mbp`;
		let state: "up" | "unreachable" = "unreachable";
		let leases = 0;
		const rig = await managerRig(sb, {
			remote: {
				endpoint: "mbp",
				has: (n: string) => n === name,
				get status() {
					return { state, detail: "test" };
				},
				acquire: (n: string) => {
					if (state !== "up") return { ok: false, busy: true, message: "mbp is unreachable" };
					leases++;
					return { model: n, valid: () => true, release: () => {} };
				},
			} as never,
		});
		await rig.manager.start();
		try {
			assert.match((await rig.manager.select("web", name, "owner")).message, /background work only/);
			assert.match((await rig.manager.select("memory", name, "owner")).message, /background work only/);
			const sel = await rig.manager.select("background", name, "owner");
			assert.equal(sel.ok, true);
			assert.match(sel.message, /mbp is unreachable: it waits until it is up/);
			assert.equal(rig.manager.isRemote(name), true);
			const refused = await rig.manager.acquire(name);
			assert.ok(!("release" in refused) && refused.busy);
			state = "up";
			assert.ok("release" in (await rig.manager.acquire(name)));
			assert.equal(leases, 1);
			assert.match((await rig.manager.load(name, "owner")).message, /never loads it/);
			assert.match((await rig.manager.unload(name, "owner")).message, /never unloads it/);
			assert.deepEqual(rig.manager.healingReport(), [], "no self-healing for the other machine");
			const view = (await rig.manager.status()).models.find((m) => m.name === name)!;
			assert.equal(view.status, "on mbp: up");
			assert.deepEqual(view.selectedFor, ["background"]);
		} finally {
			await rig.manager.stop();
		}
	});
});

function job(db: ReturnType<typeof openDb>): string {
	const id = crypto.randomUUID();
	insertBackgroundJob(db, { id, origin: "test", session: `bg-${id}`, prompt: "look", at: new Date().toISOString() });
	return id;
}

describe("background work on another machine's model", () => {
	function worker(opts: { remote: boolean; lose?: boolean }) {
		const db = openDb(":memory:");
		const local = new DeviceSlot();
		const far = new DeviceSlot();
		let valid = true;
		const w = new BackgroundWorker({
			db,
			device: local,
			deviceFor: (m) => (m === "tak@mbp" ? far : local),
			models: {
				selected: () => (opts.remote ? "tak@mbp" : "tak"),
				acquire: async (n) => ({ model: n, valid: () => valid, release: () => {} }),
				isRemote: (n) => n === "tak@mbp",
			},
			conversations: {
				turn: async () => {
					if (opts.lose) {
						valid = false;
						return { ok: false, reason: "error", message: "fetch failed" } as never;
					}
					return { ok: true, text: "done" } as never;
				},
				sessionFile: () => null,
			},
			chatPending: () => true, // a person is waiting on the Spark
			log: silentLogger,
			gapMs: 0,
		});
		return { db, w, local, far };
	}

	test("a conversation here does not hold it back, and it takes the other machine's device, not this one's", async () => {
		const { db, w, local } = worker({ remote: true });
		const holdLocal = local.tryAcquire("chat:1")!; // a chat on the Spark holds its device
		const id = job(db);
		assert.equal(await w.drainOnce(), true);
		assert.equal(getBackgroundJob(db, id)!.status, "settled");
		holdLocal();
		const local2 = worker({ remote: false });
		local2.local.tryAcquire("chat:1");
		job(local2.db);
		assert.equal(await local2.w.drainOnce(), false, "the same work on this machine's model waits for the person");
	});

	test("a lost connection pauses the step without counting it, instead of failing it", async () => {
		const { db, w } = worker({ remote: true, lose: true });
		const id = job(db);
		assert.equal(await w.drainOnce(), true);
		const step = getBackgroundJob(db, id)!;
		assert.equal(step.status, "paused");
		assert.equal(step.pauses, 0);
	});
});

describe("the thinking model: any OpenAI-compatible server, for the thinking tool only (2026-10-14)", () => {
	let ep: FakeEndpoint;
	let remote: RemoteModels;
	let port: number;

	async function start(endpoint: FakeEndpoint, model = "flash-q4") {
		ep = endpoint;
		const c = parseThinkingModel(`${model}@mbp=${ep.url}`)!;
		port = await freePort();
		remote = new RemoteModels({
			config: c,
			registry: { models_dir: "/", defaults: {}, models: [] } as unknown as Registry,
			port,
			cert: () => CERT,
			key: () => KEY,
			log: silentLogger,
			healthIntervalMs: 60_000,
			healthTimeoutMs: 2000,
		});
		await remote.start();
	}

	afterEach(async () => {
		await remote?.stop();
		await ep?.close();
	});

	test("IYYE2_THINKING_MODEL has the same shape, never plain HTTP", () => {
		assert.deepEqual(parseThinkingModel("qwen3.8-flash-next-q4@mbp=https://192.168.1.177:8191"), {
			kind: "openai",
			model: "qwen3.8-flash-next-q4",
			endpoint: "mbp",
			url: "https://192.168.1.177:8191",
		});
		assert.equal(parseThinkingModel(undefined), null);
		assert.throws(() => parseThinkingModel("x@mbp=http://192.168.1.177:8000"), /IYYE2_THINKING_MODEL must look like/);
	});

	test("up when /v1/models lists it (a path id by its last part); the call goes out under the server's own id", async () => {
		await start(await fakeEndpoint());
		assert.equal(remote.status.state, "up", remote.status.detail);
		assert.equal(remote.name, "flash-q4@mbp");
		const lease = remote.acquire("flash-q4@mbp");
		assert.ok("release" in lease);
		const r = await post(port, { model: "flash-q4@mbp", stream: true, messages: [{ role: "user", content: "hi" }] });
		assert.equal(r.status, 200);
		assert.equal(ep.requests[0]!.body.model, "/Users/owner/Downloads/flash-q4");
		assert.equal(ep.requests[0]!.auth, `Bearer ${KEY}`);
		lease.release();
	});

	test("a hang-up or a bad page on /v1/models makes it unreachable, never an escaped rejection (crashes of 2026-10-21)", async () => {
		const escaped: unknown[] = [];
		const onRejection = (r: unknown) => escaped.push(r);
		process.on("unhandledRejection", onRejection);
		try {
			const flaky = await fakeEndpoint();
			flaky.modelsReply = "hang-up";
			await start(flaky); // start() checks once; this rejected before
			assert.equal(remote.status.state, "unreachable");
			assert.match(remote.status.detail, /socket hang up|ECONNRESET/);
			flaky.modelsReply = "html";
			await remote.check();
			assert.equal(remote.status.state, "unreachable");
			flaky.modelsReply = "ok";
			await remote.check();
			assert.equal(remote.status.state, "up", remote.status.detail);
			await new Promise((r) => setImmediate(r));
			assert.deepEqual(escaped, []);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});

	test("refused: another model, or a server that leaves reasoning in the answer", async () => {
		await start(await fakeEndpoint(), "other");
		assert.equal(remote.status.state, "misconfigured");
		assert.match(remote.status.detail, /serves flash-q4, not other/);
		assert.ok(!("release" in remote.acquire("other@mbp")));
		await remote.stop();
		await ep.close();

		const mixed = await fakeEndpoint();
		mixed.models = [{ id: "flash-q4", reasoning_parser: null }];
		await start(mixed);
		assert.equal(remote.status.state, "misconfigured");
		assert.match(remote.status.detail, /does not separate the model's reasoning/);
		await remote.stop();
		await ep.close();

		// A server that does not report a reasoning parser at all is taken at its word.
		const plain = await fakeEndpoint();
		plain.models = [{ id: "flash-q4" }];
		await start(plain);
		assert.equal(remote.status.state, "up");
	});
});
