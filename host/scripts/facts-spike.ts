// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.011 F0: measure structured fact extraction on real turns.
 *
 *   node scripts/facts-spike.ts --db <copy of iyye.db> --labels <labels.json> --out <dir>
 *        [--models gemma-4-E4B,gemma-4-26B] [--variants closed,free] [--port 8191] [--llama-server <path>]
 *
 * It starts its own llama.cpp router on a free port with an empty cache,
 * loads one registry model at a time, runs every labelled item through the
 * extraction prompt (`src/facts/extract.ts`), and scores the kept facts
 * against the labels: recall, strict precision, JSON failures, grounding and
 * filter drops (by language), latency, and key stability (the same fact said
 * twice gets the same key). It never touches ~/.iyye2 or a running host; the
 * database must be a copy. Raw outputs and the facts left unmatched (for a
 * manual precision review) go to `--out`, which must stay out of the repo.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expandHome, PROJECT_ROOT } from "../src/config.ts";
import {
	type ExtractedFact,
	type ExtractionDoc,
	extractionInput,
	extractionPrompt,
	type KnownPerson,
	parseFacts,
	processFacts,
} from "../src/facts/extract.ts";
import { loadRegistry } from "../src/models/registry.ts";

interface Label {
	s: string[];
	o: string[];
	g?: string;
}
interface Item {
	id: string;
	doc: ExtractionDoc;
	expect: Label[];
	lang: "en" | "ru";
}

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const dbPath = opt("--db");
const labelsPath = opt("--labels");
const outDir = opt("--out");
if (!dbPath || !labelsPath || !outDir) {
	console.error("usage: node scripts/facts-spike.ts --db <copy> --labels <labels.json> --out <dir> [--models a,b]");
	process.exit(2);
}
const models = (opt("--models", "gemma-4-E4B") ?? "").split(",");
const variants = (opt("--variants", "closed,free") ?? "").split(",") as ("closed" | "free")[];
const port = Number(opt("--port", "8191"));
const binary = expandHome(opt("--llama-server", "~/Downloads/llama.cpp/build_27/bin/llama-server")!);
const base = `http://127.0.0.1:${port}`;
const scratch = mkdtempSync(join(tmpdir(), "iyye-facts-spike-"));
let router: ChildProcess | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadItems(): { items: Item[]; people: KnownPerson[] } {
	const db = new DatabaseSync(dbPath!, { readOnly: true });
	const rows = db
		.prepare(
			"SELECT event_id, kind, scope, contact_id, user_text, reply_text, said_at FROM stm_episodes ORDER BY said_at",
		)
		.all() as {
		event_id: string;
		kind: string;
		scope: string;
		contact_id: string | null;
		user_text: string;
		reply_text: string;
		said_at: string;
	}[];
	const contacts = db.prepare("SELECT id, display_name, kind FROM contacts").all() as {
		id: string;
		display_name: string;
		kind: string;
	}[];
	const links = new Map(
		(
			db.prepare("SELECT account_id, person_id FROM contact_links").all() as {
				account_id: string;
				person_id: string;
			}[]
		).map((l) => [l.account_id, l.person_id]),
	);
	// People are persons, not accounts: an account linked to the owner is the owner (its name is not a person's).
	const people: KnownPerson[] = contacts
		.filter((c) => c.kind === "owner" || !links.has(c.id))
		.map((c) => ({
			id: c.kind === "owner" ? "owner" : c.id,
			name: c.kind === "owner" ? "the owner" : c.display_name,
		}));
	const person = (contactId: string | null, scope: string): { speaker: string; speakerId: string } => {
		const id = scope === "owner" ? "owner" : (links.get(contactId ?? "") ?? contactId ?? "unknown");
		if (id === "owner") return { speaker: "the owner", speakerId: "owner" };
		return { speaker: contacts.find((c) => c.id === id)?.display_name ?? "a contact", speakerId: id };
	};
	const labels = JSON.parse(readFileSync(labelsPath!, "utf8")) as {
		items: { i: number; kind: ExtractionDoc["kind"]; expect: Label[] }[];
		synthetic_ru: { id: string; speaker: string; at: string; text: string; expect: Label[] }[];
	};
	const items: Item[] = labels.items.map((l) => {
		const r = rows[l.i]!;
		const who = person(r.contact_id, r.scope);
		const doc: ExtractionDoc =
			l.kind === "person"
				? { kind: "person", text: r.user_text, ...who, at: r.said_at }
				: l.kind === "reply"
					? {
							kind: "reply",
							text: r.reply_text,
							speaker: "Iyye",
							speakerId: null,
							recipient: who.speaker,
							asked: r.user_text,
							at: r.said_at,
						}
					: { kind: "finding", text: r.user_text, speaker: "Iyye's probe", speakerId: null, at: r.said_at };
		return { id: `${l.kind}#${l.i}`, doc, expect: l.expect, lang: /[а-яё]/i.test(doc.text) ? "ru" : "en" };
	});
	const jacob = people.find((p) => p.name === "Jacob");
	for (const s of labels.synthetic_ru) {
		const who =
			s.speaker === "owner" || !jacob
				? { speaker: "the owner", speakerId: "owner" }
				: { speaker: "Jacob", speakerId: jacob.id };
		items.push({
			id: `ru:${s.id}`,
			doc: { kind: "person", text: s.text, ...who, at: s.at },
			expect: s.expect,
			lang: "ru",
		});
	}
	db.close();
	return { items, people };
}

async function portBusy(p: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createConnection({ host: "127.0.0.1", port: p });
		s.once("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.once("error", () => resolve(false));
	});
}

async function req(
	method: string,
	path: string,
	body?: unknown,
	timeoutMs = 10_000,
): Promise<{ status: number; json: unknown }> {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	try {
		return { status: res.status, json: JSON.parse(text) };
	} catch {
		return { status: res.status, json: text };
	}
}

async function startRouter(specs: { name: string; path: string; serverArgs: Record<string, unknown> }[]) {
	const preset = join(scratch, "models.ini");
	writeFileSync(
		preset,
		`version = 1\n\n${specs
			.map(
				(m) =>
					`[${m.name}]\nmodel = ${m.path}\nc = 16384\nnp = 1\nstop-timeout = 5\n${Object.entries(m.serverArgs)
						.filter(([k]) => k !== "c")
						.map(([k, v]) => `${k} = ${v}\n`)
						.join("")}`,
			)
			.join("\n")}`,
	);
	router = spawn(
		binary,
		[
			"--models-preset",
			preset,
			"--no-models-autoload",
			"--models-max",
			"1",
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
		],
		{
			stdio: ["ignore", "ignore", "ignore"],
			env: { PATH: process.env.PATH, HOME: process.env.HOME, LLAMA_CACHE: join(scratch, "cache") },
		},
	);
	for (let i = 0; i < 120; i++) {
		try {
			if ((await req("GET", "/health", undefined, 1000)).status === 200) return;
		} catch {
			// not up yet
		}
		await sleep(250);
	}
	throw new Error("router did not become healthy");
}

async function load(model: string): Promise<void> {
	await req("POST", "/models/load", { model });
	for (let i = 0; i < 1200; i++) {
		const r = await req("GET", "/models");
		const m = (r.json as { data: { id: string; status: { value: string; failed?: boolean } }[] }).data.find(
			(x) => x.id === model,
		);
		if (m?.status.value === "loaded") return;
		if (m?.status.failed) throw new Error(`${model} failed to load`);
		await sleep(500);
	}
	throw new Error(`${model} did not load`);
}

async function complete(model: string, system: string, user: string): Promise<{ text: string; ms: number }> {
	const t0 = Date.now();
	const r = await req(
		"POST",
		"/v1/chat/completions",
		{
			model,
			stream: false,
			max_tokens: 1200,
			temperature: 0,
			chat_template_kwargs: { enable_thinking: false },
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
		},
		600_000,
	);
	const text = (r.json as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
	return { text, ms: Date.now() - t0 };
}

function matches(f: ExtractedFact, l: Label): boolean {
	const subj = `${f.subjectRef} ${f.subject}`.toLowerCase();
	const body = `${f.object} ${f.details ?? ""} ${f.predicate}`.toLowerCase();
	const subjOk = l.s.some((s) => subj.includes(s) || (s === "jacob" && subj.includes("yakov")));
	return subjOk && l.o.some((o) => body.includes(o.toLowerCase()));
}

interface Run {
	model: string;
	variant: string;
	items: {
		id: string;
		lang: string;
		ms: number;
		raw: string;
		bad: number;
		kept: ExtractedFact[];
		dropped: { why: string; fact: unknown }[];
	}[];
}

function score(run: Run, items: Item[], peopleJacob: string | undefined) {
	let labels = 0;
	let found = 0;
	let kept = 0;
	let keptMatched = 0;
	let bad = 0;
	const dropped: Record<string, Record<string, number>> = { en: {}, ru: {} };
	const groups = new Map<string, Set<string>>();
	const unmatched: { id: string; fact: string; key: string }[] = [];
	const missed: { id: string; label: Label }[] = [];
	const ms: number[] = [];
	for (const r of run.items) {
		const item = items.find((i) => i.id === r.id)!;
		ms.push(r.ms);
		bad += r.bad;
		for (const d of r.dropped) {
			const why = d.why.replace(/ [^ ]+ is not in the source$/, " X is not in the source");
			dropped[r.lang]![why] = (dropped[r.lang]![why] ?? 0) + 1;
		}
		kept += r.kept.length;
		const used = new Set<number>();
		for (const l of item.expect) {
			labels++;
			const hit = r.kept.findIndex((f) => matches(f, l));
			if (hit >= 0) {
				found++;
				used.add(hit);
				if (l.g) {
					const set = groups.get(l.g) ?? new Set<string>();
					set.add(r.kept[hit]!.key.replace(peopleJacob ?? "\u0000", "jacob"));
					groups.set(l.g, set);
				}
			} else missed.push({ id: r.id, label: l });
		}
		r.kept.forEach((f, i) => {
			if (used.has(i) || item.expect.some((l) => matches(f, l))) keptMatched++;
			else
				unmatched.push({
					id: r.id,
					fact: `${f.subject} | ${f.predicate} | ${f.object}${f.details ? ` (${f.details})` : ""}`,
					key: f.key,
				});
		});
	}
	const sorted = [...ms].sort((a, b) => a - b);
	const stable = [...groups.values()];
	return {
		model: run.model,
		variant: run.variant,
		items: run.items.length,
		labels,
		recall: +(found / labels).toFixed(3),
		kept,
		strictPrecision: +(keptMatched / Math.max(1, kept)).toFixed(3),
		jsonBadLines: bad,
		dropped,
		latencyMs: {
			median: sorted[Math.floor(sorted.length / 2)],
			max: sorted.at(-1),
			total: ms.reduce((a, b) => a + b, 0),
		},
		keyStability: {
			groups: stable.length,
			oneKey: stable.filter((s) => s.size === 1).length,
			keys: Object.fromEntries([...groups].map(([g, s]) => [g, [...s]])),
		},
		unmatched,
		missed,
	};
}

async function main() {
	if (await portBusy(port)) throw new Error(`port ${port} is in use; pick another with --port`);
	mkdirSync(outDir!, { recursive: true });
	const { items, people } = loadItems();
	const registry = loadRegistry(join(PROJECT_ROOT, "config/models.json"));
	const specs = models.map((name) => {
		const s = registry.models.find((m) => m.name === name);
		if (!s?.available) throw new Error(`${name} is not an available registry model`);
		return { name: s.name, path: s.path, serverArgs: s.serverArgs };
	});
	await startRouter(specs);
	const summary = [];
	for (const spec of specs) {
		const t0 = Date.now();
		await load(spec.name);
		const loadMs = Date.now() - t0;
		for (const variant of variants) {
			const run: Run = { model: spec.name, variant, items: [] };
			for (const item of items) {
				const { text, ms } = await complete(
					spec.name,
					extractionPrompt(item.doc.kind, variant),
					extractionInput(item.doc),
				);
				const parsed = parseFacts(text);
				const p = processFacts(parsed.facts, item.doc, people);
				run.items.push({
					id: item.id,
					lang: item.lang,
					ms,
					raw: text,
					bad: parsed.bad,
					kept: p.kept,
					dropped: p.dropped,
				});
				process.stderr.write(".");
			}
			process.stderr.write(`\n${spec.name} ${variant} done\n`);
			writeFileSync(join(outDir!, `${spec.name}-${variant}.json`), JSON.stringify(run, null, 1));
			const s = score(run, items, people.find((p) => p.name === "Jacob")?.id);
			writeFileSync(join(outDir!, `${spec.name}-${variant}.score.json`), JSON.stringify(s, null, 1));
			summary.push({ ...s, loadMs, unmatched: s.unmatched.length, missed: s.missed.length });
		}
		await req("POST", "/models/unload", { model: spec.name });
		await sleep(3000);
	}
	console.log(JSON.stringify(summary, null, 2));
}

main()
	.catch((err) => {
		console.error((err as Error).message);
		process.exitCode = 1;
	})
	.finally(async () => {
		if (router) {
			const r = router;
			router = null;
			const exited = new Promise((resolve) => r.once("exit", resolve));
			r.kill("SIGTERM");
			await Promise.race([exited, sleep(30_000)]);
		}
		rmSync(scratch, { recursive: true, force: true });
	});
