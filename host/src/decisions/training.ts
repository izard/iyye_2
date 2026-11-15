// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The offline decision-training session (plan 0.017 N3, HLD §10.3): one
 * candidate adapter from the owner's labels, trained while Iyye is stopped
 * (owner decision 2026-10-27: memory, and nothing else may write the records
 * meanwhile). Run by the owner, or the owner's scheduler, through
 * `scripts/decisions-train.ts`. Iyye never stops or starts itself for it.
 *
 * In order, and nothing later happens when an earlier step says no:
 *
 * 1. **The policy** (`IYYE2_DECISION_TRAINING`, off by default). Off: nothing
 *    is touched, not even the lock.
 * 2. **The host's lock** (`process/host-lock.ts`): refused while a host holds
 *    it; held for the whole session, so a host started meanwhile refuses to
 *    start and names the session. Also refused while anything still listens
 *    on Iyye's own ports (the router, Kev, Hindsight): a service left running
 *    holds the memory training needs.
 * 3. **Leftovers** of a session that was killed: candidate directories the
 *    registry does not know, partial ones, exported files, an unfinished
 *    session row.
 * 4. **Eligibility:** a dataset can be cut (N2), enough owner labels arrived
 *    since the last candidate, and at least one question has enough labels of
 *    each class in training. Only those questions are trained on. Otherwise
 *    the session is recorded as skipped: no update is better than a noisy one.
 * 5. **Memory:** what is available against the measured peak plus a margin.
 * 6. **The dataset is frozen** (`freezeDataset`), and the training and
 *    validation files written from it. The sealed test set is not read.
 * 7. **Training** (`decision-worker/train_candidate.py`): always from the
 *    released pin (decision 5), with records of Kev's own suite mixed in
 *    (decision 6), within the time budget. A stop request (SIGTERM, Ctrl-C)
 *    is passed on at once; the trainer discards its work in under a second.
 * 8. **Calibration:** the candidate scores the validation file at temperature
 *    1 (`predict.py --raw --context serving`, the serving environment and its limits) and a temperature is
 *    fitted on that alone (`temperature.ts`). It is recorded in the registry,
 *    never written into the candidate (that would void its manifest).
 * 9. **Registration:** one transaction writes the candidate (`decision_artifacts`,
 *    state `candidate`) and closes the session. Anything that went wrong or
 *    was stopped before that leaves the registry exactly as it was, and the
 *    candidate directory is deleted.
 *
 * The exported files are deleted whatever happens. Nothing here evaluates,
 * serves or activates a candidate (N4, N5).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireHostLock, releaseHostLock } from "../process/host-lock.ts";
import type { Db } from "../state/db.ts";
import {
	type DatasetManifest,
	datasetPolicy,
	deleteDatasetFiles,
	describeDataset,
	freezeDataset,
	labelCounts,
	planDataset,
	writeDataset,
} from "./dataset.ts";
import { fitTemperature, MIN_FIT_LABELS, marginOf, type RawAnswer, type TemperatureFit } from "./temperature.ts";

export const TRAINING_HOLDER = "a decision training session";

export interface TrainingSettings {
	policy: "off" | "on";
	minNewLabels: number;
	minPerClass: number;
	maxMinutes: number;
	minFreeGb: number;
	epochs: number;
	replayPerExample: number;
	maxState: number;
	/** IYYE2_TEST_LOOKS (the dataset's policy). */
	testLooks: number;
	/** The released pin every candidate starts from (IYYE2_DECISIONS_MODEL). */
	parent: string;
}

export interface SessionDeps {
	stateDir: string;
	settings: TrainingSettings;
	/** Opens the control database; called only once the lock is held. */
	openDb: () => Db;
	/** Iyye's own services that must not be running: a name for the refusal and the port it listens on. */
	ports: { name: string; port: number }[];
	listening: (port: number) => Promise<boolean>;
	availableGb: () => number;
	/** The trainer and the scorer, as commands the arguments are appended to (tests: fakes). */
	trainCommand: string[];
	predictCommand: string[];
	/** Kev's provisioned suite to draw replay records from; null when it is not there. */
	suiteDir: string | null;
	/** The environment of both commands (they replace it with their own; they need IYYE2_STATE_DIR). */
	env: Record<string, string>;
	/** Aborted when the owner or the scheduler asks the session to stop. */
	signal?: AbortSignal;
	/** Stop after eligibility and the memory check: say what a session would do, freeze and train nothing. */
	checkOnly?: boolean;
	now?: () => Date;
	newId?: () => string;
	say?: (line: string) => void;
}

export type SessionOutcome = "off" | "refused" | "skipped" | "candidate" | "stopped" | "failed";

export interface SessionResult {
	outcome: SessionOutcome;
	reason: string | null;
	sessionId: string | null;
	artifactId: string | null;
	/** 0: a candidate, or a recorded "no"; 3: refused (a host or its services are running); 143: stopped; 1: failed. */
	exitCode: number;
}

/** The trainer's batch and accumulation: one optimizer step sees this many records. */
const BATCH = 2;
const ACCUM = 4;
const CANDIDATE_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
/** A failed run's log is kept this long for the owner to read. */
const FAILED_LOG_DAYS = 14;

export const candidatesDir = (stateDir: string) => join(stateDir, "decisions", "training", "candidates");
const sessionsDir = (stateDir: string) => join(stateDir, "decisions", "training", "sessions");

export interface Trainable {
	role: string;
	question: string;
	yes: number;
	no: number;
}

/** The questions with enough owner labels of each class in training, and the nearest miss when there is none. */
export function trainable(
	manifest: DatasetManifest,
	minPerClass: number,
): { questions: Trainable[]; closest: Trainable | null } {
	const all = labelCounts(manifest)
		.filter((c) => c.split === "train")
		.map((c) => ({ role: c.role, question: c.question, yes: c.yes, no: c.no }));
	const questions = all.filter((c) => c.yes >= minPerClass && c.no >= minPerClass);
	const closest = [...all].sort((a, b) => Math.min(b.yes, b.no) - Math.min(a.yes, a.no))[0] ?? null;
	return { questions, closest };
}

/** Optimizer steps for `epochs` passes over the own and replay records, within the trainer's bounds. */
export function trainingSteps(own: number, replay: number, epochs: number): number {
	return Math.min(2000, Math.max(1, Math.ceil((epochs * (own + replay)) / (BATCH * ACCUM))));
}

/** Owner labels on the dataset's roles and scopes that arrived after a time ("" for all of them). */
function labelsSince(db: Db, manifest: DatasetManifest, since: string): number {
	const { roles, scopes } = manifest.policy;
	return (
		db
			.prepare(
				`SELECT count(*) AS n FROM decision_labels l JOIN decisions d ON d.id = l.decision_id
				 WHERE l.value IS NOT NULL AND l.labelled_at > ?
				 AND d.role IN (${roles.map(() => "?").join(", ")}) AND d.scope IN (${scopes.map(() => "?").join(", ")})`,
			)
			.get(since, ...roles, ...scopes) as { n: number }
	).n;
}

export type Eligibility = { ok: true; questions: Trainable[]; fresh: number } | { ok: false; reason: string };

/**
 * May a session train on this cut (plan §3.3 step 2)? A dataset can be cut, enough owner labels arrived since
 * the last candidate, and at least one question has enough of each class in training. Reads only.
 */
export function eligibility(
	db: Db,
	plan: DatasetManifest,
	s: Pick<TrainingSettings, "minNewLabels" | "minPerClass">,
): Eligibility {
	if (plan.problem) return { ok: false, reason: plan.problem };
	const last = (db.prepare("SELECT max(created_at) AS at FROM decision_artifacts").get() as { at: string | null }).at;
	const fresh = labelsSince(db, plan, last ?? "");
	if (fresh < s.minNewLabels)
		return {
			ok: false,
			reason: `${fresh} owner label(s) since ${last ? "the last candidate" : "the start"}; ${s.minNewLabels} are needed`,
		};
	const { questions, closest } = trainable(plan, s.minPerClass);
	if (questions.length === 0)
		return {
			ok: false,
			reason:
				`no question has ${s.minPerClass} labels of each class in training` +
				(closest ? ` (closest: ${closest.role} ${closest.question}, ${closest.yes} yes · ${closest.no} no)` : ""),
		};
	return { ok: true, questions, fresh };
}

const named = (questions: readonly Trainable[]) =>
	questions.map((q) => `${q.role} ${q.question} (${q.yes} yes · ${q.no} no)`).join(", ");

/** A real directory directly inside `parent`: never a link, never a path that leaves it. */
function ownDirectory(parent: string, name: string): string | null {
	const path = join(parent, name);
	if (dirname(resolve(path)) !== resolve(parent)) return null;
	try {
		return lstatSync(path).isDirectory() ? path : null;
	} catch {
		return null;
	}
}

/** Partial runs in the candidates directory: a trainer writes there until it finishes, and nothing reads them. */
function removePartialRuns(stateDir: string): number {
	const cdir = candidatesDir(stateDir);
	let n = 0;
	for (const name of existsSync(cdir) ? readdirSync(cdir) : []) {
		if (!name.startsWith(".partial-") || !CANDIDATE_ID.test(name.slice(".partial-".length))) continue;
		const path = ownDirectory(cdir, name);
		if (!path) continue;
		rmSync(path, { recursive: true, force: true });
		n++;
	}
	return n;
}

export interface Leftovers {
	candidates: number;
	partial: number;
	failedLogs: number;
	exports: number;
	sessions: number;
}

/**
 * What a killed session left behind. Called with the lock held, so no other session is writing: a candidate
 * directory the registry does not know (never loaded, and now deleted), partial runs, old failure logs,
 * exported files (they hold what people said), and session rows that never ended.
 */
export function cleanLeftovers(db: Db, stateDir: string, now: Date): Leftovers {
	const out: Leftovers = { candidates: 0, partial: 0, failedLogs: 0, exports: 0, sessions: 0 };
	const cdir = candidatesDir(stateDir);
	const known = new Set((db.prepare("SELECT id FROM decision_artifacts").all() as { id: string }[]).map((r) => r.id));
	for (const name of existsSync(cdir) ? readdirSync(cdir) : []) {
		const path = ownDirectory(cdir, name);
		if (!path) continue;
		if (name.startsWith(".partial-")) {
			// Counted below, all at once.
		} else if (name.startsWith(".failed-") && CANDIDATE_ID.test(name.slice(".failed-".length))) {
			if (now.getTime() - lstatSync(path).mtimeMs > FAILED_LOG_DAYS * 86_400_000) {
				rmSync(path, { recursive: true, force: true });
				out.failedLogs++;
			}
		} else if (CANDIDATE_ID.test(name) && !known.has(name)) {
			rmSync(path, { recursive: true, force: true });
			out.candidates++;
		}
	}
	out.partial = removePartialRuns(stateDir);
	const sdir = sessionsDir(stateDir);
	for (const name of existsSync(sdir) ? readdirSync(sdir) : []) {
		const path = ownDirectory(sdir, name);
		if (!path) continue;
		rmSync(path, { recursive: true, force: true });
		out.exports++;
	}
	out.sessions = db
		.prepare(
			"UPDATE decision_training_sessions SET ended_at = ?, outcome = 'failed', reason = 'the session did not finish (killed, or the machine went down)' WHERE ended_at IS NULL",
		)
		.run(now.toISOString()).changes;
	return out;
}

interface Ran {
	code: number | null;
	stdout: string;
	stderr: string;
	stopped: boolean;
}

/** Run a command to its end; a stop request sends it SIGTERM (the trainer then stops its own child at once). */
function run(
	cmd: readonly string[],
	args: readonly string[],
	env: Record<string, string>,
	signal?: AbortSignal,
): Promise<Ran> {
	return new Promise((done, fail) => {
		const child = spawn(cmd[0]!, [...cmd.slice(1), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let stopped = false;
		const stop = () => {
			stopped = true;
			child.kill("SIGTERM");
		};
		child.stdout.on("data", (d: Buffer) => {
			stdout = (stdout + d.toString("utf8")).slice(-65_536);
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr = (stderr + d.toString("utf8")).slice(-4000);
		});
		child.once("error", (err) => {
			signal?.removeEventListener("abort", stop);
			fail(err);
		});
		child.once("close", (code) => {
			signal?.removeEventListener("abort", stop);
			done({ code, stdout, stderr, stopped });
		});
		if (signal?.aborted) stop();
		else signal?.addEventListener("abort", stop, { once: true });
	});
}

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";
const tail = (text: string) => text.trim().split("\n").slice(-3).join(" | ").slice(-400);

class Stopped extends Error {}
class Failed extends Error {}

/** The candidate the trainer says it wrote, checked: in its place, whole, trained from this pin on exactly this file. */
function checkCandidate(
	stateDir: string,
	said: { id?: unknown; dir?: unknown },
	parent: string,
	trainFile: string,
): { id: string; dir: string; manifestSha256: string; manifest: Record<string, unknown> } {
	const id = typeof said.id === "string" ? said.id : "";
	const dir = ownDirectory(candidatesDir(stateDir), id);
	if (!CANDIDATE_ID.test(id) || !dir || typeof said.dir !== "string" || resolve(said.dir) !== resolve(dir))
		throw new Failed("the trainer did not name a candidate in the candidates directory");
	let text: string;
	try {
		text = readFileSync(join(dir, "manifest.json"), "utf8");
	} catch {
		throw new Failed("the candidate has no manifest");
	}
	const manifest = JSON.parse(text) as {
		state?: string;
		parent?: { requested?: string };
		data?: { sha256?: string };
	};
	const data = createHash("sha256").update(readFileSync(trainFile)).digest("hex");
	if (manifest.state !== "candidate" || manifest.parent?.requested !== parent || manifest.data?.sha256 !== data)
		throw new Failed("the candidate's manifest does not name this session's parent and training file");
	return { id, dir, manifestSha256: createHash("sha256").update(text).digest("hex"), manifest };
}

/**
 * How many records Kev's trainer left out because their state is longer than the training limit: it only
 * says so in its log ("dropped 3 of 153 records that exceed the training context"). Null when the log is not there.
 */
function droppedRecords(candidateDir: string): number | null {
	let log: string;
	try {
		log = readFileSync(join(candidateDir, "train.log"), "utf8");
	} catch {
		return null;
	}
	const m = /^dropped (\d+) of \d+ records that exceed the training context/m.exec(log);
	return m ? Number(m[1]) : 0;
}

interface Prediction {
	id: string;
	probabilities: Record<string, Record<string, number>>;
	logits?: Record<string, Record<string, number>> | null;
}

/** Why a fit is not one to serve with, in words. */
function unreliable(fit: TemperatureFit): string {
	return [
		fit.n < MIN_FIT_LABELS ? `only ${fit.n} validation label(s), ${MIN_FIT_LABELS} are needed` : null,
		fit.at_bound ? "it sits at the edge of the range tried" : null,
	]
		.filter(Boolean)
		.join(" and ");
}

/** What the calibration came to, for the owner. */
function calibrationText(fit: TemperatureFit | null): string {
	if (!fit) return "no validation labels of the trained question(s), so no temperature was fitted";
	const nll = `(mean NLL ${fit.nll_raw.toFixed(3)} → ${fit.nll_fitted.toFixed(3)})`;
	// A fit recorded before 2026-11-15 used every validation question and was registered as it came.
	if (fit.reliable === undefined)
		return `temperature ${fit.temperature.toFixed(2)} on ${fit.n} validation label(s) of every question, trained on or not ${nll}: fitted the old way, do not rely on it`;
	const figures = `${fit.temperature.toFixed(2)} on ${fit.n} validation label(s) of the trained question(s) ${nll}`;
	return fit.reliable
		? `temperature ${figures}`
		: `no temperature registered: the fit, ${figures}, cannot be relied on (${unreliable(fit)})`;
}

/** The validation labels joined to the candidate's raw answers, by record id and question (some questions only, if asked). */
export function rawAnswers(
	validationJsonl: string,
	predictions: readonly Prediction[],
	keep: (role: string, question: string) => boolean = () => true,
): RawAnswer[] {
	const byId = new Map(predictions.map((p) => [p.id, p]));
	const rows: RawAnswer[] = [];
	for (const line of validationJsonl.split("\n").filter(Boolean)) {
		const r = JSON.parse(line) as {
			_meta: { id: string; source: string };
			questions: Record<string, { label: boolean }>;
		};
		const p = byId.get(r._meta.id);
		if (!p) throw new Failed(`the scorer gave no answer for a validation record`);
		const role = r._meta.source.replace(/^iyye_/, "");
		for (const [q, { label }] of Object.entries(r.questions)) {
			if (!keep(role, q)) continue;
			const z = p.logits?.[q];
			const yes = p.probabilities[q]?.true;
			if (z && typeof z.true === "number" && typeof z.false === "number")
				rows.push({ margin: z.true - z.false, label });
			else if (typeof yes === "number") rows.push({ margin: marginOf(yes), label });
			else throw new Failed(`the scorer gave no yes/no answer for ${q}`);
		}
	}
	return rows;
}

export async function runTrainingSession(d: SessionDeps): Promise<SessionResult> {
	const now = d.now ?? (() => new Date());
	const say = d.say ?? (() => {});
	const s = d.settings;
	const none = (outcome: SessionOutcome, reason: string, exitCode: number): SessionResult => {
		say(`${outcome}: ${reason}`);
		return { outcome, reason, sessionId: null, artifactId: null, exitCode };
	};
	if (s.policy !== "on") return none("off", "decision training is off (IYYE2_DECISION_TRAINING)", 0);

	const lock = acquireHostLock(d.stateDir, TRAINING_HOLDER);
	if (!lock.ok)
		return none(
			"refused",
			`${lock.who} (pid ${lock.pid}) is using ${d.stateDir}: stop Iyye first; training never runs beside it`,
			3,
		);
	let db: Db | null = null;
	const sessionId = (d.newId ?? (() => crypto.randomUUID()))();
	const exportDir = join(sessionsDir(d.stateDir), sessionId);
	let candidateDir: string | null = null;
	let recorded = false;
	const end = (outcome: "skipped" | "stopped" | "failed", reason: string, more: Record<string, unknown> = {}) => {
		db!
			.prepare(
				"UPDATE decision_training_sessions SET ended_at = ?, outcome = ?, reason = ?, summary_json = ? WHERE id = ?",
			)
			.run(now().toISOString(), outcome, reason, JSON.stringify(more), sessionId);
		say(`${outcome}: ${reason}`);
		return {
			outcome,
			reason,
			sessionId,
			artifactId: null,
			exitCode: outcome === "skipped" ? 0 : outcome === "stopped" ? 143 : 1,
		} satisfies SessionResult;
	};
	try {
		for (const p of d.ports)
			if (await d.listening(p.port))
				return none("refused", `${p.name} is still listening on port ${p.port}: stop Iyye's services first`, 3);

		db = d.openDb();
		const left = cleanLeftovers(db, d.stateDir, now());
		if (Object.values(left).some((n) => n > 0))
			say(
				`cleaned up after an unfinished session: ${left.candidates} unregistered candidate(s), ${left.partial} partial run(s), ${left.exports} exported file set(s), ${left.sessions} session record(s) closed, ${left.failedLogs} old failure log(s)`,
			);
		db.prepare("INSERT INTO decision_training_sessions (id, started_at) VALUES (?, ?)").run(
			sessionId,
			now().toISOString(),
		);
		recorded = true;
		const stopIfAsked = () => {
			if (d.signal?.aborted) throw new Stopped("asked to stop");
		};

		// Eligibility, on a cut that writes nothing: a session that will not train freezes no dataset.
		const policy = datasetPolicy({ testLooks: s.testLooks });
		const plan = planDataset(db, { policy, now: now() });
		const may = eligibility(db, plan, s);
		if (!may.ok) return end("skipped", may.reason);
		const { questions } = may;
		const replaying = s.replayPerExample > 0;
		if (replaying && !d.suiteDir)
			return end("skipped", "Kev's replay suite is not provisioned (decision-worker/provision_suite.py)");
		const available = d.availableGb();
		if (available < s.minFreeGb)
			return end(
				"skipped",
				`${available.toFixed(1)} GB of memory available; ${s.minFreeGb} GB are needed (is something of Iyye's still running?)`,
				{ available_gb: available },
			);
		stopIfAsked();
		if (d.checkOnly)
			return end(
				"skipped",
				`a check only: a session would train on ${named(questions)}; ${available.toFixed(1)} GB of memory available`,
				{ available_gb: available },
			);

		// The dataset, frozen; the files the run reads. The test set stays in the database.
		const frozen = freezeDataset(db, { policy, now: now(), by: `session ${sessionId}` });
		if (!frozen.ok) return end("skipped", frozen.reason);
		db.prepare("UPDATE decision_training_sessions SET dataset_id = ? WHERE id = ?").run(frozen.id, sessionId);
		say(describeDataset(frozen.manifest, frozen.hash));
		const wanted = new Set(questions.map((q) => `${q.role}|${q.question}`));
		const files = writeDataset(db, frozen.id, exportDir, { train: (role, q) => wanted.has(`${role}|${q}`) });
		const own = files.counts.train ?? 0;
		const replay = replaying ? Math.min(20_000, s.replayPerExample * own) : 0;
		const steps = trainingSteps(own, replay, s.epochs);
		say(
			`training on ${named(questions)}: ${own} example(s)${replay ? ` and ${replay} of Kev's own` : ""}, ${steps} step(s), at most ${s.maxMinutes} min, from ${s.parent}`,
		);

		const started = Date.now();
		const trained = await run(
			d.trainCommand,
			[
				"--data",
				files.files.train!,
				"--parent",
				s.parent,
				"--steps",
				String(steps),
				"--max-minutes",
				String(s.maxMinutes),
				"--batch",
				String(BATCH),
				"--accum",
				String(ACCUM),
				"--seed",
				"0",
				"--out-root",
				candidatesDir(d.stateDir),
				"--label",
				`session ${sessionId}`,
				...(replay ? ["--suite", d.suiteDir!, "--replay", String(replay)] : []),
				...(s.maxState ? ["--max-state", String(s.maxState)] : []),
			],
			d.env,
			d.signal,
		);
		if (trained.stopped || trained.code === 143)
			throw new Stopped(trained.stopped ? "asked to stop during training" : "the time budget ran out");
		let said: { id?: unknown; dir?: unknown; resources?: Record<string, unknown> } = {};
		try {
			said = JSON.parse(lastLine(trained.stdout)) as typeof said;
		} catch {
			// Not a candidate line: the exit code and the log say why.
		}
		// Whatever the trainer named is this session's to delete if the session does not register it.
		if (typeof said.id === "string" && CANDIDATE_ID.test(said.id))
			candidateDir = ownDirectory(candidatesDir(d.stateDir), said.id);
		if (trained.code !== 0)
			throw new Failed(`the trainer exited ${trained.code}: ${tail(trained.stderr) || "no message"}`);
		const candidate = checkCandidate(d.stateDir, said, s.parent, files.files.train!);
		candidateDir = candidate.dir;
		stopIfAsked();

		// Calibration: the candidate's raw answers on validation, and nothing else.
		let fit: TemperatureFit | null = null;
		if ((files.counts.validation ?? 0) > 0) {
			const out = join(exportDir, "validation-raw.json");
			const scored = await run(
				d.predictCommand,
				// The serving limits, not the training ones: a temperature is for what the served model answers, and it
				// answers states far longer than the 384 tokens a strict training-context scorer refuses (2026-11-15).
				[
					"--run",
					candidate.dir,
					"--records",
					files.files.validation!,
					"--out",
					out,
					"--raw",
					"--context",
					"serving",
				],
				d.env,
				d.signal,
			);
			if (scored.stopped) throw new Stopped("asked to stop during calibration");
			if (scored.code !== 0)
				throw new Failed(`the scorer exited ${scored.code}: ${tail(scored.stderr) || "no message"}`);
			const answers = JSON.parse(readFileSync(out, "utf8")) as { predictions: Prediction[] };
			// Only the questions it was trained on: what it answers about the others is the released model's
			// doing, right or wrong, and must not set the temperature of what it learned (2026-11-15).
			fit = fitTemperature(
				rawAnswers(readFileSync(files.files.validation!, "utf8"), answers.predictions, (role, q) =>
					wanted.has(`${role}|${q}`),
				),
			);
		}
		stopIfAsked();

		const at = now().toISOString();
		const dropped = droppedRecords(candidate.dir);
		if (dropped)
			say(
				`${dropped} record(s) were longer than the training limit and were not trained on (IYYE2_TRAIN_MAX_STATE, now ${s.maxState || "Kev's 384"} tokens)`,
			);
		const training = {
			steps,
			own_examples: own,
			dropped_records: dropped,
			replay_records: replay,
			epochs: s.epochs,
			max_state: s.maxState || null,
			minutes: Math.round((Date.now() - started) / 6000) / 10,
			available_gb_before: Math.round(available * 10) / 10,
			resources: said.resources ?? null,
		};
		db.transaction(() => {
			db!
				.prepare(
					`INSERT INTO decision_artifacts (id, state, parent, dataset_id, dataset_hash, manifest_sha256, trained_json,
						temperature, calibration_json, training_json, session_id, created_at)
					 VALUES (?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					candidate.id,
					s.parent,
					frozen.id,
					frozen.hash,
					candidate.manifestSha256,
					JSON.stringify(questions),
					// A temperature is registered only when the fit can be relied on; the fit itself is always kept.
					fit?.reliable ? fit.temperature : null,
					fit ? JSON.stringify(fit) : null,
					JSON.stringify(training),
					sessionId,
					at,
				);
			db!
				.prepare(
					"UPDATE decision_training_sessions SET ended_at = ?, outcome = 'candidate', artifact_id = ?, summary_json = ? WHERE id = ?",
				)
				.run(at, candidate.id, JSON.stringify({ trained: questions, ...training, calibration: fit }), sessionId);
		})();
		candidateDir = null; // registered: it stays
		say(
			`candidate ${candidate.id} registered: ${steps} step(s) in ${training.minutes} min; ` +
				calibrationText(fit) +
				". It is not evaluated, served or active.",
		);
		return { outcome: "candidate", reason: null, sessionId, artifactId: candidate.id, exitCode: 0 };
	} catch (err) {
		if (!db || !recorded) throw err;
		const reason = (err as Error).message;
		return end(err instanceof Stopped ? "stopped" : "failed", reason);
	} finally {
		// The exported files hold what people said; an unregistered candidate is never kept.
		try {
			deleteDatasetFiles(exportDir);
			rmSync(exportDir, { recursive: true, force: true });
			if (candidateDir) rmSync(candidateDir, { recursive: true, force: true });
			// A trainer that was killed could not remove its own partial run; no other run exists while we hold the lock.
			if (db) removePartialRuns(d.stateDir);
		} finally {
			db?.close();
			releaseHostLock(d.stateDir);
		}
	}
}

interface SessionRow {
	id: string;
	started_at: string;
	ended_at: string | null;
	outcome: string | null;
	reason: string | null;
	artifact_id: string | null;
	summary_json: string | null;
}

/** `/decisions learning`: the last sessions and what the registry holds. Records only. */
export function learningReport(
	db: Db,
	s: Pick<TrainingSettings, "policy" | "minNewLabels" | "minPerClass" | "testLooks">,
	now: Date = new Date(),
): string {
	const lines = [
		`decision learning: ${s.policy === "on" ? "on" : "off (IYYE2_DECISION_TRAINING)"}; a session runs only while Iyye is stopped (host/scripts/decisions-train.ts)`,
	];
	// What a session would find now, from the records (it would also check the memory, with Iyye stopped).
	const may = eligibility(db, planDataset(db, { policy: datasetPolicy({ testLooks: s.testLooks }), now }), s);
	lines.push(
		may.ok
			? `a session now would train on ${named(may.questions)}; ${may.fresh} owner label(s) since the last candidate`
			: `a session now would be skipped: ${may.reason}`,
	);
	const sessions = db
		.prepare("SELECT * FROM decision_training_sessions ORDER BY started_at DESC LIMIT 7")
		.all() as SessionRow[];
	if (sessions.length === 0) lines.push("no session has run yet");
	else lines.push("the last sessions:");
	for (const r of sessions) {
		const when = r.started_at.slice(0, 16).replace("T", " ");
		if (r.outcome === "candidate") {
			const sum = JSON.parse(r.summary_json ?? "{}") as {
				trained?: Trainable[];
				steps?: number;
				minutes?: number;
				calibration?: TemperatureFit | null;
			};
			lines.push(
				`  ${when}Z candidate ${r.artifact_id}: trained on ${named(sum.trained ?? [])}; ${sum.steps} step(s), ${sum.minutes} min; ` +
					calibrationText(sum.calibration ?? null),
			);
		} else lines.push(`  ${when}Z ${r.outcome ?? "running, or killed"}${r.reason ? `: ${r.reason}` : ""}`);
	}
	const states = db
		.prepare("SELECT state, count(*) AS n FROM decision_artifacts GROUP BY state ORDER BY state")
		.all() as { state: string; n: number }[];
	lines.push(
		states.length
			? `registry: ${states.map((x) => `${x.n} ${x.state}`).join(", ")}. A candidate is not evaluated, served or active: evaluation and activation are not built yet.`
			: "registry: empty",
	);
	return lines.join("\n");
}
