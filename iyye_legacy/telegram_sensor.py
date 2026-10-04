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
Telegram sensor — polls the Telegram Bot API directly via HTTP (no MCP subprocess).

Uses a background thread (same pattern as HardwareSensor) so new messages are
fetched independently of main-loop ticks.  The update cursor is persisted in a
small JSON sidecar file so restarts don't re-deliver already-seen messages.

Required env:
  TELEGRAM_BOT_TOKEN=123456:ABC...

Optional env:
  TELEGRAM_DEFAULT_CHAT_ID=<int>  — stored on first message if absent
  TELEGRAM_ALLOWED_CHAT_IDS=123,456  — comma-separated allowlist (empty = allow all)
  TELEGRAM_STATE_PATH=./telegram_sensor_state.json
"""

import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from iyye_base import PROJECT_ROOT, BaseSensorQueue

log = logging.getLogger("Iyye.Sensors.Telegram")

_API_BASE = "https://api.telegram.org/bot{token}/{method}"


class TelegramSensor(BaseSensorQueue):
    """
    Polls Telegram getUpdates in a background thread and pushes individual
    message dicts onto the sensor queue.

    Each queued item has the shape::

        {
            "update_id": int,
            "message_id": int,
            "chat_id": int,
            "user_id": int | None,
            "username": str | None,
            "first_name": str | None,
            "date_unix": int | None,
            "text": str,
            "timestamp": "<iso8601>",
        }
    """

    def __init__(
        self,
        poll_interval: float = 5.0,
        maxlen: int = 10_000,
        # kept for compatibility with discovery/config that passes these kwargs
        mcp_script_path: str = "./iyye_io/mcp_telegram.py",
    ):
        super().__init__(name="telegram_sensor", maxlen=maxlen)

        self.poll_interval = poll_interval
        self._token: str = os.getenv("TELEGRAM_BOT_TOKEN", "")
        self._running = False
        self._executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="tg_sensor"
        )

        # Allowed-chat filter (empty set = accept all)
        raw_allowed = os.getenv("TELEGRAM_ALLOWED_CHAT_IDS", "")
        self._allowed: Set[int] = set()
        for part in raw_allowed.split(","):
            s = part.strip()
            if s:
                try:
                    self._allowed.add(int(s))
                except ValueError:
                    pass

        # At-least-once cursor (issue #3).  Telegram drops an update only once
        # getUpdates is called with a higher offset, so the getUpdates offset
        # is the durable "safe to drop" point — and it must advance ONLY after
        # the brain has *processed* a message (via mark_processed), never at
        # fetch or at queue-drain.  A crash before processing therefore leaves
        # the message un-confirmed and Telegram re-delivers it on the next poll.
        #   _confirmed_id  — persisted; getUpdates offset = _confirmed_id + 1.
        #                    Highest update past which everything is processed.
        #   _max_fetched   — highest update_id seen this session.
        #   _inflight      — fetched + queued but not yet processed.
        #   _processed     — processed (or filtered) but still above
        #                    _confirmed_id because a lower update is still
        #                    in-flight; used to dedup re-deliveries and to let
        #                    _confirmed_id advance only past a contiguous
        #                    processed prefix (so out-of-order acks never drop
        #                    an unprocessed lower update).
        raw_state_path = Path(os.getenv("TELEGRAM_STATE_PATH", "telegram_sensor_state.json"))
        self._state_path = raw_state_path if raw_state_path.is_absolute() else PROJECT_ROOT / raw_state_path
        self._cursor_lock = threading.Lock()
        self._confirmed_id: int = 0
        self._max_fetched: int = 0
        self._inflight: Set[int] = set()
        self._processed: Set[int] = set()
        self._default_chat_id: Optional[int] = None
        self._load_state()

        # Allow env override of default chat id (takes precedence over saved state)
        env_chat = os.getenv("TELEGRAM_DEFAULT_CHAT_ID")
        if env_chat:
            try:
                self._default_chat_id = int(env_chat)
            except ValueError:
                pass

    # ------------------------------------------------------------------
    # Persistent state helpers
    # ------------------------------------------------------------------

    def _load_state(self) -> None:
        try:
            if self._state_path.exists():
                data = json.loads(self._state_path.read_text())
                # Resume from the last CONFIRMED (processed) update.
                self._confirmed_id = int(data.get("last_update_id", 0))
                self._max_fetched = self._confirmed_id
                chat = data.get("default_chat_id")
                if chat is not None:
                    self._default_chat_id = int(chat)
        except Exception as exc:
            log.warning("Could not load Telegram sensor state: %s", exc)

    def _save_state(self, confirmed_id: int) -> bool:
        """Atomically persist *confirmed_id* (tmp + rename).  Returns True on a
        durable write, False on failure.  The caller must NOT expose a cursor
        it could not persist — confirming an update at Telegram is irreversible
        (issue: cursor exposed before persistence)."""
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._state_path.with_name(self._state_path.name + ".tmp")
            tmp.write_text(
                json.dumps(
                    {
                        "last_update_id": confirmed_id,
                        "default_chat_id": self._default_chat_id,
                    }
                )
            )
            tmp.replace(self._state_path)   # atomic
            return True
        except Exception as exc:
            log.warning("Could not save Telegram sensor state: %s", exc)
            return False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start_collection(self) -> None:
        """Start background polling thread."""
        if not self._token:
            log.error("TELEGRAM_BOT_TOKEN not set — Telegram sensor disabled")
            return
        if not self._running:
            self._running = True
            self._executor.submit(self._poll_loop)
            log.info(
                "Telegram sensor started (interval=%.1fs, offset=%d)",
                self.poll_interval,
                self._confirmed_id + 1,
            )

    def stop_collection(self) -> None:
        """Stop background polling."""
        self._running = False
        self._executor.shutdown(wait=False)
        log.info("Telegram sensor stopped")

    # ------------------------------------------------------------------
    # Background polling
    # ------------------------------------------------------------------

    def _poll_loop(self) -> None:
        """Background thread: calls getUpdates and pushes messages."""
        while self._running:
            try:
                messages = self._fetch_updates()
                for msg in messages:
                    self.push(msg)
                    log.debug(
                        "Telegram: queued message from chat_id=%s text=%r",
                        msg.get("chat_id"),
                        (msg.get("text") or "")[:80],
                    )
            except Exception as exc:
                log.error("Telegram poll loop error: %s", exc)
            time.sleep(self.poll_interval)

    def _fetch_updates(self) -> List[Dict[str, Any]]:
        """
        Call getUpdates with offset = last_update_id + 1.
        Returns a list of normalised message dicts.
        """
        import requests

        with self._cursor_lock:
            offset = self._confirmed_id + 1
        url = _API_BASE.format(token=self._token, method="getUpdates")
        try:
            resp = requests.get(
                url,
                params={
                    "offset": offset,
                    "limit": 10,
                    "timeout": 0,
                    "allowed_updates": json.dumps(["message"]),
                },
                timeout=10,
            )
        except Exception as exc:
            log.warning("Telegram getUpdates network error: %s", exc)
            return []

        if not resp.ok:
            log.warning(
                "Telegram getUpdates HTTP %s: %s", resp.status_code, resp.text[:200]
            )
            return []

        try:
            data = resp.json()
        except Exception as exc:
            log.warning("Telegram getUpdates JSON parse error: %s", exc)
            return []

        if not data.get("ok"):
            log.warning("Telegram getUpdates not ok: %s", data)
            return []

        out: List[Dict[str, Any]] = []
        with self._cursor_lock:
            for upd in data.get("result", []):
                uid = upd.get("update_id", 0)
                # Skip re-deliveries: already processed (<= confirmed), already
                # queued (in-flight), or already filtered/processed-pending.
                if (uid <= self._confirmed_id or uid in self._inflight
                        or uid in self._processed):
                    continue
                self._max_fetched = max(self._max_fetched, uid)

                msg = upd.get("message")
                chat_id = (msg or {}).get("chat", {}).get("id")
                # Filtered (non-message or disallowed chat): never queued, so it
                # would never be mark_processed — confirm it directly so the
                # offset can advance past it instead of re-delivering forever.
                if not msg or (self._allowed and chat_id not in self._allowed):
                    self._processed.add(uid)
                    continue

                user = msg.get("from") or {}
                item: Dict[str, Any] = {
                    "update_id": uid,
                    "message_id": msg.get("message_id"),
                    "chat_id": chat_id,
                    "user_id": user.get("id"),
                    "username": user.get("username"),
                    "first_name": user.get("first_name"),
                    "date_unix": msg.get("date"),
                    "text": msg.get("text") or msg.get("caption") or "",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                out.append(item)
                self._inflight.add(uid)

                if self._default_chat_id is None and chat_id is not None:
                    self._default_chat_id = chat_id
                    log.info("Telegram sensor: learned default chat_id=%s", chat_id)

            # Filtered updates may let the offset move forward immediately.
            self._advance_confirmed_locked()

        return out

    # ------------------------------------------------------------------
    # Confirmation — advance the persisted cursor only after PROCESSING
    # ------------------------------------------------------------------

    def mark_processed(self, update_ids: List[int]) -> None:
        """Confirm that the brain has fully handled *update_ids* (called by the
        consuming stream after a reply is sent).  Only now may the durable
        cursor advance past them so the next getUpdates lets Telegram drop them.

        Out-of-order safe: the cursor advances only past a contiguous processed
        prefix, so acking a higher update first never confirms (and thus drops)
        a still-unprocessed lower one."""
        with self._cursor_lock:
            changed = False
            for uid in update_ids:
                if isinstance(uid, int) and uid in self._inflight:
                    self._inflight.discard(uid)
                    self._processed.add(uid)
                    changed = True
            if changed:
                self._advance_confirmed_locked()

    def _advance_confirmed_locked(self) -> None:
        """Advance _confirmed_id as far as is safe — to one below the lowest
        still-in-flight update, or to the highest fetched when nothing is in
        flight.  Caller holds ``_cursor_lock``.

        Persist the candidate cursor BEFORE assigning it: the getUpdates offset
        derives from _confirmed_id, so the next poll would tell Telegram to drop
        these updates.  If the durable write fails we must NOT advance — leave
        _confirmed_id unchanged so Telegram re-delivers and we retry next time
        (otherwise a swallowed save loses the messages permanently)."""
        new = (min(self._inflight) - 1) if self._inflight else self._max_fetched
        if new <= self._confirmed_id:
            return
        if not self._save_state(new):
            return  # not durable — keep the old cursor; Telegram re-delivers
        self._confirmed_id = new
        # Drop now-confirmed ids from the pending set.
        self._processed = {p for p in self._processed if p > self._confirmed_id}

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def get_state(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "running": self._running,
            "queue_size": len(self),
            "last_update_id": self._confirmed_id,   # persisted resume point
            "max_fetched": self._max_fetched,        # in-memory fetch position
            "inflight": len(self._inflight),         # fetched, not yet processed
            "default_chat_id": self._default_chat_id,
        }
