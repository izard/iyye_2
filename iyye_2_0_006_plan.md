# Iyye 2.0.006 — Commitments, Reminders and Plans: Implementation Plan

- Status (2026-10-04): **accepted; C0 (spike) done** (`host/SPIKE-0.006.md`: the host parses simple time forms; reply review gains `claims_arranged` for the ledger label). **C1 (commitments and reminders), C2 (promise labels), C3 (owner view) and C4 (plans) done: 0.006 is complete.** Owner decisions in §7.
- Scope: closes the Stage 1 gap (HLD §14): durable commitments with exact routes and receipts, reminders that survive sleep and restart, a check that replies promise only what is recorded, and owner-approved plans whose steps run as jobs.
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §7.1 (durable intentions), §7.2 (promises are structured commitments), §7.3 (outbox), §3.1 (records), §8.1 (due work wakes Iyye), §9.1 (capabilities by effect), §15 #4, #5, #6, #7, #8, #11.
- Builds on: the outbox (exact routes, receipts, `unknown`), the scheduler, `Rhythm`, the toolkit broker (`act` toolkits are owner-only), Kev's reply review (0.003).

## 1. What exists, and the gap

| Need | Today | 0.006 |
| --- | --- | --- |
| A future obligation | Forbidden by the prompt; nothing could keep it | A `commitments` record, created only by a typed tool or command, before the reply acknowledges it |
| Something happens at a time | Nothing runs without a person's message | A durable timer: due commitments become outbox actions; while asleep they wait for waking |
| "Done" | A delivered reply settles its job | A commitment is `fulfilled` only by the receipt of its own action, in the same transaction |
| An unsupported promise in a reply | Kev reply review, shadow, owner labels only | The commitments ledger labels it automatically; acting (revise before delivery) is a later owner decision |
| A multi-step intention | None | Plans: proposed → authorized → active → completed/failed/abandoned, steps as background jobs (0.007) |

## 2. Design decisions

### 2.1 Commitments (HLD §7.2)

- **Record** (`commitments`, a new migration): id, kind (`reminder` in this increment; `deliverable` with plans), the creating event and scope, the **recipient** (contact id), the **route** (copied exactly from the creating event: the web chat or that Telegram chat), the deliverable text, `due_at` (UTC) plus the person's timezone, recurrence (`none`, `daily`, `weekly`), state, the action id once due, attempts, and the terminal reason.
- **States:** `scheduled → due → fulfilled | failed | cancelled`, plus `unknown` when the action's delivery is `unknown` (shown to the owner, never retried blindly).
- **Created only by a typed tool or an owner command** (§2.3), never by extraction or by Kev. The tool runs inside the turn, so the reply can quote the record ("I'll remind you on Saturday 4 October at 09:00 (Europe/Berlin): call Julia").
- **Fulfilment:** the outbox's `complete()` transaction marks the commitment `fulfilled` for the action that carries its id. A different message to the same person can never fulfil it (§15 #5). A terminal failure marks it `failed` and sends one truthful notice to the owner's web chat.
- **Recurring:** each occurrence is its own row, created when the previous one is due; cancelling stops the series.

### 2.2 The timer and sleep (HLD §8.1, §15 #4, #11)

- A **commitment clock** in the kernel scans for due commitments every 15 s (and at startup, so a reminder due during downtime is delivered late rather than lost, saying it is late).
- Due while **awake**: an outbox action (kind `reminder`, no model call: the text was fixed at creation) on the exact route.
- Due while **asleep** (owner decision 3): the reminder **waits for the morning**. It is delivered right after waking, saying it was due at night ("(due at 03:00)"). The outbox stays held while asleep, so nothing is sent before waking (§15 #11). A due reminder does not wake Iyye. This narrows HLD §8.1 and the Stage 2 exit gate ("due work wakes Iyye"), and the HLD records the change.
- **Missed by a long outage:** a reminder more than 6 h late is delivered with "(late: due at …)", and one more than 7 days late is `failed` and reported instead.

### 2.3 Who may create commitments (HLD §7.1, §9.1)

- **The owner** (web chat, terminal, owner-linked Telegram): the `reminders` toolkit, with the new effect `self` described below. Its tools are `reminder_create(text, when, recurrence?)`, `reminder_list()` and `reminder_cancel(id)`. Owner commands do the same without a model: `/remind <when> <text>`, `/reminders`, `/cancel <id>`.
- **Contacts** (owner decision 1): every contact may set reminders, **to their own chat only**. The route is always the exact chat that asked, never another person or channel. A new toolkit effect `self` (effects that reach only the asker's own route) gives everyone the `reminders` toolkit, while `act` stays owner-only. A per-contact cap (`IYYE2_CONTACT_REMINDERS_MAX`, 20 open reminders) bounds abuse. The owner sees and cancels them all (`/commitments`, `/cancel`); a contact cancels only their own.
- `when` is parsed by the host, never trusted from the model as a timestamp alone. The tool accepts an ISO local time or simple relative forms ("in 2 hours", "tomorrow 9:00"), resolves them in the person's timezone (the owner's system timezone; contacts' timezone is a later setting), refuses the past and anything beyond one year, and returns the resolved absolute time.

### 2.4 Replies may promise only what is recorded (HLD §7.2)

- **Prompt:** with the `reminders` toolkit present, the rule "do not promise future actions" becomes "a future action exists only if a tool created it; quote what the tool returned". Without it (contacts) the old rule stays.
- **Check (shadow in 0.006):** Kev's reply review already asks "does the reply promise a future action?" After each delivered reply, the ledger now gives an **automatic label**: a "yes" from a turn that created a commitment is a supported promise; a "yes" from a turn that did not is an unsupported promise. `/decisions` reports both.
- **Acting** (owner decision 2, later): an unsupported promise detected *before* delivery gets one revision step (a host note: "your reply promises X but nothing was recorded; create it with the tool or rephrase"), like the existing recovery notes. If Kev is down the reply goes out as today.

### 2.5 Plans (HLD §7.1)

Smallest useful form, after 0.007 S1 provides background jobs:

- **Record** (`plans`): id, intent, proposer (owner or an initiative opportunity), evidence ids, acceptance criteria, steps (JSON: description, effect class, status), authorization, version, review/due times, terminal reason.
- **Lifecycle:** `proposed → authorized → active → suspended → completed | failed | abandoned`.
  - Internal read-only steps may be authorized automatically by policy (0.007 initiative).
  - Anything outward (a reminder, a message) needs the owner: `/plans`, `/plan approve <id>`, `/plan cancel <id>`. As built (C4): a plan the owner proposes in the local web chat is that owner instruction when its outward steps only remind that same web chat, so it is authorized at once; every other outward step waits for `/plan approve`.
  - Nothing from Telegram can create, approve or change a plan beyond *proposing* one (HLD invariant).
- **Steps** run as background jobs (0.007), one at a time, with read-only toolkits or the `reminders` toolkit when authorized. Each step records its evidence; a step whose effect has no typed tool stays `blocked` (§15 #7). "Ran a tool" or "wrote a summary" is not completion: the plan completes only when its acceptance criteria are verified by records (a delivered receipt, a probe result).
- A revision that widens scope returns the plan to `proposed`.
- Plan priority uses only deterministic features (due time, age, owner request) in 0.006. 0.007 built observation and a shadow initiative role, but no plan scoring; that comes later, from their evidence.

## 3. Milestones

### C0 — Spike (half a day)
- **Tool use:** gemma-4-26B with `reminder_create` on 20 phrasings (English and Russian: "remind me tomorrow at 9", «напомни через два часа», recurring, ambiguous). Measure correct `when` and text, and whether the reply quotes the tool result.
- **Kev:** how reply review's "promise" answers line up with real tool calls.

Exit: wording of the tool and the prompt rule; whether relative times are parsed by the host or by the model in ISO.

*(Done, 2026-10-04; `host/SPIKE-0.006.md`.)*
- **gemma-4-26B, 20 phrasings × two ways of giving the time:**
  - **A (host parses a simple form):** 14/15 created, 13 right.
  - **B (model computes ISO):** 14/15, 14 right.
  - Both quoted the exact time in every reply.
- **Failures:**
  - a guessed year followed by a self-chosen "tomorrow" (A);
  - a weekly repeat claimed but not recorded (A);
  - a daily reminder claimed with no tool call (B);
  - placeholder text (B).
- **After fixes, A:** 13/13 right (weekly, "12 October at noon"); ambiguous requests now ask. The fixes:
  - day-month dates and noon in `kernel/when.ts`;
  - a refusal that says to ask, never to choose;
  - a result that states whether it repeats;
  - the description explains `recurrence` and says to ask when something is missing.
- **Decision: A.**
- **Kev:** the current reply-review question cannot tell a claim from an offer or a clarifying question (no-reminder replies up to 0.81). A new `claims_arranged` question puts every honest no-reminder reply at ≤ 0.27 and the one false claim at 0.86. It becomes the basis of C2's label.
- `kernel/when.ts` and the prompt rule are built and tested (`test/when.test.ts`).

### C1 — Commitments and reminders
- Migration: `commitments`; `actions.kind` gains `reminder`; `actions.commitment_id`. (No `grants` table: contacts set their own reminders without a grant, owner decision 1.)
- `kernel/commitments.ts` (the clock, due → action, held until waking while asleep, late and missed handling); outbox `complete()` and terminal-failure hooks transition the commitment in the same transaction; recovery reconciles `due` commitments whose action exists.
- `reminders` toolkit (effect `self`: everyone, own chat only), owner commands `/remind`, `/reminders`, `/cancel`, `/commitments`.
- Prompt rule switch (§2.4).

Exit, tests on the fake router and fake Telegram:
- **#4:** a reminder created on Telegram (owner-linked account, and a contact) survives a restart and a night, is sent to that exact chat at its time (or right after waking, if it fell due during the night), and is fulfilled only after the receipt.
- **#5:** a later unrelated message, a failed send, an empty or apology reply, and a cross-channel fallback do not fulfil it.
- **#6:** a crash before send, after provider acceptance, and before the receipt commit → `unknown`, never repeated.
- **#8:** a contact's reminder can only ever reach that contact's own chat; a contact cannot cancel or see another person's reminders; a Telegram "/cancel" of someone else's reminder is refused.

*(C1 as built, 2026-10-04)*
- **Records:** migration 020 adds `commitments` (kind `reminder`, scope, recipient, exact `route_json`, text, `due_at`, timezone, recurrence, `series_id`, state, `action_id`, `created_by`, `created_event_id`). A unique (series, time) makes creating a next occurrence twice a no-op. `actions` gains `commitment_id`.
  - **Deviation:** no new action kind. A reminder is a `status` action (Iyye's own message, answering nothing) with its exact route; `actions` gains only a column. Rebuilding it would fight the foreign keys `receipts`, `web_feed` and STM hold on it.
- **The outbox** (`sendOwn`, which `notifyOwner` now uses) creates the action and marks the commitment `due` in one transaction. The commitment is settled in the transaction that settles its action:
  - delivered → `fulfilled`, only by its own receipt (§15 #5);
  - terminal failure → `failed`, plus one truthful notice to the owner's web chat;
  - possibly sent → `unknown`, never sent again blindly; the owner's `resolve` moves it on (delivered → fulfilled, dismiss → failed).
  Queued while asleep, as before.
- **The clock** (`kernel/commitments.ts`, every `IYYE2_COMMITMENT_TICK_MS`, and at startup):
  - asleep it sends nothing (a reminder waits for the morning);
  - more than 5 minutes late it says "(due at 03:00)", more than `IYYE2_REMINDER_LATE_H` "(late: due at …)", and more than `IYYE2_REMINDER_MAX_LATE_D` it fails and the owner is told;
  - a repeating reminder creates its next occurrence (the first still ahead; missed ones skipped).
- **Turn context:** the scheduler gives every turn its asker and exact route (`TurnRequest.turn`, from the triggering event), and the broker passes it to tools (`ToolContext.turn`). It is never a tool parameter, so the model cannot name another chat.
- **The `reminders` toolkit** (`tools/reminders.ts`, new toolkit effect `self`: the owner and contacts, never Iyye's background work) has `reminder_create`, `reminder_list` and `reminder_cancel`, worded from C0:
  - the host parses the time;
  - a refusal says "ask, do not choose another time";
  - the result states the exact time, whether it repeats, and that a reminder inside the rest window arrives at waking;
  - a contact has at most `IYYE2_CONTACT_REMINDERS_MAX` open reminders and sees and cancels only their own.
  It is declared last, so the earlier tool declarations (and the prompt cache) are unchanged. The prompt rule switches with it (C0).
- **Owner commands** (`kernel/reminder-commands.ts`): `/remind <when> <text>` (the longest leading words that read as a time; to the web chat), `/reminders`, `/commitments` (everyone's, with states and routes), `/cancel <id>`. A Telegram `/cancel` is dialogue.
- **`/forget`** (fixed in review) reaches reminders. A reminder action has no event, so `/forget`:
  - refuses while one of the person's reminders is still on its way (queued, sending, or waiting for a retry);
  - cancels their scheduled reminders;
  - replaces with `[forgotten]` the text of their commitments, of every reminder action sent to them, and of the owner's failure and missed notices that quoted one (actions and web chat).
- **Owner notices name and quote:** `"Julia"'s reminder "…" (to their Telegram chat) could not be delivered: …`. The person's name and words are quoted and clipped, since a contact controls that text.
- Times use the system timezone; `IYYE2_TIMEZONE` is not implemented (the process timezone is the owner's).
- **Known limits:**
  - with the promise check label-only (owner decision 2), a false "I've set a reminder" without a tool call (C0's B12) is still delivered; C2 only makes it visible in `/decisions`;
  - a sent reminder is not in the person's Pi conversation or STM. **Owner choice (2026-10-04), built:** a request-local `<reminders>` note in that chat's next turns (`PiConversations.turnNotes` → `recentReminderNote`) lists the reminders delivered there in the last 12 hours, quoted (a person wrote them), so "done, thanks" makes sense. It is never stored in the transcript, STM or long-term memory, and background turns never get it.
- **Tests** (`test/commitments.test.ts`, 11; `test/when.test.ts`, 3):
  - **#4:** a contact's reminder made through the real tool on Telegram survives a restart, goes to that exact chat when due, is fulfilled by its receipt, and is sent once;
  - an owner-linked account's reminder goes to that Telegram chat in the owner's scope;
  - **#5:** an unrelated later message does not fulfil it, a blocked chat fails it (owner told), with no fallback to the web chat;
  - **#8:** contacts' isolation, Telegram `/cancel` as dialogue, no route parameter, the cap, never for background work, nothing outside a turn;
  - the clock (asleep, late notes, the 7-day failure, repeats and cancelling a series);
  - **#6:** a crash after the provider accepted → `unknown`, never resent, then resolved by the owner;
  - the owner commands; the rest-window note; `/forget`.
  - The fake router gained `[[call:NAME|{json}]]`. The suite has 326 tests. Migrations 019 and 020 were run on a copy of the live database: actions identical, integrity clean.

### C2 — Promise ledger labels
- Reply review gets its automatic label from the ledger (§2.4); `/decisions` shows supported vs unsupported promises.
- From C0: reply review adds the question `claims_arranged` (schema 2). "Unsupported" = `claims_arranged` yes and no commitment created in that turn; the older "promises or offers" question stays for comparison.

Exit: labels on test turns with and without a tool call; no label replaces an owner label.

*(C2 as built, 2026-10-04)*
- Reply review is **schema 2**: it asks C0's `claims_arranged` ("does the reply say the assistant has already set up a reminder or other future action, rather than asking, offering or only answering?") next to the old "promises or offers" question.
- **The ledger labels every answered review at once**, as a weak label: `{commitment_created, commitments}` from the turn's event (`commitmentsOfReply`: commitments whose `created_event_id` is the reply's event). The owner's `/decisions label <id> yes|no` now answers "did it claim something was set up?" and replaces the weak label; a later weak label never replaces it (`joinOutcome`).
- **`/decisions`** recomputes the ledger fact, so an owner label never hides it. It shows:
  - "promises or offers" counts;
  - "claims something is set up" counts;
  - **of the yes: N with a reminder made in that turn · M WITHOUT one (unsupported)**, listing the unsupported ones with ids to label;
  - your labels and how often Kev agrees.
  Schema-1 rows still count in the first line; the second only uses schema 2.
- **Label-only** (owner decision 2): nothing is revised before delivery; an unsupported claim is visible, not stopped.
- **Review fixes:**
  - a label answers the question its row was asked: labelling a schema-1 review (live rows exist) records `promises_future_action`, never `claims_arranged` (HLD §15 #18);
  - the report's figures are schema 2's, with earlier schema-1 reviews counted apart, not pooled (K2 rule);
  - the reminder note says "sent to this person", names the route (web chat or Telegram, since for the owner both channels are one conversation), and leaves out forgotten reminders.
- **Known limits:**
  - "supported" means only that some commitment was created in that turn, not that the reply describes it correctly (C0's A6, "every Monday" recorded once, would count as supported). The commitment ids are stored, so a later check can compare them.
  - **For Stage 4:** the weak outcome `{commitment_created}` is a ledger fact, not an answer to either question; nightly learning must not use it directly as a `claims_arranged` label.
- **Tests:** `commitments.test.ts` (Julia on Telegram: a turn that made a reminder through the tool → supported; a turn that did not → unsupported and listed; the owner's "no" kept against a later ledger label; agreement reported); `decision-roles.test.ts` updated for schema 2. The suite has 328 tests.

### C3 — Owner view
- `/reminders` and `/commitments` (all states, with their actions and receipts); a web chat chip for due-today; the day summary (0.007) lists fulfilled and failed commitments.

*(C3 as built, 2026-10-04)*
- **`/commitments`** shows, per reminder: who it is for, the route, the state with its reason, and the **evidence**: the action, its state and attempts, and the delivered receipts' level and time, e.g. `action 1a2b3c4d delivered, receipt telegram_accepted at 09:00`. `/reminders` (the owner's own coming reminders) is from C1.
- **The web chat chip** `reminders: 1 due later today · 2 delivered · 1 failed · 1 unconfirmed` (`remindersToday`, `remindersChip`, `/api/status` `reminders`): delivered and failed count today, unconfirmed counts until the owner resolves it. It is red when one failed or is unconfirmed, and absent when there is nothing today.
- **The day summary** adds "Reminders: delivered 2 to the owner, 1 to Julia; could not be delivered 1 to Julia; may not have arrived 1 to Julia". It has counts and whose, never the reminder's text (a person's words; `/forget` finds summaries by name, not by text). A problem there must not vanish from the model's note ("may not have arrived" joined the problem words).
- **Tests** (`commitments.test.ts`): the chip through the real web server's `/api/status` (none, then due/delivered/failed, then unconfirmed); `/commitments` evidence; the digest's line, with no reminder text. The suite has 329 tests.

### C4 — Plans (after 0.007 S1)
- Migration `plans`; `kernel/plans.ts`; `/plans`, `/plan approve|cancel`; steps as background jobs.

Exit:
- **#7:** an approved plan with a reminder step completes only after the receipt; a step needing an unsupported effect leaves the plan blocked; a Telegram message cannot approve or widen a plan.

*(C4 as built, 2026-10-04)*
- **Record** (migration 021, `state/plans.ts`): intent, proposer, scope, exact route and `proposed_via` (all from the turn), the creating event, typed steps (JSON), state, authorization, reason. Acceptance criteria are per step kind rather than free text, and there are no revisions yet: a changed plan is cancelled and proposed again (so nothing can widen one in place).
- **Proposing:** the `plans` toolkit (`tools/plans.ts`, effect `self`, declared last, after `reminders`) has one tool, `plan_propose(intent, steps[{kind, text, when?}])`, 1–5 steps. The host resolves reminder times when the plan is proposed (`kernel/when.ts`); a missing or unreadable time is refused with "ask, do not choose". A contact has at most `IYYE2_CONTACT_PLANS_MAX` (5) open plans. The operating note says a plan waiting for approval arranges nothing.
- **Typed steps, each done only with its evidence** (`kernel/plans.ts`, `PlanRunner`, one step at a time):
  - `investigate`: a background step (0.007 worker, origin `plan:<id>:<n>`, session `iyye:plan:<id>:<n>`, the read-only `machine` and `project` toolkits); done only when the answer cites what the tools returned in that session (`observe/citations.ts`, as in S5). The question was written by a person or the model, so naming something from it is allowed but never counts: at least one cited thing must come from the tool results alone. Up to 3 answers, then the plan fails.
  - `remind`: every reminder's commitment is created when the plan becomes active (one transaction), on the proposer's route, `created_by plan:<id>`, so it goes out at the time the person was told whatever the other steps do; the other steps run one at a time, in order. Done only when the outbox settles it `fulfilled` (its receipt is the evidence). `failed` or `cancelled` fails the plan and cancels its other coming reminders; `unknown` suspends it until a receipt settles it.
  - `other`: blocked, the plan is suspended and never completes; the owner is told and can cancel it.
- **Authorization:** automatic only when the owner proposes in the local web chat and every step is `investigate` or `remind` (which then goes to that web chat). Investigate steps stay read-only after plan 0.008: their sessions never get `telegram_send`. Everything else is `proposed` and the owner gets a web notice with `/plan approve <id>`. Owner commands come only from owner surfaces, so Telegram — a contact, or the owner's linked Telegram account — can at most propose.
- **Owner commands:** `/plans`, `/plan <id>` (steps, evidence, authorization), `/plan approve <id>`, `/plan cancel <id>` (abandoned; its scheduled reminders are cancelled and its queued steps dropped). Notices (web chat only, once per key): proposed, completed (with each step's evidence), failed, blocked, unconfirmed.
- **Elsewhere:** the reply-review ledger counts a plan the turn authorized at once as arranged (`plan:<id>`), not one only proposed, and not the plan's later reminders. `/forget` abandons the person's plans and redacts their intent and steps, the steps' prompts, answers and tool calls, and the owner's plan notices, and deletes the steps' background Pi transcripts (`planSessions`, `MemoryControl.forgetBackground`); it waits while one of their steps is running.
- **Known limits:** investigate answers stay in the plan record (`/plan <id>`); they are not findings and do not reach memory, and settled plans are not yet remembered in long-term memory (HLD §7.1). A contact proposer is not sent investigate answers, and is not told when their plan fails or its reminders are cancelled (the owner is). Initiative and opportunities (0.007) cannot propose plans yet. Plans have no due-time or age priority, are not scored, and are not reviewed at night.
- **Tests** (`plans.test.ts`, 9): #7 end to end through the commitment clock, the outbox and the web chat's receipt; unknown/failed/cancelled reminders; an ungrounded investigation; a file named only in the question is not evidence; a reminder keeps its time while an earlier step waits; a blocked step and `/plan` commands; Telegram proposes only, with the tool's parameters fixed; `/forget`, background transcripts included; the ledger. Migration 021 applied to a copy of the live database (integrity and foreign keys OK). The suite has 338 tests.

### Follow-up 2026-10-13: the person's own tasks

A plan step of kind `task`: something the person does themselves (an agreed list, such as the tool upgrades the owner said they would add). Iyye only keeps it; it is done when the person says so in their own conversation (`plan_task_done`, a second tool in the `plans` toolkit, checked against the plan's scope) or the owner with `/plan done <id> <step>`. Tasks wait in any order and never hold the other steps back; the plan completes when every step is done. A plan of tasks only, proposed by the owner on any owner channel (their linked Telegram accounts included), is authorized at once: it arranges nothing; with a reminder on Telegram it still waits for approval. Every turn of a conversation gets a request-local `<open_plans>` note with its open plans and each step's state (records, not memory), and the operating note asks the model to keep an agreed list with `plan_propose`. Tests: `test/plans.test.ts`.

## 4. Risks

- **Time parsing:** a wrong timezone or a misread relative time sends a reminder at the wrong hour. The host resolves times, never the model alone, and the reply quotes the resolved absolute time so the person can correct it.
- **Reminders at night wait for the morning:** a reminder for 03:00 arrives after waking. The reply that creates a reminder inside the rest window says so.
- **Prompt rule change:** the model may over-use the tool. The C0 spike measures it, and `reminder_list`/`/cancel` keep it reversible.

## 5. Out of scope

- Contact timezones (contacts' reminders use the owner's timezone, and the reply states it).
- Commitments other than reminders ("I'll send you the report"), which come with plans that produce artifacts.
- Acting promise revision (owner decision 2).
- Calendar integration.

## 6. Configuration (planned)

| Name | Default | Meaning |
| --- | --- | --- |
| `IYYE2_COMMITMENT_TICK_MS` | `15000` | how often due commitments are checked |
| `IYYE2_REMINDER_LATE_H` | `6` | later than this, a reminder says it is late |
| `IYYE2_CONTACT_REMINDERS_MAX` | `20` | open reminders a contact may have |
| `IYYE2_CONTACT_PLANS_MAX` | `5` | open plans a contact may have |
| `IYYE2_REMINDER_MAX_LATE_D` | `7` | later than this, it fails and is reported instead |
| `IYYE2_TIMEZONE` | — | **not built**: times use the system timezone, which is the owner's |

## 7. Owner decisions

1. **Contacts just set reminders** (2026-10-04): to their own chat only, capped; no grant needed.
2. **The promise check stays label-only** (2026-10-04): the ledger labels Kev's reply review; nothing revises a reply before delivery.
3. **Reminders due at night wait for the morning** (2026-10-04).
