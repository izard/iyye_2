// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * The observer (plan 0.007 S4): probes the owner-approved domains while
 * awake, when they are stale, and turns changes that matter into findings.
 *
 * 1. Every probe run is an `observations` row, with its change against the
 *    previous run (the domain's deterministic rule).
 * 2. A change goes to the importance check (Kev, acting; fallback: the rule).
 * 3. A finding enters short-term memory (scope `iyye`, owner-readable, kind
 *    `observation`; at night, the bank `iyye-self`) and becomes a web chat
 *    message: at most `findingsPerDay`, never while asleep, held while a
 *    conversation is active (owner decision 7: web UI only).
 *
 * Probes are cheap and use no model, so they need no device slot; only the
 * Kev check takes it, and a busy device defers the decision to a later tick.
 */

import { createHash } from "node:crypto";
import type { ImportanceResult } from "../decisions/observation-importance.ts";
import type { Logger } from "../log.ts";
import type { Db } from "../state/db.ts";
import { getKv, setKv } from "../state/kv.ts";
import { INVESTIGATION_DOMAIN } from "../state/observations.ts";
import { recordIyyeEntry } from "../state/stm.ts";
import type { Domain, ProbeResult, Severity } from "./domains.ts";

const ENABLED_KEY = "observe.enabled";

export interface ObservationRow {
	id: string;
	domain: string;
	at: string;
	result_json: string;
	severity: Severity;
	change_text: string | null;
	decision_id: string | null;
	decided_by: string | null;
	finding: number;
	notified_at: string | null;
}

export interface ObserverDeps {
	db: Db;
	domains: Domain[];
	/** Enabled until the owner says otherwise; the rest need `/domain enable`. */
	defaultEnabled: string[];
	importance: {
		decide(i: {
			observationId: string;
			domain: string;
			change: string;
			severity: Severity;
		}): Promise<ImportanceResult>;
	};
	notifyOwner: (key: string, text: string) => Promise<unknown>;
	mode: () => "awake" | "winding_down" | "asleep";
	log: Logger;
	findingsPerDay?: number;
	/** No finding message within this long of chat activity; it waits. */
	quietMs?: number;
	tickMs?: number;
	now?: () => Date;
	newId?: () => string;
}

export class Observer {
	private readonly d: Required<ObserverDeps>;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;

	constructor(deps: ObserverDeps) {
		this.d = {
			findingsPerDay: 5,
			quietMs: 180_000,
			tickMs: 60_000,
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
			...deps,
		};
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), this.d.tickMs);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.running;
	}

	enabled(): string[] {
		const raw = getKv(this.d.db, ENABLED_KEY);
		if (raw === null) return this.d.defaultEnabled.filter((n) => this.d.domains.some((d) => d.name === n));
		try {
			return (JSON.parse(raw) as string[]).filter((n) => this.d.domains.some((d) => d.name === n));
		} catch {
			return [];
		}
	}

	/** `/domain enable|disable <name>`: owner only. */
	setEnabled(name: string, on: boolean): string {
		const domain = this.d.domains.find((d) => d.name === name);
		if (!domain) return `no domain ${JSON.stringify(name)}; domains: ${this.d.domains.map((d) => d.name).join(", ")}`;
		const now = new Set(this.enabled());
		if (on) now.add(name);
		else now.delete(name);
		setKv(this.d.db, ENABLED_KEY, JSON.stringify([...now]), this.d.now().toISOString());
		return on
			? `${name} enabled: Iyye looks at ${domain.description} when nobody has for ${Math.round(domain.stalenessMs / 3_600_000)} h`
			: `${name} disabled: Iyye no longer looks at it`;
	}

	/** One pass: probe stale domains, decide pending changes, send pending findings. Public for tests. */
	tick(): Promise<void> {
		if (this.running) return this.running;
		this.running = this.pass().finally(() => {
			this.running = null;
		});
		return this.running;
	}

	/** `/domains`. */
	report(): string {
		const on = new Set(this.enabled());
		const lines = ["observation domains (Iyye looks at an enabled one when nobody has for its window):"];
		for (const d of this.d.domains) {
			const last = this.last(d.name);
			lines.push(
				`  ${d.name} — ${on.has(d.name) ? "enabled" : "disabled"} · every ${Math.round(d.stalenessMs / 3_600_000)} h · ${d.description}` +
					(last
						? `\n    last look ${hhmm(last.at)}${last.change_text ? `: ${last.change_text}` : ": no change"}${last.finding ? " (finding)" : ""}`
						: "\n    not looked at yet"),
			);
		}
		const today = this.findingsToday();
		lines.push(
			`findings today: ${today} of at most ${this.d.findingsPerDay} messages · /domain enable|disable <name>`,
		);
		return lines.join("\n");
	}

	private async pass(): Promise<void> {
		if (this.d.mode() !== "awake") return; // asleep: no probes; staleness waits for waking
		const enabled = new Set(this.enabled());
		for (const domain of this.d.domains.filter((d) => enabled.has(d.name))) {
			const last = this.last(domain.name);
			if (last && this.d.now().getTime() - Date.parse(last.at) < domain.stalenessMs) continue;
			await this.observe(domain, last);
		}
		await this.decidePending();
		await this.deliverPending();
	}

	private async observe(domain: Domain, last: ObservationRow | undefined): Promise<void> {
		let result: ProbeResult;
		try {
			result = await domain.probe();
		} catch (err) {
			result = { error: (err as Error).message };
		}
		const prev = last ? (JSON.parse(last.result_json) as ProbeResult) : null;
		const change = domain.compare(prev, result, this.d.now());
		const json = JSON.stringify(result);
		this.d.db
			.prepare(
				`INSERT INTO observations (id, domain, at, result_json, result_hash, severity, change_text)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				this.d.newId(),
				domain.name,
				this.d.now().toISOString(),
				json,
				createHash("sha256").update(json).digest("hex"),
				change.severity,
				change.text,
			);
	}

	/** Changes not yet decided (new, or deferred while the device was busy), oldest first. */
	private async decidePending(): Promise<void> {
		const pending = this.d.db
			.prepare("SELECT * FROM observations WHERE severity != 'none' AND decided_by IS NULL ORDER BY at")
			.all() as ObservationRow[];
		for (const o of pending) {
			const r = await this.d.importance.decide({
				observationId: o.id,
				domain: o.domain,
				change: o.change_text ?? "",
				severity: o.severity,
			});
			if (r.kind === "deferred") return; // the device is busy; try again next tick
			this.d.db
				.prepare("UPDATE observations SET decision_id = ?, decided_by = ?, finding = ? WHERE id = ?")
				.run(r.decisionId, r.by, r.finding ? 1 : 0, o.id);
			if (r.finding) {
				recordIyyeEntry(this.d.db, {
					id: `obs:${o.id}`,
					kind: "observation",
					text: `${o.domain}: ${o.change_text}`,
					at: o.at,
				});
				this.d.log.info("observe: finding", { domain: o.domain, by: r.by });
			}
		}
	}

	/** Finding messages not yet sent: awake, no conversation in the last `quietMs`, within the daily cap. */
	private async deliverPending(): Promise<void> {
		if (this.d.mode() !== "awake") return;
		const pending = this.d.db
			.prepare("SELECT * FROM observations WHERE finding = 1 AND notified_at IS NULL ORDER BY at")
			.all() as ObservationRow[];
		if (pending.length === 0) return;
		const lastChat = (
			this.d.db.prepare("SELECT max(coalesce(settled_at, created_at)) AS t FROM jobs").get() as { t: string | null }
		).t;
		if (lastChat && this.d.now().getTime() - Date.parse(lastChat) < this.d.quietMs) return; // held during a conversation
		for (const o of pending) {
			const at = this.d.now().toISOString();
			if (this.findingsToday() >= this.d.findingsPerDay) {
				// Over the cap: kept in memory, not sent (the day summary still counts it).
				this.d.db.prepare("UPDATE observations SET notified_at = ? WHERE id = ?").run(`cap:${at}`, o.id);
				continue;
			}
			await this.d.notifyOwner(
				`finding:${o.id}`,
				o.domain === INVESTIGATION_DOMAIN
					? `I looked into it: ${o.change_text}`
					: `I noticed (${o.domain}): ${o.change_text}`,
			);
			this.d.db.prepare("UPDATE observations SET notified_at = ? WHERE id = ?").run(at, o.id);
		}
	}

	private findingsToday(): number {
		const start = new Date(this.d.now());
		start.setHours(0, 0, 0, 0);
		return (
			this.d.db
				.prepare("SELECT count(*) AS n FROM observations WHERE notified_at >= ? AND notified_at NOT LIKE 'cap:%'")
				.get(start.toISOString()) as { n: number }
		).n;
	}

	private last(domain: string): ObservationRow | undefined {
		return this.d.db
			.prepare("SELECT * FROM observations WHERE domain = ? ORDER BY at DESC, rowid DESC LIMIT 1")
			.get(domain) as ObservationRow | undefined;
	}
}

function hhmm(iso: string): string {
	return new Date(iso).toTimeString().slice(0, 5);
}
