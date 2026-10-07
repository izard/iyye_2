// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Service status (plan 0.010 M1): every minute, each service's state, since
 * when, and its last error go into `service_status`, the one source the
 * self-preservation signals read. 2026-10-07: Telegram was "retrying" for
 * eight hours and only the host's console knew why.
 *
 * - A change of state resets `since`; a new detail in the same state does
 *   not ("retrying in 12 s" changes on every retry).
 * - The error text keeps no retry countdown and no bot token (a second line
 *   of defence: the poller scrubs its own token already).
 */

import type { Db } from "../state/db.ts";

/** States that are fine, or on their way to fine: no error, no outage. */
export const OK_SERVICE_STATES = new Set(["up", "connected", "disabled", "not installed", "starting", "restarting"]);

export type ServiceProbe = () => Record<string, { state: string; detail?: string }>;

export interface ServiceStatusRow {
	name: string;
	state: string;
	since: string;
	last_error: string | null;
	last_error_at: string | null;
	updated_at: string;
}

/** Strip what must never be stored (a bot token) and what is noise (the retry countdown). */
export function cleanError(detail: string): string {
	return detail
		.replace(/bot\d+:[\w-]+/g, "bot<token>")
		.replace(/\b\d{6,}:[\w-]{20,}\b/g, "<token>")
		.replace(/;?\s*retrying in \d+ s\s*$/i, "")
		.trim()
		.slice(0, 300);
}

/** Record the services' current states (one call per minute from the host). */
export function recordServices(db: Db, probe: ServiceProbe, now: Date): void {
	const at = now.toISOString();
	const services = probe();
	db.transaction(() => {
		for (const [name, s] of Object.entries(services)) {
			const old = db.prepare("SELECT * FROM service_status WHERE name = ?").get(name) as
				| ServiceStatusRow
				| undefined;
			const failing = !OK_SERVICE_STATES.has(s.state);
			const error = failing && s.detail ? cleanError(s.detail) : null;
			if (!old) {
				db.prepare(
					"INSERT INTO service_status (name, state, since, last_error, last_error_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				).run(name, s.state, at, error, error ? at : null, at);
				continue;
			}
			db.prepare(
				`UPDATE service_status SET state = ?, since = ?, updated_at = ?,
					last_error = coalesce(?, last_error), last_error_at = CASE WHEN ? IS NULL THEN last_error_at ELSE ? END
				 WHERE name = ?`,
			).run(s.state, old.state === s.state ? old.since : at, at, error, error, at, name);
		}
	})();
}

export function serviceStatuses(db: Db): ServiceStatusRow[] {
	return db.prepare("SELECT * FROM service_status ORDER BY name").all() as ServiceStatusRow[];
}
