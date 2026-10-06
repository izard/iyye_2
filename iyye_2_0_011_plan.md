# Iyye 2.0.011 — Fact Ledger: Structured Facts with Probabilities (Plan)

- Status (2026-10-06): **draft for the owner; nothing built.** Placed after plan 0.010 M1 and before Stage 3 (0.009): character learning and curiosity both read its beliefs.
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

- **Prior by source and modality** (owner-tunable table, later calibrated by Kev from outcomes):

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
- **Owner view:** `/facts <query>` (beliefs with sources, history and validity), `/facts correct <id> <text>` and `/facts wrong <id>` (owner evidence: the strongest source, and a label for Kev).

### 3.6 Forgetting and privacy

- Every fact and belief carries its evidence ids: `/forget <person>` deletes their facts, removes their evidence from beliefs (recomputing `p` from what remains), and deletes beliefs left with none.
- Scope as now: a contact's facts live in their bank and STM scope; the owner reads all; contacts read only their own; `iyye-self` facts are owner-only.

## 4. Milestones

- **F0 — Spike:** on the M8 days' real turns (English and Russian), measure `gemma-4-E4B` extraction (precision and recall against a hand-labelled sample, grounding-check rejects, latency per turn) and the merge classification on pairs from the live banks; decide between the background model and the memory model for extraction.
- **F1 — Day-time extraction into `stm_facts`,** the grounding check and filters, priors; recall offers today's facts. Hindsight's nightly path unchanged.
- **F2 — Beliefs and the nightly merge** (`beliefs` table, log-odds update with independence, time-aware `changes`, deterministic classification for exact keys); structured facts stored verbatim in Hindsight; the old turn extraction kept in parallel for one week and compared (`/facts compare`).
- **F3 — Kev `fact_relation` role** (shadow, then acting by owner decision) for non-exact relations; `/facts correct|wrong` labels it.
- **F4 — Use:** belief-aware recall formatting and threshold, curiosity signals for important uncertain beliefs (0.010 M2), `/facts`.
- **F5 — Switch-over and evaluation:** retire Hindsight's own extraction for turns once F2's comparison holds; multi-day evaluation.

Exit gate (HLD §15):
- **#1 Continuity:** a preference stated in the morning is recalled as a fact in the afternoon (another chat, the same scope rules) and the next day, with its source.
- **#2 Correction:** a later explicit correction lowers the old belief or closes its validity without deleting its history, and Iyye's repetitions never raise a belief.
- **#12 Growth:** independent corroboration raises a belief; generated text (replies, summaries) never does.
- **#15 Forgetting:** a forgotten person's facts and evidence leave every belief; nothing returns through a merge.
- **#18 Label integrity:** owner corrections join the right belief; self-generated agreement is never an authoritative label.

## 5. Risks

- **Extraction quality on a 4B model:** F0 decides; the grounding check bounds hallucination; the memory model is the fallback.
- **Device time:** one background step per turn; it yields to people and to adenosine's reserve.
- **Fact keys too strict or too loose:** "plays violin" vs "takes violin lessons". Exact keys handle the clear cases; Kev and semantic neighbours the rest; `/facts correct` fixes what slips.
- **Over-confident priors:** the table is a start; F3's labels and Stage 4 calibrate it; every update is bounded per night.
- **Two stores drifting:** Hindsight holds text and the retrieval index, SQLite the belief; one fact id links them, and a nightly check reports any orphan on either side.

## 6. Configuration (planned)

| Name | Default | Meaning |
| --- | --- | --- |
| `IYYE2_FACTS_EXTRACT` | `1` | extract facts during the day |
| `IYYE2_FACTS_MODEL` | `background` | which selection extracts: `background` or `memory` |
| `IYYE2_FACTS_MIN_P` | `0.3` | beliefs below this are not offered in turns |
| `IYYE2_FACTS_MAX_STEP` | `2.0` | the largest log-odds change one night may make to a belief |

## 7. Open questions for the owner

1. Should contacts' facts about *other* people (Jacob about his father) be stored in the contact's bank only (as now), or also raise beliefs the owner sees?
2. May the owner's correction (`/facts wrong`) delete a fact outright, or only drop its belief to near zero and keep the history?
3. Is the prior table right for your family, for example should Jacob's statements about himself start lower than an adult's?
4. During F2's week of running both paths, may the night take noticeably longer?
