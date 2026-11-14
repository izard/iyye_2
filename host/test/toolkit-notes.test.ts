// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/** A toolkit's own note (`Toolkit.note`, 2026-11-14): shown with one request only, to the sessions that declare the toolkit. */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TurnInfo } from "../src/decisions/toolkit-selection.ts";
import { createLocalModelRuntime } from "../src/integration/pi/runtime.ts";
import { PiConversations } from "../src/integration/pi/sessions.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import { RouterClient } from "../src/models/client.ts";
import { renderPreset } from "../src/models/preset.ts";
import type { RouterProcess } from "../src/models/router.ts";
import { openDb } from "../src/state/db.ts";
import { type IyyeTool, ToolBroker, type Toolkit } from "../src/tools/broker.ts";
import { thinkingToolkit } from "../src/tools/thinking.ts";
import { fakeRouterProcess, freePort, type Sandbox, sandbox, waitFor } from "./model-helpers.ts";

describe("a toolkit's note reaches the turn, and only the turn", () => {
	const sb: Sandbox = sandbox();
	let router: RouterProcess;
	let runtime: ModelRuntime;
	const requestsFile = join(sb.stateDir, "fake-router-requests.jsonl");
	const requests = () =>
		existsSync(requestsFile)
			? readFileSync(requestsFile, "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l) as { tools?: { function: { name: string } }[]; messages: unknown[] })
			: [];

	before(async () => {
		writeFileSync(join(sb.stateDir, "models.ini"), renderPreset(sb.registry));
		router = fakeRouterProcess(sb, await freePort());
		await router.start();
		const client = new RouterClient(router.url);
		await client.load("small");
		await waitFor(async () => (await client.listModels()).get("small")?.value === "loaded");
		runtime = await createLocalModelRuntime({ routerUrl: router.url, registry: sb.registry });
	});
	after(async () => {
		await router.stop();
		sb.cleanup();
	});

	const clock: IyyeTool = {
		name: "current_time",
		label: "time",
		description: "time",
		summary: "time",
		parameters: Type.Object({}),
		run: async () => "noon",
	};

	test("the thinking model away: its sessions are told with that request, the tools stay as declared, nothing enters the conversation", async () => {
		rmSync(requestsFile, { force: true });
		const db = openDb(":memory:");
		let why: string | null = null;
		const kits: Toolkit[] = [
			{ name: "core", description: "basics", effect: "read", tools: [clock] },
			thinkingToolkit({
				db,
				model: "tak@mbp",
				machine: "mbp",
				models: { acquire: async () => ({ ok: false, busy: true, message: "mbp is unreachable" }) },
				device: new DeviceSlot(),
				complete: async () => ({ text: "", truncated: false }),
				dailyMax: 5,
				away: () => why,
			}),
		];
		const turns: TurnInfo[] = [];
		const conv = new PiConversations({
			db,
			runtime,
			stateDir: sb.stateDir,
			identity: "You are Iyye.",
			log: silentLogger,
			tools: new ToolBroker({ db, log: silentLogger, toolkits: kits }),
			afterTurn: (t) => turns.push(t),
		});
		const say = async (scope: string, view: Parameters<typeof conv.turn>[0]["view"], text: string) => {
			const r = await conv.turn({ scope, view, model: "small", text });
			assert.ok(r.ok, JSON.stringify(r));
			return requests().at(-1)!;
		};
		const owner = { kind: "owner", channel: "web" } as const;
		const names = (r: { tools?: { function: { name: string } }[] }) => r.tools?.map((t) => t.function.name);
		const told = (r: { messages: unknown[] }) => JSON.stringify(r.messages).includes("<thinking_model>");

		const first = await say("owner", owner, "hello");
		assert.ok(!told(first), "nothing to say while it can be asked");
		assert.deepEqual(turns.at(-1)!.noted, []);

		why = "unreachable";
		const away = await say("owner", owner, "ask the thinking model about primes");
		assert.ok(told(away));
		assert.match(JSON.stringify(away.messages), /cannot be asked right now \(mbp is unreachable\)/);
		assert.deepEqual(names(away), names(first), "the declared tools do not change: no reprocessing");
		assert.deepEqual(turns.at(-1)!.noted, ["thinking"]);

		// An untrusted contact has no thinking toolkit, so no note about it either.
		const contact = await say("contact:c1", { kind: "contact", displayName: "Julia", channel: "telegram" }, "hi");
		assert.deepEqual(names(contact), ["current_time"]);
		assert.ok(!told(contact));
		assert.deepEqual(turns.at(-1)!.noted, []);

		why = null;
		const back = await say("owner", owner, "thanks");
		assert.ok(!told(back), "request-local: the earlier note is not in the conversation");
		assert.match(JSON.stringify(back.messages), /ask the thinking model about primes/, "the conversation itself is");
		assert.deepEqual(turns.at(-1)!.noted, []);
		await conv.disposeAll();
	});
});
