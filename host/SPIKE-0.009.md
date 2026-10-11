# CH0 spike — the voice (plan 0.009, DGX Spark, 2026-10-10)

llama.cpp: the host's `build_27` llama-server, build 11362, commit 926862e57 (the converter venv is locked to the same commit).

What it measured: which small model can be Iyye's voice (a rephraser that changes tone, never meaning), how well the host's meaning check judges rephrasings, whether llama.cpp applies a per-request LoRA in router mode, and what training and converting a voice LoRA costs on the Spark. The model choice stays with the owner (owner decision 3: A/B in CH3); this spike gives the figures. All runs used their own llama-server on a free port (never the live router), with the live host running beside them.

## Inputs

- **Real:** the 94 distinct delivered replies (20–1500 characters) in the Spark's live database, read-only. All are English; there is **no real Russian reply** yet. Per-item outputs stay in `~/.iyye2/spikes/voice` (0700); only figures are here.
- **Synthetic:** the 32 originals of `test/fixtures/voice-pairs*.json` (18 English, 14 Russian).
- **Prompt:** the style as the system message (warmth, brevity, playfulness, formality, and a mood line), the message framed as `Rewrite this message in Iyye's voice: <<< … >>>`; temperature 0.3, `repeat_penalty` 1.0 per request (the registry's default 1.2 penalizes exactly the repetition a rephraser needs), thinking off. Without the framing, MiniCPM5 returned every message unchanged.
- **Modes:** *masked* (the plan's design: fixed segments replaced by `⟦n⟧` placeholders the host puts back) in two styles ("warm", "terse"), and *plain* (the whole text) for comparison: 378 rephrasings per model.

## The meaning check (`src/voice/check.ts`)

Fixed segments must survive as a multiset (numbers, times, dates, URLs, e-mail, @mentions, paths and file names, hashes, quotes, names: known contacts and capitalized words not starting a sentence; a Russian name by its stem). A failure may become a negation, never vanish; negations, hedges, promises ("I will", "сделаю") and reports of something done ("sent", "готово") may neither appear nor disappear; script share and length stay close.

| Labelled set | Faithful refused (false reject) | Changed accepted (false accept) |
| --- | --- | --- |
| `voice-pairs.json` (40 + 40, used to develop the check) | 0 / 40 | 1 / 40 (added content with nothing fixed in it: "I'm busy today") |
| CH0's held-out set (24 + 24, written after, never used to tune at CH0; now `voice-pairs-ch0-heldout.json`) | **3 / 24 (12.5 %)** | **5 / 24 (21 %)** |

The held-out misses: a tense change ("arrived" → "will arrive", "добавила" → "добавлю"), a lowercase Russian weekday ("вторник" → "среда"), a replaced reason that keeps a negation ("no access" → "I checked: no meetings"); refused: a possessive name ("Tuesday's"), passive reports ("are now on the list"). **A deterministic check cannot see meaning without fixed segments**: it is a filter, as the plan says, not proof.

**Second revision (2026-10-10, after CH0; "For CH3" item 2).** Dates in words are fixed segments compared by what they name (weekdays, months, today/tomorrow/yesterday, English and Russian with case endings: "Tuesday's" = "on Tuesday" = "во вторник"; English months only capitalized, "May" never at a sentence start); a possessive is the same name; a tense rule (a future marker may not appear or vanish beside a past form, and a past verb may not come back only as another form of the same verb; a Russian short participle reports the same completed act); there may not be fewer negations than before. Tuned on the development set and CH0's held-out set (which is development since). A fresh held-out set, `voice-pairs-heldout.json` (12 originals, 7 English and 5 Russian, 24 + 24), was written before the rules were coded and measured once:

| Set | False rejects | False accepts |
| --- | --- | --- |
| development (40 + 40) | 0 / 40 | 0 / 40 |
| CH0's held-out, now development | 2 / 24 | 1 / 24 ("пришла" → "придёт": a Russian future without a marker, from another stem) |
| **fresh held-out, second revision** | **5 / 24 (21 %)** | **4 / 24 (17 %)** |
| fresh held-out, the CH0 check | 5 / 24 | 14 / 24 |

Caveat: the same author wrote the rules and the fresh set, knowing which kinds of change the revision targets, so the fresh set over-represents dates and tenses and the drop in false accepts (14 → 4) is optimistic; real rephrasings decide. The new false rejects are negations moved by idiom ("don't forget", "rather than", "не позже", "молчит"): the negation-count rule's cost. Still missed: present → past ("is on Thursday" → "was on Thursday"), a question reported as an answer, "будет" beside a participle, a state read as a deadline. Those need a model's judgement: the Kev "same meaning?" role in shadow (item 4 below).

## Candidates (masked, both styles, 252 rephrasings each)

| | minicpm5-2b | qwen35-4b-tak | gemma-4-E4B |
| --- | --- | --- | --- |
| Generation speed | 91 tok/s | 91 tok/s | 41 tok/s |
| Latency, median / p90 | 0.85 / 2.6 s | 0.75 / 2.4 s | 1.85 / 5.8 s |
| Accepted by the check | 57 % | 57 % | 47 % |
| …of which unchanged (a copy) | 87 of 143 | 35 of 143 | 0 of 118 |
| **Usable** (accepted and ≥ 5 % changed) | **19 %** | **42 %** | **47 %** |
| Usable, real replies only | 40 / 188 | 78 / 188 | 96 / 188 |
| Placeholders lost, repeated or invented | 94 | 45 | 11 |
| Russian synthetic accepted, English system prompt | 20 / 28 (19 unchanged) | 15 / 28 (7 "language changed") | 0 / 28 (27 translated to English) |
| Russian synthetic accepted, **Russian system prompt** (`--native-prompt`) | 27 / 28 (26 unchanged) | 18 / 28 (6 unchanged) | **19 / 28 (none unchanged)** |
| Style gap (two styles, same input; median edit distance) | 0.08 | 0.28 | 0.44 |
| Thinking leaked | 0 | 0 | 0 |
| Plain mode accepted (no placeholders) | 54 % | 47 % | 37 % |

**Weak labels** (gemma-4-12B as judge, "same facts, promises, problems?", on the warm masked rephrasings that unmasked; a model's verdict, not ground truth, HLD §10.2):

| | accepted, judge "same" | accepted, judge "different" | refused, judge "same" | refused, judge "different" |
| --- | --- | --- | --- | --- |
| minicpm5-2b | 53 | 13 | 5 | 7 |
| qwen35-4b-tak | 54 | 20 | 16 | 18 |
| gemma-4-E4B | 53 | **6** | **57** | 4 |

Reading:
- **MiniCPM5-2B** mostly copies (style gap 0.08) and loses placeholders on real replies with many segments; as a voice it barely speaks.
- **qwen35-4b-tak** rephrases moderately, keeps Russian best, but has the highest share of accepted rephrasings the judge calls different (27 %) and loses placeholders often. It cannot carry a trained voice (below).
- **gemma-4-E4B** rephrases most and keeps placeholders best; the judge calls only 10 % of its accepted rephrasings different, but the check refuses half of what the judge calls the same (it rephrases further than the check's lexical rules allow). With an English system prompt it translated every Russian message into English; with the instructions in Russian it kept Russian and had the most usable Russian rephrasings (19 of 28, changed median 0.41; its refusals there were mostly capitalized words the check took for added names). The voice's prompt must be in the message's language. Half the speed, and already resident as the background model. **Russian rests on 14 synthetic originals only: indicative, not a result.**
- Masking helps: plain mode drops quotes, names and paths that masking protects.

## The voice LoRA round trip (`scripts/voice-lora-smoke.ts`, MiniCPM5-2B, synthetic data only)

| Step | Result |
| --- | --- |
| GGUF = Hugging Face source? (`gguf_match.py`, cosine of dequantized Q6_K tensors vs safetensors) | token_embd 0.9996, ffn_down 0.99996, norms 1.0: the same model |
| Training (`voice_train.py`: peft LoRA r8 on q/k/v/o, 40 synthetic pairs, 20 steps × 4, bf16) | 45 s wall (34 s load), 0.47 s/step, peak 6.0 GB CUDA; loss 2.29 → 0.95 |
| Conversion (llama.cpp `convert_lora_to_gguf.py`, converter venv) | 3 s, f16 GGUF LoRA |
| Router mode: preset `lora = <file>`, per-request `lora: [{id: 0, scale}]`, greedy, 12 held-out prompts | **works through the router**: scale 1 differs from the plain model in 10/12 (both runs) |
| Determinism (second run) | the same request again gave the same text 12/12, cached or fully re-evaluated, plain model and LoRA alike |
| Scale 0 vs the plain model | the same text in 10/12 (first run) and 8/12 (second); since repeats are exact, the difference is systematic: a model loaded with a LoRA at scale 0 is close to, not identical with, the model without one. The voice off should mean the model without the LoRA (or that difference accepted) |
| No `lora` field | equal to scale 1 in 11/12 in the first run, 5/12 in the second (it was each prompt's first request after loading; unexplained). The voice must always send its scale explicitly |
| Prompt cache | a request with another scale re-evaluates the whole prompt (~195 tokens); the same scale again reuses it (1 token). Blending scales per request (plan §2.3, layer 3) costs a full prefill each time the scale changes |
| Parity, greedy, Hugging Face bf16 (+ peft) vs llama.cpp on the Q6_K GGUF | two runs: base 8/12 and 7/12 identical, LoRA 11/12 and 12/12, median shared prefix 100 %; the adapter changed the HF output in 10/12 |
| Stopping and the lock (after the refactor into `worker_env.py`) | SIGTERM a few seconds after start: voice trainer gone in 0.46 s, Kev trainer in 0.63 s, partial directories deleted, no process left; with a voice run holding the lock, a Kev run exited 3 at once |

## The voice LoRA round trip on gemma-4-E4B (2026-10-11, synthetic data only)

Same smoke (`scripts/voice-lora-smoke.ts --model gemma-4-E4B --steps 20`), same fixtures, two runs, the live host running beside it (its background model is this same GGUF, loaded separately by the live router).

| Step | Result |
| --- | --- |
| Provisioning (`voice_provision.py gemma-4-E4B`, network once) | 11.5 min, 16 GB (one bf16 safetensors file: text, vision and audio towers) |
| GGUF = Hugging Face source? (Q8_0) | token_embd 0.99992, blk.0 ffn_down 0.99992, blk.0 attn_output 0.99998, blk.41 attn_q 0.99996: the same model. `gguf_match.py` now has tensor pairs per GGUF architecture (Gemma 4's text model lives under `model.language_model`; norms and the 2.8-billion-parameter per-layer embedding are not compared) and fails when a pair cannot be compared |
| Training (r8 on q/k/v/o of the **text model only**, 40 synthetic pairs, 20 steps × 4, bf16) | 135 / 139 s wall, of which 112 / 118 s loading 16 GB; 1.0 s/step; peak 17.3 GB CUDA; loss 2.32 → 0.93 / 0.92; 4.5 M trainable parameters. `voice_lora.py` now targets the text model's linear layers by full name: the vision and audio towers have same-named projections (the audio tower's wrapped, so a bare suffix fails). 264 adapter tensors: q/o on all 42 layers, k/v on the 24 that compute their own keys (the last 18 share them) |
| Conversion (`convert_lora_to_gguf.py --base`, the existing converter venv) | 2.5–2.9 s, 264 tensors, f16. **No newer converter needed:** with `--base` it reads `config.json` directly, so transformers 4.57.6 not knowing `gemma4` does not matter; llama.cpp 926862e57 has the `Gemma4ForConditionalGeneration` text converter |
| Router mode, per-request `lora`, greedy, 12 held-out prompts | **works**: scale 1 differs from the plain model in 12/12; repeats exact 12/12 (cached); scale 0 = plain in 8/12 (both runs, as MiniCPM: close, not identical); no `lora` field = scale 1 in only 2/12 (MiniCPM 11 and 5): always send the scale; a changed scale re-evaluates the prompt (~190 tokens), the same again reuses it |
| Plain model, the same request fully re-evaluated | 11/12 identical (MiniCPM 12/12): one greedy text changed with the batch shape of a full prefill |
| Parity, Hugging Face bf16 (+ peft) vs llama.cpp Q8_0 | base 7/12 identical, LoRA 11/12 (both runs), median shared prefix 100 %; the adapter moved the HF output in 12/12 |
| MiniCPM5-2B again with the changed scripts | unchanged: same model, 0.47 s/step, 6.0 GB, loss 2.29 → 0.95, LoRA parity 12/12 |

So gemma-4-E4B can carry a trained voice through the same path as MiniCPM5: about 2.3 × the step time and 3 × the memory, both small for a nightly job.

## Which models can carry a trained voice

- **minicpm5-2b:** yes, verified end to end (source `openbmb/MiniCPM5-2B@f974000`, arch llama).
- **gemma-4-E4B:** yes, verified end to end (2026-10-11, below; source `google/gemma-4-E4B-it@ee0ef60`, arch gemma4, the registry's `gemma-4-E4B-it-Q8_0.gguf`).
- **qwen35-4b-tak:** no. A custom fine-tune of Qwen3.5-4B with no published source; an adapter trained on the base would be applied to other weights (HLD §9.5). The owner may know its source.

**Owner decision (2026-10-10): the voice model is `qwen35-4b-tak` for now** (plan 0.009 §6, decision 7); a trained voice on it needs its source checkpoint.

## For CH3

1. The model (one voice, owner decision 4; the owner decides by A/B): gemma-4-E4B has the most usable rephrasings in English and, with a Russian prompt, in Russian, the fewest the judge calls different, and keeps placeholders best; its LoRA path works (2026-10-11, below). qwen35-4b-tak is faster but cannot carry a trained voice. MiniCPM5 is not a voice without tuning.
2. ~~The check needs: weekdays and months (both languages) as fixed segments, tense of report verbs, possessive names; then a fresh held-out set.~~ Done (second revision, above).
3. Russian: no real data yet; the voice's instructions in the message's language.
4. A Kev "same meaning?" role in shadow beside the check (the plan's next step), since lexical rules miss tense and replaced reasons.
