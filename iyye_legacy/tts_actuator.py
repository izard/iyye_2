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
TTS Actuator — speaks text aloud on macOS using the built-in `say` command.

Non-blocking: speech runs in a background process.  If a new response arrives
while the previous one is still playing, the old speech is interrupted.
"""

import logging
import subprocess

from iyye_base import BaseActuator

log = logging.getLogger("Iyye.Actuators.TTS")

_SAY = "/usr/bin/say"


class TTSActuator(BaseActuator):
    """
    Speaks text using the macOS `say` command.

    A new call interrupts any currently running speech so responses
    never queue up and play long after they are relevant.
    """

    def __init__(self, voice: str = "Samantha", rate: int = 180) -> None:
        self.name = "tts_actuator"
        self._voice = voice
        self._rate = rate          # words per minute (macOS default ≈ 175)
        self._proc: subprocess.Popen | None = None

    def _do_actuate(self, payload: str) -> bool:
        text = payload.strip()
        if not text:
            return True

        # Interrupt previous speech if still running.
        if self._proc is not None and self._proc.poll() is None:
            self._proc.kill()
            self._proc = None

        try:
            args = [_SAY, "-v", self._voice, "-r", str(self._rate), text]
            self._proc = subprocess.Popen(
                args,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            log.info("TTS: speaking %d chars via voice=%s", len(text), self._voice)
            return True
        except FileNotFoundError:
            log.error("TTS: /usr/bin/say not found — macOS only")
            return False
        except Exception as exc:
            log.error("TTS: error: %s", exc)
            return False

    def graceful_stop(self) -> None:
        """Sleep must silence speech, not just future speech: kill any
        in-flight ``say`` process (HLD: actuators stop during sleep — a
        sentence started at wind-down must not keep talking into sleep)."""
        super().graceful_stop()
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.kill()
            except Exception as exc:
                log.debug("TTS: kill on stop failed: %s", exc)
        self._proc = None
