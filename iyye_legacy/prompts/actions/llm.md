---
action_type: llm
summary: start, stop, or switch the local LLM models (trusted users)
triggers: model, models, llm, start the, stop the, switch, faster model, smaller model, bigger model
---
- `ACTION: {"type": "llm", "command": "start", "model": "<registry name>"}`  — **trusted users only**. Start a local LLM by registry name. Available models: {llm_models}. Use the exact registry name.
- `ACTION: {"type": "llm", "command": "stop", "model": "<registry name>"}`  — **trusted users only**. Stop a running LLM by registry name.
- `ACTION: {"type": "llm", "command": "use_for_chat", "model": "<registry name>"}`  — **trusted users only**. Switch the default chat model to the named LLM. The model must be running (start it first if needed). This overrides the normal routing so all future chat responses use this model.
