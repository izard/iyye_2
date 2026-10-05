// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PROJECT_ROOT } from "../src/config.ts";
import { renderPreset } from "../src/models/preset.ts";
import { loadRegistry, parseRegistry, RegistryError, shardsExist } from "../src/models/registry.ts";

test("the shipped config/models.json is valid and seeded from the 1.x registry", () => {
	const reg = loadRegistry(resolve(PROJECT_ROOT, "config/models.json"));
	const names = reg.models.map((m) => m.name);
	assert.ok(names.includes("gemma-4-26B"));
	assert.ok(names.includes("gemma-4-E4B"));
	assert.ok(!names.some((n) => n.includes("vision")), "vision is out of scope for 0.001");
	assert.deepEqual(reg.defaults, { c: 65536, np: 1, timeout: 86400, "repeat-penalty": 1.2 });
	assert.deepEqual(reg.models.find((m) => m.name === "gemma-4-26B")!.serverArgs, { reasoning: "off" });
	assert.deepEqual(reg.models.find((m) => m.name === "gpt-oss-120b")!.serverArgs, { c: 32768 });
});

const base = (models: unknown[], extra: Record<string, unknown> = {}) => ({ models_dir: "/m", models, ...extra });
const model = (o: Record<string, unknown> = {}) => ({
	name: "a",
	file: "a.gguf",
	ram_required_gb: 1,
	startup_s: 1,
	...o,
});

test("unknown keys, duplicates and host-managed options are rejected", () => {
	assert.throws(() => parseRegistry(base([model({ port: 8080 })]), "/"), /unknown key "port"/);
	assert.throws(() => parseRegistry(base([model(), model()]), "/"), /duplicate model name/);
	assert.throws(() => parseRegistry(base([model({ server_args: { "models-max": 4 } })]), "/"), /managed by the host/);
	assert.throws(() => parseRegistry(base([model({ server_args: { port: 1 } })]), "/"), /managed by the host/);
	assert.throws(() => parseRegistry(base([model({ server_args: { x: "a\nb" } })]), "/"), /single line/);
	assert.throws(() => parseRegistry(base([model({ server_args: { "Bad Key": 1 } })]), "/"), /invalid option name/);
	assert.throws(() => parseRegistry(base([model({ name: "a b" })]), "/"), /invalid characters/);
	assert.throws(() => parseRegistry(base([model({ ram_required_gb: -1 })]), "/"), RegistryError);
});

test("a missing GGUF marks the model unavailable instead of failing", () => {
	const reg = parseRegistry(base([model({ file: "/definitely/not/here.gguf" })]), "/");
	assert.equal(reg.models[0]!.available, false);
});

test("split models need every shard", () => {
	const dir = mkdtempSync(join(tmpdir(), "iyye-shards-"));
	try {
		const first = join(dir, "m-00001-of-00002.gguf");
		writeFileSync(first, "");
		assert.equal(shardsExist(first), false);
		writeFileSync(join(dir, "m-00002-of-00002.gguf"), "");
		assert.equal(shardsExist(first), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the preset INI matches the golden file and leaves out unavailable models", () => {
	const dir = mkdtempSync(join(tmpdir(), "iyye-preset-"));
	try {
		writeFileSync(join(dir, "alpha.gguf"), "");
		const reg = parseRegistry(
			{
				models_dir: dir,
				defaults: { c: 65536, np: 4, "repeat-penalty": 1.2 },
				models: [
					model({ name: "alpha", file: "alpha.gguf", server_args: { reasoning: "off", jinja: true } }),
					model({ name: "absent", file: "absent.gguf" }),
				],
			},
			"/",
		);
		const golden = readFileSync(new URL("./fixtures/preset.golden.ini", import.meta.url), "utf8");
		assert.equal(renderPreset(reg), golden.replaceAll("$DIR", dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
