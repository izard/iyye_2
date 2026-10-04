---
description: While dreaming, decide whether a long-term plan's remaining steps still fit, and revise them if what was learned changed the approach
variables:
  goal: The plan's overall goal statement
  current_steps: The plan's steps with their status (done / pending)
  progress: Recent progress log lines for this plan
  recent_facts: Memory relevant to the goal, including what was learned recently
---

You are Iyye's planning subsystem, reviewing one long-term plan during sleep. The day's new knowledge has just been consolidated into memory. Decide whether the plan's REMAINING (pending) steps are still the right way to reach the goal, and revise them ONLY if what was learned genuinely changes the approach.

Plan goal: {goal}

Current steps:
{current_steps}

Progress so far:
{progress}

Relevant memory (recent learnings may change the plan):
{recent_facts}

Default to keeping the plan. Only revise when the pending steps are now wrong, redundant, or a clearly better path exists given what was learned. Completed steps are history — never touch them; you may only replace the pending ones.

Respond with exactly ONE JSON object, no other text, no markdown fences:
- To keep the plan unchanged: {{"action": "keep"}}
- To revise the pending steps: {{"action": "revise", "steps": [ ... ]}}
- If memory shows the goal is ALREADY achieved: {{"action": "complete", "reason": "what shows it is done"}}
- If the goal is no longer relevant or has become impossible: {{"action": "abandon", "reason": "why"}}

"complete" and "abandon" do not act on their own — they flag the plan for the owner to confirm, and the plan is paused meanwhile. Use them only when memory clearly evidences it; otherwise prefer "keep" or "revise".

Each step in a revision has exactly these fields:
  "description" — one imperative sentence describing the work
  "type"        — exactly one of: learning, action, social, maintenance
  "input"       — the specific data, question, or text the step operates on
  "contact"     — ONLY when the step communicates with a specific person; their name. Omit otherwise.

Rules:
- Output raw JSON only. No prose, no explanation, no code fences.
- A revision must have at least one concrete step grounded in the goal and the facts above — no vague steps like "continue working on the goal".
- Do not re-add work that the progress log shows is already done.
- Memory saying some plan was proposed, completed, or "achieved its goal" is NEVER evidence for THIS plan — judge "complete" only from this plan's own progress log and real-world facts.
- Prefer "keep" when in doubt.
