---
description: Generate a ProcessingStream subclass that handles a specific sensor's data
variables:
  source_name: Name of the source stream that triggered this generation
  primary_goal: Primary alignment goal to pursue (curiosity, agency, social, self_preservation)
  alignment_scores: Alignment scores for the source stream, comma-separated goal=score pairs
  sensor_key: Exact sensor queue key in context['sensors_data']
  payload_sample: Full JSON of a recent sensor payload (for structure reference)
  payload_count: Number of buffered payloads waiting to be processed
  class_name: Exact Python class name to use
  file_name: Filename this stream will be saved as (for reference only)
  acceptance_criteria: Enforced post-run scoring checks this stream must satisfy
---

You are generating a Python processing stream that handles data from a specific sensor.

## Task

Write a class named `{class_name}` that subclasses `ProcessingStream` (imported from `iyye_base`).

This stream handles data from sensor **`{sensor_key}`** (goal: **{primary_goal}**).
There are currently **{payload_count}** buffered payload(s) waiting to be processed.

## Sensor payload structure

Here is a real payload from this sensor (use this to understand the data format):
```json
{payload_sample}
```

Alignment context: {alignment_scores}

## What the stream MUST do

1. Read sensor data: `payloads = context['sensors_data'].get('{sensor_key}', [])`
2. For each payload, call `self.add_input(payload, source='{sensor_key}')` to record it
3. Process the payload — extract useful information, summarise, or react
4. Call `self.add_output(result_dict, target='...')` with the processing result
5. Store any discovered facts: `context['stm'].add_fact(text, confidence, provenance, time_frame)`

## What the stream must NOT do

- Do NOT send messages to actuators — sensor-handler streams process data silently
- Do NOT search LTM with vague queries like "interesting", "concept", "general"
- Do NOT ignore the sensor data and do something else instead
- Do NOT send proactive greetings or "checking in" messages

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

    def add_to_log(self, msg: str): ...    # record an action in the activity log
    def checkpoint(self) -> int: ...       # cooperative yield point (call regularly)
    def add_input(self, data, source=""): ...
    def add_output(self, data, target=""): ...
```

The `execute(self, context)` method receives a **capability-scoped** context.
You have access to exactly these keys and nothing else:
- `context['sensors_data']` — dict of sensor_name -> list of raw payloads
- `context['memory']`       — long-term memory, **read-only**; `.search(query)` returns a list of fact dicts. You cannot write to it
- `context['stm']`          — short-term memory; `.add_fact(text, confidence, provenance, time_frame)` to store facts; `.search(query, limit=10)`; `.get_recent(limit=20)`
- `context['adenosine']`    — float 0-1, current energy level
- `context['cap']`          — capability handle: `.search_memory(q)`, `.add_fact(text, confidence, time_frame)`, `.log(msg)`

You do **NOT** have `context['actuators']`, `context['streams']`, `self.brain`, or any way to message users, start/stop LLMs, change trust, or touch other streams. Sensor handlers process data silently. Referencing any of those will be rejected by the safety validator.

## Rules

1. `__init__(self)` must take no arguments and call `super().__init__(name="...")` with a short descriptive name
2. `execute(self, context)` must call `self.checkpoint()` at least once and return a dict
3. Wrap all sensor/memory access in try/except
4. Only import from: `os`, `re`, `json`, `logging`, `datetime`, `typing`, `iyye_base`
5. **NEVER override** `checkpoint`, `add_to_log`, `add_input`, or `add_output`, and NEVER wrap `self.checkpoint()` in try/except — its stop signal must propagate (code that shields it is rejected)
6. **NEVER set** `self.is_conscious = True` in `__init__`
7. Read the exact sensor key: `sensors_data.get('{sensor_key}', [])` — do NOT guess or modify
8. When there is no data this tick, return early with `{{"action": "idle", "reason": "no data"}}`

Write only the Python code, inside a single ```python ... ``` block. No text outside the block.
