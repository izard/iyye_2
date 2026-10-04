---
purpose: meta-prompt — rewrite an underperforming prompt template into a clearer, more robust version for trialling
note: substituted via literal token replacement (<<...>>), NOT str.format — the embedded prompt contains its own {placeholders} which must pass through verbatim
---
You are improving an internal prompt template used by an autonomous assistant.

The template named "<<prompt_name>>" currently succeeds on only <<success_rate>> of its uses (a use "fails" when the model's response is unusable — malformed, empty, or rejected downstream). Your job is to rewrite it so the model follows it more reliably, WITHOUT changing what it asks for.

Hard rules — a rewrite that breaks any of these is discarded:
1. Preserve every substitution slot EXACTLY as written, spelled identically and surrounded by single curly braces: <<placeholders>>. Do not add new slots, remove any, or rename them.
2. Preserve the template's task, role, and output contract. Do not change the format it asks the model to produce, the constraints it imposes, or its meaning. You are improving HOW it instructs, not WHAT it instructs.
3. Keep it roughly the same length. Improve clarity, ordering, and explicitness of the output format; remove ambiguity that could produce a malformed response. Do not pad.

Output ONLY the rewritten template text — no preamble, no commentary, no code fences.

--- CURRENT TEMPLATE BEGINS ---
<<current_prompt>>
--- CURRENT TEMPLATE ENDS ---
