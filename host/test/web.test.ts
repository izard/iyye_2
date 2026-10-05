// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { admitTelegramUpdate } from "../src/kernel/admission.ts";
import { getEvent } from "../src/state/events.ts";
import { getJobForEvent } from "../src/state/jobs.ts";
import type { FeedView } from "../src/state/web.ts";
import { type Sandbox, sandbox, waitFor } from "./model-helpers.ts";
import { http, loginAs, msgId, type Stack, startStack, TOKEN } from "./web-helpers.ts";

describe("owner web chat", () => {
	const sb: Sandbox = sandbox();
	let s: Stack;
	let auth: { cookie: string; csrf: string };
	const post = (path: string, body: unknown) => http(s.port, "POST", path, { ...auth, body });
	const feed = async (): Promise<FeedView[]> =>
		(await http(s.port, "GET", "/api/messages?after=0", { cookie: auth.cookie })).body.messages as FeedView[];

	before(async () => {
		s = await startStack(sb);
		auth = await loginAs(s.port);
	});
	after(async () => {
		await s.stop();
		sb.cleanup();
	});

	describe("A8: authentication and request origin", () => {
		test("an unauthenticated POST is 401, and so is reading the transcript", async () => {
			const r = await http(s.port, "POST", "/api/messages", { body: { client_msg_id: msgId(), text: "hi" } });
			assert.equal(r.status, 401);
			assert.equal((await http(s.port, "GET", "/api/messages")).status, 401);
		});

		test("a cross-origin or origin-less POST is 403, even with a valid session", async () => {
			const body = { client_msg_id: msgId(), text: "hi" };
			assert.equal(
				(await http(s.port, "POST", "/api/messages", { ...auth, body, origin: "http://evil.example" })).status,
				403,
			);
			assert.equal((await http(s.port, "POST", "/api/messages", { ...auth, body, origin: null })).status, 403);
			assert.equal(
				(await http(s.port, "POST", "/api/login", { body: { token: TOKEN }, origin: "http://evil.example" }))
					.status,
				403,
			);
		});

		test("a foreign Host header (DNS rebinding) is refused on every request", async () => {
			assert.equal((await http(s.port, "GET", "/", { host: "evil.example" })).status, 403);
			assert.equal(
				(await http(s.port, "GET", "/api/messages", { host: `evil.example:${s.port}`, cookie: auth.cookie }))
					.status,
				403,
			);
			assert.equal((await http(s.port, "GET", "/", { host: `localhost:${s.port}` })).status, 200);
		});

		test("POSTs need the session's CSRF token", async () => {
			const body = { client_msg_id: msgId(), text: "hi" };
			assert.equal((await http(s.port, "POST", "/api/messages", { cookie: auth.cookie, body })).status, 403);
			assert.equal(
				(await http(s.port, "POST", "/api/messages", { cookie: auth.cookie, csrf: "nope", body })).status,
				403,
			);
		});

		test("a wrong token does not log in; the right one sets an HttpOnly SameSite=Strict cookie", async () => {
			assert.equal((await http(s.port, "POST", "/api/login", { body: { token: "b".repeat(64) } })).status, 401);
			assert.equal((await http(s.port, "POST", "/api/login", { body: { token: "short" } })).status, 401);
			const r = await http(s.port, "POST", "/api/login", { body: { token: TOKEN } });
			const cookie = String(r.headers["set-cookie"]);
			assert.match(cookie, /iyye_session=[^;]+; HttpOnly; SameSite=Strict; Path=\//);
		});

		test("pages carry a strict CSP and no CORS headers", async () => {
			const r = await http(s.port, "GET", "/");
			assert.equal(r.status, 200);
			assert.match(String(r.headers["content-security-policy"]), /default-src 'self'; frame-ancestors 'none'/);
			assert.equal(r.headers["access-control-allow-origin"], undefined);
			assert.equal(r.headers["x-content-type-options"], "nosniff");
		});
	});

	describe("messages", () => {
		test("a reply appears with its action ID, delivered at ui_enqueued, then client_ack after the browser's ack", async () => {
			const r = await post("/api/messages", { client_msg_id: msgId(), text: "hello there" });
			assert.equal(r.status, 202);
			const eventId = String(r.body.event_id);
			let reply: FeedView | undefined;
			await waitFor(async () => {
				reply = (await feed()).find((m) => m.kind === "reply" && m.event_id === eventId);
				return reply !== undefined;
			});
			assert.equal(reply!.text, "echo: hello there");
			assert.ok(reply!.action_id);
			assert.equal(reply!.action_state, "delivered");
			assert.equal(reply!.receipt_level, "ui_enqueued");
			assert.equal(getEvent(s.db, eventId)!.status, "answered");
			assert.equal(getJobForEvent(s.db, eventId)!.status, "settled");
			assert.equal(getJobForEvent(s.db, eventId)!.model_name, "small");

			assert.deepEqual((await post("/api/ack", { action_id: reply!.action_id })).body, { upgraded: true });
			const after = (await feed()).find((m) => m.action_id === reply!.action_id)!;
			assert.equal(after.receipt_level, "client_ack");
		});

		test("a replayed client_msg_id is one event and one transcript entry", async () => {
			const id = msgId();
			const a = await post("/api/messages", { client_msg_id: id, text: "once" });
			const b = await post("/api/messages", { client_msg_id: id, text: "once" });
			assert.equal(a.status, 202);
			assert.equal(b.status, 200);
			assert.equal(b.body.outcome, "duplicate");
			assert.equal(b.body.event_id, a.body.event_id);
			assert.equal((await feed()).filter((m) => m.client_msg_id === id).length, 1);
		});

		test("bad input is rejected: client_msg_id format, text length, malformed JSON", async () => {
			for (const client_msg_id of ["", "short", "x".repeat(65), "has spaces in it", 12345678]) {
				assert.equal(
					(await post("/api/messages", { client_msg_id, text: "hi" })).status,
					400,
					String(client_msg_id),
				);
			}
			assert.equal((await post("/api/messages", { client_msg_id: msgId(), text: "x".repeat(8001) })).status, 413);
			assert.equal((await http(s.port, "POST", "/api/messages", { ...auth, raw: "{not json" })).status, 400);
		});

		test("text starting with '/' that is not a host command is ordinary chat", async () => {
			const r = await post("/api/messages", { client_msg_id: msgId(), text: "/shrug hello" });
			assert.equal(r.status, 202);
			await waitFor(async () => (await feed()).some((m) => m.kind === "reply" && m.text === "echo: /shrug hello"));
		});

		test("a failed turn shows a notice and leaves the message unanswered", async () => {
			const r = await post("/api/messages", { client_msg_id: msgId(), text: "[[fail]]" });
			const eventId = String(r.body.event_id);
			let notice: FeedView | undefined;
			await waitFor(async () => {
				notice = (await feed()).find((m) => m.kind === "notice" && m.event_id === eventId);
				return notice !== undefined;
			});
			assert.match(notice!.text, /^I couldn't answer that \(error: /);
			assert.equal(getEvent(s.db, eventId)!.status, "admitted");
			assert.equal(getJobForEvent(s.db, eventId)!.status, "failed");
		});
	});

	describe("messages that need attention", () => {
		test("a failed Telegram reply is listed for the owner (never in the transcript) and can be dismissed", async () => {
			const r = admitTelegramUpdate(
				{ db: s.db, now: () => new Date(), newId: () => crypto.randomUUID() },
				{
					updateId: 77,
					message: {
						messageId: 1,
						chatId: 4242,
						chatType: "private",
						fromUserId: 4242,
						fromIsBot: false,
						username: null,
						firstName: "Julia",
						text: "hi",
						dateUnix: null,
					},
				},
			);
			assert.ok(r.outcome === "admitted");
			// This stack has no Telegram adapter, so the reply fails at once with no fallback.
			const a = await s.outbox.deliver({
				jobId: r.jobId,
				event: getEvent(s.db, r.eventId)!,
				kind: "reply",
				content: "for Julia only",
			});
			assert.equal(a.state, "terminal_failure");

			assert.equal((await http(s.port, "GET", "/api/actions")).status, 401);
			const list = await http(s.port, "GET", "/api/actions", { cookie: auth.cookie });
			const item = (list.body.actions as { id: string; recipient: string; preview: string; state: string }[]).find(
				(x) => x.id === a.id,
			)!;
			assert.equal(item.recipient, "Julia (Telegram)");
			assert.equal(item.preview, "for Julia only");
			assert.ok(!(await feed()).some((m) => m.text === "for Julia only"), "never shown as a web message");
			assert.ok(Number((await http(s.port, "GET", "/api/status", { cookie: auth.cookie })).body.attention) >= 1);

			const body = { action_id: a.id, resolution: "dismiss" };
			assert.equal((await http(s.port, "POST", "/api/actions/resolve", { cookie: auth.cookie, body })).status, 403);
			assert.equal((await post("/api/actions/resolve", { action_id: a.id, resolution: "bogus" })).status, 400);
			assert.deepEqual((await post("/api/actions/resolve", body)).body, { state: "terminal_failure" });
			assert.equal(s.outbox.get(a.id)!.resolved_by, "owner_web");
			assert.equal((await post("/api/actions/resolve", body)).status, 409);
			const after = await http(s.port, "GET", "/api/actions", { cookie: auth.cookie });
			assert.ok(!(after.body.actions as { id: string }[]).some((x) => x.id === a.id));
		});
	});

	describe("owner commands from the web", () => {
		test("/load works, is recorded as issued by owner_web, and a retried POST runs it once", async () => {
			const id = msgId();
			assert.equal((await post("/api/messages", { client_msg_id: id, text: "/load small-2" })).status, 202);
			assert.equal((await post("/api/messages", { client_msg_id: id, text: "/load small-2" })).status, 200);
			await waitFor(async () =>
				(await feed()).some((m) => m.kind === "command_result" && m.text === "small-2 loaded"),
			);
			const ops = s.db
				.prepare("SELECT requested_by FROM model_ops WHERE op = 'load' AND model_name = 'small-2'")
				.all() as { requested_by: string }[];
			assert.deepEqual(ops, [{ requested_by: "owner_web" }]);
		});

		test("status reports the router, each channel's model, and Telegram honestly", async () => {
			const r = await http(s.port, "GET", "/api/status", { cookie: auth.cookie });
			assert.equal(r.body.router, "up");
			assert.deepEqual((r.body.channels as Record<string, unknown>).web, { model: "small", status: "loaded" });
			assert.equal(r.body.telegram, "disabled (no TELEGRAM_BOT_TOKEN)");
		});
	});
});
