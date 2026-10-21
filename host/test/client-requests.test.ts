// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The host's first crash (2026-10-21): `socket hang up` on an outgoing request nobody listened to. A
 * request without its own `'error'` listener is now a warning naming where it was created, not a crash.
 */

import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { test } from "node:test";
import type { Logger } from "../src/log.ts";
import { callerFrames, guardClientRequests } from "../src/process/client-requests.ts";

function rig() {
	const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
	const log: Logger = { info() {}, error() {}, warn: (msg, fields) => warnings.push({ msg, fields }) };
	return { warnings, uninstall: guardClientRequests(log) };
}

/** A server that accepts a connection and closes it without answering: Node's "socket hang up". */
async function hangUp(): Promise<{ port: number; close(): void }> {
	const s = createServer((socket) => socket.end());
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	return { port: (s.address() as AddressInfo).port, close: () => s.close() };
}

test("a request with no error listener is a warning naming its creator, not a crash", async () => {
	const r = rig();
	const srv = await hangUp();
	try {
		const req = request({ host: "127.0.0.1", port: srv.port, path: "/health?x=1" });
		req.end();
		await new Promise((resolve) => req.on("close", resolve));
		assert.equal(r.warnings.length, 1);
		assert.equal(r.warnings[0]!.fields!.error, "socket hang up");
		assert.equal(r.warnings[0]!.fields!.code, "ECONNRESET");
		assert.equal(r.warnings[0]!.fields!.path, "/health");
		assert.match(String(r.warnings[0]!.fields!.created), /client-requests\.test\.ts/);
		// Once per call site.
		const again = () => {
			const q = request({ host: "127.0.0.1", port: srv.port });
			q.end();
			return new Promise((resolve) => q.on("close", resolve));
		};
		await again();
		await again();
		assert.equal(r.warnings.length, 2);
	} finally {
		r.uninstall();
		srv.close();
	}
});

test("a request that listens itself gets its error as before, and no warning", async () => {
	const r = rig();
	const srv = await hangUp();
	try {
		const err = await new Promise<Error>((resolve) => {
			const req = request({ host: "127.0.0.1", port: srv.port });
			req.on("error", resolve);
			req.end();
		});
		assert.equal(err.message, "socket hang up");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(r.warnings.length, 0);
	} finally {
		r.uninstall();
		srv.close();
	}
});

test("callerFrames drops Node's own frames", () => {
	const stack = [
		"Error",
		"    at Channel.publish (node:diagnostics_channel:1:1)",
		"    at new ClientRequest (node:_http_client:2:2)",
		"    at Object.request (node:https:3:3)",
		"    at RemoteModels.get (/x/src/models/remote.ts:271:16)",
	].join("\n");
	assert.equal(callerFrames(stack), "at RemoteModels.get (/x/src/models/remote.ts:271:16)");
});
