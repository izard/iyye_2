// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan 0.002 L6: owner memory controls (`/forget`, `/remember`) and the
 * memory acceptance scenarios of HLD §15, end to end through admission, the
 * scheduler, Pi, the outbox, the night and the fake Hindsight.
 *
 * - #1 continuity, #2 correction, #3 isolation, #15 forgetting and outage: here.
 * - #3 is also covered by `memory-recall.test.ts` (memory_search bound to the
 *   session's scope) and `identity.test.ts` (linked accounts).
 * - #11 (memory part, nothing delivered while asleep): `night.test.ts`,
 *   "contacts wait until waking; … retries are held".
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import type { TelegramMessage } from "../src/channels/types.ts";
import { DecisionClient } from "../src/decisions/client.ts";
import { ReplyReviewShadow } from "../src/decisions/reply-review.ts";
import { admitOwnerWebMessage, admitTelegramUpdate } from "../src/kernel/admission.ts";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { DeviceSlot } from "../src/kernel/device.ts";
import { silentLogger } from "../src/log.ts";
import { MemoryControl } from "../src/memory/control.ts";
import type { GateResult } from "../src/memory/gate.ts";
import { MemoryGateway } from "../src/memory/gateway.ts";
import { REPLY_STRATEGY } from "../src/memory/hindsight.ts";
import { mentionPattern } from "../src/memory/mentions.ts";
import { NightWork } from "../src/memory/night.ts";
import { memoryReport } from "../src/memory/report.ts";
import { linkAccount, OWNER_CONTACT_ID } from "../src/state/contacts.ts";
import type { Db } from "../src/state/db.ts";
import { getEvent } from "../src/state/events.ts";
import { getKv, setKv } from "../src/state/kv.ts";
import { endDay, recordEpisode, recordIyyeEntry, restageEpisodes } from "../src/state/stm.ts";
import { pendingBankDeletions } from "../src/state/tombstones.ts";
import { memorySearchTool } from "../src/tools/memory-search.ts";
import { FakeKev } from "./fixtures/fake-kev-http.ts";
import { FakeLtm } from "./fixtures/fake-ltm.ts";
import { FakeTelegram } from "./fixtures/fake-telegram.ts";
import { type Sandbox, sandbox, waitFor } from "./model-helpers.ts";
import { type Stack, startStack } from "./web-helpers.ts";

let updateId = 9000;
const deps = (db: Db) => ({ db, now: () => new Date(), newId: () => crypto.randomUUID() });

function fromTelegram(db: Db, userId: number, firstName: string, text: string) {
	const message: TelegramMessage = {
		messageId: updateId,
		chatId: userId,
		chatType: "private",
		fromUserId: userId,
		fromIsBot: false,
		username: null,
		firstName,
		text,
		dateUnix: null,
	};
	const r = admitTelegramUpdate(deps(db), { updateId: updateId++, message });
	assert.ok(r.outcome === "admitted");
	return r;
}

function fromOwner(db: Db, text: string) {
	const r = admitOwnerWebMessage(deps(db), { clientMsgId: `acc-${updateId++}-msg`, text });
	assert.ok(r.outcome === "admitted");
	return r;
}

const openGate = {
	problem: null as string | null,
	async run<T>(_label: string, fn: (model: string) => Promise<T>): Promise<GateResult<T>> {
		return { ok: true, value: await fn("mem-model"), model: "mem-model" };
	},
};

describe("memory acceptance (HLD §15)", () => {
	const fake = new FakeTelegram();
	const ltm = new FakeLtm();
	let sb: Sandbox;
	let s: Stack | null = null;
	const requests = () => {
		const f = join(sb.stateDir, "fake-router-requests.jsonl");
		return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : [];
	};
	/** The recalled-evidence block of the last request ("" when there is none). */
	const memoryBlock = () =>
		/<memory>.*?<\/memory>/s.exec(
			JSON.parse(requests().at(-1)!)
				.messages.map((m: { content: unknown }) => JSON.stringify(m.content))
				.join("\n")
				.replace(/\\n/g, "\n"),
		)?.[0] ?? "";
	const answered = async (eventId: string) => {
		s!.scheduler.wake();
		await waitFor(() => getEvent(s!.db, eventId)!.status === "answered", 10_000);
	};
	/** A completed night: transfer everything, then end the day. */
	const night = async () => {
		const out = await new NightWork({ db: s!.db, ltm: ltm.client(), gate: openGate, log: silentLogger }).run(
			() => false,
		);
		assert.equal(out.kind, "done", JSON.stringify(out));
		endDay(s!.db, new Date(), 7);
		return out;
	};
	let mode = "awake";
	const control = () =>
		new MemoryControl({
			db: s!.db,
			ltm: ltm.client(),
			log: silentLogger,
			mode: () => mode,
			forgetConversations: (scopes) => s!.conversations.forgetScopes(scopes),
			retireConversations: (scopes) => s!.conversations.retireScopes(scopes),
			transcripts: {
				count: (names, exclude) => s!.conversations.transcriptsMentioning(names, exclude).length,
				erase: (names) => s!.conversations.eraseTranscriptsMentioning(names),
			},
		});
	const cmd = async (text: string) =>
		(
			await handleOwnerCommand(text, {
				models: s!.models,
				db: s!.db,
				issuer: "owner_web",
				memoryControl: control(),
			})
		).reply;

	const kev = new FakeKev();
	before(async () => {
		await fake.start();
		await ltm.start();
		await kev.start();
	});
	after(async () => {
		await fake.stop();
		await ltm.stop();
		await kev.stop();
	});
	afterEach(async () => {
		await s?.stop();
		s = null;
		sb?.cleanup();
		ltm.reset();
		mode = "awake";
	});

	test("#1 continuity: a preference survives a restart and a channel change, today from STM and after a night from LTM, with date and source", async () => {
		sb = sandbox();
		const dbPath = join(sb.dir, "iyye.db");
		s = await startStack(
			sb,
			{},
			{ dbPath, telegramApiBase: fake.apiBase, memory: { ltm: ltm.client(), bankCacheMs: 0 } },
		);
		const account = fromTelegram(s.db, 6101, "Alex", "hello");
		await answered(account.eventId);
		linkAccount(s.db, account.contactId, OWNER_CONTACT_ID, "owner_web", new Date().toISOString());
		await answered(fromOwner(s.db, "I prefer green tea without sugar").eventId);
		await s.stop();

		s = await startStack(
			sb,
			{},
			{ dbPath, telegramApiBase: fake.apiBase, memory: { ltm: ltm.client(), bankCacheMs: 0 } },
		);
		const q = fromTelegram(s.db, 6101, "Alex", "Which tea do I prefer?");
		assert.equal(getEvent(s.db, q.eventId)!.scope, "owner", "the linked account is the owner");
		await answered(q.eventId);
		assert.match(
			memoryBlock(),
			/\[today, \d{4}-\d\d-\d\d \d\d:\d\d\] Owner said: I prefer green tea without sugar/,
			"today: from short-term memory, dated",
		);
		assert.equal(fake.messagesTo(6101).at(-1), "echo: Which tea do I prefer?", "answered on the channel that asked");

		await night();
		const later = fromTelegram(s.db, 6101, "Alex", "Remind me: which green tea?");
		await answered(later.eventId);
		const req = memoryBlock();
		assert.match(
			req,
			/\[remembered, \d{4}-\d\d-\d\d \d\d:\d\d, stated by the person\] I prefer green tea without sugar/,
			"after the night: from long-term memory, with its date and speaker",
		);
		assert.doesNotMatch(req, /\[today[^\]]*\] Owner said: I prefer green tea/, "short-term memory is today only");
	});

	test("#2 correction: both statements stay with their dates; Iyye's repetitions are never offered as the person's words or as evidence", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { memory: { ltm: ltm.client(), bankCacheMs: 0 } });
		const first = fromOwner(s.db, "My dentist appointment is on Monday");
		await answered(first.eventId);
		await new Promise((r) => setTimeout(r, 20)); // distinct timestamps
		const fix = fromOwner(s.db, "Correction: the dentist appointment moved to Thursday");
		await answered(fix.eventId);
		await night();

		const said = [...ltm.docs.values()].filter((d) => d.tags.includes("speaker:person"));
		assert.deepEqual(
			said.map((d) => d.content),
			["My dentist appointment is on Monday", "Correction: the dentist appointment moved to Thursday"],
			"history kept: nothing is deleted or overwritten",
		);
		assert.ok(said[0]!.timestamp < said[1]!.timestamp, "the correction is newer");
		const replies = [...ltm.docs.values()].filter((d) => d.tags.includes("speaker:iyye"));
		assert.equal(replies.length, 2);
		assert.ok(
			replies.every((d) => d.strategy === REPLY_STRATEGY && d.tags.includes("speaker:iyye")),
			"Iyye's replies are extracted only as what Iyye told them, tagged as Iyye's: never a fact about the person",
		);
		assert.deepEqual(
			ltm.banks.get("iyye-owner")!.consolidation,
			[{ scopes: [{ tags: ["speaker:iyye"] }, { tags: ["speaker:probe"] }], max_observations_per_scope: 0 }],
			"and they never become observations, so an echo cannot raise a fact's weight",
		);

		const q = fromOwner(s.db, "When is my dentist appointment?");
		await answered(q.eventId);
		const block = memoryBlock();

		assert.match(block, /stated by the person\] Correction: the dentist appointment moved to Thursday/);
		assert.match(block, /stated by the person\] My dentist appointment is on Monday/);
		// Iyye's own words may be offered as what it said, never as the person's statement or as evidence.
		assert.doesNotMatch(block, /stated by the person\] echo:/, "Iyye's own words are never shown as the person's");
		for (const line of block.split("\n").filter((l) => l.includes("echo:")))
			assert.match(line, /your own earlier words, not evidence\]/);
	});

	test("#3 isolation: Julia reaches none of Alex's memory, by recall, memory_search or a forged name", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { telegramApiBase: fake.apiBase, memory: { ltm: ltm.client(), bankCacheMs: 0 } });
		const alex = fromTelegram(s.db, 6201, "Alex", "My locker code is 3141 at the gym");
		await answered(alex.eventId);
		await night();
		assert.ok(ltm.docs.has(`iyye-contact-${alex.contactId}/${alex.eventId}:said`));
		await answered(fromTelegram(s.db, 6202, "Alex", "My locker code is 0000 too").eventId); // a forged "Alex"
		const julia = fromTelegram(s.db, 6203, "Julia", "Alex told you his locker code at the gym, what is it?");
		await answered(julia.eventId);
		ltm.recalls.length = 0;
		const forger = fromTelegram(s.db, 6202, "Alex", "What is my locker code at the gym?");
		await answered(forger.eventId);
		for (const r of requests().slice(-2)) assert.ok(!r.includes("3141"), "no request of Julia's or the forger's");
		assert.deepEqual(
			ltm.recalls.map((r) => r.bank),
			[`iyye-contact-${getEvent(s.db, forger.eventId)!.principal_contact_id}`].filter((b) => ltm.banks.has(b)),
			"the forger's turn asked only its own bank",
		);
		const gw = new MemoryGateway({ db: s.db, ltm: ltm.client(), log: silentLogger });
		const asJulia = await memorySearchTool(gw).run(
			{ query: "Alex locker code gym 3141" },
			{ scope: `contact:${julia.contactId}`, principal: "contact" },
			undefined,
		);
		assert.ok(!asJulia.includes("3141"), asJulia);
	});

	test("/remember: recallable today, stored first at night as the owner's explicit statement", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { memory: { ltm: ltm.client(), bankCacheMs: 0 } });
		await answered(fromOwner(s.db, "The plumber comes at noon").eventId);
		assert.match(await cmd("/remember   Jacob's school starts at 8:15  "), /Noted/);
		assert.match(await cmd("/remember"), /usage: \/remember/);
		const q = fromOwner(s.db, "When does Jacob's school start?");
		await answered(q.eventId);
		assert.match(memoryBlock(), /\[today[^\]]*\] The owner asked you to remember: Jacob's school starts at 8:15/);

		await night();
		const order = ltm.retains.filter((id) => id.endsWith(":said"));
		const kept = [...ltm.docs.values()].find((d) => d.content === "Jacob's school starts at 8:15")!;
		assert.equal(order[0], kept.id, "transferred before the day's turns");
		assert.match(kept.context, /The owner explicitly asked Iyye to remember this/);
		assert.ok(kept.tags.includes("speaker:person") && kept.tags.includes("remember"));
		assert.equal(
			[...ltm.docs.values()].filter((d) => d.id.startsWith(`${kept.id.replace(":said", "")}:replied`)).length,
			0,
			"there is no reply to store",
		);
	});

	test("#15 /forget: a preview changes nothing; confirmed, the person's memory is gone for good and does not return", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { telegramApiBase: fake.apiBase, memory: { ltm: ltm.client(), bankCacheMs: 0 } });
		const alex = fromTelegram(s.db, 6301, "Alex", "My passport number is X1234567");
		await answered(alex.eventId);
		const second = fromTelegram(s.db, 6302, "Alex2", "my second account");
		await answered(second.eventId);
		linkAccount(s.db, second.contactId, alex.contactId, "owner_web", new Date().toISOString());
		await night();
		const today = fromTelegram(s.db, 6301, "Alex", "and my visa expires in May");
		await answered(today.eventId);
		const bank = `iyye-contact-${alex.contactId}`;
		setKv(s.db, "memory.banks_to_consolidate", JSON.stringify([bank, "iyye-owner"]), new Date().toISOString());
		assert.ok(existsSync(join(sb.stateDir, "sessions", encodeURIComponent(`contact:${alex.contactId}`))));

		// The default 60 s bank cache: it still lists the bank after the deletion.
		const ownerGateway = new MemoryGateway({ db: s.db, ltm: ltm.client(), log: silentLogger });
		assert.ok(
			(await ownerGateway.recall({ scope: "owner", principal: "owner" }, "passport number")).items.some(
				(i) => i.said === "person" && i.text.includes("X1234567"),
			),
		);
		// The owner's conversation today quoted Alex: Iyye's reply must not reach the owner's bank tonight.
		setKv(s.db, "decisions.reply_review.since", "2000-01-01T00:00:00.000Z", new Date().toISOString());
		const review = new ReplyReviewShadow({
			db: s.db,
			client: new DecisionClient({ db: s.db, service: kev.service }),
			device: new DeviceSlot(),
			chatPending: () => false,
			log: silentLogger,
		});
		await review.drainOnce(); // the earlier replies (Alex's own are deleted with his scope)
		const ownerTurn = fromOwner(s.db, "What is Alex's passport number?");
		await answered(ownerTurn.eventId);
		await review.drainOnce(); // Iyye's reply to the owner, quoting Alex, is now in the decision journal
		const pending = fromOwner(s.db, "And Alex's travel plans?");
		await answered(pending.eventId); // delivered, not yet reviewed
		assert.ok(JSON.stringify(s.db.prepare("SELECT state_json FROM decisions").all()).includes("passport"));
		recordIyyeEntry(s.db, {
			id: "summary:9",
			kind: "summary",
			text: "Day 9: 2 messages from Alex.",
			at: new Date().toISOString(),
		});
		recordIyyeEntry(s.db, {
			id: "summary:10",
			kind: "summary",
			text: "Day 10: a quiet day.",
			at: new Date().toISOString(),
		});
		const preview = await cmd(`/forget ${alex.contactId.slice(0, 8)}`);
		assert.match(preview, /would remove what Iyye remembers about Alex .* and their 1 linked account/);
		assert.match(preview, /To do it: \/forget [0-9a-f]{8} confirm/);
		assert.ok(ltm.banks.has(bank), "a preview changes nothing");
		assert.match(await cmd("/forget owner confirm"), /no contact matches|refused/);

		mode = "asleep";
		assert.match(await cmd(`/forget ${alex.contactId.slice(0, 8)} confirm`), /refused: Iyye is not awake/);
		mode = "awake";
		const reply = await cmd(`/forget ${alex.contactId.slice(0, 8)} confirm`);
		assert.match(reply, /Forgotten: Alex .*Long-term memory: deleted\..*Kept: the contact/s);
		assert.equal(await review.drainOnce(), 0, "the owner's unstored replies are never reviewed now");
		assert.deepEqual(
			(s.db.prepare("SELECT event_id FROM stm_episodes WHERE kind = 'summary'").all() as { event_id: string }[]).map(
				(r) => r.event_id,
			),
			["summary:10"],
			"a day summary naming them is dropped; one that does not stays",
		);
		const journal = JSON.stringify(s.db.prepare("SELECT * FROM decisions").all());
		assert.ok(
			!journal.includes("passport") && !journal.includes("travel"),
			"nothing quoting them in the decision journal",
		);

		assert.ok(!ltm.banks.has(bank), "the bank is deleted in long-term memory");
		const db = s.db;
		const dump = JSON.stringify([
			db.prepare("SELECT * FROM stm_episodes").all(),
			db.prepare("SELECT * FROM stm_fts").all(),
			db.prepare("SELECT payload_json FROM events").all(),
			db.prepare("SELECT content FROM actions").all(),
		]);
		assert.ok(!dump.includes("X1234567") && !dump.includes("visa"), "no text of theirs is left in Iyye's records");
		assert.match(dump, /\[forgotten\]/);
		assert.equal(JSON.parse(getKv(db, "memory.banks_to_consolidate")!).includes(bank), false);
		assert.ok(
			!existsSync(join(sb.stateDir, "sessions", encodeURIComponent(`contact:${alex.contactId}`))),
			"their transcripts are deleted",
		);
		const owner = await ownerGateway.recall({ scope: "owner", principal: "owner" }, "Alex passport number visa");
		assert.deepEqual(
			owner.items.map((i) => i.text),
			[
				"Owner said: What is Alex's passport number? / You replied: ",
				"Owner said: And Alex's travel plans? / You replied: ",
			],
			"not even the owner recalls it: only the owner's own questions are left, without Iyye's answers",
		);
		assert.equal(owner.ltm, true, "a bank deleted since the cached bank list is empty, not an outage");

		// It does not return: not by restaging, not by a late delivery, not by the next night.
		assert.equal(restageEpisodes(db), 0);
		recordEpisode(db, getEvent(db, today.eventId)!, { id: "late", content: "late reply" }, new Date().toISOString());
		assert.equal(
			(db.prepare("SELECT count(*) n FROM stm_episodes WHERE scope LIKE 'contact:%'").get() as { n: number }).n,
			0,
		);
		const retainsBefore = ltm.retains.length;
		await night();
		assert.deepEqual(
			ltm.retains.slice(retainsBefore),
			[`${ownerTurn.eventId}:said`, `${pending.eventId}:said`],
			"only the owner's own words; Iyye's reply that may quote Alex was dropped (and day summaries stay in short-term memory)",
		);
		assert.equal(ltm.docs.get(`iyye-owner/${ownerTurn.eventId}:said`)!.content, "What is Alex's passport number?");
		assert.equal(s.conversations.sessionFile("owner"), null, "the owner's conversation starts afresh");

		// The contact stays: what they say now is remembered normally.
		const after = fromTelegram(s.db, 6301, "Alex", "I moved to Lisbon");
		await answered(after.eventId);
		assert.equal(getEvent(db, after.eventId)!.scope, `contact:${alex.contactId}`);
		await night();
		assert.ok(ltm.docs.has(`${bank}/${after.eventId}:said`), "new memory after the forget");
	});

	test("#15 /forget (owner decision 2026-10-19): Iyye's stored replies to the owner and transcripts that name them go too", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { telegramApiBase: fake.apiBase, memory: { ltm: ltm.client(), bankCacheMs: 0 } });
		const julia = fromTelegram(s.db, 6401, "Julia", "My birthday is on 3 May");
		await answered(julia.eventId);
		const asked = fromOwner(s.db, "When is Julia's birthday?");
		await answered(asked.eventId);
		const other = fromOwner(s.db, "What is the weather like?");
		await answered(other.eventId);
		await night();
		const replied = (id: string) => `iyye-owner/${id}:replied`;
		assert.ok(ltm.docs.has(replied(asked.eventId)) && ltm.docs.has(replied(other.eventId)), "both replies stored");
		// Retired transcripts of the owner's earlier days: one names her, one only a namesake's longer name.
		const ownerDir = join(sb.stateDir, "sessions", "owner");
		writeFileSync(
			join(ownerDir, "2026-10-01T00-00-00-000Z_old.jsonl"),
			`${JSON.stringify({ text: "Julia's cat" })}\n`,
		);
		writeFileSync(join(ownerDir, "2026-10-01T00-00-00-000Z_quiet.jsonl"), `${JSON.stringify({ text: "Juliana" })}\n`);

		const preview = await cmd(`/forget ${julia.contactId.slice(0, 8)}`);
		assert.match(
			preview,
			/1 of Iyye's replies to you stored on earlier nights and 0 stored day summaries that name them \("julia"\): deleted/,
		);
		// The old one and today's owner conversation (it asked about her); never her own, which goes whole.
		assert.match(preview, /2 other conversation transcript\(s\) that name them/);
		assert.ok(ltm.docs.has(replied(asked.eventId)), "a preview changes nothing");

		const reply = await cmd(`/forget ${julia.contactId.slice(0, 8)} confirm`);
		assert.match(
			reply,
			/Iyye's stored words that named them: 1 reply to you and 0 day summaries, deleted from long-term memory/,
		);
		assert.ok(!ltm.docs.has(replied(asked.eventId)), "the stored reply naming her is deleted");
		assert.ok(ltm.docs.has(replied(other.eventId)), "a stored reply that does not name her stays");
		assert.ok(ltm.docs.has(`iyye-owner/${asked.eventId}:said`), "the owner's own words stay");
		const text = (id: string) =>
			(s!.db.prepare("SELECT reply_text FROM stm_episodes WHERE event_id = ?").get(id) as { reply_text: string })
				.reply_text;
		assert.equal(text(asked.eventId), "");
		assert.match(text(other.eventId), /weather/);
		assert.deepEqual(
			readdirSync(ownerDir).filter((f) => f.includes("2026-10-01")),
			["2026-10-01T00-00-00-000Z_quiet.jsonl"],
		);
		assert.equal(
			s.conversations.transcriptsMentioning(mentionPattern(["julia"])).length,
			0,
			"no transcript naming her is left anywhere",
		);
	});

	test("#15 /forget during an outage: queued, never read or written until deleted; the next night deletes it first", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { telegramApiBase: fake.apiBase, memory: { ltm: ltm.client(), bankCacheMs: 0 } });
		const bob = fromTelegram(s.db, 6401, "Bob", "My cat is called Pirate");
		await answered(bob.eventId);
		await night();
		const bank = `iyye-contact-${bob.contactId}`;
		assert.ok(ltm.banks.has(bank));

		ltm.down = true;
		const reply = await cmd(`/forget ${bob.contactId.slice(0, 8)} confirm`);
		assert.match(reply, /Long-term memory: deletion is queued/);
		assert.deepEqual(
			pendingBankDeletions(s.db).map((p) => [p.bank, p.attempts]),
			[[bank, 1]],
		);
		assert.match(
			memoryReport(s.db, { mode: "awake", day: 1, lastNight: null, ltm: "up", problem: null }),
			new RegExp(`forgotten, deletion pending .*${bank} since .*1 attempt\\(s\\)`),
		);
		ltm.down = false;
		const owner = await new MemoryGateway({ db: s.db, ltm: ltm.client(), log: silentLogger }).recall(
			{ scope: "owner", principal: "owner" },
			"cat Pirate",
		);
		assert.deepEqual(owner.items, [], "a bank awaiting deletion is never read, even when Hindsight is back");
		assert.ok(!ltm.recalls.some((r) => r.bank === bank), "not even asked");

		const after = fromTelegram(s.db, 6401, "Bob", "I got a dog called Rex");
		await answered(after.eventId);
		await night();
		assert.deepEqual(pendingBankDeletions(s.db), [], "the night deleted the bank first");
		assert.ok(!ltm.docs.has(`${bank}/${bob.eventId}:said`), "the old memory is gone");
		assert.ok(ltm.docs.has(`${bank}/${after.eventId}:said`), "then the new turn was stored");
	});

	test("#15 outage: with Hindsight down the night keeps STM and recall invents nothing", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { memory: { ltm: ltm.client(), bankCacheMs: 0 } });
		await answered(fromOwner(s.db, "The car is due for inspection in June").eventId);
		ltm.down = true;
		const out = await new NightWork({ db: s.db, ltm: ltm.client(), gate: openGate, log: silentLogger }).run(
			() => false,
		);
		assert.equal(out.kind, "blocked", "a 503 is an outage, not the episode's failure");
		assert.deepEqual(
			s.db.prepare("SELECT state, attempts FROM stm_episodes").get(),
			{ state: "day", attempts: 0 },
			"kept for a later night, no attempt charged",
		);
		const q = fromOwner(s.db, "When is the car inspection?");
		await answered(q.eventId);
		const block = memoryBlock();
		assert.match(block, /Long-term memory is unavailable right now/);
		assert.match(block, /\[today[^\]]*\] Owner said: The car is due for inspection in June/);
		assert.equal((block.match(/\[remembered/g) ?? []).length, 0, "nothing presented as long-term memory");
	});

	test("/forget waits for work in flight and refuses the owner", async () => {
		sb = sandbox();
		s = await startStack(sb, {}, { telegramApiBase: fake.apiBase, memory: { ltm: null } });
		const eve = fromTelegram(s.db, 6501, "Eve", "hi");
		await answered(eve.eventId);
		const owned = fromTelegram(s.db, 6502, "Me", "hi");
		await answered(owned.eventId);
		linkAccount(s.db, owned.contactId, OWNER_CONTACT_ID, "owner_web", new Date().toISOString());
		assert.match(await cmd(`/forget ${owned.contactId.slice(0, 8)}`), /refused: the owner's own memory/);
		await s.scheduler.stop(); // hold the next job queued
		fromTelegram(s.db, 6501, "Eve", "one more thing");
		assert.match(await cmd(`/forget Eve confirm`), /refused: 1 message\(s\) from them are still being answered/);
		assert.equal(pendingBankDeletions(s.db).length, 0, "nothing changed");
	});
});
