// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Iyye 2.0 resident host entry point.
 *
 *   node src/main.ts
 *
 * 0.001 so far: configuration, control-state database, local model router
 * and model manager, the locked-down Pi integration with read-only tools
 * (current time; system status for the owner), the owner's authenticated
 * web chat with the scheduler and outbox that answer it, and a development
 * console on the host's terminal.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { TelegramPoller } from "./channels/telegram/poller.ts";
import { TelegramSender } from "./channels/telegram/sender.ts";
import { WebChatAdapter } from "./channels/web/adapter.ts";
import { ensureOwnerToken, WebSessions } from "./channels/web/auth.ts";
import { WebServer } from "./channels/web/server.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { DecisionClient } from "./decisions/client.ts";
import { InitiativeShadow } from "./decisions/initiative.ts";
import { MemorySalience } from "./decisions/memory-salience.ts";
import { ObservationImportance } from "./decisions/observation-importance.ts";
import { ReplyReviewShadow } from "./decisions/reply-review.ts";
import { decisionsReport, labelDecision, roleReport } from "./decisions/report.ts";
import { DecisionService } from "./decisions/service.ts";
import { ToolkitSelectionShadow, ToolkitSelector } from "./decisions/toolkit-selection.ts";
import { createLocalModelRuntime } from "./integration/pi/runtime.ts";
import { PiConversations } from "./integration/pi/sessions.ts";
import { Adenosine } from "./kernel/adenosine.ts";
import { BackgroundWorker } from "./kernel/background.ts";
import { type CommandExtras, handleOwnerCommand, isCommand } from "./kernel/commands.ts";
import { CommitmentClock } from "./kernel/commitments.ts";
import { composeDaySummary } from "./kernel/day-summary.ts";
import { DeviceSlot } from "./kernel/device.ts";
import { focusReport } from "./kernel/focus.ts";
import { PlanRunner } from "./kernel/plans.ts";
import { recover } from "./kernel/recovery.ts";
import { ReminderCommands } from "./kernel/reminder-commands.ts";
import { Rhythm } from "./kernel/rhythm.ts";
import { Scheduler } from "./kernel/scheduler.ts";
import { wakeMessage, wakeProblems } from "./kernel/wake-check.ts";
import { consoleLogger, type Logger } from "./log.ts";
import { MemoryControl } from "./memory/control.ts";
import { MemoryGate } from "./memory/gate.ts";
import { MemoryGateway } from "./memory/gateway.ts";
import { HindsightClient } from "./memory/hindsight.ts";
import { NightWork } from "./memory/night.ts";
import { MemoryPassthrough } from "./memory/passthrough.ts";
import { memoryReport } from "./memory/report.ts";
import { MemoryService } from "./memory/service.ts";
import { RouterClient } from "./models/client.ts";
import { ModelManager } from "./models/manager.ts";
import { systemMemoryProbe } from "./models/memory.ts";
import { loadRegistry, RegistryError } from "./models/registry.ts";
import { pidAlive, RouterProcess } from "./models/router.ts";
import { gitDomain, machineDomain } from "./observe/domains.ts";
import { Investigations } from "./observe/investigations.ts";
import { Observer } from "./observe/observer.ts";
import { ensureWorkspace } from "./observe/workspace.ts";
import { type ChannelAdapter, Outbox } from "./outbox/outbox.ts";
import { recentReminderNote, remindersChip, remindersToday } from "./state/commitments.ts";
import { type Db, openDb } from "./state/db.ts";
import { getJob } from "./state/jobs.ts";
import { DAY_KEYS } from "./state/models.ts";
import { recentSentNote, sentReport } from "./state/sent.ts";
import { recordIyyeEntry } from "./state/stm.ts";
import { appendFeed } from "./state/web.ts";
import { ToolBroker, type Toolkit } from "./tools/broker.ts";
import { GuardedHttp } from "./tools/http.ts";
import { memorySearchTool } from "./tools/memory-search.ts";
import { messagingToolkit } from "./tools/messaging.ts";
import { plansToolkit } from "./tools/plans.ts";
import { currentTimeTool, systemStatusTool } from "./tools/probes.ts";
import { projectToolkit } from "./tools/project.ts";
import { remindersToolkit } from "./tools/reminders.ts";
import { toolsReport } from "./tools/report.ts";
import { WEB_TOOLKIT, webFetchTool, webSearchTool } from "./tools/web.ts";
import { SearxngService } from "./web/searxng.ts";

async function main(): Promise<number> {
	const log = consoleLogger();
	let config: ReturnType<typeof loadConfig>;
	let registry: ReturnType<typeof loadRegistry>;
	let identity: string;
	try {
		config = loadConfig();
		registry = loadRegistry(config.modelsRegistry);
		identity = readFileSync(config.identityFile, "utf8");
	} catch (err) {
		if (err instanceof ConfigError || err instanceof RegistryError) {
			log.error(err.message);
			return 2;
		}
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			log.error(`cannot read ${(err as NodeJS.ErrnoException).path}`);
			return 2;
		}
		throw err;
	}
	mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
	if (!acquireHostLock(config.stateDir, log)) return 3;

	const db = openDb(join(config.stateDir, "iyye.db"));
	const router = new RouterProcess({
		command: config.llamaServer,
		argsPrefix: config.llamaServerArgsPrefix,
		port: config.routerPort,
		presetPath: join(config.stateDir, "models.ini"),
		stateDir: config.stateDir,
		startTimeoutMs: 30_000,
		stopGraceMs: 30_000,
		log,
	});
	const models = new ModelManager({
		db,
		registry,
		router,
		client: new RouterClient(router.url),
		memory: systemMemoryProbe,
		stateDir: config.stateDir,
		modelsMax: config.modelsMax,
		defaultModel: config.defaultModel,
		defaultMemoryModel: config.memory.defaultModel,
		defaultBackgroundModel: config.backgroundModel,
		healthIntervalMs: config.healthIntervalS * 1000,
		log,
	});

	const memory = new MemoryService({
		installDir: config.memory.installDir,
		stateDir: join(config.stateDir, "memory"),
		hindsightPort: config.memory.hindsightPort,
		dbPort: config.memory.dbPort,
		passthroughPort: config.memory.passthroughPort,
		models: {
			embeddings: config.memory.embeddingsModel,
			reranker: config.memory.rerankerModel,
			textSearchLanguage: config.memory.textSearchLanguage,
			storedLanguage: "English",
		},
		enabled: config.memory.enabled,
		log,
	});
	// Day recall (plan 0.002 L3): STM in SQLite, LTM in Hindsight; neither uses the generative model.
	const ltm = config.memory.enabled
		? new HindsightClient({ baseUrl: memory.baseUrl, apiKey: () => memory.apiKey() })
		: null;
	const gateway = new MemoryGateway({
		db,
		ltm,
		ltmReady: () => memory.status.state === "up",
		log,
	});

	// Iyye's own SearXNG (plan 0.004 T3): self-hosted search, no account, no key.
	const searxng = new SearxngService({
		installDir: config.web.searxngDir,
		stateDir: join(config.stateDir, "web"),
		port: config.web.searxngPort,
		engines: config.web.searxngEngines,
		enabled: config.web.enabled,
		log,
	});
	const webHttp = new GuardedHttp();
	// Toolkits in declaration order: the order the model sees, always (plan 0.004 §3.4).
	// Read-only toolkits are for everyone, owner and contacts (owner decision, plan 0.004 §8).
	const machineToolkit: Toolkit = {
		name: "machine",
		description: "the state of the computer you run on",
		effect: "read",
		tools: [
			systemStatusTool({
				memory: systemMemoryProbe,
				loadedModels: async () =>
					(await models.status()).models.filter((m) => m.status === "loaded").map((m) => m.name),
			}),
		],
	};
	// Plan 0.008: one instance, in the people's broker and the background one. `outbox` is created below;
	// it is read only when the tool runs.
	const messaging = messagingToolkit({
		db,
		outbox: { sendOwn: (req) => outbox.sendOwn(req), notifyOwner: (req) => outbox.notifyOwner(req) },
		maxPerDay: config.send.dailyMax,
		contactMaxPerDay: config.send.contactDailyMax,
		iyyeMaxPerDay: config.send.iyyeDailyMax,
	});
	const tools = new ToolBroker({
		db,
		log,
		toolkits: [
			{
				name: "core",
				description: "the time and your memory of earlier conversations",
				effect: "read",
				tools: [currentTimeTool(), memorySearchTool(gateway)],
			},
			machineToolkit,
			...(config.web.enabled
				? [
						{
							name: WEB_TOOLKIT,
							description: "the public web",
							effect: "read" as const,
							tools: [
								webSearchTool({
									db,
									http: webHttp,
									budget: config.web.dailyCalls,
									searxng,
									wikipediaLangs: config.web.wikipediaLangs,
								}),
								webFetchTool({ db, http: webHttp, budget: config.web.dailyCalls }),
							],
						},
					]
				: []),
			// Last, so adding it left the earlier declarations (and the prompt cache) unchanged (plan 0.006 C1).
			remindersToolkit({
				db,
				contactMax: config.commitments.contactMax,
				restWindow: config.memory.sleepWindow,
			}),
			// After reminders, for the same reason (plan 0.006 C4). `plans` is created below; it is read only during a turn.
			plansToolkit({ propose: (p) => plans.propose(p) }),
			// Last again (plan 0.008): messages to people Iyye knows (owner, trusted contacts, Iyye itself).
			messaging,
		],
	});
	const runtime = await createLocalModelRuntime({ routerUrl: router.url, registry });
	const selectionActs = config.decisions.toolkitSelection === "act";
	const conversations = new PiConversations({
		db,
		runtime,
		stateDir: config.stateDir,
		identity,
		log,
		tools,
		memory: gateway,
		// Reminders just sent in a chat, so the next turn knows what an answer to one means (plan 0.006).
		// …and messages Iyye sent them for the owner (plan 0.008).
		turnNotes: (scope) =>
			[recentReminderNote(db, scope, new Date()), recentSentNote(db, scope, new Date())]
				.filter(Boolean)
				.join("\n\n") || null,
		// Plan 0.004 §3.4: acting toolkit selection before each turn (only adds; `selector` is created below and
		// read only during a turn), or the T4 shadow after it. Never both.
		toolkitSelection: selectionActs
			? { alwaysOn: (name) => selector.alwaysOn(name), choose: (req) => selector.choose(req) }
			: null,
		afterTurn: (turn) => (selectionActs ? selector.observe(turn) : selectionShadow.observe(turn)),
	});

	// Without a token the Telegram route has no adapter: such actions fail at once (no fallback to web).
	const adapters: ChannelAdapter[] = [new WebChatAdapter({ db, log })];
	if (config.telegramBotToken) adapters.push(new TelegramSender({ token: config.telegramBotToken, log }));
	// Asleep, retries wait until waking (HLD §15 #11). `rhythm` is created below; this runs later.
	const outbox = new Outbox({ db, log, adapters, held: () => rhythm.mode() === "asleep" });
	// One device-consuming task at a time (HLD §5.1): chat jobs, console turns and memory work share it.
	const device = new DeviceSlot();
	// Adenosine (plan 0.007 S2): one writer of energy charges; `rhythm` is created below and read later.
	const adenosine = new Adenosine({
		db,
		log,
		mode: () => rhythm.mode(),
		charges: { awakePerHour: config.adenosine.perHour },
		reserve: config.adenosine.reserve,
		windDown: config.adenosine.windDown,
	});
	const scheduler = new Scheduler({
		db,
		device,
		models,
		conversations,
		outbox,
		log,
		onDeviceTime: (jobId, ms) => adenosine.deviceTime("chat", ms, `${jobId}:${getJob(db, jobId)?.attempt ?? 0}`),
		rhythm: {
			mode: () => rhythm.mode(),
			wakeForOwner: (why) => rhythm.wakeForOwner(why),
			restoring: () => rhythm.restoring(),
		},
	});
	// Background work (plan 0.007 S1): its own conversations and read-only toolkits, on the background model.
	const backgroundConversations = new PiConversations({
		db,
		runtime,
		stateDir: join(config.stateDir, "background"),
		identity,
		log,
		// Fixed order (plan 0.004 §3.4): machine, then project (read-only looks into Iyye's repositories, S5).
		tools: new ToolBroker({
			db,
			log,
			toolkits: [
				machineToolkit,
				projectToolkit({
					workspace: config.workspaceDir,
					...(config.projectRepo ? { project: config.projectRepo } : {}),
				}),
				// Iyye may write to people on its own (plan 0.008 change): labelled, capped, the owner told.
				messaging,
			],
		}),
	});
	const background = new BackgroundWorker({
		db,
		device,
		models,
		conversations: backgroundConversations,
		chatPending: () => scheduler.hasRunnableJobs() || scheduler.busy,
		rhythm: { mode: () => rhythm.mode() },
		log,
		quietMs: config.backgroundQuietS * 1000,
		gapMs: config.backgroundGapS * 1000,
		energy: adenosine,
		onSettled: (job) => {
			log.info("background: step settled", { id: job.id, origin: job.origin });
			investigations.onStepSettled(job);
			plans.onStepSettled(job);
		},
	});
	const admission = {
		db,
		now: () => new Date(),
		newId: () => crypto.randomUUID(),
		telegramAllowedUserIds: config.telegramAllowedUserIds,
	};
	const poller = config.telegramBotToken
		? new TelegramPoller({ token: config.telegramBotToken, admission, log, wake: () => scheduler.wake() })
		: null;
	// Hindsight's model calls reach the router only through this, and only inside the gate.
	const passthrough = new MemoryPassthrough({
		port: config.memory.passthroughPort,
		routerUrl: router.url,
		key: () => memory.passthroughKey(),
		log,
	});
	models.onRouterLost(() => passthrough.abortAll("model router lost"));
	const memoryGate = new MemoryGate({
		device,
		models,
		passthrough,
		chatPending: () => scheduler.hasRunnableJobs(),
		log,
	});
	// Day and night (plan 0.002 L4/L5): STM moves into LTM only while asleep.
	const rhythm = new Rhythm({
		db,
		window: config.memory.sleepWindow,
		night: ltm
			? new NightWork({
					db,
					ltm,
					gate: memoryGate,
					log,
					thinking: config.memory.thinking,
					purgeTraces: (bank) => memory.purgeTraces(bank),
					// Shadow (plan 0.003 K3): journaled, never read by the night.
					salience: {
						ask: (e) => memorySalience.ask(e),
						outcome: (id, t) => memorySalience.outcome(id, t),
					},
				})
			: null,
		turnRunning: () => device.holder !== null && !device.holder.startsWith("memory:"),
		// Asleep, only the memory model stays loaded; waking loads the chat models again.
		models,
		keep: () => {
			const m = models.selected("memory");
			return m ? [m] : [];
		},
		ready: () => models.state === "up" && memory.status.state === "up",
		// Owner decision (2026-10-03): chat history does not survive the night; memory carries the days.
		onNightEnd: async () => {
			const n = await conversations.resetAll();
			// resetAll retired every session row, background ones too: close the background conversations as well,
			// or a paused step would continue its old in-memory conversation (plan 0.007 S1).
			await backgroundConversations.disposeAll();
			log.info("rhythm: conversations start afresh", { retired: n });
		},
		notify: (text) => appendFeed(db, { kind: "notice", text, at: new Date().toISOString() }),
		energy: adenosine,
		minRestMs: config.adenosine.minRestMin * 60_000,
		// The end of a completed day (plan 0.007 S3): the summary, then the wake check, as web chat messages.
		dayEnd: {
			compose: async (w) => {
				const r = await composeDaySummary(db, w, {
					complete: async (system, user) => {
						const out = await memoryGate.run(
							"day-summary",
							async (model) => {
								const res = await fetch(`${router.url}/v1/chat/completions`, {
									method: "POST",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({
										model,
										stream: false,
										max_tokens: 400,
										chat_template_kwargs: { enable_thinking: false },
										messages: [
											{ role: "system", content: system },
											{ role: "user", content: user },
										],
									}),
									signal: AbortSignal.timeout(600_000), // a hang detector, not a latency budget
								});
								if (!res.ok) return null;
								const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
								return body.choices?.[0]?.message?.content ?? null;
							},
							{ thinking: false },
						);
						return out.ok ? out.value : null;
					},
				});
				log.info("rhythm: day summary", { source: r.source, problem: r.problem });
				return r.text;
			},
			afterWake: async (day, summary) => {
				if (summary) {
					// Owner decision (2026-10-04): the summary also goes into short-term memory, so Iyye can talk about it.
					recordIyyeEntry(db, {
						id: `summary:${day - 1}`,
						kind: "summary",
						text: summary,
						at: new Date().toISOString(),
					});
					await outbox.notifyOwner({ key: `day-summary:${day - 1}`, content: summary });
				}
				const status = await models.status();
				const missing = DAY_KEYS.map((k) => models.selected(k)).filter(
					(m): m is string => m !== null && !status.models.some((s) => s.name === m && s.status === "loaded"),
				);
				const problems = wakeProblems({
					db,
					services: {
						"the model router": models.state,
						"long-term memory": config.memory.enabled ? memory.status.state : "disabled",
						"the decision service": decisions.status.state,
						"web search": searxng.status.state,
						Telegram: poller ? poller.status.state : "disabled",
					},
					missingModels: [...new Set(missing)],
				});
				if (problems.length)
					await outbox.notifyOwner({ key: `wake-check:${day}`, content: wakeMessage(day, problems) });
			},
		},
		log,
	});
	const stmCount = (states: string) =>
		(db.prepare(`SELECT count(*) AS n FROM stm_episodes WHERE state IN (${states})`).get() as { n: number }).n;
	// /forget and /remember (plan 0.002 L6).
	const memoryControl = new MemoryControl({
		db,
		ltm,
		log,
		mode: () => rhythm.mode(),
		forgetConversations: (scopes) => conversations.forgetScopes(scopes),
		forgetBackground: (scopes) => backgroundConversations.forgetScopes(scopes),
		retireConversations: (scopes) => conversations.retireScopes(scopes),
		forgetQueued: (scopes) => {
			selectionShadow.forgetScopes(scopes);
			selector.forgetScopes(scopes);
		},
		purgeTraces: (bank) => memory.purgeTraces(bank),
	});
	// The commitment clock (plan 0.006 C1): due reminders become actions on their exact route; asleep, they wait.
	const commitmentClock = new CommitmentClock({
		db,
		outbox,
		mode: () => rhythm.mode(),
		log,
		tickMs: config.commitments.tickMs,
		lateMs: config.commitments.lateH * 3_600_000,
		maxLateMs: config.commitments.maxLateD * 86_400_000,
	});
	// Plans (plan 0.006 C4): typed steps, each done only with its evidence; the owner authorizes what reaches beyond them.
	const plans = new PlanRunner({
		db,
		worker: background,
		outbox,
		log,
		contactMax: config.commitments.contactPlansMax,
	});
	const commandExtras = {
		commitments: new ReminderCommands({ db }),
		plans,
		sentReport: () => sentReport(db),
		energyReport: () => adenosine.report(),
		opportunities: () => investigations.report(),
		domains: {
			report: () => observer.report(),
			set: (name: string, on: boolean) => observer.setEnabled(name, on),
		},
		focus: {
			report: async () => {
				const name = models.selected("background");
				const status = await models.status();
				return focusReport({
					db,
					worker: background,
					deviceHolder: device.holder,
					queuedReplies: (
						db.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'queued'").get() as { n: number }
					).n,
					backgroundModel: {
						name,
						loaded: status.models.some((m) => m.name === name && m.status === "loaded"),
					},
					quietS: config.backgroundQuietS,
					gapS: config.backgroundGapS,
				});
			},
			pause: (by: string) => background.pauseInitiative(by),
			resume: () => background.resumeInitiative(),
		},
		rhythm,
		memoryControl,
		toolsReport: () => toolsReport(db, tools.toolkits),
		decisionsReport: (args: string[] = [], issuer = "owner") => {
			if (args[0] === "label")
				return labelDecision(db, args[1] ?? "", args[2] ?? "", issuer, new Date().toISOString());
			if (args[0]) return roleReport(db, args[0]);
			return decisionsReport(db, decisions.status, selectionShadow.pending, replyReview.pending);
		},
		rhythmReport: {
			day: () => rhythm.describeDay(stmCount("'day'"), stmCount("'backlog'")),
			night: () =>
				rhythm.describeNight({
					deviceHolder: device.holder,
					stmWaiting: stmCount("'day', 'backlog'"),
					problem: memoryGate.problem,
				}),
		},
		memoryReport: () =>
			memoryReport(db, {
				mode: rhythm.mode(),
				day: rhythm.day(),
				lastNight: rhythm.lastNight(),
				ltm: `${memory.status.state}: ${memory.status.detail}`,
				problem: memoryGate.problem,
			}),
	};
	const memoryStatus = () => {
		const base = `${rhythm.mode().replace("_", " ")}, day ${rhythm.day()} · energy ${Math.round(adenosine.level() * 100)}% · long-term ${memory.status.state}: ${memory.status.detail}`;
		return memoryGate.problem ? `${base} — ${memoryGate.problem}` : base;
	};
	// Local typed decisions (plan 0.003): Kev, shadow-only in this increment.
	const decisions = new DecisionService({
		installDir: config.decisions.installDir,
		stateDir: join(config.stateDir, "decisions"),
		port: config.decisions.port,
		model: config.decisions.model,
		enabled: config.decisions.enabled,
		log,
	});
	const decisionClient = new DecisionClient({ db, service: decisions, timeoutMs: config.decisions.timeoutMs });
	// Observation domains (plan 0.007 S4): Iyye's own workspace repository, created once by the host.
	try {
		ensureWorkspace(config.workspaceDir, log);
	} catch (err) {
		log.warn("workspace: could not be created", { dir: config.workspaceDir, error: (err as Error).message });
	}
	// Opportunities and investigations (plan 0.007 S5): findings that raise a question, looked into within bounds.
	const investigations = new Investigations({
		db,
		worker: background,
		energy: adenosine,
		mode: () => rhythm.mode(),
		initiative: new InitiativeShadow({ client: decisionClient, device }),
		log,
		sweepMs: config.sweepS * 1000,
	});
	const observer = new Observer({
		db,
		domains: [
			machineDomain({
				memoryGb: systemMemoryProbe,
				loadedModels: async () =>
					(await models.status()).models.filter((m) => m.status === "loaded").map((m) => m.name),
				services: () => ({
					"the model router": models.state,
					"long-term memory": config.memory.enabled ? memory.status.state : "disabled",
					"the decision service": decisions.status.state,
					"web search": searxng.status.state,
					Telegram: poller ? poller.status.state : "disabled",
				}),
			}),
			gitDomain("workspace", config.workspaceDir, "Iyye's own workspace repository", 12 * 3_600_000),
			...(config.projectRepo
				? [gitDomain("project", config.projectRepo, `the repository ${config.projectRepo}`, 6 * 3_600_000)]
				: []),
		],
		defaultEnabled: ["machine", "workspace"],
		importance: new ObservationImportance({ client: decisionClient, device }),
		notifyOwner: (key, text) => outbox.notifyOwner({ key, content: text }),
		mode: () => rhythm.mode(),
		log,
		findingsPerDay: config.findingsPerDay,
		quietMs: config.backgroundQuietS * 1000,
	});
	const selector = new ToolkitSelector({ db, client: decisionClient, log });
	// Toolkit selection in shadow (plan 0.004 T4): asked after each turn, when the device is free.
	const selectionShadow = new ToolkitSelectionShadow({
		db,
		client: decisionClient,
		device,
		chatPending: () => scheduler.hasRunnableJobs(),
		log,
	});
	// Plan 0.003 K3, both shadow: memory salience inside the night loop; reply review after delivery, when idle.
	const memorySalience = new MemorySalience({ db, client: decisionClient, device, log });
	const replyReview = new ReplyReviewShadow({
		db,
		client: decisionClient,
		device,
		chatPending: () => scheduler.hasRunnableJobs(),
		ready: () => decisions.checkpoint !== null,
		log,
	});
	const owner = ensureOwnerToken(config.stateDir);
	const web = new WebServer({
		port: config.webPort,
		log,
		ownerToken: owner.token,
		sessions: new WebSessions(db),
		admission,
		models,
		outbox,
		scheduler,
		memoryStatus,
		decisionsStatus: () => `${decisions.status.state}: ${decisions.status.detail}`,
		remindersStatus: () => remindersChip(remindersToday(db, new Date())),
		webStatus: () => `${searxng.status.state}: ${searxng.status.detail}`,
		commandExtras,
		telegramStatus: () =>
			poller ? `${poller.status.state}: ${poller.status.detail}` : "disabled (no TELEGRAM_BOT_TOKEN)",
	});

	// Router and health timers are unref'd; this keeps the resident process alive until a signal.
	const keepAlive = setInterval(() => {}, 1 << 30);
	let shuttingDown = false;
	const done = new Promise<number>((resolve) => {
		const shutdown = async (signal: string) => {
			if (shuttingDown) {
				log.warn(`second ${signal}: exiting without cleanup`);
				process.exit(1);
			}
			shuttingDown = true;
			log.info(`${signal}: stopping`);
			clearInterval(keepAlive);
			try {
				await web.stop();
				await poller?.stop();
				await rhythm.stop();
				await scheduler.stop();
				await outbox.stop();
				await memory.stop();
				await selectionShadow.stop();
				await replyReview.stop();
				await background.stop();
				adenosine.stop();
				await observer.stop();
				await investigations.stop();
				await commitmentClock.stop();
				await plans.stop();
				await decisions.stop();
				await searxng.stop();
				await passthrough.stop();
				await conversations.disposeAll();
				await backgroundConversations.disposeAll();
				await models.stop();
			} catch (err) {
				log.error("stopping models failed", { error: (err as Error).message });
			}
			db.close();
			releaseHostLock(config.stateDir);
			log.info("iyye host stopped");
			resolve(0);
		};
		process.on("SIGINT", () => void shutdown("SIGINT"));
		process.on("SIGTERM", () => void shutdown("SIGTERM"));
	});

	log.info("iyye host starting", { stateDir: config.stateDir, routerPort: config.routerPort });
	// Settle anything a crash left half-done before new work is admitted (HLD §13).
	await recover(db, outbox, scheduler, log);
	outbox.start();
	await web.start();
	process.stderr.write(
		owner.created || process.stderr.isTTY
			? `\nOwner web chat: ${web.loginUrl}\n\n`
			: `\nOwner web chat: http://127.0.0.1:${config.webPort}/ (token in ${join(config.stateDir, "owner_token")})\n\n`,
	);
	scheduler.start();
	rhythm.start();
	poller?.start();
	if (config.memory.enabled) await passthrough.start(); // before Hindsight, which calls it
	memory.start(); // in the background: chat works while memory comes up
	if (ltm) {
		// Once long-term memory is up: finish queued /forget deletions and drop any stored model traces.
		const settle = setInterval(() => {
			if (memory.status.state !== "up") return;
			clearInterval(settle);
			void memoryControl
				.resumeDeletions()
				.then(() => memory.purgeTraces())
				.catch((err) => log.warn("memory: startup cleanup failed", { error: (err as Error).message }));
		}, 5000);
		settle.unref();
	}
	decisions.start(); // in the background too
	selectionShadow.start();
	replyReview.start();
	background.start();
	observer.start();
	investigations.start();
	commitmentClock.start();
	plans.start();
	adenosine.start();
	searxng.start();
	await models.start();
	log.info("iyye host ready", { router: models.state, web: `http://127.0.0.1:${config.webPort}/` });

	if (process.stdin.isTTY) startOwnerConsole(models, conversations, db, device, commandExtras, log);
	return done;
}

/**
 * Temporary owner console on the host's own terminal. Whoever holds the
 * terminal that started the host is the owner. It goes away once the
 * authenticated web chat (M4) and the scheduler (M7) carry the same work.
 *
 * Chat here uses its own scope ("owner-console") so development turns never
 * mix into the owner's real web-chat conversation, and it bypasses admission
 * and the outbox: replies are printed, not delivered anywhere.
 */
function startOwnerConsole(
	models: ModelManager,
	conversations: PiConversations,
	db: Db,
	device: DeviceSlot,
	commandExtras: CommandExtras,
	log: Logger,
): void {
	const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "iyye> " });
	let current: AbortController | null = null;
	models.onRouterLost(() => current?.abort());
	rl.prompt();
	rl.on("line", async (line) => {
		const text = line.trim();
		rl.pause();
		try {
			if (!text) {
				// nothing
			} else if (isCommand(text)) {
				const r = await handleOwnerCommand(text, { models, db, issuer: "owner_terminal", ...commandExtras });
				process.stdout.write(`${r.reply}\n`);
			} else {
				const model = models.selected("web");
				const lease = model ? await models.acquire(model) : { ok: false, message: "no model selected for web" };
				if (!("release" in lease)) {
					process.stdout.write(`(no reply: ${lease.message})\n`);
				} else {
					current = new AbortController();
					commandExtras.rhythm?.noteOwnerActivity();
					const releaseDevice = await device.acquire("console");
					try {
						const r = await conversations.turn({
							scope: "owner-console",
							view: { kind: "owner", channel: "console" },
							model: lease.model,
							text,
							signal: current.signal,
						});
						process.stdout.write(r.ok ? `${r.text}\n` : `(no reply: ${r.reason}: ${r.message})\n`);
					} finally {
						current = null;
						lease.release();
						releaseDevice();
					}
				}
			}
		} catch (err) {
			log.error("console input failed", { error: (err as Error).message });
		}
		rl.resume();
		rl.prompt();
	});
	rl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
}

/** One host per state directory: two would fight over the router and the database. */
function acquireHostLock(stateDir: string, log: Logger): boolean {
	const lock = join(stateDir, "host.lock");
	try {
		writeFileSync(lock, String(process.pid), { flag: "wx" });
		return true;
	} catch {
		const pid = Number(readFileSync(lock, "utf8"));
		// pid <= 1 (e.g. an empty lock file) is stale: kill(0, 0) would "succeed" for our own group.
		if (Number.isInteger(pid) && pid > 1 && pid !== process.pid && pidAlive(pid)) {
			log.error(`another Iyye host (pid ${pid}) is using ${stateDir}`);
			return false;
		}
		writeFileSync(lock, String(process.pid));
		return true;
	}
}

function releaseHostLock(stateDir: string): void {
	rmSync(join(stateDir, "host.lock"), { force: true });
}

main().then(
	(code) => process.exit(code),
	(err) => {
		process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
		process.exit(1);
	},
);
