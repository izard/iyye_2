---
action_type: python
summary: run a Python 3 script (trusted users) — compute, check system state, manipulate files, fetch live data
triggers: compute, calculate, run, script, code, python, file, files, disk, convert, count, how many, how much, check, system
---
- `ACTION: {"type": "python", "code": "print('hello')"}`  — **trusted users only** (web_chat is always trusted; telegram contacts marked as "Trusted: yes" in the contact context are also trusted). Write a short Python 3 script (max 100 lines) that prints its result to stdout. The script runs in a subprocess with a 30-second timeout. Use this when the user asks you to compute something, check system state, manipulate files, or run any code.
  - **Available libraries: the Python standard library only, plus `requests`.** Third-party packages such as `yfinance`, `pandas`, `numpy`, `bs4`/`beautifulsoup4`, `selenium`, etc. are **NOT installed** — importing them fails. Use `urllib.request` or `requests` for HTTP, and `json` to parse responses.
  - Print a short, already-formatted answer, not raw data structures — the output is summarized for the user afterward.
  - On failure, print the HTTP status code or exception message — NEVER a generic "could not retrieve" message. The error is explained to the user and used to retry better.
