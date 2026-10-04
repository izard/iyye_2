---
description: During dreaming, infer labelled relations from a newly stored long-term-memory fact to existing related facts (graph edges)
variables:
  new_fact: The text of the fact just added to long-term memory
  candidates: Numbered list of existing facts that are semantically near the new fact
---
You are Iyye's memory-consolidation graph builder. A new fact has just entered long-term memory. Your job is to connect it to existing facts it is genuinely related to, building a knowledge graph.

NEW FACT:
{new_fact}

EXISTING CANDIDATE FACTS (numbered):
{candidates}

For each existing candidate that the NEW FACT is genuinely, specifically related to, output one JSON object per line:
  {{"n": <candidate number>, "rel": "<short relation phrase>"}}

The relation phrase describes how the NEW FACT relates to that candidate, read as "new fact <rel> candidate" — e.g. "is the child of", "happened during", "is part of", "contradicts", "elaborates", "is the same person as".

Rules:
- Output ONLY raw JSON lines — no prose, no numbering, no markdown fences.
- Relate ONLY when there is a real, specific connection. Mere topical similarity or sharing a common word is NOT a relation — skip it.
- Keep each relation phrase to a few words.
- Reference candidates by their number only; never invent a number not in the list.
- If the new fact relates to none of the candidates, output exactly nothing (empty response).
