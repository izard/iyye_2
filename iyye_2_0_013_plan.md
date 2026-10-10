# Iyye 2.0.013 — Reliable Evidence and Temporal Memory: Implementation Plan

- Status (2026-10-10): **accepted, trimmed scope; built** (owner decisions in §5; as built, §6). E0 and parts of E2 and E4 were built first (`42e584c`, `5e4b111`); then E1, E3, E5 (scoped) and E6. Time estimates were provisional.
- Origin: an external review of the fact ledger at `42e584c` and its proposed plan (2026-10-10), checked against the code: every residual failure it listed was reproduced or confirmed by reading. This plan keeps its direction and trims what does not fit Iyye today (§4).
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §6 (memory: provenance, correction, forgetting), §11.2 (a self-authored narration never counts as evidence), §15 #2 (a correction supersedes without erasing history). Builds on plan 0.011 (the fact ledger).
- Gate: plan 0.009 (character) and Stage 4 (decision learning) start only after E6.

## 1. What is already built

- **E0 (regressions):** `test/review-2026-10-10.test.ts`: privacy before trust, a value said again, a late report, an owner correction to an earlier value, incomplete and malformed extraction, figures and units, citations, the trusted contact's prompt.
- **E2 (completion contract), the part that matters now:** `routerComplete` accepts only a finished answer with text (`finish_reason` `stop`); cut off at `max_tokens`, no answer text, or another ending is an error; a non-empty reply with no fact line is a failed attempt; valid fact lines next to a malformed one are kept (owner decision).
- **E3, interim:** a reply's fact is cited only when its turn made a successful call to a world-reading tool (not the clock, not another model).
- **E4, the core:** a figure in an investigation's answer is found only as a whole number with its own unit (or its short form, or none).
- **E1, stopgap:** a value said again after its replacement is current again; a late report never makes a second current value. Its limit (one date range per value) is what E1 removes.

## 2. Milestones

### E1 — Belief validity as date ranges (next; ~1 day, provisional)

- **Evidence carries its dates** (migration 033): `belief_evidence.effective_at` (the date the evidence says the value held from: the fact's `valid_from`; a correction's date) and `said_at` (when it was said), backfilled from `stm_facts`; where neither is recoverable, the date it was received, flagged `effective_known = 0` and shown as approximate, never presented as known.
- **`belief_intervals`** (same migration): any number of date ranges per belief (`valid_from`, `valid_to` or open, the evidence that opened it, the belief that closed it). The `beliefs` columns `state`, `valid_from`, `valid_to`, `closed_by` stay, as a cache of the latest range, so every reader keeps working.
- **The timeline is rebuilt from evidence, per single-valued fact key** (`rebuildTimeline`): deterministic and idempotent, so the merge, `/facts correct`, `/facts wrong`, `/forget` and the backfill all use the one function, and a retry never duplicates a range. Transitions are the supporting evidence of the key's plain values (not negations, not comparisons or estimates), ordered by effective date; for the same date (owner decision 1): an explicit owner correction last (it wins), then later `said_at`, then the evidence id. Each transition to another value closes the current range and opens one; a value already current is corroborated, not reopened. Iyye's own cited words open a range only when no value holds at that date: they never replace what someone said.
- **Old effective date vs late arrival** (owner direction): a report placed at an older date is inserted at that date and preserves every later transition (Berlin said in October "since July", after Paris from September: Munich May–July, Berlin July–September, Paris current); evidence received now with the latest effective date changes the current value.
- **Conflicts stay visible** (owner decision 1): selecting one current value does not resolve a disagreement. `/facts` shows, for a value, the competing values of its key with their evidence (another value with a transition on the same date, or contradicting evidence).
- **Correction:** `/facts correct` adds an owner correction effective today, which wins its date; a correction to the value already current answers "already current" and adds the owner's confirmation.
- **Readers:** recall's "(until …)", `/facts` (every range, approximate dates marked, conflicts), `/person` hypotheses, the fact-relation role's inputs, and `/forget` (ranges rebuilt from the evidence that remains).
- **Backfill:** at startup, once (`kv`), restartable: fill the evidence dates, then rebuild every single-valued key. Run it first on a copy of the Spark's database and read the result before the live host runs it.
- **Tests:** a value said again in order and out of order (both ranges kept); a late report between two changes; same-date conflicts and the tie order; a correction to an earlier value while another is current; a correction to the current value; Iyye's cited words; `/forget` of the evidence behind a transition; the backfill run twice; recall and `/facts` output.

### E3 — Citations bound to the turn's own tool results (~1 day, provisional)

- **Tool calls name their turn** (migration 034): `tool_calls.event_id` (from `ToolContext.turn.eventId`, set by the host) and `result_hash`, with the result kept bounded as now.
- **The extraction prompt** for a reply lists the turn's tool results by number; the model may name a `tool_ref` for a fact. The host resolves it: the result must belong to the same turn, be a successful call of a world-reading tool, and contain the fact's quote or its figures (with units). Only then is the fact `cited`, with the result's id kept on the fact (traceability). This establishes where a claim came from, not that it is true (owner decision 2).
- **Model output is not an observation** (owner decision 2): `ask_thinking_model` and `look_at_image` results are another model's words; their provenance is kept, but they never give a fact independent observation weight.
- **One source counts once:** several facts citing one tool result are one source for a belief.
- **Audit:** already stored cited relays without a resolvable result are marked down to uncited in their evidence (weight recomputed); nothing is merged again.
- **Tests:** the clock, another turn's search, another model's answer or a ref to a result that lacks the quote cannot cite; a matching search result cites and the reference survives into the belief, recall and `/facts`; two facts citing one result count once.

### E5, scoped to the fact ledger — Why a belief exists, and forgetting it (~½ day, provisional)

- `/facts why <id>`: the chain from the belief to its evidence, the structured facts, the turn (or the correction), the quote, and the tool result (E3).
- `/forget` rebuilds ranges as well as probabilities; a retry never brings a forgotten source back (a test with an interrupted forget).
- **Limit, stated (not promised):** Hindsight's own observations, consolidations and summaries keep no link to their sources, so derived memory there cannot be traced or forgotten selectively without upstream changes. The owner's own bank may keep Iyye's replies that quoted a forgotten person (already a known limit of plan 0.002 L6). Deleting a training example does not undo weights already trained; Stage 4 must record which adapter versions saw which examples.

### E6 — A fixed test set before character work and learning (~½ day, provisional)

- One fixed dataset and test file across disclosure, date ranges, correction, complete versus failed extraction, citations, independent sources and forgetting.
- `/facts report`: documents done, failed and given up; uncited and cited relays; keys with more than one current value (always 0); conflicts.
- The gate: plan 0.009 and Stage 4 reference E6 as their entry condition.

## 3. Order

E1 → E3 → E5 (scoped) → E6. Each lands with its tests and a full test run; migrations run at the next host start; a commit only when the owner asks.

## 4. Deferred, with reasons

- **Splitting long documents into chunks** (the review's E2 remainder): no evidence yet that extraction reaches its 1,200-token cap; `/facts report` (E6) will show it if it does.
- **Checking that a claim follows from its quote** (the review's E4 remainder): it needs a model's judgement; if added, it runs in shadow on adversarial examples before it may weigh anything. Until then grounding is a filter, not proof.
- **Source lineage through Hindsight-derived memory** (the review's E5 beyond the ledger): needs upstream changes (§2, E5 limit).
- **Proxy authorization review:** no finding behind it; the remote pass-through already forwards only under a lease, and the key never reaches Pi.

## 5. Owner decisions (2026-10-10)

1. **Tie rule:** the latest effective date wins. For the same date: an explicit owner correction wins, then the later `said_at`, then a stable evidence id. Ordinary owner statements follow the normal rule. Competing evidence stays visible as a conflict in `/facts`: selecting one current value does not resolve the disagreement.
2. **`look_at_image` is model output:** its provenance is kept, but it has no independent observation weight. A tool result that matches a quote or a figure establishes traceability, not the claim's meaning.
3. **This trimmed plan is added to the repository before E1**, with the decisions above, the deferred work and the Hindsight limitation; time estimates are provisional.
4. **E1 distinguishes an old effective date from a late arrival:** an older report preserves later transitions; newly received evidence with the latest effective date may change the current value.
5. **Valid fact lines next to a malformed line are kept** (decided with the second review pass).

## 6. As built (2026-10-10)

- **E1:** migration `033_belief_intervals.sql` (evidence `effective_at`, `said_at`, `effective_known`; `belief_intervals`), `rebuildTimeline` / `currentOf` / `intervalsOf` / `conflictsOf` in `facts/beliefs.ts`. `mergeFact` no longer opens or closes values itself: it adds dated evidence (contradictions undated) and rebuilds the key; its relation reads `changes` when the value that holds moved to it. `/facts correct` adds a correction effective today (the value already current: "already current", a confirmation without a date); `/facts confirm` is undated; `/facts wrong` and `/forget` rebuild the key. The backfill (`ensureBeliefTimelines`, kv `belief_timelines_v1`) runs at startup. `/facts <words>` shows every range ("~" for an approximate date), "never held" for a same-date loser, and `conflict:` lines. Dry run on a copy of the Spark's database: 37 beliefs, one single-valued key, nothing changed. Tests: `test/belief-timeline.test.ts` (11).
- **E1, after review:** a new value reported for an older date only adds history: it contradicts (lowers p of) another value only for the same date, so the value that holds keeps its probability. Dates still to come (a planned move) do not hold until their day; the night rebuilds every key (`rebuildAllTimelines`), so they hold from then. Recall labels a value that never held "disputed: another value was given for the same time" and a planned one "from <date>, not yet", never as past history.
- **E3:** migration `034_tool_call_lineage.sql`: `tool_calls.event_id` (from the scheduled turn, in the broker) and `result_hash`; `stm_facts.tool_call_id`. A reply's document lists its turn's results (by `event_id`, never by time) of the observation tools (web, machine, repositories) and the model tools (`ask_thinking_model`, `look_at_image`); the clock is not offered. The model names a `tool_ref`; the host cites only an observation that carries the fact (`traceable`: every figure as a whole number; for a value without figures, a content word), keeping `tool_call_id` for model answers as provenance without weight. `source_named` is no longer asked for or trusted. One source counts once through the existing independence rule (Iyye's repeat of a belief weighs 0). The audit (`auditUntracedCitations`, kv `cited_relay_audit_v1`) made stored citations without a traced result uncited; on the Spark's copy there were none (49 relays, all uncited). Tests: `test/citation-lineage.test.ts` (6).
- **E3, checked on a real turn:** a stack test (fake router, web chat and Telegram) shows the broker records the turn's own event id, the same id short-term memory keeps, and the reply's document offers that result.
- **E5 (scoped):** `/facts why <id>`: ranges, each piece of evidence with its dates, the quote and its message, the tool result and its hash, and "traced means where a claim came from, not that it is true". `/forget` rebuilds ranges; a second forget changes nothing.
- **E6:** `/facts report` (`factsIntegrity`): documents done, failed, given up, skipped; Iyye's words cited, uncited, cited-but-untraced (0); conflicts; keys with two current values (0). `test/integrity-gate.test.ts` runs one fixed scenario across all of it and checks the figures after every step. It is the entry condition for plan 0.009 and Stage 4.
- **Known limits, kept:** recall shows a value's latest range only (`/facts` shows them all). For a value without figures, tracing needs only one of its content words in the tool result: traceability at its weakest. An owner correction holds from today; a planned date after it still takes over on its day.
