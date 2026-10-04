// K0 probe: the two shadow roles over labelled turns, plus latency. Read-only on ~/.iyye2/iyye.db.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEY = readFileSync(join(homedir(), ".iyye2/decisions/secrets/kev_api_key"), "utf8").trim();
const URL = "http://127.0.0.1:8188/v1/systemone";
const ask = async (state, questions) => {
	const t = performance.now();
	const res = await fetch(URL, {
		method: "POST",
		headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
		body: JSON.stringify({ model: "kev-latest", state, questions }),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 300)}`);
	return { ms: performance.now() - t, body };
};

const SALIENCE = {
	type: "noul",
	instructions:
		"The state is one message a person sent to their personal assistant. Does it contain something worth remembering long-term about the person or the people, places, plans, preferences or facts in their life, beyond small talk, greetings, thanks or a one-off question?",
};
const PROMISE = {
	type: "noul",
	instructions:
		"The state is an assistant's reply. Does the reply promise or offer a future action the assistant would take later on its own, such as a reminder, a follow-up, flagging or watching for something, or contacting someone?",
};
const ANSWERS = {
	type: "score",
	instructions: "The state is a person's message and the assistant's reply. How well does the reply address the message?",
	criteria: ["does not address it", "partly addresses it", "fully addresses it"],
};

const db = join(homedir(), ".iyye2/iyye.db");
const q = (sql) => JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8" }) || "[]");

// Salience: [text, expected worth-keeping?, label source]
const salience = [
	["My daughter Julia has violin lessons on Tuesdays.", true, "night smoke: completed"],
	["What's 2+2?", false, "night smoke: completed_empty"],
	["Thanks!", false, "night smoke: completed_empty"],
	["My brother Alex lives in Berlin and visits in December.", true, "night smoke: completed"],
	["Моя мама живёт в Чебоксарах.", true, "night smoke: completed"],
	["Actually Alex's visit moved to January.", true, "night smoke: completed"],
	["Hello Iyye, this is Alex.", false, "hand label"],
	["What time is it?", false, "hand label"],
	["ok", false, "hand label"],
	["I'm allergic to peanuts.", true, "hand label"],
	["Я не пью кофе с сахаром.", true, "hand label"],
	["Can you tell me a joke?", false, "hand label"],
	...q("SELECT user_text AS t, state FROM stm_episodes").map((r) => [r.t, r.state === "completed", `live: ${r.state}`]),
];
const promises = [
	["Thanks — noted. If Jacob ever writes anything that worries me, I'll flag it rather than handle it like an adult conversation. Fair?", true, "the 2026-10-02 incident"],
	["Sure, I'll remind you tomorrow at 9 to call your mother.", true, "hand label"],
	["I'll keep an eye on the disk space and let you know if it gets low.", true, "hand label"],
	["It's 14:05 in Berlin right now.", false, "hand label"],
	["Your brother Alex lives in Berlin.", false, "hand label"],
	["I can't set reminders yet, but you could use your phone's alarm.", false, "hand label"],
];

const pct = (x) => `${(x * 100).toFixed(0)}%`;
for (const [name, rows, question] of [
	["salience", salience, SALIENCE],
	["promise", promises, PROMISE],
]) {
	let agree = 0;
	console.log(`\n== ${name}`);
	for (const [text, want, src] of rows) {
		const { ms, body } = await ask(text, { q: question });
		const p = body.answers?.q?.noul ?? body.answers?.q?.probability ?? NaN;
		const got = p >= 0.5;
		if (got === want) agree++;
		console.log(`${got === want ? "  " : "✗ "}p=${p.toFixed(2)} want=${want ? "yes" : "no "} ${ms.toFixed(0).padStart(5)} ms  ${src.padEnd(26)} ${text.slice(0, 70)}`);
	}
	console.log(`agreement ${agree}/${rows.length} (${pct(agree / rows.length)})`);
}

// Reply review on the live delivered replies.
console.log("\n== reply review (live replies)");
const replies = q(
	"SELECT a.content AS reply, e.payload_json AS p FROM actions a JOIN events e ON e.id = a.event_id WHERE a.kind = 'reply' AND a.state = 'delivered' ORDER BY a.created_at",
);
for (const r of replies) {
	const p = JSON.parse(r.p);
	const msg = p.text ?? p.message?.text ?? "";
	const { ms, body } = await ask(
		{ message: msg, reply: r.reply },
		{ promise: PROMISE, answers: ANSWERS },
	);
	const a = body.answers;
	console.log(`promise p=${a.promise.noul.toFixed(2)} answers=${a.answers.score.toFixed(2)} ${ms.toFixed(0).padStart(5)} ms  ${msg.slice(0, 50)} → ${r.reply.slice(0, 50).replace(/\n/g, " ")}`);
}

// Latency: a new ~300-token state, then the same state again (prefix cache).
const long = `${salience.map((s) => s[0]).join(" ")} `.repeat(3);
const first = await ask(long, { a: SALIENCE, b: PROMISE });
const again = await ask(long, { a: SALIENCE, b: PROMISE });
console.log(`\nlatency, 2 questions on a ${long.length}-char state: new ${first.ms.toFixed(0)} ms, cached ${again.ms.toFixed(0)} ms; usage ${JSON.stringify(first.body.usage)}`);
