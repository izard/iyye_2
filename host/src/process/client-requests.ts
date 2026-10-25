// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * A backstop for outgoing requests nobody listens to. An `http(s).request` that
 * fails with no `'error'` listener throws, which would take the host down
 * (it holds the outbox, leases and SQLite state). Node prints that case as
 * `Unhandled 'error' event` … `Emitted 'error' event on ClientRequest`.
 *
 * Written for the crashes of 2026-10-21 (`socket hang up` at
 * `TLSSocket.socketOnEnd`), which turned out to be the other kind: an
 * unhandled rejection from the thinking model's health check
 * (`models/remote.ts`, fixed there). This listener does not cover that.
 *
 * Every client request gets one more `'error'` listener as it is created
 * (`http.client.request.created`, fired in the `ClientRequest` constructor).
 * A request whose own code also listens is unchanged: the error reaches that
 * code. A request with no other listener gets a warning naming where it was
 * created (once per creating line), not a crash. Whatever awaited that request
 * may then never settle, which is a bug to fix at the named site.
 */

import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ClientRequest } from "node:http";
import type { Logger } from "../log.ts";

const CHANNEL = "http.client.request.created";
/** Node's own frames come first; the default 10 can end before the caller. */
const STACK_FRAMES = 40;

/** Install the listener on every client request this process creates. Returns the uninstall. */
export function guardClientRequests(log: Logger): () => void {
	const warned = new Set<string>();
	const onCreated = (message: unknown) => {
		const req = (message as { request?: ClientRequest }).request;
		if (!req) return;
		const limit = Error.stackTraceLimit;
		Error.stackTraceLimit = STACK_FRAMES;
		const created = new Error().stack ?? "";
		Error.stackTraceLimit = limit;
		const site = callerFrames(created);
		const onError = (err: Error & { code?: string }) => {
			if (req.listenerCount("error") > 1) return; // its own code handles it
			const creator = site.split(" < ")[0]!;
			if (warned.has(creator)) return;
			warned.add(creator);
			log.warn("http: a request failed with nobody listening (it would have crashed the host)", {
				error: err.message,
				code: err.code,
				host: req.host,
				path: req.path?.split("?")[0],
				created: site,
			});
		};
		req.on("error", onError);
	};
	subscribe(CHANNEL, onCreated);
	return () => unsubscribe(CHANNEL, onCreated);
}

/** The creating stack without Node's internals and this file: where the request came from. */
export function callerFrames(stack: string): string {
	return stack
		.split("\n")
		.slice(1)
		.map((l) => l.trim())
		.filter((l) => !l.includes("node:") && !l.includes("client-requests.ts"))
		.slice(0, 8)
		.join(" < ");
}
