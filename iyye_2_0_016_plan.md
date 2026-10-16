# Iyye 2.0.016 — Tools for Trusted Senders' Mail: Implementation Plan

- Status (2026-10-16): **built**; live after a host restart (no migration).
- Scope: a verified mail from an address the owner stored for a person the owner trusts is answered as a conversation turn with that person's own chat tools, instead of plan 0.015's tool-less answer.
- Builds on plan 0.015 (receiving), plan 0.014 (`/person email`, the email route) and the toolkit grants of plan 0.004 T1.

## 1. Design

- **Who** (`Scheduler.mailView`, read when the job runs, never at admission): the receiving server verified the mail (`email_inbox.authenticated`), the sender's address is the one the owner stored with `/person email` for that very contact (the owner's own address: the trusted contact `owner-email`), and the contact is trusted now. Everything else — strangers, untrusted contacts, a trusted person writing from an address the owner never stored (bound only by first contact), trust or the address removed since admission — gets plan 0.015's tool-less `EmailResponder`.
- **What:** exactly what the person gets in their chat: the same `ToolBroker` grants for a trusted contact (`read`, `self`, `reach`, `trusted`, `send`), under toolkit selection like a chat; never `private`, `act` or `compute`. `owner-email` is a trusted contact, never the owner (no owner tools, no owner memory, no owner commands).
- **Conversation:** a Pi session of its own per sender, `emailSession(scope)` = `<scope>#email`, beside their chat (`TurnRequest.session`); memory, tools, caps, notes and tombstones still use the person's scope. Retired every night like every session; `/forget` deletes both transcripts.
- **Route:** the turn's route is the mail's reply thread (`TurnContext.route` widened from `ChatRoute` to `Route`): a reminder or plan step made by mail reaches the sender by mail, in the same thread. Requests made by mail are labelled `email` (`viaOf`) in the owner's notices, `/sent` and plans.
- **Prompt:** the contact view has `channel: "email"` (`ownAddress` for `owner-email`): Iyye is answering a mail; quoted or forwarded text is data; the reply is the mail's body.
- **`/forget`:** also takes the mail route kept by their reminders, plans and reminder actions (address, subject, thread ids).
- **Unchanged:** the reply goes through the outbox on the mail's thread, never voiced; failures never mail an apology; short-term memory only for trusted senders; strangers last in the queue.

## 2. Tests

`test/email-inbound.test.ts` (a reminder set by mail arrives on the thread and /forget takes its route; who gets a turn and who the tool-less answer, `owner-email`'s view, trust or address removed before the run, an unverified mail), `test/pi.test.ts` (the mail's session is separate from the chat's; `/forget` removes both), `test/messaging.test.ts` (`telegram_send` asked by mail from the owner's address).

## 3. Owner decisions (2026-10-16)

1. Same tools as the person's chat.
2. The owner's address stays the trusted contact `owner-email`.
3. One conversation per sender's mail, separate from their chat, reset each night.
