// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * One-off, owner-run download of the decision checkpoint (plan 0.003 K1): the
 * pinned Kev checkpoint (IYYE2_DECISIONS_MODEL, `repo@revision`) and the base
 * model at the revision the checkpoint itself names, from Hugging Face, into
 * `<IYYE2_STATE_DIR>/decisions/hf`. It uses Kev's own resolver, so exactly
 * the files Kev's server loads are fetched. The host itself never goes online
 * for them: Kev runs with HF_HUB_OFFLINE=1 and reports "needs provisioning"
 * until this has run.
 *
 *   cd host && node scripts/provision-decisions.ts
 *
 * Writes `decisions/provisioned.json` (what was downloaded, at which revisions).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const python = join(config.decisions.installDir, ".venv", "bin", "python");
if (!existsSync(python)) {
	console.error(`Kev is not installed (${python} missing): cd kev && uv sync --frozen --extra serve`);
	process.exit(2);
}
const stateDir = join(config.stateDir, "decisions");
const hfHome = join(stateDir, "hf");
mkdirSync(hfHome, { recursive: true });
mkdirSync(join(stateDir, "home"), { recursive: true });
console.log(`Downloading ${config.decisions.model} and its base into ${hfHome} …`);
const out = execFileSync(
	python,
	[
		"-c",
		[
			"import json, sys",
			"from kev.checkpoint import resolve_run, read_meta",
			"path = resolve_run(sys.argv[1])",
			"meta = read_meta(path)",
			"base = resolve_run(f'{meta.base}@{meta.base_revision or \"\"}')",
			"print(json.dumps({'path': path, 'base': meta.base, 'baseRevision': meta.base_revision, 'basePath': base}))",
		].join("\n"),
		config.decisions.model,
	],
	{
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
		env: { PATH: "/usr/bin:/bin", HOME: join(stateDir, "home"), HF_HOME: hfHome, HF_HUB_DISABLE_TELEMETRY: "1" },
	},
);
const r = JSON.parse(out.trim().split("\n").at(-1)!) as {
	path: string;
	base: string;
	baseRevision: string;
	basePath: string;
};
const record = {
	run: config.decisions.model,
	path: r.path,
	base: r.base,
	baseRevision: r.baseRevision,
	at: new Date().toISOString(),
};
writeFileSync(join(stateDir, "provisioned.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(
	`checkpoint ${record.run}\n  ${r.path}\nbase ${r.base}@${r.baseRevision}\n  ${r.basePath}\nrecorded in ${join(stateDir, "provisioned.json")}`,
);
