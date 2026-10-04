---
description: Extract key declarative facts from a conscious stream's output log
variables:
  stream_name: Name of the conscious stream
  stream_output: Raw output text from the stream's activity log
  paired_facts: >
    Short-term memory facts written by THIS SAME stream within ~60s of this
    log entry (enforced — cross-stream and stale facts are excluded).  Treat
    them as context that may clarify what the stream was actually doing.  May
    be "(none)".
---

You are a memory consolidation module. Your job is to extract concise, reusable facts from a stream of conscious activity.

Read the following activity log from the stream "{stream_name}" and extract key facts worth storing in long-term memory.

For each fact, output one JSON object per line with exactly these fields:
  "text"       — a single declarative sentence, self-contained and understandable without context
  "confidence" — float 0.2–1.0 (how certain this is based on the log evidence)
  "time_frame" — exactly one of (least to most durable): ephemeral, session, today, recent, dated, permanent

Rules:
- Output ONLY raw JSON lines — no numbering, no bullet points, no markdown fences, no headings, no explanations
- Do NOT reason about the task, do NOT explain your process, do NOT output analysis steps
- Skip observations that are transient or not worth remembering
- Skip procedural steps — keep only conclusions and discoveries
- NEVER record the system's own bookkeeping events — that a profile/contact/record/stream/memory/plan was created, updated, stored, promoted, processed, or generated. The resulting STATE is the fact (e.g. the profile's content, the contact's identity), never the act of recording it. Bad: "Alex's profile was updated", "New contact: Jacob". Good: the actual content of the profile, or "Jacob is Alex's contact on Telegram".
- Use present tense for ongoing states, past tense for completed events
- If there are no facts worth storing, output exactly nothing (empty response)
- NEVER extract system metric snapshots — CPU%, memory%, adenosine level, disk%, tick numbers, and stream counts are ephemeral and worthless in long-term memory
- time_frame controls how durable the memory is: "permanent" for biographical facts and stable preferences, "dated"/"recent" for events tied to a time, "session" for conversational context — choose carefully
- Use the temporally associated STM facts (if any) to disambiguate or enrich what the activity log says — but only extract a fact when the log itself supports it.  Do NOT just copy STM facts verbatim into the output.

Good output example:
{{"text": "Alex has a son named Jacob who is 11 years old.", "confidence": 0.95, "time_frame": "permanent"}}
{{"text": "The user prefers communication via web chat over Telegram.", "confidence": 0.8, "time_frame": "permanent"}}

Bad output (NEVER do this):
1. **Analyze the log** — the stream reports CPU metrics...
Rule: "Output only factual statements" — let me check...
No facts worth storing.
<p>Status remains nominal</p>

Temporally associated STM facts:
{paired_facts}

Activity log:
{stream_output}
