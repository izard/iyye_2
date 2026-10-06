// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Debugging: print every memory Iyye's long-term memory (Hindsight) holds,
 * bank by bank, newest first. Read-only, and no model call: it can run while
 * Iyye is awake or asleep. Talks to the running Hindsight of the host's state
 * directory (IYYE2_STATE_DIR, default ~/.iyye2).
 *
 *   node scripts/dump-ltm.ts [--bank <bank id>] [--type world|experience|observation] [--q <text>] [--limit <n>] [--json]
 *
 *   --bank   only this bank (e.g. iyye-owner, iyye-self, iyye-contact-<id>)
 *   --type   only this kind of memory: world (facts), experience, observation (consolidated)
 *   --q      only memories whose text matches (Hindsight's full-text search)
 *   --limit  at most this many memories per bank (default: all)
 *   --json   one JSON object per memory and line, with its bank, instead of text
 *
 * The output contains what people told Iyye: keep it out of logs and tickets.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { HindsightClient, type MemoryUnit } from "../src/memory/hindsight.ts";

const USAGE =
	"usage: node scripts/dump-ltm.ts [--bank <bank id>] [--type world|experience|observation] [--q <text>] [--limit <n>] [--json]";
const args = process.argv.slice(2);
const opts: { bank?: string; type?: string; q?: string; limit?: number; json: boolean } = { json: false };
for (let i = 0; i < args.length; i++) {
	const a = args[i]!;
	const value = () => {
		const v = args[++i];
		if (v === undefined) fail(USAGE);
		return v!;
	};
	if (a === "--bank") opts.bank = value();
	else if (a === "--type") {
		opts.type = value();
		if (!["world", "experience", "observation"].includes(opts.type)) fail(USAGE);
	} else if (a === "--q") opts.q = value();
	else if (a === "--limit") {
		opts.limit = Number(value());
		if (!Number.isInteger(opts.limit) || opts.limit < 1) fail(USAGE);
	} else if (a === "--json") opts.json = true;
	else fail(USAGE);
}

function fail(message: string, code = 2): never {
	console.error(message);
	process.exit(code);
}

const config = loadConfig();
const keyFile = join(config.stateDir, "memory", "secrets", "hindsight_api_key");
if (!existsSync(keyFile)) fail(`no Iyye long-term memory in ${config.stateDir} (missing ${keyFile})`, 1);
const ltm = new HindsightClient({
	baseUrl: `http://127.0.0.1:${config.memory.hindsightPort}`,
	apiKey: () => readFileSync(keyFile, "utf8").trim(),
});

let banks: string[];
try {
	banks = (await ltm.listBanks()).sort();
} catch (err) {
	fail(
		`Hindsight on 127.0.0.1:${config.memory.hindsightPort} is not reachable: ${(err as Error).message}\nStart the host (it supervises Hindsight) and try again.`,
		1,
	);
}
if (opts.bank) {
	if (!banks.includes(opts.bank)) fail(`no bank ${opts.bank}; banks: ${banks.join(", ") || "none"}`, 1);
	banks = [opts.bank];
}
if (banks.length === 0 && !opts.json) console.log("long-term memory is empty (no banks)");

const PAGE = 100;
let shown = 0;
for (const bank of banks) {
	const units: MemoryUnit[] = [];
	let total = 0;
	for (let offset = 0; ; offset += PAGE) {
		const page = await ltm.listMemories(bank, {
			...(opts.type ? { type: opts.type } : {}),
			...(opts.q ? { q: opts.q } : {}),
			limit: opts.limit ? Math.min(PAGE, opts.limit - units.length) : PAGE,
			offset,
		});
		total = page.total;
		units.push(...page.items);
		if (page.items.length < PAGE || units.length >= total || (opts.limit && units.length >= opts.limit)) break;
	}
	shown += units.length;
	if (opts.json) {
		for (const u of units) console.log(JSON.stringify({ bank, ...u }));
		continue;
	}
	console.log(
		`\n=== ${bank}: ${total} memor${total === 1 ? "y" : "ies"}${units.length < total ? ` (showing ${units.length})` : ""}`,
	);
	for (const u of units) console.log(render(u));
}
if (!opts.json) console.log(`\n${shown} memor${shown === 1 ? "y" : "ies"} in ${banks.length} bank(s)`);

function render(u: MemoryUnit): string {
	const when = (u.date ?? u.occurred_start ?? "").slice(0, 16).replace("T", " ") || "undated";
	const flags = [u.fact_type ?? "?", u.state && u.state !== "valid" ? u.state : ""].filter(Boolean).join(", ");
	const extra = [
		u.entities ? `entities: ${u.entities}` : "",
		u.tags?.length ? `tags: ${u.tags.join(", ")}` : "",
		u.context ? `context: ${oneLine(u.context, 100)}` : "",
	].filter(Boolean);
	return `- [${when}] (${flags}) ${oneLine(u.text, 1000)}${extra.length ? `\n    ${extra.join(" · ")}` : ""}`;
}

function oneLine(text: string, max: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}
