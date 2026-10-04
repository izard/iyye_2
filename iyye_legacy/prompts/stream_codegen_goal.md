---
description: Generate a ProcessingStream subclass that explores an underserved alignment goal
variables:
  primary_goal: The alignment goal to pursue (curiosity, agency, social, self_preservation)
  alignment_scores: Current alignment scores, comma-separated goal=score pairs
  question: Specific question or task this stream should answer
  stm_context: Recent STM facts relevant to this goal
  class_name: Exact Python class name to use
  file_name: Filename this stream will be saved as (for reference only)
  acceptance_criteria: Enforced post-run scoring checks this stream must satisfy
---

You are generating a Python processing stream that investigates a specific question for Iyye, an AI personality.

## Task

Write a class named `{class_name}` that subclasses `ProcessingStream` (imported from `iyye_base`).

This stream was created to pursue the goal: **{primary_goal}**

**Your specific question to investigate:** {question}

Alignment context: {alignment_scores}

## Recent context from short-term memory
{stm_context}

## What the stream MUST do

1. Investigate the specific question above — do NOT wander to other topics
2. Search LTM with specific, targeted queries related to the question (not vague terms)
3. Store any discovered facts or conclusions: `context['stm'].add_fact(text, confidence, provenance, time_frame)`
4. Track progress: call `self.add_input(question, source='goal')` on first tick, `self.add_output(result)` when done
5. Retire when the question is answered: return `{{"action": "complete", "finding": "..."}}`

## What the stream must NOT do

- Do NOT send messages to actuators — goal streams work silently in the background
- Do NOT search LTM with vague queries like "interesting", "concept", "knowledge", "fact"
- Do NOT read from `sensors_data` — there is no sensor data for goal-driven streams
- Do NOT send proactive greetings, "checking in", or "I'm here" messages
- Do NOT run indefinitely — answer the question and retire within a few ticks

## Automatic scoring (enforced — write for these checks)

{acceptance_criteria}

## Base class interface

```python
from iyye_base import ProcessingStream

class ProcessingStream:
    name: str
    priority: int           # 1-10
    urgency: float          # 0.0-1.0
    alignment_scores: dict
    is_conscious: bool
    input_history: list
    output_history: list
    activity_log: list

    def add_to_log(self, msg: str): ...
    def checkpoint(self) -> int: ...
    def add_input(self, data, source=""): ...
    def add_output(self, data, target=""): ...
```

The `execute(self, context)` method receives a **capability-scoped** context.
You have access to exactly these keys and nothing else:
- `context['memory']`       — long-term memory, **read-only**; `.search(query)` returns a list of fact dicts (extract `.get('text','')`). You cannot write to it
- `context['stm']`          — short-term memory; `.add_fact(text, confidence, provenance, time_frame)`; `.search(query, limit=10)`; `.get_recent(limit=20)`
- `context['adenosine']`    — float 0-1, current energy level
- `context['cap']`          — capability handle: `.search_memory(q)`, `.add_fact(text, confidence, time_frame)`, `.log(msg)`, and `.emit(text)` to send ONE short user-visible note via the local web chat (rate-limited; only effective once this stream has proven useful and graduated — it returns False otherwise, so never rely on it)

You do **NOT** have `context['actuators']`, `context['streams']`, `self.brain`, or any way to message users, start/stop LLMs, change trust, or reach other streams. Referencing any of those will be rejected by the safety validator.

## Rules

1. `__init__(self)` must take no arguments and call `super().__init__(name="...")` with a short descriptive name
2. `execute(self, context)` must call `self.checkpoint()` at least once and return a dict
3. Wrap all memory access in try/except
4. Only import from: `os`, `re`, `json`, `logging`, `datetime`, `typing`, `iyye_base`
5. **NEVER override** `checkpoint`, `add_to_log`, `add_input`, or `add_output`, and NEVER wrap `self.checkpoint()` in try/except — its stop signal must propagate (code that shields it is rejected)
6. **NEVER set** `self.is_conscious = True` in `__init__`
7. Use a `self._done` flag — once the question is answered, return idle on subsequent ticks

Write only the Python code, inside a single ```python ... ``` block. No text outside the block.
