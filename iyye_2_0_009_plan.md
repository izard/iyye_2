# Iyye 2.0.009 — Stage 3, Developing Character: Rough Plan

- Status (2026-10-04): **rough draft for discussion; nothing built.** Starts after M8 has produced a few real days of records (the evidence character learns from). Owner requirement: one part is **a separate, tunable small model that only rephrases outputs according to character and mood**.
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §4 (stable identity, developing character, prompt composition), §5.2 (motivations), §6.4 (relationship context), §8.2 (adenosine), §9.3 (models are replaceable, character persists), §10 (learning), §11 (a recognizable day, reinforcement with damping), §14 Stage 3, §15 #12, #13, #15.
- Builds on: adenosine (0.007 S2), the day summary and night (0.002, 0.007 S3), Kev and the decision journal (0.003), outcome records (receipts, commitments, findings, plans, `/sent`), `/forget` and tombstones.

## 1. The idea in one paragraph

Iyye's **character** is a small, explicit, versioned state (temperaments, style, interests) that changes slowly, at night, only from verified evidence, within hard bounds, and that the owner can inspect, undo, freeze or reset. Its **mood** is a fast, honest state derived from records (energy, how the day is going, how the current conversation feels), decaying to baseline. Character changes **choices** (how often Iyye investigates, notices, offers observations, writes to people) through the kernel's existing dials. Both change **expression** through one new component, the **voice**: a separate small model that receives a finished output and rephrases it in Iyye's current character and mood, while a host check guarantees that no fact, number, name, promise or problem is added, dropped or changed. The model that decides *what* to say never decides *how Iyye feels*; the voice never decides *what* is said.

## 2. Components

### 2.1 Character state (HLD §4.2)

- `character_revisions` table (immutable rows) + `~/.iyye2/character.json`, the active revision's snapshot.
- Contents, small and interpretable:
  - **Temperament** multipliers: curiosity, agency, social initiative. Start at 1.0, bounded [0.7, 1.3], at most ±0.02 per night each, a total nightly budget, slow regularization toward 1.0.
  - **Style** dials (0–1): brevity, warmth, playfulness, formality, how often to volunteer an observation, emoji use. Same bounds and damping.
  - **Interests and habits**: short source-linked statements ("checks the workspace repository after commits", "likes Alpine geography questions"), each with its supporting record ids, added only after repeated distinct-day evidence, retired when the evidence ages out.
  - Owner corrections (pinned values), review time, revision number, reset watermark.
- `identity.md` stays owner-only and unchanged by learning. Character never touches authorization, trust, quiet hours or caps' upper limits.

### 2.2 Mood state (new; HLD §8.2 is its honest-metaphor precedent)

- A few bounded dimensions, **computed deterministically from records**, never from the model's self-report:
  - **energy** ← adenosine level (tired late, fresh after a full night);
  - **ease** ← the day's outcomes (delivered vs failed messages, fruitful vs fruitless investigations, errors, model outages);
  - **engagement** ← recent interaction (a lively conversation vs a quiet day), per conversation;
  - **valence of the current exchange** ← a Kev role on the incoming message (shadow first), per conversation only.
- Global parts (energy, ease) decay toward baseline and reset at a completed night; conversational parts live only in that conversation. A rude contact cannot make Iyye curt with the owner.
- Mood is honest and bounded: it may colour phrasing ("long day; here's the short version") but never invents feelings beyond what the records support (identity rule: "do not invent … feelings"), and never changes what Iyye does or promises.
- `/mood` shows it with its sources; journaled (`mood_samples`) so the voice's training examples carry the mood they were written in.

### 2.3 The voice: a separate, tunable small rephrasing model (owner requirement)

- **What it does:** input = the finished output text + the character's style dials + the mood + the audience (owner / contact, language) → the same message, rephrased. Nothing else: no tools, no memory access, no conversation history beyond the one output.
- **Where it sits:** between Pi's final answer and `Outbox.deliver` (and before `sendOwn` for Iyye's own notices, findings, day summary text and `telegram_send` messages). One pass per output, inside the turn's device hold.
- **What it never touches:** owner command replies (deterministic), quoted words of a person (reminder texts, the label lines), tool-result quotes, receipts and status reports, trust/security messages, refusals of authorization. These are marked as fixed segments that the voice receives as placeholders and the host re-inserts.
- **The meaning check (host, deterministic, like `summaryProblem` and `checkCitations`):** every number, date, time, URL, file name, hash, proper name and quoted string in the original must appear in the rephrasing; no new ones may appear; a promise or "I did X" claim may not appear unless it was there; negations and problem words ("could not", "failed", "may not have arrived") must survive; the language must match; length within bounds. On failure → the original goes out unchanged (journaled). Later a Kev "same meaning?" role runs in shadow next to it.
- **The model:** a small instruct model, its own registry selection (`/use <model> voice`), candidates from `models.json`: `minicpm5-2b`, `qwen35-4b-tak`, `gemma-4-E4B` (already resident as the background model, so no extra memory), chosen by the V0 spike on latency and meaning preservation.
- **Tunable, in three layers:**
  1. **Conditioning** (day one): character and mood as a compact structured header; a `strength` dial (0 = pass-through, the safe default) per surface: owner web, owner Telegram, contacts, Iyye's own messages.
  2. **A voice LoRA** trained on preferred rephrasings: pairs (original → the version the owner preferred) from explicit owner feedback (`/voice better <id>` with their own wording, `/voice worse <id>`, "shorter please" detected by a Kev role and confirmed). Owner-scope data only; contacts' conversations never enter the voice's training set. Trained at night through the Stage 4 machinery (registry, held-out set, promotion/rollback); this may be the first generative adapter that machinery serves.
  3. **Per-request LoRA scale** (if the V0 spike confirms llama.cpp applies per-request adapter scales in router mode): the character's dials can blend adapters ("warmer" vs "terser") without retraining.
- **Why separate:** the chat model can be swapped (HLD §9.3) without losing Iyye's voice; the voice can be tuned cheaply and rolled back without touching judgment; and its narrow job makes its failures checkable.
- **Costs:** an extra generation per output (a few hundred tokens on a 2–4B model; the spike measures it). Owner directive holds: no time limit; if the voice model is not loaded, the original goes out (never a wait or a load on the chat path).

### 2.4 Character changes choices (HLD §4.2 "must change actual choices")

The kernel's existing dials read the temperament, multiplied and clamped:
- curiosity → investigation cooldown and daily allowance (0.007 S5), stale-domain windows (S4);
- social initiative → findings-per-day cap, "volunteer an observation" frequency, the Iyye-initiated message cap (0.008), never above the configured maximum;
- agency → how readily Iyye proposes a plan for an open intention (once Iyye can propose plans).
The bounds stay with the kernel: a more adventurous temperament investigates more often within its budget; it cannot grant itself tools.

### 2.5 Nightly character review (HLD §8.3, §11.2)

- A night phase after memory work: gather the day's **evidence** with author/action ids:
  - **expressed preference:** explicit owner feedback ("shorter", "more detail", "don't message Jacob so often"), detected by a Kev role (shadow first, then acting with confirmation);
  - **observed outcome:** fruitful vs fruitless investigations, findings the owner engaged with vs ignored, messages answered vs unanswered, reminders confirmed;
  - **hypotheses** (Iyye's own guesses) are recorded but carry no weight on their own.
- Propose a bounded delta → a new revision with its evidence list; never from self-praise, message volume or the model's appraisal of itself (§15 #12).
- Interests and habits: a statement is added only after evidence on ≥ 3 distinct days, retired after N quiet days.
- The voice pairs gathered that day become candidates for the next voice training run.

### 2.6 Owner controls and forgetting

- `/character` (current values with their sources), `/character diff [n]` ("what changed in you?"), `/character undo`, `/character freeze|unfreeze`, `/character reset` (keeps factual memory; sets a watermark so old evidence cannot recreate the same revision; switches off the voice LoRA).
- `/mood`, `/voice` (recent rephrasings beside their originals, failures of the meaning check), `/voice off|on|strength <surface> <0–1>`, `/voice better|worse <id>`.
- `/forget <person>` removes that person's evidence from character revisions (recomputing affected statements) and drops voice pairs that quote them; a voice adapter trained on removed pairs is deactivated until retrained clean (HLD §10.5).

### 2.7 Declarative skill trials (HLD Stage 3, second half)

Kept for later in this stage: a useful recipe ("weekly repo digest") becomes a declarative skill only after evaluation, with no executable code and no new permissions (§15 #13). Sketched here, planned in its own increment.

## 3. Milestones (rough)

- **CH0 — Spike:** pick the voice model (latency, meaning preservation on ~200 real replies from the M8 journal, English and Russian); measure the meaning check's false-reject rate; verify llama.cpp per-request LoRA in router mode; measure a small mlx/llama LoRA training run's time and memory on this machine (owner approval needed before any training).
- **CH1 — Character state:** migration, revisions, `character.json`, `/character …`, prompt composition reads style (HLD §4.3); no learning yet; temperament wired into the kernel's dials at 1.0 (no behaviour change).
- **CH2 — Mood:** deterministic mood from records, `/mood`, journal; the valence Kev role in shadow.
- **CH3 — Voice, shadow:** the voice runs on every eligible output and the meaning check judges it, but the **original is delivered**; `/voice` shows both. Owner then decides per surface when to let it act.
- **CH4 — Voice, acting:** strength dials per surface, fixed segments, fallback to the original, owner feedback commands collecting pairs.
- **CH5 — Nightly character review:** bounded deltas from evidence, interests/habits, undo/freeze/reset, forgetting.
- **CH6 — Voice tuning:** the first voice LoRA from owner-approved pairs through the Stage 4 registry (held-out pairs, the meaning check as a hard gate, promotion/rollback).
- **CH7 — Evaluation (exit gate):** two scratch installations fed different evidence for several simulated days develop different, repeatable habits and voices; the same installation keeps them across restart and a chat-model change; reset removes them; generated self-praise moves nothing.

## 4. Risks

- **The voice changes meaning.** The host check plus fallback is the guard; shadow first; the check errs toward refusing.
- **Latency.** One more generation per reply on a shared device; the spike decides whether it fits, and strength 0 is a per-surface off switch.
- **Mood as manipulation.** A contact steering Iyye's mood: conversational mood is confined to that conversation and bounded; global mood comes only from records.
- **Feedback loops.** Style drifting toward whatever got any reply: bounded steps, total budget, regularization, distinct-day evidence, owner feedback weighted above volume (§11.2).
- **Over-anthropomorphising.** Mood is presented as what it is, a summary of real state; the identity rule against invented feelings stays above it.
- **Training on private words.** The voice trains on owner-scope pairs only; forgetting deactivates affected adapters.

## 5. Open questions for the owner

1. Which surfaces get the voice first: the owner's web chat only, or also Telegram, contacts, Iyye's own messages?
2. May Iyye mention its mood in words ("I'm a bit tired tonight"), or should mood only colour phrasing?
3. Voice model size: share the resident `gemma-4-E4B`, or a dedicated smaller one (2B) for speed?
4. Should contacts each get their own style (e.g. simpler words with Jacob), learned from stated preferences, or one voice for everyone at first?
5. Training approval: the voice LoRA (CH6) is local training on this machine; it needs your explicit go-ahead (HLD §12.2), as Kev training does.
