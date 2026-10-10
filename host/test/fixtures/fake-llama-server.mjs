#!/usr/bin/env node
// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0
//
// A stand-in for `llama-server` in router mode, mimicking what builds 9542 and 11362
// were observed to do (host/PINS.md). It keeps 9542's extra "default" id, which
// the host must ignore. Model names select behaviour:
//   broken-*  load fails (status unloaded, failed: true, exit_code 1)
//   slow-*    stays "loading" forever
//   mute-*    loads, but chat requests return HTTP 500
// Chat replies are scripted by markers in the last user message:
//   [[empty]] empty reply · [[empty-always]] empty for every request of that conversation turn and after · [[fail]] HTTP 500 · [[slow]] 1.5 s delay ·
//   [[slow-always]] 1.5 s delay for every request once any user message in the conversation carries it · [[length]] cut off at the token limit ·
//   [[history]] lists every user message in the request ·
//   [[tool:NAME]] calls tool NAME once, then replies "tool result: <results>" ·
//   [[call:NAME|{json}]] the same, with those arguments ·
//   [[callloop:NAME|{json}]] calls it with those arguments on every request, forever (a tool-call loop) ·
//   [[toolloop:NAME]] keeps calling NAME until a result mentions a limit ·
//   otherwise "echo: <text>".
// Every chat request body is appended to fake-router-requests.jsonl next to the preset.
// FAKE_LOAD_MS sets the load time (default 100); the host passes the router a
// minimal environment, so tests set it only when spawning the fake directly.
// The fake records its argv and environment in fake-router-args.json next to
// the preset file.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

const argv = process.argv.slice(2);
const arg = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const stateDir = dirname(arg("--models-preset"));
writeFileSync(join(stateDir, "fake-router-args.json"), JSON.stringify({ argv, env: process.env }));

const loadMs = Number(process.env.FAKE_LOAD_MS ?? 100);
const models = new Map([["default", { value: "unloaded" }]]);
for (const m of readFileSync(arg("--models-preset"), "utf8").matchAll(/^\[([^\]]+)\]$/gm)) {
	if (m[1] !== "*") models.set(m[1], { value: "unloaded" });
}

const send = (res, code, body) => {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};
const err = (res, code, message) => send(res, code, { error: { code, message, type: "invalid_request_error" } });

const readJson = (req) =>
	new Promise((resolve) => {
		let data = "";
		req.on("data", (c) => {
			data += c;
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(data || "{}"));
			} catch {
				resolve({});
			}
		});
	});

const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" });
	if (req.method === "GET" && url.pathname === "/models") {
		return send(res, 200, {
			data: [...models].map(([id, s]) => ({
				id,
				path: null,
				status: { value: s.value, ...(s.failed ? { failed: true, exit_code: 1 } : {}) },
			})),
		});
	}
	if (req.method === "POST" && url.pathname === "/models/load") {
		const { model } = await readJson(req);
		const s = models.get(model);
		if (!s) return send(res, 404, { error: { message: "File Not Found", type: "not_found_error", code: 404 } });
		if (s.value !== "unloaded") return err(res, 400, "model is already running");
		models.set(model, { value: "loading" });
		if (!model.startsWith("slow-")) {
			setTimeout(() => {
				models.set(model, model.startsWith("broken-") ? { value: "unloaded", failed: true } : { value: "loaded" });
			}, loadMs);
		}
		return send(res, 200, { success: true });
	}
	if (req.method === "POST" && url.pathname === "/models/unload") {
		const { model } = await readJson(req);
		const s = models.get(model);
		if (!s) return send(res, 404, { error: { message: "File Not Found", type: "not_found_error", code: 404 } });
		if (s.value === "unloaded") return err(res, 400, "model is not running");
		setTimeout(() => models.set(model, { value: "unloaded" }), 20);
		return send(res, 200, { success: true });
	}
	if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
		const body = await readJson(req);
		const { model } = body;
		const s = models.get(model);
		if (!s) return err(res, 400, `model '${model}' not found`);
		if (s.value !== "loaded") return err(res, 400, "model is not loaded");
		if (model.startsWith("mute-")) return err(res, 500, "internal error");
		appendFileSync(join(stateDir, "fake-router-requests.jsonl"), `${JSON.stringify(body)}\n`);
		const text = (m) =>
			typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("");
		const messages = body.messages ?? [];
		const users = messages.filter((m) => m.role === "user").map(text);
		const last = users.at(-1) ?? "";
		const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
		const toolResults = messages.slice(lastUserIndex + 1).filter((m) => m.role === "tool").map(text);
		const callMarker = /\[\[(call|callloop):([a-z_]+)\|(\{.*?\})\]\]/s.exec(last);
		const toolMarker = callMarker
			? [callMarker[0], callMarker[1] === "call" ? "tool" : "forever", callMarker[2]]
			: /\[\[(tool|toolloop):([a-z_]+)\]\]/.exec(last);
		const toolArgs = callMarker ? callMarker[3] : "{}";
		let toolCall = null;
		if (toolMarker) {
			const done =
				toolMarker[1] === "forever"
					? false
					: toolMarker[1] === "tool"
						? toolResults.length > 0
						: toolResults.some((r) => /limit/.test(r));
			if (!done) toolCall = toolMarker[2];
		}
		if (last.includes("[[fail]]")) return err(res, 500, "scripted failure");
		if (last.includes("[[slow]]") || users.some((u) => u.includes("[[slow-always]]")))
			await new Promise((r) => setTimeout(r, 1500));
		const reply = toolMarker
			? `tool result: ${toolResults.join(" || ")}`
			: last.includes("[[empty]]") || users.some((u) => u.includes("[[empty-always]]"))
				? ""
				: last.includes("[[history]]")
					? `history: ${users.join(" | ")}`
					: `echo: ${last}`;
		if (!body.stream) {
			return send(res, 200, {
				model,
				choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
			});
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta, finish) =>
			res.write(
				`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
			);
		chunk({ role: "assistant", content: "" }, null);
		if (toolCall) {
			const id = `call_${toolResults.length + 1}`;
			chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: toolCall, arguments: toolArgs } }] }, null);
			chunk({}, "tool_calls");
			res.end("data: [DONE]\n\n");
			return;
		}
		for (const piece of reply.match(/.{1,8}/gs) ?? []) chunk({ content: piece }, null);
		chunk({}, last.includes("[[length]]") ? "length" : "stop");
		res.write(
			`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
		);
		res.end("data: [DONE]\n\n");
		return;
	}
	return err(res, 404, "not found");
});

server.listen(Number(arg("--port")), arg("--host") ?? "127.0.0.1");
const stop = () => {
	server.closeAllConnections();
	server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
