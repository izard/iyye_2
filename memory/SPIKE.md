# L0 spike — Hindsight 0.10.2 on the owner's Mac (2026-10-02)

## Setup
- **Isolated from the owner's live host:**
  - its own llama.cpp router on 127.0.0.1:8189 (build 11362), gemma-4-E4B only;
  - Hindsight on 127.0.0.1:8899;
  - all state in a scratch folder (`HOME` and `HF_HOME` pointed there).

  The owner's host (8180, with gemma-4-26B and qwen38-27b-tak loaded) was not touched.
- **Install:** `uv venv --python 3.11`, then `hindsight-api==0.10.2`. That is 1.7 GB in `memory/.venv`, with dependencies pinned in `memory/requirements.lock`: torch 2.14.1, sentence-transformers 6.1.0, pg0-embedded 0.15.2, mlx 0.32.3.
- **Configuration:**
  - `HINDSIGHT_API_LLM_PROVIDER=openai`, pointed at the router;
  - `LLM_MAX_CONCURRENT=1`, `LLM_TIMEOUT=600`;
  - `ENABLE_AUTO_CONSOLIDATION=false`, reconcile and mental-model sweeps at 0;
  - API-key tenant extension on.

## Results

| # | Question | Result |
| --- | --- | --- |
| 1 | Install and first start | **Blocked, then worked around.** pg0's bundled PostgreSQL 18.1 links `/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib` and `libcrypto.3.dylib`. This Mac's Homebrew is the x86 one in `/usr/local`, so they don't exist. `DYLD_FALLBACK_LIBRARY_PATH` does not work, because `initdb` starts `postgres` through `/bin/sh`, which strips `DYLD_*`. **Workaround that works:** copy the venv's own arm64 `libssl.3`/`libcrypto.3` (shipped in `psycopg2/.dylibs`) into pg0's `lib/`, `install_name_tool -change` the 10 referencing files to `@loader_path/…/lib/…` (12 references; the short relative path fits the header padding), and `codesign --force -s -` each. Postgres and initdb then run. |
| 1b | Downloads and offline | The first start downloaded 225 MB (BAAI/bge-small-en-v1.5 embedder and cross-encoder/ms-marco-MiniLM-L-6-v2 reranker) into `HF_HOME`. Every later start contacts the HF Hub unless `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` are set. With them set it starts in **15 s, fully offline**. |
| 1c | Footprint | Hindsight RSS 0.95 GB at rest, 1.1 GB after work. Embedder and reranker run on **CPU**: Hindsight declines MPS ("leaks memory"), so they **do not contend with Metal** inference. |
| 2 | Retain and control of device use | Synchronous retain (`async:false`) blocks until extraction is done. Consolidation is an async operation that the worker runs and `GET …/operations/{id}` reports. With auto-consolidation and the sweeps off, Hindsight uses the model **only when Iyye triggers retain or consolidate**, so the worker can stay enabled. |
| 3 | Extraction quality (gemma-4-E4B, 10 owner turns plus 2 Russian) | See the next table. Facts were correct and well-attributed ("the owner…", "brother Alex… Berlin"). Small talk ("What's 2+2?") produced nothing. |
| 3b | Speed per retained turn | **Reasoning on: 20–45 s. Reasoning off: 8–14 s** (first call 28 s, warm-up). Consolidation of 10–12 facts: **about 100 s with reasoning on, about 5 s with it off.** |
| 3c | Iyye's repetition as evidence | With reasoning on, the mission held: the turn where Iyye repeated Julia's lessons added no fact. With reasoning off, it added a duplicate fact, and **consolidation merged it** into one observation. |
| 3d | Correction | "Kazan in November", then "moved to December": raw facts keep both. **After consolidation, one observation** says "rescheduled … December 2026". Recall with `types:[observation, world]` and `prefer_observations:true` returns the December one first. |
| 3e | Russian | With the English-only embedder, the facts were extracted in English ("Cheboksary") or mixed ("User любит чак-чак"). Russian questions still found them ("Где живёт мама?" → Cheboksary; "Какой десерт я люблю?" → чак-чак). |
| 4 | Recall latency | **0.05–0.14 s** per query (budget `mid`, 400 tokens), with the right fact first in 6 of 6 English and 3 of 3 Russian questions. |
| 5 | Forgetting | `DELETE …/documents/{id}` removed its memory unit **and the observation derived from it**. Recall no longer finds it, so `/forget` can work at the document level. |
| 6 | Pi per-turn context hook | `DefaultResourceLoader` with `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles` and a `systemPromptOverride` loads **only** the inline extension, with no context files, skills or prompts. An inline `pi.on("context")` handler that inserts a `<memory>` message before the user turn reaches the model on every request. In the next turn's request the earlier injected block is **gone**: it is request-local and never stored as a turn. |
| 7 | Process lifecycle | SIGTERM to Hindsight also stops its Postgres. **SIGKILL leaves Postgres running**; a restarted Hindsight reattaches (data intact), but then does not stop it on SIGTERM. So the supervisor must run `pg0 stop --name hindsight` (with the same `HOME`) on shutdown and after any crash. |

Extracted facts, E4B with reasoning on (8 from 10 turns): daughter Julia's violin on Tuesdays; prefers short answers; Kazan trip in November, and rescheduled to December; black coffee, no sugar; 128 GB Mac Studio; brother Alex in Berlin; peanut allergy. Nothing from "Remind me…" (Iyye's repeat) or from "2+2".

## Security notes for L1
- `hindsight-api` binds **0.0.0.0** by default: always pass `--host 127.0.0.1`.
- pg0's database is `hindsight:hindsight@127.0.0.1:5432`, the default port with a weak password. L1 should use `pg0://user:<random>@hindsight:<free port>` in `HINDSIGHT_API_DATABASE_URL`.
- The API key file is 0600. Unauthenticated requests got 401.

## Go / no-go per plan §3
- **§3.1 pass-through and leases: go.** Hindsight only calls the model when triggered. Use the memory model with reasoning off: a 3–9× speed-up, and consolidation fixes its occasional duplicates.
- **§3.2 banks by scope: go.** Bank creation via `PUT /banks/{id}` with `retain_mission` works.
- **§3.3 request-local recall: go** with the `DefaultResourceLoader` plus inline `context` extension, not the prepend fallback.
- **§3.4 idle-window transfers: go.** About 10 s of model time per answered turn with E4B (reasoning off), plus a few seconds of consolidation per idle window.
- **§3.5 forgetting: go**, at document level.
- **Decided (owner, 2026-10-02):** option (c). Iyye uses its own conda-forge PostgreSQL 18.6 + pgvector 0.8.6 (`memory/pg`, `memory/pg.lock`), never pg0. The OpenSSL patch above was spike-only. A later check against that Postgres: Hindsight's migrations created 25 tables, the wrong password was refused, and it runs TCP-only on 127.0.0.1 (a Unix socket path in the scratch dir exceeded macOS's 103-byte limit).
