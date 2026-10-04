# T0 spike — self-hosted search, Wikipedia and tool-switching cost (2026-10-03)

## Setup
- **SearXNG:** cloned from github.com/searxng/searxng @ `19ffbcd30686e4008392e93de164200510dfb9d8` (2026-10-02) into `web/searxng`, an upstream clone like `pi/`, `hindsight/` and `kev/`: never modified or committed into. It is not on PyPI.
  - Its requirements are installed with uv into `web/.venv` (Python 3.13.15), outside the clone, so the clone stays clean. The exact set is pinned in `web/searxng-requirements.lock` (32 packages, e.g. flask 3.1.3, granian 2.8.3).
  - It runs from the source tree: `SEARXNG_SETTINGS_PATH=<settings.yml> PYTHONPATH=web/searxng web/.venv/bin/python -m searx.webapp`.
- **Scratch settings** (generated, never the clone's own): `use_default_settings` with `engines.keep_only`, `server.bind_address 127.0.0.1`, a random port, a random `secret_key`, `limiter: false`, `image_proxy: false`, `public_instance: false`, `search.formats [html, json]`, `safe_search: 1`, metrics off. `/healthz` answers `OK` once up, and `/config` lists the loaded engines.
- **Isolation:** scratch ports and directories only. The owner's host (router 8180, memory 8185–8187, Kev 8188 started by the owner's host at 10:44) was not touched.

## Results

| # | Question | Result |
| --- | --- | --- |
| 1 | Install and start | Starts in about 2 s. The log warns that `limiter.toml` is missing and that `X-Forwarded-For` is unset; both are harmless with the limiter off on 127.0.0.1. |
| 2 | Which engines work from this machine (4 queries each: 2 English, 2 Russian) | **Working:** Yandex (10–15 results), Yahoo (7), Yep (20), Fireball (5), Bing (10; one query returned unrelated results, and with `safe_search: 0` it returned adult content for "Cheboksary population").<br>**Blocked:** DuckDuckGo and Qwant (CAPTCHA); Google, Brave, PrivacyWall and Tusksearch (suspended or access denied after the first request).<br>**Unusable:** Quark (crashes); Encyclosearch (timeout); Wiby and CrowdView (empty).<br>**Inactive upstream:** Startpage and Mojeek (proof-of-work CAPTCHAs), not loadable. Presearch does not exist in this version. SearXNG's own `wikipedia` and `wikidata` engines added nothing to general results. |
| 3 | Merged quality with `yandex,yahoo,yep,fireball,bing` | **Good.** 23–50 results in **0.7–1.0 s**.<br>"Cheboksary population": Wikipedia first (4 engines agree), then three population sites.<br>"Чебоксары население": ru.wikipedia first (4 engines agree).<br>"weather Berlin tomorrow": AccuWeather and meteoblue.<br>"llama.cpp router mode models preset": the Hugging Face blog post and the llama.cpp server README. |
| 4 | Wikipedia directly (MediaWiki API, no key, descriptive User-Agent) | `list=search` returns the right article first for en "Cheboksary" and ru "Чебоксары" in **~0.45 s**. `/api/rest_v1/page/summary/Cheboksary` returns a clean extract. |
| 5 | Cost of changing the declared tool set (llama.cpp build 11362, gemma-4-E4B, `--jinja`, a 4.6k-token conversation, `cache_prompt`) | Same tools, one more turn: 6 tokens processed, 4,605 from cache, **0.5 s**. **Any change to the tool set, even only their order, reprocesses the whole conversation:** web toolkit added gave 4,684 tokens, 0 from cache, **8.9 s**; only the order changed gave 8.4 s. The next turn with the new set is cached again (0.4 s). With gemma-4-26B and conversations near 16k tokens the cost is several times larger. |

## Decisions for the plan
- **Engines:** `yandex`, `yahoo`, `yep`, `fireball`, `bing`, with `safe_search: 1`. Every engine is scraped and can be blocked at any time; the merged set tolerates losing some. Wikipedia is queried directly by Iyye, not through SearXNG.
- **Tool selection:** per-turn selection is ruled out as designed. It would turn a 0.5 s turn into a full reprocessing of the conversation. Instead:
  1. **Declare tools in one fixed order** (toolkit order, then tool order), so an unchanged set always hits the cache.
  2. **Change the set rarely and stickily:** a toolkit that becomes active stays active for the rest of the conversation's session. Selection (the Kev role) decides only *additions*, and only when a message needs a toolkit that is not yet active. Removal happens only when a new session starts.
  3. Until declarations are large, every permitted toolkit stays active, as now. The Kev role stays in shadow and also records the cost it would cause (how many switches).
