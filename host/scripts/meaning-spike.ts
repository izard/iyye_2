// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.009 (SPIKE-0.009 "For CH3" item 4): would a Kev "same meaning?" role
 * beside the deterministic meaning check be worth having? Offline, shadow by
 * construction: nothing here is journaled or read by the host.
 *
 * The real Kev (supervised by DecisionService on a free port with a scratch
 * state directory linked to the provisioned model, as `decisions-smoke.ts`;
 * never the running host's Kev) is asked fixed yes/no questions about each
 * (message, rewording) pair:
 *
 * - the labelled synthetic pairs: `voice-pairs.json` and
 *   `voice-pairs-ch0-heldout.json` (both developed the lexical check) and
 *   `voice-pairs-heldout.json` (held out from it). Kev was tuned on none of
 *   them; the question wording was fixed before the first run.
 * - optionally (`--rows`), CH0's real rephrasings (`~/.iyye2/spikes/voice/rows.jsonl`),
 *   with gemma-4-12B's weak same/different verdicts as labels (a model's
 *   judgement, not ground truth, HLD §10.2).
 *
 * Reports, per question and set: ranking quality (AUC), accuracy at 0.5, the
 * share decided outside the abstention band 0.3–0.7 and its accuracy, and what
 * Kev adds to the lexical check: of the changed rewordings the check accepts,
 * how many Kev calls different; of the faithful ones it accepts, how many Kev
 * would wrongly refuse. Figures only on the console; per-pair rows (they quote
 * real replies) go to `--out` (0700, rows 0600).
 *
 *   node scripts/meaning-spike.ts <scratch-dir> [--rows <rows.jsonl>] [--out <dir>]
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { DecisionService } from "../src/decisions/service.ts";
import { consoleLogger } from "../src/log.ts";
import { voiceProblem } from "../src/voice/check.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { rows: { type: "string" }, out: { type: "string" } },
});
const scratch = positionals[0];
if (!scratch) {
	console.error("usage: node scripts/meaning-spike.ts <scratch-dir> [--rows <rows.jsonl>] [--out <dir>]");
	process.exit(2);
}

/** Fixed before the first run. "same" asks the role's question; "changed" its inverse, to see which Kev answers better. */
const QUESTIONS = {
	same: "The state holds a message and a rewording of it. Does the rewording say exactly the same thing as the message: the same facts, times, places, people, promises, problems and certainty, only in other words or another tone?",
	changed:
		"The state holds a message and a rewording of it. Does the rewording add, drop or change anything the message says: a fact, a time, a place, a person, a promise, a problem, or how certain it is?",
} as const;
type Q = keyof typeof QUESTIONS;

interface Pair {
	set: string;
	lang: string;
	original: string;
	rephrased: string;
	/** true: the same meaning. */
	same: boolean;
	names: readonly string[];
}

const config = loadConfig();
const fixtures = join(import.meta.dirname, "..", "test", "fixtures");
const SYNTHETIC_NAMES = ["Julia", "Jacob", "Юля"]; // as test/voice-check.test.ts
const pairs: Pair[] = [];
for (const [set, file] of [
	["development", "voice-pairs.json"],
	["ch0-heldout (development)", "voice-pairs-ch0-heldout.json"],
	["heldout", "voice-pairs-heldout.json"],
] as const) {
	for (const p of JSON.parse(readFileSync(join(fixtures, file), "utf8")) as {
		original: string;
		rephrased: string;
		same: boolean;
		lang: string;
	}[])
		pairs.push({
			set,
			lang: p.lang,
			original: p.original,
			rephrased: p.rephrased,
			same: p.same,
			names: SYNTHETIC_NAMES,
		});
}
if (values.rows) {
	const db = new DatabaseSync(join(config.stateDir, "iyye.db"), { readOnly: true });
	const names = (db.prepare("SELECT display_name FROM contacts").all() as { display_name: string }[]).map(
		(r) => r.display_name,
	);
	db.close();
	for (const line of readFileSync(values.rows, "utf8").split("\n").filter(Boolean)) {
		const r = JSON.parse(line) as {
			original: string;
			final: string | null;
			changed: number;
			judge?: string;
			lang: string;
			source: string;
		};
		if (r.final === null || r.changed <= 0 || (r.judge !== "same" && r.judge !== "different")) continue;
		pairs.push({
			set: `CH0 rephrasings of ${r.source === "real" ? "real replies" : "synthetic originals"} (judge labels)`,
			lang: r.lang,
			original: r.original,
			rephrased: r.final,
			same: r.judge === "same",
			names,
		});
	}
}

const out = values.out ?? join(config.stateDir, "spikes", "meaning");
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

type Row = Pair & { check: string | null; p: Record<Q, number>; ms: number };
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
	for (const pair of pairs) {
		const t = Date.now();
		const res = await fetch(`${svc.baseUrl}/v1/systemone`, {
			method: "POST",
			headers: { authorization: `Bearer ${svc.apiKey()}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: "kev-latest",
				state: { message: pair.original, rewording: pair.rephrased },
				questions: Object.fromEntries(
					Object.entries(QUESTIONS).map(([id, instructions]) => [id, { type: "noul", instructions }]),
				),
			}),
		});
		const body = (await res.json()) as { answers?: Record<string, { noul?: number }> };
		const p = Object.fromEntries(
			(Object.keys(QUESTIONS) as Q[]).map((q) => [q, Number(body.answers?.[q]?.noul ?? Number.NaN)]),
		) as Record<Q, number>;
		if (!res.ok || Object.values(p).some((x) => !(x >= 0 && x <= 1)))
			throw new Error(`Kev: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
		rows.push({ ...pair, check: voiceProblem(pair.original, pair.rephrased, pair.names), p, ms: Date.now() - t });
	}
} finally {
	await svc.stop();
}
writeFileSync(join(out, "rows.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });

/** P(same) by question: "changed" is inverted. */
const pSame = (r: Row, q: Q) => (q === "same" ? r.p.same : 1 - r.p.changed);
function auc(rs: Row[], q: Q): number | null {
	const pos = rs.filter((r) => r.same).map((r) => pSame(r, q));
	const neg = rs.filter((r) => !r.same).map((r) => pSame(r, q));
	if (!pos.length || !neg.length) return null;
	let wins = 0;
	for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
	return wins / (pos.length * neg.length);
}
const pct = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((100 * n) / d)} %)` : "—");
function summarize(rs: Row[], q: Q) {
	const right = rs.filter((r) => pSame(r, q) >= 0.5 === r.same).length;
	const decided = rs.filter((r) => pSame(r, q) < 0.3 || pSame(r, q) > 0.7);
	const decidedRight = decided.filter((r) => pSame(r, q) > 0.7 === r.same).length;
	const accepted = rs.filter((r) => r.check === null);
	const accChanged = accepted.filter((r) => !r.same);
	const accSame = accepted.filter((r) => r.same);
	return {
		auc: auc(rs, q)?.toFixed(3) ?? "—",
		accuracy: pct(right, rs.length),
		outsideBand: pct(decided.length, rs.length),
		outsideBandAccuracy: pct(decidedRight, decided.length),
		checkAcceptedChanged_kevSaysDifferent: pct(accChanged.filter((r) => pSame(r, q) < 0.5).length, accChanged.length),
		checkAcceptedChanged_kevSureDifferent: pct(accChanged.filter((r) => pSame(r, q) < 0.3).length, accChanged.length),
		checkAcceptedSame_kevWronglyDifferent: pct(accSame.filter((r) => pSame(r, q) < 0.5).length, accSame.length),
		checkAcceptedSame_kevSureWronglyDifferent: pct(accSame.filter((r) => pSame(r, q) < 0.3).length, accSame.length),
	};
}
const summary: Record<string, unknown> = {
	checkpoint,
	questions: QUESTIONS,
	latencyMsMedian: [...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)],
	sets: {},
};
for (const set of [...new Set(rows.map((r) => r.set))]) {
	for (const lang of ["all", "en", "ru"]) {
		const rs = rows.filter((r) => r.set === set && (lang === "all" || r.lang === lang));
		if (!rs.length || (lang !== "all" && rs.length === rows.filter((r) => r.set === set).length)) continue;
		const label = `${set}${lang === "all" ? "" : ` [${lang}]`}`;
		const s = {
			n: rs.length,
			same: rs.filter((r) => r.same).length,
			lexicalCheck: {
				falseAccepts: pct(rs.filter((r) => !r.same && r.check === null).length, rs.filter((r) => !r.same).length),
				falseRejects: pct(rs.filter((r) => r.same && r.check !== null).length, rs.filter((r) => r.same).length),
			},
			same_question: summarize(rs, "same"),
			changed_question: summarize(rs, "changed"),
		};
		(summary.sets as Record<string, unknown>)[label] = s;
		console.log(`\n${label}: ${JSON.stringify(s, null, 1)}`);
	}
}
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`, { mode: 0o600 });
console.log(`\nlatency median ${summary.latencyMsMedian} ms; rows and summary in ${out}`);
