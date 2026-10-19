// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner memory controls (plan 0.002 L6, HLD §6.4): `/forget` and `/remember`.
 * Called only from owner commands (local web chat, terminal).
 */

import { deleteQueuedFactDocs } from "../facts/night.ts";
import type { Logger } from "../log.ts";
import type { Contact } from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import { recordRemember } from "../state/stm.ts";
import {
	type BankDeleter,
	forgetBusy,
	forgetMedia,
	forgetRecords,
	forgetTarget,
	imageEvents,
	planSessions,
	retryBankDeletions,
} from "./forget.ts";
import type { HindsightClient } from "./hindsight.ts";
import { mentionPattern } from "./mentions.ts";

export interface MemoryControlDeps {
	db: Db;
	ltm: (BankDeleter & Partial<Pick<HindsightClient, "deleteDocument">>) | null;
	log: Logger;
	/** "awake" | "winding_down" | "asleep": forgetting waits for the day, when no night writes to the banks. */
	mode: () => string;
	/** Close and delete these scopes' Pi conversations. */
	forgetConversations: (scopes: readonly string[]) => Promise<number>;
	/** Start the owner's conversation afresh: today's replies in it may quote the person. */
	retireConversations?: (scopes: readonly string[]) => Promise<void>;
	/** Close and delete background conversations (their plans' steps, plan 0.006 C4: the prompts quote them). */
	forgetBackground?: (scopes: readonly string[]) => Promise<number>;
	/** Drop queued shadow-decision work for these scopes. */
	forgetQueued?: (scopes: readonly string[]) => void;
	/**
	 * Transcripts that name the person (owner decision 2026-10-19), in every conversation store: how many
	 * there are, and deleting them.
	 */
	transcripts?: {
		count: (names: RegExp | null, exclude: readonly string[]) => number;
		erase: (names: RegExp | null) => Promise<number>;
	} | null;
	/** `<state>/media`: kept copies of images they sent (the vision tool); null when there is none. */
	mediaDir?: string | null;
	purgeTraces?: ((bank: string) => Promise<unknown>) | null;
	now?: () => Date;
	newId?: () => string;
}

const REMEMBER_MAX_CHARS = 4000;

const names = (n: readonly string[]) =>
	n.length ? n.map((x) => JSON.stringify(x)).join(", ") : "no name long enough to look for";

export class MemoryControl {
	private readonly d: Required<MemoryControlDeps>;

	constructor(deps: MemoryControlDeps) {
		this.d = {
			forgetQueued: () => {},
			forgetBackground: async () => 0,
			retireConversations: async () => {},
			purgeTraces: null,
			mediaDir: null,
			transcripts: null,
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			...deps,
		};
	}

	/** `/forget <contact>` without `confirm`: what would go. Changes nothing. */
	preview(contact: Contact): string {
		const t = forgetTarget(this.d.db, contact);
		if (typeof t === "string") return t;
		const c = t.counts;
		const accounts = t.scopes.length > 1 ? ` and their ${t.scopes.length - 1} linked account(s)` : "";
		return [
			`/forget would remove what Iyye remembers about ${t.person.display_name} (id ${t.person.id.slice(0, 8)})${accounts}:`,
			`  - long-term memory: ${t.banks.length} bank(s), deleted`,
			`  - short-term memory: ${c.stm} entr${c.stm === 1 ? "y" : "ies"}, deleted`,
			`  - conversation transcripts and the images they sent: deleted`,
			`  - ${c.messages} message(s), Iyye's replies and ${c.toolCalls} tool call(s): text replaced by "[forgotten]" (dates and delivery records stay)`,
			`  - ${c.decisions} shadow decision(s) and your notes about them: deleted`,
			`  - your conversation with Iyye: starts afresh; its replies to you not yet stored are dropped (they may quote them); your own words stay`,
			`  - ${t.storedReplies.length} of Iyye's replies to you stored on earlier nights and ${t.storedSummaries.length} stored day summar${t.storedSummaries.length === 1 ? "y" : "ies"} that name them (${names(t.names)}): deleted from long-term memory`,
			`  - ${this.d.transcripts?.count(mentionPattern(t.names), t.scopes) ?? 0} other conversation transcript(s) that name them: deleted (a conversation using one starts afresh)`,
			`Kept: the contact, its channels and its trust, so new messages are answered and remembered normally.`,
			`Not covered: what you yourself told Iyye about them stays in your memory; so does anything that quotes them without naming them. A namesake's mentions go too.`,
			`To do it: /forget ${t.person.id.slice(0, 8)} confirm`,
		].join("\n");
	}

	/** `/forget <contact> confirm`. */
	async forget(contact: Contact, by: string): Promise<string> {
		const t = forgetTarget(this.d.db, contact);
		if (typeof t === "string") return t;
		if (this.d.mode() !== "awake") {
			return "refused: Iyye is not awake (the night writes to long-term memory); /wake first, then /forget again";
		}
		const busy = forgetBusy(this.d.db, t.scopes);
		if (busy) return `refused: ${busy}; try again when that is done`;
		const steps = planSessions(this.d.db, t.scopes);
		const images = imageEvents(this.d.db, t.scopes);
		forgetRecords(this.d.db, t, by, this.d.now().toISOString());
		try {
			if (this.d.mediaDir) forgetMedia(this.d.mediaDir, images);
		} catch (err) {
			this.d.log.warn("memory: deleting forgotten images failed", { error: (err as Error).message });
		}
		this.d.forgetQueued(t.scopes);
		let transcripts = 0;
		try {
			transcripts = await this.d.forgetConversations(t.scopes);
			transcripts += await this.d.forgetBackground(steps);
			await this.d.retireConversations(["owner"]);
			transcripts += (await this.d.transcripts?.erase(mentionPattern(t.names))) ?? 0;
		} catch (err) {
			this.d.log.warn("memory: deleting forgotten transcripts failed", { error: (err as Error).message });
		}
		// Stored replies and summaries that named them: queued in the transaction, deleted now if memory is up
		// (otherwise at the next night, which deletes what is queued before it writes).
		let docsLeft = 0;
		if (this.d.ltm?.deleteDocument && (t.storedReplies.length || t.storedSummaries.length)) {
			docsLeft = await deleteQueuedFactDocs(
				this.d.db,
				this.d.ltm as Pick<HindsightClient, "deleteDocument">,
				this.d.log,
			).catch(() => -1);
		}
		const left = await retryBankDeletions({
			db: this.d.db,
			ltm: this.d.ltm,
			log: this.d.log,
			purgeTraces: this.d.purgeTraces,
		});
		const pending = t.banks.filter((b) => left.includes(b));
		return [
			`Forgotten: ${t.person.display_name} (id ${t.person.id.slice(0, 8)}). Short-term memory, ${transcripts} conversation transcript(s) and folder(s) and the text of their messages are gone.`,
			...(t.storedReplies.length || t.storedSummaries.length
				? [
						`Iyye's stored words that named them: ${t.storedReplies.length} repl${t.storedReplies.length === 1 ? "y" : "ies"} to you and ${t.storedSummaries.length} day summar${t.storedSummaries.length === 1 ? "y" : "ies"}${docsLeft === 0 ? ", deleted from long-term memory" : ", queued for deletion from long-term memory (retried every night)"}.`,
					]
				: []),
			pending.length === 0
				? `Long-term memory: deleted.`
				: `Long-term memory: deletion is queued (${pending.length} bank(s) not reachable now); it is retried at startup and every night, and nothing is read from or written to them until then.`,
			`Your conversation with Iyye starts afresh (its replies today may have quoted them), and its replies to you that were not yet stored are dropped; your own words stay.`,
			`Kept: the contact, its channels and trust. Not covered: what you told Iyye about them, and anything that quotes them without naming them.`,
		].join("\n");
	}

	/** `/remember <text>`: an explicit owner fact, recallable now and stored first at night. */
	remember(text: string): string {
		const t = text.trim();
		if (!t) return "usage: /remember <what to remember>";
		if (t.length > REMEMBER_MAX_CHARS) return `refused: at most ${REMEMBER_MAX_CHARS} characters`;
		recordRemember(this.d.db, { id: this.d.newId(), text: t, at: this.d.now().toISOString() });
		return "Noted. It is in short-term memory now and goes to long-term memory first thing tonight.";
	}

	/** Startup: finish any deletion a crash or an outage left queued. */
	async resumeDeletions(): Promise<string[]> {
		return retryBankDeletions({
			db: this.d.db,
			ltm: this.d.ltm,
			log: this.d.log,
			purgeTraces: this.d.purgeTraces,
		});
	}
}
