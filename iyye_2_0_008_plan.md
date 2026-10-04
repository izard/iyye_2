# Iyye 2.0.008 — Sending Messages for the Owner: Implementation Plan

- Status (2026-10-04): **built**, then **widened the same day** (§6: trusted contacts and Iyye itself may initiate messages, to everyone Iyye knows, the owner included). Owner decisions in §4 and §6.
- Scope: the owner asks Iyye to write to someone ("Send Jacob a greeting message from me", refused on 2026-10-04 because no tool could send), and Iyye composes the message and sends it at once on that person's own Telegram chat.
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §3 (separation of authority), §7.3 (effects through the outbox), §9.1 (capabilities by effect), §15 #5 (delivery only by receipt), §15 #15 (forgetting).
- Builds on: `Outbox.sendOwn` (exact route, receipts, `unknown` never resent), the toolkit broker (`act` toolkits are owner-only), toolkit selection (0.004 §3.4), `turnNotes` (0.006), `/forget` (0.002 L6).

## 1. Design

- **One tool, `telegram_send(to, text)`**, in a new `messaging` toolkit (`host/src/tools/messaging.ts`), effect `act`: only the owner principal gets it. That is the local web chat and every Telegram account the owner linked with `/link <account> owner` (0.005); contacts and background work never do.
- **The host resolves the person**, never the model: `to` is a name (or id, or Telegram user id) that `findContacts` matches; linked accounts count as their person; the owner's own accounts are refused; several people with that name are refused with their ids ("ask the owner which one"). The route is the person's own private Telegram chat, the account that wrote most recently. No parameter can name a chat or a route, and a person who never wrote to Iyye cannot be reached (Telegram bots cannot either).
- **Iyye composes the words**; the recipient sees them under a label, `✉️ From Iyye, on behalf of Alex:` (the owner's name from their linked Telegram account), so nobody mistakes them for the owner's own typing.
- **Sent at once** through `Outbox.sendOwn` (idempotency key `notice:send:<id>`), so delivery is confirmed only by the Telegram receipt. The tool result states exactly what happened: delivered (quoting the message), not delivered yet (retried by the outbox), could not be delivered, or may not have arrived (`unknown`, never resent). A message that fails for good also sends the owner one web notice.
- **One message per person per owner request** (`dedup_key` = triggering event + person), so a retried turn never sends twice. At most `IYYE2_SEND_DAILY_MAX` (20) a day.
- **Records** (migration 023, `state/sent.ts`): `sent_messages` (recipient, their scope, route, the composed text, the requesting event and channel). A message is joined to its action **by key** (`notice:send:<id>`), never only by `action_id`, which is written after the send returns: a crash in between must not hide a message that may have gone out.
- **The recipient's conversation knows:** their next turns get a request-local `<sent_for_owner>` note of what was delivered to them in the last 12 hours (like the reminders note), quoted as a record, so "thanks!" makes sense.
- **The prompt:** with `messaging`, the operating note tells the model to compose and send when the owner asks, and never to say a message was sent unless the tool said so.
- **Toolkit selection:** `messaging` is always on for the owner (like `reminders`), because a hidden one would refuse exactly the request that motivated it.
- **Owner view:** `/sent` lists the latest 20 with the request channel, the delivery state and the receipt. The day summary adds "Messages sent for the owner: delivered 1 to Jacob", counts and names only, never the words.
- **`/forget <person>`:** the words sent to them go from `sent_messages`, the actions, the owner's failure notices and the owner's own `telegram_send` tool call (scope `owner`, which carries them in its arguments and result); it waits while a message to them is still on its way.
- **Reply review:** the ledger counts a message the turn sent (`send:<id>`), so "I sent Jacob a greeting" is a supported claim, not a false one.

## 2. Risks

- **The model sends something the owner did not ask for** (owner decision 1 chose sending at once over confirming first). An instruction injected into a fetched web page or a recalled memory could ask for a send in the same turn. Bounds: owner turns only, people Iyye knows only, one message per person per request, a daily cap, every send recorded in `/sent`, the label on every message, and the prompt rule. A confirm-first mode is the fallback if this happens.
- **Wrong person with a shared name:** refused when ambiguous; the owner can give an id.
- **The recipient replies** to Iyye, not to the owner: that is a normal contact turn, with the `<sent_for_owner>` note as context.

## 3. Tests

`test/messaging.test.ts` (9): a web-chat request delivered to Jacob's own chat with the label, its record, `/sent`, the recipient note and the day-summary line; from a linked Telegram account, and no second send on a retried request; unknown, ambiguous, the owner's own account and no Telegram chat refused, an id picks one, no route parameter; owner-only (contacts and background never get it, and it refuses outside an owner turn), always on under selection, the prompt rule; a blocked bot reported truthfully and to the owner, and the daily cap; `/forget`; a send cut by a crash (no `action_id`) still found by `/sent`, the day summary and `/forget`; a send through the broker as in a real turn, its owner-scope tool call recorded and then forgotten; the reply-review ledger. Migrations up to 023 applied to a copy of the live database (integrity and foreign keys OK; "Jacob" resolves, "Alex" is the owner). The suite has 353 tests.

## 4. Owner decisions (2026-10-04)

1. Send at once (no confirmation step).
2. From the local web chat and from linked Telegram accounts.
3. Iyye composes the words.
4. Any contact Iyye knows.

## 5. Configuration

| Name | Default | Meaning |
| --- | --- | --- |
| `IYYE2_SEND_DAILY_MAX` | `20` | messages Iyye may send for the owner per day |

## 6. Change (owner, 2026-10-04): trusted contacts and Iyye itself may initiate, to all users

Owner decision: "trusted users and Iyye himself can also initiate messages to all users". As built:

- **A new toolkit effect, `reach`** (`tools/broker.ts`): allowed for the owner, contacts the owner trusts (`/trust`, a local owner operation; the session's `trusted` comes from the kernel's view, never the conversation) and Iyye's background work (`iyye`). Untrusted contacts never get it. `messaging` is `reach` now; `act` stays owner-only. A trust change changes the grants, so the session reopens with or without the tool; the tool also re-reads the contact's trust when it runs, so a revoke takes effect at once.
- **Who asked is recorded and shown** (migration 024: `requested_by` owner/contact/iyye, `requester_contact_id`, `requester_scope`):
  - the recipient's label: "✉️ From Iyye, on behalf of Alex:" or "…on behalf of Julia:", or "✉️ From Iyye:" when Iyye wrote on its own;
  - **the owner gets a web notice for every message a trusted contact asked for or Iyye sent on its own** (with the words and the outcome), except when the owner is the recipient;
  - `/sent`, the recipient's `<sent_for_owner>` note ("for the owner", "for "Julia"", "on your own") and the day summary ("… (asked by the owner 1, Julia 1, Iyye on its own 1)") all say who asked.
- **All users:** anyone Iyye knows with a Telegram chat, now including the owner on a linked Telegram account ("Alex" means the owner). A trusted contact cannot "send" to themselves (they are in the conversation).
- **Bounds:** besides one per person per request and `IYYE2_SEND_DAILY_MAX` (20) in all: `IYYE2_SEND_CONTACT_DAILY_MAX` (10) per trusted contact, and `IYYE2_SEND_IYYE_DAILY_MAX` (5) on Iyye's own, with at most one Iyye-initiated message per person per day.
- **Iyye's own messages:** the background broker declares `messaging` after `machine` and `project`. The prompt tells Iyye to write on its own only when someone clearly needs to know what it found. There is no dedicated trigger yet: today the background steps are repository investigations (0.007 S5) and plan investigate steps (0.006 C4), so Iyye-initiated messages will be rare until a job has a reason to tell someone something.
- **Plan steps never get it** (`PLAN_STEP_SCOPE`, `iyye:plan:`): a plan's investigate step may run a contact's question and is approved, or auto-authorized (0.006 C4), as a read-only look, so the broker does not declare `reach` there and the tool refuses. Investigations (0.007 S5), whose questions the host writes, keep it.
- **A sent message is never evidence:** the citation check of investigations and plan steps ignores `telegram_send` calls (its result echoes Iyye's own words), both for grounding and for "used a tool".
- **`/trust` says what it grants now:** its reply and `/help` say the contact may ask Iyye to message anyone it knows. Today only the owner's own linked accounts are trusted, so nobody gains it by surprise.
- **`/forget`** now also covers the messages a forgotten person asked for (their words, the owner's "asked Iyye to write" notices, the tool calls).
- **Risks added:** a trusted contact can now cause messages to anyone Iyye knows, including children in the contact list; Iyye's background model (a 4B model) can too. The owner notices, labels, caps and `/sent` make every one visible; revoking trust or `IYYE2_SEND_IYYE_DAILY_MAX=0` turns either off.
- **Tests** (`messaging.test.ts`, now 12, and one in `plans.test.ts`): who may send (owner, trusted, Iyye; never untrusted, never a plan step, and a forged trusted context is refused from the record); a file named only in Iyye's own sent message does not ground a plan step; a trusted contact's message labelled with their name, the owner's notice, writing to the owner without a notice, no self-send, revoke at once, their cap; Iyye's own message labelled "From Iyye", the owner's notice, once per person per day, its cap, the digest; `/forget` of a requester. The suite has 357 tests.

| Name | Default | Meaning |
| --- | --- | --- |
| `IYYE2_SEND_CONTACT_DAILY_MAX` | `10` | messages one trusted contact may ask for per day |
| `IYYE2_SEND_IYYE_DAILY_MAX` | `5` | messages Iyye may send on its own per day (one per person) |
