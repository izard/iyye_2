// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("config reads the existing Telegram bot token (1.x is retired; HLD §16)", () => {
	assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc" }).telegramBotToken, "123:abc");
	assert.equal(loadConfig({}).telegramBotToken, null);
});

test("the web chat listens on loopback unless IYYE2_WEB_LISTEN names an address (owner decision 2026-10-09)", () => {
	assert.equal(loadConfig({}).webListen, "127.0.0.1");
	assert.equal(loadConfig({ IYYE2_WEB_LISTEN: "0.0.0.0" }).webListen, "0.0.0.0");
	assert.equal(loadConfig({ IYYE2_WEB_LISTEN: "192.168.1.123" }).webListen, "192.168.1.123");
	assert.throws(() => loadConfig({ IYYE2_WEB_LISTEN: "spark.local" }), /must be an IP address/);
});

test("llama.cpp loads without mmap on Linux (shared CPU/GPU memory, owner 2026-10-09); macOS keeps its default", () => {
	assert.equal(loadConfig({}).llamaLoadMode, process.platform === "linux" ? "none" : null);
	assert.equal(loadConfig({ IYYE2_LLAMA_LOAD_MODE: "mmap" }).llamaLoadMode, "mmap");
	assert.throws(() => loadConfig({ IYYE2_LLAMA_LOAD_MODE: "fast" }), /must be auto, none, mmap or mlock/);
});
