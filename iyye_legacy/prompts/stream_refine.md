---
description: Revise an existing generated ProcessingStream subclass to fix problems and improve usefulness
variables:
  class_name: Exact Python class name to use for the revised stream
  sensor_key: Exact sensor queue key in context['sensors_data'] (may be empty for goal streams)
  payload_sample: Full JSON of a recent sensor payload, for structure reference
  issues: Observed problems with the current version (low usefulness, errors, vague output, new evidence)
  current_code: The current version's full source code
  acceptance_criteria: Enforced post-run scoring checks the revised stream must satisfy
---

You are improving an existing Python processing stream that has been running but
is underperforming. Your job is to REVISE the code below — not rewrite it from
scratch — so it handles its input more usefully while keeping what already works.

## The stream

Class name to use: `{class_name}`
Sensor it handles (if any): `{sensor_key}`

A recent payload from its sensor, for reference:
```json
{payload_sample}
```

## Observed problems to fix

{issues}

## Automatic scoring (enforced — the revision must satisfy these)

{acceptance_criteria}

## Current version source

```python
{current_code}
```

## What to do

1. Keep the same overall responsibility and the same sensor/goal focus.
2. Make targeted changes that address the observed problems — handle the real
   payload shape, extract more concrete facts, stop emitting vague or empty
   output, and fix any errors.
3. Preserve the cooperative-multitasking contract: call `self.checkpoint()` at
   least once and return a dict from `execute(self, context)`.
4. Store durable findings with
   `context['stm'].add_fact(text, confidence, provenance, time_frame)` using a
   specific `time_frame` — one of, least to most durable: ephemeral / session /
   today / recent / dated / permanent. Use ephemeral for metric snapshots and
   permanent only for facts that will stay true indefinitely.

## Hard rules

1. `__init__(self)` must take no arguments and call `super().__init__(name="...")`.
2. Only import from: `os`, `re`, `json`, `logging`, `datetime`, `typing`, `iyye_base`.
3. Do NOT use `eval`, `exec`, `compile`, `open`, `__import__`, `subprocess`,
   `socket`, `os.system`, or file deletion.
4. Do NOT override `checkpoint`, `add_to_log`, `add_input`, or `add_output`.
5. Wrap all sensor/memory access in try/except.

Output ONLY the revised class in a single ```python code block. No prose.
