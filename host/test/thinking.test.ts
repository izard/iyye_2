// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import type { ModelLease, OpResult } from "../src/models/manager.ts";
import { openDb } from "../src/state/db.ts";
import { toolCallsForScope } from "../src/state/tool-calls.ts";
import { ToolBroker } from "../src/tools/broker.ts";
import { type ThinkComplete, type ThinkingDeps, thinkComplete, thinkingToolkit } from "../src/tools/thinking.ts";

type Result = { content: { text: string }[]; isError?: boolean };
type Exec = (id: string, p: unknown, s: AbortSignal | undefined, u: undefined, c: never) => Promise<Result>;

function lease(valid = () => true): ModelLease & { released: boolean } {
	const l = {
		model: "qwen38-27b-tak@mbp",
		released: false,
		valid,
		release() {
			l.released = true;
		},
	};
	return l;
}

function rig(over: Partial<ThinkingDeps> = {}, principal: "owner" | "contact" | "iyye" = "owner") {
	const db = openDb(":memory:");
	const device = new DeviceSlot();
	const l = lease();
	const asked: string[] = [];
	const complete: ThinkComplete = async (_m, q) => {
		asked.push(q);
		return { text: "Sally's parents have five children.", truncated: false };
	};
	const kit = thinkingToolkit({
		db,
		model: "qwen38-27b-tak@mbp",
		machine: "mbp",
		models: { acquire: async () => l },
		device,
		complete,
		dailyMax: 2,
		...over,
	});
	const tools = new ToolBroker({ db, toolkits: [kit], log: silentLogger }).forSession({ scope: "owner", principal });
	const ask = (question: string, signal?: AbortSignal) =>
		(tools.definitions[0]!.execute as unknown as Exec)("c", { question }, signal, undefined, undefined as never);
	return { db, device, lease: l, asked, tools, ask };
}

describe("ask_thinking_model", () => {
	test("owner-only: contacts and background work never see it", () => {
		assert.deepEqual(rig().tools.names, ["ask_thinking_model"]);
		assert.deepEqual(rig({}, "contact").tools.names, []);
		assert.deepEqual(rig({}, "iyye").tools.names, []);
	});

	test("the question goes as written; the answer comes back; the lease and the device are released", async () => {
		const r = rig();
		const out = await r.ask("If Sally has three brothers, and each has two sisters, how many children?");
		assert.match(
			out.content[0]!.text,
			/^The thinking model answered after \d+ s:\nSally's parents have five children\.$/,
		);
		assert.deepEqual(r.asked, ["If Sally has three brothers, and each has two sisters, how many children?"]);
		assert.ok(r.lease.released);
		assert.equal(r.device.holder, null);
	});

	test("takes the other machine's device: background work there gives way", async () => {
		const r = rig();
		let preempted = false;
		const release = r.device.tryAcquire("background", {
			onPreempt: () => {
				preempted = true;
				setTimeout(() => release?.(), 10);
			},
		});
		const out = await r.ask("2+2?");
		assert.ok(preempted);
		assert.match(out.content[0]!.text, /answered/);
	});

	test("daily limit counts answered questions only", async () => {
		let fail = true;
		const r = rig({
			complete: async () => {
				if (fail) throw new Error("HTTP 500");
				return { text: "4", truncated: false };
			},
		});
		assert.match((await r.ask("a")).content[0]!.text, /failed: HTTP 500/);
		fail = false;
		await r.ask("b");
		await r.ask("c");
		assert.match((await r.ask("d")).content[0]!.text, /daily limit is used up \(2 questions\)/);
		assert.equal(toolCallsForScope(r.db, "owner").length, 4);
	});

	test("cut off while still reasoning (rapid-mlx's notice): no answer, its scratch work never passed on", async () => {
		const r = rig({
			complete: async () => ({
				text: "[truncated — reasoning incomplete; raise max_tokens]\n\nd maybe include Top 5. Let's ensure",
				truncated: true,
			}),
		});
		const out = (await r.ask("q")).content[0]!.text;
		assert.match(
			out,
			/^The thinking model on mbp ran out of room while still reasoning \(after \d+ s\) and reached no answer/,
		);
		assert.ok(!out.includes("Let's ensure"));
		const partial = rig({ complete: async () => ({ text: "Five", truncated: true }) });
		assert.match(
			(await partial.ask("q")).content[0]!.text,
			/ran out of room; the answer may be incomplete\):\nFive$/,
		);
	});

	test("an unavailable or lost machine is said plainly, never retried", async () => {
		const away = rig({
			models: { acquire: async (): Promise<OpResult> => ({ ok: false, busy: true, message: "mbp is unreachable" }) },
		});
		assert.match((await away.ask("q")).content[0]!.text, /not available now \(mbp is unreachable\)/);
		let valid = true;
		const l = lease(() => valid);
		const lost = rig({
			models: { acquire: async () => l },
			complete: async () => {
				valid = false;
				throw new Error("socket hang up");
			},
		});
		assert.match((await lost.ask("q")).content[0]!.text, /connection to mbp was lost/);
		assert.ok(l.released);
	});

	test("the turn's cancellation stops the call", async () => {
		const ac = new AbortController();
		const r = rig({
			complete: (_m, _q, signal) =>
				new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
		});
		const p = r.ask("q", ac.signal);
		setTimeout(() => ac.abort(), 10);
		assert.equal((await p).content[0]!.text, "Stopped.");
		assert.ok(r.lease.released);
	});
});

test("thinkComplete streams with thinking on, keeps only the answer, and notices a cut-off", async () => {
	let body: Record<string, unknown> = {};
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => {
			body = JSON.parse(raw);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const ev = (delta: object, finish: string | null = null) =>
				res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
			ev({ reasoning_content: "Sally is one of the sisters…" });
			ev({ content: "Five " });
			ev({ content: "children." }, "length");
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const r = await thinkComplete(() => url, 16384)("m@mbp", "riddle", new AbortController().signal);
		assert.deepEqual(r, { text: "Five children.", truncated: true });
		assert.equal(body.stream, true);
		assert.equal(body.max_tokens, 16384);
		assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
	} finally {
		server.close();
	}
});
