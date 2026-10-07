# Plan 0.011 F0 spike — structured fact extraction on real turns

- Date: 2026-10-07. Machine: the owner's Mac (128 GB, M3 Max), with the live host running (gemma-4-26B and gemma-4-E4B loaded).
- Everything ran on a copy of the live database and on the spike's own llama.cpp router (port 8191, empty cache); nothing touched `~/.iyye2`, the owner's router or Kev.
- Script: `scripts/facts-spike.ts --db <copy> --labels <labels.json> --out <dir> [--models …] [--variants closed,free]`. The real turns, the labels and the raw outputs stay in the scratch directory, out of the repository.

## 1. The sample

- **43 items from `stm_episodes`** (2–7 October): 30 people's turns (owner, Jacob, the owner's second Telegram account), 7 Iyye replies, 4 findings, chosen across days and kinds, including questions, requests and small talk that should give nothing.
- **6 synthetic Russian messages.** The plan expected Russian turns, but every live turn so far is English. These test the grounding check across scripts: an exonym (Пекин → Beijing), a hedge, a place name, a preference, a greeting.
- **62 expected facts, labelled by Claude before any model ran** (subject and value keywords, and 10 "same fact" groups for key stability). They are Claude's labels, not the owner's, and the owner may correct them. Recall is matched automatically (a kept fact with the label's subject and a value keyword). Strict precision counts only facts that match a label. Facts that were correct but unlabelled were reviewed by hand (§3).

## 2. Results

| Run | Model | Predicates | Recall | Strict precision | Kept | JSON errors | Same fact → one key | Median / max per item |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v1 | gemma-4-E4B | closed list | 0.69 | 0.73 | 64 | 1 | 4 of 8 | 3.8 s / 28 s |
| v1 | gemma-4-E4B | free phrases | 0.74 | 0.69 | 67 | 1 | 6 of 10 (spurious: "has", "is in") | 5.5 s / 23 s |
| v2 | gemma-4-E4B | closed, prompt v2 | 0.71 | 0.72 | 67 | 0 | 7 of 9 | 4.1 s / 28 s |
| v2 | gemma-4-26B | closed, prompt v2 | 0.90 | 0.69 | 96 | 3 | 5 of 10 | 7.9 s / 35 s |
| **v3** | **gemma-4-E4B** | **closed, prompt v2 + host fixes** | **0.77** | **0.79** | **66** | **0** | **8 of 10** | **4.0 s / 28 s** |
| v3 | gemma-4-26B | closed, prompt v2 + host fixes | 0.92 | 0.69 | 97 | 3 | 5 of 10 | 5.6 s / 32 s |
| v4 | gemma-4-E4B | the final code (after the real-night fixes, §5) | 0.77 | 0.79 | 65 | 1 | 9 of 10 | 5.0 s / 44 s (the live host busy) |

- **These are in-sample numbers.** The prompt and the host rules were tuned on the same 49 items, and the labels are Claude's. Expect lower numbers on new turns: the comparison week (F2) and the owner's `/facts correct|wrong` are the held-out check.
- **Precision after review (v3, E4B):** of the 14 kept facts that matched no label, 9 are true but unlabelled: the owner is named Alex, works at Nvidia; the MacBook has 128 GB; macOS, Pi and llama.cpp versions from findings; what Iyye told about Bunin and the good-night message. 5 are junk, all from questions or requests ("the owner has family", "the owner has telegram accounts", a greeting request as a fact). That makes reviewed precision ≈ 0.92.
- **Grounding drops:** few, and the right ones. "An unknown value" ×2 (from a question: "Jacob | age | unknown") and one name the source did not contain. In v1, two of Iyye's replies were dropped wrongly: the reply had `**350.8 GB**` and the model quoted it without the Markdown. Fixed (quotes match without Markdown emphasis).
- **Russian:** with the exonym rule (a name no transliteration finds is accepted only when the Cyrillic quote names something), 5 of the 6 synthetic Russian facts are kept and correct. «Хёэнкирхен» → "Höhenkirchen" is kept, and one hedge is missed.
- **Latency:** E4B answers in ~4 s per document, under 30 s worst case, with the live host's models loaded too. One turn makes two documents (the person's words and Iyye's reply), so ~10 s of background device time per turn.

## 3. What changed because of the spike

- **Closed predicate vocabulary** (v1 → v2). Free phrases looked better on recall, but their keys never repeat ("has age" vs "is older than", "work as" vs "works at"), and the merge needs keys that repeat. The closed list, with "use the list whenever it fits" and a few mappings (a hobby → practises, a grade → studies), took key stability from 4 of 8 to 8 of 10.
- **Questions and requests state nothing** (prompt v2): v1 extracted "the owner | other: send greeting | Jacob".
- **`relation_of` is turned by the host** when the model writes it the other way round ("the owner | relation_of | Julia (wife)" → "Julia | relation_of | wife of the owner"). The model kept doing it despite the prompt, and both directions must share a key.
- **"Unknown" values are dropped.** They come from questions ("how old am I?").
- **Merge rules from replaying the facts** (`merge-replay`, the v3 facts through `mergeFact` in time order: 59 new, 5 corroborated, 2 changes). Two rules the plan lacked:
  - a value that contains another, word for word, corroborates it ("Nvidia" / "Nvidia Germany");
  - a comparison or estimate ("older than 10") neither replaces nor contradicts a value.

  The model also dropped "older than" from "older than 10". The prompt now asks it to keep comparisons in the value, but v4 shows it still drops them. So the host keeps the quote in the details when the quote has a comparison the value lacks (`said as "Im older than 10"`), and the merge treats the value as an approximation. A question ("how old am I?") gave "Jacob | age | self" in v4: pronouns are now dropped like "unknown".
- **The model:** E4B. The 26B finds more (0.92 recall), but it invents predicates ("is_relation_of", "is_located_in", so 5 of 10 keys), keeps more noise (strict precision 0.69), takes ~1.5–2× longer, and is the chat model. The background and memory selections are both E4B, so the day and the night extract on the same model. If the owner selects a bigger memory model, the night's leftover extraction uses it.

## 4. Not measured here

- **The merge classification on pairs from the live banks:** the live banks hold no structured facts yet, so there is nothing to pair. The deterministic rules were replayed on the spike's facts instead (§3), and the Kev `fact_relation` role starts in shadow (F3) to collect exactly these pairs.
- **The owner's own labels:** the sample's labels are Claude's.

## 5. The real night (`scripts/memory-night-smoke.ts <scratch> --models-from <hf> --facts`)

Real PostgreSQL, Hindsight and llama.cpp (gemma-4-E4B, reasoning off) on scratch ports and state; the smoke's 7 owner turns (one in Russian). The night ran the fact ledger first (14 documents at 0.2–4.5 s each), then Hindsight's own transfer and consolidation, in ~4 min in all. Each run found something the labelled sample had not, all fixed in the host and tested:

| Run | Seen | Fix |
| --- | --- | --- |
| 1 | the tag filter `structured-fact` also returns consolidation's observations, which inherit the tag | the relation role keeps only `fact:` documents (it already did); the smoke checks those |
| 1 | "Jacob \| relation_of \| the writer": the model echoes the prompt's word for the speaker | "the writer" in a value is the speaker, by name |
| 1 | "Jacob \| relation_of \| 12 years old of the owner": a detail that is no relation was turned into one | a relation needs a relation word, or it is dropped |
| 3 | "son of the owner of the owner": the detail already said it whole | a detail with "of" is the value |
| 3 | «Моя мама живёт в Чебоксарах» became "the owner lives in Cheboksary" | the host's first-name match took "the" from the owner's display name "the owner"; the owner now matches only by its full name |
| 4 | "the writer's mother" and "the owner's mother" were two subjects | "the writer's …" and "my …" in a subject are the speaker's |

After the fixes the night stores the structured facts in the owner's bank as `fact:<id>` documents, a tag-filtered recall finds them, and `DELETE …/documents/fact:<id>` removes one, all on the real API. Remaining model slips (not host bugs): the owner's "Jacob - 12 years old" sometimes comes out only from Iyye's reply (p 0.40, Iyye's words); "Alex's visit moved to January" became "Alex | other: has_visit | the owner", not a change of date. Hindsight's own extraction in the same run is no better (it dated Julia's Tuesday lessons to the day the note was made). The comparison week (F2) exists to show which of the two keeps more of what matters.
