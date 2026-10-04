---
action_type: python
extends: python
index: false
summary: fetch live data (stock prices, weather) via keyless JSON endpoints
triggers: stock, stocks, share, shares, price, prices, ticker, quote, market, weather, temperature, forecast, rain, exchange rate, currency
trigger_patterns: \b[A-Z]{3,5}\b
---
  - For live data, fetch a **keyless JSON HTTP endpoint** and print the parsed values — do NOT scrape HTML and do NOT use a search engine. Recipes:
    - Weather: `https://wttr.in/<city>?format=j1` (JSON) or `?format=3` (one line). No special headers needed.
    - Stock/quote: `https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>` — the latest price is under `chart.result[0].meta.regularMarketPrice`. **You MUST send a browser User-Agent header or Yahoo returns HTTP 429**: `requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)`. Check `resp.status_code == 200` before parsing and print the status code if not.
    - Print a short formatted answer, e.g. `print(f"NVDA: ${price:.2f}")`.
