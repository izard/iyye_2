# Pinned dependencies

| Component | Pin | Notes |
| --- | --- | --- |
| Node | >= 22.19.0 (dev: 22.23) | Matches Pi's `engines`. Tests run `.ts` directly via Node type stripping. |
| better-sqlite3 | 13.0.3 | Ships prebuilt binaries; installs with `--ignore-scripts`. SQLite 3.53.4 in the darwin-arm64 build. |
| typebox | 1.3.27 | Same version Pi uses; tool parameter schemas. |
| postal-mime | 4.0.7 | MIME parsing of received mail (plan 0.015); no dependencies, MIT-0. The IMAP and SMTP clients are the host's own (`channels/email/`). |
| typescript / @types/node / @biomejs/biome | 7.0.2 / 22.19.19 / 2.3.5 | Same as the Pi clone's dev tooling. |
| `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` | 1.0.0 (exact) | Pi's own `@earendil-works/*` dependencies resolve to 1.0.0 in `package-lock.json`. Clone at `1c1e9c0ef` for source reading. Behaviour below. |
| llama.cpp `llama-server` | build 11362 (`926862e57`, 2026-10-02), `~/Downloads/llama.cpp/build_27/bin/` (previously build 9542, `6b80c74f2`, in `build_last6/`) | Router mode, behaviour below. Docs for an exact build: `git -C ~/Downloads/llama.cpp show <commit>:tools/server/README.md`. Re-probe with `node scripts/probe-router.ts <llama-server> --tools gemma-4-E4B` before switching builds. |

## Long-term memory (0.002)

| Component | Pin | Notes |
| --- | --- | --- |
| Hindsight (`hindsight-api`) | 1.2.0 (2026-11-06; the live host runs 0.10.2 until the owner switches, `memory/UPGRADE-1.2.0.md`) | uv venv, Python 3.11. 1.2.0 is installed in its own directory, `iyye_2/memory-1.2.0` (`.venv`, `pg` a link to `../memory/pg`), selected with `IYYE2_MEMORY_DIR`; 0.10.2 stays in `memory/.venv`. Dependency lists: `memory/requirements.lock` (macOS arm64) and `memory/requirements-linux-aarch64.lock` (the Spark; torch 2.14.1+cu130, sentence-transformers 6.1.0 and transformers 5.15.1 held at 0.10.2's versions; dateparser held at 1.4.3, since 1.5.0 breaks Hindsight's date analysis of every query naming a date or weekday); 0.10.2's Spark list is `memory/requirements-linux-aarch64-0.10.2.lock`. Clone at `v1.2.0` (`34a138684`). |
| PostgreSQL / pgvector | 18.6 (`hf773c0a_3`) / 0.8.6 (`h24b1a1f_0`), conda-forge osx-arm64 | `memory/pg`, explicit lock `memory/pg.lock`. Recreate with `conda create -p memory/pg --file memory/pg.lock`. On the Spark, `memory/pg-linux-aarch64.lock`. Unchanged by the 1.2.0 upgrade. |
| Embedder / reranker | `BAAI/bge-small-en-v1.5` / `cross-encoder/ms-marco-MiniLM-L-6-v2` | Downloaded by `scripts/provision-memory.ts` (it prints the revisions; record them here). Hindsight runs them on CPU: it declines MPS. |

Hindsight behaviour the host relies on (L0 spike, `memory/SPIKE.md`; every item checked again on 1.2.0 on 2026-11-06, `memory/UPGRADE-1.2.0.md`):
- It binds 0.0.0.0 unless `--host` is passed.
- It contacts the HF Hub at every start unless `HF_HUB_OFFLINE=1`.
- It masks DB credentials in its log.
- A SIGKILL leaves its database connections open, but Iyye's Postgres is owned separately.
- With auto-consolidation and sweeps off, it uses the model only when Iyye triggers retain or consolidate.
- `DELETE …/documents/{id}` also removes the observations derived from it.
- (L2) Per-operation `RETAIN_/CONSOLIDATION_/REFLECT_LLM_MAX_RETRIES` fall back to `HINDSIGHT_API_LLM_MAX_RETRIES`; its SDK client has `max_retries: 0`, so `LLM_MAX_RETRIES=1` really bounds calls.
- (L2) Its startup LLM verification failure is only a warning; `SKIP_LLM_VERIFICATION=true` skips it.
- (L2) A model-call failure during `retain` with `async:false` returns HTTP 500 `Fact extraction failed: …` and stores nothing.
- (L5) `GET …/documents/{id}` returns `memory_unit_count`; 0 means extraction kept nothing (`completed_empty`).
- (L5) `PUT /v1/default/banks/{id}` with `retain_mission` creates or updates a bank; `POST …/consolidate` returns `operation_id`; `GET …/operations/{id}` reports `pending|processing|completed|failed|cancelled|not_found`.
- (L5) A retain with an existing `document_id` replaces the document (`update_mode` default `replace`) and skips byte-identical content.
- (Provenance) Item `tags` are inherited by the extracted facts and by observations; with the default `combined` observation scope, consolidation keeps differently-tagged facts in separate observations. Recall returns `tags` and filters with `tags` + `tags_match` (`any` includes untagged).
- (Provenance) `PATCH …/banks/{id}/config` with `{"updates": {"retain_strategies": {...}}}` defines named strategies (bank config API on by default); an item's `strategy` selects one. `retain_extraction_mode: chunks` stores the text verbatim as one `world` unit with no LLM call. Strategies cannot be set by environment variable.
- (L3) Recall needs no model call: only the CPU embedder and reranker (about 0.1 s).
- (L2) llama.cpp 11362 honours `chat_template_kwargs.enable_thinking=false` per request for gemma-4-E4B: no `reasoning_content`.
- (1.2.0) Retain asks for `response_format: json_object` (no tools), `temperature` 0.1, `max_tokens` 64000, at `POST /v1/chat/completions` only. A reply that is JSON without a top-level `facts` list is now HTTP 500 (0.10.2 stored nothing and answered 200); `{"facts": []}` is still a 200 with 0 units, and prose was a 500 in both.
- (1.2.0) Consolidation answers one entry per new fact (no setting) and asks again, one by one, about every fact a batch left unplaced, which includes every fact in a scope capped at 0 (Iyye's own). The heaviest live night (85 facts, 71 Iyye's) took 176 s on 0.10.2 and 630 s on 1.2.0, so the night waits up to 1,800 s. In Hindsight's own turn extraction it also handled a correction worse (kept the stale value); the live `ledger` mode never recalls those observations.
- (1.2.0) `GET …/documents?q=` also matches document text and stops at 1000 matches (`total` is then a lower bound, `total_is_estimate`): never page on a `q` search (the orphan check lists every document).
- (1.2.0) `HINDSIGHT_API_LLM_TRACE_ENABLED=false` also covers the embedding, reranker and decision-model calls that 1.1 added to the request history (one recorder). The default reranker is the hosted `hs-rerank-1` and the decision model `none`: Iyye sets the local reranker and embedder explicitly. The audit log stays off by default. A timestamp with no UTC offset is read in `HINDSIGHT_API_DEFAULT_TIMEZONE` (UTC); Iyye always sends `Z`.
- (1.2.0) The migrations from 0.10.2 (six, one of them on `memory_units`) ran in under a second on a copy of the live data, and the first start was healthy after 14 s (MemoryService waits 180 s). They cannot be undone: going back needs the copy of `pgdata` from before. 0.10.2 starts on a database 1.2.0 migrated without refusing, so `MemoryService` refuses an installed version older than the newest one recorded in `<state>/memory/hindsight_version`.

## Pi request details the host relies on (2026-10-03 incident)

- Pi sends no output cap unless asked; the host passes `max_tokens` through the model's `samplingParams`, which are assigned last to every request body.
- `enable_thinking` is sent only for models declared `reasoning: true`. With `thinkingFormat: "chat-template"` and literal `chatTemplateKwargs` it is sent as given, and `supportsDeveloperRole: false` keeps the system prompt as role `system`, not `developer`.
- `isRecoverableLength`: `length` with output below the model's `maxTokens` is treated as context overflow, and Pi compacts and retries once.
- The default compaction `reserveTokens` is 16,384, so a 16k slot left no room; with `np = 1` the window is 65,536.
- **Timeouts:** Pi uses `httpIdleTimeoutMs` as the whole request's timeout (0 means about 24 days). llama.cpp's router proxy uses `--timeout` (default 3600 s) for reads and writes to the model servers, and model servers take `timeout` from the preset.
- qwen3.8-27b-tak's template honours `chat_template_kwargs.enable_thinking` (off: no `reasoning_content`).

## Local decisions (0.003)

| Component | Pin | Notes |
| --- | --- | --- |
| Kev | clone `kev/` @ `84847f0` | `uv sync --frozen --extra serve --python 3.13` (lockfile untouched); Python 3.13.15, mlx-lm 0.31.3, transformers 5.17.0, torch 2.8.0, in `kev/.venv` |
| Checkpoint | `jaredpalmer/kev-4b@6cfce5c2fa4b4bd64026336ab649c5ca78857d52` | LoRA r16, temperature 2.41; base `Qwen/Qwen3.5-4B-Base@1001bb4d826a52d1f399e183466143f4da7b741b`; 8.8 GB in `~/.iyye2/decisions/hf`, fetched by `scripts/provision-decisions.ts` |

Kev behaviour the host relies on (K0 spike, `decision-worker/SPIKE.md`):
- `--run repo@revision` pins the checkpoint; the base is pinned by the checkpoint's own `head.pt` (`base_revision`). `GET /v1/models` reports `run` exactly as requested.
- `KEV_API_KEY` guards only `/v1/*`; `/docs` and `/openapi.json` stay open (no data). CORS allows any origin, but no browser page holds the key. It binds 127.0.0.1 by default.
- On Apple Silicon it serves through MLX (bf16): 7–8 s load offline, 15.9 GB peak during the LoRA merge, about 9–10 GB resident.

## Web (0.004)

| Component | Pin | Notes |
| --- | --- | --- |
| SearXNG | clone `web/searxng` @ `19ffbcd30686e4008392e93de164200510dfb9d8` (2026-10-02) | not on PyPI; runs from the source tree with `PYTHONPATH`; requirements in `web/.venv` (Python 3.13.15), pinned in `web/searxng-requirements.lock` (flask 3.1.3, granian 2.8.3, …) |

SearXNG behaviour the host relies on (T0 spike, `web/SPIKE.md`):
- `SEARXNG_SETTINGS_PATH` selects the settings, and `use_default_settings.engines.keep_only` plus per-engine `disabled: false` selects the engines. `/healthz` answers `OK`, and `/config` reports `instance_name` and the loaded engines.
- Served by `granian --interface wsgi … searx.webapp:app --host --port`; granian renames its process to `granian wsgi <host>:<port> searx.webapp:app`.
- **Engines are scraped and change.** On 2026-10-03 Yandex, Yahoo, Yep, Fireball and Bing worked from this machine. DuckDuckGo and Qwant were behind CAPTCHAs, Google, Brave, PrivacyWall and Tusksearch suspended the instance, and Startpage and Mojeek are inactive upstream. Re-test with the spike's per-engine probe after an upgrade.
- The MediaWiki API (`/w/api.php`, `list=search`, `prop=extracts`) needs no key; Iyye sends a descriptive User-Agent.

## Known audit finding

`npm audit` reports a high-severity `brace-expansion` (DoS on crafted brace patterns) inside `@earendil-works/pi-coding-agent`'s own pinned dependency tree (via `minimatch`). It is not fixed locally, because `npm audit fix` would override Pi's pins. Pi's glob-using file tools are disabled for every Iyye session (plan M3, `noTools`). Revisit when Pi is upgraded.

## llama.cpp router behaviour (probed 2026-10-02 on builds 9542 and 11362)

Probed with MiniCPM5-2B, qwen3.5-4b and a non-GGUF file; build 11362 re-probed with `scripts/probe-router.ts`. The host code relies on each point, and each held on both builds unless noted:

- **Endpoints:** `GET /health`, `GET /models`, `POST /models/load`, `POST /models/unload`. Build 9542 had no `/models/sse`, so the host polls `GET /models`. Build 11362 adds `/models/sse` (the host does not use it, and polling still works).
- **New in 11362, unused by the host:**
  - `POST /models` downloads a model from Hugging Face into `LLAMA_CACHE`, which the host points at an empty folder in the state dir.
  - `DELETE /models?model=` removes a cached model. Per the docs it cannot delete preset models.
  - The router has no API key, so any local process could trigger a download. The host never calls either endpoint.
- **Model list:** `GET /models` lists every preset section. Build 9542 also listed a `default` id; 11362 does not. The host ignores ids that are not in its registry either way.
- **Asynchronous load and unload:** the POST returns `{"success":true}` at once.
  - Load: status `unloaded → loading → loaded`. On 9542 that took about 13 s for MiniCPM5-2B and about 6 s for gemma-4-E4B; on 11362, 0.8 s and 5 s.
  - Unload: `loaded → unloaded` within about 1 s.
- **Failed load:** status `unloaded` with `"failed": true, "exit_code": 1`, about 1–15 s after the POST.
- **Errors:**
  - load of a loaded or loading model → 400 "model is already running";
  - unload of an unloaded model → 400 "model is not running";
  - load of an unknown id → 404;
  - chat with an unloaded model → 400 "model is not loaded"; it fails fast, with no autoload under `--no-models-autoload`.
- **`--models-max N` evicts silently (still true in 11362).** With `--models-max 1`, loading a second model unloaded the first, and a load that then failed had already evicted the loaded model. The host therefore runs the router with `--models-max 0` and enforces its own cap by refusing.
- **Lifecycle:** model processes exit when the router gets SIGTERM, and also when it gets SIGKILL. Stopping can take more than 10 s while a model is mid-load, so the host waits 30 s before SIGKILL.
- **Preset keys:** `c` and `np` short forms, `model`, and the preset-only `stop-timeout` are accepted. Model processes inherit the router's environment, so the host passes only PATH, HOME and an empty `LLAMA_CACHE`.
- **Memory accounting (macOS):** on 2026-10-02 the `vm_stat` reclaimable figure (free + inactive + speculative) was 49.4 GB before loading gemma-4-E4B, 46.7 GB after (model process RSS 8.9 GB) and 49.3 GB after stopping. Mapped weights mostly still count as reclaimable, so the host subtracts each loaded model's registry `ram_required_gb` as well.
- **Readiness:** a reasoning model answering `max_tokens: 1` returns empty `content` with text in `reasoning_content`, and `finish_reason: length` on 11362. Readiness is HTTP 200 plus a `choices` entry.

## Pi 1.0.0 behaviour the host relies on (checked 2026-10-02)

- `ModelRuntime.create` always registers Pi's built-in hosted providers. Their auth can come from environment variables (`getProviderEnvValue` reads `process.env`) and from ambient files. Hence `lockToLocalProvider` in `src/integration/pi/runtime.ts`; `test/pi.test.ts` asserts it with `OPENAI_API_KEY` set.
- `PI_OFFLINE` is read once inside `ModelRuntime.create` to disable catalog network refresh.
- With a custom `ResourceLoader`, `getSystemPrompt()` replaces Pi's coding-agent preamble, but Pi still appends a `<cwd>` section. The host therefore uses cwd `/`.
- The system prompt is captured when the session is built, not per turn. A changed contact view reopens the session.
- `agent_settled` is emitted inside the run's `finally`, before `prompt()` resolves.
- `prompt()` mid-run throws unless `streamingBehavior` is given. The host never does this, because turns are serialized per scope.
- **Tool calling:** llama.cpp builds 9542 (gemma-4-E4B and gemma-4-26B) and 11362 (gemma-4-E4B) return OpenAI `tool_calls`, including two in parallel with `{}` arguments, and answers from `role: tool` results. Pi's `openai-completions` handles the streamed `tool_calls` deltas.
- `openai-completions` sends `stream: true`, `stream_options.include_usage`, `store` and `max_completion_tokens`. llama.cpp build 9542 accepted all of them in the gemma-4-E4B smoke test.

On a Pi upgrade, the conformance test "ModelRuntime's methods are the ones lockToLocalProvider was written against" (`test/pi.test.ts`) fails if `ModelRuntime` gained or lost a method. Check any new inference entry point and add it to `GUARDED_METHODS` before updating the expected list.
