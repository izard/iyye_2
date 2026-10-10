// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic owner commands (plan M2/M7). They are handled by the host,
 * never by Pi, and may only be invoked from an owner surface: the
 * authenticated local web chat (M4) or the host's own terminal. Telegram text
 * that looks like a command is ordinary dialogue and never reaches here.
 */

import type { ModelManager } from "../models/manager.ts";
import {
	accountsOf,
	type Contact,
	type ContactSummary,
	findContacts,
	getContact,
	linkAccount,
	linkOf,
	listContacts,
	OWNER_CONTACT_ID,
	setTrusted,
	unlinkAccount,
} from "../state/contacts.ts";
import type { Db } from "../state/db.ts";
import type { SelectionKey } from "../state/models.ts";

export interface CommandContext {
	models: ModelManager;
	db: Db;
	/** Who issued the command, recorded with each model operation. */
	issuer: string;
	/** Day and night (plan 0.002 L4); /sleep and /wake need it. */
	rhythm?: { sleep(reason: string): string; wakeForOwner(why: string): string; noteOwnerActivity(): void } | null;
	/** The /memory report (plan 0.002). */
	memoryReport?: (() => string) | null;
	/**
	 * /decisions [<role> | label <id> yes|no]: the decision service and its
	 * shadow roles (plans 0.003, 0.004 T4). `args` are the words after the command.
	 */
	decisionsReport?: ((args?: string[], issuer?: string) => string) | null;
	/** /tools: toolkits and recent tool calls (plan 0.004 T1). */
	toolsReport?: (() => string) | null;
	/** /remind, /reminders, /commitments, /cancel (plan 0.006 C1). */
	commitments?: {
		remind(input: string, by: string): string;
		reminders(): string;
		all(): string;
		cancel(ref: string, by: string): string;
	} | null;
	/** /plans, /plan <id>, /plan approve|cancel <id> (plan 0.006 C4). */
	plans?: {
		report(): string;
		detail(ref: string): string;
		approve(ref: string, by: string): string;
		cancel(ref: string, by: string): string;
	} | null;
	/** /sent: messages sent for the owner (plan 0.008). */
	sentReport?: (() => string) | null;
	/** /self, /motivation (plan 0.010 M0b, M0). */
	self?: { command(args: string[], by: string): string } | null;
	/** /pause|/resume <motivation>, /self questions|accept|dismiss (plan 0.010 M1). */
	motivations?: {
		pause(m: string, by: string): string | null;
		resume(m: string): string | null;
		questionsReport(): string;
		accept(ref: string, text: string, by: string): string;
		dismiss(ref: string): string;
	} | null;
	/** /motivation [report [days] | trace <id> | useful <id> yes|no] (plan 0.010 M0, M4). */
	motivationReport?: ((args?: string[]) => string) | null;
	/** /facts [<query> | compare | correct <id> <text> | wrong <id>] (plan 0.011). */
	facts?: { command(args: string[], by: string): string | Promise<string> } | null;
	/** /opportunities: findings that raised a question and their investigations (plan 0.007 S5). */
	opportunities?: (() => string) | null;
	/** /domains, /domain enable|disable <name> (plan 0.007 S4). */
	domains?: { report(): string; set(name: string, on: boolean): string } | null;
	/** /energy: where adenosine went (plan 0.007 S2). */
	energyReport?: (() => string) | null;
	/** /focus, /pause initiative, /resume initiative (plan 0.007 S1). */
	focus?: { report(): string | Promise<string>; pause(by: string): string; resume(): string } | null;
	/** /forget and /remember (plan 0.002 L6). */
	memoryControl?: {
		preview(contact: Contact): string;
		forget(contact: Contact, by: string): Promise<string>;
		remember(text: string): string;
	} | null;
	/** /person, /note: what Iyye knows about a person, and the owner's notes (plan 0.005 Stage 2). */
	people?: { person(args: string, by: string): string; note(args: string, by: string): string } | null;
	/** /day and /night: day/night status (plan 0.002 L4). */
	rhythmReport?: { day(): string; night(): string } | null;
}

/** Everything a host adds to the base context (models, db, issuer): reports and controls. */
export type CommandExtras = Omit<CommandContext, "models" | "db" | "issuer">;

export interface CommandResult {
	handled: boolean;
	reply: string;
}

const HELP = [
	"/models — list models, status and selection",
	"/load <model> — load a model",
	"/unload <model> — unload a model (refused while in use)",
	"/use <model> [web|telegram|memory|background] — select the model for a channel (default: both chat channels), memory work or background work",
	"/router restart — restart the model router",
	"/contacts — list contacts and their trust",
	"/trust <contact> — mark a contact as trusted (name, Telegram user id, or id): they may then ask Iyye to message anyone it knows",
	"/link <account> owner|<person> — this account is you (owner) or that person: shared conversation and memory",
	"/unlink <account> — the account is its own contact again",
	'/person <person> — what Iyye knows about someone: accounts, trust, your notes, relationship hypotheses; /person add <name> ["note"] — someone who has not written yet',
	"/note <person> <text> — a note about someone, for your conversations only; /note share|private|delete <id> — let them see it too (Iyye may repeat it to them), or not",
	"/untrust <contact> — remove a contact's trust",
	"/tools — toolkits, who may use them, and the latest tool calls",
	"/decisions — the local decision model's shadow answers and how they compared with what happened",
	"/decisions <role> — a role's recent answers; /decisions label <id> yes|no — your answer to one of them",
	"/focus — what Iyye is doing now and why, and its background work",
	"/energy — adenosine: the energy level, what it allows, and where it went today",
	"/domains — what Iyye looks at on its own; /domain enable|disable <name>",
	"/opportunities — questions Iyye's findings raised and what its investigations found",
	"/remind <when> <text> — a reminder to this chat, e.g. /remind tomorrow 9:00 call Julia",
	"/reminders — your coming reminders; /commitments — everyone's, with their states",
	"/cancel <id> — cancel a reminder (yours or a contact's)",
	"/plans — plans and their states; /plan <id> — its steps and evidence",
	"/sent — messages Iyye sent to people for you, with their delivery",
	"/self — what Iyye knows about itself (hardware, power, sleep, versions, place, people) and its gaps; /self set place|expected-hardware <text>, /self relation <contact> <text>",
	"/motivation — the four needs (self-preservation, curiosity, agency, social), their evidence, and what would be opened",
	"/motivation report [days] — what each motivation opened, tried, resolved and was held back from (the trial period by default); /motivation trace <id>; /motivation useful <id> yes|no",
	"/facts — facts extracted today; /facts <words> — beliefs about them, with sources; /facts compare — last night's structured facts; /facts confirm <id>, /facts correct <id> <text>, /facts wrong <id>; /facts private|share <id>",
	"/plan approve <id> — let a proposed plan run; /plan cancel <id> — drop a plan and its coming steps",
	"/pause initiative, /resume initiative — stop or allow background work",
	"/pause <motivation>, /resume <motivation> — self-preservation, curiosity, agency or social: stop or allow what it opens and does",
	"/self questions — what Iyye asked about itself; /self accept <id> [answer], /self dismiss <id>; /self estimate misleading",
	"/day — awake or asleep, day number, when the next night starts and why",
	"/night — the night in progress (what it is doing, what is left) and the last night's result",
	"/memory — memory status: short-term (today) and long-term, the last night",
	"/remember <text> — remember this: in short-term memory now, stored first tonight",
	"/forget <contact> [confirm] — forget a person: shows what would go; with confirm, deletes their memory",
	"/sleep — go to sleep now: move today's memory into long-term memory",
	"/wake — wake up now (the night's work continues later)",
].join("\n");

const COMMANDS = new Set([
	"/help",
	"/models",
	"/load",
	"/unload",
	"/use",
	"/router",
	"/contacts",
	"/trust",
	"/untrust",
	"/link",
	"/unlink",
	"/person",
	"/note",
	"/memory",
	"/remember",
	"/forget",
	"/tools",
	"/decisions",
	"/day",
	"/focus",
	"/energy",
	"/domains",
	"/opportunities",
	"/remind",
	"/reminders",
	"/commitments",
	"/cancel",
	"/plans",
	"/sent",
	"/self",
	"/motivation",
	"/facts",
	"/plan",
	"/domain",
	"/pause",
	"/resume",
	"/night",
	"/sleep",
	"/wake",
]);

export function isCommand(text: string): boolean {
	return text.trimStart().startsWith("/");
}

/**
 * True only for the host's own commands. Other text starting with "/" (a
 * pasted path, "/shrug") is ordinary chat.
 */
export function isKnownCommand(text: string): boolean {
	return COMMANDS.has(text.trim().split(/\s+/)[0] ?? "");
}

export async function handleOwnerCommand(text: string, ctx: CommandContext): Promise<CommandResult> {
	const [cmd, ...args] = text.trim().split(/\s+/);
	if (cmd !== "/sleep") ctx.rhythm?.noteOwnerActivity(); // the owner is here: not a quiet moment to fall asleep
	switch (cmd) {
		case "/help":
			return { handled: true, reply: HELP };
		case "/models":
			return { handled: true, reply: await renderModels(ctx.models) };
		case "/load":
			if (args.length !== 1) return usage("/load <model>");
			return result(await ctx.models.load(args[0]!, ctx.issuer));
		case "/unload":
			if (args.length !== 1) return usage("/unload <model>");
			return result(await ctx.models.unload(args[0]!, ctx.issuer));
		case "/use": {
			const target = args[1];
			if (
				args.length < 1 ||
				args.length > 2 ||
				(target !== undefined && !["web", "telegram", "memory", "background"].includes(target))
			) {
				return usage("/use <model> [web|telegram|memory|background]");
			}
			const keys: SelectionKey[] = target === undefined ? ["web", "telegram"] : [target as SelectionKey];
			const replies: string[] = [];
			for (const key of keys) {
				const r = await ctx.models.select(key, args[0]!, ctx.issuer);
				replies.push(r.message);
				if (!r.ok) break;
			}
			return { handled: true, reply: replies.join("\n") };
		}
		case "/router":
			if (args.length !== 1 || args[0] !== "restart") return usage("/router restart");
			return result(await ctx.models.restartRouter(ctx.issuer));
		case "/contacts":
			return { handled: true, reply: renderContacts(ctx.db) };
		case "/link": {
			if (args.length !== 2) return usage("/link <account> owner|<person>");
			return { handled: true, reply: link(ctx, args[0]!, args[1]!) };
		}
		case "/unlink": {
			const ref = text.trim().slice(cmd.length).trim();
			if (!ref) return usage("/unlink <account>");
			return { handled: true, reply: unlink(ctx, ref) };
		}
		case "/person":
		case "/note": {
			if (!ctx.people) return { handled: true, reply: "people are not available here" };
			const rest = text.trim().slice(cmd.length);
			return {
				handled: true,
				reply: cmd === "/person" ? ctx.people.person(rest, ctx.issuer) : ctx.people.note(rest, ctx.issuer),
			};
		}
		case "/trust":
		case "/untrust": {
			const ref = text.trim().slice(cmd.length).trim();
			if (!ref) return usage(`${cmd} <contact>`);
			return { handled: true, reply: changeTrust(ctx, ref, cmd === "/trust") };
		}
		case "/remind":
		case "/reminders":
		case "/commitments":
		case "/cancel": {
			if (!ctx.commitments) return { handled: true, reply: "reminders are not available here" };
			const rest = text.trim().slice(cmd.length).trim();
			if (cmd === "/remind") return { handled: true, reply: ctx.commitments.remind(rest, ctx.issuer) };
			if (cmd === "/reminders") return { handled: true, reply: ctx.commitments.reminders() };
			if (cmd === "/commitments") return { handled: true, reply: ctx.commitments.all() };
			if (!rest) return usage("/cancel <id>");
			return { handled: true, reply: ctx.commitments.cancel(rest, ctx.issuer) };
		}
		case "/self": {
			const q = ctx.motivations;
			if (q && args[0] === "questions") return { handled: true, reply: q.questionsReport() };
			if (q && args[0] === "accept" && args[1])
				return {
					handled: true,
					reply: q.accept(args[1], text.trim().split(/\s+/).slice(3).join(" "), ctx.issuer),
				};
			if (q && args[0] === "dismiss" && args[1]) return { handled: true, reply: q.dismiss(args[1]) };
			return {
				handled: true,
				reply: ctx.self ? ctx.self.command(args, ctx.issuer) : "the self model is not available here",
			};
		}
		case "/motivation":
			return {
				handled: true,
				reply: ctx.motivationReport ? ctx.motivationReport(args) : "motivations are not available here",
			};
		case "/facts":
			return {
				handled: true,
				reply: ctx.facts ? await ctx.facts.command(args, ctx.issuer) : "facts are not available here",
			};
		case "/sent":
			return { handled: true, reply: ctx.sentReport ? ctx.sentReport() : "sending is not available here" };
		case "/plans":
		case "/plan": {
			if (!ctx.plans) return { handled: true, reply: "plans are not available here" };
			if (cmd === "/plans") return { handled: true, reply: ctx.plans.report() };
			const [sub, ref] = args;
			if ((sub === "approve" || sub === "cancel") && ref && args.length === 2)
				return {
					handled: true,
					reply: sub === "approve" ? ctx.plans.approve(ref, ctx.issuer) : ctx.plans.cancel(ref, ctx.issuer),
				};
			if (sub && args.length === 1 && sub !== "approve" && sub !== "cancel")
				return { handled: true, reply: ctx.plans.detail(sub) };
			return usage("/plan <id> | /plan approve <id> | /plan cancel <id>");
		}
		case "/opportunities":
			return {
				handled: true,
				reply: ctx.opportunities ? ctx.opportunities() : "investigations are not available here",
			};
		case "/domains":
			return { handled: true, reply: ctx.domains ? ctx.domains.report() : "observation is not available here" };
		case "/domain": {
			if (args.length !== 2 || (args[0] !== "enable" && args[0] !== "disable"))
				return usage("/domain enable|disable <name>");
			if (!ctx.domains) return { handled: true, reply: "observation is not available here" };
			return { handled: true, reply: ctx.domains.set(args[1]!, args[0] === "enable") };
		}
		case "/energy":
			return { handled: true, reply: ctx.energyReport ? ctx.energyReport() : "energy is not available here" };
		case "/focus":
			return { handled: true, reply: ctx.focus ? await ctx.focus.report() : "focus is not available here" };
		case "/pause":
		case "/resume": {
			const which = "initiative | self-preservation | curiosity | agency | social";
			if (args.length !== 1) return usage(`${cmd} ${which}`);
			if (args[0] !== "initiative") {
				const m = ctx.motivations;
				const reply = m ? (cmd === "/pause" ? m.pause(args[0]!, ctx.issuer) : m.resume(args[0]!)) : null;
				return reply ? { handled: true, reply } : usage(`${cmd} ${which}`);
			}
			if (!ctx.focus) return { handled: true, reply: "background work is not available here" };
			return { handled: true, reply: cmd === "/pause" ? ctx.focus.pause(ctx.issuer) : ctx.focus.resume() };
		}
		case "/decisions":
			return {
				handled: true,
				reply: ctx.decisionsReport ? ctx.decisionsReport(args, ctx.issuer) : "decisions are not available here",
			};
		case "/tools":
			return { handled: true, reply: ctx.toolsReport ? ctx.toolsReport() : "tools are not available here" };
		case "/day":
			return {
				handled: true,
				reply: ctx.rhythmReport ? ctx.rhythmReport.day() : "day and night are not available here",
			};
		case "/night":
			return {
				handled: true,
				reply: ctx.rhythmReport ? ctx.rhythmReport.night() : "day and night are not available here",
			};
		case "/remember": {
			if (!ctx.memoryControl) return { handled: true, reply: "memory is not available here" };
			return { handled: true, reply: ctx.memoryControl.remember(text.trim().slice(cmd.length)) };
		}
		case "/forget": {
			if (!ctx.memoryControl) return { handled: true, reply: "memory is not available here" };
			const confirm = args.length > 1 && args.at(-1) === "confirm";
			const ref = (confirm ? args.slice(0, -1) : args).join(" ");
			if (!ref) return usage("/forget <contact> [confirm]");
			const c = oneContact(ctx, ref);
			if (typeof c === "string") return { handled: true, reply: c };
			return {
				handled: true,
				reply: confirm ? await ctx.memoryControl.forget(c, ctx.issuer) : ctx.memoryControl.preview(c),
			};
		}
		case "/memory":
			return { handled: true, reply: ctx.memoryReport ? ctx.memoryReport() : "memory is not available here" };
		case "/sleep":
			return {
				handled: true,
				reply: ctx.rhythm ? ctx.rhythm.sleep("the owner asked") : "sleep is not available here",
			};
		case "/wake":
			return {
				handled: true,
				reply: ctx.rhythm ? ctx.rhythm.wakeForOwner("the owner asked") : "sleep is not available here",
			};
		default:
			return { handled: false, reply: `unknown command ${cmd}\n${HELP}` };
	}
}

async function renderModels(models: ModelManager): Promise<string> {
	const s = await models.status();
	const ram = s.availableRamGb === null ? "unknown" : `${s.availableRamGb.toFixed(1)} GB`;
	const lines = [
		`router: ${s.router}${s.routerPid ? ` (pid ${s.routerPid})` : ""} · free RAM: ${ram} · max loaded: ${s.modelsMax}`,
	];
	for (const m of s.models) {
		const flags = [
			m.status + (m.failed ? " (last load failed)" : ""),
			`${m.ramRequiredGb} GB`,
			m.inUse > 0 ? `in use ×${m.inUse}` : "",
			m.selectedFor.length > 0 ? `selected: ${m.selectedFor.join(", ")}` : "",
		].filter(Boolean);
		lines.push(`  ${m.name} — ${flags.join(" · ")}`);
	}
	return lines.join("\n");
}

function result(r: { ok: boolean; message: string }): CommandResult {
	return { handled: true, reply: r.ok ? r.message : `refused: ${r.message}` };
}

function usage(u: string): CommandResult {
	return { handled: true, reply: `usage: ${u}` };
}

function renderContacts(db: Db): string {
	const contacts = listContacts(db);
	const when = (c: ContactSummary) =>
		c.last_seen ? ` · last message ${c.last_seen.slice(0, 16).replace("T", " ")}` : "";
	const account = (c: ContactSummary) =>
		`${c.display_name} (${c.bindings ?? "no channel"} · id ${c.id.slice(0, 8)}${when(c)})`;
	const lines: string[] = [];
	const own = contacts.filter((c) => linkOf(db, c.id)?.person_id === OWNER_CONTACT_ID);
	lines.push(`you (owner) — web chat${own.length ? `; your accounts: ${own.map(account).join(", ")}` : ""}`);
	const persons = contacts.filter((c) => !linkOf(db, c.id));
	if (persons.length === 0 && own.length === 0) return "no contacts yet";
	for (const p of persons) {
		const accounts = accountsOf(db, p.id)
			.map((a) => contacts.find((c) => c.id === a.id)!)
			.filter(Boolean);
		const twins = persons.filter(
			(o) => o.id !== p.id && o.display_name.toLowerCase() === p.display_name.toLowerCase(),
		);
		const notes = (
			db.prepare("SELECT count(*) AS n FROM person_notes WHERE person_id = ?").get(p.id) as { n: number }
		).n;
		lines.push(
			`${p.display_name} — ${p.trusted ? "trusted" : "not trusted"} · ${p.bindings ?? (accounts.length ? "no channel of its own" : "no account yet")} · id ${p.id.slice(0, 8)}${when(p)}${notes ? ` · ${notes} note${notes === 1 ? "" : "s"}` : ""}` +
				(accounts.length ? `\n    accounts: ${accounts.map(account).join(", ")}` : "") +
				(twins.length
					? `\n    same name as ${twins.map((t) => `id ${t.id.slice(0, 8)}`).join(", ")}: if this is the same person, /link one to the other`
					: ""),
		);
	}
	return lines.join("\n");
}

/** One contact by an owner's reference, or the reason there is none (ambiguity changes nothing). */
function oneContact(ctx: CommandContext, ref: string): Contact | string {
	const matches = findContacts(ctx.db, ref);
	if (matches.length === 0) return `no contact matches ${JSON.stringify(ref)}; see /contacts`;
	if (matches.length > 1) {
		return `${JSON.stringify(ref)} matches ${matches.length} contacts; use an id:\n${matches
			.map((c) => `  ${c.display_name} — id ${c.id.slice(0, 8)}`)
			.join("\n")}`;
	}
	return matches[0]!;
}

/**
 * Identity links are deterministic owner operations (plan 0.005, HLD §6.2):
 * only from an owner surface, never inferred from what anyone wrote.
 */
function link(ctx: CommandContext, accountRef: string, personRef: string): string {
	const account = oneContact(ctx, accountRef);
	if (typeof account === "string") return account;
	const toOwner = personRef.toLowerCase() === "owner";
	const person = toOwner ? getContact(ctx.db, OWNER_CONTACT_ID) : oneContact(ctx, personRef);
	if (!person) return "no owner contact";
	if (typeof person === "string") return person;
	try {
		linkAccount(ctx.db, account.id, person.id, ctx.issuer, new Date().toISOString());
	} catch (err) {
		return `refused: ${(err as Error).message}`;
	}
	const name = `${account.display_name} (id ${account.id.slice(0, 8)})`;
	if (toOwner) {
		return `${name} is now linked to you, the owner. Messages from it are yours: the same conversation and memory as the web chat, owner tools, and it can read everything Iyye knows. Owner commands still work only here and in the terminal.`;
	}
	const trustNote =
		account.trusted === person.trusted
			? `Trust is unchanged (${person.trusted ? "trusted" : "not trusted"}).`
			: `Trust follows the person: this account is now ${person.trusted ? "TRUSTED" : "NOT trusted"} (it was ${account.trusted ? "trusted" : "not trusted"}).`;
	return `${name} is now an account of ${person.display_name} (id ${person.id.slice(0, 8)}): it speaks as ${person.display_name}, with their conversation and memory, and its earlier memory is theirs to recall. ${trustNote}`;
}

function unlink(ctx: CommandContext, ref: string): string {
	const account = oneContact(ctx, ref);
	if (typeof account === "string") return account;
	const was = linkOf(ctx.db, account.id);
	if (!was || !unlinkAccount(ctx.db, account.id))
		return `${account.display_name} (id ${account.id.slice(0, 8)}) is not linked`;
	const person =
		was.person_id === OWNER_CONTACT_ID ? "you" : (getContact(ctx.db, was.person_id)?.display_name ?? was.person_id);
	return `${account.display_name} (id ${account.id.slice(0, 8)}) is its own contact again (its earlier conversation and memory). What it said while linked stays with ${person}.`;
}

/**
 * Trust changes are deterministic owner operations (HLD §9.2): only callable
 * from an owner surface, recorded with who made them, and never inferred from
 * anything a contact said. An ambiguous reference changes nothing.
 */
function changeTrust(ctx: CommandContext, ref: string, trusted: boolean): string {
	const matches = findContacts(ctx.db, ref);
	if (matches.length === 0) return `no contact matches ${JSON.stringify(ref)}; see /contacts`;
	if (matches.length > 1) {
		return `${JSON.stringify(ref)} matches ${matches.length} contacts; use an id:\n${matches
			.map((c) => `  ${c.display_name} — id ${c.id.slice(0, 8)}`)
			.join("\n")}`;
	}
	const c = matches[0]!;
	const link = linkOf(ctx.db, c.id);
	if (link) {
		const person =
			link.person_id === OWNER_CONTACT_ID
				? "you, the owner"
				: (getContact(ctx.db, link.person_id)?.display_name ?? link.person_id);
		return `${c.display_name} (id ${c.id.slice(0, 8)}) is an account of ${person}; trust is per person${link.person_id === OWNER_CONTACT_ID ? "" : `: use /${trusted ? "trust" : "untrust"} on ${person}`}`;
	}
	setTrusted(ctx.db, c.id, trusted, ctx.issuer, new Date().toISOString());
	return trusted
		? `${c.display_name} is now trusted. They may ask Iyye to send Telegram messages to anyone Iyye knows (labelled with their name, capped per day, and each one reported to you); /untrust stops that.`
		: `${c.display_name} is now not trusted`;
}
