// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The Iyye model registry (`config/models.json`, plan M2): which local GGUF
 * models exist, what they cost to load, and the llama-server options each one
 * runs with. Seeded from the 1.x `llm-registry.json` and `llm-*.sh` scripts.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { expandHome } from "../config.ts";

export type ServerArgValue = string | number | boolean;
export type ServerArgs = Record<string, ServerArgValue>;

export interface ModelSpec {
	name: string;
	/** Absolute path of the GGUF file (the first shard for split models). */
	path: string;
	ramRequiredGb: number;
	startupS: number;
	roles: string[];
	description: string;
	serverArgs: ServerArgs;
	/**
	 * Whether the model may reason ("think") before answering. Sent explicitly
	 * on every request (`chat_template_kwargs.enable_thinking`), because some
	 * templates think by default. Default "off".
	 */
	thinking: "off" | "on";
	/** False when the GGUF (or any of its shards) is missing; such a model is listed but cannot load. */
	available: boolean;
}

export interface Registry {
	modelsDir: string;
	defaults: ServerArgs;
	models: ModelSpec[];
}

export class RegistryError extends Error {}

function thinking(v: unknown, where: string): "off" | "on" {
	if (v === undefined) return "off";
	if (v === "off" || v === "on") return v;
	throw new RegistryError(`${where} must be "off" or "on"`);
}

const MODEL_KEYS = new Set([
	"name",
	"file",
	"ram_required_gb",
	"startup_s",
	"roles",
	"description",
	"server_args",
	"thinking",
]);
const TOP_KEYS = new Set(["models_dir", "defaults", "models"]);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Option names as llama-server accepts them in a preset: lowercase words joined by dashes. */
const ARG_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/**
 * Options the host owns. The router sets host/port/alias itself, `model` comes
 * from `file`, and model-count/autoload/sleep policy must stay with the host.
 */
const RESERVED_ARGS = new Set([
	"model",
	"m",
	"host",
	"port",
	"alias",
	"api-key",
	"hf-repo",
	"hf",
	"models-dir",
	"models-preset",
	"models-max",
	"models-autoload",
	"no-models-autoload",
	"sleep-idle-seconds",
	"load-on-startup",
]);

export function loadRegistry(path: string): Registry {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new RegistryError(`cannot read model registry ${path}: ${(err as Error).message}`);
	}
	return parseRegistry(raw, dirname(path));
}

export function parseRegistry(raw: unknown, baseDir: string): Registry {
	const top = obj(raw, "registry");
	unknownKeys(top, TOP_KEYS, "registry");
	const modelsDirRaw = str(top.models_dir, "models_dir");
	const modelsDir = isAbsolute(expandHome(modelsDirRaw)) ? expandHome(modelsDirRaw) : resolve(baseDir, modelsDirRaw);
	const defaults = serverArgs(top.defaults ?? {}, "defaults");
	if (!Array.isArray(top.models)) throw new RegistryError("models must be an array");
	const seen = new Set<string>();
	const models = top.models.map((m, i): ModelSpec => {
		const where = `models[${i}]`;
		const o = obj(m, where);
		unknownKeys(o, MODEL_KEYS, where);
		const name = str(o.name, `${where}.name`);
		if (!NAME_RE.test(name)) throw new RegistryError(`${where}.name ${JSON.stringify(name)} has invalid characters`);
		if (seen.has(name)) throw new RegistryError(`duplicate model name ${JSON.stringify(name)}`);
		seen.add(name);
		const file = str(o.file, `${where}.file`);
		const path = isAbsolute(expandHome(file)) ? expandHome(file) : resolve(modelsDir, file);
		const roles = o.roles ?? [];
		if (!Array.isArray(roles) || !roles.every((r) => typeof r === "string")) {
			throw new RegistryError(`${where}.roles must be an array of strings`);
		}
		return {
			name,
			path,
			ramRequiredGb: num(o.ram_required_gb, `${where}.ram_required_gb`),
			startupS: num(o.startup_s, `${where}.startup_s`),
			roles,
			description: o.description === undefined ? "" : str(o.description, `${where}.description`),
			serverArgs: serverArgs(o.server_args ?? {}, `${where}.server_args`),
			thinking: thinking(o.thinking, `${where}.thinking`),
			available: shardsExist(path),
		};
	});
	return { modelsDir, defaults, models };
}

/** For `x-00001-of-00003.gguf`, every shard must exist; otherwise just the file. */
export function shardsExist(path: string): boolean {
	const m = /^(.*)-00001-of-(\d{5})\.gguf$/.exec(path);
	if (!m) return existsSync(path);
	const total = Number(m[2]);
	for (let i = 1; i <= total; i++) {
		if (!existsSync(`${m[1]}-${String(i).padStart(5, "0")}-of-${m[2]}.gguf`)) return false;
	}
	return true;
}

export function findModel(registry: Registry, name: string): ModelSpec | undefined {
	return registry.models.find((m) => m.name === name);
}

function serverArgs(v: unknown, where: string): ServerArgs {
	const o = obj(v, where);
	const out: ServerArgs = {};
	for (const [k, val] of Object.entries(o)) {
		if (!ARG_KEY_RE.test(k)) throw new RegistryError(`${where}: invalid option name ${JSON.stringify(k)}`);
		if (RESERVED_ARGS.has(k)) throw new RegistryError(`${where}: option ${JSON.stringify(k)} is managed by the host`);
		if (typeof val === "number") {
			if (!Number.isFinite(val)) throw new RegistryError(`${where}.${k} must be finite`);
		} else if (typeof val === "string") {
			if (/[\r\n]/.test(val)) throw new RegistryError(`${where}.${k} must be a single line`);
		} else if (typeof val !== "boolean") {
			throw new RegistryError(`${where}.${k} must be a string, number or boolean`);
		}
		out[k] = val;
	}
	return out;
}

function obj(v: unknown, where: string): Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw new RegistryError(`${where} must be an object`);
	return v as Record<string, unknown>;
}

function str(v: unknown, where: string): string {
	if (typeof v !== "string" || v === "") throw new RegistryError(`${where} must be a non-empty string`);
	return v;
}

function num(v: unknown, where: string): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
		throw new RegistryError(`${where} must be a non-negative number`);
	}
	return v;
}

function unknownKeys(o: Record<string, unknown>, allowed: Set<string>, where: string): void {
	for (const k of Object.keys(o)) {
		if (!allowed.has(k)) throw new RegistryError(`${where}: unknown key ${JSON.stringify(k)}`);
	}
}
