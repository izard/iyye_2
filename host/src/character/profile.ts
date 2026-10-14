// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * A turn's profile (owner decision 13): resolved once when the turn starts
 * and fixed for its reasoning and its delivery. The kernel renders the owner's
 * selected reasoning and perspective from the host's definitions (only the
 * owner's turns carry them), records which revision and definitions the turn
 * was bound to (reasoning provenance, even when no voice runs), and hands the
 * same revision to the voice.
 */

import type { Db } from "../state/db.ts";
import type { EventRow } from "../state/events.ts";
import { Character, controlsOf, definitionsOf, type Revision } from "./character.ts";
import { type Controls, controlsDigest, renderMind } from "./policy.ts";

export interface TurnProfile {
	/** The reasoning and perspective for Pi's prompt: owner turns only, null when off. */
	mind: string | null;
	revision: Revision;
	controls: Controls;
	[key: string]: unknown;
}

/** Whether a turn is the owner's (their conversation, any owner channel); contacts and background never get `mind`. */
function ownerTurn(event: EventRow): boolean {
	return event.scope === "owner";
}

export function bindTurnProfile(
	db: Db,
	character: Pick<Character, "active">,
	jobId: string,
	event: EventRow,
	now: Date,
): TurnProfile {
	const revision = character.active();
	const controls = controlsOf(revision.state);
	const rendered = ownerTurn(event) ? renderMind(controls, definitionsOf(revision.state)) : null;
	db.prepare(
		`INSERT OR REPLACE INTO turn_profiles (job_id, event_id, scope, character_rev, controls_json, mind_versions_json, mind_digest, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		jobId,
		event.id,
		event.scope ?? "",
		revision.rev,
		JSON.stringify(controls),
		JSON.stringify(rendered?.versions ?? []),
		rendered?.digest ?? null,
		now.toISOString(),
	);
	return { mind: rendered?.text ?? null, revision, controls };
}

/** The active revision's live-configuration digest for the M4 trial (null when nothing is selected or no revision yet). */
export function liveControlsDigest(db: Db): string | null {
	try {
		const state = new Character({ db, stateDir: null }).active().state;
		return controlsDigest(controlsOf(state), definitionsOf(state));
	} catch {
		return null;
	}
}
