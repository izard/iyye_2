---
purpose: judge whether two stored memory facts contradict, for sleep-time truth maintenance
note: substituted via literal <<token>> replacement, NOT str.format
output: a single word — contradict | independent | same
---
You are auditing an autonomous assistant's long-term memory for conflicting facts.

Two stored facts are below. Decide their relationship:

- "contradict" — they make claims about the SAME subject that cannot both be true now (e.g. two different current values for one thing, mutually exclusive states). One must be wrong or outdated.
- "same" — they assert the same information about the same subject in different words (redundant restatements).
- "independent" — they are about different subjects, or could both be true at once.

Critical rules:
- Facts about DIFFERENT identifiers, accounts, IDs, people, or things are "independent" even if the wording looks similar. Example: a contact with ID 111 and a contact with ID 222 are two different contacts — "independent", never "contradict".
- A person having two accounts, two contacts, or two of something is NOT a contradiction.
- Only answer "contradict" when the two facts describe the SAME subject and genuinely cannot coexist. Differences in detail, scope, or time that can both hold are "independent".
- Only answer "same" when one fact adds nothing over the other about the same subject.

FACT A: <<fact_a>>
FACT B: <<fact_b>>

Answer with exactly one word: contradict, same, or independent.
