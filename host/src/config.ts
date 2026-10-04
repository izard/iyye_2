// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWindow, type RestWindow } from "./kernel/rhythm.ts";

/** iyye_2/ — the project root holding config/ and the host package. */
export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface Config {
	stateDir: string;
	webPort: number;
	/** Router launch command; tests replace it with a fake router. */
	llamaServer: string;
	llamaServerArgsPrefix: string[];
	routerPort: number;
	modelsRegistry: string;
	/** Owner-written identity, the base of every system prompt (HLD §4.1). */
	identityFile: string;
	/** Most models the host keeps loaded at once (enforced by the host, not the router). */
	modelsMax: number;
	/** Background work (plan 0.007 S1): its model, loaded by day like the chat models. */
	backgroundModel: string;
	/** No background step starts this soon after chat activity, and steps are spaced this far apart. */
	backgroundQuietS: number;
	backgroundGapS: number;
	/** Adenosine (plan 0.007 S2): time drain per awake hour, the background reserve, the wind-down level, a tired nap's minimum. */
	adenosine: { perHour: number; reserve: number; windDown: number; minRestMin: number };
	/** Plan 0.007 S4: Iyye's own repository, an optional repository to observe, the daily cap on finding messages. */
	workspaceDir: string;
	projectRepo: string | null;
	findingsPerDay: number;
	/** Plan 0.007 S5: how often the opportunity sweep runs. */
	sweepS: number;
	/** Plan 0.006 C1: the commitment clock, lateness notes and limits. Times are in the system's timezone. */
	commitments: { tickMs: number; lateH: number; maxLateD: number; contactMax: number; contactPlansMax: number };
	/** Messages Iyye sends to people per day (plan 0.008): in all, per trusted contact, on Iyye's own. */
	send: { dailyMax: number; contactDailyMax: number; iyyeDailyMax: number };
	defaultModel: string;
	/** Seconds between router health checks. */
	healthIntervalS: number;
	telegramBotToken: string | null;
	telegramAllowedUserIds: Set<number>;
	memory: {
		enabled: boolean;
		/** `iyye_2/memory`: the Hindsight venv and the PostgreSQL install. */
		installDir: string;
		hindsightPort: number;
		dbPort: number;
		passthroughPort: number;
		/** The model Hindsight's extraction and consolidation run on until `/use <model> memory` changes it. */
		defaultModel: string;
		/** Local rest window, e.g. "02:00-06:00": the night moves STM into LTM (plan 0.002 §3.4). */
		sleepWindow: RestWindow;
		/** The memory model's reasoning during night extraction. */
		thinking: boolean;
		embeddingsModel: string;
		rerankerModel: string;
		textSearchLanguage: string;
	};
	/** The web toolkit (plan 0.004): read-only, for everyone, self-contained. */
	web: {
		enabled: boolean;
		/** Successful web calls per local day: the owner's scope, each contact's. */
		dailyCalls: { owner: number; contact: number };
		/** `iyye_2/web`: `searxng/` (the pinned source tree) and `.venv/`. */
		searxngDir: string;
		searxngPort: number;
		/** Engines that worked from this machine (plan 0.004 T0). */
		searxngEngines: string[];
		wikipediaLangs: string[];
	};
	/** Local typed decisions (plan 0.003): the Kev server. */
	decisions: {
		enabled: boolean;
		/** `iyye_2/kev`: the Kev checkout with its `.venv`. */
		installDir: string;
		port: number;
		/** Hub id pinned to a revision (`repo@sha`); provisioned once by `scripts/provision-decisions.ts`. */
		model: string;
		/** Per call; past it the call is journaled as an error (shadow calls are never retried). */
		timeoutMs: number;
		/** Toolkit selection (plan 0.004 §3.4): `act` chooses toolkits before each turn; `shadow` only compares after it. */
		toolkitSelection: "act" | "shadow";
	};
}

export class ConfigError extends Error {}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, values: readonly T[], fallback: T): T {
	const v = env[name];
	if (v === undefined || v === "") return fallback;
	if (!(values as readonly string[]).includes(v)) throw new ConfigError(`${name} must be one of ${values.join(", ")}`);
	return v as T;
}

function list(spec: string, item: RegExp, name: string): string[] {
	const items = spec
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const bad = items.find((s) => !item.test(s));
	if (items.length === 0 || bad !== undefined)
		throw new ConfigError(`${name}: invalid item ${JSON.stringify(bad ?? spec)}`);
	return items;
}

function dailyCalls(spec: string): { owner: number; contact: number } {
	const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(spec);
	if (!m)
		throw new ConfigError(`IYYE2_WEB_DAILY_CALLS must look like 200,50 (owner,contact), got ${JSON.stringify(spec)}`);
	return { owner: Number(m[1]), contact: Number(m[2]) };
}

function window(spec: string): RestWindow {
	try {
		return parseWindow(spec);
	} catch (err) {
		throw new ConfigError(`IYYE2_SLEEP_WINDOW: ${(err as Error).message}`);
	}
}

export function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

function absPath(p: string, base: string): string {
	const e = expandHome(p);
	return isAbsolute(e) ? e : resolve(base, e);
}

/** A number in [0, 1]. */
function fraction(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return dflt;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0 || n > 1) {
		throw new ConfigError(`${name} must be a number in [0, 1], got ${JSON.stringify(raw)}`);
	}
	return n;
}

function int(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return dflt;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new ConfigError(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
	}
	return n;
}

/** Read configuration from the environment (plan §6). Throws ConfigError on invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const cwd = process.cwd();
	// The existing bot: 1.x is retired, so 2.0 is its only poller (HLD §16).
	const telegramBotToken = env.TELEGRAM_BOT_TOKEN || null;
	const allowed = new Set<number>();
	// The 1.x allowlist (chat ids, equal to user ids in private chats) is honoured when the 2.0 one is unset.
	for (const part of (env.IYYE2_TELEGRAM_ALLOWED_USER_IDS || env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(",")) {
		const s = part.trim();
		if (!s) continue;
		const n = Number(s);
		if (!Number.isSafeInteger(n)) throw new ConfigError(`invalid Telegram user id ${JSON.stringify(s)}`);
		allowed.add(n);
	}
	const webPort = int(env, "IYYE2_WEB_PORT", 5100, 1, 65535);
	const routerPort = int(env, "IYYE2_ROUTER_PORT", 8180, 1, 65535);
	if (webPort === routerPort) throw new ConfigError("IYYE2_WEB_PORT and IYYE2_ROUTER_PORT must differ");
	return {
		stateDir: absPath(env.IYYE2_STATE_DIR || "~/.iyye2", cwd),
		webPort,
		llamaServer: absPath(env.IYYE2_LLAMA_SERVER || "~/Downloads/llama.cpp/build_27/bin/llama-server", cwd),
		llamaServerArgsPrefix: [],
		routerPort,
		modelsRegistry: absPath(env.IYYE2_MODELS_REGISTRY || resolve(PROJECT_ROOT, "config/models.json"), cwd),
		identityFile: absPath(env.IYYE2_IDENTITY || resolve(PROJECT_ROOT, "config/identity.md"), cwd),
		modelsMax: int(env, "IYYE2_MODELS_MAX", 2, 1, 16),
		backgroundModel: env.IYYE2_BACKGROUND_MODEL || "gemma-4-E4B",
		backgroundQuietS: int(env, "IYYE2_BACKGROUND_QUIET_S", 180, 0, 86_400),
		backgroundGapS: int(env, "IYYE2_BACKGROUND_GAP_S", 30, 0, 86_400),
		workspaceDir: absPath(
			env.IYYE2_WORKSPACE || resolve(absPath(env.IYYE2_STATE_DIR || "~/.iyye2", cwd), "workspace"),
			cwd,
		),
		projectRepo: env.IYYE2_PROJECT_REPO ? absPath(env.IYYE2_PROJECT_REPO, cwd) : null,
		findingsPerDay: int(env, "IYYE2_FINDINGS_PER_DAY", 5, 0, 100),
		sweepS: int(env, "IYYE2_SWEEP_S", 1800, 10, 86_400),
		commitments: {
			tickMs: int(env, "IYYE2_COMMITMENT_TICK_MS", 15_000, 1000, 3_600_000),
			lateH: int(env, "IYYE2_REMINDER_LATE_H", 6, 1, 168),
			maxLateD: int(env, "IYYE2_REMINDER_MAX_LATE_D", 7, 1, 365),
			contactMax: int(env, "IYYE2_CONTACT_REMINDERS_MAX", 20, 0, 1000),
			contactPlansMax: int(env, "IYYE2_CONTACT_PLANS_MAX", 5, 0, 100),
		},
		send: {
			dailyMax: int(env, "IYYE2_SEND_DAILY_MAX", 20, 0, 1000),
			contactDailyMax: int(env, "IYYE2_SEND_CONTACT_DAILY_MAX", 10, 0, 1000),
			iyyeDailyMax: int(env, "IYYE2_SEND_IYYE_DAILY_MAX", 5, 0, 1000),
		},
		adenosine: {
			perHour: fraction(env, "IYYE2_ADENOSINE_PER_HOUR", 0.02),
			reserve: fraction(env, "IYYE2_ADENOSINE_RESERVE", 0.35),
			windDown: fraction(env, "IYYE2_ADENOSINE_WIND_DOWN", 0.15),
			minRestMin: int(env, "IYYE2_TIRED_MIN_REST_MIN", 60, 0, 1440),
		},
		defaultModel: env.IYYE2_DEFAULT_MODEL || "gemma-4-26B",
		healthIntervalS: int(env, "IYYE2_HEALTH_INTERVAL_S", 30, 1, 3600),
		telegramBotToken,
		telegramAllowedUserIds: allowed,
		memory: {
			enabled: env.IYYE2_MEMORY_ENABLED !== "0",
			installDir: absPath(env.IYYE2_MEMORY_DIR || resolve(PROJECT_ROOT, "memory"), cwd),
			hindsightPort: int(env, "IYYE2_MEMORY_PORT", 8186, 1, 65535),
			dbPort: int(env, "IYYE2_MEMORY_DB_PORT", 8185, 1, 65535),
			passthroughPort: int(env, "IYYE2_MEMORY_PASSTHROUGH_PORT", 8187, 1, 65535),
			defaultModel: env.IYYE2_MEMORY_MODEL || "gemma-4-E4B",
			sleepWindow: window(env.IYYE2_SLEEP_WINDOW || "02:00-06:00"),
			thinking: env.IYYE2_MEMORY_THINKING !== "0",
			embeddingsModel: env.IYYE2_MEMORY_EMBEDDINGS_MODEL || "BAAI/bge-small-en-v1.5",
			rerankerModel: env.IYYE2_MEMORY_RERANKER_MODEL || "cross-encoder/ms-marco-MiniLM-L-6-v2",
			textSearchLanguage: env.IYYE2_MEMORY_TEXT_LANGUAGE || "english",
		},
		web: {
			enabled: env.IYYE2_WEB_ENABLED !== "0",
			dailyCalls: dailyCalls(env.IYYE2_WEB_DAILY_CALLS || "200,50"),
			searxngDir: absPath(env.IYYE2_SEARXNG_DIR || resolve(PROJECT_ROOT, "web"), cwd),
			searxngPort: int(env, "IYYE2_SEARXNG_PORT", 8184, 1, 65535),
			searxngEngines: list(
				env.IYYE2_SEARXNG_ENGINES || "yandex,yahoo,yep,fireball,bing",
				/^[a-z0-9 _.-]+$/i,
				"IYYE2_SEARXNG_ENGINES",
			),
			wikipediaLangs: list(env.IYYE2_WIKIPEDIA_LANGS || "en,ru", /^[a-z]{2,3}(-[a-z]+)?$/, "IYYE2_WIKIPEDIA_LANGS"),
		},
		decisions: {
			enabled: env.IYYE2_DECISIONS_ENABLED !== "0",
			installDir: absPath(env.IYYE2_DECISIONS_DIR || resolve(PROJECT_ROOT, "kev"), cwd),
			port: int(env, "IYYE2_DECISIONS_PORT", 8188, 1, 65535),
			model: env.IYYE2_DECISIONS_MODEL || "jaredpalmer/kev-4b@6cfce5c2fa4b4bd64026336ab649c5ca78857d52",
			timeoutMs: int(env, "IYYE2_DECISIONS_TIMEOUT_MS", 5000, 100, 600_000),
			toolkitSelection: oneOf(env, "IYYE2_TOOLKIT_SELECTION", ["act", "shadow"], "act"),
		},
	};
}
