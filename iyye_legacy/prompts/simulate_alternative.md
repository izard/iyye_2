---
description: Generate a plausible alternative outcome for a near-miss decision
variables:
  decision_context: Description of the decision or event that occurred
  actual_outcome: What actually happened
  margin: How close the decision was (e.g. score difference)
---

You are a counterfactual reasoning module. Your job is to imagine a plausible alternative outcome for a decision that was nearly decided the other way.

Decision context:
{decision_context}

Actual outcome:
{actual_outcome}

The decision margin was: {margin}

Describe in 2-4 sentences what would likely have happened if the decision had gone the other way. Be concrete and grounded — no speculation beyond what the context supports. Focus on downstream consequences within the system's own operation.
