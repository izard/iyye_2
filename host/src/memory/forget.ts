// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * `/forget <contact>` (plan 0.002 L6, HLD §6.4): the owner removes what Iyye
 * remembers about a person. Deterministic and owner-only; nothing a contact
 * says can trigger it.
 *
 * - One SQLite transaction makes the person unrecallable at once: a tombstone
 *   per scope, their STM entries and decisions deleted, the text of their
 *   messages, Iyye's replies and tool calls redacted, and their Hindsight banks
 *   queued for deletion (removed from the consolidation list).
 * - The banks are then deleted in Hindsight. A deletion that fails stays
 *   queued and is retried at startup and before each night; until it succeeds
 *   recall and the night skip that bank.
 * - The owner's recall reads every contact, so Iyye's replies to the owner
 *   today may quote the person. Those replies leave the owner's short-term
 *   memory (only the owner's own words stay), so tonight's night cannot store
 *   them. Owner replies stored on earlier nights are a known limit (plan
 *   0.002 L6): they cannot be told apart without per-turn recall provenance.
 * - The tombstone keeps anything said before it out of memory for good (late
 *   deliveries, the night, restaging). What the person says afterwards is
 *   remembered normally: the contact, its channel bindings and trust stay.
 */

import { existsSync, rmSync } from "node:fs";
import { forgetReplyReviews } from "../decisions/reply-review.ts";
import { forgetBeliefs } from "../facts/beliefs.ts";
import { queueFactDocDeletions } from "../facts/night.ts";
import { forgetFacts } from "../facts/store.ts";
import type { Logger } from "../log.ts";
import { forgetMotivationRecords } from "../motivation/actor.ts";
import { forgetSelfFacts } from "../self/model.ts";
import { accountsOf, type Contact, OWNER_CONTACT_ID, resolvePerson, scopeFor } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { getKv, setKv } from "../state/kv.ts";
import { mediaPath } from "../state/media.ts";
import { forgetNotes } from "../state/notes.ts";
import {
	addTombstone,
	bankDeletionDone,
	bankDeletionFailed,
	pendingBankDeletions,
	queueBankDeletion,
} from "../state/tombstones.ts";
import { forgetVoice } from "../voice/shadow.ts";
import { bankFor } from "./gateway.ts";

export const FORGOTTEN = "[forgotten]";
export const PENDING_BANKS_KEY = "memory.banks_to_consolidate";

export interface ForgetTarget {
	person: Contact;
	/** The person's scope and every linked account's scope. */
	scopes: string[];
	banks: string[];
	counts: { messages: number; stm: number; toolCalls: number; decisions: number };
}

/** What `/forget` would cover, or why it cannot. */
export function forgetTarget(db: Db, contact: Contact): ForgetTarget | string {
	const person = resolvePerson(db, contact);
	if (person.id === OWNER_CONTACT_ID || person.kind === "owner") {
		return "refused: the owner's own memory is not forgotten this way (use scripts/memory-clear.ts for debugging)";
	}
	const scopes = [scopeFor(person), ...accountsOf(db, person.id).map(scopeFor)];
	const banks = scopes.map(bankFor).filter((b): b is string => b !== null);
	const marks = scopes.map(() => "?").join(", ");
	const count = (sql: string) => (db.prepare(sql).get(...scopes) as { n: number }).n;
	return {
		person,
		scopes,
		banks,
		counts: {
			messages: count(`SELECT count(*) AS n FROM events WHERE scope IN (${marks})`),
			stm: count(`SELECT count(*) AS n FROM stm_episodes WHERE scope IN (${marks})`),
			toolCalls: count(`SELECT count(*) AS n FROM tool_calls WHERE scope IN (${marks})`),
			decisions: count(`SELECT count(*) AS n FROM decisions WHERE scope IN (${marks})`),
		},
	};
}

/** The background conversations of the person's plan steps (plan 0.006 C4): their prompts quote the person. */
/** Events in these scopes that came with an image (to delete their kept copies, `forgetMedia`). */
export function imageEvents(db: Db, scopes: readonly string[]): string[] {
	const marks = scopes.map(() => "?").join(", ");
	return (
		db
			.prepare(
				`SELECT id FROM events WHERE scope IN (${marks}) AND json_extract(payload_json, '$.message.image') IS NOT NULL`,
			)
			.all(...scopes) as { id: string }[]
	).map((r) => r.id);
}

/** Delete the kept copies of these events' images (`<state>/media/<event id>`); returns how many there were. */
export function forgetMedia(mediaDir: string, eventIds: readonly string[]): number {
	let n = 0;
	for (const id of eventIds) {
		const path = mediaPath(mediaDir, id);
		if (existsSync(path)) {
			rmSync(path, { force: true });
			n++;
		}
	}
	return n;
}

export function planSessions(db: Db, scopes: readonly string[]): string[] {
	const marks = scopes.map(() => "?").join(", ");
	return (
		db
			.prepare(
				`SELECT DISTINCT b.session FROM background_jobs b JOIN plans p ON b.origin LIKE 'plan:' || p.id || ':%'
				 WHERE p.scope IN (${marks})`,
			)
			.all(...scopes) as { session: string }[]
	).map((r) => r.session);
}

/** Why the person's records cannot be forgotten right now (work in flight), or null. */
export function forgetBusy(db: Db, scopes: readonly string[]): string | null {
	const marks = scopes.map(() => "?").join(", ");
	const jobs = (
		db
			.prepare(`SELECT count(*) AS n FROM jobs WHERE scope IN (${marks}) AND status IN ('queued', 'running')`)
			.get(...scopes) as { n: number }
	).n;
	if (jobs > 0) return `${jobs} message(s) from them are still being answered`;
	const actions = (
		db
			.prepare(
				`SELECT count(*) AS n FROM actions a JOIN events e ON e.id = a.event_id
				 WHERE e.scope IN (${marks}) AND a.state IN ('prepared', 'queued', 'sending', 'failed')`,
			)
			.get(...scopes) as { n: number }
	).n;
	if (actions > 0) return `${actions} reply(ies) to them are still being delivered`;
	// A reminder already on its way (queued, sending, or waiting for a retry) has no event: its commitment says whose it is.
	const reminders = (
		db
			.prepare(
				`SELECT count(*) AS n FROM actions a JOIN commitments c ON c.id = a.commitment_id
				 WHERE c.scope IN (${marks}) AND a.state IN ('prepared', 'queued', 'sending', 'failed')`,
			)
			.get(...scopes) as { n: number }
	).n;
	if (reminders > 0) return `${reminders} reminder(s) to them are still being delivered`;
	// A message sent to them for the owner (plan 0.008), still on its way.
	const sends = (
		db
			.prepare(
				`SELECT count(*) AS n FROM actions a JOIN sent_messages s ON a.idempotency_key = 'notice:send:' || s.id
				 WHERE s.scope IN (${marks}) AND a.state IN ('prepared', 'queued', 'sending', 'failed')`,
			)
			.get(...scopes) as { n: number }
	).n;
	if (sends > 0) return `${sends} message(s) to them are still being delivered`;
	// An email to them, or asked for by them (plan 0.014), still on its way.
	const mails = (
		db
			.prepare(
				`SELECT count(*) AS n FROM actions a JOIN sent_emails m ON a.idempotency_key = 'notice:email:' || m.id
				 WHERE (m.recipient_scope IN (${marks}) OR m.requester_scope IN (${marks}))
				 AND a.state IN ('prepared', 'queued', 'sending', 'failed')`,
			)
			.get(...scopes, ...scopes) as { n: number }
	).n;
	if (mails > 0) return `${mails} email(s) to or for them are still being sent`;
	// A step of their plan running right now (plan 0.006 C4) would write their words back after the deletion.
	const steps = (
		db
			.prepare(
				`SELECT count(*) AS n FROM background_jobs b JOIN plans p ON b.origin LIKE 'plan:' || p.id || ':%'
				 WHERE p.scope IN (${marks}) AND b.status = 'running'`,
			)
			.get(...scopes) as { n: number }
	).n;
	if (steps > 0) return "a step of their plan is running";
	return null;
}

/**
 * The SQLite part, in one transaction. After it returns nothing about the
 * person is recallable; their banks wait in `bank_deletions_pending`.
 */
export function forgetRecords(db: Db, t: ForgetTarget, by: string, at: string): void {
	const marks = t.scopes.map(() => "?").join(", ");
	db.transaction(() => {
		for (const scope of t.scopes) addTombstone(db, scope, at, by);
		db.prepare(
			`DELETE FROM stm_fts WHERE event_id IN (SELECT event_id FROM stm_episodes WHERE scope IN (${marks}))`,
		).run(...t.scopes);
		db.prepare(`DELETE FROM stm_fts WHERE scope IN (${marks})`).run(...t.scopes);
		db.prepare(`DELETE FROM stm_episodes WHERE scope IN (${marks})`).run(...t.scopes);
		db.prepare(`DELETE FROM decisions WHERE scope IN (${marks})`).run(...t.scopes);
		// Their reminders (plan 0.006): none is sent any more, and their words go.
		db.prepare(
			`UPDATE commitments SET state = CASE WHEN state = 'scheduled' THEN 'cancelled' ELSE state END,
				settled_at = coalesce(settled_at, ?), reason = coalesce(reason, 'forgotten'), text = ?
			 WHERE scope IN (${marks})`,
		).run(at, FORGOTTEN, ...t.scopes);
		// Messages sent to them, or asked for by them (plan 0.008): the words go, from the record, the actions,
		// the owner's notices (failure, and "asked Iyye to write…") and the tool call that sent each one.
		const mine = `SELECT id FROM sent_messages WHERE scope IN (${marks}) OR requester_scope IN (${marks})`;
		const keys = `SELECT 'notice:send:' || id FROM (${mine}) UNION SELECT 'notice:send-failed:' || id FROM (${mine})
			UNION SELECT 'notice:sent-by:' || id FROM (${mine})`;
		const both = [...t.scopes, ...t.scopes];
		const all3 = [...both, ...both, ...both];
		db.prepare(`UPDATE actions SET content = ? WHERE content IS NOT NULL AND idempotency_key IN (${keys})`).run(
			FORGOTTEN,
			...all3,
		);
		db.prepare(
			`UPDATE web_feed SET text = ? WHERE action_id IN (SELECT id FROM actions WHERE idempotency_key IN (${keys}))`,
		).run(FORGOTTEN, ...all3);
		db.prepare(
			`UPDATE tool_calls SET args_json = ?, result = NULL WHERE tool = 'telegram_send'
			 AND trim(json_extract(args_json, '$.text')) IN (SELECT text FROM sent_messages WHERE id IN (${mine}))`,
		).run(JSON.stringify(FORGOTTEN), ...both);
		db.prepare(`UPDATE sent_messages SET text = ? WHERE id IN (${mine})`).run(FORGOTTEN, ...both);
		// Emails to them or asked for by them (plan 0.014): the words, the subject and the address go, from the
		// record, the action (content and route), the owner's notices and the tool call; their stored address too.
		const mails = `SELECT id FROM sent_emails WHERE recipient_scope IN (${marks}) OR requester_scope IN (${marks})`;
		const mailKeys = `SELECT 'notice:email:' || id FROM (${mails}) UNION SELECT 'notice:email-failed:' || id FROM (${mails})
			UNION SELECT 'notice:emailed-by:' || id FROM (${mails})`;
		db.prepare(`UPDATE actions SET content = ? WHERE content IS NOT NULL AND idempotency_key IN (${mailKeys})`).run(
			FORGOTTEN,
			...all3,
		);
		db.prepare(
			`UPDATE actions SET route_json = ? WHERE idempotency_key IN (SELECT 'notice:email:' || id FROM (${mails}))`,
		).run(JSON.stringify({ channel: "email", to: FORGOTTEN, subject: FORGOTTEN }), ...both);
		db.prepare(
			`UPDATE web_feed SET text = ? WHERE action_id IN (SELECT id FROM actions WHERE idempotency_key IN (${mailKeys}))`,
		).run(FORGOTTEN, ...all3);
		db.prepare(
			`UPDATE tool_calls SET args_json = ?, result = NULL WHERE tool = 'email_send'
			 AND trim(json_extract(args_json, '$.text')) IN (SELECT text FROM sent_emails WHERE id IN (${mails}))`,
		).run(JSON.stringify(FORGOTTEN), ...both);
		db.prepare(
			`UPDATE sent_emails SET text = ?, subject = ?, address = ?, dedup_key = 'forgotten:' || id WHERE id IN (${mails})`,
		).run(FORGOTTEN, FORGOTTEN, FORGOTTEN, ...both);
		// (Their stored address is deleted below, after their received mail is redacted by it.)
		// Their plans (plan 0.006 C4): abandoned, their words gone, and so are the steps' prompts, answers and tool calls.
		const plans = db.prepare(`SELECT id, state FROM plans WHERE scope IN (${marks})`).all(...t.scopes) as {
			id: string;
			state: string;
		}[];
		for (const p of plans) {
			db.prepare(
				`UPDATE plans SET intent = ?, steps_json = '[]', reason = 'forgotten', updated_at = ?,
					state = CASE WHEN state IN ('proposed', 'authorized', 'active', 'suspended') THEN 'abandoned' ELSE state END,
					settled_at = coalesce(settled_at, ?) WHERE id = ?`,
			).run(FORGOTTEN, at, at, p.id);
			db.prepare(
				`UPDATE background_jobs SET prompt = ?, result = NULL,
					status = CASE WHEN status IN ('queued', 'paused') THEN 'failed' ELSE status END,
					error = CASE WHEN status IN ('queued', 'paused') THEN 'forgotten' ELSE error END
				 WHERE origin LIKE ?`,
			).run(FORGOTTEN, `plan:${p.id}:%`);
			db.prepare("UPDATE tool_calls SET args_json = ?, result = NULL WHERE scope LIKE ?").run(
				JSON.stringify(FORGOTTEN),
				`iyye:plan:${p.id}:%`,
			);
			for (const key of ["proposed", "completed", "failed", "blocked", "unconfirmed"].map(
				(k) => `notice:plan-${k}:${p.id}`,
			)) {
				db.prepare(
					"UPDATE web_feed SET text = ? WHERE action_id IN (SELECT id FROM actions WHERE idempotency_key = ?)",
				).run(FORGOTTEN, key);
				db.prepare("UPDATE actions SET content = ? WHERE idempotency_key = ? AND content IS NOT NULL").run(
					FORGOTTEN,
					key,
				);
			}
		}
		// Iyye's replies to the owner not yet stored may quote the person: only the owner's words stay.
		const ownerTurns = db
			.prepare(
				"SELECT event_id, action_id, user_text FROM stm_episodes WHERE scope = 'owner' AND kind = 'turn' AND state IN ('day', 'backlog')",
			)
			.all() as { event_id: string; action_id: string; user_text: string }[];
		for (const r of ownerTurns) {
			db.prepare("UPDATE stm_episodes SET reply_text = '' WHERE event_id = ?").run(r.event_id);
			db.prepare("UPDATE stm_fts SET body = ? WHERE event_id = ?").run(r.user_text, r.event_id);
		}
		// The fact ledger (plan 0.011 §3.6): their evidence leaves every belief, beliefs about them go, and so do
		// their structured facts, every fact about them and the facts of those replies. Facts about them stored
		// in other banks (the owner's) are queued for deletion there; their own banks go whole.
		const elsewhere = db
			.prepare(
				`SELECT scope, id FROM stm_facts WHERE subject_ref = ? AND stored_at IS NOT NULL AND scope NOT IN (${marks})`,
			)
			.all(`contact:${t.person.id}`, ...t.scopes) as { scope: string; id: string }[];
		queueFactDocDeletions(
			db,
			elsewhere.map((f) => ({ scope: f.scope, stmFactId: f.id })),
			at,
		);
		const beliefs = forgetBeliefs(db, t.scopes, [t.person.id], at);
		// The motivations' records that may quote them (plan 0.010): questions and notices about those beliefs,
		// notices about their plans, and the signal texts kept with the motivation samples.
		// Follow-ups about what they said (plan 0.010 M3): the message itself is a sent message (above).
		const followUps = (
			db
				.prepare(
					`SELECT cluster FROM opportunities WHERE cluster IN (SELECT 'event:' || id FROM events WHERE scope IN (${marks}))`,
				)
				.all(...t.scopes) as { cluster: string }[]
		).map((r) => r.cluster);
		forgetMotivationRecords(
			db,
			[...beliefs.map((id) => `belief:${id}`), ...plans.map((p) => `plan:${p.id}`), ...followUps],
			FORGOTTEN,
		);
		forgetFacts(db, t.scopes, [t.person.id], { ownerReplies: ownerTurns.map((r) => r.event_id) });
		// Day summaries not yet stored may name the person ("2 from Julia"): they go too (HLD §15 #15).
		const names = [t.person.display_name, ...accountsOf(db, t.person.id).map((a) => a.display_name)]
			.map((n) => n.trim().toLowerCase())
			.filter((n) => n.length >= 2);
		const summaries = db
			.prepare("SELECT event_id, user_text FROM stm_episodes WHERE kind = 'summary' AND state IN ('day', 'backlog')")
			.all() as { event_id: string; user_text: string }[];
		for (const r of summaries.filter((r) => names.some((n) => r.user_text.toLowerCase().includes(n)))) {
			db.prepare("DELETE FROM stm_fts WHERE event_id = ?").run(r.event_id);
			db.prepare("DELETE FROM stm_episodes WHERE event_id = ?").run(r.event_id);
		}
		// The same replies are copied into reply-review rows (future training data): those go too, for good.
		// The owner's statements about who they are (plan 0.010 self model).
		forgetSelfFacts(db, [t.person.id]);
		// The owner's notes about them (plan 0.005 Stage 2).
		forgetNotes(db, [t.person.id]);
		// The voice's shadow samples of messages to them and their labels, and their conversation's mood (plan 0.009).
		forgetVoice(
			db,
			t.scopes,
			[t.person.id],
			[t.person.display_name, ...accountsOf(db, t.person.id).map((a) => a.display_name)],
			at,
		);
		forgetReplyReviews(
			db,
			ownerTurns.map((r) => r.action_id),
			at,
		);
		// …and the images they sent (only Telegram's file id is in the payload; kept copies: `forgetMedia`).
		db.prepare(
			`UPDATE events SET payload_json = json_remove(payload_json, '$.message.image')
			 WHERE scope IN (${marks}) AND json_extract(payload_json, '$.message.image') IS NOT NULL`,
		).run(...t.scopes);
		// Telegram payloads keep their routing (chat id, user id); only the words go.
		db.prepare(
			`UPDATE events SET payload_json = json_set(payload_json, '$.message.text', ?)
			 WHERE scope IN (${marks}) AND json_extract(payload_json, '$.message.text') IS NOT NULL`,
		).run(FORGOTTEN, ...t.scopes);
		db.prepare(
			`UPDATE events SET payload_json = json_set(payload_json, '$.text', ?)
			 WHERE scope IN (${marks}) AND json_extract(payload_json, '$.text') IS NOT NULL`,
		).run(FORGOTTEN, ...t.scopes);
		db.prepare(
			`UPDATE actions SET content = ? WHERE content IS NOT NULL
			 AND event_id IN (SELECT id FROM events WHERE scope IN (${marks}))`,
		).run(FORGOTTEN, ...t.scopes);
		// Their mail (plan 0.015): the subject goes from the event, the replies' routes, and the inbox record,
		// with the address, for every mail from one of their addresses (also those dropped before admission).
		db.prepare(
			`UPDATE events SET payload_json = json_set(payload_json, '$.subject', ?, '$.from', json('null'),
				'$.messageId', json('null'), '$.inReplyTo', json('null'), '$.references', json('null'))
			 WHERE scope IN (${marks}) AND channel = 'email'`,
		).run(FORGOTTEN, ...t.scopes);
		db.prepare(
			`UPDATE actions SET route_json = ? WHERE json_extract(route_json, '$.channel') = 'email'
			 AND event_id IN (SELECT id FROM events WHERE scope IN (${marks}))`,
		).run(JSON.stringify({ channel: "email", to: FORGOTTEN, subject: FORGOTTEN }), ...t.scopes);
		const accounts = [t.person.id, ...accountsOf(db, t.person.id).map((a) => a.id)];
		const am = accounts.map(() => "?").join(", ");
		db.prepare(
			`UPDATE email_inbox SET subject = ?, from_name = NULL, from_address = ?, message_id = NULL
			 WHERE contact_id IN (${am}) OR from_address IN (
				SELECT external_id FROM channel_bindings WHERE channel = 'email' AND contact_id IN (${am})
				UNION SELECT address FROM contact_emails WHERE contact_id IN (${am}))`,
		).run(FORGOTTEN, FORGOTTEN, ...accounts, ...accounts, ...accounts);
		db.prepare(`DELETE FROM contact_emails WHERE contact_id IN (${am})`).run(...accounts);
		// Reminders sent to them (no event; their commitment says whose), and the owner's notices that quote one.
		db.prepare(
			`UPDATE actions SET content = ? WHERE content IS NOT NULL
			 AND (commitment_id IN (SELECT id FROM commitments WHERE scope IN (${marks}))
			   OR idempotency_key IN (SELECT 'notice:commitment-failed:' || id FROM commitments WHERE scope IN (${marks}))
			   OR idempotency_key IN (SELECT 'notice:commitment-missed:' || id FROM commitments WHERE scope IN (${marks})))`,
		).run(FORGOTTEN, ...t.scopes, ...t.scopes, ...t.scopes);
		db.prepare(
			`UPDATE web_feed SET text = ? WHERE action_id IN (SELECT id FROM actions WHERE idempotency_key IN (
				SELECT 'notice:commitment-failed:' || id FROM commitments WHERE scope IN (${marks})
				UNION SELECT 'notice:commitment-missed:' || id FROM commitments WHERE scope IN (${marks})))`,
		).run(FORGOTTEN, ...t.scopes, ...t.scopes);
		db.prepare(`UPDATE tool_calls SET args_json = ?, result = NULL WHERE scope IN (${marks})`).run(
			JSON.stringify(FORGOTTEN),
			...t.scopes,
		);
		const pending = parseBanks(getKv(db, PENDING_BANKS_KEY));
		setKv(db, PENDING_BANKS_KEY, JSON.stringify(pending.filter((b) => !t.banks.includes(b))), at);
		for (const scope of t.scopes) {
			const bank = bankFor(scope);
			if (bank) queueBankDeletion(db, bank, scope, at);
		}
	})();
}

export interface BankDeleter {
	deleteBank(bank: string): Promise<void>;
}

/**
 * Delete every queued bank in long-term memory. A 404 counts as deleted (it
 * never existed or is already gone). Returns the banks still pending.
 */
export async function retryBankDeletions(deps: {
	db: Db;
	ltm: BankDeleter | null;
	log: Logger;
	purgeTraces?: ((bank: string) => Promise<unknown>) | null;
}): Promise<string[]> {
	const left: string[] = [];
	for (const p of pendingBankDeletions(deps.db)) {
		if (!deps.ltm) {
			left.push(p.bank);
			continue;
		}
		try {
			try {
				await deps.ltm.deleteBank(p.bank);
			} catch (err) {
				if ((err as { status?: unknown }).status !== 404) throw err; // never created, or already gone
			}
			await deps.purgeTraces?.(p.bank);
			bankDeletionDone(deps.db, p.bank);
			deps.log.info("memory: forgotten bank deleted", { bank: p.bank });
		} catch (err) {
			const message = (err as Error).message;
			bankDeletionFailed(deps.db, p.bank, message);
			deps.log.warn("memory: deleting a forgotten bank failed; it stays queued", { bank: p.bank, error: message });
			left.push(p.bank);
		}
	}
	return left;
}

/** Banks whose deletion is queued: never read from, never written to. */
export function banksBeingForgotten(db: Db): Set<string> {
	return new Set(pendingBankDeletions(db).map((p) => p.bank));
}

export function parseBanks(raw: string | null): string[] {
	try {
		const v = JSON.parse(raw ?? "[]");
		return Array.isArray(v) ? v.filter((b): b is string => typeof b === "string") : [];
	} catch {
		return [];
	}
}
