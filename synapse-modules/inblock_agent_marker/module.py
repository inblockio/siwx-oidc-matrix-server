# SPDX-License-Identifier: Apache-2.0
#
# Copyright 2026 inblock.io assets GmbH
#
# Agent marker: lists every local account that flags itself as an agent (the custom
# profile field `io.inblock.agent` = true, MSC4133) in the room state
# `io.element.functional_members` (MSC4171, key `service_members`) of each chat it is
# in, so that Element Call does not ring the agent. The state event is sent in the
# name of whoever invited the agent (the invite that precedes its current join); a chat
# the agent created itself is marked in the agent's own name (`mark_own_rooms`, on by
# default, the owner's answer OQ1). Chats where the inviter may not write the mark, has
# left, is on another server or does not exist are skipped with one log line and never
# by picking another member.
#
# Triggers (no timer, no `on_new_event`, see "Why not on_new_event" below):
#   - a local account joins a room (Synapse's join notification);
#   - an account changes its profile, which includes setting its flag (the module
#     marks that account's existing chats: the on-flag reaction);
#   - the module starts (a sweep over every flagged account).
# A sweep writes only where a flagged, joined agent is missing from the list. A mark a
# person removed by hand comes back at the next start. Nothing removes a mark.
#
# Contract: docs/agent-marker.md. Tests: synapse-modules/inblock_agent_marker_tests, run
# by synapse-modules/run-tests.sh against Synapse at the tag the Dockerfile pins, on
# SQLite and on Postgres.
#
# SYNAPSE-INTERNAL DEPENDENCIES. Public ModuleApi calls used: register_third_party_rules_callbacks
# (on_profile_update only), is_mine, get_room_state, create_and_send_event_into_room,
# run_db_interaction, run_as_background_process, sleep, delayed_background_call,
# should_run_background_tasks. Everything below can change in any release; the tests are
# a step of the Synapse bump procedure (patches/synapse/README.md, rule 4) and a bump is
# not merged while they are red. All six are used in this file only, in the places
# marked "INTERNAL n":
#   1. `api._hs.get_datastores().main.get_profile_field(UserID, field)`: the profile
#      field read (no public call reads a custom field); same call inblock_directory uses.
#   2. `synapse.event_auth.get_send_level` and `get_user_power_level`: whether the
#      inviter may write the mark, so that a skip is one module line and no Synapse
#      "Denying new event" warning.
#   3. SQL on `profiles(full_user_id, fields)`: the flagged accounts, for the start sweep.
#   4. SQL on `room_memberships(room_id, user_id, event_id, sender, membership,
#      event_stream_ordering)`: the inviter, and which account an event id joined.
#   5. SQL on `local_current_membership(room_id, user_id, membership)`: the rooms an
#      account is in.
#   6. `api._hs.get_notifier().add_new_join_in_room_callback(cb)`: the join trigger,
#      called as cb(event_id, room_id) for every new local join. (Also imported:
#      synapse.logging.context.make_deferred_yieldable, synapse.api.errors.StoreError.)
#
# WHY NOT on_new_event (spike limit L2). Registering any `on_new_event` callback makes
# Synapse 1.165.0 log two logcontext WARNINGs about every state event, from its own
# dispatcher: the sender's request has finished by the time the dispatcher awaits the
# store (handlers/message.py runs the notification with run_in_background and does not
# wait for it), and a callback is the only thing that makes the dispatcher do that
# await. A callback cannot prevent it, so the module does not register one. The join
# notification (INTERNAL 6) arrives synchronously, before the join event is stored, so
# the module waits for the row in `room_memberships` (it also tells which account
# joined) and then works in its own background process. The test suite counts the log
# lines with the module loaded against not loaded (LogNoiseTestCase).

import json
import logging
from dataclasses import dataclass
from typing import Any

from twisted.internet import defer

from synapse.api.errors import StoreError
from synapse.event_auth import get_send_level, get_user_power_level
from synapse.logging.context import make_deferred_yieldable
from synapse.module_api import ModuleApi
from synapse.module_api.errors import ConfigError, SynapseError
from synapse.types import UserID

logger = logging.getLogger(__name__)

FM_TYPE = "io.element.functional_members"
DEFAULT_FLAG_FIELD = "io.inblock.agent"


@dataclass
class AgentMarkerConfig:
    flag_field: str = DEFAULT_FLAG_FIELD
    # OQ1, answered a: a chat the agent created itself is marked in the agent's own name.
    mark_own_rooms: bool = True
    # How long a freshly created chat is left alone before the agent's own mark is
    # written: room creation sends its initial events one after the other.
    own_room_delay_seconds: float = 2.0
    # How long to wait for a join event to be stored after Synapse announced it.
    join_wait_seconds: float = 10.0
    startup_delay_seconds: float = 5.0
    sweep_batch_size: int = 25
    sweep_pause_seconds: float = 0.2


def _num(config: dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    value = config.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ConfigError(f"{key}: expected a number from {low} to {high}")
    return float(value)


def _is_true(value: Any) -> bool:
    # JSON true: Postgres hands back True, SQLite's JSON_EXTRACT hands back 1 (DD9).
    return value is True or (type(value) is int and value == 1)


class AgentMarker:
    def __init__(self, config: AgentMarkerConfig, api: ModuleApi):
        self._cfg = config
        self._api = api
        self._locks: dict[str, defer.DeferredLock] = {}
        self._skipped: set[tuple[str, str]] = set()  # one log line per chat and agent and process
        api.register_third_party_rules_callbacks(on_profile_update=self.on_profile_update)
        # INTERNAL 6
        api._hs.get_notifier().add_new_join_in_room_callback(self._on_join_announced)
        if api.should_run_background_tasks():
            api.delayed_background_call(
                int(config.startup_delay_seconds * 1000), self.sweep, desc="agent_marker_start"
            )

    @staticmethod
    def parse_config(config: dict[str, Any]) -> AgentMarkerConfig:
        if not isinstance(config, dict):
            raise ConfigError("config: expected a mapping")
        known = {
            "flag_field", "mark_own_rooms", "own_room_delay_seconds", "join_wait_seconds",
            "startup_delay_seconds", "sweep_batch_size", "sweep_pause_seconds",
        }
        unknown = sorted(set(config) - known)
        if unknown:
            raise ConfigError("unknown setting(s): " + ", ".join(unknown))
        flag = config.get("flag_field", DEFAULT_FLAG_FIELD)
        if not isinstance(flag, str) or not flag:
            raise ConfigError("flag_field: expected a non-empty string")
        own = config.get("mark_own_rooms", True)
        if not isinstance(own, bool):
            raise ConfigError("mark_own_rooms: expected true or false")
        return AgentMarkerConfig(
            flag_field=flag,
            mark_own_rooms=own,
            own_room_delay_seconds=_num(config, "own_room_delay_seconds", 2.0, 0, 60),
            join_wait_seconds=_num(config, "join_wait_seconds", 10.0, 1, 120),
            startup_delay_seconds=_num(config, "startup_delay_seconds", 5.0, 0, 600),
            sweep_batch_size=int(_num(config, "sweep_batch_size", 25, 1, 1000)),
            sweep_pause_seconds=_num(config, "sweep_pause_seconds", 0.2, 0, 10),
        )

    # ---- triggers --------------------------------------------------------------

    def _on_join_announced(self, event_id: str, room_id: str) -> None:
        # Synchronous and called before the join event is stored: only start the work.
        if self._api.should_run_background_tasks():
            self._api.run_as_background_process(
                "agent_marker_join", self._after_join, event_id, room_id
            )

    async def on_profile_update(self, user_id: str, _p: Any, _a: bool, deactivation: bool) -> None:
        if deactivation or not self._api.should_run_background_tasks():
            return
        if self._api.is_mine(user_id):
            self._api.run_as_background_process("agent_marker_profile", self.sweep_user, user_id)

    async def _after_join(self, event_id: str, room_id: str) -> None:
        user_id = await self._wait_for_join(event_id)
        if user_id is None or not self._api.is_mine(user_id):
            return
        if not await self.is_flagged(user_id):
            return
        await self.mark(room_id, user_id, checked=True, fresh=True)

    async def _wait_for_join(self, event_id: str) -> str | None:
        waited, step = 0.0, 0.05
        while True:
            row = await self._membership_of_event(event_id)
            if row is not None:
                user_id, membership = row
                return user_id if membership == "join" else None
            if waited >= self._cfg.join_wait_seconds:
                logger.debug("agent_marker: join event %s was not stored in time", event_id)
                return None
            await self._api.sleep(step)
            waited += step
            step = min(step * 2, 2.0)

    # ---- reads -----------------------------------------------------------------

    async def is_flagged(self, user_id: str) -> bool:
        # INTERNAL 1
        store = self._api._hs.get_datastores().main
        try:
            value = await store.get_profile_field(UserID.from_string(user_id), self._cfg.flag_field)
        except StoreError:
            return False
        return _is_true(value)

    async def _membership_of_event(self, event_id: str) -> tuple[str, str] | None:
        def txn(t: Any) -> tuple[str, str] | None:
            # INTERNAL 4
            t.execute("SELECT user_id, membership FROM room_memberships WHERE event_id = ?", (event_id,))
            row = t.fetchone()
            return (row[0], row[1]) if row else None

        return await self._api.run_db_interaction("agent_marker_event", txn)

    async def inviter_of(self, room_id: str, user_id: str) -> str | None:
        """The sender of the invite that directly precedes the current stay, else None.

        The newest membership event that is not a join marks the start of the current
        stay (a join after a join is a profile change). If that event is an invite, its
        sender is the inviter; a leave, ban or knock means the account came in some other
        way, and an invite from an earlier stay does not count.
        """

        def txn(t: Any) -> str | None:
            # INTERNAL 4
            t.execute(
                "SELECT sender, membership FROM room_memberships"
                " WHERE room_id = ? AND user_id = ? AND membership != 'join'"
                " AND event_stream_ordering IS NOT NULL"
                " ORDER BY event_stream_ordering DESC LIMIT 1",
                (room_id, user_id),
            )
            row = t.fetchone()
            return row[0] if row and row[1] == "invite" else None

        return await self._api.run_db_interaction("agent_marker_inviter", txn)

    async def flagged_accounts(self) -> list[str]:
        needle = '%"' + self._cfg.flag_field + '"%'

        def txn(t: Any) -> list[tuple[str, Any]]:
            # INTERNAL 3. The text match is a pre-filter that works on both engines
            # (SQLite keeps the JSON as text, Postgres as JSONB); the value is read in Python.
            t.execute(
                "SELECT full_user_id, fields FROM profiles WHERE fields IS NOT NULL"
                " AND CAST(fields AS TEXT) LIKE ?",
                (needle,),
            )
            return list(t.fetchall())

        out = []
        for uid, fields in await self._api.run_db_interaction("agent_marker_flagged", txn):
            fields = json.loads(fields) if isinstance(fields, str) else fields
            if isinstance(fields, dict) and _is_true(fields.get(self._cfg.flag_field)):
                out.append(uid)
        return out

    async def joined_rooms(self, user_id: str) -> list[str]:
        def txn(t: Any) -> list[str]:
            # INTERNAL 5
            t.execute(
                "SELECT room_id FROM local_current_membership WHERE user_id = ? AND membership = 'join'",
                (user_id,),
            )
            return [r[0] for r in t.fetchall()]

        return await self._api.run_db_interaction("agent_marker_rooms", txn)

    # ---- writes ----------------------------------------------------------------

    async def sweep(self) -> None:
        wrote = 0
        for uid in await self.flagged_accounts():
            wrote += await self.sweep_user(uid, checked=True, log=False)
        logger.info("agent_marker: sweep done, %d room(s) written", wrote)

    async def sweep_user(self, user_id: str, checked: bool = False, log: bool = True) -> int:
        if not checked and not await self.is_flagged(user_id):
            return 0
        rooms = await self.joined_rooms(user_id)
        wrote = 0
        size = self._cfg.sweep_batch_size
        for i in range(0, len(rooms), size):
            if i:
                await self._api.sleep(self._cfg.sweep_pause_seconds)
            for room_id in rooms[i : i + size]:
                wrote += int(await self.mark(room_id, user_id, checked=True))
        if log:
            logger.info("agent_marker: %s swept, %d room(s) written", user_id, wrote)
        return wrote

    async def mark(self, room_id: str, agent: str, checked: bool = False, fresh: bool = False) -> bool:
        if not checked and not await self.is_flagged(agent):
            return False
        lock = self._locks.setdefault(room_id, defer.DeferredLock())
        await make_deferred_yieldable(lock.acquire())
        try:
            return await self._mark_locked(room_id, agent, fresh)
        finally:
            lock.release()
            if not lock.locked and not lock.waiting:
                self._locks.pop(room_id, None)

    def _skip(self, room_id: str, agent: str, why: str) -> None:
        if (room_id, agent) not in self._skipped:
            self._skipped.add((room_id, agent))
            logger.info("agent_marker: skip %s in %s: %s", agent, room_id, why)

    async def _read(self, room_id: str, agent: str) -> Any:
        keys = [(FM_TYPE, ""), ("m.room.create", ""), ("m.room.power_levels", ""), ("m.room.member", agent)]
        return await self._api.get_room_state(room_id, keys)

    async def _mark_locked(self, room_id: str, agent: str, fresh: bool) -> bool:
        state = await self._read(room_id, agent)
        fm = state.get((FM_TYPE, ""))
        content = dict(fm.content) if fm is not None else {}
        members = content.get("service_members")
        members = list(members) if isinstance(members, list) else []
        if agent in members:
            return False
        me = state.get(("m.room.member", agent))
        if me is None or me.membership != "join":
            return False
        sender = await self.inviter_of(room_id, agent)
        create = state.get(("m.room.create", ""))
        if sender is None and self._cfg.mark_own_rooms and create is not None and create.sender == agent:
            sender = agent
            if fresh and self._cfg.own_room_delay_seconds > 0:
                # The chat is being created: let its initial events land first, then read again.
                await self._api.sleep(self._cfg.own_room_delay_seconds)
                state = await self._read(room_id, agent)
                fm = state.get((FM_TYPE, ""))
                content = dict(fm.content) if fm is not None else {}
                members = content.get("service_members")
                members = list(members) if isinstance(members, list) else []
                if agent in members:
                    return False
        if sender is None:
            self._skip(room_id, agent, "no invite on record")
            return False
        if not self._api.is_mine(sender):
            self._skip(room_id, agent, "inviter is remote")
            return False
        state.update(await self._api.get_room_state(room_id, [("m.room.member", sender)]))
        inv = state.get(("m.room.member", sender))
        if inv is None or inv.membership != "join":
            self._skip(room_id, agent, "inviter not joined")
            return False
        # INTERNAL 2
        need = get_send_level(FM_TYPE, "", state.get(("m.room.power_levels", "")))
        if get_user_power_level(sender, state) < need:
            self._skip(room_id, agent, "inviter below power %d" % (need,))
            return False
        content["service_members"] = members + [agent]
        try:
            await self._api.create_and_send_event_into_room(
                {"type": FM_TYPE, "state_key": "", "room_id": room_id, "sender": sender, "content": content}
            )
        except SynapseError as e:
            self._skip(room_id, agent, "refused %s" % (e.code,))
            return False
        logger.info("agent_marker: marked %s in %s as %s", agent, room_id, sender)
        return True
