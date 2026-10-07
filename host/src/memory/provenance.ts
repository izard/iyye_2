// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * Provenance by construction (plan 0.002 §3.3): every document Iyye retains
 * holds one speaker's words and carries that speaker's tag, set by the host.
 * Who said something is never judged by the extraction model, and it travels
 * with the facts and observations Hindsight derives (tags are inherited).
 */

export const SPEAKER_PERSON = "speaker:person";
/** A structured fact stored verbatim by the fact ledger (plan 0.011 F2), document `fact:<id>`. */
export const STRUCTURED_TAG = "structured-fact";
export const SPEAKER_IYYE = "speaker:iyye";
/** A measurement by one of Iyye's own probes (plan 0.007 S4): neither a person's statement nor Iyye's words. */
export const SPEAKER_PROBE = "speaker:probe";

/** Document ids per episode and speaker: deterministic, so a retry replaces instead of duplicating. */
export const saidDocId = (eventId: string) => `${eventId}:said`;
export const repliedDocId = (eventId: string) => `${eventId}:replied`;
export const observedDocId = (id: string) => `${id}:observed`;
export const summaryDocId = (id: string) => `${id}:summary`;
