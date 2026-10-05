// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("config reads the existing Telegram bot token (1.x is retired; HLD §16)", () => {
	assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc" }).telegramBotToken, "123:abc");
	assert.equal(loadConfig({}).telegramBotToken, null);
});
