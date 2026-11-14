// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Which wording of "does this message need the thinking model?" does Kev
 * answer best, zero-shot (the `thinking_need` shadow role,
 * `src/decisions/thinking-need.ts`, whose two questions were chosen here)? Offline: nothing here is journaled or read
 * by the host.
 *
 * The real Kev (supervised by `DecisionService` on a free port with a scratch
 * state directory linked to the provisioned model, as `meaning-spike.ts`;
 * never the running host's Kev) is asked every candidate wording about each
 * answered message of the owner and of trusted contacts since the thinking tool
 * first ran. The label is the weak one the role records: the chat model asked
 * the thinking model in that turn (`tool_calls.event_id`). The database is
 * opened read-only.
 *
 * Per wording: ranking quality (AUC), mean p of the turns that asked and of
 * those that did not, how each falls around the band, and the best single
 * threshold; again without the messages that name the thinking model
 * themselves (an explicit request needs no judgement). Figures only on the
 * console; per-message rows (they quote real messages) go to `--out` (0700,
 * rows 0600).
 *
 *   node scripts/thinking-need-spike.ts <scratch-dir> [--db <iyye.db>] [--out <dir>]
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { bestThreshold } from "../src/decisions/report.ts";
import { DecisionService } from "../src/decisions/service.ts";
import { ASKS_QUESTION, NEED_QUESTION, THINKING_NEED } from "../src/decisions/thinking-need.ts";
import { consoleLogger } from "../src/log.ts";
import { type EventRow, messageText } from "../src/state/events.ts";
import { ASK_THINKING_TOOL } from "../src/tools/thinking.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { db: { type: "string" }, out: { type: "string" } },
});
const scratch = positionals[0];
if (!scratch) {
	console.error("usage: node scripts/thinking-need-spike.ts <scratch-dir> [--db <iyye.db>] [--out <dir>]");
	process.exit(2);
}

const ASSISTANT = "The state is a message someone sent to their personal assistant.";
/**
 * `role` and `asks` are the two the role asks. The rest are the wordings tried beside them (2026-11-14), kept so
 * a later checkpoint can be compared on the same ones; `quick` is an inverse (its p is turned round).
 */
const QUESTIONS = {
	role: NEED_QUESTION.instructions,
	asks: ASKS_QUESTION.instructions,
	reasoning: `${ASSISTANT} To answer it well, does the assistant need careful step-by-step reasoning, as for a puzzle, a riddle, math, logic or a tricky analysis, rather than a quick reply, a lookup or small talk?`,
	both: `${ASSISTANT} To answer it well, does the assistant need the help of a stronger, slower reasoning model: because the message asks for a careful, thorough or expert answer, or because it takes step-by-step reasoning, as a puzzle, math, logic or a tricky analysis does?`,
	hard: `${ASSISTANT} Is it a hard question, one where a quick answer is likely to be wrong unless it is thought through carefully?`,
	quick: `${ASSISTANT} Can the assistant answer it well at once, without working through it step by step?`,
} as const;
type Q = keyof typeof QUESTIONS;
const INVERSE: readonly Q[] = ["quick"];
/** The message itself names the thinking model: the person decided, not the chat model. */
const EXPLICIT = /think(?:ing)?[\s-]+model|reasoning model|думающ|размышля|мыслящ/i;

const config = loadConfig();
const db = new DatabaseSync(values.db ?? join(config.stateDir, "iyye.db"), { readOnly: true });
const first = (
	db.prepare("SELECT min(started_at) AS at FROM tool_calls WHERE tool = ?").get(ASK_THINKING_TOOL) as {
		at: string | null;
	}
).at;
if (!first) {
	console.error("the thinking model was never asked: nothing to compare");
	process.exit(1);
}
const events = db
	.prepare(
		`SELECT e.*, EXISTS (SELECT 1 FROM tool_calls t WHERE t.event_id = e.id AND t.tool = ?) AS called
		 FROM events e
		 WHERE e.status = 'answered' AND e.received_at >= ?
		 AND (e.scope = 'owner' OR e.scope IN (SELECT 'contact:' || id FROM contacts WHERE trusted = 1))
		 ORDER BY e.received_at`,
	)
	.all(ASK_THINKING_TOOL, first) as unknown as (EventRow & { called: number })[];
db.close();
const turns = events
	.map((e) => ({ id: e.id, scope: e.scope, at: e.received_at, called: e.called === 1, message: messageText(e) }))
	.filter((t) => t.message.trim());
console.log(
	`${turns.length} answered messages since ${first.slice(0, 10)}; the thinking model was asked in ${turns.filter((t) => t.called).length}`,
);

const out = values.out ?? join(config.stateDir, "spikes", "thinking-need");
mkdirSync(out, { recursive: true, mode: 0o700 });
chmodSync(out, 0o700);

// The real Kev on its own port, its cache linked to the provisioned one (nothing copied or downloaded).
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
	...(config.decisions.python ? { command: [config.decisions.python, "-m", "kev.serve"] } : {}),
});

type Row = (typeof turns)[number] & { p: Record<Q, number>; ms: number };
const rows: Row[] = [];
let checkpoint: unknown = null;
const t0 = Date.now();
svc.start();
try {
	while (svc.status.state !== "up") {
		if (["not installed", "needs provisioning"].includes(svc.status.state) || Date.now() - t0 > 300_000)
			throw new Error(`Kev not up: ${svc.status.state}: ${svc.status.detail}`);
		await new Promise((r) => setTimeout(r, 500));
	}
	checkpoint = svc.checkpoint;
	console.log(`Kev up after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(checkpoint)}`);
	for (const turn of turns) {
		const t = Date.now();
		const res = await fetch(`${svc.baseUrl}/v1/systemone`, {
			method: "POST",
			headers: { authorization: `Bearer ${svc.apiKey()}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: "kev-latest",
				// Exactly the role's state.
				state: { message: turn.message.slice(0, 4000) },
				questions: Object.fromEntries(
					Object.entries(QUESTIONS).map(([id, instructions]) => [id, { type: "noul", instructions }]),
				),
			}),
		});
		const body = (await res.json()) as { answers?: Record<string, { noul?: number }> };
		const p = Object.fromEntries(
			(Object.keys(QUESTIONS) as Q[]).map((q) => {
				const x = Number(body.answers?.[q]?.noul ?? Number.NaN);
				return [q, INVERSE.includes(q) ? 1 - x : x];
			}),
		) as Record<Q, number>;
		if (!res.ok || Object.values(p).some((x) => !(x >= 0 && x <= 1)))
			throw new Error(`Kev: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
		rows.push({ ...turn, p, ms: Date.now() - t });
	}
} finally {
	await svc.stop();
}
writeFileSync(join(out, "rows.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });

function auc(rs: Row[], q: Q): string {
	const pos = rs.filter((r) => r.called).map((r) => r.p[q]);
	const neg = rs.filter((r) => !r.called).map((r) => r.p[q]);
	if (!pos.length || !neg.length) return "—";
	let wins = 0;
	for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
	return (wins / (pos.length * neg.length)).toFixed(3);
}
const mean = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "—");
const { low, high } = THINKING_NEED.abstain;
function summarize(rs: Row[], q: Q) {
	const band = (xs: Row[]) =>
		`${xs.filter((r) => r.p[q] >= high).length} yes · ${xs.filter((r) => r.p[q] > low && r.p[q] < high).length} unsure · ${xs.filter((r) => r.p[q] <= low).length} no`;
	const asked = rs.filter((r) => r.called);
	const not = rs.filter((r) => !r.called);
	const best = bestThreshold(rs.map((r) => ({ p: r.p[q], yes: r.called })));
	return {
		auc: auc(rs, q),
		asked: `${asked.length}: mean p ${mean(asked.map((r) => r.p[q]))} (${band(asked)})`,
		notAsked: `${not.length}: mean p ${mean(not.map((r) => r.p[q]))} (${band(not)})`,
		bestThreshold: `p ≥ ${best.t.toFixed(2)} → ${best.correct}/${rs.length} agree`,
	};
}
const implicit = rows.filter((r) => !EXPLICIT.test(r.message));
const summary = {
	checkpoint,
	band: THINKING_NEED.abstain,
	questions: QUESTIONS,
	latencyMsMedian: [...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)],
	namesTheThinkingModel: {
		messages: rows.length - implicit.length,
		ofThemAsked: rows.filter((r) => EXPLICIT.test(r.message) && r.called).length,
	},
	all: Object.fromEntries((Object.keys(QUESTIONS) as Q[]).map((q) => [q, summarize(rows, q)])),
	withoutMessagesNamingIt: Object.fromEntries((Object.keys(QUESTIONS) as Q[]).map((q) => [q, summarize(implicit, q)])),
};
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
console.log(`rows: ${join(out, "rows.jsonl")}`);
