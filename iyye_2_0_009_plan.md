# Iyye 2.0.009 — Stage 3, Developing Character: Rough Plan

- Entry condition (plan 0.013 E6, 2026-10-10): `test/integrity-gate.test.ts` passes and `/facts report` shows no key with two current values and no untraced citation.
- Status (2026-10-10): **CH0 done (`host/SPIKE-0.009.md`), and CH6's environments and round trip (infrastructure only, `decision-worker/TRAINING.md`); nothing else built.** Before (2026-10-05): **rough draft; owner decisions on the voice in §6. Comes after plan 0.010 (motivations), which it builds on (owner decision, 2026-10-05).** Starts after M8 has produced a few real days of records (the evidence character learns from). Owner requirement: one part is **a separate, tunable small model that only rephrases outputs according to character and mood**.
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
- Mood is honest and bounded. **It mostly colours phrasing** (owner decision 2): word choice, length, warmth. **Saying it in words is the exception**: the kernel allows one short mood remark ("long day here, so briefly:") only when a dimension is clearly away from baseline, at most once per conversation per day, and the meaning check accepts that one added sentence only when it was allowed and carries no fact. It never invents feelings beyond what the records support (identity rule: "do not invent … feelings"), and never changes what Iyye does or promises.
- `/mood` shows it with its sources; journaled (`mood_samples`) so the voice's training examples carry the mood they were written in.

### 2.3 The voice: a separate, tunable small rephrasing model (owner requirement)

- **What it does:** input = the finished output text + the character's style dials + the mood + the audience (owner / contact, language) → the same message, rephrased. Nothing else: no tools, no memory access, no conversation history beyond the one output.
- **Where it sits (owner decisions 1, 6): only Telegram messages, to every contact and to the owner's linked Telegram accounts alike.** Replies, and messages Iyye sends (`telegram_send` text, but not its label line; reminder delivery wrappers, but not the reminder's own words). The owner's web chat, notices and the day summary are never rephrased. One pass per output, between Pi's final answer (or the composed send) and the outbox, inside the turn's device hold.
- **What it never touches:** owner command replies (deterministic), quoted words of a person (reminder texts, the label lines), tool-result quotes, receipts and status reports, trust/security messages, refusals of authorization. These are marked as fixed segments that the voice receives as placeholders and the host re-inserts.
- **The meaning check (host, deterministic, like `summaryProblem` and `checkCitations`):** every number, date, time, URL, file name, hash, proper name and quoted string in the original must appear in the rephrasing; no new ones may appear; a promise or "I did X" claim may not appear unless it was there; negations and problem words ("could not", "failed", "may not have arrived") must survive; the language must match; length within bounds. On failure → the original goes out unchanged (journaled). Later a Kev "same meaning?" role runs in shadow next to it.
- **The model, chosen by A/B testing** (owner decision 3): its own registry selection (`/use <model> voice`); candidates from `models.json`: `minicpm5-2b`, `qwen35-4b-tak`, `gemma-4-E4B` (already resident as the background model). Two kinds of A/B, both feeding one report (`/voice ab`):
  - **blind owner comparison:** for a sample of real contact messages, `/voice compare` shows the original's two rephrasings from two candidates, unlabeled, and the owner picks one (or neither). Each pick is also a preference pair for tuning;
  - **live split:** each contact-day is assigned one candidate (deterministic, balanced, journaled), comparing meaning-check failure rate, latency, and weak outcome signals (the contact replied; no "what do you mean?" follow-up).
  The owner reads the figures and picks; the loser is unloaded.
- **One voice for everyone** (owner decision 4): one style for all contacts at first; no per-contact styles.
- **Tunable, in three layers:**
  1. **Conditioning** (day one): character and mood as a compact structured header; a `strength` dial (0 = pass-through, the safe default) per surface: owner web, owner Telegram, contacts, Iyye's own messages.
  2. **A voice LoRA, one of the nightly tunables** (owner decision 5): trained by the same bounded nightly tuning job as Kev's decision adapters (Stage 4), with the same registry, held-out set, promotion discipline and rollback, and the meaning check as a hard gate on every candidate. Its examples are preference pairs: the owner's blind A/B picks, `/voice better <id>` with the owner's own wording, `/voice worse <id>`. **Scope safety:** the voice now speaks to contacts, so its training text comes from their conversations; one shared adapter could carry one contact's facts into another's messages through its weights (HLD §15 #3). So examples are stored and trained **with the facts masked**: every fixed segment (names, numbers, dates, quotes, files) is a placeholder, as the voice itself sees it, and an example whose text still names a person is dropped. `/forget` removes a person's examples and deactivates an adapter trained on them until it is rebuilt clean (§10.5).
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
  - **As built (2026-10-10):** `host/src/voice/check.ts` (the meaning check, `maskFixed`/`unmask`; `test/voice-check.test.ts` with labelled pairs, a held-out set never used to tune it: 12.5 % false rejects, 21 % false accepts) and `scripts/voice-spike.ts` (94 real replies, all English, and 32 synthetic, 14 Russian; three candidates, masked and plain). Usable rephrasings (accepted and actually changed): gemma-4-E4B 47 % (41 tok/s; it keeps Russian only when the instructions are in Russian, then 19 of 28 synthetic Russian rephrasings usable), qwen35-4b-tak 42 % (91 tok/s), minicpm5-2b 19 % (mostly copies). llama.cpp applies a per-request LoRA scale through the router; a changed scale re-evaluates the prompt. A MiniCPM5 voice LoRA trains at 0.47 s/step in 6 GB and converts in 3 s. qwen35-4b-tak cannot carry a trained voice (no known source checkpoint). Figures and recommendations in the spike; the model is the owner's A/B choice in CH3.
  - **The check's second revision (2026-10-10):** dates in words (weekdays, months, today/tomorrow/yesterday, English and Russian) as fixed segments compared by what they name, possessive names, a tense rule (past ↔ future), no fewer negations. On a fresh held-out set written before the change: 21 % false rejects, 17 % false accepts (the CH0 check: 21 % and 58 % on the same set; optimistic, since the same author wrote rules and set). Details in the spike.
- **CH1 — Character state:** migration, revisions, `character.json`, `/character …`, prompt composition reads style (HLD §4.3); no learning yet; temperament wired into the kernel's dials at 1.0 (no behaviour change).
- **CH2 — Mood:** deterministic mood from records, `/mood`, journal; the valence Kev role in shadow.
- **CH3 — Voice, shadow, and A/B:** the voice runs on every Telegram message to a contact and the meaning check judges it, but the **original is delivered**; `/voice` shows both; `/voice compare` and the live split collect the A/B figures; the owner picks the model and when to let it act.
- **CH4 — Voice, acting:** on contacts' Telegram messages only; one strength dial; fixed segments; the bounded mood remark; fallback to the original; owner feedback commands collecting masked pairs.
- **CH5 — Nightly character review:** bounded deltas from evidence, interests/habits, undo/freeze/reset, forgetting.
- **CH6 — Voice in the nightly tuning** (environments and the round trip built 2026-10-10: `voice_provision.py`, `voice_train.py`, the converter venv, `scripts/voice-lora-smoke.ts`; no data path, evaluation, registry or schedule yet): the voice LoRA becomes one tunable of the Stage 4 nightly job (built with it, or this stage builds the job's generic part first: candidate registry, held-out sets, promotion and rollback, preemption by owner input). Character review (CH5) and the temperament tuning stay deterministic and bounded; only the voice and Kev adapters are trained weights.
- **CH7 — Evaluation (exit gate):** two scratch installations fed different evidence for several simulated days develop different, repeatable habits and voices; the same installation keeps them across restart and a chat-model change; reset removes them; generated self-praise moves nothing.

## 4. Risks

- **The voice changes meaning.** The host check plus fallback is the guard; shadow first; the check errs toward refusing.
- **Latency.** One more generation per contact reply on a shared device; the A/B figures include it, and strength 0 switches the voice off.
- **Mood as manipulation.** A contact steering Iyye's mood: conversational mood is confined to that conversation and bounded; global mood comes only from records.
- **Feedback loops.** Style drifting toward whatever got any reply: bounded steps, total budget, regularization, distinct-day evidence, owner feedback weighted above volume (§11.2).
- **Over-anthropomorphising.** Mood is presented as what it is, a summary of real state; the identity rule against invented feelings stays above it.
- **Training on private words.** The voice speaks to contacts, so its examples come from their conversations: facts are masked, named people dropped, and forgetting deactivates affected adapters.

## 5. Still open

- When Stage 4's nightly job is built relative to CH6, since the voice depends on it.
- The source of `qwen35-4b-tak` (decision 7), without which it cannot carry a trained voice; whether gemma-4-E4B's GGUF LoRA converts and applies (not yet tried).

## 6. Owner decisions (2026-10-04)

1. **Surfaces:** the voice rephrases only Telegram messages to contacts.
2. **Mood:** mostly colours phrasing; saying it in words is an exception.
3. **Voice model:** chosen by A/B testing.
4. **One voice** for all contacts.
5. **Tuning:** the voice is one of the nightly tunables, trained with the others.
6. **The owner's linked Telegram accounts get the voice too**, like every contact (2026-10-04, later).
7. **The voice model for now: `qwen35-4b-tak`** (2026-10-10, after CH0). CH3 starts with it; the A/B (decision 3) can still replace it. Known from CH0: it cannot carry a trained voice LoRA until its source checkpoint is known (an adapter trained on Qwen3.5-4B would be applied to other weights), so CH6 needs that source or another model; its Russian needs the instructions in Russian.

Next: CH1 (character state), after plan 0.010 M4's trial.
