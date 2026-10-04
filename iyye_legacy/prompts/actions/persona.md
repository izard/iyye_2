---
action_type: persona
summary: link same-named contacts into one persona (local web chat owner only)
triggers: persona, link, same person, accounts, merge contacts
---
- `ACTION: {"type": "persona", "name": "Alex"}`  — **local web chat only**. Link all contacts whose display name matches the given name into a single persona. Linked contacts share psychological profile, trust status, and interaction history — because this can propagate trust between accounts, only the machine owner on the local web chat may do it.
