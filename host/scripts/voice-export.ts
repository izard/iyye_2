// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.009 CH3/CH6: write the voice's training examples (`src/voice/export.ts`)
 * from the live database, read-only. Nothing trains from them on its own:
 * `decision-worker/voice_train.py --data <out>/data.jsonl` is a separate, owner-started step.
 *
 * Refused until the sealed evaluation set holds owner labels. Writes
 * `data.jsonl` (masked `{system, input, output}` lines) and `lineage.json`
 * (each example's sample, original, person and scope, model, prompt version,
 * character revision and mood snapshot, and the data file's hash) to `--out`
 * (default `<state>/voice/exports/<time>`, 0700, files 0600). Figures only on
 * the console.
 *
 *   node scripts/voice-export.ts [--out <dir>]
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.ts";
import { examplesJsonl, exportVoice } from "../src/voice/export.ts";

const { values } = parseArgs({ options: { out: { type: "string" } } });
const config = loadConfig();
const db = new Database(join(config.stateDir, "iyye.db"), { readonly: true, fileMustExist: true });
const names = (
	db.prepare("SELECT display_name FROM contacts WHERE kind != 'owner'").all() as { display_name: string }[]
)
	.map((r) => r.display_name)
	.filter((n) => n && n.trim().length >= 2);
const ex = exportVoice(db, names);
db.close();
if (!ex.ok) {
	console.error(`voice-export: refused: ${ex.refused}`);
	process.exit(3);
}
const out = values.out ?? join(config.stateDir, "voice", "exports", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(out, { recursive: true, mode: 0o700 });
chmodSync(out, 0o700);
writeFileSync(join(out, "data.jsonl"), examplesJsonl(ex.examples), { mode: 0o600 });
writeFileSync(join(out, "lineage.json"), `${JSON.stringify({ sha256: ex.hash, examples: ex.lineage }, null, 1)}\n`, {
	mode: 0o600,
});
console.log(
	`voice-export: ${ex.examples.length} example(s), sha256 ${ex.hash.slice(0, 12)}; dropped: ${JSON.stringify(ex.dropped)}; in ${out}`,
);
