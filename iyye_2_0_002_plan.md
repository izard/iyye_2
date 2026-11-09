# Iyye 2.0.002 — Long-Term Memory: Implementation Plan

- Status (2026-10-03): plan accepted; owner decisions in §8. **L0 (spike): go** (`memory/SPIKE.md`). **L1 (supervised service) done. L2 (pass-through, gate, memory model) done.** Redesigned after L2 (owner, 2026-10-02) around 1.x's day/night split (§3.4, decision 6). **L3 (day recall), L4 (sleep and wake), L5 (night transfer and consolidation) and L6 (`/forget`, `/remember`, memory acceptance) done.** 0.002 is complete.
- Scope: Iyye remembers across conversations and restarts. It retains what was said, recalls relevant evidence before it answers, lets the model search memory, and moves the day's short-term memory into long-term memory at night, all locally.
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §6 (memory and relationships), §5.1 (one device-consuming task), §8.3 (dreaming), §9.3 (one admission broker), §15 #1, #2, #3, #15.
- Builds on 0.001 ([plan](iyye_2_0_001_plan.md)): admission, scheduler, model manager, Pi integration, tool broker, outbox.
- Upstream: Hindsight 0.10.2 (clone `hindsight/` @ `0be6c02b2`; PyPI `hindsight-api`; npm `@vectorize-io/hindsight-client` 0.10.2).

## 1. What 0.001 has, and the gap

| Memory layer (HLD §6.1) | 0.001 | 0.002 |
| --- | --- | --- |
| Working context | Pi transcript per scope (owner, each contact), about 16k tokens per conversation | unchanged; per-turn recalled evidence is added |
| Episodic evidence | only inside Pi transcripts | **STM:** each answered turn becomes a scoped episode in SQLite, searchable at once; at night it is retained into Hindsight and leaves STM |
| Consolidated understanding | none | **LTM:** Hindsight facts and observations, extracted and consolidated at night |

## 2. Hindsight facts this plan relies on (from its docs and client; L0 verifies each)

- **Runs locally:** `pip install hindsight-api` (full) on Apple Silicon includes:
  - an embedded Postgres (pg0);
  - a local BGE embedder (about 130 MB);
  - a MiniLM cross-encoder reranker (about 90 MB).

  Expected RSS is 0.8–1.5 GB, and it needs Python 3.11 or newer.
- **Model endpoint:** an OpenAI-compatible provider is set with `HINDSIGHT_API_LLM_PROVIDER=openai`, `…_BASE_URL` and `…_MODEL`. Retain, consolidation, reflect and mental-model refresh can each have their own model, concurrency cap and timeout.
- **Retain:**
  - `documentId` (replace on re-send), `tags`, `metadata`, `timestamp`;
  - `async` with a caller-supplied `operationId`, for idempotent retries;
  - `GET …/operations/{id}` gives the status.
- **Recall:** filters by tags (`all_strict`, `any_strict`, tag groups), a token budget, minimum scores and the memory `types`, and can include source facts.
- **Consolidation:**
  - `HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false` (also per bank) turns off automatic runs;
  - `POST …/consolidate` triggers one;
  - reconcile and mental-model sweeps stop at `…_INTERVAL_SECONDS=0`;
  - `HINDSIGHT_API_WORKER_ENABLED=false` stops the background worker entirely.
- **API key:** `HINDSIGHT_API_TENANT_EXTENSION=…ApiKeyTenantExtension` with `HINDSIGHT_API_TENANT_API_KEY`.
- **Documents:** they can be deleted, and memories can be invalidated or edited.

## 3. Design decisions

### 3.1 Hindsight never reaches the model router directly

Hindsight's model calls (extraction, consolidation, reflect) would otherwise bypass the scheduler. That breaks the one-task-on-the-device rule and model leases, and it fails visibly: the router runs with `--no-models-autoload`, and the owner can `/unload` the model. So:

- The host serves a small OpenAI-compatible **memory pass-through** on 127.0.0.1, and Hindsight's `LLM_BASE_URL` points at it.
- It forwards `/v1/chat/completions` to the router only while a memory job holds a lease on the **memory model**. At any other time it answers 503, and Hindsight's retry and backoff absorbs that.
- The memory model is a selection like the others: `/use <model> memory`, persisted in `model_selection`, which needs a schema change for the new channel value.
- Hindsight runs with:
  - concurrency 1;
  - auto-consolidation off;
  - all sweeps off;
  - its worker on only if L0 shows `async=false` retain is impractical;
  - timeouts well above its 30 s reflect default (owner directive: a slow answer beats a timed-out one).
- Embedding and reranking run inside the Hindsight process, on CPU or MPS. L0 measures whether they contend with Metal inference.

### 3.2 Banks come from the trusted scope

- **One bank per scope:** `iyye-owner` and `iyye-contact-<contact id>`. Each is created on first use, with Iyye's bank config applied (auto-consolidation off, mission text).
- **Never chosen by the model:** the gateway derives the bank from the scope admission assigned (HLD §6.2).
- **Only the host holds the key:** the Hindsight API key lives in a 0600 file in the state dir. No model-reachable code holds a Hindsight client.
- **No `owner-console` retention:** the dev console scope is never retained.
- **Owner reading contacts' banks (owner decision, §8):** the owner scope also reads contact banks, read-only and labelled by contact. A contact scope reads only its own bank.

### 3.3 Recalled memory never becomes new evidence

- **Recall is per turn, not persisted.** Before each turn the gateway recalls from the scope's bank within a small token budget, and Pi gets the result through a request-local `context` hook. Pi docs: "transforms conversation messages … Pi restores that state afterward". Iyye owns this as an inline extension. L0 verifies it works with Iyye's custom `ResourceLoader`; if not, the fallback is a clearly delimited block prepended to the turn text.
- **Recall is marked as data.** The evidence block is labelled as memory, with source dates and IDs, and is never presented as instructions.
- **What a retained episode contains:**
  - the admitted user text, as written;
  - the reply the outbox actually delivered, attributed to Iyye;
  - never the recalled block, tool chatter, failure notices, dropped events or owner commands.
- **Iyye's reply is not corroboration, by construction** (owner, 2026-10-02, after the first live night stored Iyye's own offer "I'll flag worrying messages from Jacob" as the owner's "protocol"; the mission alone did not stop the local model). Provenance is a tag the host sets, never a judgement the model makes (`memory/provenance.ts`):
  - **The person's words** are their own document, `<event>:said`, tagged `speaker:person`. It holds no text of Iyye's, in content or context; the context names the speaker. Hindsight extracts facts from it.
  - **Iyye's reply** is a separate document, `<event>:replied`, tagged `speaker:iyye`, retained with the bank strategy `iyye-verbatim` (`retain_extraction_mode: chunks`). It is stored as written, with no model call, so no model rephrases it into a claim.
  - Tags are inherited by facts and observations. Consolidation scopes observations by tag set, so Iyye's words never merge into the person's observations (verified on the real model; see L5).
  - **Recall:**
    - The per-turn block recalls with `tags: [speaker:person]`, `tags_match: any`: the people's words plus untagged legacy memories, never Iyye's.
    - `memory_search` sees everything.
    - Every long-term item is labelled from its tag: "stated by the person", "your own earlier words, not evidence", or "source not recorded" for untagged memories. An untagged memory is never shown as the person's.
  - The retain mission remains, as a backstop only.
  - **Trade-off:** a bare "yes" answering a question from Iyye extracts nothing, because the question is not in the person's document. That is the price of never laundering Iyye's proposals into the owner's facts.
- **Episode envelope:** two documents per episode as above. Tags `scope:<scope>`, `channel:<web|telegram>` and `speaker:<person|iyye>`. Metadata: event id, speaker, and action id on Iyye's document. `timestamp`: when it was said or delivered. `completed` or `completed_empty` is decided by the person's document only.

### 3.4 Day and night (1.x's STM → LTM, owner decision 6)

Generative memory work never shares the device with dialogue because it never runs while Iyye is awake.

- **STM is the transfer outbox** (migration 009, `stm_episodes`): one row per answered event, created in the transaction that marks the event answered (§3.3 lists what it holds). It is scoped like the event, carries the episode envelope, and is indexed with SQLite FTS5 (`unicode61`; queries use word stems as prefixes, so «Джулии» finds «Джулия»; verified on the bundled SQLite 3.53.4). States: `day → completed | completed_empty | failed`, plus `attempts` and the last error. STM holds turns, not extracted facts: keeping it costs no model work.
- **Day:** before each turn the gateway recalls from STM (scope-filtered in SQL, bm25-ranked, today's episodes) and from LTM (Hindsight recall: CPU embedder and reranker only, no model call, about 0.1 s). `memory_search` reads the same two. No retain, no consolidation.
- **Night:** a minimal sleep mode (§8.1 of the HLD: awake → winding down → asleep → waking, persisted in `kv`):
  - *Falls asleep* at the start of the rest window (`IYYE2_SLEEP_WINDOW`, default `02:00-06:00` local time), on the owner's `/sleep`, or as **catch-up** when STM holds episodes older than 24 h and no night has completed for 24 h (the Mac was off or asleep at night): then at startup or after 30 minutes without owner input.
  - *Winding down:* the running chat turn finishes; the scheduler takes no new contact jobs; the outbox dispatcher holds deliveries (HLD §15 #11). The owner web chat gets the local status "starting sleep".
  - *Models rest* (owner, 2026-10-02): once asleep, every model except the memory model is unloaded, so the night has the device and RAM to itself and the memory model always fits under `IYYE2_MODELS_MAX`. A router restart at night reloads none of the chat models. On waking, a model that only the night needed is unloaded and the chat channels' selected models are loaded again. Until they are back, jobs wait for them instead of timing out, so a contact's 3 a.m. message is answered, not failed.
  - *Asleep:* one `MemoryGate.run` **per episode**: retain into the scope's bank (`document_id` = event id; Hindsight 0.10.2 replaces a document with the same id and skips identical content, so a retry after a crash never duplicates). Then `consolidate` for each bank that received facts, under the gate. Confirmed episodes (`completed`, or `completed_empty` when extraction found nothing) leave STM. A failed one stays, recallable, and is retried next night; after 3 attempts it is `failed` and shown in `/memory`.
  - *Owner input wakes Iyye at once:* the night work stops after the current episode (at most one retain, 10–30 s), and the owner is answered. Contacts' messages are admitted while asleep but wait until waking; they do not count as "chat pending" for the gate, or one 3 a.m. message would stall the whole night. If the owner then stays quiet for 15 minutes inside the window, sleep resumes.
  - *Waking:* when STM is drained and consolidation is done, or at the end of the window. The owner web chat gets "waking up day N"; queued contact jobs and held deliveries go out.
- **Thinking at night:** reasoning off was a daytime latency compromise. With reasoning on, L0 stored nothing for small talk and kept the "Iyye's repetition is not evidence" mission. So `enable_thinking` becomes a property of the admission (`IYYE2_MEMORY_THINKING`, default on), and L5 measures the night with it.
- **Hindsight down:** turns still answer and recall falls back to STM only; STM grows until a night succeeds; the status bar says LTM is unavailable. Iyye never fabricates recall (HLD §13).
- Full dreaming (plan review, character, training, day summary; HLD §8.3 phases 4–7) stays in 0.003.

### 3.5 Tools and owner controls

- **`memory_search`:** an `IyyeTool` for everyone, bound to the session's scope. The model supplies only a query, and results come back as quoted evidence with dates.
- **`memory_reflect`:** deferred, because reflect is heavy and the design keeps it for sleep or explicit questions.
- **Owner commands:**
  - `/memory` shows the service state, mode (awake/asleep), STM episodes by scope, failed transfers, and the last completed night.
  - `/sleep` and `/wake` put Iyye to sleep now or wake it.
  - `/forget <contact>` deletes that contact's bank, documents and pending transfers, and leaves a tombstone so a retry cannot re-import it (as built: L6 below).
  - `/remember <text>` retains an explicit owner fact with high priority (as built: an STM entry stored first at night).

## 4. Milestones

### L0 — Spike (gate)
Run against its own router on a separate port and state folder (check ports first), never the owner's live host. Verify and record in `host/PINS.md`:
1. Install `hindsight-api==0.10.2` in a uv-managed Python 3.11 venv under `iyye_2/memory/.venv`. Find out what pg0 and the local embedder and reranker download on first start; provision them once, then run with `HF_HUB_OFFLINE=1` and no egress (A9 style).
2. Retain via `async=false` and via async with operation id, with the worker disabled; and `consolidate` with the worker disabled. This decides whether Iyye fully controls when Hindsight uses the device.
3. Extraction quality and speed through the router with gemma-4-26B (reasoning off), gemma-4-E4B and qwen38-27b-tak, on a fixed set of 10 owner turns. Does it treat Iyye's statements as Iyye's?
4. Recall latency and quality, and whether the embedder or reranker on MPS slows Metal inference.
5. `deleteDocument` and bank deletion: are derived facts and observations removed too? Forgetting depends on it (HLD §6.4).
6. Pi 1.0.0: an inline extension's `context` hook works through Iyye's `ResourceLoader` and leaves the transcript unchanged.
7. RAM of the Hindsight process at rest and under load.

Exit: a short `memory/SPIKE.md` with measurements and a go/no-go per design point in §3, and the plan updated where reality differs.

*(Done 2026-10-02, see `memory/SPIKE.md`.)* Differences from what §2–§3 assumed:
- **OpenSSL.** pg0's PostgreSQL needs arm64 OpenSSL from `/opt/homebrew`, which this Mac lacks. A patch (the venv's OpenSSL plus `install_name_tool` and ad-hoc signing) works; the production choice is §8.4.
- **Offline.** Hindsight must run with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` after provisioning. It binds 0.0.0.0 by default, and its database has default credentials on port 5432; L1 fixes all of these.
- **Postgres lifecycle.** It survives a Hindsight SIGKILL and is then not stopped by Hindsight, so L1's supervisor owns `pg0 stop`.
- **Worker.** It can stay on: with auto-consolidation and sweeps off, Hindsight uses the model only when Iyye triggers it.
- **Memory model.** gemma-4-E4B with reasoning off: retain 8–14 s per turn, consolidation about 5 s. With reasoning on it is 20–45 s and 100 s, with slightly better attribution, and consolidation removes the difference.
- **Recall hook.** Recall uses Pi's `DefaultResourceLoader` (all discovery off) plus an inline `context` extension, which was verified to be request-local. This replaces `IyyeResourceLoader` for memory-enabled sessions.
- **No GPU contention.** Embedder and reranker run on CPU (Hindsight declines MPS).

### L1 — Hindsight as a supervised local service
`memory/`:
- pinned `requirements.lock`;
- the host spawns and stops Hindsight like the router: own pid file, log, adopt-or-start, kills only its own pid, minimal environment, API key file;
- health checks;
- status in the web UI (`memory: up / starting / down`).

Exit: tests against a fake Hindsight HTTP server, plus one real-service smoke script.

*(As built, 2026-10-02)*
- **Processes** (`host/src/memory/`):
  - `postgres.ts` manages Iyye's own cluster in `~/.iyye2/memory/pgdata` through `pg_ctl`:
    - initdb with scram-sha-256 and a 0600 password file;
    - an `iyye.conf` include pins it to 127.0.0.1:`IYYE2_MEMORY_DB_PORT`, TCP only (macOS socket paths over 103 bytes fail), with `max_connections` 50;
    - `CREATE DATABASE` and `CREATE EXTENSION vector` are idempotent;
    - adoption after a crash is `pg_ctl status` on its own data directory;
    - the password goes only through `--pwfile` and `PGPASSWORD`.
  - `service.ts` (`MemoryService`) runs Hindsight through the shared `process/supervised.ts`. The router was refactored onto the same helper, and its tests are unchanged.
- **Hindsight's environment** is built from scratch:
  - Iyye's Postgres URL, refused unless it is `postgresql://…@127.0.0.1`, so pg0 can never be used;
  - pool at most 10 connections;
  - `HF_HUB_OFFLINE`, local embedder and reranker;
  - model calls to the pass-through port (L2);
  - auto-consolidation and sweeps off;
  - the API key from a 0600 file.

  Adoption also requires an authenticated request to succeed.
- **Startup:** in the background, with an honest status (`not installed`, `needs provisioning`, `starting`, `up`, `retrying: …`) in `/api/status` and the UI. A health loop restarts with backoff. Shutdown stops Hindsight, then Postgres.
- **Provisioning** is explicit: `host/scripts/provision-memory.ts` downloads the two models into `~/.iyye2/memory/hf`. The host never does.
- **Tests:** `test/memory.test.ts` uses a fake `hindsight-api` and the real conda Postgres (skipped when it is not installed). They cover the exact environment (no inherited `OPENAI_API_KEY`), refusal of a non-local DB URL, adoption after a host crash, restart after a kill, busy ports, 0600 secrets, the wrong password being refused, and TCP only.
- **Real-service smoke:** `host/scripts/memory-smoke.ts <scratch>` brought both services up from nothing in 12 s, and both stopped cleanly.

### L2 — Memory pass-through and the memory model
- the pass-through server with lease gating;
- `/use <model> memory`;
- migration for the channel value.

Exit: requests outside a lease get 503; requests inside one reach the router with the selected model; and `/unload` of the memory model is refused while a memory job runs.

*(As built, 2026-10-02)*
- **(Superseded by L5)** At the end of L2 nothing called the gate. Since L5 the night job is its only caller.
- **One device slot** (`kernel/device.ts`, `DeviceSlot`): chat jobs (scheduler), console turns and memory work share it, so a chat turn and Hindsight extraction never run on the device together (HLD §5.1). A model lease alone only protects a model from unload.
- **The gate** (`memory/gate.ts`, `MemoryGate.run(label, fn)`) is the only way Hindsight work gets the device. It holds slot → memory model (loaded on demand) → lease → pass-through admission for the whole Hindsight operation, and always lets go in order: stop admitting, drain in-flight calls (30 s, then abort), release the lease, release the slot.
  - Memory work never waits in line: with a chat job queued (`scheduler.hasQueuedJobs()`) or the device held it declines at once (`busy`), and the night job tries again after the next episode boundary. (Under the day/night redesign the gate runs only while asleep, where held contact jobs must not count as pending: L4 changes `chatPending` accordingly.)
  - A refusal that needs the owner (no memory model selected, the model cap is full, not enough RAM) is kept as `gate.problem` and appended to the memory status in the UI, e.g. `memory model gemma-4-E4B not loaded: at most 2 model(s) may be loaded; unload one of: …`.
  - The memory model stays loaded after memory work (reloading it between episodes would cost more than it saves). It counts against `IYYE2_MODELS_MAX` like any other model; `/unload` it to free the slot.
- **The pass-through** (`memory/passthrough.ts`) on 127.0.0.1:`IYYE2_MEMORY_PASSTHROUGH_PORT`:
  - Bearer key from `~/.iyye2/memory/secrets/passthrough_key` (0600, separate from Hindsight's API key); wrong key 401.
  - Only `POST /v1/chat/completions` and a stub `GET /v1/models`; everything else 404.
  - 503 with no admission, while closing, or once the lease is invalid, checked again after the request body arrives (the gate may have let go meanwhile); the router being lost aborts in-flight calls.
  - It always overwrites `model` with the admitted one and sets `chat_template_kwargs.enable_thinking = false`; responses stream through; a client disconnect aborts the upstream call.
- **Hindsight's model settings** (`MemoryService.hindsightEnv`): `LLM_API_KEY` = the pass-through key, `LLM_MAX_RETRIES=1` (a 503 means "not admitted now": fail fast, the episode is retried later), `SKIP_LLM_VERIFICATION=true` (its startup probe could only meet the 503 or spend device time).
- **Memory model selection:** migration `008_memory_selection.sql` adds `memory` to `model_selection` (table rebuilt, rows kept). `/use <model> memory` needs the model only to exist and be available, not loaded. `IYYE2_MEMORY_MODEL` (default `gemma-4-E4B`) seeds it once.
- **Tests:** `test/memory-gate.test.ts` (fake router): 503 outside the gate, nothing forwarded; a body still arriving when the gate closes is refused (this caught a real race); forwarded with the model overwritten and thinking off; streaming; 401/404; a queued chat job or held device makes memory decline; a chat turn waits until memory has fully let go; `/unload` refused while a call drains, allowed after; drain timeout aborts; router lost aborts and later calls 503; full model cap surfaces as `gate.problem`; `/use x memory`; migration 008 on a pre-008 database.
- **Real smoke** (`host/scripts/memory-l2-smoke.ts <scratch> --models-from ~/.iyye2/memory/hf`; real llama.cpp 11362 with gemma-4-E4B, conda Postgres, Hindsight, all on free scratch ports):
  - Hindsight up in 11 s; a retain outside the gate failed in 0.8 s with the pass-through's 503.
  - Inside the gate: three retains took 11.2, 15.5 and 17.7 s; a direct call returned no `reasoning_content`; recall (0.1 s) found "Julia … violin … Tuesdays" and "Alex resides in Berlin" first.
  - **For L4:** with thinking off, the small-talk turn "What's 2+2?" was stored as a fact (with reasoning on, L0 stored nothing). The retain mission or a cheap pre-filter must drop such turns.

### L3 — Day recall: STM, gateway and `memory_search`
- migration 009: `stm_episodes` and its FTS5 index; a row created in the outbox transaction that marks the event answered (never for `owner-console`, failure notices or owner commands);
- `memory/gateway.ts`: scope → STM rows and Hindsight bank, bank bootstrap, recall from both within a budget, labelled "today" or with the remembered date;
- the per-turn `context` hook (verified in L0);
- the `memory_search` tool.

Exit: a turn recalls something said earlier today in another session or channel of the same scope, and something from LTM; a scope cannot reach another scope's STM rows or bank, even with a forged contact name in a tool call (§15 #3); recalled text is absent from the Pi transcript and from STM episodes.

*(As built, 2026-10-02)*
- **STM** (`state/stm.ts`, migration `009_stm.sql`): `stm_episodes` plus an FTS5 table (`unicode61`). `Outbox.complete` writes the episode in the same transaction that marks the event answered, so only a delivered reply creates one (failure notices, owner commands, the console and `unknown` deliveries never do). Queries cut each word to a stem and match it as a prefix (OR, bm25), and never pass FTS syntax through. A `failed` episode stays recallable.
- **Gateway** (`memory/gateway.ts`): `readableScopes` comes from the trusted reader. A contact reads only its own scope; the owner reads its own and every contact's, labelled `from contact "Name"`. STM hits and LTM hits (`memory/hindsight.ts`, recall with budget `low`, 3 s timeout, only banks that exist) are merged into one `<memory>` block that says it is data, not instructions. If Hindsight is down or not yet up, recall uses STM only and says so.
- **Per-turn hook** (`integration/pi/sessions.ts`): `PiConversations` recalls before each turn. An inline `context` extension inserts the block as its own message before the latest user message in each model request. It is loaded through Pi's `DefaultResourceLoader` with all discovery off (`loadInlineExtensions`); any load error is fatal.
- **`memory_search`** (`tools/memory-search.ts`): audience `everyone`, one `query` argument (≤ 300 characters, no other properties), bound to the session's trusted scope.
- **Tests:** `test/memory-recall.test.ts`, with an in-process fake Hindsight (`test/fixtures/fake-ltm.ts`). Covered:
  - stem queries;
  - only answered turns enter STM;
  - the block appears in the request but not in the transcript, STM or the next turn;
  - Julia's turn and `memory_search` never see Alex's STM or bank;
  - the owner sees both, labelled;
  - with Hindsight down the turn uses STM only;
  - leaving STM.

### L4 — Sleep and wake (minimal HLD §8.1)
- mode in `kv` (`awake`, `winding_down`, `asleep`, `waking`, day number, last completed night), rest window, catch-up rule;
- `/sleep`, `/wake`; owner input wakes; resume after 15 quiet minutes inside the window;
- scheduler holds contact jobs while asleep; the outbox dispatcher holds deliveries;
- "starting sleep" and "waking up day N" status events in the owner web chat; mode in `/api/status` and the UI.

Exit: no outward delivery while asleep; an owner message wakes Iyye and is answered; a contact's message is answered after waking; a restart keeps the mode.

*(As built, 2026-10-02)*
- **`kernel/rhythm.ts`** (`Rhythm`): the mode, day number and last night are kept in `kv`. A tick runs every 30 s.
  - **Falling asleep:** at the start of the rest window, once the owner has been quiet for 15 minutes; on catch-up (STM older than 24 h, no night for 24 h, owner quiet for 30 minutes); or on `/sleep`.
  - **Winding down:** waits until no chat turn holds the device, then the mode becomes asleep and the night runs.
  - **Waking:** when the night's work is done; at the end of the window (rest-window nights only); or when the work is blocked, in which case the notice says why.
  - **Owner input:** `wakeForOwner` wakes Iyye without advancing the day, and the night is still owed. Owner commands and console turns count as owner activity, so `/wake` is not undone by the next tick.
- **Models rest:** `ModelManager.restForNight(keep)` unloads everything but the memory model, and while resting `loadSelected` reloads nothing after a router restart. `wakeFromNight` unloads any model no chat channel selects and loads the chat selections. `Rhythm.restoring()` is true from waking until that finishes, and the scheduler then treats a "not loaded" refusal as waiting, not toward `modelWaitMs`.
- **Fresh conversations after a night** (owner decision 7): `Rhythm` calls `onNightEnd` before waking, only when a night completes. `main.ts` wires it to `PiConversations.resetAll()`, which waits for live turns, disposes the sessions and clears `pi_sessions` (`retireSessions`). The next turn of every scope creates a new session file; the old files are kept. The wake notice adds "Conversations start afresh; earlier days are in memory." Tests: `night.test.ts` (called once, while still asleep, and not for an interrupted night) and `pi.test.ts` (a `[[history]]` turn after the reset sees only the new message; the old file still holds the old one).
- **Restart mid-night:** `rhythm.start()` runs before the router and Hindsight are up, so a resumed night first rests the models (which also keeps `models.start()` from loading chat models), then waits up to 5 minutes for `ready()` (router up, memory service up) before its work. Only then does it end as `blocked`, with the reason. An owner wake that arrives before the night loop runs restores the models itself, so `restoring()` cannot stay set.
- **Memory block:** recalled text and contact labels have `<`/`>` replaced by look-alikes, so a contact's `</memory>` cannot close the evidence block.
  - **Restart:** an unfinished night resumes.
  - **Notices:** "starting sleep (…)" and "waking up day N — …" go to the owner's web chat as local notices (`web_feed`), not through the outbox.
- **Scheduler:** while not awake it runs no job unless an owner job is queued, which wakes Iyye. Then all jobs run as usual. `hasRunnableJobs()` (owner-only while asleep) is the gate's `chatPending`, so a held contact job does not stall the night.
- **Outbox:** `held()` stops retries while asleep.
- **Commands:** `/sleep` and `/wake` in both the web chat and the terminal.
  - `/day` shows: awake, asleep or winding down; the day number; the rest window; when the next night starts and why (the window, or catch-up with how much more quiet time it needs); conversations waiting in STM; when the last night ended; and whether a night is still owed after the owner woke Iyye.
  - `/night` shows the night in progress: since when and why, what it is doing now (moving a conversation, consolidating a bank, waiting for a chat turn), STM left, models resting, and any block. It also shows the last completed night: start and end times, how long it took, why it started, and its result.
  - Each night's start time, reason and summary are kept in `kv`.
- **Status:** the UI's memory chip shows the mode and day.
- **Config:** `IYYE2_SLEEP_WINDOW` (default `02:00-06:00`, validated at startup).

### L5 — Night transfer and consolidation
- the night job: one gated retain per episode, `completed_empty`, attempts, crash recovery;
- consolidation per bank under the gate; clear confirmed episodes from STM;
- `enable_thinking` per admission; measure a night with thinking on.

Exit: kill the host mid-night and restart: one document per episode, no duplicate, nothing lost from STM; a Hindsight outage keeps STM and turns still answer; owner input during the night waits at most one retain.

*(As built, 2026-10-02)*
- **`memory/night.ts`** (`NightWork.run(shouldStop)`):
  - One `MemoryGate.run` per episode, with reasoning on (`IYYE2_MEMORY_THINKING`, default 1).
  - Each bank is created on first use with `RETAIN_MISSION`. Iyye's replies are not evidence, small talk is ignored, and facts are written in English.
  - The episode is retained with `document_id` = event id, tags `scope:` and `channel:`, and metadata with the event and action ids.
  - `memory_unit_count` from `GET …/documents/{id}` decides `completed` or `completed_empty`.
  - Banks that received facts are consolidated afterwards, each under the gate with reasoning off. The pending list lives in `kv`, so an interrupted night still consolidates, and a failed consolidation stays pending.
  - **Failures:** an HTTP error from Hindsight charges an attempt (three, then `failed`). If Hindsight can't be reached, or the gate reports a problem such as a full model cap, the night stops as `blocked`, says why, and charges nothing.
- **`enable_thinking` per admission:** `MemoryPassthrough.admit(lease, { thinking })` and `MemoryGate.run(label, fn, { thinking })`. Off unless asked.
- **Tests:** `test/night.test.ts`, 13 tests:
  - transfer to the right banks, content and tags;
  - extraction runs with reasoning on, consolidation with it off;
  - a crash re-retain gives one document;
  - (since 2026-10-03, decision 8) an unstored episode leaves STM for the backlog at the end of the night and is dropped after three nights;
  - Hindsight unreachable or the model cap full gives `blocked`, with no attempts charged;
  - owner input stops between episodes, and consolidation is still owed;
  - windows, including wrapped ones;
  - one night per window;
  - the owner being active keeps Iyye awake;
  - catch-up;
  - winding down waits for the turn, and an owner wake keeps the day number;
  - a restart resumes the night;
  - end to end: a contact is held while asleep and doesn't stall the night, the owner wakes Iyye, both are answered, and no retries happen while asleep.
- **Real night** (`host/scripts/memory-night-smoke.ts <scratch> --models-from ~/.iyye2/memory/hf [model] [--no-thinking]`; gemma-4-E4B with reasoning on, real Hindsight, free scratch ports). Six owner turns, including small talk, Russian and a correction:
  - Day recall from STM found all three test questions, including a Russian one.
  - The night took 217 s: retains took 12–45 s each and consolidation 32 s.
  - "What's 2+2?" and "Thanks!" became `completed_empty`.
  - Consolidation merged the correction into "Alex is expected to visit during January 2027; this rescheduled his previous December visit".
  - The Russian turn was stored as "The user's mother lives in Cheboksary" and recalled from "Где живёт мама?".
  - STM was empty afterwards.
  - About 36 s per turn means a 100-turn day takes about an hour of a four-hour window.
  - An owner message during the night waits for the current operation: up to about 45 s for a retain, or for a consolidation up to the 30 s drain before its calls are aborted.
- **Provenance re-run** (same script, with the 2026-10-02 incident turn and Iyye's real reply added):
  - No fact or observation tagged `speaker:person` mentions flagging. The offer exists only as Iyye's verbatim words.
  - The per-turn recall for "family" returned only `[person]` results; Iyye's words appear only through `memory_search`.
  - Observations stayed per speaker: the person's from the person's facts, and Iyye's (e.g. "The speaker knows…") from Iyye's.
  - **Cost:** Iyye's verbatim words take part in consolidation too. With 7 turns, consolidation took 62–105 s, against 32 s with 6 turns before the split. The verbatim retains themselves make no model call.

### Debugging: clearing long-term memory (as built, 2026-10-03)
- `host/scripts/memory-clear.ts [--bank <id>] [--restage] [--yes]` works against the running host's Hindsight (`IYYE2_STATE_DIR`, default `~/.iyye2`). It lists each bank with its documents and memories, asks you to type `clear` (or takes `--yes`), and deletes the banks with `DELETE /v1/default/banks/{id}`.
  - Hindsight's own "clear memories" keeps the documents, and a re-retain of identical content is skipped, so a cleared conversation could never be stored again. That is why the script deletes whole banks.
  - It removes the deleted banks from the night's list of banks owing consolidation.
  - `--restage` puts the conversations of the deleted banks back into STM (state `day`, attempts reset, indexed again), so `/sleep` re-runs the night on them.
  - It refuses while Iyye is asleep or winding down.
- **The running host copes:**
  - The night forgets which banks it has set up at the start of each run.
  - A retain that gets 404 re-creates the bank (mission and verbatim strategy) and retries once, without charging an attempt.
  - Consolidation of a deleted bank drops it from the list.
  - Recall lists the banks again after an error.
- **Tests:** `test/memory-clear.test.ts`.

### L6 — Owner controls and acceptance
- `/memory`, `/forget <contact>`, `/remember <text>` (an owner STM episode, transferred at night).

Acceptance (§15):
- **#1:** a preference stated, a restart, and a later related question → recalled with its date and source (from STM the same day, from LTM after a night).
- **#2:** a newer explicit correction supersedes an older fact without raising confidence through Iyye's repetition.
- **#3:** Julia cannot reach Alex's STM or bank via retrieval, `memory_search` or forged names.
- **#11 (memory part):** nothing is delivered while asleep.
- **#15:** a forgotten contact's data does not return through recall, retries or re-import; a memory outage keeps STM and invents nothing.

*(L6 as built, 2026-10-03)*
- **`/forget <contact>`** (owner surfaces only; `kernel/commands.ts` → `memory/control.ts`, `memory/forget.ts`):
  - Without `confirm` it only shows what would go (counts per kind) and the exact confirm command. With `confirm` it acts.
  - It covers the person and every linked account (plan 0.005). It refuses the owner and owner-linked accounts, refuses while Iyye is not awake (the night writes to the banks), and refuses while a message from them is still queued or running, or a reply to them is still being delivered.
  - **One SQLite transaction:** a tombstone per scope (`memory_tombstones`, migration 014), their STM entries and FTS rows and their shadow decisions deleted; the text of their messages, of Iyye's replies to them and of their tool calls replaced by `[forgotten]` (dates, routes and delivery records stay); their banks removed from the consolidation list and queued in `bank_deletions_pending`.
  - **Then:** their Pi transcripts (current and retired, `sessions/<scope>/`) are deleted after the live sessions are closed (`PiConversations.forgetScopes`), queued toolkit-selection work is dropped, the banks are deleted in Hindsight (404 counts as done), and Hindsight's stored request traces for those banks are purged.
  - A bank deletion that fails stays queued. It is retried when long-term memory comes up after a start and at the start of every night, before anything is written. Until then recall never reads that bank and the night never writes to it.
  - **No return:** the tombstone keeps anything said before it out of memory: `recordEpisode` (a delivery that completes late), the night (`dropEpisode`) and restaging all refuse it. Both compare the tombstone with when Iyye received the message. What the person says afterwards is remembered normally: the contact, its channels and trust are kept, and the reply says so.
  - **The owner's side:** the owner's recall reads every contact, so Iyye's replies to the owner today may quote the person. In the same transaction, those replies leave the owner's unstored STM entries (only the owner's own words stay, re-indexed), so tonight's night cannot store them; the owner's Pi conversation is also started afresh (`PiConversations.retireScopes`), so its history cannot be quoted again.
  - **Stored words that name them** (owner decision 2026-10-19, built): no record says which memory fed a reply, so the person's names are the test (`memory/mentions.ts`: every name the person and their linked accounts carry, at least 3 characters, whole words, any case and script). `/forget` also removes Iyye's replies to the owner stored on earlier nights that name them (their `:replied` documents and stored facts from `iyye-owner`, the facts' belief evidence, the text in SQLite's short-term memory copy, and their reply reviews), day summaries stored in `iyye-self` that name them, and every conversation transcript, current or retired, in either conversation store that names them (a conversation using one starts afresh). Documents are deleted at once when memory is up, otherwise by the next night before it writes. The preview counts each.
  - **Known limits:**
    - what the owner told Iyye about the person stays in the owner's memory, by design;
    - the name test errs both ways: a namesake's mentions go too, and a reply that used their information without naming them stays; observations Hindsight consolidated from deleted facts may remain (no lineage, plan 0.013);
    - host log lines are not rewritten (they carry ids and states, not message text); the owner's web chat history keeps Iyye's earlier replies.
  - `/memory` lists bank deletions still pending, with their attempts and last error.
  - Recall treats a 404 from one bank (deleted since the bank list was cached) as "nothing there", not as long-term memory being unavailable.
- **The night and outages:** a 502, 503 or 504 from Hindsight (its database or the pass-through is down) now stops the night as unreachable, without charging attempts, like a refused connection. Before, three such nights could drop a day's turns as `failed`. A 500 (extraction failed) is still charged to the episode.
- **`/remember <text>`:** an answered owner web event (`dedup remember:<id>`, payload `{text, remember: true}`) and an STM entry of kind `remember` with no reply (migration 014 rebuilds `stm_episodes` with `kind` and a nullable `action_id`). It is recalled today as "The owner asked you to remember: …". At night it is transferred before everything else, as the person's document only, tagged `speaker:person` and `remember`, with the context "The owner explicitly asked Iyye to remember this". At most 4000 characters.
- **Hindsight request tracing is off** (`HINDSIGHT_API_LLM_TRACE_ENABLED=false`). It was on by default and stored every extraction prompt (people's words) in `llm_requests`, outside the banks, where deleting a bank does not reach. Once long-term memory is up after a start, the host purges any traces left (`MemoryService.purgeTraces`, through Iyye's own PostgreSQL; checked against a real scratch cluster).
- **Acceptance** (`test/memory-acceptance.test.ts`, 8 tests; the fake Hindsight now answers recall from its stored documents by word overlap):
  - **#1:** a preference given in the web chat, a restart, then a question from an owner-linked Telegram account: recalled from STM with its date the same day, and after a night from LTM as "remembered, <date>, stated by the person". The answer goes to the Telegram chat that asked.
  - **#2:** a statement and its later correction are both kept, with their dates, as the person's documents. Iyye's two echoes are stored verbatim (no extraction, so they cannot add a fact or raise confidence) and never appear in the per-turn evidence. Superseding is left to Hindsight's consolidation, which sees both dated statements.
  - **#3:** after a night, Julia and a second account calling itself "Alex" reach none of Alex's memory, by per-turn recall or by `memory_search`, and Alex's bank is never queried for them (also `memory-recall.test.ts`, `identity.test.ts`).
  - **#11 (memory part):** `night.test.ts`, "contacts wait until waking; … retries are held".
  - **#15:** the forget preview and confirm (including a linked account); nothing of theirs left in STM, FTS, events or actions; the bank and transcripts deleted; the owner's recall right after it, with the default bank cache, is empty and not "unavailable"; the owner's question about them stays but Iyye's answer is not stored, and the owner's conversation starts afresh; no return by restaging, a late delivery or the next night; new messages remembered normally. `/forget` during an outage: queued, never read even once Hindsight is back, deleted first by the next night, which then stores the new turn. With Hindsight answering 503, the night stops as blocked and keeps STM with no attempt charged, and recall says that long-term memory is unavailable and presents nothing as remembered. Refusals: the owner, and work in flight.
  - `/remember`: recalled today, stored first at night with its context, with no reply document.
  - Also `memory.test.ts`: the trace-off setting, and the purge per bank or for all, in every schema, refusing a malformed bank id.

  The suite has 254 tests.

## 5. Risks

- **Device contention:** resolved by design (§3.4): extraction and consolidation run only at night. An owner message during the night waits for at most one retain.
- **The night is too short:** at 10–30 s per episode, a 100-turn day takes 17–50 minutes. What does not fit leaves STM for the transfer backlog (decision 8) and is stored by a later night, first; `/memory` shows the backlog.
- **Model cap at night:** resolved by unloading the chat models while asleep. The night fails to load the memory model only if it alone does not fit, and the memory status then says why.
- **Waking takes a model load:** the first reply after waking, including the owner's mid-night message, waits for the chat model to load again (`startup_s` in the registry, about 30 s for gemma-4-26B).
- **Extraction quality with local models:** Hindsight is tuned for strong hosted models. A weak local extractor yields noisy facts, which is the 1.x failure mode, so L0 must show acceptable quality before L4.
- **Python service footprint:** PyTorch and pg0 add disk use and memory.
- **Forgetting:** if deleting a document leaves derived observations, `/forget` needs a bank rebuild. L0 decides.

## 6. Out of scope for 0.002

- full dreaming: plan review, character changes, nightly training and the day summary (0.003); 0.002 has only the minimal sleep and wake that the STM → LTM night needs;
- mental models and knowledge pages;
- `reflect` in conversation;
- Kev salience and recall-budget decisions (Stage 0 decisions, later);
- importing 1.x LanceDB facts;
- shared banks between contacts.

### Follow-up (2026-10-06): what long-term memory keeps

A dump (`scripts/dump-ltm.ts`) showed about 84 of 130 memories were noise: Iyye's own replies stored verbatim (39), observations Hindsight built from them and attributed to the person (29: Iyye's "my abilities are limited to text" became "the user's abilities are limited to text"), machine findings (models loaded, Telegram reconnected) and observations of them (14), and day summaries split into trivia (10, "lowest adenosine was 0.51").

As built (owner decision: drop the verbatim replies, keep the important facts in them with time and provenance):
- **Iyye's replies are extracted, not stored verbatim:** strategy `iyye-reply` with its own `retain_mission` (`REPLY_MISSION`): only what later conversations may depend on (facts Iyye told them with their source, things Iyye confirmed it did or set up, answers), each written as "On <date> Iyye told <person> that …"; never anything about the person. The document's context names the person, the date and what they had asked; tags `speaker:iyye`; metadata event and action ids; timestamp the reply's.
- **No observations from Iyye's words or its probes:** every bank gets a Hindsight consolidation strategy matched by tag (`speaker:iyye`, `speaker:probe`) with `max_observations_per_scope: 0`: decided by tags the host set, not by a model. People's banks get an observations mission as a backstop (`OBSERVATIONS_MISSION`: durable knowledge from the person's own words, never about Iyye or its system). The `iyye-self` bank builds no observations at all.
- **Only durable entries of Iyye's own:** self-model changes, repository findings and investigation answers are transferred; machine findings (passing states) and day summaries stay in that day's short-term memory only.
- **Cleanup:** short-term memory keeps every past conversation's text, so the cleanest repair is a rebuild under the new rules: with the new host running and Iyye awake, `node scripts/memory-clear.ts --restage` deletes the banks and queues every past conversation; the next night (or `/sleep`) transfers them again. (No surgical prune: observations cannot be removed selectively, and Hindsight requeues facts for consolidation only when all of a bank's observations are cleared.)

### Follow-up (2026-10-06): recall that finds what matters

The owner noticed Telegram turns missing relevant long-term memory. Measured against the live banks: Jacob's bank held "Jacob is building Innsbruck airport (Roblox)", but "What does Jacob build in Roblox?" never got it, because the gateway merged banks in a fixed order (the owner's 5 weakest-or-not, 2 from `iyye-self`, 2 per contact in creation order, the owner's linked accounts first) and cut at 10. Separately, the reranker cannot know who "we" or "I" is: "Where do we live?" scored 0.01 against "The user resides in …", Jacob's "what was I building?" 0.0004 against his airport.

As built (`memory/gateway.ts`):
- **The query is rewritten for the reader** (`memoryQuery`): first-person words become "the user" (owner) or the contact's name, in English and Russian; a relation the owner stated (`/self relation Jacob my son`) adds the name when the question uses it. Measured: 0.01 → 0.99 and 0.0004 → 0.99.
- **Banks merge by relevance** (Hindsight's cross-encoder reranker score, now read as `LtmResult.score`): the reader's own bank gives its best 5; the owner's linked accounts their best 2 or strong matches; the bank of a person the question names its best 3 or strong matches; any other bank (other contacts, `iyye-self`) only strong matches (≥ 0.3). One list by score, duplicates once, 10 at most.
- **One failing bank no longer drops the others** (`allSettled`; logged).
- **What Iyye told someone is included**, labelled "your own earlier words, not evidence" (owner decision of the same day: those facts are kept for continuity), never as the person's statement; `includeIyye: false` leaves them out.
- Not done: recall under device load was not measured (each bank call has a 3 s limit; one slow bank now costs only its own items).

## 7. Configuration (planned)

| Name | Default | Meaning |
| --- | --- | --- |
| `IYYE2_MEMORY_ENABLED` | `1` | start the Hindsight service |
| `IYYE2_MEMORY_PORT` | `8186` | Hindsight API (127.0.0.1); 8888 is Hindsight's own default and more likely to collide |
| `IYYE2_MEMORY_DB_PORT` | `8185` | Iyye's PostgreSQL (127.0.0.1, TCP only) |
| `IYYE2_MEMORY_PASSTHROUGH_PORT` | `8187` | the lease-gated OpenAI-compatible pass-through |
| `IYYE2_MEMORY_MODEL` | `gemma-4-E4B` | initial memory model; `/use <model> memory` overrides it |
| `IYYE2_MEMORY_DIR` | `iyye_2/memory` | where `.venv` (Hindsight) and `pg` (PostgreSQL) are installed |
| `IYYE2_MEMORY_EMBEDDINGS_MODEL` / `IYYE2_MEMORY_RERANKER_MODEL` | `BAAI/bge-small-en-v1.5` / `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` (was `cross-encoder/ms-marco-MiniLM-L-6-v2` until 2026-11-08) | local models (§8.5) |
| `IYYE2_MEMORY_TEXT_LANGUAGE` | `english` | keyword-search dictionary (§8.5) |
| `IYYE2_SLEEP_WINDOW` | `02:00-06:00` | local rest window: the night's STM → LTM transfer and consolidation |
| `IYYE2_MEMORY_THINKING` | `1` | model reasoning on for night extraction |
| `IYYE2_MEMORY_RECALL_TOKENS` | `600` | per-turn recall budget |

## 8. Owner decisions (2026-10-02)

1. **Install approval: yes, for the L0 spike.** Hindsight goes into `iyye_2/memory/`, with its model files downloaded once.
2. **Owner access to contact memory: yes, as a read-only owner view.**
   - Owner-scope recall and owner `memory_search` may also query contact banks.
   - Results are labelled with whose bank they came from.
   - Contacts still see only their own bank, never the owner's or each other's.
   - Retention never writes across banks.
3. **What is retained: every answered turn by default.** That covers owner and contacts, user text plus Iyye's delivered reply. `/forget <contact>` removes a contact's memory.
4. **Database: (c), an external PostgreSQL** (decided 2026-10-02, after L0 found pg0 needs arm64 OpenSSL from `/opt/homebrew`). It is the conda-forge osx-arm64 **PostgreSQL 18.6 + pgvector 0.8.6**, installed with `conda create -p memory/pg` (no sudo, native arm64, 130 MB) and pinned in `memory/pg.lock`. pg0 is never used, and the spike's pg0 patch is not part of the product.
5. **Stored memory is English only** (decided 2026-10-02):
   - The embedder stays `BAAI/bge-small-en-v1.5` with the `english` keyword dictionary.
   - Hindsight is told to write every fact, observation and reflection in English (`HINDSIGHT_API_LLM_OUTPUT_LANGUAGE=English`), so a conversation in Russian is stored as English facts.
   - Recall still worked for Russian questions in L0, but L3 should check it again with this setting.
   - Changing language later means re-embedding and rebuilding indexes.

8. **Short-term memory is today only** (decided 2026-10-03). At the end of every completed night (`endDay`), today's unstored episodes leave STM for a **transfer backlog** (state `backlog`, migration 013): a queue of pending writes that is never recalled and is retried first by later nights. Entries are dropped (`failed`) after 3 attempts or 7 days, and the wake notice and `/memory` say so. Recall reads only today's STM plus LTM. "Today" means since the last completed night, so a night the owner interrupts does not end the day. `memory-clear --restage` queues old conversations in the backlog, not in STM. `/day`, `/night` and `/memory` show today's STM and the backlog separately.
7. **Chat history does not survive the night** (decided 2026-10-03). When a night completes, every conversation (owner, contacts, console) starts a fresh Pi session; memory carries the days. A night the owner interrupts keeps the history, because that night is still owed. Old transcript files stay on disk.
6. **Day/night memory, as in 1.x** (decided 2026-10-02): during the day chat recalls from STM and LTM; at night Iyye moves STM into LTM and clears STM. No generative memory work while awake. Defaults chosen by the implementer and open to change: STM holds turns, not extracted facts; rest window 02:00–06:00; contacts' messages wait until waking; owner input wakes Iyye.

## 9. After 0.002

0.003 grows 0.002's minimal sleep into full dreaming (HLD §8.3 phases 4–7: plan review, character, day summary) and adds Kev in shadow mode for memory salience.
