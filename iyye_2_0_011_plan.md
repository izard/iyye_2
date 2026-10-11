# Iyye 2.0.011 — Fact Ledger: Structured Facts with Probabilities (Plan)

- Status (2026-10-07): **accepted (owner decisions in §7); F0–F4 built, and F5's switch** (as built below the milestones). F5's switch-over waits for the comparison week and the owner's decision. Placed after plan 0.010 M1 and before Stage 3 (0.009): character learning and curiosity both read its beliefs.
- Scope: during the day, extract structured facts (subject, predicate, object, details, timing, provenance, probability) from people's turns, Iyye's replies and Iyye's own findings; use them in the day's recall; at night, merge them into long-term memory with a Bayesian update against related stored facts, aware of time.
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §3.1 (SQLite is control state, not a second vector store), §5.2 (consequential uncertainty), §6.1 (day and night), §6.2–6.3 (scoped gateway), §8.3 (dreaming as review), §9.4 (typed decisions), §11.2 (damping, author credit), §15 #1, #2, #12, #15, #18.
- Builds on: background jobs (0.007 S1), the night (0.002), the scoped memory gateway and recall rewrite (2026-10-06 follow-ups), reply extraction strategy, Kev roles (0.003), the self model's relations (0.010 M0b), `/forget` and tombstones.

## 1. Lessons from 1.x (from its code)

1.x extracted one JSON line per fact (`text`, model-assigned `confidence` 0.2–1.0, `time_frame` ephemeral → permanent, `provenance`) from every stream during the day, and merged into LTM by semantic dedup: a repeat raised confidence by a fixed +0.05, kept the more durable time frame and merged provenance; an LLM judged near-duplicates as *same* or *contradict* and the loser was retired. What it taught:
- **Model-assigned confidence is not a probability:** it was poorly calibrated and drifted with prompt versions.
- **Repetition is not evidence:** Iyye's own echoes and a person repeating themselves inflated confidence until provenance-aware merges and "independent sources only" rules were added.
- **Noise needs rules, not trust:** bookkeeping, metrics and the model narrating its task leaked into LTM until concept-based filters existed.
- **A low-confidence fact is a reason for curiosity**, closed only by settlement evidence.
- Its facts were sentences, not terms; a later graph layer added labelled edges between them.

## 2. Today, and the gap

| Need | 2.0 today | 0.011 |
| --- | --- | --- |
| Facts during the day | STM holds raw answered turns (FTS); no facts until the night | Facts extracted after each turn, findings and investigations, usable at once |
| Structure | Hindsight extracts what/when/where/who/why at night | Subject, predicate, object, details, validity interval, modality, source, evidence |
| Probability | None (observations carry a supporting-fact count) | A belief per fact: prior from rules, updated by independent evidence |
| Contradiction and change | Left to consolidation | Explicit: corroborate, contradict, refine, supersede in time |
| Uncertainty as a signal | — | Consequential, uncertain facts become curiosity signals (0.010) |

## 3. Design

### 3.1 The fact record

```
subject      the person, place or thing (resolved to a contact id when it is a known person)
predicate    a verb phrase ("lives in", "is the son of", "plays", "has an appointment")
object       the value ("a south-eastern suburb of Munich", "violin", "2026-10-12 09:00")
details      qualifiers, at most a sentence
valid_from   when it became true (stated, or the turn's time)
valid_to     when it stopped (null while current; set by a later change)
time_frame   ephemeral < session < today < recent < dated < permanent (1.x's durability scale)
modality     stated | measured | told_by_iyye | inferred
source       who said or measured it: the owner, a contact id, Iyye, a probe (set by the host)
evidence     the event, entry or tool-call ids it came from
p            the belief (§3.3)
```

The **fact key** is `normalize(subject) | normalize(predicate)`: two facts with the same key are about the same thing.

### 3.2 Extraction during the day

- **When:** after each answered turn (the person's words and Iyye's reply separately), each finding and each investigation answer, as a background step on the background model (`gemma-4-E4B`), only when the device is free; it pauses for people like all background work. A turn's facts are ready within minutes.
- **What the model does:** fill the record's text fields and flag hedges ("I think", "maybe", "probably") and negations. It does not set `source`, `modality` or `p`: the host does, from the document (provenance by construction, as now).
- **Grounding check (host):** the subject and object must appear in the source text or be a known contact's name; numbers, dates and names must too (like `observe/citations.ts`). A fact that fails is dropped and counted.
- **Filters (host):** no bookkeeping, metrics or process narration (the 1.x concept filters, ported as rules); Iyye's replies yield only `told_by_iyye` facts (what it told whom, with the source it named), never facts about the person.
- **STM:** `stm_facts` (SQLite, FTS, today's facts, scoped like episodes). Recall offers today's facts alongside raw turns: shorter, more precise, and across every conversation the reader may read, including Iyye's own findings for the owner.

### 3.3 Probability: rules first, calibration later

- **Prior by source and modality** (owner-tunable table, later calibrated by Kev from outcomes). The same for every contact: a child's statements about themselves start like an adult's (owner decision 3).

  | Source | Prior |
  | --- | --- |
  | the owner, about anything | 0.90 |
  | a contact, about themselves | 0.85 |
  | a contact, about someone else | 0.60 |
  | Iyye relaying a cited web result | 0.60 |
  | Iyye relaying an uncited claim | 0.40 |
  | a probe measurement | 0.95, `ephemeral` or `today` |
  | inferred (by the model, not stated) | 0.40 |

- **Hedging** multiplies the odds by 0.5; a negation is a fact with the negated predicate, not a low `p`.
- **Ephemeral and time-bound facts** carry their validity, not a lower probability: "disk is 350 GB free (at 14:10)" is certain and old.

### 3.4 The nightly merge (Bayesian, time-aware)

For each STM fact, oldest first, under the memory gate:
1. **Find related beliefs:** same fact key (exact, from the `beliefs` table) plus semantic neighbours (Hindsight recall on `subject predicate object`, the 2026-10-06 rewrite rules).
2. **Classify each relation:** `corroborates` | `contradicts` | `refines` | `changes` (the same key, a new value, after the old one's time) | `unrelated`. Deterministic for an exact key and equal object; otherwise a typed Kev role (`fact_relation`, shadow first, deterministic fallback: `unrelated`).
3. **Update in log-odds,** counting only **independent** evidence: `logit(p') = logit(p) + w · logit(p_source)`, with `w` = 1 for a new source, 0 for a source that already supports this belief (Iyye's own echoes, a person repeating themselves the same day), and capped per night. A contradiction from a source applies the same term with the opposite sign to the contradicted belief. A `changes` relation closes the old belief's `valid_to` instead of lowering it: "lived in Berlin until 2025" stays true.
4. **Store:** the fact goes to Hindsight verbatim as one structured sentence ("Julia plays the violin [stated by Julia, 2026-10-03]"), dated (`occurred_start`/`valid_to`), tagged by speaker and modality, with `fact_key` and the belief id in metadata; Hindsight extracts nothing more (it remains storage, retrieval, entities and consolidation). The belief (`p`, evidence ids, sources, validity, history) lives in SQLite `beliefs`: control state about the fact, not a second semantic store (HLD §3.1).
5. **Decay:** non-durable time frames lose weight with age, as in 1.x; `permanent` and `dated` do not.

### 3.5 Use

- **Recall** shows each fact with its belief, source and age: `[likely 0.85 · Julia said · 3 days ago] Julia plays the violin`. Beliefs below 0.3 are not offered in turns (kept, and visible in `/facts`).
- **Curiosity** (0.010): an *important* belief (about a person the owner cares about, used in recalls, or blocking a plan) with `p` in [0.3, 0.7] becomes a curiosity signal; it is settled only by new independent evidence (a person's statement, a measurement), never by Iyye's own reasoning.
- **Character** (0.009) reads beliefs about stated preferences ("the owner prefers short answers", p 0.9) as evidence for style.
- **Owner view:** `/facts <query>` (beliefs with sources, history and validity), `/facts correct <id> <text>` (owner evidence, the strongest source, and a label for Kev) and `/facts wrong <id>`, which **deletes the fact outright** (owner decision 2): the belief, its history and its text in Hindsight go, and a suppression on that fact key and object keeps the same evidence from re-creating it at the next merge. New, independent evidence can still raise it again.

### 3.6 One world model, scoped disclosure (owner decision 1)

- **Beliefs are common:** every source counts toward one Iyye-observable world model. Jacob saying "my father works at Nvidia" corroborates the owner's own statement, and a contact's statement about another person raises or lowers the same belief the owner's statements do (with the "about someone else" prior, §3.3).
- **What each reader may see (owner decision 1, revised 2026-10-07):** what Iyye has internalised is Iyye's knowledge, and it may share it, as facts with their provenance, never as anyone's words.
  - **The owner** sees every belief and all its evidence.
  - **A trusted contact** is offered a belief when it is not private (below), with its provenance ("Julia said, 3 days ago"). Quotes, conversations and stored turns of other people never cross; only the belief sentence and who it came from.
  - **An untrusted contact** is offered only beliefs it is a source of, and beliefs whose evidence is tied to no person (a probe measurement, a cited web result).
  - **Private facts never reach another contact**, trusted or not, but are used with the person who stated them and with the owner. The host marks a fact private by rule, never by a model's judgement: the speaker asked for it ("don't tell anyone", "between us", «никому не говори», «между нами»); a credential (password, PIN, account or card number, an ID document's number); health; money; an address. A belief is private when any of its evidence is. The owner overrides either way with `/facts private <id>` and `/facts share <id>`.
  - `iyye-self` facts stay owner-only.
  - Exit-gate tests in F4: a private fact never reaches another contact; an untrusted contact gets nothing another person said; after `/forget` nothing they said is offered to anyone.
- **Forgetting:** every fact and belief carries its evidence ids. `/forget <person>` deletes their facts, removes their evidence from every belief (recomputing `p` from what remains, so their influence on the common model goes too), and deletes beliefs left with none.

## 4. Milestones

- **F0 — Spike:** on the M8 days' real turns (English and Russian), measure `gemma-4-E4B` extraction (precision and recall against a hand-labelled sample, grounding-check rejects, latency per turn) and the merge classification on pairs from the live banks; decide between the background model and the memory model for extraction.
- **F1 — Day-time extraction into `stm_facts`,** the grounding check and filters, priors; recall offers today's facts. Hindsight's nightly path unchanged.
- **F2 — Beliefs and the nightly merge** (`beliefs` table, log-odds update with independence, time-aware `changes`, deterministic classification for exact keys; one common model, disclosure scoped by evidence); structured facts stored verbatim in Hindsight; the old turn extraction kept in parallel for one week and compared (`/facts compare`). Nights run noticeably longer that week (owner decision 4).
- **F3 — Kev `fact_relation` role** (shadow, then acting by owner decision) for non-exact relations; `/facts correct|wrong` labels it.
- **F4 — Use:** belief-aware recall formatting and threshold; the disclosure rule of §3.6 (trusted contacts get shareable beliefs with provenance, private facts by rule, `/facts private|share`); curiosity signals for important uncertain beliefs (0.010 M2).
- **F5 — Switch-over and evaluation:** retire Hindsight's own extraction for turns once F2's comparison holds; multi-day evaluation.

*(F0–F3 as built, 2026-10-07)*
- **F0** (`host/SPIKE-0.011.md`, `host/scripts/facts-spike.ts`): 43 live items (owner and contact turns, Iyye's replies, findings; the live turns are all English) plus 6 synthetic Russian messages, labelled before any model ran. Decisions: extraction runs on the **background model (gemma-4-E4B)** with a **closed predicate vocabulary** (free phrases gave keys that never match); grounding is on a **verbatim quote** (the English fields cannot be checked against Russian text), with numbers and names checked too; relations written the other way round are turned by the host; Markdown is ignored when matching quotes. The memory model is also E4B, so the night extracts on the same model; the 26B finds more but is twice as slow and less consistent in its keys (numbers in the spike report). Replaying the extracted facts through the merge showed two rules the plan lacked: a value that contains another word for word corroborates it ("Nvidia" / "Nvidia Germany"), and a comparison or estimate ("older than 10", kept from the quote when the model drops it) never replaces or contradicts a value. The real night (smoke) found host bugs the sample had not ("the writer" echoed as a value, the owner matched by the word "the", relations turned without a relation word); all fixed and tested.
- **F1:** `host/src/facts/extract.ts` (prompt, JSON-lines parser, grounding, filters, `subject_ref|predicate` keys, priors of §3.3 set by the host); `facts/store.ts` (migration 027: `stm_facts` with FTS, `fact_extractions`; the work list is `stm_episodes`; the tombstone and the entry are checked in the transaction that stores the facts); `facts/extractor.ts` (`FactExtractor`: one direct completion per document, explicit `max_tokens`, thinking off, a hang detector only; it obeys `BackgroundWorker.blockedReason`/`yieldReason`, holds the device as preemptible, discards the output and charges no attempt when it gives way, and pays device time). Documents: a person's words and Iyye's reply per turn, `/remember`, self-model changes and repository findings; not machine findings, day summaries or investigation answers (Iyye's own narration). Recall offers up to 3 of today's facts as `Fact: …`, scoped exactly like episodes, while their entry is in STM. `/forget` deletes the person's facts, every fact about them, and the facts of Iyye's replies to the owner that day.
- **F2:** `facts/beliefs.ts` (migration 028: `beliefs`, `belief_evidence`, `belief_suppressions`, `stm_facts.stored_at`). `p` is a fold over evidence rows, so `/forget` (their rows deleted, `p` recomputed, beliefs about them and beliefs left without evidence deleted) is exact. A source repeating itself and Iyye's own words about an existing belief weigh 0; Iyye's words never replace or contradict another source's value, and create a belief only when they cite a source (a web result, a measurement): uncited, they stay stored text with no belief, so they can never raise an F4 curiosity signal; the evidence that creates a belief applies its prior in full, later updates in one night are capped at `IYYE2_FACTS_MAX_STEP` (2.0). Single-valued predicates (`is_named`, `lives_in`, `located_in`, `from`, `works_at`, `works_as`, `age`, `born_on`): a later value closes the old belief (`valid_to`), one said the same day contradicts it. `facts/night.ts` (`FactNight`), run by `NightWork` before the episodes' transfer: queued document deletions, leftover extraction under the memory gate, the merge, and each merged fact stored verbatim in the bank of the scope it came from. Every fact is read again right before its merge and its storage (a `/forget` may land during the night: its tombstone is checked, and a bank being deleted is never re-created); a fact that breaks the merge is dropped and logged, and a fault in the ledger never stops the episodes' own transfer (document `fact:<id>`, tags `structured-fact`, the speaker tag, `modality:…`; a fact that could not be stored is retried next night). No common bank: only the beliefs table is shared, and nothing shows beliefs in a turn until F4. Hindsight's own extraction of turns runs unchanged in parallel (the comparison week; nights run longer). `/facts`, `/facts <words>`, `/facts compare`, `/facts correct <id> <text>` (owner evidence, the old value closed or contradicted), `/facts wrong <id>` (deleted outright with its stored text; a suppression keeps evidence said before it from re-creating it).
- **F3:** `decisions/fact-relation.ts`: the `fact_relation` role (questions `same_fact`, `contradicts`, `refines`; abstain 0.3–0.7), shadow only. At night, before a fact with no belief of its exact key is merged, it is asked about the two nearest stored beliefs of another key (Hindsight recall over `structured-fact` documents); the merge never reads it (tested: the beliefs are identical with and without it). `/facts correct` asks about the corrected value against the old belief and joins the owner's label (`owner_correction`); `/decisions label` covers the rest.
- **Configuration:** `IYYE2_FACTS_EXTRACT`, `IYYE2_FACTS_MERGE` (both on), `IYYE2_FACTS_MAX_STEP` (2), `IYYE2_FACTS_MIN_P` (0.3, read in F4). `IYYE2_FACTS_MODEL` was not needed: the day uses the `background` selection, the night the `memory` selection.
- **Tests:** `test/facts.test.ts` (20); `scripts/memory-night-smoke.ts --facts` is the real night (five runs, `host/SPIKE-0.011.md` §5). Migrations 027 and 028 apply at the next host restart (checked on a copy of the live database).

*(F4 and F5's switch as built, 2026-10-07)*
- **Disclosure (§3.6, owner decision 1 revised):** `facts/disclosure.ts`. Migration 029: `stm_facts.private`, `belief_evidence.private` (copied at merge), `beliefs.disclosure` (the owner's override), `beliefs.recalled_at`, and `beliefs_fts` kept by triggers. `privateReason` (`facts/extract.ts`) sets privacy by rule at extraction: the speaker asked anywhere in the message (English and Russian phrases); credentials; health; money; addresses, where `lives_in` always counts as one and German compounds like "Hauptstraße 12" are caught. Owner corrections follow the same rules. A belief is private when any of its evidence is, unless the owner said `/facts share`; `/facts private` makes any belief private. `/facts <words>` shows each belief's status.
- **Recall:** the gateway offers up to 4 beliefs per turn, found lexically (`beliefs_fts`) and through the stored `fact:` documents Hindsight returns, both filtered by `visibleEvidence`:
  - the owner sees everything;
  - a trusted contact sees non-private beliefs with all their provenance;
  - an untrusted contact sees only its own and person-less evidence (a cited relay, a measurement);
  - `iyye`-scope evidence stays the owner's.

  The lexical query keeps only content words: English and Russian stopwords, and the rewrite's "the user", never match, so an unrelated question gets no beliefs. Each belief comes as one labelled line: `[likely 0.85 · Julia said · 3 days ago] Julia plays the violin`, plus `(until …)` once closed. Iyye's own echoes are no provenance. Beliefs below `IYYE2_FACTS_MIN_P` (0.3) are not offered. Stored structured facts are never shown as raw Hindsight text, only as their beliefs, so the filter cannot be bypassed. Belief sentences read as English ("Julia is the wife of the owner", "Jacob's age is 12").
- **Curiosity:** `belief_uncertain` signals (0.010 `signals.ts`, weight 0.35) for current beliefs with p in [0.3, 0.7] that rest on a person's evidence (never Iyye's words alone) and matter: about the owner, or about a trusted contact or one with a stated relation. "Used in recalls" waits until recall knows what a reply actually used. They settle when new evidence moves p out of the band. **Recorded, not counted:** they are kept in the motivation samples (`/motivation`) but add no need and open nothing (the tracker's `JOURNAL_ONLY`). Without that, an uncertain belief about Julia would push curiosity over the threshold and Iyye would ask an unrelated self-model question, credited to the wrong cause (§11.2). Asking about beliefs is 0.010 M2/M3.
- **F5's switch:** `IYYE2_FACTS_TURNS` = `hindsight` (the default, the comparison week) | `ledger`. In `ledger`, `NightWork` never retains a person's turn or Iyye's reply in Hindsight. A turn leaves short-term memory once every one of its documents was extracted (or gave up) and its facts were stored, as `completed` with facts or `completed_empty`; until then it waits in the backlog for a later night's extraction. Banks that received structured facts are consolidated in both modes. `ledger` without extraction and merge is refused at startup. The switch-over itself (§4 F5) is the owner's, after `/facts compare` over the comparison week.
- **Tests:** `test/facts-use.test.ts` (11), covering exit gate #15 for disclosure (nothing a forgotten person said reaches anyone), private facts, untrusted contacts, overrides, recall, curiosity and the switch. Migration 029 applies at the next restart (checked on a copy of the live database).
- **Not yet:** the multi-day evaluation (F5); asking the owner about uncertain beliefs (since built: plan 0.010 M2).
- **The orphan check (§5), built 2026-10-11** (`facts/orphans.ts`): at the end of each fact night, every stored fact is compared with the `fact:` documents of every bank (Hindsight's document list, filtered by id; no model call). Reported, never repaired: *missing* (stored, its belief still there, no document in its bank), *unknown* (a `fact:` document no stored fact accounts for, or in another bank than its fact's), *stale* (its belief deleted by `/facts wrong` or `/forget`, the text still there; inert, since recall offers stored facts only as beliefs). Documents queued for deletion and banks being forgotten are not orphans. The result (kv `facts.orphan_check`) is shown by `/facts report`, and the next wake check mentions any orphan or a check that could not finish; `test/facts.test.ts`. The owner's repair (2026-10-11): `/facts orphans` runs the check now and lists every orphan; `/facts orphans restore` clears `stored_at` of the missing ones, so the next night stores them again verbatim under the same document id; `/facts orphans delete` shows the unknown and stale documents and `/facts orphans delete confirm` queues them for deletion and deletes them at once (failures retried, like `/facts wrong`). Cross-language recall: a Russian question does not find an English belief lexically, and the English embedding model finds it only weakly.

Exit gate (HLD §15):
- **#1 Continuity:** a preference stated in the morning is recalled as a fact in the afternoon (another chat, the same scope rules) and the next day, with its source.
- **#2 Correction:** a later explicit correction lowers the old belief or closes its validity without deleting its history, and Iyye's repetitions never raise a belief.
- **#12 Growth:** independent corroboration raises a belief; generated text (replies, summaries) never does.
- **#15 Forgetting:** a forgotten person's facts and evidence leave every belief; nothing returns through a merge.
- **#18 Label integrity:** owner corrections join the right belief; self-generated agreement is never an authoritative label.

*(Review fixes, 2026-10-10; `test/review-2026-10-10.test.ts`)*
- **Privacy before trust:** a private belief reaches only its speakers for every contact reader; an untrusted one was shown it through personless evidence (a cited relay).
- **A value said again:** the fact key's earlier value said after its replacement (Berlin → Munich → Berlin) reopens the closed belief and closes the replacement; a later fact about the past only adds history, and Iyye's words never reopen. `/facts correct` to a value replaced earlier reopens it. One belief per value: its `valid_from` moves to the return, the earlier interval stays only in the evidence.
- **Incomplete extraction:** a completion cut off at `max_tokens` (`finish_reason: length`) is an error in `routerComplete`, and a non-empty reply with no well-formed fact line is a failed attempt (retried, then given up), never an empty document.
- **Citations are the host's:** a reply's fact is `cited` only when its turn has a successful call to a world-reading tool (`toolBacked`, from `tool_calls`); the extraction model's `source_named` alone no longer is.
- **Contacts' prompt:** a trusted contact's says to share about other people only what recall labels with its source (the disclosure rule); an untrusted one's still says nothing.
- **Second pass (same day, after a review of the fixes):** a late report of an earlier value (Berlin in July, after Paris from September) is history and never makes a second current value; `routerComplete` accepts only a finished answer with text (a body without one, or another `finish_reason`, is an error; an empty `stop` is still an empty answer); the clock and `ask_thinking_model` no longer make a reply's source cited (they observe nothing the fact could rest on); an investigation's figure must carry its own unit or none ("12GB" is not "12MB"). Valid fact lines next to a malformed one are kept (owner decision 2026-10-10). Still open, for a 0.013 plan: one validity interval per value (a return moves `valid_from`, the earlier interval stays only in evidence), and citations bound to the specific tool result rather than to any world-reading call in the turn.
- **Known limit, kept:** grounding checks the quote, numbers, dates and names, not that the claim follows from the quote ("the grass is purple" from "the grass is green" passes); it is a filter, not proof.

## 5. Risks

- **Extraction quality on a 4B model:** F0 decides; the grounding check bounds hallucination; the memory model is the fallback.
- **Device time:** one background step per turn; it yields to people and to adenosine's reserve.
- **Fact keys too strict or too loose:** "plays violin" vs "takes violin lessons". Exact keys handle the clear cases; Kev and semantic neighbours the rest; `/facts correct` fixes what slips.
- **Over-confident priors:** the table is a start; F3's labels and Stage 4 calibrate it; every update is bounded per night.
- **Two stores drifting:** Hindsight holds text and the retrieval index, SQLite the belief; one fact id links them, and a nightly check reports any orphan on either side (built 2026-10-11, F2 as built).

## 6. Configuration

| Name | Default | Meaning |
| --- | --- | --- |
| `IYYE2_FACTS_EXTRACT` | `1` | extract facts during the day |
| `IYYE2_FACTS_MODEL` | `background` | which selection extracts: `background` or `memory` |
| `IYYE2_FACTS_MIN_P` | `0.3` | beliefs below this are not offered in turns |
| `IYYE2_FACTS_MAX_STEP` | `2.0` | the largest log-odds change one night may make to a belief |

## 7. Owner decisions (2026-10-06)

1. **Facts any person states count toward one common, Iyye-observable world model** (§3.6). *Revised 2026-10-07:* what Iyye has internalised it may share with **trusted contacts only**, as facts with their provenance (never anyone's words), except **private** facts (the speaker asked; credentials; health; money; addresses), which reach only their speaker and the owner. Untrusted contacts get only what they said themselves and facts tied to no person. (Before: no contact learned what another person told Iyye.)
2. **`/facts wrong` deletes a fact outright**, with a suppression so the same evidence does not re-create it.
3. **No separate priors per person:** a child's statements about themselves start like an adult's.
4. **Longer nights during F2's comparison week are fine.**
