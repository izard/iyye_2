# Iyye 2.0.014 — Email from Iyye's Own Mailbox: Implementation Plan

- Status (2026-10-15): **built**; not live until the owner configures the mailbox (§5) and restarts the host. Owner decisions in §4.
- Scope: the owner or a trusted contact asks Iyye to email someone; Iyye composes the mail and sends it at once from its own mailbox. Outbound only: nothing arrives by email.
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §7.3 (effects through the outbox), §9.1 (capabilities by effect), §15 #5 (delivery only by receipt), §15 #15 (forgetting). Builds on plan 0.008 (`telegram_send`), whose shape it follows.

## 1. Design

- **One tool, `email_send(to, subject, text)`**, in a new `email` toolkit (`host/src/tools/email.ts`), a new effect `send` (an outward effect for the owner and trusted contacts; `trusted` stays the read-only effect of `vision`, and `send` counts as an effect for the voice and the prompt): the owner and every contact the owner trusts (owner decision 1), never Iyye's own work, investigations or plan steps. Trust is read again when the tool runs. Declared last; always on under toolkit selection (a hidden one would refuse "email this to Bob").
- **Two kinds of recipient, never mixed** (owner decision 2), always decided by the host:
  - a **name**: a person Iyye knows (`resolveRecipient`, as `telegram_send`), at the address the owner stored for them with `/person email <person|me> <address|none>` (migration 041, `contact_emails`; the owner's web chat and terminal only; one person per address). A contact's conversation is told the person's name, never the stored address;
  - an **address**: accepted only when it is written in the very message that asked (`messageText` of the turn's own event). An address from a web page, a tool result, memory or an earlier message is refused, so nothing Iyye reads can choose a recipient.
- **Iyye composes the words**; the mail ends `--` / `Sent by Iyye, an AI assistant, on behalf of <name>.` From: Iyye's own mailbox (owner decision 3: a dedicated account, never the owner's private one).
- **Sent at once** (owner decision 4) through `Outbox.sendOwn` on a new outbound-only route `{ channel: "email", to, subject }` (key `notice:email:<id>`). `ChatRoute` (web, Telegram) remains the only route a turn, reminder or plan can have; email is never an inbound `Channel`.
- **The SMTP client is the host's own** (`channels/email/smtp.ts`, no new dependency), because the outbox needs exactly which step failed:
  - failure before the message's closing dot (connect, TLS, login, MAIL/RCPT refused): a definite non-delivery, retried by the outbox for 4xx and network trouble, not for 5xx or a refused login;
  - 250 after the message: delivered, receipt `provider_accepted` with the Message-ID (accepted, not read);
  - 4xx/5xx after it: not delivered;
  - no answer after it (connection lost, 120 s silence): **unknown**, never resent by itself; the owner resolves it.
  - TLS always verified (implicit TLS or STARTTLS before login; a server without STARTTLS is refused); a line break in any header refused; non-ASCII subjects as RFC 2047 words; body UTF-8 base64. The login name and password never appear in an error.
- **Bounds:** one mail per address per request (a retried turn never sends twice); `IYYE2_EMAIL_DAILY_MAX` (20) a day in all, `IYYE2_EMAIL_CONTACT_DAILY_MAX` (5) per trusted contact; subject one line ≤ 150, text ≤ 10,000, one recipient, no CC/BCC, no attachments.
- **The owner sees:** a web notice for every mail a trusted contact asked for; one notice for any mail that fails for good; `/sent` lists emails with their state; the day summary counts them (never the words or addresses); the web chat's attention list shows an unknown or failed mail with its address.
- **Reply review:** a mail the turn sent (`email:<id>`) is a recorded effect, so "I emailed Bob" is a supported claim.
- **`/forget <person>`:** waits while a mail to or for them is on its way; then the words, subject and address go from `sent_emails`, its action (content and route), the owner's notices and the `email_send` tool call, and their stored address is deleted.

## 2. Risks

- **A trusted contact emails anyone** (decision 2 allows an address they type). Bounds: their own typed address only, the per-contact cap, the signature naming them, and the owner's notice for every such mail.
- **Injected instructions** (a fetched page in the same turn) cannot add a recipient (§1), but could alter the words to a legitimate one. Same bound as `telegram_send`: the signature, the records and the notices.
- **The account's password** sits on the host (0600, read at each send, never logged). A dedicated account limits the damage if it leaks; a Gmail app password can be revoked alone.
- **Spam filtering:** a new account may land in spam; "accepted" never claims more than the server's acceptance.

## 3. Tests

`host/test/email.test.ts` against the in-process fake SMTP server `host/test/fixtures/fake-smtp.ts` (implicit TLS and STARTTLS with the test-only certificate, PLAIN and LOGIN, scripted refusals, a dropped and a hung connection after the message). Never a real server from tests.

## 4. Owner decisions (2026-10-15)

1. **Who:** the owner and all trusted contacts (not Iyye's own work).
2. **Recipients:** both stored addresses and addresses typed in the asking message.
3. **Mailbox:** a dedicated account, certainly not the owner's private one.
4. **Sending:** at once, no confirmation step.

## 5. Setup (owner, once)

1. Create a dedicated mailbox. For Gmail: turn on 2-step verification and make an app password.
2. On the host machine:
   ```
   mkdir -m 700 ~/.iyye2/email
   cat > ~/.iyye2/email/config.json <<'EOF'
   {"host": "smtp.gmail.com", "port": 465, "security": "tls", "user": "<the account>", "from": "<the account>", "name": "Iyye"}
   EOF
   printf '%s\n' '<app password>' > ~/.iyye2/email/password && chmod 600 ~/.iyye2/email/password
   ```
   (`"port": 587, "security": "starttls"` works too.)
3. `cd host && node scripts/email-smoke.ts <your address>`: one real test mail with the host's own client.
4. Restart the host; the log says `email: not available` with the reason if anything is missing. `IYYE2_EMAIL=0` turns it off.
5. Store addresses: `/person email me <address>`, `/person email Bob <address>`.
