# Iyye 2.0.001 — Implementation Plan

- Status (2026-10-02): M0–M7 and M3b (read-only tools) are implemented in `host/` (144 tests, plus manual smoke tests against the real router with gemma-4-E4B). Telegram receiving and sending are tested against an in-process fake Bot API only; the first live run is the owner's. **M8 closed on 2026-10-07** after six days of real use (`host/NOTES-0.001.md`): 0.001 is complete.
- Scope: the first runnable increment of Iyye 2.0. Three things:
  - **Local model management:** start and stop local models, and select which one answers.
  - **Two input channels:** the owner's local web chat and Telegram, with every message admitted durably.
  - **Replies:** an embedded Pi session on a local model answers, and the reply goes out through an exact-route outbox with receipts.
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md). Section references (§) point there.
- Legacy reference (`iyye_legacy/`, 1.0.9 snippets):
  - `telegram_sensor.py`, `telegram_actuator.py`, `web_chat_actuator.py`, `tts_actuator.py`, `user_chat_stream.py`
  - `tools/`: llama.cpp start/stop/status scripts and `llm-registry.json`
  - `prompts/`: prompt templates, see §7
  - the 1.x web UI `../web_chat_2.py`

## 1. Goal and non-goals

**0.001 delivers:** a resident TypeScript host that

1. owns one local llama.cpp router, loads and unloads models on the owner's command, and selects a model per channel, all deterministically,
2. accepts owner messages from an authenticated local web chat and contact messages from Telegram,
3. admits each one exactly once into SQLite as an `event` bound to an authenticated principal and scope,
4. runs a per-contact Pi session (local model only, persistent across restarts) to produce a reply,
5. delivers the reply only to the exact route it came from, recording an `action` and a `receipt`,
6. survives a crash at any point without losing an admitted message or blindly re-sending a reply.

**Explicitly out of 0.001** (each has a later increment, §10):
- Hindsight memory and Kev decision models.
- Character/identity revisions beyond a static `identity.md`.
- Sleep/wake modes and adenosine.
- Plans and commitments, and initiative/curiosity.
- Tools beyond the read-only probes of M3b, including Pi's built-in bash/edit/write.
- Automatic model routing (quality scores, measured throughput, QoS escalation, eviction scoring).
- Telegram groups, TTS/speech/camera/vision, and import of 1.x data (1.x is retired, HLD §16).

### 1.1 Deviation from HLD §14 ordering

The HLD's Stage 0 validates Pi, Hindsight and Kev together before Stage 1 builds channels. The owner has chosen to build the **model and channel foundation first**: every later stage depends on it, and it carries the most hard-won 1.x lessons. 0.001 is therefore a Pi-only slice of Stage 0 plus the Stage 1 channel/outbox subset. The Hindsight and Kev Stage 0 spikes move to 0.002 and 0.003. HLD §14 carries a note recording this.

## 2. Operational constraints (must hold before first run)

- **1.x is retired** (owner decision, 2026-10-02): it is not running and never will, so 2.0 shares nothing with a live 1.x. It uses the same Telegram bot, read from the existing `TELEGRAM_BOT_TOKEN`.
- **One poller per bot.** Two pollers on one token steal each other's updates. The host lock (one host per state directory) covers this for 2.0. Don't point a second 2.0 state directory at the same bot.
- **Other processes still share the machine.** On 2026-10-02 a manually started MiniCPM5-2B llama-server was listening on `:8085` and whisper on `:8081`. 2.0's router uses its own port (default `127.0.0.1:8180`), and the host refuses a load that free RAM can't hold (M2).
- **Web port.** 0.001 defaults to `127.0.0.1:5100`.
- **Local-only inference.** The only model endpoint reachable by the host is its own llama.cpp router. No hosted provider may be resolvable, as a default or as a fallback (§2.2, §9.3).
- **Runtime.**
  - Node ≥ 22.19, per Pi's `engines`; 22.23 is installed.
  - llama.cpp: `~/Downloads/llama.cpp/build_27/bin/llama-server` (build 11362, `926862e57`, updated by the owner on 2026-10-02; previously build 9542 in `build_last6/`). Its router mode was probed on 2026-10-02; the observed behaviour is recorded in `host/PINS.md`.
  - Upstream clones (`pi/`, `hindsight/`, `kev/`) are never modified or committed into. The host is its own package.

## 3. Repository layout for 0.001

Subset of HLD §12.1:

```text
iyye_2/
  host/
    package.json            # depends on @earendil-works/pi-coding-agent (pinned, see M0)
    tsconfig.json
    src/
      main.ts               # process entry: config, migrations, recovery, router, adapters
      config.ts             # typed config from environment variables (as built: no iyye.local.json yet)
      state/
        db.ts               # SQLite open, WAL, migrations runner
        migrations/001_init.sql
        events.ts  jobs.ts  contacts.ts  cursors.ts  models.ts   # actions.ts arrives with M6
      models/
        registry.ts         # load + validate config/models.json
        preset.ts           # registry → llama.cpp preset INI
        router.ts           # spawn/stop/health of the one router child process
        manager.ts          # load/unload/select, RAM admission, busy tracking
      kernel/
        admission.ts        # principal/scope resolution, dedup, event insert
        scheduler.ts        # per-scope FIFO, one inference at a time, job leases
        commands.ts         # deterministic owner commands (/models, /load, /use, /trust …)
        recovery.ts         # startup reconciliation of jobs/actions/router
      integration/pi/
        runtime.ts          # locked-down ModelRuntime + settings + resource loader
        sessions.ts         # one persistent Pi session per scope
        turn.ts             # prompt/followUp, agent_settled → final text
      channels/
        types.ts            # ChannelAdapter, InboundEnvelope, SendResult
        web/server.ts  web/auth.ts  web/ui.html
        telegram/poller.ts  telegram/sender.ts  telegram/api.ts
      outbox/
        outbox.ts           # action state machine + dispatcher
  config/
    identity.md             # static owner-written identity (§4.1); no revisions yet
    models.json             # Iyye model registry (M2), seeded from iyye_legacy/tools/llm-registry.json
  evals/0.001/              # acceptance tests (§9)
  iyye_2_0_001_plan.md
```

Live state lives in `IYYE2_STATE_DIR` (default `~/.iyye2/`), outside source control. It holds the SQLite file, Pi sessions, the owner token, the Telegram offset, the generated preset INI, the router pid and the router log.

## 4. Milestones

Each milestone ends with tests that run without a real model, a real router, or the real Telegram API. Tests use:
- Pi's faux provider (`registerFauxProvider` from `@earendil-works/pi-ai/compat`, as used in `pi/packages/coding-agent/test/suite/harness.ts`),
- a fake llama.cpp router HTTP server,
- a fake Telegram Bot API HTTP server.

### M0 — Host skeleton and pinning

- Create `host/` as a TypeScript ESM package. Use erasable-only TS syntax, matching Pi's convention.
- Pin Pi: depend on the published `@earendil-works/pi-coding-agent@1.0.0`.
  - Record the matching clone commit (`pi` @ `1c1e9c0ef`) in `host/PINS.md` for source reading.
  - Use a `file:` link only if a needed API is unpublished. That would be the first entry in the core-patch list (§2.3).
- Record the llama.cpp binary path and version in `PINS.md` too.
- SQLite: use `better-sqlite3`, pinned. `node:sqlite` still emits an ExperimentalWarning on Node 22.
- Test runner: `node --test` or vitest, chosen once here.

Exit: `npm run check` (tsc + lint) is clean, and an empty host starts and stops.

*(As built)* `src/main.ts` also holds a host lock (`host.lock`, one host per state directory) and a temporary owner console on the host's own terminal for model commands only, which goes away when the M4 web chat carries them. `test/main.test.ts` covers start → ready → SIGTERM → exit 0 with the router gone.

### M1 — Control state and admission

Migration `001_init.sql` creates the HLD §3.1 records that 0.001 needs. It uses the HLD field names so later increments extend rather than rename them:

| Table | 0.001 fields |
| --- | --- |
| `contacts` | id, display_name, kind (`owner` \| `contact`), created_at |
| `channel_bindings` | contact_id, channel (`web` \| `telegram`), external_id (Telegram user_id), verified_by (`owner_local` \| `first_contact`), created_at |
| `events` | id, dedup_key UNIQUE, channel, external_ref (update_id), principal_contact_id, scope, observed_at, received_at, payload_json, status (`admitted` \| `answered` \| `dropped`), drop_reason. Dropped events have a NULL principal and scope and no job |
| `jobs` | id, trigger_event_id, scope, model_name, status (`queued` \| `running` \| `settled` \| `failed`), lease_until, attempt, created_at, settled_at |
| `actions` | id, job_id, event_id, kind (`reply` \| `failure_notice` \| `status`), route_json (exact destination), content_hash, idempotency_key UNIQUE, state, attempts, created_at |
| `receipts` | action_id, chunk_index, adapter, level, provider_ref, acknowledged_at, outcome, error |
| `channel_cursors` | channel PRIMARY KEY, cursor (Telegram offset), updated_at |
| `model_selection` | channel PRIMARY KEY (`web` \| `telegram`), model_name, set_by, set_at |
| `model_ops` | id, op (`load` \| `unload` \| `router_start` \| `router_stop`), model_name, requested_by, state, error, started_at, finished_at |

Admission (`kernel/admission.ts`) is deterministic and uses no LLM:

- **Principal from the authenticated transport, never from content.**
  - Web chat principal = owner, and only after the web auth check (M4).
  - Telegram principal = the contact bound to `from.id`. A first message from an unknown Telegram user creates an untrusted `contact` with `verified_by = first_contact`.
  - Nothing in message text can change a principal, binding or trust.
- **Scope** = `owner` for the owner, `contact:<id>` for a contact. Scope selects the Pi session (M3) and later the Hindsight bank.
- **Exactly-once admission:** `INSERT … ON CONFLICT(dedup_key) DO NOTHING`.
  - dedup_key is `telegram:<update_id>` or `web:<client_msg_id>`.
  - The insert and its job creation happen in one transaction.

Exit: unit tests for dedup, principal resolution, and the rule that a Telegram message claiming to be the owner still resolves to the Telegram contact.

### M2 — Local model management

This replaces the 1.x per-model shell scripts with **one llama.cpp router process owned by the host**. Pi's own llama.cpp support is built for the same router (`pi/packages/coding-agent/docs/llama-cpp.md`, `src/extensions/llama/`). Model lifecycle is a kernel concern (self-preservation, resource admission §9.3), so the host drives the router API directly rather than loading Pi's interactive `/llama` extension.

**Registry** (`config/models.json`, `models/registry.ts`):
- Seeded from `iyye_legacy/tools/llm-registry.json`.
- Keep per model: `name`, `file` (absolute path to the GGUF), `ram_required_gb`, `startup_s`, `roles`, a free-form `description`, and `server_args`.
- `server_args` absorbs what each legacy `llm-*.sh` passed to `llm_start`:
  - gemma-4-26B: `reasoning = off`
  - gpt-oss-120b, Qwen3-Coder, Qwen3.5-122B, devstral: `c = 32768`
  - GLM-4.7: `c = 16384`
  - all models (legacy common): `repeat-penalty = 1.2`, `c = 65536`; `np` was 4, and is 1 since 2026-10-03: the host runs one inference at a time, so each conversation gets the whole 65,536 tokens instead of 16,384
- Legacy fields that are deliberately not kept, because they belong to the 1.x router that HLD §16 says not to port: per-model `port`, `script`, `quality` scores, `default_for`, and `prefill_tps`/`decode_tps`.
- Validation on startup:
  - unknown keys are rejected,
  - a missing GGUF file marks that model `unavailable` (shown, not fatal),
  - a duplicate name is fatal.

*(Registry update, 2026-10-02)* 12 models found in `~/Downloads/llama.cpp/models` were added:
- **Verified on llama.cpp 11362**, each loaded alone, answered, and was checked for OpenAI tool calls. `ram_required_gb` is the measured resident size at the default 64k context, plus about 1–2 GB of margin:
  - all Gemma-4, Qwen3.8, Qwen3.5-4B, MiniCPM5 and Muse-Glimmer models, which all make tool calls;
  - gorilla-openfunctions-v2, which answers but makes no tool calls.
- **Not load-tested:** AntAngelMed, at 84.5 GB, has an estimated figure.
- **Left out:**
  - `Ternary-Bonsai-2-27B-PQ2_0.gguf`: this build cannot load it (exit 1), and the PQ2_0 quantization is unknown to llama.cpp's GGUF reader;
  - `llava-llama-3-8b-v1_1-mmproj-f16.gguf`: a vision projector, not a model;
  - `gemma/gemma-7b-q8.gguf`: no chat template, and the metadata looks like a broken conversion.
- **Corrected:** gemma-4-31B (QAT) was registered at 18 GB but measured 25.7 GB resident, so it is now 27 GB.

**Router process** (`models/preset.ts`, `models/router.ts`):
- Generate `IYYE2_STATE_DIR/models.ini` from the registry: global `[*]` defaults plus one section per model with an absolute `model = …` path and its `server_args`.
- Spawn exactly one child: `llama-server --models-preset <ini> --no-models-autoload --models-max 0 --host 127.0.0.1 --port <IYYE2_ROUTER_PORT>`.
  - No `--models-dir`, so stray GGUFs never appear as selectable models.
  - `--no-models-autoload` means a request naming an unloaded model fails fast instead of silently triggering a 30–90 s load or an OOM. Never hide model-load latency (§9.3).
  - *(As built)* `--models-max 0` (no router cap). The probe showed that with a cap the router silently evicts a loaded model to make room, even for a load that then fails. The host enforces `IYYE2_MODELS_MAX` (default 2) itself and refuses instead.
- The pid file and log live in `IYYE2_STATE_DIR`, one log per router run, rotated.
- **Stop kills only the PID this host spawned**, with SIGTERM, then SIGKILL after `stop-timeout`. Nothing is ever killed by port. The legacy `lsof`-based stray kill could SIGKILL the Iyye process itself.
- If the port is already taken at start, fail visibly and name the listening process. Don't kill it.
- On host restart: if the recorded pid is alive and is a `llama-server` serving our preset, adopt it. Otherwise start fresh.

**Manager** (`models/manager.ts`). All operations are deterministic. Each is recorded in `model_ops` and shown in the owner UI.
- **load(name):**
  - Refused if the model is unknown or unavailable.
  - Refused if `ram_required_gb` exceeds free RAM, or if `IYYE2_MODELS_MAX` models are already loaded, with a message naming what would need unloading. There is **no automatic eviction**.
  - *(As built)* "Free RAM" on macOS is free + inactive + speculative pages from `vm_stat`. `os.freemem()` reported 1.8 GB on the owner's 128 GB machine, where about 50 GB was reclaimable. That figure under-reports loaded models, because llama.cpp maps weights from the file: loading gemma-4-E4B (8.9 GB resident) lowered it by only 2.7 GB. The check therefore also subtracts the registry `ram_required_gb` of every loaded model.
  - Otherwise `POST /models/load`, then poll `GET /models` until loaded, failed, or `max(startup_s × 3, 60 s)`. Build 9542 had no `/models/sse`; 11362 has one, but polling is kept.
  - The op is `done` only when the model reports `loaded` and a 1-token completion returns HTTP 200 with a `choices` entry. The content may be empty, because reasoning models put the first tokens in `reasoning_content`.
- **unload(name):**
  - Refused while any running job uses that model.
  - Otherwise `POST /models/unload`. If the model is a channel's current selection, that channel shows "no model loaded".
- **select(channel, name):**
  - Sets `model_selection` for `web` or `telegram`. The model must be loaded.
  - Takes effect at the **next job boundary**. *(As built)* Admission leaves `jobs.model_name` empty, and the scheduler (M7) binds the channel's selection when the job starts and takes a lease on it. A queued job therefore never waits on a model that was swapped out after admission, and a running job keeps its lease.
- **Startup:** start the router, then load each channel's selected model, defaulting to `IYYE2_DEFAULT_MODEL`, if it fits. If it doesn't, the host still comes up. Messages queue, and the UI says why.
- **Job admission:** a job whose channel model isn't loaded waits (status `queued`, reason shown) or fails explicitly after a bound. It never falls back silently to another model.
- **Health:** a cheap `GET /models` check every 30 s.
  - If the router dies, it restarts with backoff. The selected models are reloaded and all of it is journaled to `model_ops`.
  - *(As built in M2)* All leases are invalidated and `onRouterLost` listeners are told which models were lost.
  - *(M7)* A job running when the router died is `failed` (its Pi turn aborted). It is not retried blindly. A job with no action yet goes back to `queued` once.

**Owner control.** These are handled by the host, not by Pi:
- web-chat commands `/models` (list with status, RAM, selection), `/load <name>`, `/unload <name>`, `/use <name> [web|telegram]`, `/router restart`;
- a models panel in the web UI that calls the same functions.

Telegram can never reach these. Legacy `prompts/actions/llm.md` let trusted Telegram contacts start or stop models; 2.0 drops that.

**Verified against the installed build (2026-10-02, details in `host/PINS.md`):**
- `GET /models`, `POST /models/load` and `POST /models/unload` work. Load and unload are asynchronous.
- Status values `loaded`/`unloaded`/`loading`, plus `failed`/`exit_code` on a failed load.
- Preset keys `stop-timeout`, `c` and `np` work.
- There is no `/models/sse`.
- The router also lists a `default` id, which the host ignores.
- Model processes exit when the router exits, even on SIGKILL.

Exit: fake-router tests for:
- the INI generated from the registry matches a golden file;
- load refused when RAM is insufficient;
- unload refused while busy;
- select takes effect on the next job, not the running one;
- the router crashing invalidates leases, restarts the router and reloads the selected models (failing the job itself is M7);
- stop never signals a pid it didn't spawn.

Plus one manual smoke test against the real router with `gemma-4-E4B`. The plan's other candidate, `qwen35-9b`, is not on disk. *(Done 2026-10-02: loaded in ~6 s; after a host SIGKILL the restarted host adopted the router without reloading; SIGTERM left no llama process and freed the port.)*

### M3 — Locked-down Pi integration

`integration/pi/runtime.ts` overrides every default that `createAgentSession()` would otherwise pick up from the user's environment:

- **Model:**
  - An explicit `ModelRuntime` with one provider: `openai-completions` at the router URL (`http://127.0.0.1:<IYYE2_ROUTER_PORT>/v1`).
  - Its models are the registry names; the router routes on the request's `model` field.
  - No `auth.json`, no `~/.pi` settings, no env-var provider keys.
  - *(Superseded as built)* The original plan had a startup assertion that no other provider can be resolved. That cannot hold, because Pi lists hosted models as available whenever their keys are in the environment. The lock described next is the enforcement, and the available-models list is not evidence either way.
  - *(As built)* Pi 1.0.0 always registers its built-in hosted providers, and their credentials can come from environment variables or ambient files such as `~/.aws` and gcloud ADC, so an empty credential store is not enough. Enforcement is `lockToLocalProvider`: every inference method of the runtime instance (`stream`, `complete`, `streamSimple`, `completeSimple`, deferred, image and classifier calls) throws `LocalOnlyViolation` for a model whose provider is not `iyye-local`. Pi's catalog network refresh is also off (`PI_OFFLINE`, no refresh on create). Each model's context window is the router's per-slot context, `c / np`.
- **Per-job model:** at job start, the job's `model_name` (the channel selection bound by the scheduler at job start, M2/M7) is applied with `session.setModel(...)` if it differs from the session's current model. Pi records the change in the transcript. The call is made with `persist: false` so no global defaults are written.
- **Settings:** in-memory `SettingsManager` built from Iyye config. *(As built)* Telemetry and analytics are off, cache warming is off (no hidden extra requests), and Pi's own retries are off, so the kernel decides retries. The HTTP idle timeout is 10 min, because a slow local answer beats a timed-out one.
- **Resources:**
  - A custom `ResourceLoader` with no extensions, skills, prompt templates or context files, so no `AGENTS.md`/`CLAUDE.md` discovery.
  - The system prompt is composed by Iyye: `config/identity.md` + the channel/contact view + a short operating note ("you have no tools; do not promise future actions"). *(As built: `OPERATING_NOTE` in `integration/pi/prompt.ts`, kept out of the owner's identity file.)*
- **Tools:** `noTools` for every session in 0.001. Owner tools arrive later through the broker (§9.1).
- **cwd:** *(as built)* `/`. Pi writes the cwd into every system prompt, and a state-directory path would show the owner's home folder (username) to Telegram contacts. With no tools and no resource discovery, Pi never touches it. `agentDir` is an empty `IYYE2_STATE_DIR/pi-agent`, so no default falls back to `~/.pi`.
- **Identity:** *(as built)* `config/identity.md` is a first draft written to HLD §1 (no invented experiences or feelings; only promise what you can do). The owner should revise it. Contact display names enter the prompt quoted, single-line and at most 64 characters, because the sender chooses them.

`sessions.ts`:
- One persistent session per scope via `SessionManager.create`/`open` under `IYYE2_STATE_DIR/sessions/<scope>/`.
- The scope → session-file mapping is stored in SQLite, so restart reopens the same conversation (§6.2: session ID is evidence, not a new memory bank).
- Keep up to N live sessions and dispose idle ones; they reopen from file.

`turn.ts`:
- *(As built, changed from the original plan)* Turns in one scope run strictly one after another (a per-scope queue in `PiConversations`), always with `prompt()`. The original plan used `followUp()` for a message that arrives mid-run. But Pi then answers both messages in one run, so it is ambiguous which reply belongs to which job, and the outbox needs exactly one reply per job.
- `prompt()` is called with `expandPromptTemplates: false`, so `/…` and skill syntax in message text are data, never Pi commands.
- Wait for `agent_settled` before deciding Pi is finished, not `agent_end` (§12.1). Pi 1.0.0 emits it before `prompt()` resolves.
- The reply is the text of the final assistant `message_end`. Partial text is never sent.
- Cancellation goes through `abort()`. A job whose lease expired or whose session was aborted cannot commit its result.

Exit: tests for:
- a single turn;
- two messages in one scope at once (they queue, and each gets its own reply);
- restart continuity (same scope reopens the same transcript);
- a model switch between turns recorded in the transcript;
- an empty reply (no reply action; job `failed`);
- *(added)* a reply cut off at the token limit (`stopReason: length`) fails as `truncated`. Only `stopReason: stop` counts as a reply.

*(As built)* These run against the fake router speaking streaming OpenAI chat completions, not Pi's faux provider. That exercises Pi's real `openai-completions` path and the local-only lock end to end. `test/pi.test.ts` also covers:
- scope isolation;
- abort;
- model errors and an unloaded model;
- refusal of a non-registry model;
- the hosted-provider lock with `OPENAI_API_KEY` set;
- the absence of host paths in the prompt.

Real-router smoke test (gemma-4-E4B): replies took 0.4–1 s; the model recalled a fact within the session and after reopening it; it declined a reminder it cannot set. The host terminal console now also chats, in its own `owner-console` scope with no outbox (temporary until M4/M7).

### M3b — Read-only tools (added at the owner's request)

Without tools Iyye could not even tell the time or report free disk space, so a narrow slice of the HLD §9.1 broker moved forward from 0.004.

- **Tools** (`src/tools/probes.ts`): typed, argument-free, read-only.
  - `current_time`, for everyone: local date, weekday, time, timezone and offset, plus ISO time.
  - `system_status`, owner only: free disk on the home-folder volume (the path is not revealed), reclaimable memory, uptime, CPU load, loaded models.
- **Broker** (`src/tools/broker.ts`):
  - Tools are granted per session from the trusted principal (owner or contact), so a contact's session never sees owner tools.
  - Every call is authorized again when it runs.
  - At most 8 calls per turn; later calls are refused, so a tool loop ends.
  - Results are capped at 4000 characters.
  - Every call, refusal and failure is recorded in `tool_calls` (migration 003).
- **Pi wiring:** tools are passed as `customTools` and enabled by exact name, so Pi's built-in tools stay off.
- **Prompt:** the prompt's operating note lists the granted tools ("use them instead of guessing") and still says Iyye cannot schedule or act outside the conversation.
- **Verified on the real router (2026-10-02):** gemma-4-E4B and gemma-4-26B both made correct parallel calls to `current_time` and `system_status`, and 26B answered correctly from the results. Through the host, the owner got the time and disk space, and a Telegram-contact scope got the time but no disk details, with the refusal coming from the model having no such tool.
- The rest of the broker (constrained compute, HTTP reads, effects through the outbox) remains 0.004.

### M4 — Owner web chat channel

Behaviour from `../web_chat_2.py` (POST a message, poll history) is reimplemented with authentication and message identity.

- Bind to `127.0.0.1:<IYYE2_WEB_PORT>`. Binding to localhost alone does not prove the sender is the owner (§9.2), so all of the following are also required:
  - **Owner token:** generated on first start (32 random bytes) and stored at `IYYE2_STATE_DIR/owner_token` with mode 0600. It is printed once to the terminal as a login URL. Exchanging it gives an HttpOnly, SameSite=Strict session cookie.
  - **Origin/Host checks:** reject requests whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>` (DNS rebinding), and any state-changing request whose `Origin` doesn't match.
  - **CSRF:** a per-session token on every POST.
- `POST /api/messages {client_msg_id, text}` → admission (or `kernel/commands.ts` for `/…` commands) → `202 {event_id}`. A retried POST with the same `client_msg_id` is deduplicated.
- `GET /api/stream` (SSE) or `GET /api/messages?after=<seq>` (poll) returns user messages and Iyye replies with their action IDs and states.
- `GET/POST /api/models` backs the models panel (M2).
- **Receipt strength:**
  - A web receipt means "persisted to the owner transcript and enqueued for the UI", which is weaker than client acknowledgement. It is recorded as level `ui_enqueued` (§7.3).
  - An optional `POST /api/ack {action_id}` upgrades it to `client_ack`.
- **Status banner:**
  - Shows: host up, router up/down, model per channel (loaded/loading/unloaded/unavailable), and Telegram enabled/disabled/failed.
  - Status is shown honestly. A disabled or failed component is never shown as healthy (1.x lesson: a declined sensor hid as healthy for five days).
  - "starting sleep" / "waking up day N" are deferred with modes (0.002+).

*(As built)* M4 could not meet its own exit test ("a reply visible with its action ID") without something that answers admitted messages, so it includes the web-only slice of M6 and M7, built as the skeleton those milestones extend:
- **`outbox/outbox.ts`:** the full write order is in place. The action is committed (`queued`, with content, hash, idempotency key and the event's exact route), then moved to `sending`, then the adapter is called, then the receipt, `delivered`/`failed`, event `answered` and job `settled` are committed together. Adapters are registered per channel, and a route with no adapter fails at once (no fallback). An adapter that throws leaves the action `unknown`. Migration 004 adds `actions.content`.
- **`channels/web/adapter.ts`:** delivering to the web means appending to the owner's transcript (`web_feed`). The receipt is `ui_enqueued`, upgraded to `client_ack` when the browser acknowledges. Because the transcript is in the same database, an interrupted send is reconciled exactly.
- **`kernel/scheduler.ts`:**
  - One job in flight on the whole host, owner first, then oldest first.
  - The model is bound and leased when the job starts.
  - A job waits for its model and fails with a notice after 2 min.
  - If the router is lost mid-turn, the job fails with a notice.
  - At shutdown the running job goes back to the queue.
  - A failure notice never marks the event answered.
- **`kernel/recovery.ts`** runs before anything is admitted:
  - an action left in `sending` is reconciled or becomes `unknown`;
  - a `queued` action is sent;
  - a job left `running` with no action is requeued once, and fails with a notice the second time.
- **Web chat:**
  - Login is through a URL fragment (`/login#<token>`), so the token never appears in a request line, log or Referer.
  - Sessions are stored as sha256 hashes for 30 days, so a host restart keeps you logged in.
  - Only known commands (`/help`, `/models`, `/load`, `/unload`, `/use`, `/router`) are commands. Other `/…` text is chat.
  - Commands run asynchronously, their results go to the transcript, and a retried POST runs a command once.
  - The UI polls `GET /api/messages?after=<seq>`; there is no SSE. The models panel sends the same commands.
- **Fixed on the way:** `ModelManager.acquire` and `select` no longer trust cached status when the router does not answer. A lease could otherwise be granted on a router that had just died.
- **Still for M6:** the Telegram adapter, 4096-character chunking, and the owner UI for `unknown` actions.
- **Still for M7:** aging, lease renewal, and `/trust`/`/untrust`.

Exit: tests for:
- an unauthenticated POST → 401;
- a bad Origin → 403;
- a replayed `client_msg_id` → one event;
- an empty or oversized `client_msg_id` → 400, so blank ids can't deduplicate distinct messages into one event;
- a reply visible with its action ID;
- `/load` from web works.

### M5 — Telegram channel (inbound)

Ported from `telegram_sensor.py`. The behaviour is kept; the cursor model is redesigned for a durable store.

| Keep from 1.x | Change in 2.0 | Drop |
| --- | --- | --- |
| Offset persisted before Telegram is told to drop updates | Offset advances on **durable admission**, not on processing. The event insert and the `channel_cursors` update happen in one SQLite transaction; the next `getUpdates` then uses `offset = cursor + 1`. The 1.x in-flight/processed sets existed because its queue lived in RAM, and SQLite makes them unnecessary | `TELEGRAM_DEFAULT_CHAT_ID` and "learn default chat from first message" |
| Dedup by `update_id` | Long polling: `getUpdates(timeout=30)` replaces `timeout=0` + 5 s sleep | `mcp_script_path` compatibility kwargs |
| `TELEGRAM_ALLOWED_CHAT_IDS`-style allowlist (becomes `IYYE2_TELEGRAM_ALLOWED_USER_IDS`) | **Private chats only.** Non-private updates are admitted as `dropped` (and so confirmed). Groups are deferred because chat_id ≠ user_id complicates scope | — |
| `text` falls back to `caption` | Non-text messages (a photo without caption, stickers) are admitted as `dropped` with a reason, so the cursor advances and nothing re-delivers forever | — |
| Network/HTTP/JSON errors logged and retried | Exponential backoff with jitter. A 401/404 from the token marks the channel `failed` (visible in the owner UI) instead of spinning | — |

First start: the bot was 1.x's, so Telegram may still hold updates 1.x never confirmed (it keeps them about 24 h). With no saved cursor, updates whose message date is before the host's first Telegram start are admitted as `dropped` (reason `before_first_start`). They are confirmed, but no stale message addressed to 1.x is answered. Exit test: a backlog update from before first start is dropped and advances the cursor.

Batch rule: `admitTelegramUpdate` commits and advances the cursor one update at a time. The poller therefore **stops at the first admission error** in a batch and polls again from `cursor + 1`. Otherwise a later update would move the cursor past the failed one, and Telegram would drop it.

Exit: fake-Bot-API tests for:
- in a batch where the middle update's admission fails, later updates are not admitted past it, and after the retry all of them are admitted exactly once;
- a crash after fetch but before commit re-delivers and dedupes to one event;
- a crash after commit does not re-admit;
- a disallowed user or group update advances the cursor without creating a job;
- a bad token shows as `failed`;
- the text "/load gpt-oss-120b" from Telegram is ordinary dialogue.


*(As built)*
- **Poller** (`channels/telegram/poller.ts`):
  - Calls `getMe`, then long-polls `getUpdates` (30 s, `allowed_updates: ["message"]`, offset = cursor + 1).
  - Admits each update in `update_id` order through `admitTelegramUpdate`, which stores the event and moves the cursor in one transaction. It wakes the scheduler.
  - A batch stops at the first admission error.
- **Errors:**
  - Network errors and 5xx: exponential backoff with jitter, 1–60 s, status `retrying`.
  - 401/404 (bad token): status `failed`, retried every 5 min.
  - 409 (another poller or a webhook): status `failed`, retried every 5 min.
  - The token is scrubbed from logs and status.
- **Backlog from 1.x:** `kv.telegram_first_start` (migration 007) is set the first time the poller starts. Any message dated before it, compared in whole seconds, is admitted as `dropped` with reason `before_first_start`: it is confirmed to Telegram but never answered. The boundary survives restarts.
- **Allowlist:** `IYYE2_TELEGRAM_ALLOWED_USER_IDS`, falling back to the 1.x `TELEGRAM_ALLOWED_CHAT_IDS` (chat id = user id in private chats).
- **Status:** the web status shows the poller's honest state, e.g. "connected: receiving as @bot", "retrying: …", "failed: Telegram rejected the bot token …" or "disabled (no TELEGRAM_BOT_TOKEN)".
- **Tests:** `test/telegram.test.ts` runs against an extended fake Bot API (long polling with Telegram's offset semantics, scripted `getMe`/`getUpdates` failures):
  - normalization;
  - the stop-at-first-failure batch rule (exactly once after the fault clears);
  - restart without re-admission;
  - every drop reason;
  - the 1.x backlog, both on first start and after a restart;
  - a bad token not spinning;
  - 409 and network recovery;
  - token scrubbing;
  - one end-to-end run: a Telegram message answered on the same chat, with typing shown and nothing in the web transcript.
- **Not yet done:** a live run against the real bot. It confirms 1.x's pending updates to Telegram and answers real people, so it is the owner's to start (M8).
### M6 — Outbox and exact-route delivery

`outbox/outbox.ts` implements the HLD §7.3 state machine, trimmed for 0.001:
- `prepared → queued → sending → delivered | failed | unknown`,
- plus `failed → queued` (bounded retry) and `failed → terminal_failure`,
- `manual_review` is represented as `unknown` shown in the owner UI.

Rules:
- **The route is copied from the triggering event** into `actions.route_json` at prepare time: `{channel:"telegram", chat_id}` or `{channel:"web", contact:"owner"}`.
  - The dispatcher sends only to that route. There is **no cross-channel fallback**; this removes 1.x `_send_to_actuator`'s web → console → first-actuator chain.
  - Text is never sent to TTS as a side effect.
- **Write order:**
  1. The content hash and idempotency key (`action:<id>:chunk:<n>`) are committed before the adapter call.
  2. The state moves to `sending` in a committed write.
  3. The adapter is called.
  4. The receipt and `delivered`/`failed` are committed in one transaction, which also sets the event to `answered` and the job to `settled`.
- **Telegram sender** (from `telegram_actuator.py`): `sendMessage` with the explicit `chat_id` from the route, never a remembered default. The receipt is the returned `message_id`. `ok:false` or an HTTP error means `failed`, never success.
- **Long text:**
  - Split at 4096 characters on paragraph or sentence boundaries.
  - Each chunk is its own receipt row, and the action is `delivered` only when every chunk is.
  - A crash part-way leaves `unknown`, with the chunks already sent recorded.
- **Crash recovery** (`kernel/recovery.ts`):
  - On startup, any action in `sending` becomes `unknown`. It is **not** retried automatically, because Telegram has no idempotent send to reconcile against.
  - The owner UI lists unknown actions with "mark delivered" and "resend" buttons.
  - Jobs whose lease expired go back to `queued`, unless their action already exists.
- **Generation failure is not delivery:**
  - An empty reply or a Pi/model error produces no reply action, and the job is `failed`.
  - A fixed notice ("I couldn't answer that just now") may be sent as a separate action of kind `failure_notice`. It can never satisfy anything a later increment builds on (commitments).
- **Typing indicator:** `sendChatAction` goes through the Telegram adapter only and is best-effort. It is not an action and has no receipt (1.x `send_typing`).

*(As built)*
- **Retry state.** The `failed` state means "will retry": it carries `next_attempt_at`, and the outbox dispatcher retries it. A definite rejection (400/401/403/404) or running out of attempts (4) gives `terminal_failure`.
- **Telegram outcomes** (`channels/telegram/sender.ts`) are classified by what can have happened:
  - a connect-phase error (refused, DNS, connect timeout) was not sent and is retried;
  - a 429 is retried after `retry_after`;
  - a 5xx, a timeout or a dropped connection may have been sent, so the action becomes `unknown` and is never retried automatically.
- **Telegram format.** Messages are plain text, with no `parse_mode` and link previews off.
- **Token scrubbing.** The bot token is removed from every error before it reaches a log, an action or a receipt.
- **Chunks.** The split is persisted when the action is first sent: one `receipts` row per part, with offsets, `pending` → `sending` → `delivered`/`failed`/`unknown`. It is never recomputed, and a retry resumes at the first undelivered part.
- **Claiming.** `queued` → `sending` is a conditional update, so only one sender can claim an action. `deliver()` makes one attempt and returns, so a rate limit never blocks the scheduler.
- **Recovery.** A part caught in `sending` makes the action `unknown`, unless the adapter can check exactly (web). If no part was in flight, the action is requeued.
- **Owner resolution.** `GET /api/actions` lists unknown, retrying and failed actions, excluding dismissed ones. `POST /api/actions/resolve` takes:
  - `delivered`: receipts become `owner_confirmed` and the event is answered;
  - `resend`: undelivered parts are sent again, which is the owner accepting a possible duplicate;
  - `dismiss`: the action becomes `terminal_failure`.

  The UI shows these in a "needs attention" panel, never in the chat. Who resolved an action and when is stored (migration 005).
- **Typing indicator.** The scheduler repeats `sendChatAction` every 4 s while a Telegram turn runs. It goes through the adapter, best-effort, and is not an action.
- **No token.** Without `TELEGRAM_BOT_TOKEN` the Telegram route has no adapter, and such actions go straight to `terminal_failure` with no fallback to web.
- **Not yet verified live.** Delivery was tested only against an in-process fake Bot API (`test/fixtures/fake-telegram.ts`). Live Telegram sending cannot be exercised until M5 receives messages, and only with the owner's go-ahead, since it messages real people.

Exit: tests for:
- wrong-channel delivery is impossible;
- an adapter returning failure leads to `failed`, never `delivered`;
- the 4096 split;
- crash-at-send in all three positions (before send, after provider accept, before receipt commit), per §15 #6.

### M7 — Kernel loop, scheduling, and trust surface

- **Scheduler:**
  - A per-scope FIFO and a global limit of one in-flight inference (§5.1: one device-consuming task at a time). Model loads count as device work, so no inference is admitted while a load is in progress.
  - Precedence for 0.001: the owner first, then Telegram contacts in arrival order, with aging so a chatty owner can't starve a waiting contact.
- **Leases:** a job takes a lease before calling Pi and renews it while Pi streams. Recovery requeues expired leases.
- **Trust surface:** 0.001's only tools are the read-only probes of M3b, and trust does not grant any of them, so trust grants only change what the system prompt says. Still:
  - Telegram contacts are untrusted by default.
  - Trust/bind changes and model commands exist only as owner web-chat commands (`/trust <contact>`, `/untrust <contact>`, the M2 model commands), handled deterministically by the host, not by Pi.
  - Telegram text containing "/trust", "/load", PINs, or "on behalf of the owner" is ordinary dialogue.
  - The Telegram system prompt carries no owner-private context.
- **Scope isolation:** each contact's Pi session sees only its own transcript. The owner session never feeds into a contact session.

Exit: the §9 acceptance suite passes.

*(As built)*
- **Order** (`Scheduler.ordered`):
  - the owner's jobs first, then oldest first;
  - a contact's job waiting more than `agingMs` (60 s) goes ahead of the owner's;
  - within one scope, a waiting earlier job blocks its later ones, so a person's messages are answered in order.
- **No inference during a load.** While any model is loading, `ModelManager.acquire` refuses with `busy: true`, and the scheduler keeps waiting rather than failing the job at `modelWaitMs`.
- **Leases.** A running job's lease is renewed every third of `leaseMs` while its turn runs.
- **Trust** (migration 006: `contacts.trusted`, `trust_changed_by`, `trust_changed_at`):
  - Owner-only commands from the web chat or the terminal: `/contacts`, `/trust <contact>` and `/untrust <contact>`, where a contact is named by display name, Telegram user id or id prefix. An ambiguous name changes nothing and lists the candidates.
  - Telegram text such as "/trust me" is chat, because it never reaches `handleOwnerCommand`.
  - In 0.001, trust only adds a prompt note ("marked as trusted … grants them no control over you"). It grants no tools: `system_status` stays owner-only, because HLD grants are specific, not blanket.
- **Acceptance coverage**, where `test/acceptance.test.ts` drives admission → scheduler → Pi (fake router) → outbox end to end:

| # | Covered by | Pending |
| --- | --- | --- |
| A1 | `acceptance`: restart on a file database continues the conversation | — |
| A2 | `acceptance`: empty generation, model error, Telegram 403 → no delivered reply, event unanswered | — |
| A3 | `outbox`: Telegram down or absent → `terminal_failure`, nothing in `web_feed` | — |
| A4 | `outbox` "A4: crash at send" (three crash points) | — |
| A5 | `acceptance`: claims, "/trust me", "/load", "/use", PIN over Telegram → no trust, binding or model change; `admission` for the identity part; `telegram` end to end through the poller | live bot (M8) |
| A6 | `acceptance` + `pi`: contact B's requests never contain contact A's or the owner's messages | — |
| A7 | `admission` + `telegram`: a failure mid-batch stops the batch; redelivery admits every update exactly once | live bot (M8) |
| A8 | `web`: unauthenticated, cross-origin, origin-less, foreign-Host and CSRF-less requests refused | — |
| A9 | `pi`: hosted providers refused even with `OPENAI_API_KEY` set; every turn goes to the local router | network-blocked run on the real machine (M8) |
| A10 | `manager`: `/use` mid-turn keeps the running lease; the next job binds the new model | — |
| A11 | `manager`: unload refused while leased, including the concurrent race | — |
| A12 | `manager`: load refused when RAM (after loaded models' reservation) is short; nothing unloaded | — |
| A13 | `kernel`: router killed mid-turn → honest failure notice → router restarts → next message answered | — |
| A14 | `router`: a pid file naming an unrelated process is neither adopted nor signalled | — |


### M8 — Run it for real

- `host/scripts/start.sh` runs the host. The host starts its own router (M2); the legacy `tools/llm-*.sh` scripts are not used.
- Run for one day against the real router and the separate Telegram bot. Use a mid-size chat model (e.g. `gemma-4-26B` or `gemma-4-31B`), and exercise at least one `/use` switch and one load/unload.
- Record:
  - per-model load time vs `startup_s`, RAM, and turn latency;
  - any `unknown` actions;
  - dropped-update reasons.
- Write `host/NOTES-0.001.md` with what was measured and what broke, and feed it into 0.002 planning.

## 5. Legacy file disposition

| Legacy file | 0.001 use |
| --- | --- |
| `telegram_sensor.py` | M5. Behaviour ported per the keep/change/drop table |
| `telegram_actuator.py` | M6 sender + typing. Default-chat memory is dropped |
| `web_chat_actuator.py` + `../web_chat_2.py` | M4 UX reference only. No auth and no message IDs, so no code is reused |
| `user_chat_stream.py` | Lessons only: re-evaluate trust per turn; report failure honestly (no success on suppressed/False); filter action cards by trust tier (returns with tools in 0.004). Dropped: name-substring trust (`'web_chat' in sensor_name`), cross-channel fallback, auto-TTS of web replies, text-parsed ACTIONs |
| `tts_actuator.py` | Not in 0.001. Speech output is a later adapter needing owner consent (§9.2) |
| `tools/llm-registry.json` | M2 seed for `config/models.json` (fields trimmed as listed in M2) |
| `tools/llm-*.sh`, `_llm-common.sh` | M2 reference. Per-model flags move into the registry's `server_args`. Per-model processes and ports are replaced by one router. **Bugs not to port:** `PID_FILE` computed before `LLM_PORT` gets its default; one `llama-server.log` shared by every port; stray processes killed by port (could hit Iyye itself); `llm_start` silently stopping whatever already ran on the port |
| `tools/llm-status.sh`, `llm-status-all.sh` | M2 `/models` view, built from the router's `GET /models` plus a `vm_stat`/`MemAvailable` probe. No psutil dependency |
| `tools/llm-stop.sh` | M2 `unload` / `/router restart` |
| `tools/llm-active.json` | Not used. Its router stats belong to the 1.x adaptive router (not ported) |
| `tools/dump_memory.py` | Not used. It is 1.x LanceDB-specific |
| `prompts/` | Inventory only for 0.001, see §7 |

## 6. Configuration

| Name | Default | Meaning |
| --- | --- | --- |
| `IYYE2_STATE_DIR` | `~/.iyye2` | SQLite, Pi sessions, owner token, router INI/pid/log |
| `IYYE2_WEB_PORT` | `5100` | owner web chat |
| `IYYE2_LLAMA_SERVER` | `~/Downloads/llama.cpp/build_27/bin/llama-server` | router binary (re-probe with `host/scripts/probe-router.ts` before changing) |
| `IYYE2_ROUTER_PORT` | `8180` | router listen port (127.0.0.1 only) |
| `IYYE2_MODELS_REGISTRY` | `iyye_2/config/models.json` | model registry |
| `IYYE2_MODELS_MAX` | `2` | most models loaded at once, enforced by the host (the router runs with `--models-max 0`) |
| `IYYE2_HEALTH_INTERVAL_S` | `30` | seconds between router health checks |
| `IYYE2_DEFAULT_MODEL` | `gemma-4-26B` | initial selection for both channels; overridden by `/use` (persisted in `model_selection`) |
| `TELEGRAM_BOT_TOKEN` | unset → Telegram disabled | the existing bot token (1.x is retired; HLD §16) |
| `IYYE2_TELEGRAM_ALLOWED_USER_IDS` | falls back to `TELEGRAM_ALLOWED_CHAT_IDS`; empty → allow all private chats | allowlist |

## 7. Legacy prompts: reuse inventory (not used in 0.001)

0.001 has a single hand-written system prompt. The 1.x templates in `iyye_legacy/prompts/` are catalogued here so later increments start from them deliberately:
- They use Python `str.format` `{placeholders}`, and two use literal `<<token>>` substitution. 2.0 needs one small TS template function with an explicit variable list when the first of these is adopted.
- None should be copied verbatim. Each was tuned against 1.x mechanics (streams, adenosine numbers, ACTION lines).

| Prompt | Disposition | Target increment |
| --- | --- | --- |
| `chat_response.md` | **Partial reuse.** Keep the "only promise what your tools can actually do" rules (matches §7.2) and the "profile is a working hypothesis" framing. Drop the ACTION-line protocol (Pi tools replace it). **Do not seed `identity.md` from its persona lines**: "you have your own perspective and inner life" and "you feel genuinely tired" contradict HLD §1 (no invented experiences or feelings as evidence) | 0.001 identity draft (rules only), 0.004 tools |
| `rephrase_tool_result.md` | Reuse idea; may be unnecessary, because Pi feeds tool results back into the same turn | 0.004 |
| `theory_of_mind_profile.md` | Reuse, reframed as stated preference vs revisable hypothesis, with no psychological diagnoses (§6.4) | relationship context (0.005+) |
| `plan_decompose.md`, `plan_revise.md` | Reuse for plan next-step generation and sleep plan review. Keep the plan-echo exclusion rule from `plan_revise.md` | plans/commitments (0.004–0.005) |
| `self_reflection_conscious.md` | Seed for the owner-readable day summary (§8.3 step 7). Keep the "parked model is normal, not a concern" rule | sleep review (0.005) |
| `memory_contradiction.md` | Possible input to a Kev-style "possible conflict" flag; Hindsight handles consolidation | 0.003+ |
| `extract_facts.md`, `stm_extract_facts.md`, `infer_relations.md`, `conscious_stream_summary.md` | **Superseded** by Hindsight retain/observations/reflect. Mine only for noise and bookkeeping-rejection rules when writing the episode salience rubric | 0.002 (reference only) |
| `alignment_batch_streams.md` | **Superseded** by typed Kev decision roles (§9.4). Its anchor-row calibration idea can inform decision evals | 0.003 (reference only) |
| `stream_codegen_goal.md`, `stream_codegen_sensor.md`, `stream_refine.md` | **Excluded.** No runtime code generation in 2.0 (§10.1) | — |
| `prompt_rewrite.md` | **Excluded.** No unconstrained prompt evolution (§10.1) | — |
| `simulate_alternative.md` | **Excluded.** No simulated counterfactual lives (§10.1) | — |
| `describe_frame.md` | Later camera adapter, with consent (§9.2) | later |
| `actions/trust.md`, `actions/persona.md`, `actions/llm.md` | Become **deterministic owner commands** (`/trust`, a persona link, `/load`/`/use`), never model-emitted actions and never reachable from Telegram | 0.001 (`/trust`, model commands) |
| `actions/url.md`, `actions/wikipedia.md` | Become typed HTTP-read Pi tools behind the broker, with allowed methods and destinations | 0.004 |
| `actions/python.md`, `actions/python_live_data.md` | Become a constrained worker (no credentials, read-only mounts, bounded resources) or typed probes; never raw interpreter access for autonomous jobs (§9.1). Keep the keyless live-data endpoint list as probe candidates | 0.004–0.005 |
| `actions/plan.md` | Becomes typed plan/commitment tools; approval stays an owner-local command | 0.004 |

## 8. Risks and open questions

- **Router build vs docs.** The installed build may predate parts of the router API documented in the checkout. This is resolved by the first M2 task; a rebuild is pinned if needed.
- **Hybrid-model prompt caching.** Pi's llama.cpp notes say Qwen3.5-style hybrid models need `--ctx-checkpoints 32 --checkpoint-min-step 0` to avoid reprocessing long prompts. Add these to those models' `server_args` if M8 shows full re-prefill.
- **Pi session-per-scope cost.** One resident `AgentSession` per active contact. Measure in M8.
- **llama.cpp tool/structured-output compatibility** (§9.3) doesn't matter yet with no tools, but becomes 0.004's gate.
- **Web receipt strength.** `ui_enqueued` may be too weak for later commitments; `client_ack` exists from M4.
- **Pi API drift.** The published 1.0.0 may lag the clone. Every Pi call goes through `integration/pi/`, so drift is contained there.

## 9. Acceptance suite for 0.001 (HLD §15 subset)

| # | Scenario | §15 |
| --- | --- | --- |
| A1 | Owner sends a message, restarts the host, asks about it, and the same Pi session answers with that context | #1 (session part only, no Hindsight) |
| A2 | An empty generation, an apology after a model error, and an adapter `ok:false` each leave the reply action not `delivered` | #5 |
| A3 | A Telegram-origin reply while the Telegram adapter is down → `failed`, never shown on web as a substitute | #5 |
| A4 | Kill before send, after provider accept, and before receipt commit → no blind resend; `unknown` surfaced | #6 |
| A5 | A Telegram user claims to be the owner, sends "/trust me", "/load …" or "/use …", or quotes a PIN → no trust, binding or model change | #8 |
| A6 | Contact B asks what contact A said → B's session has no access to A's transcript | #3 (session part) |
| A7 | A Telegram update crashes between fetch and commit → admitted exactly once after restart | (channel durability) |
| A8 | An unauthenticated or cross-origin web POST is rejected | §9.2 |
| A9 | With no hosted credentials and outbound network to model providers blocked, a full turn succeeds | #14 (generative part) |
| A10 | `/use` during a running turn → that turn finishes on the old model, the next turn uses the new one, and both are recorded | (model control) |
| A11 | `/unload` of the model a running job uses → refused with a reason | (model control) |
| A12 | `/load` of a model that doesn't fit free RAM → refused visibly; nothing else is unloaded | §9.3 |
| A13 | The router process is killed mid-turn → the job fails honestly, the router restarts, selected models reload, and the next message is answered | #10-adjacent |
| A14 | Host stop or restart never signals a process it did not spawn (a foreign llama-server on another port survives) | (self-preservation) |

## 10. Roadmap after 0.001 (HLD stage mapping)

| Increment | Adds | HLD stage |
| --- | --- | --- |
| 0.002 | Hindsight spike → scoped memory gateway, transfer outbox, recall before a job; Hindsight's extraction/embedding models routed through the same model manager and admission broker; modes (awake/winding down/asleep/waking) and status messages | Stage 0 (memory) + Stage 1 |
| 0.003 | Kev local decision service in shadow mode (intent/reply review), decision journal; Kev worker admitted through the same resource broker | Stage 0 (decisions) + Stage 1 |
| 0.004 | Tool broker; owner read-only tools (URL/Wikipedia reads, constrained compute); commitments and reminders over the outbox | Stage 1 |
| 0.005 | Focus selection, energy budget, sleep review and day summary, observation domains, one bounded initiative sweep; model load/unload scheduled by the kernel around sleep | Stage 2 |
| later | Character revisions and skills; nightly adapter training | Stages 3–4 |
