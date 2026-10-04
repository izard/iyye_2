# Plan 0.006 C0 spike — reminder tool use, time parsing, promise labels

- Date: 2026-10-04. Model: gemma-4-26B (the owner's chat model) on a scratch router port; Kev on its own port; nothing touched `~/.iyye2` or the owner's services.
- Scripts: `scripts/spike-0006-reminders.ts <scratch>` (`VARIANTS=A,B`), `scripts/spike-0006-promise.ts <scratch>`.
- Setup: the real identity prompt, the new prompt rule (`operatingNote` with a `reminders` toolkit: "a future action exists only if a tool created it"), `current_time` fixed at Sunday 4 October 2026 14:00, and a stub `reminder_create`. 20 phrasings, each in a fresh conversation: 9 English and 5 Russian reminders (relative, weekday, date, daily, weekly), 2 ambiguous, 4 that must not create a reminder.

## 1. Who resolves the time

| | A: host parses a simple form (`kernel/when.ts`) | B: model computes ISO |
| --- | --- | --- |
| reminders created / expected | 14 / 15 | 14 / 15 |
| right time | 13 | 14 |
| right repeat | 13 | 13 |
| reply quotes the exact time | 14 / 14 | 14 / 14 |
| wrong-time or false claims | **A8**: wrote year 2025, was refused, then **chose "tomorrow" itself** (said so). **A6**: said "every Monday", record was one-off | **B12**: "Я установила ежедневное напоминание" (I set a daily reminder) with **no tool call at all**. **B14**: created a reminder with placeholder text instead of asking |

Fixes, then A again:
- the parser accepts `12 October 12:00`, `october 12th at noon`, `noon`, `midnight`, and a date without a year means the next such date;
- a refusal ends "Ask the person what they meant; do not choose another time yourself";
- the result says "once (it does not repeat)" or "then every day/week";
- the description explains `recurrence` ("daily" for "every day", "weekly" for "every Monday") and says to ask when the time or topic is missing.

**A after the fixes:** 13 created, all 13 correct in time, repeat and text, every reply quoting the time. The weekly repeat, "12 October at noon" and "next Sunday" are right. "Remind me in an hour" and "I need to remember to call mom tomorrow" now ask instead of guessing. One over-cautious question remains: «в среду в 18:30» → "which Wednesday?" (safe, slightly annoying).

**Decision: A** (the host resolves times; the model writes a simple form). It matched B on accuracy after small fixes, and it keeps date arithmetic out of the model, where A8's year guess came from.

## 2. Kev and the promise label (C2)

60 replies (A, B, A after fixes) through reply review's current question ("does the reply promise or offer a future action?"):
- reminder created: p 0.56–0.95 (mean 0.84);
- no reminder: p 0.04–0.81. Clarifying questions ("when should I send it?") and offers ("anything else you need me to keep an eye on?") score up to 0.81. A ledger label "promise without a record" from this question would mislabel them.

A second wording, **`claims_arranged`**: "Does the reply say that the assistant has already set up a reminder or some other future action, rather than asking for details, offering to do it, or only answering?"
- reminder created: p 0.49–0.94 (mean 0.86);
- no reminder: all ≤ 0.27, **except B12's false claim at 0.86**.

**Decision for C2:** reply review gains `claims_arranged` (schema 2). The ledger's automatic label is "unsupported" when it says yes and the turn created no commitment. This separates exactly the one real false claim from 16 honest replies here. The label stays label-only (owner decision 2).

## 3. For C1

- `kernel/when.ts` and the prompt rule are built and tested (`test/when.test.ts`).
- The tool's wording, refusal and result texts above go into the real `reminder_create`.
- False claims without a tool call happen (B12). Label-only means such a reply is delivered; the ledger and `/decisions` make it visible.
