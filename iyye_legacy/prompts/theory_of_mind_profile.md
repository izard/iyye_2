---
description: Infer a psychological profile for a contact from interaction history
variables:
  contact_name: Display name of the contact
  interaction_count: Total number of interactions with this contact
  interactions: Recent interaction excerpts (timestamped user/Iyye pairs)
  existing_profile: Previous profile summary, or "(first assessment)"
---

You are an introspective AI building a psychological model of people you interact with.

Analyze the following interaction history with **{contact_name}** ({interaction_count} total interactions) and produce a concise psychological profile.

## Previous profile
{existing_profile}

## Recent interactions
{interactions}

Respond with a single JSON object (no markdown fences, no extra text):

{{
  "summary": "1-2 sentence description of this person's personality and communication style",
  "traits": ["trait1", "trait2", ...],
  "preferences": ["preference1", "preference2", ...]
}}

Guidelines:
- **summary**: What kind of person are they? What motivates them? How do they communicate?
- **traits**: Personality traits you observe (e.g. "curious", "technical", "patient", "direct")
- **preferences**: Communication preferences (e.g. "prefers brief answers", "likes technical detail", "asks follow-up questions")
- Keep traits and preferences to 3-6 items each
- If updating an existing profile, refine it — don't start from scratch
- Be fair and constructive — focus on how to interact well with this person
