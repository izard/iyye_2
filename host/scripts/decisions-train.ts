// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The offline decision-training session (plan 0.017 N3; `src/decisions/training.ts`
 * says what it does, step by step). Run it only while Iyye is stopped:
 *
 *   IYYE2_DECISION_TRAINING=on node scripts/decisions-train.ts
 *
 * - With the policy off (the default) it does nothing.
 * - It takes the host's lock for as long as it runs: it refuses while Iyye is
 *   running, and Iyye refuses to start while it runs. It also refuses while
 *   the router, Kev or Hindsight still listen on their ports.
 * - It trains one candidate from the released Kev pin on the owner's labels,
 *   fits a temperature on the validation split, and registers the candidate.
 *   Nothing is evaluated, served or activated.
 * - Ctrl-C or SIGTERM stops it in about a second; nothing is registered, and
 *   the stopped run is discarded.
 * - It writes the training and validation examples under
 *   `~/.iyye2/decisions/training/sessions/` only for the run, and deletes
 *   them when it ends, however it ends.
 *
 * `--check` stops after eligibility and the memory check: it says what a
 * session would do now, freezes no dataset and trains nothing. It still needs
 * Iyye stopped, since it takes the lock and opens the database.
 *
 * Exit status: 0 a candidate was registered, or the session was skipped for a
 * recorded reason; 3 refused (Iyye or one of its services is running);
 * 143 stopped; 1 failed.
 */

import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { runTrainingSession } from "../src/decisions/training.ts";
import { systemMemoryProbe } from "../src/models/memory.ts";
import { openDb } from "../src/state/db.ts";

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
const config = loadConfig();
const root = resolve(import.meta.dirname, "..", "..");
const worker = join(root, "decision-worker");
const trainPython = join(root, "kev-train", ".venv", "bin", "python");
const servePython =
	config.decisions.python ??
	(existsSync(join(root, "kev-cuda", ".venv", "bin", "python"))
		? join(root, "kev-cuda", ".venv", "bin", "python")
		: join(config.decisions.installDir, ".venv", "bin", "python"));
if (config.decisions.training.policy === "on")
	for (const p of [trainPython, servePython])
		if (!existsSync(p)) {
			console.error(`missing ${p} (decision-worker/train-env.sh builds the training venv)`);
			process.exit(2);
		}
const suite = join(config.stateDir, "decisions", "suites", "evals", "v7", "decision-v7");

const stop = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const)
	process.on(sig, () => {
		console.error(`${sig}: stopping; nothing will be registered`);
		stop.abort();
	});

const listening = (port: number) =>
	new Promise<boolean>((done) => {
		const s = connect({ host: "127.0.0.1", port });
		const end = (up: boolean) => {
			s.destroy();
			done(up);
		};
		s.setTimeout(1000, () => end(false));
		s.once("connect", () => end(true));
		s.once("error", () => end(false));
	});

const result = await runTrainingSession({
	stateDir: config.stateDir,
	settings: {
		...config.decisions.training,
		testLooks: config.decisions.testLooks,
		parent: config.decisions.model,
	},
	openDb: () => openDb(join(config.stateDir, "iyye.db")),
	ports: [
		{ name: "the model router", port: config.routerPort },
		{ name: "the decision service (Kev)", port: config.decisions.port },
		{ name: "long-term memory (Hindsight)", port: config.memory.hindsightPort },
	],
	listening,
	availableGb: () => systemMemoryProbe(),
	trainCommand: [trainPython, join(worker, "train_candidate.py")],
	predictCommand: [servePython, join(worker, "predict.py")],
	suiteDir: existsSync(join(suite, "manifest.json")) ? suite : null,
	env: { IYYE2_STATE_DIR: config.stateDir },
	signal: stop.signal,
	checkOnly: values.check,
	say: (line) => console.log(line),
});
process.exit(result.exitCode);
