// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { admitTelegramUpdate } from "../src/kernel/admission.ts";
import { handleOwnerCommand } from "../src/kernel/commands.ts";
import { silentLogger } from "../src/log.ts";
import { MemoryControl } from "../src/memory/control.ts";
import { formatRecalled, MemoryGateway } from "../src/memory/gateway.ts";
import { cardLines, cardSummary, inUsualHours, personCard, scriptOf, usualHoursFor } from "../src/people/card.ts";
import {
	NEW_CONTACT_NOTICES_DAILY,
	newContactKey,
	newContactNotice,
	newContactNoticeToday,
	People,
	personNoteFor,
} from "../src/people/people.ts";
import { findContacts, getContact, linkOf, resolvePerson } from "../src/state/contacts.ts";
import { openDb } from "../src/state/db.ts";
import { notesAbout } from "../src/state/notes.ts";

function rig() {
	const db = openDb(":memory:");
	const people = new People({ db });
	const cmd = async (text: string) =>
		(await handleOwnerCommand(text, { models: {} as never, db, issuer: "owner_web", people })).reply;
	let update = 9000;
	const write = (fromId: number, firstName: string, text = "hello") =>
		admitTelegramUpdate(
			{ db, now: () => new Date(), newId: () => crypto.randomUUID() },
			{
				updateId: update++,
				message: {
					messageId: update,
					chatId: fromId,
					chatType: "private",
					fromUserId: fromId,
					fromIsBot: false,
					username: null,
					firstName,
					text,
					dateUnix: Math.floor(Date.now() / 1000),
				},
			},
		);
	const id = (name: string) => findContacts(db, name)[0]!.id;
	return { db, people, cmd, write, id };
}

describe("people before they write", () => {
	test("/person add makes a person with no account; the same name is refused; a note may come with it", async () => {
		const r = rig();
		assert.match(
			await r.cmd('/person add Jacob "my son, 12"'),
			/^Added Jacob \(id \w{8}\), not trusted, with no account yet, and your note/,
		);
		const jacob = getContact(r.db, r.id("Jacob"))!;
		assert.equal(jacob.trusted, 0);
		assert.deepEqual(
			notesAbout(r.db, jacob.id).map((n) => [n.text, n.visibility]),
			[["my son, 12", "owner"]],
		);
		assert.match(await r.cmd("/person add jacob"), /^refused: Jacob \(id \w{8}\) already has that name/);
		assert.match(await r.cmd("/contacts"), /Jacob — not trusted · no account yet · id \w{8} · 1 note/);
		assert.match(
			await r.cmd(`/person ${jacob.id.slice(0, 8)}`),
			/^Jacob — id \w{8} · not trusted · no account yet\n\nWho they are to you: not said\nWrites: has not written yet\nBetween them and Iyye: nothing open\nWhat Iyye holds about them: nothing yet\nMissing: who they are to you \(\/self relation\); an email address \(\/person email\)\n\nYour notes:\n {2}- \w{8} \[yours only · \d{4}-\d\d-\d\d\] my son, 12/,
		);
	});

	test("their account's first message tells the owner, with the suggestion; only /link joins them", async () => {
		const r = rig();
		await r.cmd("/person add Jacob");
		await r.cmd("/person add Mila");
		const added = r.id("Jacob");
		const first = r.write(501, "Jacob");
		assert.equal(first.outcome, "admitted");
		const newId = (first as { newContactId?: string }).newContactId!;
		assert.ok(newId && newId !== added);
		assert.equal((r.write(501, "Jacob") as { newContactId?: string }).newContactId, undefined, "only the first time");
		const notice = newContactNotice(r.db, newId)!;
		const jacob = getContact(r.db, added)!;
		assert.match(
			notice,
			/^Someone new wrote to Iyye on Telegram: Jacob \(Telegram user id 501\), id \w{8}, not trusted\./,
		);
		assert.match(
			notice,
			new RegExp(
				`Possibly Jacob \\(id ${jacob.id.slice(0, 8)}\\), same name: if so, /link ${newId.slice(0, 8)} ${jacob.id.slice(0, 8)}`,
			),
		);
		assert.match(notice, /People you added without an account yet: Mila \(id \w{8}\)/);
		assert.match(notice, /A name is no proof/);
		assert.equal(linkOf(r.db, newId), undefined, "a notice never links");
		assert.match(await r.cmd("/person add Owner"), /^refused: "owner" means you/);
		await r.cmd(`/link ${newId.slice(0, 8)} ${jacob.id.slice(0, 8)}`);
		assert.equal(resolvePerson(r.db, getContact(r.db, newId)!).id, jacob.id);
		assert.match(await r.cmd(`/person ${jacob.id.slice(0, 8)}`), /· telegram:501 · last message/);
	});
});

describe("owner notes", () => {
	test("owner-only by default; share, private and delete by id; a linked account's notes go to its person", async () => {
		const r = rig();
		r.write(601, "Julia");
		const julia = r.id("Julia");
		const added = await r.cmd("/note Julia prefers short answers");
		assert.match(added, /^Noted about Julia \(note (\w{8})\), for your conversations only/);
		const noteId = /note (\w{8})/.exec(added)![1]!;
		assert.equal(personNoteFor(r.db, `contact:${julia}`), null, "owner-only notes never reach her turns");
		assert.match(await r.cmd(`/note share ${noteId}`), /now shared with Julia/);
		assert.equal(
			personNoteFor(r.db, `contact:${julia}`),
			"<owner_notes>\nYour owner's notes about the person you are talking with. Take them into account; they may see them:\n- prefers short answers\n</owner_notes>",
		);
		assert.equal(personNoteFor(r.db, "owner"), null);
		await r.cmd(`/note private ${noteId}`);
		assert.equal(personNoteFor(r.db, `contact:${julia}`), null);
		// A second account linked to Julia: notes written through it are about Julia.
		r.write(602, "Jules");
		await r.cmd(`/link Jules Julia`);
		await r.cmd('/note Jules "plays violin"');
		assert.deepEqual(
			notesAbout(r.db, julia).map((n) => n.text),
			["prefers short answers", "plays violin"],
		);
		assert.match(await r.cmd(`/note delete ${noteId}`), /^Deleted note/);
		assert.deepEqual(
			notesAbout(r.db, julia).map((n) => n.text),
			["plays violin"],
		);
		assert.match(await r.cmd("/note Nobody hi"), /^no contact matches/);
		r.write(603, "Julia");
		assert.match(await r.cmd("/note Julia hi"), /matches 2 people; use an id/);
	});

	test("the owner's turns that name the person recall the notes; a contact's turns never do", async () => {
		const r = rig();
		await r.cmd('/person add Jacob "my son, 12; keep answers age-appropriate"');
		r.write(701, "Julia");
		const gw = new MemoryGateway({ db: r.db, ltm: null, log: silentLogger });
		const owner = await gw.recall(
			{ scope: "owner", principal: "owner" },
			"What should I get Jacob for his birthday?",
		);
		assert.deepEqual(
			owner.items.filter((i) => i.source === "note").map((i) => i.text),
			["Your note about Jacob: my son, 12; keep answers age-appropriate"],
		);
		assert.match(
			formatRecalled(owner),
			/- \[the owner's own note, \d{4}-\d\d-\d\d \d\d:\d\d\] Your note about Jacob/,
		);
		const none = await gw.recall({ scope: "owner", principal: "owner" }, "What is the weather?");
		assert.equal(none.items.filter((i) => i.source === "note").length, 0);
		const julia = await gw.recall({ scope: `contact:${r.id("Julia")}`, principal: "contact" }, "How old is Jacob?");
		assert.equal(julia.items.filter((i) => i.source === "note").length, 0);
	});

	test("relationship hypotheses come from the ledger's relation beliefs, with sources", async () => {
		const r = rig();
		await r.cmd("/person add Jacob");
		const at = new Date().toISOString();
		r.db
			.prepare(
				`INSERT INTO beliefs (id, fact_key, subject_ref, subject, predicate, object, object_norm, time_frame, valid_from, p, created_at, updated_at)
			 VALUES ('b1', 'k', ?, 'Jacob', 'relation_of', 'son of the owner', 'son of the owner', 'permanent', ?, 0.9, ?, ?),
			        ('b2', 'k2', 'jacob', 'Jacob', 'likes', 'chess', 'chess', 'permanent', ?, 0.9, ?, ?)`,
			)
			.run(`contact:${r.id("Jacob")}`, at, at, at, at, at, at);
		for (const b of ["b1", "b2"])
			r.db
				.prepare(
					`INSERT INTO belief_evidence (id, belief_id, source, scope, modality, sign, source_p, weight, relation, night, at)
				 VALUES (?, ?, 'owner', 'owner', 'stated', 1, 0.9, 1, 'new', '2026-10-09', ?)`,
				)
				.run(`e-${b}`, b, at);
		const view = await r.cmd("/person Jacob");
		assert.match(
			view,
			/Relationship hypotheses \(from conversations; revisable, not established\):\n {2}- \[very likely 0\.90 · you said · today\] Jacob is the son of the owner \(belief b1\)$/,
		);
		assert.ok(!view.includes("chess"), "only relations, nothing else about them");
	});

	test("a note written before a link follows the account to its person, either way round; /forget removes it", async () => {
		const r = rig();
		// The new account gets a note, then is linked to the person the owner added.
		await r.cmd("/person add Jacob");
		const jacob = r.id("Jacob");
		const acc = (r.write(901, "Jake") as { newContactId: string }).newContactId;
		await r.cmd(`/note ${acc.slice(0, 8)} "plays chess"`);
		await r.cmd(`/note share ${notesAbout(r.db, acc)[0]!.id.slice(0, 8)}`);
		await r.cmd(`/link ${acc.slice(0, 8)} ${jacob.slice(0, 8)}`);
		assert.deepEqual(
			notesAbout(r.db, jacob).map((n) => n.text),
			["plays chess"],
		);
		assert.match(personNoteFor(r.db, `contact:${jacob}`)!, /- plays chess/);
		assert.match(await r.cmd(`/person ${jacob.slice(0, 8)}`), /\[shared with them · [\d-]+\] plays chess/);
		// The other way round: the person the owner added becomes an account of the one that wrote.
		await r.cmd('/person add Mila "likes cats"');
		const mila = r.id("Mila");
		const tg = (r.write(902, "Mila T") as { newContactId: string }).newContactId;
		await r.cmd(`/link ${mila.slice(0, 8)} ${tg.slice(0, 8)}`);
		assert.deepEqual(
			notesAbout(r.db, tg).map((n) => n.text),
			["likes cats"],
		);
		r.db.prepare("UPDATE jobs SET status = 'settled'").run();
		const control = new MemoryControl({
			db: r.db,
			ltm: null,
			log: silentLogger,
			mode: () => "awake",
			forgetConversations: async () => 0,
		});
		await control.forget(getContact(r.db, jacob)!, "owner_web");
		assert.deepEqual(notesAbout(r.db, jacob), []);
		assert.deepEqual(notesAbout(r.db, acc), []);
		await control.forget(getContact(r.db, tg)!, "owner_web");
		assert.deepEqual(notesAbout(r.db, mila), []);
	});

	test("/forget deletes the notes about the person", async () => {
		const r = rig();
		r.write(801, "Julia");
		await r.cmd("/note Julia secret thing");
		r.db.prepare("UPDATE jobs SET status = 'settled'").run();
		const control = new MemoryControl({
			db: r.db,
			ltm: null,
			log: silentLogger,
			mode: () => "awake",
			forgetConversations: async () => 0,
		});
		assert.match(control.preview(getContact(r.db, r.id("Julia"))!), /your notes about them: deleted/);
		await control.forget(getContact(r.db, r.id("Julia"))!, "owner_web");
		assert.deepEqual(notesAbout(r.db, r.id("Julia")), []);
	});
});

describe("a person's card (plan 0.018 W5)", () => {
	const NOW = new Date("2026-11-23T12:00:00Z");
	const HOUR = 3_600_000;
	const DAY = 24 * HOUR;
	function known() {
		const db = openDb(":memory:");
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, trusted, created_at) VALUES ('jul', 'Julia', 'contact', 1, 't')",
		).run();
		db.prepare(
			"INSERT INTO contacts (id, display_name, kind, created_at) VALUES ('bob', 'Bob', 'contact', 't')",
		).run();
		let n = 0;
		const says = (who: string, at: Date, text: string) =>
			db
				.prepare(
					"INSERT INTO events (id, dedup_key, channel, principal_contact_id, scope, received_at, payload_json, status) VALUES (?, ?, 'telegram', ?, ?, ?, ?, 'answered')",
				)
				.run(`e${++n}`, `e${n}`, who, `contact:${who}`, at.toISOString(), JSON.stringify({ message: { text } }));
		// Julia: twelve messages on six evenings (17:00 and 20:00 UTC), mostly in Russian; one stray at 02:00.
		for (let d = 1; d <= 6; d++) {
			says("jul", new Date(NOW.getTime() - d * DAY + 5 * HOUR), d === 1 ? "see you tomorrow" : "привет, как дела?");
			says("jul", new Date(NOW.getTime() - d * DAY + 8 * HOUR), "хорошо, спасибо");
		}
		says("jul", new Date(NOW.getTime() - 3 * DAY - 10 * HOUR), "не спится");
		says("bob", new Date(NOW.getTime() - DAY), "hi");
		return { db, says };
	}

	test("when and how they write, what is open, what is held and what is missing: from records only", () => {
		const { db } = known();
		db.prepare(
			"INSERT INTO self_facts (facet, field, value_json, source, observed_at) VALUES ('social', 'relation:jul', '\"my wife\"', 'owner', 't')",
		).run();
		db.prepare(
			`INSERT INTO commitments (id, kind, scope, recipient_contact_id, route_json, text, due_at, timezone, series_id, state, created_by, created_at)
			 VALUES ('c1', 'reminder', 'contact:jul', 'jul', '{}', 'call the dentist', '2026-11-24T08:00:00.000Z', 'UTC', 'c1', 'scheduled', 'x', ?)`,
		).run(NOW.toISOString());
		db.prepare(
			`INSERT INTO plans (id, intent, proposer_contact_id, scope, route_json, proposed_via, steps_json, state, created_at, updated_at)
			 VALUES ('p1', 'x', 'jul', 'contact:jul', '{}', 'Telegram', '[]', 'proposed', ?, ?)`,
		).run(NOW.toISOString(), NOW.toISOString());
		const c = personCard(db, getContact(db, "jul")!, NOW, "UTC");
		assert.equal(c.relation, "my wife");
		assert.equal(c.messages30, 13);
		assert.equal(c.daysActive30, 6);
		assert.deepEqual(c.usualHours, { from: 17, to: 20 }, "the stray message at night does not widen it");
		assert.deepEqual(c.scripts, [
			{ script: "Cyrillic", messages: 12 },
			{ script: "Latin", messages: 1 },
		]);
		assert.deepEqual(c.reminders, { waiting: 1, next: "2026-11-24T08:00:00.000Z" });
		assert.deepEqual(c.plans, { proposed: 1 });
		assert.deepEqual(c.missing, [
			"an email address (/person email)",
			"their name in Cyrillic script (it is known in Latin only)",
		]);
		const text = cardLines(c, NOW).join("\n");
		assert.match(
			text,
			/^Who they are to you: "my wife"\nWrites: 13 message\(s\) on 6 day\(s\) in the last 30; last 16 h ago; first 2026-11-17\nUsually writes between 17:00 and 20:59 \(local time here\)\nWrites in: Cyrillic script \(12 message\(s\)\), Latin script \(1 message\(s\)\)\nBetween them and Iyye: 1 reminder\(s\) waiting, the next 2026-11-24 08:00 UTC; 1 plan\(s\) proposed/,
		);
		assert.equal(inUsualHours(c.usualHours!, 18), true);
		assert.equal(inUsualHours(c.usualHours!, 10), false);
		assert.equal(inUsualHours({ from: 22, to: 1 }, 23), true, "across midnight");
		assert.equal(inUsualHours({ from: 22, to: 1 }, 12), false);
		assert.equal(
			cardSummary("Julia", true, c, NOW),
			'"Julia" ("my wife"), trusted: 13 message(s) in 30 days, last 16 h ago; usually writes between 17:00 and 20:59; 1 reminder(s) waiting; 1 open plan(s)',
		);
		// One message says nothing about when someone writes.
		const bob = personCard(db, getContact(db, "bob")!, NOW, "UTC");
		assert.equal(bob.usualHours, null);
		assert.equal(usualHoursFor(db, getContact(db, "bob")!, NOW, "UTC"), null);
		assert.equal(scriptOf("12345 !!"), null);
	});

	test("/person shows it, and after /forget nothing of it is left", async () => {
		const { db, says } = known();
		const people = new People({ db, now: () => NOW, timezone: "UTC" });
		const before = people.person("Julia", "owner_web");
		assert.match(before, /Usually writes between 17:00 and 20:59/);
		assert.match(before, /Writes in: Cyrillic script/);
		db.prepare("UPDATE jobs SET status = 'settled'").run();
		const control = new MemoryControl({
			db,
			ltm: null,
			log: silentLogger,
			mode: () => "awake",
			forgetConversations: async () => 0,
			now: () => NOW,
		});
		await control.forget(getContact(db, "jul")!, "owner_web");
		const after = people.person("Julia", "owner_web");
		assert.match(
			after,
			/Writes: has not written yet\nBetween them and Iyye: nothing open\nWhat Iyye holds about them: nothing yet/,
		);
		assert.doesNotMatch(after, /Usually writes|Cyrillic|17:00/);
		// What they write from then on is theirs again.
		says("jul", new Date(NOW.getTime() + HOUR), "hello again");
		assert.match(
			new People({ db, now: () => new Date(NOW.getTime() + 2 * HOUR), timezone: "UTC" }).person(
				"Julia",
				"owner_web",
			),
			/Writes: 1 message\(s\) on 1 day\(s\)/,
		);
	});
});

test("the new-contact allowance: at most NEW_CONTACT_NOTICES_DAILY notices a day, counted from the outbox's own keys", () => {
	const r = rig();
	const now = new Date();
	const ids = Array.from(
		{ length: NEW_CONTACT_NOTICES_DAILY + 1 },
		(_, i) => (r.write(1000 + i, `P${i}`) as { newContactId: string }).newContactId,
	);
	for (const id of ids.slice(0, NEW_CONTACT_NOTICES_DAILY)) {
		assert.ok(newContactNoticeToday(r.db, id, now));
		// What Outbox.notifyOwner stores for this key (`notice:<key>`).
		r.db
			.prepare(
				"INSERT INTO actions (id, kind, route_json, content_hash, idempotency_key, state, created_at) VALUES (?, 'status', '{}', 'h', ?, 'queued', ?)",
			)
			.run(crypto.randomUUID(), `notice:${newContactKey(id)}`, now.toISOString());
	}
	assert.equal(newContactNoticeToday(r.db, ids.at(-1)!, now), null);
});
