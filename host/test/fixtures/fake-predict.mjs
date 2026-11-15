// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

// A stand-in for decision-worker/predict.py: every yes/no question gets the raw logits {true: 2, false: 0}
// (so "yes" at 0.88, whatever the label). FAKE_PREDICT: ok (default) · fail (exit 4) · hang (waits for SIGTERM).
// Every call's arguments are appended to FAKE_LOG. It never reads a label.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name) => {
	const i = args.indexOf(name);
	return i < 0 ? null : args[i + 1];
};
const mode = process.env.FAKE_PREDICT || "ok";
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: "predict", args })}\n`);
if (mode === "hang") {
	process.on("SIGTERM", () => process.exit(143));
	setInterval(() => {}, 1000);
} else if (mode === "fail") {
	console.error("predict: the candidate does not match its manifest");
	process.exit(4);
} else {
	const p = 1 / (1 + Math.exp(-2));
	const predictions = readFileSync(arg("--records"), "utf8")
		.trim()
		.split("\n")
		.map((line) => {
			const r = JSON.parse(line);
			const qs = Object.keys(r.questions);
			return {
				id: r._meta.id,
				probabilities: Object.fromEntries(qs.map((q) => [q, { false: 1 - p, true: p }])),
				logits: Object.fromEntries(qs.map((q) => [q, { false: 0, true: 2 }])),
				latency_ms: 70,
			};
		});
	writeFileSync(arg("--out"), JSON.stringify({ temperature: 1, predictions }));
}
