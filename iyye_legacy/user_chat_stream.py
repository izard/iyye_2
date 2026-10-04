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
# streams/user_chat_stream.py
#!/usr/bin/env python3
"""
User Chat Stream - Processes incoming user messages via LLM and sends responses.

This is the primary conscious stream created by StreamFactory when sensor
queues (web_chat, telegram, microphone) contain new messages.
"""

import json
import logging
import re
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple, TYPE_CHECKING

from iyye_base import PROJECT_ROOT, ProcessingStream
from llm_scheduler import LLMCall, LLMConsumerMixin
from tool_use import ToolUseMixin

if TYPE_CHECKING:
    from main_loop import IyyeBrain

log = logging.getLogger("Iyye")


class UserChatStream(ToolUseMixin, LLMConsumerMixin, ProcessingStream):
    """
    Processes incoming user messages with LLM and routes responses to actuators.
    Can become conscious (priority 5, higher than self-reflection's 3).

    LLM calls go through the async scheduler so the main loop never blocks on a
    chat decode.  A turn spans up to two LLM stages — 'generate' (the reply)
    and, if the reply carries a python ACTION, 'rephrase' (tool output → answer)
    — tracked in ``self._turn``.  One in-flight job per stream gives per-contact
    response ordering for free (each contact has its own UserChatStream).
    """

    # Instances are created on-demand by StreamFactory, not by the stream loader.
    _factory_created: bool = True

    def __init__(
        self,
        name: str,
        messages: List[Any],
        brain: "IyyeBrain",
        sensor_name: str = "",
    ):
        super().__init__(name=name)
        self.brain = brain
        self.priority = 5
        self._can_be_conscious = True
        self._sensor_name: str = sensor_name  # e.g. "TelegramSensor", "web_chat"
        self._last_chat_id: Optional[int] = None  # for telegram reply routing
        self._last_user_id: Optional[int] = None   # telegram user id (distinct from chat in groups)
        self._last_sender_name: Optional[str] = None  # display name of the last sender
        self._pending_messages: List[Any] = list(messages)
        # HLD: "local web chat … user is assumed trusted"; "telegram …
        # Users assumed not trusted, unless instructed by trusted user."
        self._trusted: bool = self._is_trusted_source(sensor_name)
        # In-flight chat turn across async LLM stages, or None when idle.
        # Shape: {"stage": "generate"|"rephrase", "user_text", "source", ...}.
        self._turn: Optional[Dict[str, Any]] = None
        # Consecutive transient-failure retries for the head message; reset
        # whenever a message is committed (popped).
        self._generate_retries: int = 0
        # Recall results from the current turn, stashed for usefulness
        # attribution once the reply is produced (#5 retrieval-quality signal).
        self._last_recall: List[Any] = []
        # Fallback apologies sent (generate failed past its retry budget) —
        # read by self_reflection's cognitive-health sweep.
        self._fallbacks_sent: int = 0
        # Armed after a fact-using turn; the next message scores satisfaction.
        self._pending_feedback: Optional[Dict[str, Any]] = None

        # Populate input_history so _select_conscious_for_interrupt finds this stream
        for msg in messages:
            text, _, _, _ = self._extract_text_and_chat_id(msg)
            if text:
                src = sensor_name or (msg.get('source', 'sensor') if isinstance(msg, dict) else 'sensor')
                self.add_input(text, source=src)

    # ------------------------------------------------------------------
    # Trust
    # ------------------------------------------------------------------

    @staticmethod
    def _is_trusted_source(sensor_name: str) -> bool:
        """HLD: web_chat is local → trusted.  Everything else → untrusted."""
        return 'web_chat' in sensor_name.lower() or 'webchat' in sensor_name.lower()

    def _check_contact_trusted(self) -> bool:
        """Re-evaluate trust for the current contact via Theory of Mind.

        A contact starts untrusted but can be promoted to trusted when a
        trusted user instructs Iyye (e.g. "trust Jacob").  The ToM stream
        stores this flag per contact.
        """
        if self._is_trusted_source(self._sensor_name):
            return True
        tom = self.brain.theory_of_mind()
        if tom is None:
            return False
        contact_id = tom.make_contact_id(
            self._last_sender_name or 'unknown',
            self._sensor_name,
            self._last_chat_id,
            self._last_user_id,
        )
        return tom.is_contact_trusted(contact_id)

    def _execute_trust_action(self, action: Dict[str, Any]) -> Optional[str]:
        """Handle ACTION: {"type": "trust"/"untrust", "contact": "<name or telegram_<id>>"}.

        SECURITY: the ONLY way a remote (Telegram) user becomes trusted is an
        explicit command from the local web chat (127.0.0.1, the machine
        owner).  The capability profile in execute() already restricts this
        action to the local-owner tier; the source check here is
        defence-in-depth.  The old PIN-style self-verification path (and the
        last-resort "trust the current sender" fallback) was removed — it let
        an untrusted sender talk the LLM into granting them trust.

        Matches contacts by explicit contact id (``telegram_<id>``) or by
        display-name substring.  When multiple contacts share a display name
        all of them are updated.  The contact must already exist (i.e. has
        messaged at least once) — trust is never granted to an account Iyye
        has never seen.
        """
        if not self._is_trusted_source(self._sensor_name):
            self.add_to_log(
                f"SECURITY: blocked trust action from non-local source "
                f"'{self._sensor_name}' — trust changes are local-web-chat only"
            )
            return None
        target_name = (action.get('contact') or '').strip().lower()
        if not target_name:
            self.add_to_log("Trust action missing 'contact' field — ignored")
            return None
        granting = action['type'] == 'trust'
        tom = self.brain.theory_of_mind()
        if tom is None:
            self.add_to_log("Trust action failed: Theory of Mind stream not available")
            return None

        updated = []
        for cid, display in tom.find_contacts(target_name):
            if tom.set_contact_trusted(cid, granting):
                updated.append(f"{display} ({cid})")

        if updated:
            verb = "Granted" if granting else "Revoked"
            summary = ", ".join(updated)
            self.add_to_log(f"ACTION {verb.lower()} trust for {summary}")
            return f"{verb} trust for {summary}."

        self.add_to_log(f"Trust action failed for '{target_name}' — no matching contact")
        return (
            f"I don't know any contact matching '{target_name}' yet. "
            f"They need to message me at least once before I can "
            f"{'trust' if granting else 'untrust'} them."
        )

    # ------------------------------------------------------------------
    # LLM management actions
    # ------------------------------------------------------------------

    def _execute_llm_action(self, action: Dict[str, Any]) -> Optional[str]:
        """Handle ACTION: {"type": "llm", "command": "start|stop|use_for_chat", "model": "..."}.

        Dispatches to LlmManagementStream via inter-stream messages and/or
        sets a role override on the LLM router.
        """
        command = (action.get('command') or '').strip().lower()
        model_name = (action.get('model') or '').strip()
        if not command or not model_name:
            return None

        if command == 'start':
            # Find registry entry to get the script name
            router = getattr(self.brain, 'llm_router', None)
            if router is None:
                return "[LLM] Router not available."
            entry = next((m for m in router._registry if m['name'] == model_name), None)
            if entry is None:
                return f"[LLM] Unknown model '{model_name}'."
            from messaging import Messages
            self.brain.post_message("llm_management",
                                    Messages.start_llm(script=entry["script"]))
            self.add_to_log(f"Requested LLM start: {model_name}")
            return f"[LLM] Starting {model_name} — this may take a minute."

        elif command == 'stop':
            from messaging import Messages
            self.brain.post_message("llm_management",
                                    Messages.stop_llm(name=model_name))
            self.add_to_log(f"Requested LLM stop: {model_name}")
            return f"[LLM] Stopping {model_name}."

        elif command == 'use_for_chat':
            router = getattr(self.brain, 'llm_router', None)
            if router is None:
                return "[LLM] Router not available."
            if not router.set_role_override("chat", model_name):
                return f"[LLM] Unknown model '{model_name}'."
            self.add_to_log(f"Switched chat model to {model_name}")
            return f"[LLM] Chat responses will now use {model_name}."

        else:
            return f"[LLM] Unknown command '{command}'."

    def _execute_persona_action(self, action: Dict[str, Any]) -> Optional[str]:
        """Handle ACTION: {"type": "persona", "name": "..."}.

        Local-web-chat only (defence-in-depth; the capability profile already
        denies it for remote senders): persona linking propagates trust across
        accounts, so it is restricted to the same channel as trust changes.
        """
        if not self._is_trusted_source(self._sensor_name):
            self.add_to_log(
                f"SECURITY: blocked persona action from non-local source "
                f"'{self._sensor_name}' — persona linking is local-web-chat only"
            )
            return None
        tom = self.brain.theory_of_mind()
        if tom is None:
            return "[Persona] Theory of Mind stream not available."
        name = (action.get('name') or '').strip()
        if not name:
            return "[Persona] No display name provided."
        if tom.link_by_display_name(name):
            return f"[Persona] Linked all contacts named '{name}' into one persona."
        return f"[Persona] Found fewer than 2 contacts named '{name}' — nothing to link."

    # ------------------------------------------------------------------
    # Long term plan actions
    # ------------------------------------------------------------------

    def _execute_plan_action(self, action: Dict[str, Any]) -> Optional[str]:
        """Handle ACTION: {"type": "plan", "command": "create|approve|abandon|list", ...}.

        SECURITY: ``source`` is stamped from the channel this stream serves
        (``self._sensor_name``), never from LLM output, so a remote sender
        cannot forge a local-owner approval.  approve/abandon are local-web-
        chat only (defence-in-depth — PlanStore gates on source again); a
        remote *trusted* contact may create a plan, but it lands in
        ``proposed`` state for the owner to approve.
        """
        command = (action.get('command') or '').strip().lower()
        local = self._is_trusted_source(self._sensor_name)
        source = 'web_chat' if local else (self._sensor_name or 'remote_chat')
        from messaging import Messages

        if command == 'create':
            goal = (action.get('goal') or '').strip()
            if not goal:
                return "[Plan] No goal provided."
            self.brain.post_message("planner", Messages.plan_propose(
                goal=goal, source=source,
                deadline=action.get('deadline'),
            ))
            self.add_to_log(f"Proposed plan: {goal[:80]}")
            if local:
                return f"[Plan] Created and activated: {goal[:120]}"
            return (f"[Plan] Proposed: {goal[:120]} — the owner must approve "
                    f"it from the local web chat before it runs.")

        if command in ('approve', 'abandon'):
            if not local:
                self.add_to_log(
                    f"SECURITY: blocked plan {command} from non-local source "
                    f"'{self._sensor_name}' — plan lifecycle is local-web-chat only"
                )
                return None
            plan_id = (action.get('plan_id') or '').strip()
            if not plan_id:
                return "[Plan] No plan_id provided."
            msg = (Messages.plan_approve(plan_id=plan_id, source=source)
                   if command == 'approve'
                   else Messages.plan_abandon(plan_id=plan_id, source=source))
            self.brain.post_message("planner", msg)
            verb = 'Approved' if command == 'approve' else 'Abandoned'
            self.add_to_log(f"{verb} plan '{plan_id}'")
            return f"[Plan] {verb} '{plan_id}'."

        if command == 'list':
            store = getattr(self.brain, 'plan_store', None)
            if store is None:
                return "[Plan] Plan store not available."
            plans = store.all_plans()
            if not plans:
                return "[Plan] No long term plans."
            return "[Plan] Current plans:\n" + "\n".join(
                p.summary_line() for p in plans
            )

        return f"[Plan] Unknown command '{command}'."

    # ------------------------------------------------------------------
    # Message extraction helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_text_and_chat_id(
        message: Any,
    ) -> Tuple[str, Optional[int], Optional[str], Optional[int]]:
        """
        Extract text, chat_id, sender display name, and user_id from any
        message format.

        Returns: (text, chat_id, sender_name, user_id)

        sender_name is the human-readable name of the person who sent the
        message: first_name if available, otherwise @username, otherwise None.
        user_id is the Telegram user id (distinct from chat_id in groups).

        Handles:
        - Plain string (web_chat)
        - Direct Telegram message dict: {"text": "...", "chat_id": 123, ...}
          (produced after call_tool() unwraps content[0]["text"] and
          _expand_mcp_batches() splits the batch)
        - Generic dict with 'data' key
        - Legacy structuredContent wrapper (kept for safety)
        """
        if isinstance(message, str):
            return message.strip(), None, None, None

        if not isinstance(message, dict):
            return str(message).strip(), None, None, None

        # Direct Telegram message dict — top-level "text" and "chat_id"
        if 'chat_id' in message:
            text = str(message.get('text') or '').strip()
            chat_id = message.get('chat_id')
            first_name = message.get('first_name') or ''
            username = message.get('username') or ''
            sender_name = first_name or (f'@{username}' if username else None)
            user_id = message.get('user_id')
            return text, int(chat_id) if chat_id else None, sender_name, \
                int(user_id) if user_id else None

        # Legacy structuredContent wrapper
        sc = message.get('structuredContent', {})
        if isinstance(sc, dict):
            msgs = sc.get('messages', [])
            if msgs and isinstance(msgs, list):
                first = msgs[0]
                text = first.get('text', '').strip()
                chat_id = first.get('chat_id')
                first_name = first.get('first_name') or ''
                username = first.get('username') or ''
                sender_name = first_name or (f'@{username}' if username else None)
                user_id = first.get('user_id')
                return text, chat_id, sender_name, \
                    int(user_id) if user_id else None
            if 'count' in sc:
                return '', None, None, None

        # Generic dict with 'data' (web_chat format)
        data = message.get('data', '')
        return str(data).strip() if data else '', None, None, None

    # ------------------------------------------------------------------
    # Main execution
    # ------------------------------------------------------------------

    def execute(self, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Async chat turn: poll a finished LLM stage and apply it, else (when
        idle) start the next pending message's turn.  The blocking LLM call(s)
        run on a scheduler worker; the main loop is never blocked."""
        # A trusted-user python tool is running on its own thread — check it
        # first (it isn't a scheduler job, so the LLM poll/busy logic below
        # would mis-handle it and reset the turn).
        if self._turn is not None and self._turn.get("stage") == "python_running":
            return self._poll_python(context)
        # Apply a finished LLM stage.
        result = self._llm_poll()
        if result is not None:
            return self._on_llm_result(result, context)
        # A stage is still running — wait for it.
        if self._llm_busy():
            return None
        # Not busy and no result, but a turn is still recorded → its result was
        # dropped (e.g. the wake epoch rotated across a sleep).  Reset so the
        # message (still queued) is reprocessed from scratch.
        if self._turn is not None:
            self.add_to_log("Chat turn interrupted (LLM result dropped) — retrying")
            self._turn = None
        return self._begin_next_turn(context)

    def _begin_next_turn(self, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Peek the next real message, build the prompt, submit the 'generate'
        stage.  The message is left in the queue (not popped) until its result
        is applied, so a dropped/declined submission retries it cleanly."""
        # Drain empty/unparseable messages (peek then pop).  An empty message
        # is "processed" (discarded), so acknowledge it to the source sensor so
        # Telegram stops re-delivering it.
        user_text = ''
        chat_id = sender_name = user_id = None
        update_id = None
        while self._pending_messages and not user_text:
            message = self._pending_messages[0]  # peek
            user_text, chat_id, sender_name, user_id = self._extract_text_and_chat_id(message)
            update_id = message.get('update_id') if isinstance(message, dict) else None
            if not user_text:
                self._ack_source_message(update_id)
                self._pending_messages.pop(0)

        if not user_text:
            # Queue empty and all inputs answered — retire the stream.
            if len(self.input_history) > 0 and len(self.output_history) >= len(self.input_history):
                brain = getattr(self, 'brain', None)
                if brain is not None:
                    try:
                        self.request_retire("all messages processed")
                        brain.streams.remove(self)
                        log.debug("UserChatStream '%s' retired (all messages processed)", self.name)
                    except ValueError:
                        pass
            return None

        if chat_id:
            self._last_chat_id = chat_id
        if user_id:
            self._last_user_id = user_id
        if sender_name:
            self._last_sender_name = sender_name

        source = self._sensor_name or self.name
        sender_label = self._last_sender_name or source
        self.add_to_log(f"USER ({sender_label}): {user_text}")
        # Implicit feedback on the previous fact-using turn, read from this
        # new message (#5 retrieval-quality signal; shadow).
        self._emit_recall_feedback(user_text)

        # Re-evaluate trust so the prompt and later ACTION gating reflect any
        # change since construction (ToM may have (un)trusted this contact).
        self._trusted = self._check_contact_trusted()

        # Cooperative stop: if winding-down requested a stop, don't submit —
        # leave the message queued for the next wake cycle.
        try:
            self.checkpoint()
        except StopIteration:
            return None

        # Build the prompt context (main-thread reads: memory search, history).
        adenosine = context.get('adenosine', 1.0)
        active_streams = len(context.get('streams', []))
        sr_snapshot = (context.get('self_reflection_state')
                       or self.brain.self_reflection_snapshot())
        history = self._build_history() or "(none)"
        variables = dict(
            user_message=user_text,
            source=source,
            sender_name=self._last_sender_name or "unknown",
            conversation_history=history,
            stm_facts=self._build_stm_context(),
            ltm_facts=self._build_ltm_context(user_text),
            system_state=self._build_system_state(adenosine, active_streams, sr_snapshot),
            system_description=self._read_system_description(),
            contact_context=self._get_contact_context(),
            available_actions=self._build_available_actions(user_text, history),
        )

        # Typing indicator so the user knows a reply is on the way.
        self._send_typing_indicator(context)

        prompt_chars = sum(len(str(v)) for v in variables.values())
        submitted = self._llm_submit(
            role=self._chat_role(),
            kind=("chat_conscious" if self.is_conscious else "chat_subconscious"),
            conscious=self.is_conscious,
            call=LLMCall.from_file("chat_response", **variables),
            client_kwargs={"no_think": True},
            task=self._chat_task(
                prompt_chars, output_tokens=200,
                quality_need=self._GENERATE_QUALITY,
                budget_s=self._GENERATE_BUDGET_S),
        )
        if not submitted:
            # Scheduler paused/absent — leave the message queued, retry later.
            return None
        self._turn = {"stage": "generate", "user_text": user_text,
                      "source": source, "update_id": update_id,
                      # Plan social delivery: confirm "Iyye delivered to
                      # <contact>" on a successful send (settles the promise
                      # the executor recorded at handoff).
                      "deliver_to": (message.get("_deliver_to")
                                     if isinstance(message, dict) else None)}
        return {"type": "chat_submitted", "source": source}

    def _build_available_actions(self, user_text: str, history: str) -> str:
        """Per-turn action docs: full cards relevant to this conversation plus
        a one-line index of everything else this sender may use.

        The capability profile filters *display* (an untrusted telegram
        sender's prompt carries no trust/persona/python docs at all — smaller
        injection surface); execution gating in _handle_action runs
        regardless of what was shown.
        """
        try:
            from action_registry import select_actions
            from capabilities import chat_profile
            profile = chat_profile(
                self._trusted, local=self._is_trusted_source(self._sensor_name),
            )
            dynamic = {}
            router = getattr(self.brain, 'llm_router', None)
            if router is not None:
                try:
                    dynamic['llm_models'] = ", ".join(
                        m['name'] for m in router._registry)
                except Exception:
                    pass
            block = select_actions(
                user_text, history=history, profile=profile, dynamic=dynamic,
            )
            return block or "(no actions available to this sender)"
        except Exception as exc:
            log.warning("Action card selection failed: %s", exc)
            return "(action list unavailable this turn)"

    def _ack_source_message(self, update_id: Optional[int]) -> None:
        """Tell the originating cursor-based sensor (Telegram) that a message
        is fully processed, so it can advance its acknowledgment and Telegram
        can drop it.  No-op for sources without an update_id / mark_processed
        (e.g. web chat).  This is what makes Telegram ingestion at-least-once:
        the cursor advances only after the message is actually handled."""
        if not update_id:
            return
        sensors = getattr(getattr(self, 'brain', None), 'sensors', None)
        sensor = sensors.get(self._sensor_name) if isinstance(sensors, dict) else None
        mark = getattr(sensor, 'mark_processed', None)
        if callable(mark):
            try:
                mark([update_id])
            except Exception as exc:
                log.debug("UserChatStream: mark_processed failed: %s", exc)

    def _chat_role(self) -> str:
        """Web chat is local/admin — use the fast model so the heavy model stays
        free for Telegram and subconscious streams.  Telegram uses 'chat'."""
        return "fast" if self._is_trusted_source(self._sensor_name) else "chat"

    # Interactive-chat SLAs the router scores models against (latency-budget
    # routing, not just role): generate is a real reply (some quality needed);
    # rephrase is a small transform of tool output (speed over quality).
    _GENERATE_BUDGET_S = 8.0
    _GENERATE_QUALITY = 0.45
    _REPHRASE_BUDGET_S = 6.0
    _REPHRASE_QUALITY = 0.3

    def _chat_task(self, prompt_chars: int, *, output_tokens: int,
                   quality_need: float, budget_s: float) -> Dict[str, Any]:
        """Build the per-turn task spec the router uses to pick a model by
        latency budget + quality, instead of falling back to the permissive
        60s default.  A conscious turn is the user actively waiting (max
        urgency); a subconscious one is lower priority."""
        return {
            "prompt_tokens": max(50, int(prompt_chars) // 4),  # ~4 chars/token
            "expected_output_tokens": output_tokens,
            "quality_need": quality_need,
            "latency_budget_s": budget_s,
            "urgency": 0.9 if self.is_conscious else 0.6,
        }

    def _on_llm_result(self, result, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Dispatch a completed stage to its handler."""
        stage = (self._turn or {}).get("stage")
        if stage == "generate":
            return self._on_generate_result(result, context)
        if stage == "rephrase":
            return self._on_rephrase_result(result, context)
        # No recorded turn for this result — stale; ignore.
        self._turn = None
        return None

    def _on_generate_result(self, result, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Apply the reply: send it, report the interaction, then run any gated
        ACTION (which may open a second 'rephrase' stage)."""
        turn = self._turn or {}
        user_text = turn.get("user_text", "")
        source = turn.get("source", self._sensor_name or self.name)

        if result.discarded:
            # Turn cut off (cycle rotated across sleep).  Leave the message
            # queued so it is reprocessed; reset turn state.
            self._turn = None
            return None

        if not result.ok and self._generate_retries < self._MAX_GENERATE_RETRIES:
            # Transient failure — typically the LLM server mid-restart
            # (model_unavailable / connection exception / timeout), and
            # llm_management usually has it back within seconds (seen live:
            # fallback sent at 20:20:07, model up at 20:20:08).  Same
            # contract as the discarded path: leave the message queued so
            # the next tick rebuilds and resubmits the turn.  Budget-capped
            # so a persistently dead LLM still gets an apology, not silence.
            self._generate_retries += 1
            self._turn = None
            self.add_to_log(
                f"Generate failed ({result.error}) — retrying "
                f"({self._generate_retries}/{self._MAX_GENERATE_RETRIES})")
            log.warning("UserChatStream: generate failed (%s) — retry %d/%d",
                        result.error, self._generate_retries,
                        self._MAX_GENERATE_RETRIES)
            return None

        # Commit: remove the message we processed (still at the front).
        if self._pending_messages:
            self._pending_messages.pop(0)
        self._generate_retries = 0

        if not result.ok:
            response = self._fallback_message(result.error)
            action = None
            self._fallbacks_sent += 1
            log.warning("UserChatStream: generate failed (%s)", result.error)
        else:
            response, action = self._extract_action(result.text)
            self._journal_chat_quality(result, response, action)

        self.add_to_log(f"IYYE: {response}")
        self.add_output(response, target=source)
        # A plan delivery must reach the CONTACT'S OWN channel — no cross-
        # channel fallback (a Telegram message must not land on the local
        # console and then be recorded as delivered to the remote contact).
        deliver_to = turn.get("deliver_to")
        delivered = False
        if response:
            delivered = self._send_to_actuator(
                response, context,
                strict_channel=bool(deliver_to)) is True
        # Plan social delivery confirmation writes "Iyye delivered to
        # <contact>" (settling the executor's promise) ONLY when all of:
        #  - the LLM actually GENERATED the message (result.ok — never a
        #    fallback apology),
        #  - it reached the contact's own channel (delivered is True; strict
        #    routing above guarantees it wasn't a misroute).
        if deliver_to and delivered and result.ok and response:
            self._record_plan_delivery(deliver_to, response)
        self._report_interaction(user_text, response)
        self._mark_recall_used(user_text, response)

        # The message is now durably handled (reply sent / logged).  Ack it to
        # the source sensor so Telegram advances its cursor and stops
        # re-delivering — at-least-once: ack happens only after processing.
        self._ack_source_message(turn.get("update_id"))

        # Capability tier (HLD §9; issue #1): trust/untrust/persona are
        # local-web-chat only; trusted Telegram gets python/llm; untrusted gets
        # read-only lookups.  A PIN claim over Telegram never moves trust.
        from capabilities import chat_profile
        profile = chat_profile(
            self._trusted, local=self._is_trusted_source(self._sensor_name),
        )
        if action and not profile.allows(action.get('type')):
            self.add_to_log(
                f"Suppressed '{action.get('type')}' ACTION from source {source} "
                f"(profile={profile.name})"
            )
            action = None

        if action:
            staged = self._handle_action(action, user_text, context)
            if staged is not None:
                return staged  # a second LLM stage (rephrase) is now in flight

        self._turn = None
        return {"type": "chat_reply", "text": response, "source": source}

    def _handle_action(
        self, action: Dict[str, Any], user_text: str, context: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """Execute a gated ACTION.  Returns a non-None marker only when it has
        submitted a follow-up LLM stage (python → rephrase) so the turn stays
        open; otherwise returns None (turn complete)."""
        action_type = action.get('type')
        if action_type == 'python':
            # Run the (≤30s) subprocess on its own thread so it never blocks the
            # main loop.  execute() polls it via _poll_python and then submits
            # the async 'rephrase' stage once it finishes.
            code = action.get('code', '')
            t, holder = self._spawn_python_tool(code, context)
            self._background_threads = [x for x in self._background_threads if x.is_alive()]
            self._background_threads.append(t)
            self._turn = {"stage": "python_running", "user_text": user_text,
                          "source": self._sensor_name or self.name,
                          "py_thread": t, "py_holder": holder}
            return {"type": "chat_python_running"}
        if action_type in ('trust', 'untrust'):
            feedback = self._execute_trust_action(action)
            if feedback:
                self._send_to_actuator(feedback, context)
            # Refresh cached trust (e.g. the owner just revoked a contact this
            # stream serves).  Self-trust via the action is impossible —
            # trust changes are local-web-chat only.
            self._trusted = self._check_contact_trusted()
        elif action_type == 'llm':
            feedback = self._execute_llm_action(action)
            if feedback:
                self._send_to_actuator(feedback, context)
        elif action_type == 'persona':
            feedback = self._execute_persona_action(action)
            if feedback:
                self._send_to_actuator(feedback, context)
        elif action_type == 'plan':
            feedback = self._execute_plan_action(action)
            if feedback:
                self._send_to_actuator(feedback, context)
        else:
            action['chat_id'] = self._last_chat_id
            action['sensor_name'] = self._sensor_name
            action['sender_name'] = self._last_sender_name
            # Carry the user's question so the research stream can phrase an
            # answer (and never dump raw fetched HTML/JS at the user).
            action['user_text'] = user_text
            if not hasattr(self.brain, '_pending_research_tasks'):
                self.brain._pending_research_tasks = []
            self.brain._pending_research_tasks.append(action)
            self.add_to_log(
                f"Queued research task: {action_type} — "
                f"{action.get('query') or action.get('url', '')[:60]}"
            )
        return None

    def _poll_python(self, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Wait for the off-thread python subprocess, then submit the async
        'rephrase' stage with its output (or send the raw output if rephrasing
        can't be submitted)."""
        turn = self._turn or {}
        thread = turn.get("py_thread")
        if thread is not None and thread.is_alive():
            return None  # subprocess still running
        py_result = (turn.get("py_holder") or {}).get("output") or "(no output)"
        user_text = turn.get("user_text", "")
        source = turn.get("source", self._sensor_name or self.name)
        self.add_to_log(f"Python result: {py_result[:200]}")
        rephrase_history = self._build_history() or "(none)"
        tool_output = py_result[:self._REPHRASE_MAX_INPUT]
        submitted = self._llm_submit(
            role="fast",
            kind=("chat_conscious" if self.is_conscious else "chat_subconscious"),
            call=LLMCall.from_file(
                "rephrase_tool_result",
                user_message=user_text,
                tool_output=tool_output,
                conversation_history=rephrase_history,
            ),
            client_kwargs={"no_think": True},
            task=self._chat_task(
                len(user_text) + len(tool_output) + len(rephrase_history),
                output_tokens=150, quality_need=self._REPHRASE_QUALITY,
                budget_s=self._REPHRASE_BUDGET_S),
        )
        if submitted:
            self._turn = {"stage": "rephrase", "user_text": user_text,
                          "source": source, "py_result": py_result}
            return {"type": "chat_tool_rephrasing"}
        # Couldn't submit the rephrase — send the raw tool output rather than
        # nothing.
        self._send_to_actuator(py_result, context)
        self._turn = None
        return None

    def _on_rephrase_result(self, result, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Send the rephrased tool answer (or the raw tool output as fallback)."""
        turn = self._turn or {}
        self._turn = None
        source = turn.get("source", self._sensor_name or self.name)
        py_result = turn.get("py_result", "")
        if result.discarded:
            # Lost the rephrase; send the raw tool output so the user still gets
            # the answer (the main reply was already delivered).
            if py_result:
                self._send_to_actuator(py_result, context)
                self._record_delivery(py_result, py_result)
            return None
        text = result.text if (result.ok and result.text) else py_result
        self.add_to_log(f"Rephrased: {text[:200]}")
        if text:
            self._send_to_actuator(text, context)
            # #1: record substantive data Iyye actuated as a memory fact — so it
            # can recall what it told the user later (the "yesterday's forecast"
            # gap) and so the delivery settles any matching promise.
            self._record_delivery(text, py_result)
        return {"type": "chat_reply", "text": text, "source": source}

    # A delivery shorter than this, or a tool result that is an error/empty, is
    # not a real deliverable — recording it would be noise (or a false record of
    # delivering an apology for a failed tool).
    _MIN_DELIVERY_CHARS = 12
    _TOOL_ERROR_RE = re.compile(
        r"exit code|traceback|^\s*\(no output\)|\berror\b|exception|syntaxerror|"
        r"\bnot\s+found\b|\bfailed\b", re.IGNORECASE)

    def _record_plan_delivery(self, contact: str, content: str) -> None:
        """Confirm a plan social delivery: write "Iyye delivered to <contact>"
        using the explicit target contact (not _last_sender_name), so it
        matches the promise the executor recorded and the promise backstop
        settles it.  Unlike _record_delivery this is not gated on a tool
        result — the sent MESSAGE is itself the fulfillment."""
        stm = getattr(self.brain, 'stm', None)
        content = (content or '').strip()
        if stm is None or not contact or len(content) < self._MIN_DELIVERY_CHARS:
            return
        try:
            stm.add_fact(
                text=f"Iyye delivered to {contact}: {content[:240]}",
                confidence=0.9, provenance=self.name, time_frame='recent')
            self.add_to_log(f"Confirmed plan delivery to {contact}")
        except Exception as exc:
            log.debug("plan delivery record failed: %s", exc)

    def _record_delivery(self, content: str, tool_result: str) -> None:
        """Record an actuated tool-result delivery as an STM fact (#1).

        Gated on the *tool result* being substantive — so a rephrased apology
        for a broken tool ("I ran into a hiccup") is never recorded as a
        delivery.  Phrased with the canonical 'Iyye delivered to <contact>: …'
        convention, so it both seeds memory and settles a matching promise."""
        stm = getattr(self.brain, 'stm', None)
        content = (content or '').strip()
        tr = (tool_result or '').strip()
        if (stm is None or len(content) < self._MIN_DELIVERY_CHARS
                or len(tr) < self._MIN_DELIVERY_CHARS
                or self._TOOL_ERROR_RE.search(tr)):
            return
        contact = self._last_sender_name or 'the user'
        try:
            stm.add_fact(
                text=f"Iyye delivered to {contact}: {content[:240]}",
                confidence=0.9, provenance=self.name, time_frame='recent',
            )
            self.add_to_log(f"Recorded delivery to {contact}")
        except Exception as exc:
            log.debug("UserChatStream: could not record delivery: %s", exc)

    @staticmethod
    def _fallback_message(error: Optional[str]) -> str:
        """User-facing message when the generate stage failed (not discarded)."""
        e = (error or "").lower()
        if "timeout" in e:
            return ("Sorry, that took longer than expected — the model may be "
                    "overloaded. Please try again in a moment.")
        # Connection-class exceptions mean the same thing as the scheduler's
        # explicit model_unavailable: the server is down or mid-restart.
        if any(kw in e for kw in ("model_unavailable", "connection",
                                  "refused", "unreachable")):
            return ("I'm briefly unable to reach my language model — it may be "
                    "starting up. Please try again shortly.")
        return "Sorry, I couldn't generate a response just now. Please try again."

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _journal_chat_quality(self, result, response: str, action) -> None:
        """Quality signal for the prompt-tuning fold (``llm_quality``): an
        empty reply with no action is garbage (0.0); a reply whose ACTION line
        failed validation is half credit (the model reached for a tool and got
        the contract wrong); otherwise 1.0.  Transport success alone would
        score all three the same.  (Richer signal — next-turn recall_feedback
        joined by query_id — is deferred until recall volume accrues.)"""
        score = 1.0
        if not response and action is None:
            score = 0.0
        elif action is None and any(
                ln.strip().startswith("ACTION:")
                for ln in (result.text or "").splitlines()):
            score = 0.5
        from event_journal import emit
        emit(getattr(self.brain, "journal", None), "llm_quality",
             job_id=result.job_id, kind="chat", score=score)

    # _extract_action is inherited from ToolUseMixin (tool_use.py) — the
    # ACTION-line contract is shared with plan-step executors.

    def _read_system_description(self) -> str:
        """Return current system description, preferring the in-memory copy
        updated by SelfReflectionStream every gather tick over the on-disk
        snapshot which is only written once per iyye_day."""
        cached = getattr(self.brain, '_system_description_md', None)
        if cached:
            return cached
        path = PROJECT_ROOT / "system_description.md"
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            return "(unavailable)"

    def _build_ltm_context(self, query: str, limit: int = 8) -> str:
        """Relevant memory across LTM, STM, and Theory of Mind for this message.

        Unified recall (recall.Recall) — one query path over all three stores,
        with people *named in the query* pulling their ToM interaction history.
        This is what lets "when did Jacob contact you?" find Jacob's history
        (it lives in ToM) even though the sender is Alex and LTM has no fact."""
        try:
            from recall import Recall
            results = Recall(self.brain).query(
                query, limit=limit, sender=self._last_sender_name,
            )
            # Stash for usefulness attribution once the reply is produced
            # (_on_generate_result) — the start of the retrieval-quality signal.
            self._last_recall = results
            return Recall.render(results)
        except Exception as exc:
            self._last_recall = []
            log.warning("UserChatStream: recall failed, falling back to LTM: %s", exc)
            memory = getattr(self.brain, 'memory', None)
            if memory is None:
                return "(none)"
            try:
                facts = memory.search_semantic(query, limit=limit)
            except Exception:
                return "(none)"
            return "\n".join(
                f"[{f.get('time_frame','?')}/{float(f.get('confidence',0.5)):.2f}"
                f" from {f.get('provenance') or f.get('source') or '?'}] {f['text']}"
                for f in facts
            ) or "(none)"

    def _build_stm_context(self) -> str:
        """Format non-ephemeral STM facts for injection into the LLM prompt."""
        stm = getattr(self.brain, 'stm', None)
        if stm is None:
            return "(none)"
        facts = stm.get_recent(limit=30)
        # Skip ephemeral metric snapshots — they're stale by the time the LLM sees them
        relevant = [f for f in facts if f.get('time_frame') != 'ephemeral']
        if not relevant:
            return "(none)"
        lines = []
        for f in relevant:
            tf = f.get('time_frame', '?')
            conf = float(f.get('confidence', 0.7))
            prov = f.get('provenance', '?')
            lines.append(f"[{tf}/{conf:.2f} from {prov}] {f['text']}")
        return "\n".join(lines)

    def _get_contact_context(self) -> str:
        """Query Theory of Mind stream for context about the current sender."""
        tom = self.brain.theory_of_mind()
        if tom is None:
            return "(unavailable)"
        contact_id = tom.make_contact_id(
            self._last_sender_name, self._sensor_name,
            self._last_chat_id, self._last_user_id,
        )
        ctx = tom.get_contact_context(contact_id)
        return ctx or "(new contact)"

    def _mark_recall_used(self, user_text: str, response: str) -> None:
        """Attribute which recalled facts the reply leaned on and record it
        (#5 retrieval-quality signal, shadow only).  When facts were used,
        arm a pending feedback for the next turn (did the reply satisfy the
        user?).  Best-effort; clears the stash so it can't leak forward."""
        recalled = getattr(self, '_last_recall', None)
        self._last_recall = []
        if not recalled:
            return
        try:
            from recall import Recall
            used = Recall.attribute(recalled, response)
            Recall(self.brain).mark_used(used)
            if used:
                qid = next((r.query_id for r in used if r.query_id), None)
                if qid:
                    self._pending_feedback = {"query_id": qid,
                                              "prev_user": user_text}
        except Exception as exc:
            log.debug("UserChatStream: recall usefulness marking failed: %s", exc)

    # First-person correction openers signalling the prior answer missed.
    _CORRECTION_RE = re.compile(
        r"^(no\b|nope\b|wrong\b|that'?s (?:not|wrong)|not (?:what|quite|right)|"
        r"actually\b|i meant\b|that'?s incorrect)", re.IGNORECASE)

    def _emit_recall_feedback(self, new_user_text: str) -> None:
        """Implicit feedback on the previous fact-using turn, read from the
        next message: a correction or a re-ask means dissatisfied, otherwise
        satisfied.  Shadow only — journaled as `recall_feedback`, joined to the
        recall by query_id; the usefulness pass (#5 B/C) decides how to weigh
        used-and-satisfied vs used-and-dissatisfied.  Coarse by design."""
        pending = getattr(self, '_pending_feedback', None)
        self._pending_feedback = None
        if not pending:
            return
        prev = pending.get("prev_user", "")
        low = (new_user_text or "").strip()
        dissatisfied = bool(self._CORRECTION_RE.match(low)) or \
            self._reask_overlap(prev, new_user_text) >= 0.6
        try:
            from event_journal import emit
            emit(getattr(self.brain, "journal", None), "recall_feedback",
                 query_id=pending.get("query_id"),
                 signal="dissatisfied" if dissatisfied else "satisfied")
        except Exception:
            pass

    @staticmethod
    def _reask_overlap(a: str, b: str) -> float:
        ta = frozenset(w for w in re.findall(r"[a-z0-9]+", (a or "").lower()) if len(w) > 2)
        tb = frozenset(w for w in re.findall(r"[a-z0-9]+", (b or "").lower()) if len(w) > 2)
        if not ta or not tb:
            return 0.0
        return len(ta & tb) / len(ta | tb)

    def _report_interaction(self, user_text: str, response: str) -> None:
        """Post this interaction to Theory of Mind via mailbox."""
        tom = self.brain.theory_of_mind()
        if tom is None:
            return
        contact_id = tom.make_contact_id(
            self._last_sender_name, self._sensor_name,
            self._last_chat_id, self._last_user_id,
        )
        from messaging import Messages
        self.brain.post_message("theory_of_mind", Messages.interaction(
            contact_id=contact_id,
            display_name=self._last_sender_name,
            source=self._sensor_name,
            chat_id=self._last_chat_id,
            user_id=self._last_user_id,
            user_said=user_text,
            iyye_said=response,
            timestamp=datetime.now(timezone.utc).isoformat(),
        ))

    @staticmethod
    def _build_system_state(
        adenosine: float,
        active_streams: int,
        sr: Optional[Dict[str, Any]],
    ) -> str:
        """Build a human-readable system state string for the LLM prompt.

        Uses the self-reflection snapshot when available for rich introspective
        detail; falls back to bare adenosine + stream count otherwise.
        """
        parts = [f"adenosine={adenosine:.2f}"]
        if sr:
            cpu = sr.get('cpu_percent')
            mem = sr.get('memory_percent')
            if cpu is not None:
                parts.append(f"cpu={cpu:.1f}%")
            if mem is not None:
                parts.append(f"memory={mem:.1f}%")
            pos = sr.get('position', {})
            facts = pos.get('facts_in_memory')
            if facts is not None:
                parts.append(f"facts_in_memory={facts}")
            conscious = pos.get('conscious_stream')
            if conscious:
                parts.append(f"conscious_stream={conscious}")
            iyye_day = sr.get('iyye_day') or pos.get('iyye_day')
            if iyye_day is not None:
                parts.append(f"iyye_day={iyye_day}")
        parts.append(f"active_streams={active_streams}")
        return ", ".join(parts)

    def _build_history(self) -> str:
        """Format last 10 input/output pairs as a readable conversation.

        When this stream's own history is short, supplements with recent
        cross-channel interactions from Theory of Mind so that a channel
        switch (e.g. web → Telegram) doesn't lose conversational context.
        """
        _HISTORY_CAP = 10
        lines: List[str] = []
        inputs = self.input_history[-_HISTORY_CAP:]
        outputs = self.output_history[-_HISTORY_CAP:]

        # Supplement with cross-channel history from ToM when own is thin.
        own_pairs = min(len(inputs), len(outputs))
        if own_pairs < _HISTORY_CAP:
            tom = self.brain.theory_of_mind()
            if tom is not None:
                contact_id = tom.make_contact_id(
                    self._last_sender_name, self._sensor_name,
                    self._last_chat_id, self._last_user_id,
                )
                need = _HISTORY_CAP - own_pairs
                prior = tom.get_recent_interactions(contact_id, limit=need)
                for i in prior:
                    src_tag = i.get("source", "")
                    user_said = (i.get("user_said") or "")[:200]
                    iyye_said = (i.get("iyye_said") or "")[:200]
                    if user_said:
                        prefix = f"User (via {src_tag})" if src_tag else "User"
                        lines.append(f"{prefix}: {user_said}")
                        lines.append(f"Iyye: {iyye_said}")

        for inp, out in zip(inputs, outputs):
            user = inp.get('data', '') if isinstance(inp, dict) else inp
            reply = out.get('data', '') if isinstance(out, dict) else out
            lines.append(f"User: {str(user)[:200]}")
            lines.append(f"Iyye: {str(reply)[:200]}")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Tool-result rephrasing
    # ------------------------------------------------------------------

    # Max chars of raw tool output fed to the async 'rephrase' stage
    # (see _handle_action).
    _REPHRASE_MAX_INPUT = 3000

    # ------------------------------------------------------------------
    # Python execution — inherited from ToolUseMixin (tool_use.py): the
    # journaled subprocess runner and its timeout/line/output bounds are
    # shared with plan-step executors.  The trust gate stays here (HLD §9:
    # only privileged users reach the python action).
    # ------------------------------------------------------------------

    # Transient generate failures (LLM restarting) retried per message before
    # the user gets a fallback apology.  Each failed attempt already takes
    # seconds (health check / timeout), which acts as natural backoff.
    _MAX_GENERATE_RETRIES = 2

    def _send_typing_indicator(self, context: Dict[str, Any]) -> None:
        """Notify a Telegram user that a response is being generated.

        MEDIATED: the "typing…" chat action goes through the Telegram
        actuator (``send_typing``) — the stream no longer makes its own HTTP
        call, so the actuator layer is the only Telegram caller and the sleep
        stopped-gate applies to this signal too.  Best-effort; web chat needs
        no indicator (fast model, quick responses)."""
        if 'telegram' not in self._sensor_name.lower() or not self._last_chat_id:
            return
        actuators = (context.get('actuators')
                     or getattr(self.brain, 'actuators', {}) or {})
        for name, act in actuators.items():
            if ('telegram' in name.lower()
                    and callable(getattr(act, 'send_typing', None))):
                try:
                    act.send_typing(self._last_chat_id)
                except Exception:
                    pass  # cosmetic signal — never break the turn
                return

    def _send_to_actuator(self, response: str, context: Dict[str, Any],
                          strict_channel: bool = False) -> bool:
        """Route response to the actuator matching this stream's sensor source.

        *strict_channel* (plan deliveries to a specific contact): use ONLY a
        channel-matched actuator — never the web/console cross-channel
        fallback — so a message meant for a remote contact is not delivered
        to the wrong device and then falsely confirmed.  Returns True only on
        a real delivery."""
        actuators: Dict[str, Any] = context.get('actuators') or getattr(self.brain, 'actuators', {})
        if not actuators:
            return False

        sensor_lower = self._sensor_name.lower()  # e.g. "telegramsensor", "web_chat"

        # Find actuator whose name shares a keyword with the sensor name
        candidates = [
            name for name in actuators
            if self._names_match(sensor_lower, name.lower())
        ]
        if not candidates and not strict_channel:
            # Explicit fallback priority: web_chat > console (avoid console if possible)
            for preferred in ('webchat', 'web_chat', 'console'):
                for name in actuators:
                    if preferred in name.lower():
                        candidates = [name]
                        break
                if candidates:
                    break
        if not candidates and not strict_channel:
            candidates = list(actuators.keys())[:1]
        if not candidates:
            # Strict plan delivery with no matching channel — the contact was
            # NOT reached.  Leave the promise open for the backstop.
            self.add_to_log(
                f"No {sensor_lower} channel actuator — plan message NOT "
                f"delivered")
            return False

        from iyye_base import ACTUATE_SUPPRESSED
        for actuator_name in candidates:
            actuator = actuators[actuator_name]
            try:
                # Telegram actuator accepts JSON payload with chat_id
                if 'telegram' in actuator_name.lower() and self._last_chat_id:
                    payload = json.dumps({'text': response, 'chat_id': self._last_chat_id})
                else:
                    payload = response
                # allow_duplicate: a user-visible reply must never be dropped as
                # a "duplicate" (e.g. the same answer to a repeated question) —
                # the raw-data safety net still applies.
                ok = actuator.actuate(payload, allow_duplicate=True)
                if ok is ACTUATE_SUPPRESSED:
                    # A guardrail (raw-data net) blocked it — NOT delivered.
                    # Don't claim success; try the next candidate.
                    log.warning("Actuator %s suppressed the reply (guardrail) — "
                                "not delivered", actuator_name)
                    self.add_to_log(f"Reply blocked by {actuator_name} guardrail (not sent)")
                    continue
                if ok is False:
                    # Explicit False means a known failure (e.g. missing chat_id,
                    # bot send error).  Try the next candidate rather than silently
                    # claiming success.
                    log.warning("Actuator %s declined to send (returned False)", actuator_name)
                    continue
                self.add_to_log(f"Sent response via {actuator_name}")
                # Speak web-chat responses aloud via TTS if available.
                if 'web' in actuator_name.lower() or 'chat' in actuator_name.lower():
                    tts = next(
                        (a for n, a in actuators.items() if 'tts' in n.lower()),
                        None,
                    )
                    if tts is not None:
                        try:
                            tts.actuate(response)
                        except Exception as tts_exc:
                            log.warning("TTS actuator failed: %s", tts_exc)
                return True
            except Exception as exc:
                log.warning("Actuator %s failed: %s", actuator_name, exc)

        log.error("All actuators failed to send response for sensor=%s", self._sensor_name)
        self.add_to_log("FAILED: all actuators declined or errored")
        return False

    @staticmethod
    def _names_match(sensor_lower: str, actuator_lower: str) -> bool:
        """True if sensor and actuator share a meaningful keyword."""
        keywords = ('telegram', 'web_chat', 'webchat', 'chat', 'tts', 'microphone')
        return any(kw in sensor_lower and kw in actuator_lower for kw in keywords)
