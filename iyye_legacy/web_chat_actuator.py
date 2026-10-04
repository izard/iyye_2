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
Web Chat Actuator - Sends output to web chat UI.
"""

from iyye_base import BaseActuator

class WebChatActuator(BaseActuator):
    """
    Actuator that sends messages to the web chat UI.
    """
    
    def __init__(self):
        self.name = "web_chat_actuator"
    
    def _do_actuate(self, payload: str) -> bool:
        """
        Send payload to web chat UI.
        """
        try:
            # Import the broadcast function from web_chat_2
            import web_chat_2
            web_chat_2.broadcast_debug(payload)
            return True
        except Exception as e:
            import logging
            logging.getLogger("Iyye").error("WebChatActuator error: %s", e)
            return False

