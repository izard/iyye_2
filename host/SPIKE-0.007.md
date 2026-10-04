# Plan 0.007 S0 spike — background model, pause and resume, importance check

- Date: 2026-10-04. Machine: the owner's Mac (128 GB), with the live host running (gemma-4-26B loaded).
- Everything ran on scratch ports and scratch state; nothing touched `~/.iyye2`, the owner's router or the owner's Kev.
- Scripts: `scripts/spike-0007-pause.ts` (fake router), `scripts/spike-0007-models.ts <scratch>` (real router), `scripts/spike-0007-importance.ts <scratch>` (real Kev).

## 1. Pause and resume in Pi (fake router, `spike-0007-pause.ts`)

A background step is a Pi turn; "pause" is `session.abort()` through the turn's `AbortSignal` (already wired in `runTurn`). Three cases, each followed by a resume turn:

| Abort while | Abort returned after | Transcript afterwards | Tool result kept? |
| --- | --- | --- | --- |
| the model generates (after a tool result) | ~10 ms | user, assistant tool call, tool result, empty assistant `stopReason: aborted` | yes; the tool was not run again |
| a tool runs (0.8 s probe) | when the tool finished (~0.4 s) | the tool's **real** result, then an empty assistant `stopReason: error` | yes; Pi lets a running tool finish |
| the first generation | ~2 ms | user, empty assistant `aborted` | (no tool yet) |

- Pi leaves **empty** aborted/errored assistant messages out of the next request (checked in the recorded requests).
- `agent.continue()` refuses to start from an assistant message, so resuming after an abort is a **new prompt**: a host note ("[Note from Iyye's host] continue where you stopped") sent through the normal turn. The model then sees the step so far, including tool results, and continues. No Pi core patch is needed.
- A running tool is never cut off: the pause waits for it. Probes are short (S4 keeps them under a few seconds).

Open (checked on the real model below): an abort in the middle of *streamed text* leaves an aborted message with partial content; whether Pi sends that partial text in the next request.

**Answered on the real models (§2):** after an abort in the middle of streamed text, the transcript keeps an aborted assistant message *with* its partial text (290 and 459 characters), but the resume request carried only system, user and the host note: Pi leaves aborted messages out of later requests, partial or not. No `context`-hook filtering is needed. Abort settled 2–3 ms after the signal.

## 2. The background model (real router, `spike-0007-models.ts`)

20 investigation prompts per model, in the planned step format (evidence, question, "use the tools, cite what they returned"), through `PiConversations` with real probes: `system_status`, and `git_log`, `git_show_stat`, `read_file` on a scratch repository with 4 known commits. A citation check compares every figure, hash and file name in the answer with the tool calls' arguments and results.

| | gemma-4-E4B (Q8_0) | qwen35-4b-tak |
| --- | --- | --- |
| load | 2.0 s | 2.5 s |
| resident RAM | 8.9 GB | 3.8 GB |
| prefill / decode (llama.cpp timings) | 550 / 24 tok/s | 125 / 35 tok/s |
| answered | 20/20 | 20/20 |
| correct answer | 19/20 | 16/20 |
| answered without calling any tool | 0 | 4 (one invented a commit hash, `8a3b2c9d1e0f`) |
| tool-call errors | 0 | 0 |
| citation check flags | 2 (one false: "80 GB" came from the question; one honest failure: it passed `"observation o7, notes.md"` as a path, was refused, and said so) | 6 |
| median / slowest step | 3.8 s / 5.4 s | 3.6 s / 14.4 s |

**Choice: gemma-4-E4B.** It always measured before answering and never invented a figure; Qwen3.5-4B is smaller and decodes faster but answered a fifth of the steps from nothing. (The owner's "fine-tuned later" may still favour a Qwen3.5 base, shared with Kev; that is a Stage 4 question and can be re-measured then.)

Lessons for S5's citation check:
- figures that appear in the step's own prompt (the evidence and question) count as grounded;
- models write figures in Markdown and LaTeX (`**157.9 GB**`, `$56.4\text{ GB}$`); normalise before matching.

## 3. The importance check (real Kev, `spike-0007-importance.ts`)

15 hand-made changes (8 worth telling the owner, 7 routine), two wordings, kev-4b@6cfce5c on its own port.

| Wording | Worth: lowest p | Routine: highest p | At 0.3/0.6 | At 0.30/0.45 |
| --- | --- | --- | --- | --- |
| v1 "Is this change worth remembering long-term and telling the owner about, rather than routine noise?" | 0.45 | 0.40 | 9 agree, 6 unsure | **12 agree, 3 unsure, 0 wrong** |
| v2 "Would the owner want to be told about this change today, because it may need attention …?" | 0.27 | 0.31 | 12 agree, 2 unsure, 1 wrong | — |

- v1 ranks all 15 correctly (it separates at about 0.42). v2 spreads the machine cases more but calls "3 new commits since yesterday" routine (0.27).
- **Choice: v1, band 0.30/0.45.** The unsure band goes to the deterministic change rule. 15 hand labels are a starting calibration, not a measurement; the owner's `/decisions label` answers re-fit it.

## 4. Decisions for S1–S5

1. Background model: **gemma-4-E4B** (`IYYE2_BACKGROUND_MODEL` default).
2. Pause = abort the step's turn through its `AbortSignal`; resume = a host-note turn in the same session. Running tools finish; nothing is re-run; no Pi patch.
3. Importance role: wording v1, abstention band 0.30/0.45, fallback the change rule.
4. Day RAM with E4B: gemma-4-26B (~28 GB) + E4B (8.9 GB) + Kev (~10 GB) — fits; memory showed 92% free before the spike.
