// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.017 N2: what a decision dataset cut now would hold. Read-only: the
 * database is opened read-only, nothing is frozen, no test set is created or
 * retired, and no look is recorded. Freezing is the training session's job
 * (N3), with the host stopped.
 *
 *   node scripts/decisions-dataset.ts [db] [--out <dir>] [--weak <source,…>]
 *
 * Prints the cut in counts: the splits, the owner's labels per role, question
 * and class, the test set's days, what was left out and why. No message text.
 *
 * `--out <dir>` also writes the training and validation examples as Kev's
 * labelled JSONL (`train.jsonl`, `validation.jsonl`; the directory 0700, the
 * files 0600): they hold what people said, so keep them on the Spark and
 * delete them afterwards. The test examples are never written here: they
 * leave the database only through `writeDataset`, which counts the look.
 *
 * `--weak` shows what a policy with weak labels would give (decision 2 is
 * "none"): `memory_salience.transfer`, `toolkit_selection.used`.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.ts";
import {
	datasetPolicy,
	datasetRecords,
	describeDataset,
	planDataset,
	type WeakSource,
} from "../src/decisions/dataset.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { out: { type: "string" }, weak: { type: "string" } },
});
const WEAK: readonly WeakSource[] = ["memory_salience.transfer", "toolkit_selection.used"];
const weak = (values.weak ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const unknown = weak.filter((w) => !WEAK.includes(w as WeakSource));
if (positionals.length > 1 || unknown.length) {
	console.error(
		`usage: node scripts/decisions-dataset.ts [db] [--out <dir>] [--weak <${WEAK.join(",")}>]${unknown.length ? ` (unknown weak source: ${unknown.join(", ")})` : ""}`,
	);
	process.exit(2);
}
const config = loadConfig();
const path = positionals[0] ?? join(config.stateDir, "iyye.db");
const db = new Database(path, { readonly: true, fileMustExist: true });
const manifest = planDataset(db, {
	policy: datasetPolicy({ testLooks: config.decisions.testLooks, weak: weak as WeakSource[] }),
	now: new Date(),
});
console.log(`database ${path} (read-only)`);
console.log(describeDataset(manifest));
if (values.out) {
	mkdirSync(values.out, { recursive: true, mode: 0o700 });
	chmodSync(values.out, 0o700);
	const records = datasetRecords(db, manifest, ["train", "validation"]);
	for (const [split, list] of records) {
		const file = join(values.out, `${split}.jsonl`);
		writeFileSync(file, list.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
		chmodSync(file, 0o600);
		console.log(`wrote ${list.length} ${split} example(s) to ${file}`);
	}
	console.log("The test examples were not written: they are sealed.");
}
db.close();
