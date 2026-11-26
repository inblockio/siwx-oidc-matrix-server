# SPDX-License-Identifier: Apache-2.0
#
# Copyright 2026 inblock.io assets GmbH
#
# Tests for the inblock_agent_marker Synapse module (docs/agent-marker.md).
#
# NOT shipped in the image. They run inside Synapse's own test framework
# (`tests.unittest.HomeserverTestCase`, imported at test time; no Synapse code is copied
# into this file) against a Synapse checkout at the tag the Dockerfile pins:
# synapse-modules/run-tests.sh sets that up, on SQLite by default and on Postgres with
# SYNAPSE_POSTGRES=1 (run-tests.sh --postgres).
#
# The module is loaded through `modules:` like in production, next to the directory
# module and, when the checkout is on the path (GUEST_POLICY_MODULE_PATH, set by
# run-tests.sh when it exists), next to the guest policy module, whose
# `check_event_allowed` sees the module's own state event.
#
# Case names follow the H0 spike's table (track agent_call, M0): a, a2, a3, b, c, d, e,
# f, g1, g2, h, i, x1, x2. The spike's `on the wire` checks (the image's profile-field
# write policy, a remote inviter) are covered as far as stock Synapse allows: the
# denylist patch is the image's, not the checkout's.
#
# RED CONTROL. With INBLOCK_AGENT_MARKER_TESTS_WITHOUT_MODULE=1 the same scenarios run
# without the module loaded: every test that expects a mark must fail. That output is
# the "red without the module" evidence.

import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from twisted.internet.testing import MemoryReactor

from synapse.rest import admin
from synapse.rest.client import login, profile, room
from synapse.server import HomeServer
from synapse.types import JsonDict, UserID, create_requester
from synapse.util.clock import Clock

from tests import unittest
from tests.unittest import override_config

FM_TYPE = "io.element.functional_members"
FLAG = "io.inblock.agent"
MARKER_CLASS = "inblock_agent_marker.AgentMarker"
WITHOUT_MODULE = bool(os.environ.get("INBLOCK_AGENT_MARKER_TESTS_WITHOUT_MODULE"))
GUEST_POLICY_LOADED = False
try:
    if os.environ.get("GUEST_POLICY_MODULE_PATH"):
        import synapse_guest_policy  # noqa: F401

        GUEST_POLICY_LOADED = True
except ImportError:  # the module lives in its own repository
    pass


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def at_least(self, level: int) -> list[logging.LogRecord]:
        return [r for r in self.records if r.levelno >= level]

    def lines(self, prefix: str, contains: str = "") -> list[str]:
        return [
            r.getMessage()
            for r in self.records
            if r.name.startswith(prefix) and contains in r.getMessage()
        ]


@contextmanager
def capture_logs() -> Iterator[_Capture]:
    """Every record of every logger, at DEBUG, for the duration of the block."""
    handler = _Capture()
    root = logging.getLogger()
    old_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        yield handler
    finally:
        root.removeHandler(handler)
        root.setLevel(old_level)


def module_list(marker: bool = True, **marker_settings: Any) -> list[JsonDict]:
    mods: list[JsonDict] = [
        {
            "module": "inblock_directory.DirectoryModule",
            "config": {"admitted_services": ["@dir-service:test"]},
        }
    ]
    if GUEST_POLICY_LOADED:
        mods.append({"module": "synapse_guest_policy.GuestPolicy", "config": {}})
    if marker and not WITHOUT_MODULE:
        settings = {"startup_delay_seconds": 0, **marker_settings}
        mods.append({"module": MARKER_CLASS, "config": settings})
    return mods


class MarkerTestBase(unittest.HomeserverTestCase):
    # False: the server starts without the module, the test starts it later (a restart).
    MARKER_AT_START = True
    servlets = [
        admin.register_servlets,
        login.register_servlets,
        profile.register_servlets,
        room.register_servlets,
    ]

    def default_config(self) -> JsonDict:
        config = super().default_config()
        config["public_baseurl"] = "https://synapse/"
        config.setdefault("modules", module_list(marker=self.MARKER_AT_START))
        return config

    def prepare(self, reactor: MemoryReactor, clock: Clock, hs: HomeServer) -> None:
        self.store = hs.get_datastores().main
        self.tokens: dict[str, str] = {}
        self.pump(1)  # the module's start sweep, if any, runs on an empty server

    # ------------------------------------------------------------------ helpers

    def user(self, name: str, admin_user: bool = False) -> str:
        uid = self.register_user(name, "pw-" + name, admin=admin_user)
        self.tokens[uid] = self.login(name, "pw-" + name)
        return uid

    def settle(self) -> None:
        """Let the module's background work finish (it waits on the join, then writes)."""
        self.pump(0.1)

    def put_flag(self, user_id: str, by: str, value: Any = True, expect: int = 200) -> None:
        channel = self.make_request(
            "PUT",
            f"/_matrix/client/v3/profile/{user_id}/{FLAG}",
            {FLAG: value},
            access_token=self.tokens[by],
        )
        self.assertEqual(channel.code, expect, channel.result)

    def agent(self, name: str) -> str:
        uid = self.user(name)
        self.put_flag(uid, uid)
        self.settle()
        return uid

    def make_room(
        self,
        creator: str,
        *,
        public: bool = False,
        extra: JsonDict | None = None,
        version: str = "10",
    ) -> str:
        room_id = self.helper.create_room_as(
            creator,
            is_public=public,
            tok=self.tokens[creator],
            room_version=version,
            extra_content=extra,
        )
        assert room_id is not None
        return room_id

    def invite_and_join(self, room_id: str, inviter: str, invitee: str) -> None:
        self.helper.invite(room_id, inviter, invitee, tok=self.tokens[inviter])
        self.helper.join(room_id, invitee, tok=self.tokens[invitee])
        self.settle()

    def fm_event(self, room_id: str) -> Any:
        return self.get_success(
            self.hs.get_storage_controllers().state.get_current_state_event(room_id, FM_TYPE, "")
        )

    def fm_members(self, room_id: str) -> list[str] | None:
        ev = self.fm_event(room_id)
        return None if ev is None else list(ev.content.get("service_members", []))

    def fm_events_in(self, room_id: str) -> list[Any]:
        rows = self.get_success(
            self.store.db_pool.simple_select_list(
                "events", {"room_id": room_id, "type": FM_TYPE}, ["event_id", "sender"]
            )
        )
        return list(rows)

    def stored_flag(self, user_id: str) -> Any:
        return self.get_success(self.store.get_profile_field(UserID.from_string(user_id), FLAG))

    def power_levels(self, **overrides: Any) -> JsonDict:
        return {"power_level_content_override": overrides}

    def load_marker(self, **settings: Any) -> Any:
        """Start the module on the running server, as a restart would (None in the red control)."""
        if WITHOUT_MODULE:
            return None
        from inblock_agent_marker import AgentMarker

        marker = AgentMarker(
            AgentMarker.parse_config({"startup_delay_seconds": 0, **settings}),
            self.hs.get_module_api(),
        )
        self.settle()
        return marker


class AgentMarkerCases(MarkerTestBase):
    # ------------------------------------------------------------ the flag (a)

    def test_a_self_set_flag_reads_back(self) -> None:
        a = self.user("a")
        self.put_flag(a, a)
        value = self.stored_flag(a)
        # SQLite stores a JSON true as 1, Postgres as true (DD9).
        self.assertIn(value, (True, 1))

    def test_a2_another_user_cannot_set_it(self) -> None:
        a, p = self.user("a"), self.user("p")
        self.put_flag(a, p, expect=403)

    def test_a3_admin_can_set_it_on_another(self) -> None:
        a = self.user("a")
        adm = self.user("adm", admin_user=True)
        self.put_flag(a, adm)
        self.assertIn(self.stored_flag(a), (True, 1))

    # ------------------------------------------------- the join path (b, c, d)

    def test_b_join_marks_agent_in_the_inviters_name(self) -> None:
        p1, a = self.user("p1"), self.agent("a")
        room_id = self.make_room(p1)
        self.invite_and_join(room_id, p1, a)
        self.assertEqual(self.fm_members(room_id), [a])
        self.assertEqual(self.fm_event(room_id).sender, p1)

    def test_c_existing_entries_and_other_keys_survive(self) -> None:
        p1, a = self.user("p1"), self.agent("a")
        room_id = self.make_room(p1)
        self.helper.send_state(
            room_id,
            FM_TYPE,
            {"service_members": ["@other:test"], "x.keep": {"k": 1}},
            tok=self.tokens[p1],
        )
        self.invite_and_join(room_id, p1, a)
        self.assertEqual(self.fm_members(room_id), ["@other:test", a])
        self.assertEqual(self.fm_event(room_id).content["x.keep"], {"k": 1})

    def test_c2_already_listed_agent_writes_nothing(self) -> None:
        p1, a = self.user("p1"), self.agent("a")
        room_id = self.make_room(p1)
        self.helper.send_state(room_id, FM_TYPE, {"service_members": [a]}, tok=self.tokens[p1])
        before = len(self.fm_events_in(room_id))
        self.invite_and_join(room_id, p1, a)
        self.assertEqual(len(self.fm_events_in(room_id)), before)

    def test_d_unflagged_person_is_not_added(self) -> None:
        p1, p2 = self.user("p1"), self.user("p2")
        room_id = self.make_room(p1)
        self.invite_and_join(room_id, p1, p2)
        self.assertIsNone(self.fm_event(room_id))

    def test_flag_value_one_and_false(self) -> None:
        # DD9: 1 counts as true; false and other values do not.
        p1 = self.user("p1")
        for name, value, expect_mark in (("f1", 1, True), ("f2", False, False), ("f3", "yes", False)):
            uid = self.user(name)
            self.put_flag(uid, uid, value=value)
            room_id = self.make_room(p1)
            self.invite_and_join(room_id, p1, uid)
            self.assertEqual(self.fm_members(room_id) == [uid], expect_mark, name)

    # ------------------------------------------------------- the skips (e, N5)

    def test_e_inviter_without_power_is_skipped_with_one_line(self) -> None:
        p0, p1, a = self.user("p0"), self.user("p1"), self.agent("a")
        room_id = self.make_room(p0, extra=self.power_levels(state_default=50, invite=0))
        self.invite_and_join(room_id, p0, p1)
        with capture_logs() as logs:
            self.invite_and_join(room_id, p1, a)
        self.assertIsNone(self.fm_event(room_id))
        self.assertEqual(self.get_success(self.store.get_local_current_membership_for_user_in_room(a, room_id))[0], "join")
        if not WITHOUT_MODULE:
            self.assertEqual(len(logs.lines("inblock_agent_marker", "skip")), 1, logs.lines("inblock_agent_marker"))
        self.assertEqual([r.getMessage() for r in logs.at_least(logging.WARNING)], [])

    def test_inviter_who_left_is_skipped(self) -> None:
        p1, a = self.user("p1"), self.agent("a")
        room_id = self.make_room(p1, public=True)
        p2 = self.user("p2")
        self.helper.join(room_id, p2, tok=self.tokens[p2])
        self.helper.send_state(
            room_id, "m.room.power_levels",
            {"users": {p1: 100, p2: 100}}, tok=self.tokens[p1],
        )
        self.helper.invite(room_id, p2, a, tok=self.tokens[p2])
        self.helper.leave(room_id, p2, tok=self.tokens[p2])
        with capture_logs() as logs:
            self.helper.join(room_id, a, tok=self.tokens[a])
            self.settle()
        self.assertIsNone(self.fm_event(room_id))
        if not WITHOUT_MODULE:
            self.assertEqual(len(logs.lines("inblock_agent_marker", "skip")), 1)
        self.assertEqual([r.getMessage() for r in logs.at_least(logging.WARNING)], [])

    def test_no_invite_agent_joined_by_link_is_skipped(self) -> None:
        p1, a = self.user("p1"), self.agent("a")
        room_id = self.make_room(p1, public=True)
        with capture_logs() as logs:
            self.helper.join(room_id, a, tok=self.tokens[a])
            self.settle()
        self.assertIsNone(self.fm_event(room_id))
        if not WITHOUT_MODULE:
            self.assertEqual(len(logs.lines("inblock_agent_marker", "skip")), 1)
        self.assertEqual([r.getMessage() for r in logs.at_least(logging.WARNING)], [])

    def test_stale_invite_is_not_the_inviter(self) -> None:
        # An invite from an earlier stay is not "the invite that precedes the current join".
        p0, p1, a = self.user("p0"), self.user("p1"), self.agent("a")
        room_id = self.make_room(p0, public=True, extra=self.power_levels(state_default=50, invite=0))
        self.helper.join(room_id, p1, tok=self.tokens[p1])
        self.invite_and_join(room_id, p1, a)  # p1 has power 0: skipped
        self.assertIsNone(self.fm_event(room_id))
        self.helper.leave(room_id, a, tok=self.tokens[a])
        self.helper.send_state(room_id, "m.room.power_levels", {"users": {p0: 100, p1: 100}, "state_default": 50, "invite": 0}, tok=self.tokens[p0])
        self.helper.join(room_id, a, tok=self.tokens[a])  # by link now; p1 is no longer relevant
        self.settle()
        self.assertIsNone(self.fm_event(room_id))

    def test_remote_inviter_is_skipped(self) -> None:
        p1, a = self.user("p1"), self.agent("a")
        room_id = self.make_room(p1, public=True)
        self.add_remote_invite(room_id, "@far:other.example", a)
        with capture_logs() as logs:
            self.helper.join(room_id, a, tok=self.tokens[a])
            self.settle()
        self.assertIsNone(self.fm_event(room_id))
        if not WITHOUT_MODULE:
            lines = logs.lines("inblock_agent_marker", "skip")
            self.assertEqual(len(lines), 1, lines)
            self.assertIn("remote", lines[0])
        self.assertEqual([r.getMessage() for r in logs.at_least(logging.WARNING)], [])

    def add_remote_invite(self, room_id: str, sender: str, invitee: str) -> None:
        from synapse.api.room_versions import RoomVersions

        builder = self.hs.get_event_builder_factory().for_room_version(
            RoomVersions.V10,
            {
                "type": "m.room.member",
                "sender": sender,
                "state_key": invitee,
                "room_id": room_id,
                "content": {"membership": "invite"},
            },
        )
        handler = self.hs.get_event_creation_handler()
        event, unpersisted = self.get_success(handler.create_new_client_event(builder))
        context = self.get_success(unpersisted.persist(event))
        persistence = self.hs.get_storage_controllers().persistence
        assert persistence is not None
        self.get_success(persistence.persist_event(event, context))
        self.settle()

    # ------------------------------------------ the agent's own chats (f, OQ1)

    def test_f_agent_created_room_is_marked_in_its_own_name(self) -> None:
        a = self.agent("a")
        room_id = self.make_room(a)
        self.settle()
        self.assertEqual(self.fm_members(room_id), [a])
        self.assertEqual(self.fm_event(room_id).sender, a)

    @override_config({"modules": module_list(mark_own_rooms=False)})
    def test_f2_own_rooms_can_be_switched_off(self) -> None:
        a = self.agent("a")
        room_id = self.make_room(a)
        self.settle()
        self.assertIsNone(self.fm_event(room_id))

    # ---------------------------------------------------------- the sweeps

    # ---------------------------------------------------------- no loop (h)

    def test_h_no_loop(self) -> None:
        p1, a = self.user("p1"), self.agent("a")
        room_b = self.make_room(p1)
        self.invite_and_join(room_b, p1, a)
        self.pump(5)
        self.assertEqual(len(self.fm_events_in(room_b)), 1 if not WITHOUT_MODULE else 0)

    def test_h2_display_name_change_does_not_write_again(self) -> None:
        p1, a = self.user("p1"), self.agent("a")
        room_id = self.make_room(p1)
        self.invite_and_join(room_id, p1, a)
        n = len(self.fm_events_in(room_id))
        self.get_success(
            self.hs.get_profile_handler().set_displayname(
                target_user=UserID.from_string(a),
                requester=create_requester(a),
                new_displayname="Renamed Agent",
                by_admin=True,
            )
        )
        self.pump(5)
        self.assertEqual(len(self.fm_events_in(room_id)), n)

    # ---------------------------------------------------- encrypted room (i)

    def test_i_encrypted_room_gets_a_plaintext_state_event(self) -> None:
        p1, a = self.user("p1"), self.agent("a")
        room_id = self.make_room(p1)
        self.helper.send_state(
            room_id, "m.room.encryption", {"algorithm": "m.megolm.v1.aes-sha2"}, tok=self.tokens[p1]
        )
        self.invite_and_join(room_id, p1, a)
        self.assertEqual(self.fm_members(room_id), [a])
        self.assertEqual(self.fm_event(room_id).type, FM_TYPE)
        self.assertEqual(self.fm_event(room_id).sender, p1)

    # ------------------------------------------- on-flag reaction (x1), x2

    def test_x1_setting_the_flag_marks_existing_chats(self) -> None:
        p1, j = self.user("p1"), self.user("j")
        rooms = []
        for _ in range(2):
            r = self.make_room(p1)
            self.invite_and_join(r, p1, j)
            rooms.append(r)
        self.assertEqual([self.fm_members(r) for r in rooms], [None, None])
        self.put_flag(j, j)
        self.settle()
        self.assertEqual([self.fm_members(r) for r in rooms], [[j], [j]])
        self.assertEqual([self.fm_event(r).sender for r in rooms], [p1, p1])

    def test_x2_two_agents_joining_at_once_are_both_listed(self) -> None:
        p1, a1, a2 = self.user("p1"), self.agent("a1"), self.agent("a2")
        room_id = self.make_room(p1)
        self.helper.invite(room_id, p1, a1, tok=self.tokens[p1])
        self.helper.invite(room_id, p1, a2, tok=self.tokens[p1])
        self.helper.join(room_id, a1, tok=self.tokens[a1])
        self.helper.join(room_id, a2, tok=self.tokens[a2])
        self.settle()
        self.assertEqual(sorted(self.fm_members(room_id) or []), sorted([a1, a2]))

    def test_guest_policy_is_loaded_when_required(self) -> None:
        # run-tests.sh sets the require flag when it found the guest policy checkout.
        if os.environ.get("INBLOCK_AGENT_MARKER_REQUIRE_GUEST_POLICY"):
            self.assertTrue(GUEST_POLICY_LOADED, "guest policy module is not importable")


class SweepCases(MarkerTestBase):
    """g1, g2: the module starts after the chats exist (an upgrade, a restart)."""

    MARKER_AT_START = False

    def build(self, n: int) -> tuple[str, str, list[str]]:
        p1, a = self.user("p1"), self.user("a")
        self.put_flag(a, a)
        rooms = []
        for _ in range(n):
            r = self.make_room(p1)
            self.invite_and_join(r, p1, a)
            rooms.append(r)
        return p1, a, rooms

    def test_g1_start_sweep_marks_existing_chats_as_their_inviters(self) -> None:
        p1, a, rooms = self.build(3)
        self.assertEqual([self.fm_members(r) for r in rooms], [None] * 3)
        self.load_marker()
        self.assertEqual([self.fm_members(r) for r in rooms], [[a]] * 3)
        self.assertEqual([self.fm_event(r).sender for r in rooms], [p1] * 3)

    def test_g2_later_sweeps_write_nothing(self) -> None:
        _, a, rooms = self.build(2)
        marker = self.load_marker()
        ids = [[e[0] for e in self.fm_events_in(r)] for r in rooms]
        self.assertEqual([self.fm_members(r) for r in rooms], [[a]] * 2)
        with capture_logs() as logs:
            self.get_success(marker.sweep())
        self.assertTrue(logs.lines("inblock_agent_marker", "0 room(s) written"))
        self.assertEqual([[e[0] for e in self.fm_events_in(r)] for r in rooms], ids)

    def test_g3_sweep_is_batched_and_only_where_missing(self) -> None:
        p1, a, rooms = self.build(5)
        other = self.make_room(p1)  # a chat the agent is not in
        self.helper.send_state(rooms[0], FM_TYPE, {"service_members": [a]}, tok=self.tokens[p1])
        with capture_logs() as logs:
            self.load_marker(sweep_batch_size=2)
        self.assertEqual([self.fm_members(r) for r in rooms], [[a]] * 5)
        self.assertIsNone(self.fm_event(other))
        self.assertTrue(logs.lines("inblock_agent_marker", "4 room(s) written"))
        self.assertEqual(len(self.fm_events_in(rooms[0])), 1)  # the existing mark was not rewritten


class LogNoiseTestCase(MarkerTestBase):
    """L2: the module must add no WARNING lines per event.

    Synapse 1.165.0 logs logcontext WARNINGs for every event once a module registers
    `on_new_event` (the request that sent the event has finished by the time the
    dispatcher awaits the store). The scenario runs three times on one server, so the
    code path and the log setup are the same: bare, with the module started, and with a
    do-nothing `on_new_event` callback as the control that proves the count would show
    the fault.
    """

    def scenario(self, tag: str) -> list[logging.LogRecord]:
        with capture_logs() as logs:
            p = self.user(f"noise-p-{tag}")
            agent = self.user(f"noise-a-{tag}")
            self.put_flag(agent, agent)
            room_id = self.make_room(p)
            self.helper.invite(room_id, p, agent, tok=self.tokens[p])
            self.helper.join(room_id, agent, tok=self.tokens[agent])
            self.helper.send(room_id, "hello", tok=self.tokens[p])
            self.helper.send_state(room_id, "m.room.topic", {"topic": "t"}, tok=self.tokens[p])
            self.scenario_rooms = [room_id]
            own = self.make_room(agent)
            self.scenario_rooms.append(own)
            self.helper.send_state(own, "m.room.topic", {"topic": "t"}, tok=self.tokens[agent])
            self.pump(5)
        return logs.at_least(logging.WARNING)

    def test_no_new_warnings_per_event(self) -> None:
        if WITHOUT_MODULE:
            self.skipTest("red control")
        base = self.scenario("base")
        self.load_marker()
        loaded = self.scenario("loaded")
        # The module really worked in the measured scenario: both chats are marked.
        self.assertEqual([len(self.fm_members(r) or []) for r in self.scenario_rooms], [1, 1])
        out = os.environ.get("INBLOCK_AGENT_MARKER_L2_OUT")
        if out:
            with open(out, "a") as f:
                f.write(f"base={len(base)} module_loaded={len(loaded)}\n")
        msgs = [f"{r.name}: {r.getMessage()}" for r in loaded]
        self.assertLessEqual(len(loaded), len(base), "\n".join(msgs[:10]))
        self.assertEqual([m for m in msgs if "logcontext" in m], [])

    def test_control_on_new_event_callback_shows_the_noise(self) -> None:
        # Proves the measurement bites: a do-nothing on_new_event callback adds warnings.
        base = self.scenario("cbase")

        async def noop(event: Any, state: Any) -> None:
            return None

        self.hs.get_module_api().register_third_party_rules_callbacks(on_new_event=noop)
        noisy = self.scenario("cnoisy")
        out = os.environ.get("INBLOCK_AGENT_MARKER_L2_OUT")
        if out:
            with open(out, "a") as f:
                f.write(f"control: base={len(base)} on_new_event_noop={len(noisy)}\n")
        self.assertGreater(len(noisy), len(base))
