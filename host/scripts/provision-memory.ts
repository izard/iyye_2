// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * One-off, owner-run download of the local models long-term memory uses
 * (plan 0.002 L1): the embedder and the reranker, from Hugging Face, into
 * `<IYYE2_STATE_DIR>/memory/hf`. The host itself never goes online for them:
 * Hindsight runs with HF_HUB_OFFLINE=1 and reports "needs provisioning" until
 * this has run.
 *
 *   cd host && node scripts/provision-memory.ts
 *
 * Prints the snapshot revision of each model; record them in host/PINS.md.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const python = join(config.memory.installDir, ".venv", "bin", "python");
if (!existsSync(python)) {
	console.error(`Hindsight is not installed (${python} missing). See iyye_2_0_002_plan.md L1.`);
	process.exit(2);
}
const hfHome = join(config.stateDir, "memory", "hf");
mkdirSync(hfHome, { recursive: true });
const models = [config.memory.embeddingsModel, config.memory.rerankerModel];
console.log(`Downloading ${models.join(" and ")} into ${hfHome} …`);
execFileSync(
	python,
	[
		"-c",
		"import sys\nfrom huggingface_hub import snapshot_download\nfor m in sys.argv[1:]:\n    print(m, '->', snapshot_download(m))",
		...models,
	],
	{ stdio: "inherit", env: { PATH: "/usr/bin:/bin", HOME: join(config.stateDir, "memory", "home"), HF_HOME: hfHome } },
);
for (const m of models) {
	const snaps = join(hfHome, "hub", `models--${m.replace("/", "--")}`, "snapshots");
	console.log(`${m}: revision ${readdirSync(snaps).join(", ")}`);
}
console.log("Done. Restart the host; memory will start offline.");
