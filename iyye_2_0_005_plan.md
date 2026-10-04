# Iyye 2.0.005 — Identity Linking (Theory of Mind, stage 1): Implementation Plan

- Status (2026-10-03): owner decision in §6. **I1 (linking) done.** Stage 2 (owner notes about people, people before they write) is next when the owner asks.
- Scope: one **person** can have several channel accounts. The owner links accounts into a person, or into the owner, from a local owner surface. Conversation, short-term and long-term memory and trust then follow the person, not the account. This is the first stage of Theory of Mind (HLD §6.4): knowing *who* someone is, before modelling what they want.
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §6.2 ("owner-approved identity links can join channel bindings; Hindsight entity resolution may suggest a match but cannot establish identity or trust"), §6.4, §9.2 (only a local owner operation may bind identities), §15 #3.
- Motivation (2026-10-03): the owner's two Telegram accounts were two unrelated contacts. Facts the owner gave through one account (his son Jacob is 12; Julia has Iyye's contact) were invisible to the other account and to the web chat's conversation.

## 1. Model

- **Accounts and persons.** A contact row stays what it is today: one identity with its channel bindings. A **link** (`contact_links`, migration 012) says that an *account* belongs to a *person*, which is another contact or the owner.
  - Links are one level only: a person is never itself linked, and an account with linked accounts cannot be linked.
  - No rows are merged, so a link can always be undone and the history stays auditable (HLD §6.4: the owner can unlink).
- **One resolver.** `resolvePerson(account)` (binding → contact → person) is the only place a principal is decided. Admission uses it, so an event from a linked account gets the **person's** principal and scope. Everything downstream (jobs, Pi session, STM, the night's bank, tool calls, trust) already keys off the event's scope and follows automatically.
- **Linked to the owner** (owner decision 1): the account **is the owner**.
  - The principal is owner and the scope is `owner`: the same Pi conversation as the web chat, the owner's memory with its read-only view of every contact's memory, and owner toolkits.
  - Owner input from it wakes Iyye at night, like the web chat.
  - **Owner commands still work only from the local web chat and the terminal.** Telegram text that looks like a command is ordinary dialogue, as before.
  - The cost, accepted by the owner: whoever controls a linked Telegram account can read everything Iyye knows.
- **Linked to another person:** the account speaks as that person, with the person's scope, display name and trust.
  - Trust is one flag per person, so linking an untrusted account into a trusted person makes that account trusted. That is acceptable only because `/link` is an owner command, and its reply states the change.
- **Replies** still go to the exact chat that wrote (the outbox route comes from the triggering event). A person with two accounts gets each answer on the account that asked.
- **Memory across a link:**
  - A person reads their own scope plus every linked account's earlier scope (STM rows and Hindsight bank), so what was said before the link is not lost.
  - New episodes go to the person's scope and bank.
  - The owner reads everything as before, with a linked account's old memory labelled as the person's.
- **Unlink:** the account resolves to itself again, back to its own old scope. Data created while it was linked stays with the person.
- **Ordering:** two accounts of one person share a scope, so their messages are answered one after another (per-scope ordering), like two web-chat messages.
- **Suggestions only:** `/contacts` may show "possibly the same person" (same display name). A display name, a claim in a message ("this is Alex from my second account"), Hindsight entity resolution or Kev can only ever suggest a link, never create one.

## 2. Owner commands (local web chat and terminal only)

- `/link <account> owner` and `/link <account> <person>`: link an account. A reference may be a name, an id prefix of at least 6 characters, or a Telegram user id. An ambiguous name changes nothing and lists the ids, like `/trust`.
- `/unlink <account>`.
- `/contacts` lists persons with their accounts, the owner with any linked accounts, trust, and same-name hints.

## 3. Milestones

### I1 — Linking (this increment)
- Migration 012 `contact_links`; `resolvePerson` and `accountsOf` in `state/contacts.ts`; admission through the resolver.
- The scheduler's conversation view comes from the principal, not the channel: an owner-linked Telegram account gets the owner view.
- The owner's conversation note becomes channel-neutral, so web and Telegram turns share one stable system prompt and never re-process the conversation on each channel switch.
- The memory gateway's readable scopes include linked accounts' old scopes, labelled by person.
- `/link`, `/unlink`, and `/contacts` grouped by person.
- **Tests:**
  - a Telegram `/link` or `/trust` from any account is dialogue, even from an owner-linked account;
  - an owner-linked account gets owner scope, the owner view and owner recall, and its reply goes to its own Telegram chat;
  - person linking moves scope and trust, and the reply states it;
  - recall includes the account's earlier STM and bank, and never another person's (§15 #3: Julia still cannot reach Alex);
  - ambiguous names change nothing;
  - unlink restores the old scope;
  - no chains.

*(I1 as built, 2026-10-03)*
- **Linking:** migration `012_contact_links.sql`; `state/contacts.ts`: `resolvePerson`, `accountsOf`, `linkOf`, `linkAccount` (refuses self-links, linking the owner, chains in either direction), `unlinkAccount`.
- **Admission:** `admitTelegramUpdate` sets the principal to `resolvePerson(account)`, so the event's scope is the person's (or `owner`).
- **Scheduler:** the view comes from the principal (an owner principal on Telegram gets the owner view), and so does the detailed failure notice.
- **Prompt:** the owner's conversation note is channel-neutral ("through the local web chat or one of their own Telegram accounts"), so web and Telegram share one stable prompt.
- **Memory gateway:** a person's readable scopes include their linked accounts' earlier scopes. The owner's recall labels an own account's items "your own account", with "Owner said", and another person's as `contact "Person" (their account "X")`.
- **Commands** (`kernel/commands.ts`): `/link <account> owner|<person>` (the reply states what changes, including trust), `/unlink <account>`. `/trust` on a linked account points at the person. `/contacts` shows you (owner) with your accounts, each person with their accounts, trust and bindings, and a same-name hint.
- **Tests** (`test/identity.test.ts`, 4):
  - owner link: owner scope, view and recall of the account's earlier STM; the reply on its own chat; one conversation across web and Telegram; `/trust` and `/link` sent from it are dialogue;
  - person link: scope, name and trust follow the person, the reply goes to the account, the earlier STM is recalled, another person stays isolated; `/untrust` on the account is redirected; unlink restores the scope;
  - ambiguity, chains, self-links and `/contacts` grouping;
  - the resolver.

  The suite has 239 tests.

### Stage 2 (later, not built): what Iyye knows about a person
- **Owner-stated notes about a person:** `/note <person> <text>`, e.g. "my son, 12; keep answers age-appropriate", with a **visibility** setting. A note shown in that person's own prompt can be repeated to them, so private notes must stay owner-only.
- **People before they write:** `/person add Jacob "my son, 12"` creates a person with no account yet. When Jacob's Telegram account first writes, the owner links it to that person, and his conversation starts with the right context.
- **A new-contact notice to the owner,** with link suggestions.
- **Relationship hypotheses** derived from conversations (HLD §6.4: stated evidence vs revisable hypotheses), source-linked, from Hindsight observations; never diagnoses.

## 4. Risks

- **An owner-linked Telegram account is as powerful as the owner in dialogue and tools** (owner decision 1). Commands stay local-only; a compromised account still exposes memory.
- **Linking the wrong account** gives it the person's history. Ambiguity is refused, and the reply names exactly what was linked.

## 5. Out of scope

- Stage 2 (§3).
- Merging histories (a person's old Pi transcripts are not combined; recall covers them).
- Linking web identities (the web chat is the owner only).

## 6. Owner decisions (2026-10-03)

1. **A Telegram account linked to the owner is the owner** (full owner identity): the same conversation and memory as the web chat, a read-only view of every contact's memory, and owner toolkits. Trust, link and model commands remain local-only. Chosen over a separate "Alex on Telegram" person and over a limited owner identity.
