# Hindsight 0.10.2 → 1.2.0 (prepared 2026-11-06)

The live host still runs 0.10.2. 1.2.0 is installed next to it on the Spark, and the owner switches with the runbook below. Everything here was measured on the Spark beside the live host, which was not stopped, restarted or reconfigured.

## What is installed

- **Install directory:** `iyye_2/memory-1.2.0/` on the Spark, untracked, with a `.gitignore` of `*`.
  - `.venv`: `uv venv --python 3.11`, then `hindsight-api==1.2.0` with `memory-1.2.0/constraints.txt`. It takes 6.3 GB.
    - torch 2.14.1, sentence-transformers 6.1.0 and transformers 5.15.1 are held at 0.10.2's versions, so the embedder and reranker compute what they computed before.
    - **dateparser is held at 1.4.3.** 1.5.0 (released 2026-11-04, allowed by Hindsight's `dateparser>=1.4.2`) changed what `search_dates` returns. Hindsight's query analyzer then raised `too many values to unpack` on every query naming a date or a weekday and dropped the constraint: "What did I tell you on 2026-10-24?" found 9 memories of that day instead of 46. With 1.4.3 it finds 45, against 46 on 0.10.2.
  - `pg` is a link to `../memory/pg`. PostgreSQL is unchanged.
- **Selecting it:** `IYYE2_MEMORY_DIR` (`config.memory.installDir`), so 0.10.2 stays in `memory/.venv` untouched as the way back. A uv venv cannot be moved, because its scripts name their own path.
- **Lists:**
  - `memory/requirements-linux-aarch64.lock` is the freeze of the new venv.
  - `memory/requirements.lock` is the same resolution for macOS arm64 (`uv pip compile`, constrained to the Spark's versions). The Mac's own `memory/.venv` is still 0.10.2; rebuild it from that list when it is needed.
  - `memory/requirements-linux-aarch64-0.10.2.lock` is the live venv's list.
  - About 100 packages changed version, and keyring and its helpers are gone.
- **Clone:** `hindsight/` is checked out at `v1.2.0` (`34a138684`, detached).

## Rehearsal on a copy of the live data

**The copy:**
- `pg_dump` of the live database (read once, password through a temporary 0600 passfile), restored into two scratch clusters on their own ports.
- 0.10.2 and 1.2.0 ran on them with the host's exact Hindsight environment (`MemoryService.hindsightEnv`).
- Their model URL was a logging stub, never the router.
- Scratch `HOME`, a copied `HF_HOME`, all in `~/hs12-rehearsal` (0700, deleted afterwards).

| Check | Result |
| --- | --- |
| Migrations | 6 (`e5b1c7d3a902` → `c7e2f9a4d1b8`, one on `memory_units`), under 1 s; healthy after **14 s** (0.10.2: 7 s; MemoryService waits 180 s) |
| Data | 6 banks; every bank's documents, memory count and counts by type identical (owner: 817 documents, 1,172 memories) |
| Bank settings | retain strategies, the cap-0 consolidation strategy, missions and `enable_observations` identical after the migration, before the host writes them again |
| Recall | 70 queries from the live turns, as the gateway asks them: the same first result in 70, mean overlap 0.987, reranker scores identical (same id: Δ 0); no model call |
| Model calls | only `POST /v1/chat/completions` (`response_format: json_object`, no tools, `temperature` 0.1); none while idle (about 18 min) or at start |
| Network | no connection other than loopback during start and work |
| Retain, verbatim strategy | one unit, no model call (both) |
| Retain, model 503 | HTTP 500 `Fact extraction failed` (both): a charged attempt, as before |
| Retain, prose | HTTP 500 (both) |
| Retain, JSON without `facts` | **0.10.2: 200 with 0 units (`completed_empty`); 1.2.0: HTTP 500.** Such an episode is now retried and fails after its attempts instead of passing as "nothing worth keeping". This cannot happen in the live `ledger` mode, where every retain is verbatim (no model call); it matters only under `IYYE2_FACTS_TURNS=hindsight`. |
| 0.10.2 started on the database 1.2.0 migrated | **It starts and serves without complaint** (one warning: "newer migration revision … Skipping migrations"). The host now refuses this itself (below). |
| Retain, `{"facts": []}` | 200 with 0 units (both) |

## Smokes (real gemma-4-E4B on a scratch router, one at a time)

`memory-smoke`, `memory-l2-smoke` and every night smoke passed on 1.2.0. PROVENANCE was OK in all of them, and no observation was ever built from `speaker:iyye` or `speaker:probe` (the smoke now counts that as a violation).

| Night smoke (7 turns) | 0.10.2 | 1.2.0 |
| --- | --- | --- |
| reasoning on, Hindsight turn extraction (3 runs each) | 316–321 s; consolidation 20–40 s | 336–366 s; consolidation 48–62 s |
| reasoning off | 87 s; consolidation 21 s | 133 s; consolidation 70 s |
| `--facts` (reasoning on) | 358 s; consolidation 51 s | 458 s; consolidation 125 s |
| **`--ledger`: the live mode** | 68 s; consolidation 35 s | 81 s; consolidation 50 s; same episodes kept, same beliefs, same recall |

**Consolidation is a regression for Hindsight's own turn extraction.** 1.2.0 answers one entry per new fact; there is no setting to turn that off.
- Correction ("Alex visits in December", then "moved to January"):
  - 0.10.2 kept only January in 4 of 4 runs.
  - 1.2.0 kept only January in 1 of 3 runs with reasoning on, kept a stale December observation beside January in 2, and kept only December with reasoning off.
- It also takes 1.5–3 times as long.

**In the live mode this does not reach a turn.** Since `IYYE2_FACTS_TURNS=ledger` (2026-10-17):
- people's turns reach Hindsight only as structured facts, and every observation built since then carries `structured-fact` (68 of 68 on the copy);
- recall never offers a `structured-fact` item, only its belief, and the ledger handles corrections itself.

**The cost is night time, and it is larger than the smokes suggest.** The heaviest recent live night was 2026-10-25: 85 structured facts, 71 of them Iyye's own (`told_by_iyye`), and 201 s of consolidation live.

Replayed on copies of the live database (that night's `fact:` documents deleted and retained again exactly as the fact night stores them, then consolidated on gemma-4-E4B with reasoning off, as the host does):

| | 0.10.2 | 1.2.0 |
| --- | --- | --- |
| Time | **176 s** | **629 s and 633 s** (two runs) |
| Model calls | 19 | 94 |
| Observations touched | 19 | 24–25 |
| Untagged observations | count and text hash unchanged (107) | unchanged |

Every touched observation carried `structured-fact` on both versions.

**Why 1.2.0 is slower.** A batch's facts that the answer leaves unplaced are asked again, first in a smaller batch and then one by one. Iyye's own facts sit in a scope capped at 0 observations, so they are always left unplaced. Each such batch therefore costs 7–10 calls instead of one (about 20 s a fact instead of under 1 s).
- Giving those facts a glob observation scope that matches nothing did not stop it.
- This is worth reporting upstream: the re-ask ignores a cap of 0.

The night waited at most 600 s for a consolidation. Past that deadline the gate is released while Hindsight still works, its calls meet the pass-through's 503, and the facts end up marked failed. **The deadline is now 1,800 s** (`memory/night.ts`).

Going back to `IYYE2_FACTS_TURNS=hindsight` on 1.2.0 needs this measured again first.

## Host changes made for 1.2.0 (all also correct on 0.10.2)

- **The orphan check (`facts/orphans.ts`)** lists every document and filters `fact:` itself.
  - In 1.2.0, `GET …/documents?q=` also matches document text and stops at 1000 matches, after which `total` is a lower bound. The owner's bank already holds 817 documents, so it would have started reporting false `missing` orphans.
  - The fake (`test/fixtures/fake-ltm.ts`) now behaves like 1.2.0, and the test covers both cases.
- **The memory smokes** take the install directory from `IYYE2_MEMORY_DIR`. The night smoke has `--ledger` and counts observations from Iyye's words or probes as violations.
- **The night's consolidation deadline** is 1,800 s (it was 600 s); see above.
- **An older Hindsight never starts on a newer database.** `MemoryService` reads the installed version from the venv's `hindsight_api-<version>.dist-info`. It records the newest version that ever came up in `~/.iyye2/memory/hindsight_version`, and refuses to start an older one (state `failed`, naming `IYYE2_MEMORY_DIR`). Forgetting the variable after the switch is therefore an honest `/memory` failure, not 0.10.2 writing to a 1.2.0 database.
- **No pass-through change.** Retain asks for `json_object`, and no retain failed in any smoke, so the repeat-penalty fix of the fact ledger is not needed here.

## Runbook (the owner, on the Spark)

0. Sync the commit with these changes and run `npm test`.
1. Stop Iyye. Check that its PostgreSQL has stopped too: `pgrep -f 'postgres -D /home/akomarov/.iyye2/memory/pgdata'` prints nothing.
2. Back up the memory database (95 MB): `cp -a ~/.iyye2/memory/pgdata ~/.iyye2/memory/pgdata-0.10.2`.
3. Start Iyye as usual, with `IYYE2_MEMORY_DIR=/home/akomarov/Downloads/iyye/iyye_2/memory-1.2.0` added to its environment. Keep it wherever the start command lives: without it the host now refuses to start memory (above).
4. Check:
   - `/memory` says up, and `~/.iyye2/memory/hindsight_version` says 1.2.0;
   - `IYYE2_FACTS_TURNS=ledger` is still set (the consolidation regression is harmless only in that mode);
   - the newest `~/.iyye2/memory/logs/` Hindsight log shows the six `Running upgrade` lines and no error;
   - `node scripts/dump-ltm.ts --limit 3` lists the six banks.
5. After the first night:
   - the night report has no failed episodes;
   - `/facts report` shows no orphans;
   - the wake check is clean.

**Rollback:** the migrations do not downgrade.
1. Stop Iyye.
2. Restore the database: `rm -rf ~/.iyye2/memory/pgdata && mv ~/.iyye2/memory/pgdata-0.10.2 ~/.iyye2/memory/pgdata`.
3. Delete `~/.iyye2/memory/hindsight_version` (it says 1.2.0 and would refuse 0.10.2).
4. Start Iyye without `IYYE2_MEMORY_DIR`.

What the nights after the switch stored in Hindsight is then gone. SQLite (beliefs, structured facts) is not affected, and `/facts orphans restore` stores the missing structured facts again on the next night.

**After a stable week:** delete `pgdata-0.10.2` and `memory/.venv` (0.10.2).
