// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * C0 spike (plan 0.006), the Kev part: does reply review's "promises a future
 * action?" line up with whether a reminder was actually created? Reads the
 * replies of `spike-0006-reminders.ts` and asks Kev on its own port (scratch
 * state, model cache linked; never the host's Kev).
 *
 *   node scripts/spike-0006-promise.ts <scratch-dir>
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { PROMISE_QUESTION } from "../src/decisions/reply-review.ts";
import { DecisionService } from "../src/decisions/service.ts";
import { consoleLogger } from "../src/log.ts";

const scratch = process.argv[2];
if (!scratch) {
	console.error("usage: node scripts/spike-0006-promise.ts <scratch-dir>");
	process.exit(2);
}
/** Candidate wording for the ledger label (C2): what the reply says is already arranged, not what it offers. */
const CLAIM_QUESTION =
	'The state is a person\'s message and an assistant\'s reply. Does the reply say that the assistant has already set up a reminder or some other future action (for example "I\'ve set a reminder", "I will remind you at 9"), rather than asking for details, offering to do it, or only answering?';

const rows = (
	JSON.parse(readFileSync(join(scratch, "reminder-results.json"), "utf8")) as {
		variant?: string;
		say?: string;
		reply?: string;
		made?: unknown;
	}[]
).filter((r) => r.reply !== undefined);

const config = loadConfig();
const live = join(config.stateDir, "decisions");
const stateDir = join(scratch, "decisions");
mkdirSync(stateDir, { recursive: true });
if (!existsSync(join(stateDir, "hf"))) symlinkSync(join(live, "hf"), join(stateDir, "hf"));
copyFileSync(join(live, "provisioned.json"), join(stateDir, "provisioned.json"));
const port = await new Promise<number>((resolve) => {
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const p = (s.address() as { port: number }).port;
		s.close(() => resolve(p));
	});
});
const svc = new DecisionService({
	installDir: config.decisions.installDir,
	stateDir,
	port,
	model: config.decisions.model,
	log: consoleLogger(),
	healthIntervalMs: 5000,
});
svc.start();
const out: unknown[] = [];
try {
	const t0 = Date.now();
	while (svc.status.state !== "up") {
		if (Date.now() - t0 > 180_000) throw new Error(`Kev not up: ${svc.status.detail}`);
		await new Promise((r) => setTimeout(r, 500));
	}
	const table = { supported: [] as number[], unsupported: [] as number[], none: [] as number[] };
	const claims = { made: [] as number[], not: [] as number[] };
	for (const r of rows) {
		const res = await fetch(`${svc.baseUrl}/v1/systemone`, {
			method: "POST",
			headers: { authorization: `Bearer ${svc.apiKey()}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: "kev-latest",
				state: { message: r.say, reply: r.reply },
				questions: {
					[PROMISE_QUESTION.id]: { type: "noul", instructions: PROMISE_QUESTION.instructions },
					claims_arranged: { type: "noul", instructions: CLAIM_QUESTION },
				},
			}),
		});
		const answers = ((await res.json()) as { answers: Record<string, { noul: number }> }).answers;
		const p = answers[PROMISE_QUESTION.id]!.noul;
		const c = answers.claims_arranged!.noul;
		claims[r.made ? "made" : "not"].push(c);
		const promises = /\b(i'?ll|i will) remind\b|напомню|reminder (is )?set|will (send|remind)/i.test(r.reply ?? "");
		const kind = r.made ? "supported" : promises ? "unsupported" : "none";
		table[kind].push(p);
		out.push({
			variant: r.variant,
			say: r.say,
			made: Boolean(r.made),
			p: Number(p.toFixed(3)),
			claims: Number(c.toFixed(3)),
			reply: r.reply?.slice(0, 160),
		});
		console.log(`${r.variant} ${r.made ? "MADE" : "    "} promise=${p.toFixed(2)} claims=${c.toFixed(2)} ${r.say}`);
	}
	const stat = (xs: number[]) =>
		xs.length
			? `${xs.length} replies, p ${Math.min(...xs).toFixed(2)}–${Math.max(...xs).toFixed(2)}, mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)}`
			: "none";
	console.log(`reminder created (a supported promise): ${stat(table.supported)}`);
	console.log(`no reminder, reply promises anyway: ${stat(table.unsupported)}`);
	console.log(`no reminder, no promise: ${stat(table.none)}`);
	console.log(`claims_arranged when a reminder was created: ${stat(claims.made)}`);
	console.log(`claims_arranged when none was created: ${stat(claims.not)}`);
} finally {
	await svc.stop();
	writeFileSync(join(scratch, "promise-results.json"), JSON.stringify(out, null, 2));
}
