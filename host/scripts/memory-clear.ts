// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Debugging: delete Iyye's long-term memory in Hindsight (every bank, or one),
 * with all its documents, facts, observations and entities. Talks to the
 * running Hindsight of the host's state directory (IYYE2_STATE_DIR, default
 * ~/.iyye2). It cannot be undone.
 *
 *   node scripts/memory-clear.ts [--bank <bank id>] [--restage] [--yes]
 *
 *   --bank      only this bank (e.g. iyye-owner, iyye-contact-<id>)
 *   --restage   also queue every conversation already moved to long-term
 *               memory in the transfer backlog, so the next night (/sleep)
 *               transfers it again
 *   --yes       do not ask for confirmation
 *
 * Refuses while Iyye is asleep or winding down: /wake first. Short-term
 * memory is left alone unless --restage is given.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.ts";
import { HindsightClient } from "../src/memory/hindsight.ts";
import { restageEpisodes } from "../src/state/stm.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const bankArg = args.includes("--bank") ? args[args.indexOf("--bank") + 1] : undefined;
const known = new Set(["--bank", "--restage", "--yes", bankArg]);
const unknown = args.filter((a) => !known.has(a));
if (unknown.length > 0 || (args.includes("--bank") && !bankArg)) {
	console.error("usage: node scripts/memory-clear.ts [--bank <bank id>] [--restage] [--yes]");
	process.exit(2);
}

const config = loadConfig();
const keyFile = join(config.stateDir, "memory", "secrets", "hindsight_api_key");
const dbFile = join(config.stateDir, "iyye.db");
if (!existsSync(keyFile) || !existsSync(dbFile)) {
	console.error(`no Iyye memory in ${config.stateDir} (missing ${existsSync(dbFile) ? keyFile : dbFile})`);
	process.exit(1);
}

const db = new Database(dbFile);
db.pragma("busy_timeout = 5000");
const mode = (db.prepare("SELECT value FROM kv WHERE key = 'rhythm.mode'").get() as { value: string } | undefined)
	?.value;
if (mode && mode !== "awake") {
	console.error(`Iyye is ${mode.replace("_", " ")}: the night is using long-term memory. Send /wake first.`);
	process.exit(1);
}

const ltm = new HindsightClient({
	baseUrl: `http://127.0.0.1:${config.memory.hindsightPort}`,
	apiKey: () => readFileSync(keyFile, "utf8").trim(),
});
let banks: string[];
try {
	banks = await ltm.listBanks();
} catch (err) {
	console.error(`Hindsight on 127.0.0.1:${config.memory.hindsightPort} is not reachable: ${(err as Error).message}`);
	console.error("Start the host (it supervises Hindsight) and try again.");
	process.exit(1);
}
if (bankArg) {
	if (!banks.includes(bankArg)) {
		console.error(`no bank ${bankArg}; banks: ${banks.join(", ") || "none"}`);
		process.exit(1);
	}
	banks = [bankArg];
}

/** The scopes whose memory is deleted: --restage puts only their conversations back. */
const scopeOf = (bank: string) =>
	bank === "iyye-owner"
		? "owner"
		: bank.startsWith("iyye-contact-")
			? `contact:${bank.slice("iyye-contact-".length)}`
			: null;
const scopes = bankArg ? banks.map(scopeOf).filter((s): s is string => s !== null) : undefined;
const restageable = (
	db.prepare("SELECT scope FROM stm_episodes WHERE state NOT IN ('day', 'backlog')").all() as { scope: string }[]
).filter((r) => !scopes || scopes.includes(r.scope)).length;
if (banks.length === 0) console.log("long-term memory is already empty");
for (const bank of banks) {
	const s = await ltm.bankStats(bank);
	const types = Object.entries(s.byType)
		.map(([t, n]) => `${n} ${t}`)
		.join(", ");
	console.log(`  ${bank}: ${s.documents} document(s), ${s.memories} memories${types ? ` (${types})` : ""}`);
}
if (flag("--restage")) console.log(`  and queue ${restageable} conversation(s) in the transfer backlog`);
if (banks.length === 0 && !(flag("--restage") && restageable > 0)) process.exit(0);

if (!flag("--yes")) {
	if (!process.stdin.isTTY) {
		console.error("not a terminal: pass --yes to confirm");
		process.exit(2);
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await rl.question(`This cannot be undone. Type "clear" to delete ${banks.length} bank(s): `);
	rl.close();
	if (answer.trim() !== "clear") {
		console.log("nothing deleted");
		process.exit(1);
	}
}

for (const bank of banks) {
	await ltm.deleteBank(bank);
	console.log(`deleted ${bank}`);
}
// Deleted banks owe no consolidation (the night would also drop them on its own).
const pending = db.prepare("SELECT value FROM kv WHERE key = 'memory.banks_to_consolidate'").get() as
	| { value: string }
	| undefined;
if (pending) {
	const left = (JSON.parse(pending.value) as string[]).filter((b) => !banks.includes(b));
	db.prepare("UPDATE kv SET value = ? WHERE key = 'memory.banks_to_consolidate'").run(JSON.stringify(left));
}
if (flag("--restage")) {
	console.log(`${restageEpisodes(db, scopes)} conversation(s) are queued in the transfer backlog; /sleep stores them`);
}
db.close();
