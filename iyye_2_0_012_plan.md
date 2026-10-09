# Iyye 2.0.012 — A Second Model Machine for Background Work: Implementation Plan

- Status (2026-10-09): **built** (R0–R2). Owner decisions in §4. As built, §5.
- Scope: Iyye runs on the DGX Spark. The owner's MacBook Pro (M3 Max, 128 GB, on the same LAN) serves one reasoning model, and Iyye's **background work** runs on it, so long investigations neither wait for nor block chat on the Spark.
- Design source: [`iyye_2_0_hld.md`](iyye_2_0_hld.md) §2.2 and §9.3 (local-only inference, no hosted fallback), §3 (separation of authority), §5.1 (one device-consuming task per device).
- Builds on: `ModelManager` (leases, selection by key), `PiConversations` and the local-only Pi runtime (`lockToLocalProvider`), background steps (0.007, preemptible `DeviceSlot`), the memory pass-through (0.002 L2) as the pattern for a host-owned proxy, `makeComposer` (0.010 M3) and `FactExtractor` (0.011 F1).

## 1. Design

- **"Local" is the owner's machines.** The MBP is the owner's own computer on the owner's LAN, configured by the owner. It is never an automatic fallback: work selected for it waits while it is away, and work selected for the Spark never moves to it. Hosted providers stay unreachable.
- **On the MBP:** one `llama-server` with one model (`qwen38-27b-tak`), started by `host/scripts/remote-model.sh`:
  - bound to the MBP's LAN address, on its own port (8190), HTTPS with a self-signed certificate made by the script (its LAN address and `.local` name in subjectAltName), and an API key file (`--api-key-file`; never on a command line);
  - the same server arguments as the Spark's registry entry (`c`, `np`, `timeout`, `repeat-penalty`, the model's own `server_args`), written out from `config/models.json`, so they cannot drift;
  - under `caffeinate -i`. A closed lid on battery still sleeps; the owner keeps it on power.
- **On the Spark, one remote endpoint** (`IYYE2_REMOTE_MODEL`, e.g. `mbp=https://192.168.1.177:8190`), its key and its certificate in `~/.iyye2/secrets/` (0600, never logged).
- **A host-owned pass-through** (`models/remote.ts`, after `memory/passthrough.ts`) on the Spark's 127.0.0.1 forwards `POST /v1/chat/completions` (streaming) to the endpoint with the certificate **pinned** (`ca` on that one connection, never process-wide trust) and the key added by the host. Pi and the host's direct completions only ever talk to 127.0.0.1; the key never reaches Pi. No model-time limit (owner directive), as on the local path.
- **A remote model is its own kind in `ModelManager`:** named `<registry model>@<endpoint>` (`qwen38-27b-tak@mbp`; the Spark keeps its own local `qwen38-27b-tak`), described by that registry entry (thinking, roles), with its context taken from the endpoint (`/props` `n_ctx`), never guessed.
  - Never in the preset, never loaded or unloaded by the host, untouched by night and wake, not counted in `IYYE2_MODELS_MAX` or RAM, and never self-healed (an unreachable MBP is not a failed load, and must not become "gave up" notices).
  - "Loaded" means the endpoint's `/health` answers and lists the model, checked on the health tick; `acquire` on an unreachable one returns *not now*.
  - `/use qwen38-27b-tak@mbp background` only; refused for chat channels and memory. `/models` lists it with the endpoint's state.
- **Pi:** the remote model is registered under the existing Iyye provider with its own `baseUrl` (the pass-through), so `lockToLocalProvider` is unchanged and still refuses every other provider.
- **One device slot per machine:** background steps, the composer and the fact extractor take the slot of the machine their model runs on. Work on the MBP holds the MBP's slot, so a chat on the Spark never pauses it, and it never delays a chat. The other background rules (awake, initiative not paused, energy above the reserve) are unchanged, and its device time is paid for as now.
- **Wi-Fi drops are not failures:** a connection error to the endpoint is *not now*. It never counts as a composer attempt, a fruitless investigation or a failed step.
- **Visible state:** the endpoint is recorded each minute in `service_status` (`remote:mbp`), so an outage is one service state the owner sees, not silently stalled work.

## 2. Milestones

- **R0 (spike, on the MBP):** the server script; `scripts/probe-router.ts --tools qwen38-27b-tak` (tool calls, needed by investigations); throughput over Wi-Fi from the Spark; the macOS firewall's state.
  - Checked 2026-10-09: the MBP's llama.cpp (build 11362) has `--ssl-cert-file`, `--ssl-key-file` and `--api-key-file`. `qwen38-27b-tak` loads in 5 s and returns OpenAI `tool_calls` (two in parallel, `current_time({})` and `system_status({})`). The macOS firewall is off. Pi models accept their own `baseUrl`, so the guard stays as it is. Still to measure: throughput from the Spark.
- **R1 (host):** config, the pass-through with the pinned certificate, the remote kind in `ModelManager`, Pi registration, per-machine device slots in background steps, the composer and the extractor, `service_status`, `/models` and `/use`.
- **R2 (tests and docs):** a fake HTTPS endpoint with a test-only certificate (never the real MBP): pinned certificate (another certificate refused), key added, streaming, unreachable is *not now*, no healing, `/use` refused outside background, the guard still refuses other providers, a chat on the Spark does not preempt work on the MBP. CLAUDE.md and HLD §2.2 updated.

## 3. Risks

- **Prompts leave the Spark.** Background prompts carry the owner's conversations and memory. Bound: HTTPS with a pinned certificate and a key, the owner's own machine, the owner's LAN.
- **The laptop sleeps or leaves.** Background work then waits (not a failure), and `service_status` shows it.
- **Tool calls:** investigations need them. If R0 shows `qwen38-27b-tak` cannot make them, the owner chooses another model before R1.

## 4. Owner decisions (2026-10-09)

1. The MBP takes **background work** only (not chat, not memory).
2. **HTTPS and an API key** on the LAN (not an SSH tunnel, not plain HTTP).
3. The model is **`qwen38-27b-tak`** (already on the MBP).

## 5. As built (2026-10-09)

- **TLS on the MBP is the script's own.** Its llama.cpp has the `--ssl-*` options but was built without OpenSSL ("the server is built without SSL support"), and its Homebrew is the broken x86 one. `scripts/remote-model.ts` therefore runs llama-server on the MBP's 127.0.0.1 (a free port, `--api-key-file`, the registry's arguments via `serverCliArgs`, `--alias` the registry name) under `caffeinate -i`, and puts a Node HTTPS front on the LAN address, which forwards each request unchanged and streams the answer back. llama-server still checks the key on every request; `/health` stays open, as llama-server keeps it.
- **On the Spark:** `models/remote.ts` (`RemoteModels`: the pass-through on `IYYE2_REMOTE_PROXY_PORT`, 8183; health and `/props` every 30 s; leases), `models/remote-config.ts` (`IYYE2_REMOTE_MODEL`), the key and certificate in `~/.iyye2/remote/<endpoint>/` (`api_key`, `cert.pem`, 0600, read at each use). The pin is the certificate itself (the only trust anchor, and the same SHA-256 fingerprint), so a new DHCP address does not break it; a different certificate at the address is refused.
- **An endpoint that serves another file or another context per slot is `misconfigured`**, never up (the host's prompt sizes and compaction rely on the registry's context).
- **Background work on the remote model** takes the second `DeviceSlot`; the quiet period after a conversation and "a person is waiting" do not hold it back; a lost connection invalidates the leases and pauses the step uncounted (fact extraction leaves the document to do, uncharged; the composer answers "not now").
- `/models` shows it as `on mbp: up|unreachable|misconfigured`; `service_status` records `the background model on mbp`; the wake check does not count it as a missing model.
- Measured from the Spark: health through the pin 200; `/props` without the key 401; with the system CAs only, refused; `/props`: `qwen3.8-27b-tak-reasoning.gguf`, n_ctx 65536; a completion at 9.3 tokens/s decode.
- Tests: `test/remote-model.test.ts` (fake HTTPS endpoint, test-only certificates in `test/fixtures/`).
