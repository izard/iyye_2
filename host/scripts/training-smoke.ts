// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Real smoke of the decision-training round trip on the DGX Spark (Stage 4
 * infrastructure, decision-worker/TRAINING.md; HLD §14 Stage 0: "a tiny local
 * adapter/head training round trip on non-private fixture data, including
 * exact artifact reload and probability parity"):
 *
 * 1. `train_candidate.py` (training venv) trains a few steps from the
 *    provisioned Kev checkpoint on `decision-worker/fixtures/train-fixture.jsonl`
 *    (synthetic) into a scratch candidates directory;
 * 2. `predict.py` scores the fixture with the candidate in the training venv
 *    and in the serving venv (each verifies the manifest first), and with the
 *    parent in the serving venv;
 * 3. the report: parity between the two venvs (max |Δp|, argmax flips), how far
 *    training moved the candidate from its parent (both at temperature 1: a
 *    candidate carries no fitted temperature yet, its parent does), time and
 *    peak memory.
 *
 * It never touches the live Kev, its port or `~/.iyye2/decisions/training/candidates`.
 * It does use the GPU the live host shares, for a minute or two.
 *
 *   node scripts/training-smoke.ts <scratch-dir> [--steps 3] [--tolerance 0.03]
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { steps: { type: "string", default: "3" }, tolerance: { type: "string", default: "0.03" } },
});
const scratch = positionals[0];
if (!scratch) {
	console.error("usage: node scripts/training-smoke.ts <scratch-dir> [--steps 3] [--tolerance 0.03]");
	process.exit(2);
}
const config = loadConfig();
const root = resolve(import.meta.dirname, "..", "..");
const worker = join(root, "decision-worker");
const trainPython = join(root, "kev-train", ".venv", "bin", "python");
const servePython =
	config.decisions.python ??
	(existsSync(join(root, "kev-cuda", ".venv", "bin", "python"))
		? join(root, "kev-cuda", ".venv", "bin", "python")
		: join(config.decisions.installDir, ".venv", "bin", "python"));
for (const p of [trainPython, servePython])
	if (!existsSync(p)) {
		console.error(`missing ${p} (decision-worker/train-env.sh builds the training venv)`);
		process.exit(2);
	}
const fixture = join(worker, "fixtures", "train-fixture.jsonl");
const candidates = join(scratch, "candidates");
mkdirSync(candidates, { recursive: true });
const env = { IYYE2_STATE_DIR: config.stateDir };
const run = (python: string, args: string[]) =>
	execFileSync(python, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] });

console.log(`training ${values.steps} step(s) from ${config.decisions.model} …`);
const trained = JSON.parse(
	run(trainPython, [
		join(worker, "train_candidate.py"),
		"--data",
		fixture,
		"--parent",
		config.decisions.model,
		"--steps",
		values.steps,
		"--max-minutes",
		"20",
		"--out-root",
		candidates,
		"--label",
		"training smoke",
	])
		.trim()
		.split("\n")
		.at(-1)!,
) as { id: string; dir: string; resources: Record<string, number> };
console.log(`candidate ${trained.id}`);

type Scores = {
	venv: string;
	fla: boolean;
	load_s: number;
	peak_cuda_bytes: number;
	predictions: { id: string; probabilities: Record<string, Record<string, number>>; latency_ms: number }[];
};
const score = (python: string, target: string, name: string, raw = false): Scores => {
	const out = join(scratch, `${name}.json`);
	run(python, [
		join(worker, "predict.py"),
		"--run",
		target,
		"--records",
		fixture,
		"--out",
		out,
		...(raw ? ["--raw"] : []),
	]);
	return JSON.parse(readFileSync(out, "utf8")) as Scores;
};
const inTraining = score(trainPython, trained.dir, "candidate-training-venv");
const inServing = score(servePython, trained.dir, "candidate-serving-venv");
const candidateRaw = score(servePython, trained.dir, "candidate-serving-venv-raw", true);
const parent = score(servePython, config.decisions.model, "parent-serving-venv-raw", true);

/**
 * Largest probability difference and argmax disagreements between two scorings of the same records; a flip
 * between two options both scorings put within `tieMargin` of each other is a near-tie, not a disagreement.
 */
function compare(
	a: Scores,
	b: Scores,
	tieMargin = 0,
): { maxDp: number; flips: number; nearTieFlips: number; questions: number } {
	let maxDp = 0;
	let flips = 0;
	let nearTieFlips = 0;
	let questions = 0;
	for (const [i, row] of a.predictions.entries()) {
		for (const [qid, ps] of Object.entries(row.probabilities)) {
			const other = b.predictions[i]!.probabilities[qid]!;
			questions++;
			for (const [k, p] of Object.entries(ps)) maxDp = Math.max(maxDp, Math.abs(p - other[k]!));
			const top = (x: Record<string, number>) => Object.entries(x).sort((m, n) => n[1] - m[1])[0]![0];
			if (top(ps) === top(other)) continue;
			const margin = (x: Record<string, number>) => {
				const [p1, p2] = Object.values(x).sort((m, n) => n - m);
				return p1! - (p2 ?? 0);
			};
			if (margin(ps) <= tieMargin && margin(other) <= tieMargin) nearTieFlips++;
			else flips++;
		}
	}
	return { maxDp, flips, nearTieFlips, questions };
}
const parity = compare(inTraining, inServing, 2 * Number(values.tolerance));
const moved = compare(candidateRaw, parent);
const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;
const median = (xs: number[]) => xs.sort((m, n) => m - n)[Math.floor(xs.length / 2)]!;
const report = {
	candidate: trained.id,
	steps: Number(values.steps),
	training: trained.resources,
	parity: { ...parity, tolerance: Number(values.tolerance) },
	movedFromParent: moved,
	load_s: { training: inTraining.load_s, serving: inServing.load_s },
	peakCuda: { training: trained.resources.peak_cuda_bytes, scoring: inServing.peak_cuda_bytes },
	medianLatencyMs: median(inServing.predictions.map((p) => p.latency_ms)),
	fla: { training: inTraining.fla, serving: inServing.fla },
};
writeFileSync(join(scratch, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
	[
		`trained ${values.steps} step(s) in ${trained.resources.wall_s} s (peak CUDA ${gb(trained.resources.peak_cuda_bytes ?? 0)})`,
		`parity, training venv (fla ${inTraining.fla}) vs serving venv (fla ${inServing.fla}): max |Δp| ${parity.maxDp.toFixed(4)}, ${parity.flips} argmax flip(s) and ${parity.nearTieFlips} on a near-tie (both margins ≤ ${2 * Number(values.tolerance)}) in ${parity.questions} questions`,
		`moved from the parent (both at temperature 1): max |Δp| ${moved.maxDp.toFixed(4)}, ${moved.flips} flip(s)`,
		`serving-venv load ${inServing.load_s} s, median ${report.medianLatencyMs} ms per request, peak CUDA ${gb(inServing.peak_cuda_bytes)}`,
		`candidates in ${candidates}: ${readdirSync(candidates).join(", ")}`,
	].join("\n"),
);
const ok = parity.maxDp <= Number(values.tolerance) && parity.flips === 0;
console.log(ok ? "OK" : "PARITY FAILED");
process.exit(ok ? 0 : 1);
