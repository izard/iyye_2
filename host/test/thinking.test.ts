// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import type { ModelLease, OpResult } from "../src/models/manager.ts";
import { brokenStream } from "../src/models/stream.ts";
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

function rig(over: Partial<ThinkingDeps> = {}, principal: "owner" | "contact" | "iyye" = "owner", trusted = false) {
	const db = openDb(":memory:");
	const device = new DeviceSlot();
	const l = lease();
	const asked: string[] = [];
	const efforts: string[] = [];
	const complete: ThinkComplete = async (_m, q, _s, effort) => {
		asked.push(q);
		efforts.push(effort);
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
	const tools = new ToolBroker({ db, toolkits: [kit], log: silentLogger }).forSession({
		scope: "owner",
		principal,
		trusted,
	});
	const ask = (question: string, signal?: AbortSignal, effort?: string) =>
		(tools.definitions[0]!.execute as unknown as Exec)(
			"c",
			effort ? { question, effort } : { question },
			signal,
			undefined,
			undefined as never,
		);
	return { db, device, lease: l, asked, efforts, tools, ask };
}

describe("ask_thinking_model", () => {
	test("the owner and trusted contacts (owner decision 2026-10-19); untrusted contacts and background work never", () => {
		assert.deepEqual(rig().tools.names, ["ask_thinking_model"]);
		assert.deepEqual(rig({}, "contact", true).tools.names, ["ask_thinking_model"]);
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

	test("the session picks the effort per question (owner decision 2026-10-20); left out, it is medium", async () => {
		const r = rig({ dailyMax: 5 });
		await r.ask("2+2?", undefined, "low");
		await r.ask("Prove it.", undefined, "xhigh");
		await r.ask("Which is larger?");
		assert.deepEqual(r.efforts, ["low", "xhigh", "medium"]);
		const props = (
			r.tools.definitions[0]!.parameters as { properties: Record<string, { anyOf?: { const: string }[] }> }
		).properties;
		assert.deepEqual(
			props.effort!.anyOf!.map((x) => x.const),
			["low", "medium", "xhigh"],
		);
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

	test("a server failing partway (2026-10-18): what came is passed on as cut off, never as an answer", async () => {
		const failed = "the server failed: inference was interrupted (engine_transient)";
		const r = rig({ complete: async () => ({ text: "The bound is M ≈ 2 × 1", truncated: false, error: failed }) });
		const out = (await r.ask("q")).content[0]!.text;
		assert.match(
			out,
			/^The thinking model on mbp failed partway through its answer \(after \d+ s: the server failed: inference was interrupted \(engine_transient\)\)\..*conclusion is missing.*:\nThe bound is M ≈ 2 × 1$/s,
		);
		assert.ok(!out.includes("The thinking model answered"));
		const before = rig({ complete: async () => ({ text: "", truncated: false, error: failed }) });
		assert.match(
			(await before.ask("q")).content[0]!.text,
			/^The thinking model on mbp failed \(after \d+ s\) before it answered: the server failed: .*Answer yourself, and say so\.$/,
		);
		// A failed question does not use up the day's limit.
		assert.equal(
			(
				r.db.prepare("SELECT count(*) AS n FROM tool_calls WHERE result LIKE '%answered after%'").get() as {
					n: number;
				}
			).n,
			0,
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
		// The pass-through lost the machine mid-answer: the part that came is passed on, with that reason.
		let ok = true;
		const l2 = lease(() => ok);
		const midway = rig({
			models: { acquire: async () => l2 },
			complete: async () => {
				ok = false;
				return { text: "The first half", truncated: false, error: "the connection broke (terminated)" };
			},
		});
		assert.match(
			(await midway.ask("q")).content[0]!.text,
			/failed partway through its answer \(after \d+ s: the connection to mbp was lost\).*:\nThe first half$/s,
		);
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
		const r = await thinkComplete(() => url, 16384)("m@mbp", "riddle", new AbortController().signal, "low");
		assert.deepEqual(r, { text: "Five children.", truncated: true });
		assert.equal(body.stream, true);
		assert.equal(body.max_tokens, 16384);
		assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true, reasoning_effort: "low" });
	} finally {
		server.close();
	}
});

test("streamChat: a server's error frame, or a stream that ends without a finish, is never a whole answer", async () => {
	const scripts: Record<string, string[]> = {
		// rapid-mlx after a Metal failure mid-answer: an error frame, then [DONE].
		error: [
			JSON.stringify({ choices: [{ delta: { content: "Half an " }, finish_reason: null }] }),
			JSON.stringify({
				error: { message: "inference was interrupted", type: "server_error", code: "engine_transient" },
			}),
			"[DONE]",
		],
		// The connection simply closes.
		closed: [JSON.stringify({ choices: [{ delta: { content: "Half an " }, finish_reason: null }] })],
		// [DONE] with no finish_reason.
		unfinished: [JSON.stringify({ choices: [{ delta: { content: "Half an " }, finish_reason: null }] }), "[DONE]"],
		ok: [JSON.stringify({ choices: [{ delta: { content: "Whole." }, finish_reason: "stop" }] }), "[DONE]"],
		// The connection breaks mid-answer (2026-10-19): what came is kept.
		broken: [JSON.stringify({ choices: [{ delta: { content: "Half an " }, finish_reason: null }] })],
	};
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const d of scripts[req.url?.split("/")[1] ?? ""] ?? []) res.write(`data: ${d}\n\n`);
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const run = (script: string) =>
			thinkComplete(() => `${url}/${script}`, 1024)("m@mbp", "q", new AbortController().signal, "medium");
		assert.deepEqual(await run("error"), {
			text: "Half an ",
			truncated: false,
			error: "the server failed: inference was interrupted (engine_transient)",
		});
		assert.deepEqual(await run("closed"), {
			text: "Half an ",
			truncated: false,
			error: "the stream ended before the answer was finished",
		});
		assert.equal((await run("unfinished")).error, "the stream ended before the answer was finished");
		assert.deepEqual(await run("ok"), { text: "Whole.", truncated: false });
	} finally {
		server.close();
	}
});

test("brokenStream: fetch's own 5-minute rule for a silent body is named as a dropped connection", () => {
	const timeout = Object.assign(new TypeError("terminated"), {
		cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }),
	});
	assert.match(brokenStream(timeout), /^nothing arrived from the server for 5 minutes/);
	assert.equal(
		brokenStream(Object.assign(new TypeError("terminated"), { cause: new Error("other side closed") })),
		"the connection broke (other side closed)",
	);
});
