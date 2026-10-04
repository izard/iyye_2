#!/usr/bin/env python3
# Copyright 2026 Alexander Komarov
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""
Telegram Actuator - Sends messages back to Telegram using the bot API directly.

Accepts either:
- A plain string payload (sent to the default chat id from TELEGRAM_DEFAULT_CHAT_ID)
- A JSON-encoded payload: {"text": "...", "chat_id": 123456}
"""

import json
import logging
import os

from iyye_base import BaseActuator

log = logging.getLogger("Iyye.Actuators.Telegram")

_API_BASE = "https://api.telegram.org/bot{token}/sendMessage"


class TelegramActuator(BaseActuator):
    """
    Sends messages to Telegram via the Bot HTTP API (requests, no asyncio).
    Uses TELEGRAM_BOT_TOKEN and optionally TELEGRAM_DEFAULT_CHAT_ID env vars.
    """

    def __init__(self):
        self.name = "TelegramActuator"
        self._token: str = os.getenv("TELEGRAM_BOT_TOKEN", "")
        self._default_chat_id: int | None = None
        env_chat_id = os.getenv("TELEGRAM_DEFAULT_CHAT_ID")
        if env_chat_id:
            try:
                self._default_chat_id = int(env_chat_id)
            except ValueError:
                pass

    def send_typing(self, chat_id=None) -> bool:
        """Best-effort "typing…" chat action — mediated here so the ONLY
        Telegram HTTP caller is this actuator (chat streams previously posted
        it directly, bypassing the actuator layer entirely).  Not a message,
        so the content guardrails don't apply, but the sleep stopped-gate
        does: an asleep Iyye sends no outward signals of any kind.  The HTTP
        POST runs on a daemon thread (a blocking 5s timeout here once stalled
        every Telegram turn); returns True when the send was dispatched."""
        if getattr(self, '_stopped', False):
            return False
        chat_id = chat_id or self._default_chat_id
        if not (self._token and chat_id):
            return False

        def _post(token=self._token, cid=chat_id):
            try:
                import requests
                requests.post(
                    f"https://api.telegram.org/bot{token}/sendChatAction",
                    json={"chat_id": cid, "action": "typing"},
                    timeout=5,
                )
            except Exception:
                pass  # cosmetic signal — never worth a warning

        import threading
        threading.Thread(target=_post, name="tg_typing", daemon=True).start()
        return True

    def _do_actuate(self, payload: str) -> bool:
        """
        Send a message to Telegram.

        payload can be:
          - plain string  → sent to default chat
          - JSON string   → {"text": "...", "chat_id": 123} for explicit routing
        """
        text = payload
        chat_id = self._default_chat_id

        try:
            data = json.loads(payload)
            if isinstance(data, dict):
                text = data.get("text", payload)
                if data.get("chat_id"):
                    chat_id = int(data["chat_id"])
                    self._default_chat_id = chat_id  # remember for next call
        except (json.JSONDecodeError, ValueError):
            pass  # plain string

        if not chat_id:
            log.warning("TelegramActuator: no chat_id, cannot send: %s", text[:60])
            return False

        if not self._token:
            log.error("TelegramActuator: TELEGRAM_BOT_TOKEN not set")
            return False

        try:
            import requests
            url = _API_BASE.format(token=self._token)
            resp = requests.post(url, json={"chat_id": chat_id, "text": text}, timeout=10)
            if not resp.ok:
                log.error("TelegramActuator: HTTP %s: %s", resp.status_code, resp.text[:200])
                return False
            try:
                body = resp.json()
            except Exception:
                body = {}
            if not body.get("ok"):
                log.error(
                    "TelegramActuator: API error for chat_id=%s: %s",
                    chat_id,
                    body.get("description") or resp.text[:200],
                )
                return False
            log.info("TelegramActuator: sent to chat_id=%s", chat_id)
            return True
        except Exception as exc:
            log.error("TelegramActuator: send failed: %s", exc)
            return False
