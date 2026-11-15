// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

// A stand-in for decision-worker/train_candidate.py: the same arguments, the same candidate directory and
// last-line JSON, the same exit codes, and no model. FAKE_TRAINER picks what happens:
//   ok (default) · fail (exit 1, a .failed-<id> log) · hang (waits for SIGTERM, then discards and exits 143)
//   die (kills itself) · wrong-data (a candidate whose manifest names another training file) · nothing (exit 0, no candidate)
// Every call's arguments are appended to FAKE_LOG.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name) => {
	const i = args.indexOf(name);
	return i < 0 ? null : args[i + 1];
};
const mode = process.env.FAKE_TRAINER || "ok";
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: "train", args })}\n`);
const outRoot = arg("--out-root");
const data = arg("--data");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const id = `${stamp}-${createHash("sha256").update(`${process.pid}${Math.random()}`).digest("hex").slice(0, 6)}`;
mkdirSync(outRoot, { recursive: true });
const partial = join(outRoot, `.partial-${id}`);
mkdirSync(join(partial, "run"), { recursive: true });

if (mode === "hang") {
	process.on("SIGTERM", () => {
		rmSync(partial, { recursive: true, force: true });
		process.exit(143);
	});
	writeFileSync(join(outRoot, "training-now"), id);
	setInterval(() => {}, 1000);
} else if (mode === "die") {
	writeFileSync(join(outRoot, "training-now"), id);
	process.kill(process.pid, "SIGKILL");
} else if (mode === "fail") {
	rmSync(partial, { recursive: true, force: true });
	mkdirSync(join(outRoot, `.failed-${id}`), { recursive: true });
	writeFileSync(join(outRoot, `.failed-${id}`, "train.log"), "CUDA out of memory\n");
	console.error("the trainer exited 1; log kept\nCUDA out of memory");
	process.exit(1);
} else if (mode === "nothing") {
	rmSync(partial, { recursive: true, force: true });
	process.exit(0);
} else {
	writeFileSync(join(partial, "run", "head.pt"), "weights");
	// kev.train says what it left out only in its log, which the wrapper keeps beside the run.
	writeFileSync(
		join(partial, "train.log"),
		process.env.FAKE_DROPPED
			? `loading\ndropped ${process.env.FAKE_DROPPED} of 147 records that exceed the training context (384 state / 1024 branch / 2048 packed tokens)\nstep 1\n`
			: "loading\nstep 1\n",
	);
	const sha = createHash("sha256").update(readFileSync(data)).digest("hex");
	const manifest = {
		id,
		state: "candidate",
		parent: { requested: arg("--parent") },
		data: { path: data, sha256: mode === "wrong-data" ? "0".repeat(64) : sha, records: readFileSync(data, "utf8").trim().split("\n").length },
		training: { steps: Number(arg("--steps")) },
		files: { "head.pt": createHash("sha256").update("weights").digest("hex") },
	};
	writeFileSync(join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	const final = join(outRoot, id);
	const { renameSync } = await import("node:fs");
	renameSync(partial, final);
	console.log("kev.train: step 1 loss 0.7");
	console.log(JSON.stringify({ id, dir: final, resources: { status: "ok", wall_s: 1.5, peak_cuda_bytes: 31_000_000_000 } }));
}
