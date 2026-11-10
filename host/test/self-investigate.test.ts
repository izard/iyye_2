// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.018 W4: Iyye's own records as a tool, the investigation of a
 * surprising reading, the questions about its surroundings, and the note for
 * its own work. Everything from records put there by the test.
 */

import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, test } from "node:test";
import { silentLogger } from "../src/log.ts";
import { MotivationActor } from "../src/motivation/actor.ts";
import { MotivationTracker } from "../src/motivation/tracker.ts";
import { Investigations } from "../src/observe/investigations.ts";
import { SelfExpectations } from "../src/self/expectations.ts";
import { recordHosts } from "../src/self/lan.ts";
import { SelfModel } from "../src/self/model.ts";
import { recordReadings } from "../src/self/readings.ts";
import { type PeerConfig, SelfSurroundings } from "../src/self/surroundings.ts";
import { SelfUpkeep } from "../src/self/upkeep.ts";
import { getBackgroundJob, insertBackgroundJob } from "../src/state/background.ts";
import { openDb } from "../src/state/db.ts";
import { INVESTIGATION_SCOPE, ToolBroker, WEB_INVESTIGATION_SCOPE } from "../src/tools/broker.ts";
import { facetOf, SELF_FACETS, selfToolkit } from "../src/tools/self.ts";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = new Date("2026-11-23T12:00:00Z");

/** The memory a probe finds: a lot held by a model that was never there before. */
const MEMINFO = (availableKb: number) =>
	`MemTotal:       127599740 kB\nMemAvailable:   ${availableKb} kB\nSwapTotal:      16777212 kB\nSwapFree:       16357784 kB\n`;
const PS = ["  100    50  204800", "  200   100  262144", "  300   200 4194304", "  302   200 3145728"].join("\n");
const ALIASES = "  300 llama-server --alias gemma-4-26B\n  302 llama-server --alias qwen38-27b-tak\n";
const GPU_APPS = "300, 29923\n302, 61440\n";

function rig() {
	const db = openDb(":memory:");
	const clock = { now: NOW };
	const mem = { availableKb: 9 * 1024 * 1024 };
	const self = new SelfModel({
		db,
		log: silentLogger,
		mode: () => "awake",
		repoDir: ".",
		hostDir: ".",
		llamaServer: "x",
		geoHttp: null,
		now: () => clock.now,
	});
	self.setFacet("hardware", { machine: "NVIDIA DGX Spark", chip: "GB10", memoryGb: 122 }, "probe", null, NOW);
	self.setFacet("place", { stated: "SECRETPLACE" }, "owner", "owner_web", NOW);
	const duCalls: string[] = [];
	const upkeep = new SelfUpkeep({
		db,
		log: silentLogger,
		self,
		mode: () => "awake",
		processes: () => [
			{ role: "the host", pid: 100 },
			{ role: "the model router", pid: 200, router: true },
		],
		paths: { home: "/" },
		dirs: () => ({ "state/voice": "/x/voice" }),
		models: () => [],
		rhythm: null,
		inRestWindow: () => false,
		process: { ppid: 50, env: {}, terminal: false },
		exec: async (file, args) => {
			if (file === "nvidia-smi") return args[0]!.startsWith("--query-gpu") ? "3, 41, 12.5\n" : GPU_APPS;
			if (file === "ps" && args[1] === "pid=,ppid=,rss=") return PS;
			if (file === "ps" && args[1] === "pid=,args=") return ALIASES;
			if (file === "ps") return "";
			if (file === "du") {
				duCalls.push(args[1]!);
				return `${20 * 2 ** 20}\t${args[1]}\n`;
			}
			throw new Error(`unexpected command ${file}`);
		},
		readFile: (p) => (p === "/proc/meminfo" ? MEMINFO(mem.availableKb) : null),
		listDir: () => [],
		platform: "linux",
		now: () => clock.now,
		timezone: "UTC",
	});
	self.attach(upkeep);
	const exp = new SelfExpectations({
		db,
		log: silentLogger,
		self,
		mode: () => "awake",
		needs: {},
		restWindowMinutes: 240,
		timezone: "UTC",
		now: () => clock.now,
	});
	self.attach(exp);
	const machine = exp["machine" as keyof SelfExpectations] as unknown as string;
	// Ten days of history: 50 GB available, and the 26B model holding 33 GB as it does now.
	for (let d = 1; d <= 10; d++)
		for (let h = 0; h < 24; h++)
			recordReadings(
				db,
				machine,
				"memory",
				{ availableGb: 50, "resident:model gemma-4-26B": 4, "gpu:model gemma-4-26B": 29.2 },
				new Date(NOW.getTime() - d * DAY - 12 * H + h * H),
			);
	const kit = selfToolkit({
		facet: async (facet) => {
			if (facet === "memory") {
				await upkeep.current();
				return upkeep.memoryReport({ compare: true });
			}
			if (facet === "disk") return upkeep.diskReport();
			if (facet === "compute") return upkeep.computeReport();
			if (facet === "runs") return upkeep.runsReport();
			if (facet === "normal") return exp.report();
			if (facet === "models") return upkeep.modelsReport();
			return "network: not looked at in this test";
		},
		diskUsage: () => upkeep.diskUsage(),
	});
	const tool = (name: string) => kit.tools.find((t) => t.name === name)!;
	const ctx = { scope: `${INVESTIGATION_SCOPE}x:1`, principal: "iyye" as const };
	return { db, clock, mem, self, upkeep, exp, kit, tool, ctx, duCalls };
}

describe("Iyye's own records as a tool", () => {
	test("self_model: memory with what each process usually holds and what is not Iyye's; the other facets", async () => {
		const r = rig();
		const memory = await r.tool("self_model").run({ facet: "memory" }, r.ctx, undefined);
		assert.match(memory, /^memory \[just now\]: 9 GB of 121\.7 GB available; swap 0\.4 of 16 GB used/);
		assert.match(memory, /model qwen38-27b-tak — 3\.0 \+ 60\.0 = 63\.0 GB \(no history of it: new\)/);
		assert.match(memory, /model gemma-4-26B — 4\.0 \+ 29\.2 = 33\.2 GB \(usually 33\.2 GB\)/);
		assert.match(
			memory,
			/other programs \(not Iyye's\) and the system hold about 16\.0 GB \(in use 112\.7 GB, less Iyye's own 96\.7 GB\)/,
		);
		assert.match(
			await r.tool("self_model").run({ facet: "compute" }, r.ctx, undefined),
			/^load \[just now\]: [\d.]+ \/ [\d.]+ \/ [\d.]+ \(1, 5, 15 min\) on \d+ cores\nGPU: 3% busy, 41 °C, 12\.5 W/,
		);
		assert.match(await r.tool("self_model").run({ facet: "normal" }, r.ctx, undefined), /^what is normal/);
		assert.match(
			await r.tool("self_model").run({ facet: "models" }, r.ctx, undefined),
			/qwen38-27b-tak — not on this machine; 3 \+ 60 GB/,
		);
		assert.match(
			memory,
			/what differs most from usual: model qwen38-27b-tak holds 63\.0 GB, and it has no history \(it was not there before\)/,
		);
		// The facet is a word that only chooses among the fixed ones: a near word is understood, and any other
		// gets the list back instead of a rejected call.
		assert.match(await r.tool("self_model").run({ facet: "RAM" }, r.ctx, undefined), /^memory \[/);
		assert.equal(facetOf("gpu"), "compute");
		assert.equal(facetOf("people"), null);
		assert.equal(
			await r.tool("self_model").run({ facet: "people" }, r.ctx, undefined),
			`no facet "people"; the facets are: ${SELF_FACETS.join(", ")}`,
		);
	});

	test("disk_usage measures now; the toolkit is for the owner and Iyye's own work, never a contact", async () => {
		const r = rig();
		const disk = await r.tool("disk_usage").run({}, r.ctx, undefined);
		assert.deepEqual(r.duCalls, ["/x/voice"]);
		assert.match(
			disk,
			/^filesystems \[just now\]:\n {2}home — [\d.]+ GB free of [\d.]+ GB\nIyye's own directories \[just now\], GB:\n {2}state\/voice — 20\.0$/,
		);
		assert.equal(ToolBroker.allowed(r.kit, "owner"), true);
		assert.equal(ToolBroker.allowed(r.kit, "iyye", false, `${INVESTIGATION_SCOPE}x:1`), true);
		assert.equal(
			ToolBroker.allowed(r.kit, "iyye", false, `${WEB_INVESTIGATION_SCOPE}x:1`),
			true,
			"nothing in it is the owner's",
		);
		assert.equal(ToolBroker.allowed(r.kit, "contact"), false);
		assert.equal(ToolBroker.allowed(r.kit, "contact", true), false, "not a trusted contact either");
	});

	test("the note for Iyye's own work: the machine and how it is doing; no place, no people", async () => {
		const r = rig();
		await r.upkeep.tick();
		const note = r.self.aboutOwnWork()!;
		assert.match(note, /^<about_me>\nWhat you know about the machine you run on/);
		assert.match(note, /- Hardware: Iyye runs on NVIDIA DGX Spark, GB10, 122 GB memory\./);
		assert.match(note, /- What your own processes hold .*model qwen38-27b-tak 63\.0/);
		assert.ok(!/SECRETPLACE|People who wrote|Place:/.test(note));
		assert.match(r.self.aboutMe(null), /SECRETPLACE/, "the owner's own note still has the place");
	});
});

describe("a surprising reading is looked into", () => {
	test("exit check: a staged memory drop is explained with figures the tools returned, and only those", async () => {
		const r = rig();
		// Memory available falls to 9 GB and stays there for three readings: a surprise.
		for (const m of [0, 10, 20]) {
			r.clock.now = new Date(NOW.getTime() + m * MIN);
			recordReadings(
				r.db,
				r.exp["machine" as keyof SelfExpectations] as unknown as string,
				"memory",
				{ availableGb: 9 },
				r.clock.now,
			);
			await r.exp.tick();
		}
		const [surprise] = r.exp.signals();
		assert.equal(surprise!.kind, "self_surprise");
		// The motivations open an investigation for it.
		const actor = new MotivationActor({
			db: r.db,
			log: silentLogger,
			mode: () => "awake",
			notifyOwner: async () => undefined,
			self: r.self,
			now: () => r.clock.now,
		});
		const tracker = new MotivationTracker({
			db: r.db,
			log: silentLogger,
			actor,
			mode: () => "awake",
			sources: { selfGaps: () => [], healing: () => [], sleep: () => null, expectations: () => r.exp.signals() },
			now: () => r.clock.now,
			alpha: 0.5,
			threshold: 0.55,
			sustain: 2,
		});
		for (let i = 0; i < 6; i++) {
			r.clock.now = new Date(NOW.getTime() + (30 + i * 10) * MIN);
			await tracker.sweep();
		}
		const opp = r.db
			.prepare("SELECT id, domain, action_kind, status, evidence_text, question FROM opportunities")
			.all() as {
			id: string;
			domain: string;
			action_kind: string;
			status: string;
			evidence_text: string;
			question: string;
		}[];
		assert.equal(opp.length, 1, "once, however long it lasts");
		assert.deepEqual([opp[0]!.domain, opp[0]!.action_kind, opp[0]!.status], ["machine", "investigate", "open"]);
		assert.match(
			opp[0]!.evidence_text,
			/^memory available has been unusual since 2026-11-23 12:00: 9 GB, usually about 50/,
		);
		// The investigations loop runs it in a session with Iyye's own records.
		const enqueued: { origin: string; prompt: string; session?: string }[] = [];
		let n = 0;
		const inv = new Investigations({
			db: r.db,
			worker: {
				enqueue: (step) => {
					enqueued.push(step);
					insertBackgroundJob(r.db, {
						id: `job-${++n}`,
						origin: step.origin,
						session: step.session!,
						prompt: step.prompt,
						at: r.clock.now.toISOString(),
					});
					return `job-${n}`;
				},
				initiativePaused: () => false,
			},
			mode: () => "awake",
			log: silentLogger,
			now: () => r.clock.now,
		});
		await inv.tick();
		assert.equal(enqueued.length, 1);
		assert.ok(
			enqueued[0]!.session!.startsWith(INVESTIGATION_SCOPE) &&
				!enqueued[0]!.session!.startsWith(WEB_INVESTIGATION_SCOPE),
		);
		assert.match(
			enqueued[0]!.prompt,
			/^Investigation: memory available has been unusual since .*\nWhat explains this reading\?/,
		);
		assert.match(enqueued[0]!.prompt, /self_model with the facet that fits/);
		// The step calls the tool (the real one, on the staged records) and answers.
		const settle = async (answer: string, call: boolean) => {
			const step = enqueued.at(-1)!;
			const job = `done-${++n}`;
			const at = r.clock.now.toISOString();
			if (call) {
				const result = await r
					.tool("self_model")
					.run({ facet: "memory" }, { scope: step.session!, principal: "iyye" }, undefined);
				r.db
					.prepare(
						"INSERT INTO tool_calls (id, scope, principal, tool, toolkit, args_json, outcome, result, started_at, finished_at) VALUES (?, ?, 'iyye', 'self_model', 'self', ?, 'ok', ?, ?, ?)",
					)
					.run(`tc-${job}`, step.session, '{"facet":"memory"}', result, at, at);
			}
			insertBackgroundJob(r.db, { id: job, origin: step.origin, session: step.session!, prompt: step.prompt, at });
			r.db
				.prepare("UPDATE background_jobs SET status = 'settled', result = ?, settled_at = ? WHERE id = ?")
				.run(answer, at, job);
			inv.onStepSettled(getBackgroundJob(r.db, job)!);
		};
		// Repeating the surprise's own figure explains nothing, tool or no tool.
		await settle("Memory is low: only 9 GB is available, far below the usual 50 GB.", true);
		assert.equal(enqueued.length, 2, "not accepted: one more step");
		assert.match(
			enqueued[1]!.prompt,
			/That answer is not accepted: it only repeats the reading, with no figure from the tools that explains it\. .* citing figures \(GB, MB, %\) from their results/,
		);
		// A figure the tools did not return is refused, whatever else is right (the model's own arithmetic: 96.2).
		await settle("qwen38-27b-tak holds 63.0 GB and gemma-4-26B 33.2 GB, 96.2 GB together.", false);
		assert.equal(enqueued.length, 3);
		assert.match(enqueued[2]!.prompt, /it names 96\.2GB, which the tools did not return/);
		// An answer from the tool's own figures is.
		await settle(
			"The model qwen38-27b-tak is loaded and holds 63.0 GB, and it has no history: it is new. gemma-4-26B holds its usual 33.2 GB. Together with the rest, 112.7 GB is in use.",
			false,
		);
		const done = r.db.prepare("SELECT status, outcome, credited, finding_id FROM opportunities").get() as {
			status: string;
			outcome: string;
			credited: number;
			finding_id: string;
		};
		assert.deepEqual([done.status, done.outcome, done.credited], ["settled", "resolved", 1]);
		const finding = r.db
			.prepare("SELECT domain, change_text FROM observations WHERE id = ?")
			.get(done.finding_id) as {
			domain: string;
			change_text: string;
		};
		assert.equal(finding.domain, "investigation");
		assert.match(
			finding.change_text,
			/^memory available has been unusual .* → The model qwen38-27b-tak is loaded and holds 63\.0 GB/,
		);
		// The surprise lasts; nothing is opened again for it.
		for (let i = 0; i < 4; i++) {
			r.clock.now = new Date(NOW.getTime() + (120 + i * 10) * MIN);
			await tracker.sweep();
		}
		assert.equal((r.db.prepare("SELECT count(*) AS n FROM opportunities").get() as { n: number }).n, 1);
	});
});

describe("questions about the surroundings", () => {
	const IFACES: NodeJS.Dict<NetworkInterfaceInfo[]> = {};
	function around() {
		const db = openDb(":memory:");
		const clock = { now: NOW };
		const self = new SelfModel({
			db,
			log: silentLogger,
			mode: () => "awake",
			repoDir: ".",
			hostDir: ".",
			llamaServer: "x",
			geoHttp: null,
			now: () => clock.now,
		});
		const mbp: PeerConfig = {
			endpoint: "mbp",
			serves: "the thinking model",
			address: "192.168.1.177",
			answering: true,
			error: null,
		};
		const s = new SelfSurroundings({
			db,
			log: silentLogger,
			self,
			mode: () => "awake",
			peers: () => [mbp],
			needs: { Telegram: "internet", "the thinking model on mbp": { peer: "mbp" } },
			lan: "passive",
			exec: async () => "[]",
			readFile: (p) =>
				p === "/proc/net/route" ? "Iface\tDestination\tGateway\tFlags\nwlan0\t00000000\t0101A8C0\t0003\n" : null,
			listDir: () => [],
			platform: "linux",
			interfaces: () => IFACES,
			now: () => clock.now,
			timezone: "UTC",
		});
		self.attach(s);
		const at = async (ms: number) => {
			clock.now = new Date(NOW.getTime() + ms);
			await s.tick();
		};
		return { db, clock, self, s, mbp, at };
	}

	test("a machine silent for days: asked once, and the owner's word makes its silence no trouble until it answers", async () => {
		const r = around();
		await r.at(0);
		r.mbp.answering = false;
		r.mbp.error = "connect EHOSTUNREACH";
		await r.at(MIN);
		assert.deepEqual(r.s.reasons(), [], "silent for a minute");
		await r.at(2 * DAY);
		assert.deepEqual(r.s.reasons(), []);
		await r.at(3 * DAY + H);
		const [reason] = r.s.reasons();
		assert.deepEqual([reason!.kind, reason!.cluster], ["peer_long_away", "peer:mbp"]);
		assert.equal(
			reason!.text,
			"mbp (the thinking model) has not answered for 3 days; the owner has not said whether that is expected",
		);
		const q = r.s.question("peer:mbp")!;
		assert.match(
			q.question,
			/^A question about my surroundings: mbp, which I use for the thinking model, has not answered since 2026-11-23 12:01\. Is that expected\? Answer here in the web chat with \/self peer mbp away /,
		);
		assert.equal(r.s.usual("service:the thinking model on mbp"), false);
		assert.equal(r.s.cause("the thinking model on mbp"), "mbp is not on the local network");
		assert.match(
			r.self.command(["peer", "mbp"], "owner_web"),
			/usage: \/self peer <name> away \| back \(names: mbp\)/,
		);
		assert.match(r.self.command(["peer", "mbp", "away"], "owner_web"), /noted: mbp is expected to be away/);
		assert.deepEqual(r.s.reasons(), []);
		assert.equal(r.s.question("peer:mbp"), null);
		assert.equal(r.s.usual("service:the thinking model on mbp"), true, "its service's outage is as the owner said");
		assert.equal(r.s.usual("service:Telegram"), false);
		assert.equal(r.s.cause("the thinking model on mbp"), "mbp is expected to be away");
		assert.match(
			r.self.command(["network"], "owner_web"),
			/mbp \(the thinking model\): not on the LAN \(expected to be away: the owner said so\)/,
		);
		// It answers again: expected again, and a later silence is trouble as before.
		r.mbp.answering = true;
		await r.at(4 * DAY);
		assert.equal(r.s.expectedAway("mbp"), false);
		r.mbp.answering = false;
		await r.at(4 * DAY + MIN);
		assert.equal(r.s.usual("service:the thinking model on mbp"), false);
	});

	test("a host new to the network that keeps coming is asked about; the household as it was found is not", async () => {
		const r = around();
		const host = (n: number) => ({ ip: `192.168.1.${n}`, mac: `aa:aa:aa:00:00:${String(n).padStart(2, "0")}` });
		// The first two days: what was there when Iyye first looked.
		for (const d of [0, 1]) recordHosts(r.db, [host(10), host(11)], new Date(NOW.getTime() + d * DAY));
		// A week later a new device appears, and comes back on three days.
		for (const d of [7, 8]) recordHosts(r.db, [host(10), host(42)], new Date(NOW.getTime() + d * DAY));
		r.clock.now = new Date(NOW.getTime() + 8 * DAY);
		assert.deepEqual(r.s.reasons(), [], "two days are not yet a habit");
		recordHosts(r.db, [host(10), host(11), host(42)], new Date(NOW.getTime() + 9 * DAY));
		r.clock.now = new Date(NOW.getTime() + 9 * DAY);
		const reasons = r.s.reasons();
		assert.equal(reasons.length, 1, "only the new one, though the old ones have no name either");
		assert.equal(reasons[0]!.kind, "lan_unknown_host");
		assert.equal(
			reasons[0]!.text,
			"a device that is new to the local network has been there on 3 days since 2026-11-30, and has no name",
		);
		const q = r.s.question(reasons[0]!.cluster)!;
		const ref = reasons[0]!.cluster.slice("lan:".length, "lan:".length + 6);
		assert.equal(
			q.question,
			`A question about my surroundings: a device I do not know (192.168.1.42) has been on the local network on 3 days since 2026-11-30. What is it? Answer here in the web chat with /self host ${ref} <its name> or /self host ${ref} forget.`,
		);
		assert.match(r.self.command(["host", ref, "the", "new", "printer"], "owner_web"), /noted/);
		assert.deepEqual(r.s.reasons(), []);
		assert.equal(r.s.question(reasons[0]!.cluster), null);
	});
});
