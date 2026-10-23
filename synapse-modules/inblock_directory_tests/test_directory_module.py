# SPDX-License-Identifier: Apache-2.0
#
# Copyright 2026 inblock.io assets GmbH
#
# Tests for the inblock_directory Synapse module (docs/directory-search.md).
#
# NOT shipped in the image. They run inside Synapse's own test framework
# (`tests.unittest.HomeserverTestCase`, imported at test time; no Synapse code is copied
# into this file) against a Synapse checkout at the tag the Dockerfile pins:
# synapse-modules/run-tests.sh sets that up.
#
# The homeserver is configured as in production: delegated auth (the stable
# `matrix_authentication_service` block), with a stand-in for siwx-oidc's introspection
# endpoint (`AuthServiceStub`, written here from RFC 7662 and the request Synapse's
# synapse/api/auth/mas.py makes), and the module loaded through `modules:` like any
# other. Every test goes through the module's HTTP resource. Only fixture values appear
# here: the users are @<name>:test and the DID values are made up.

import json
import logging
import re
import threading
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch
from urllib.parse import parse_qs, quote
from wsgiref.simple_server import WSGIRequestHandler, make_server

from twisted.internet.testing import MemoryReactor
from twisted.web.resource import Resource

from synapse.api.room_versions import RoomVersions
from synapse.appservice import ApplicationService
from synapse.module_api.errors import ConfigError
from synapse.rest.client import room, user_directory
from synapse.server import HomeServer
from synapse.storage.roommember import ProfileInfo
from synapse.types import JsonDict, UserID, create_requester
from synapse.util.clock import Clock

from inblock_directory import DirectoryModule
from tests import unittest
from tests.unittest import override_config

SEARCH_PATH = "/_synapse/client/io.inblock/directory/v1/search"
SERVLET_PATH = "/_matrix/client/v3/user_directory/search"
SERVICE = "@dir-service:test"
DEVICE = "FIXTUREDEV"
MAS_SECRET = "fixture-introspection-secret"
DID_FIELD = "io.inblock.did"
GUEST_TYPE = "io.inblock.guest"


class _SilentHandler(WSGIRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        pass


class AuthServiceStub:
    """Stands in for siwx-oidc where Synapse's delegated auth expects its auth service.

    Synapse asks that service one question, whether an access token is live (RFC 7662):
    a form POST to `<endpoint>/oauth2/introspect`, authorised by the shared secret. The
    stub answers from a table of grants and says "inactive" to any token it does not
    hold. It is a real HTTP server on a local port, run on its own thread, because
    Synapse makes the request from native code that needs a real socket.
    """

    INTROSPECT_PATH = "/oauth2/introspect"

    def __init__(self, secret: str) -> None:
        self.secret = secret
        self._grants: dict[str, JsonDict] = {}
        self._httpd = make_server("127.0.0.1", 0, self._app, handler_class=_SilentHandler)
        self._thread = threading.Thread(
            target=self._httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self._thread.start()

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self._httpd.server_port}/"

    def grant(self, token: str, username: str, device_id: str) -> None:
        """Make `token` a live session of the local user `username` on `device_id`."""
        self._grants[token] = {
            "active": True,
            "sub": f"sub-{username}",
            "username": username,
            "scope": f"urn:matrix:client:api:* urn:matrix:client:device:{device_id}",
            "expires_in": 3600,
        }

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join()

    def _app(
        self, environ: dict[str, Any], start_response: Callable[..., Any]
    ) -> Iterable[bytes]:
        authorised = environ.get("HTTP_AUTHORIZATION") == f"Bearer {self.secret}"
        if (
            environ["REQUEST_METHOD"] != "POST"
            or environ["PATH_INFO"] != self.INTROSPECT_PATH
            or not authorised
        ):
            start_response("404 Not Found", [("Content-Length", "0")])
            return [b""]
        size = int(environ.get("CONTENT_LENGTH") or 0)
        form = parse_qs(environ["wsgi.input"].read(size).decode())
        answer = self._grants.get(form.get("token", [""])[0], {"active": False})
        body = json.dumps(answer).encode()
        start_response(
            "200 OK", [("Content-Type", "application/json"), ("Content-Length", str(len(body)))]
        )
        return [body]


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def messages(self, *prefixes: str) -> list[str]:
        """Rendered messages, with the traceback text of an exception, of the records
        whose logger name starts with a prefix (every record when none is given)."""
        out = []
        for r in self.records:
            if prefixes and not r.name.startswith(prefixes):
                continue
            text = r.getMessage()
            if r.exc_info:
                text += "\n" + logging.Formatter().formatException(r.exc_info)
            out.append(text)
        return out


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


def module_config(**settings: Any) -> JsonDict:
    """An @override_config value that loads the module with these settings."""
    return {
        "modules": [{"module": "inblock_directory.DirectoryModule", "config": settings}]
    }


class DirectoryModuleTestCase(unittest.HomeserverTestCase):
    servlets = [room.register_servlets, user_directory.register_servlets]

    def default_config(self) -> JsonDict:
        config = super().default_config()
        config["public_baseurl"] = "https://synapse/"
        config["disable_registration"] = True
        config["matrix_authentication_service"] = {
            "enabled": True,
            "endpoint": self.auth_stub.endpoint,
            "secret": self.auth_stub.secret,
        }
        # The test default turns the directory updater off; the tests need it.
        config["update_user_directory_from_worker"] = None
        # An @override_config of `modules` (already applied by super) wins.
        config.setdefault(
            "modules",
            [
                {
                    "module": "inblock_directory.DirectoryModule",
                    "config": {"admitted_services": [SERVICE], "max_limit": 20},
                }
            ],
        )
        return config

    def make_homeserver(self, reactor: MemoryReactor, clock: Clock) -> HomeServer:
        self.auth_stub = AuthServiceStub(MAS_SECRET)
        return self.setup_test_homeserver()

    def create_resource_dict(self) -> dict[str, Resource]:
        resources = super().create_resource_dict()
        # What the real listener does with the resources modules registered
        # (synapse/app/homeserver.py).
        resources.update(self.hs._module_web_resources)
        return resources

    def prepare(self, reactor: MemoryReactor, clock: Clock, hs: HomeServer) -> None:
        self.store = hs.get_datastores().main
        self.directory_handler = hs.get_user_directory_handler()
        self.tokens: dict[str, str] = {}
        self.service = self.make_user("dir-service", "Directory Service")

    def tearDown(self) -> None:
        self.auth_stub.close()

    # ------------------------------------------------------------------ helpers

    def make_user(
        self, localpart: str, display_name: str | None = None, user_type: str | None = None
    ) -> str:
        """A local account with a device and a token the fake auth service accepts."""
        user_id = f"@{localpart}:test"
        self.get_success(
            self.store.register_user(
                user_id,
                create_profile_with_displayname=display_name or localpart,
                user_type=user_type,
            )
        )
        self.get_success(self.store.store_device(user_id, DEVICE, None))
        # What the registration handler does for a provisioned account: the directory
        # learns the profile (store.register_user alone does not tell it).
        self.get_success(
            self.directory_handler.handle_local_profile_change(
                user_id, ProfileInfo(display_name=display_name or localpart, avatar_url=None)
            )
        )
        token = f"token-{localpart}"
        self.auth_stub.grant(token, localpart, DEVICE)
        self.tokens[user_id] = token
        return user_id

    def settle(self) -> None:
        """Let the directory updater, a background task, catch up with the room events."""
        self.pump(1)

    def make_room(self, creator: str, members: list[str], public: bool) -> str:
        room_id = self.helper.create_room_as(
            creator,
            is_public=public,
            tok=self.tokens[creator],
        )
        for member in members:
            if public:
                self.helper.join(room_id, member, tok=self.tokens[member])
            else:
                self.helper.invite(room_id, creator, member, tok=self.tokens[creator])
                self.helper.join(room_id, member, tok=self.tokens[member])
        self.settle()
        return room_id

    def add_remote_member(self, room_id: str, user_id: str, display_name: str) -> None:
        """A member of another homeserver, written into the room the way federation would."""
        builder = self.hs.get_event_builder_factory().for_room_version(
            RoomVersions.V10,
            {
                "type": "m.room.member",
                "sender": user_id,
                "state_key": user_id,
                "room_id": room_id,
                "content": {"membership": "join", "displayname": display_name},
            },
        )
        handler = self.hs.get_event_creation_handler()
        event, unpersisted = self.get_success(handler.create_new_client_event(builder))
        context = self.get_success(unpersisted.persist(event))
        persistence = self.hs.get_storage_controllers().persistence
        assert persistence is not None
        self.get_success(persistence.persist_event(event, context))
        self.settle()

    def post(self, path: str, body: Any, token: str | None, **kwargs: Any) -> Any:
        return self.make_request("POST", path, body, access_token=token, shorthand=False, **kwargs)

    def search(
        self,
        asker: str,
        term: Any,
        limit: Any = None,
        *,
        as_service: str | None = None,
        token: str | None = "default",
        extra: JsonDict | None = None,
    ) -> Any:
        body: JsonDict = {"asker": asker, "term": term}
        if limit is not None:
            body["limit"] = limit
        body.update(extra or {})
        if token == "default":
            token = self.tokens[as_service or self.service]
        return self.post(SEARCH_PATH, body, token)

    def user_ids(self, channel: Any) -> list[str]:
        self.assertEqual(channel.code, 200, channel.result)
        return [row["user_id"] for row in channel.json_body["results"]]

    def assertEmptyAnswer(self, channel: Any) -> None:
        self.assertEqual(channel.code, 200, channel.result)
        self.assertEqual(channel.json_body, {"results": [], "limited": False})

    @contextmanager
    def spy_on_search(self) -> Iterator[Any]:
        """Real search_users, observed."""
        with patch.object(
            self.directory_handler, "search_users", wraps=self.directory_handler.search_users
        ) as spy:
            yield spy

    def set_did_field(self, user_id: str, value: Any, field: str = DID_FIELD) -> None:
        self.get_success(self.store.set_profile_field(UserID.from_string(user_id), field, value))

    def make_appservice(self, sender: str, token: str = "as-token-fixture") -> str:
        """An application service whose user namespace covers the directory service."""
        self.hs.get_datastores().main.services_cache.append(
            ApplicationService(
                token,
                id="fixture-bridge",
                sender=UserID.from_string(sender),
                namespaces={"users": [{"regex": re.escape(SERVICE), "exclusive": False}]},
            )
        )
        return token

    # ---------------------------------------------------------------- scenarios

    def acceptance_users(self) -> tuple[str, str, str]:
        """A and B share a private room, C shares none; nobody is in a public room."""
        a = self.make_user("a-user", "Ada Alpha")
        b = self.make_user("b-user", "Bea Beta")
        c = self.make_user("c-user", "Cyd Gamma")
        self.make_room(a, [b], public=False)
        return a, b, c

    # -------------------------------------------------------------- 4.2 : auth

    def test_no_token_is_401_unknown_token(self) -> None:
        channel = self.search("@a-user:test", "ada", token=None)
        self.assertEqual(channel.code, 401, channel.result)
        self.assertEqual(channel.json_body["errcode"], "M_UNKNOWN_TOKEN")

    def test_invalid_token_is_401_unknown_token(self) -> None:
        channel = self.search("@a-user:test", "ada", token="not-a-token")
        self.assertEqual(channel.code, 401, channel.result)
        self.assertEqual(channel.json_body["errcode"], "M_UNKNOWN_TOKEN")

    def test_non_admitted_requester_is_403(self) -> None:
        a, _b, _c = self.acceptance_users()
        with self.spy_on_search() as spy:
            channel = self.search(a, "bea", as_service=a)
        self.assertEqual(channel.code, 403, channel.result)
        self.assertEqual(channel.json_body["errcode"], "M_FORBIDDEN")
        spy.assert_not_called()

    def test_admitted_requester_works(self) -> None:
        a, b, _c = self.acceptance_users()
        self.assertEqual(self.user_ids(self.search(a, "bea")), [b])

    def test_locked_admitted_requester_is_403(self) -> None:
        a, _b, _c = self.acceptance_users()
        self.get_success(self.store.set_user_locked_status(self.service, True))
        with self.spy_on_search() as spy:
            channel = self.search(a, "bea")
        self.assertEqual(channel.code, 403, channel.result)
        self.assertEqual(channel.json_body["errcode"], "M_FORBIDDEN")
        spy.assert_not_called()

    def test_deactivated_admitted_requester_is_403(self) -> None:
        a, _b, _c = self.acceptance_users()
        self.get_success(self.store.set_user_deactivated_status(self.service, True))
        with self.spy_on_search() as spy:
            channel = self.search(a, "bea")
        self.assertEqual(channel.code, 403, channel.result)
        spy.assert_not_called()

    @override_config(
        {
            "modules": [
                {
                    "module": "inblock_directory.DirectoryModule",
                    "config": {"admitted_services": [SERVICE, "@dir-guest:test"]},
                }
            ]
        }
    )
    def test_guest_typed_admitted_requester_is_403(self) -> None:
        a, _b, _c = self.acceptance_users()
        guest_service = self.make_user("dir-guest", "Directory Guest", user_type=GUEST_TYPE)
        with self.spy_on_search() as spy:
            channel = self.search(a, "bea", as_service=guest_service)
        self.assertEqual(channel.code, 403, channel.result)
        self.assertEqual(channel.json_body["errcode"], "M_FORBIDDEN")
        spy.assert_not_called()

    def test_requester_lookup_error_is_403(self) -> None:
        a, _b, _c = self.acceptance_users()
        api = self.hs.get_module_api()
        with patch.object(api, "get_userinfo_by_id", side_effect=RuntimeError("db is down")):
            with self.spy_on_search() as spy:
                channel = self.search(a, "bea")
        self.assertEqual(channel.code, 403, channel.result)
        spy.assert_not_called()

    def test_service_in_use_is_refused_once_locked(self) -> None:
        a, b, _c = self.acceptance_users()
        # Synapse caches the token check, so this is the same token the second call uses.
        self.assertEqual(self.user_ids(self.search(a, "bea")), [b])
        self.get_success(self.store.set_user_locked_status(self.service, True))
        with self.spy_on_search() as spy:
            channel = self.search(a, "bea")
        self.assertEqual(channel.code, 403, channel.result)
        self.assertEqual(channel.json_body["errcode"], "M_FORBIDDEN")
        spy.assert_not_called()

    @override_config(module_config(admitted_services=[SERVICE, "@ghost:test"]))
    def test_admitted_mxid_without_a_users_row_is_synapses_own_500(self) -> None:
        """docs/directory-search.md: Synapse's auth answers before the module runs."""
        a, _b, _c = self.acceptance_users()
        self.auth_stub.grant("token-ghost", "ghost", DEVICE)  # a session, but no account
        with self.spy_on_search() as spy:
            channel = self.search(a, "bea", token="token-ghost")
        self.assertEqual(channel.code, 500, channel.result)
        self.assertEqual(channel.json_body["errcode"], "M_FORBIDDEN")
        self.assertEqual(channel.json_body["error"], "User not found")
        spy.assert_not_called()

    def test_appservice_masquerading_as_the_admitted_service_is_403(self) -> None:
        a, _b, _c = self.acceptance_users()
        token = self.make_appservice("@dir-bridge:test")
        with self.spy_on_search() as spy:
            channel = self.post(
                f"{SEARCH_PATH}?user_id={quote(SERVICE)}", {"asker": a, "term": "bea"}, token
            )
        self.assertEqual(channel.code, 403, channel.result)
        self.assertEqual(channel.json_body["errcode"], "M_FORBIDDEN")
        spy.assert_not_called()

    def test_appservice_whose_sender_is_the_admitted_service_is_403(self) -> None:
        a, _b, _c = self.acceptance_users()
        token = self.make_appservice(SERVICE)
        with self.spy_on_search() as spy:
            channel = self.post(SEARCH_PATH, {"asker": a, "term": "bea"}, token)
        self.assertEqual(channel.code, 403, channel.result)
        self.assertEqual(channel.json_body["errcode"], "M_FORBIDDEN")
        spy.assert_not_called()

    @override_config(
        module_config(
            admitted_services=[SERVICE, "@dir-visitor:test", "@dir-oldmark:test"],
            guest_user_type="org.example.visitor",
        )
    )
    def test_guest_marker_comes_from_the_config(self) -> None:
        a, _b, _c = self.acceptance_users()
        visitor_service = self.make_user("dir-visitor", "Directory Visitor", "org.example.visitor")
        old_marker_service = self.make_user("dir-oldmark", "Directory Oldmark", GUEST_TYPE)
        visitor = self.make_user("v-user", "Vic Visitor", user_type="org.example.visitor")
        old_marker = self.make_user("o-user", "Olga Oldmark", user_type=GUEST_TYPE)
        self.make_room(a, [visitor, old_marker], public=False)

        with self.spy_on_search() as spy:
            refused = self.search(a, "ada", as_service=visitor_service)
            empty = self.search(visitor, "ada")
        self.assertEqual(refused.code, 403, refused.result)
        self.assertEqual(refused.json_body["errcode"], "M_FORBIDDEN")
        self.assertEmptyAnswer(empty)
        spy.assert_not_called()

        # The default marker is only a name once the config says otherwise.
        self.assertEqual(self.search(a, "ada", as_service=old_marker_service).code, 200)
        self.assertEqual(self.user_ids(self.search(old_marker, "ada")), [a])

    # --------------------------------------------------------- 4.2 : the asker

    def test_unknown_asker_gets_the_empty_object(self) -> None:
        self.acceptance_users()
        public = self.make_user("p-user", "Pia Public")
        self.make_room(public, [], public=True)
        with self.spy_on_search() as spy:
            channel = self.search("@nobody:test", "pia")
        self.assertEmptyAnswer(channel)
        spy.assert_not_called()

    def test_remote_asker_gets_the_empty_object(self) -> None:
        public = self.make_user("p-user", "Pia Public")
        self.make_room(public, [], public=True)
        with self.spy_on_search() as spy:
            channel = self.search("@someone:elsewhere.example", "pia")
        self.assertEmptyAnswer(channel)
        spy.assert_not_called()

    def test_deactivated_asker_gets_the_empty_object(self) -> None:
        a, _b, _c = self.acceptance_users()
        self.get_success(self.store.set_user_deactivated_status(a, True))
        with self.spy_on_search() as spy:
            channel = self.search(a, "bea")
        self.assertEmptyAnswer(channel)
        spy.assert_not_called()

    def test_locked_asker_gets_the_empty_object(self) -> None:
        a, _b, _c = self.acceptance_users()
        self.get_success(self.store.set_user_locked_status(a, True))
        with self.spy_on_search() as spy:
            channel = self.search(a, "bea")
        self.assertEmptyAnswer(channel)
        spy.assert_not_called()

    def test_guest_typed_asker_gets_the_empty_object(self) -> None:
        guest = self.make_user("g-user", "Gus Guest", user_type=GUEST_TYPE)
        other = self.make_user("o-user", "Olly Other")
        self.make_room(other, [guest], public=False)
        with self.spy_on_search() as spy:
            channel = self.search(guest, "olly")
        self.assertEmptyAnswer(channel)
        spy.assert_not_called()

    def test_asker_lookup_error_gets_the_empty_object(self) -> None:
        a, _b, _c = self.acceptance_users()
        api = self.hs.get_module_api()
        real = api.get_userinfo_by_id

        async def fail_for_asker(user_id: str) -> Any:
            if user_id == a:
                raise RuntimeError("db is down")
            return await real(user_id)

        with patch.object(api, "get_userinfo_by_id", side_effect=fail_for_asker):
            with self.spy_on_search() as spy:
                channel = self.search(a, "bea")
        self.assertEmptyAnswer(channel)
        spy.assert_not_called()

    def test_valid_asker_reaches_search_users(self) -> None:
        a, b, _c = self.acceptance_users()
        with self.spy_on_search() as spy:
            channel = self.search(a, "bea", 5)
        self.assertEqual(self.user_ids(channel), [b])
        spy.assert_called_once_with(a, "bea", 5)

    # ----------------------------------------------------- 4.2 : visibility

    def test_asker_without_a_shared_room_does_not_find_the_private_user(self) -> None:
        a, b, c = self.acceptance_users()
        self.assertEqual(self.user_ids(self.search(a, "bea")), [b])
        self.assertEqual(self.user_ids(self.search(c, "bea")), [])
        self.assertEqual(self.user_ids(self.search(b, "ada")), [a])

    @override_config({"user_directory": {"enabled": False}})
    def test_directory_disabled_gives_the_empty_object(self) -> None:
        a, _b, _c = self.acceptance_users()
        with self.spy_on_search() as spy:
            channel = self.search(a, "bea")
        self.assertEmptyAnswer(channel)
        spy.assert_not_called()

    @override_config({"rc_user_directory": {"per_second": 0.001, "burst_count": 2}})
    def test_rate_limit_is_per_asker(self) -> None:
        a, _b, c = self.acceptance_users()
        self.assertEqual(self.search(a, "bea").code, 200)
        self.assertEqual(self.search(a, "bea").code, 200)
        limited = self.search(a, "bea")
        self.assertEqual(limited.code, 429, limited.result)
        self.assertEqual(limited.json_body["errcode"], "M_LIMIT_EXCEEDED")
        # Another asker has its own allowance, and the same service token keeps working.
        self.assertEqual(self.search(c, "bea").code, 200)

    # ------------------------------------------------------ 4.2 : validation

    def test_term_bounds(self) -> None:
        a, b, _c = self.acceptance_users()
        for bad in ("", "   ", "\t\n", "x" * 65, f" {'x' * 65} ", 7, None, ["bea"], "be\x00a"):
            with self.subTest(term=bad):
                channel = self.search(a, bad)
                self.assertEqual(channel.code, 400, channel.result)
                self.assertEqual(channel.json_body["errcode"], "M_INVALID_PARAM")
        # 64 characters after trimming is the longest allowed; the trim is applied.
        self.assertEqual(self.search(a, "x" * 64).code, 200)
        self.assertEqual(self.search(a, f"  {'x' * 64}  ").code, 200)
        with self.spy_on_search() as spy:
            self.assertEqual(self.user_ids(self.search(a, "  bea  ")), [b])
        spy.assert_called_once_with(a, "bea", 10)

    def test_term_must_be_encodable_as_utf8(self) -> None:
        a, _b, _c = self.acceptance_users()
        token = self.tokens[self.service]

        def body(escaped_term: str) -> bytes:
            return ('{"asker": "%s", "term": "%s"}' % (a, escaped_term)).encode()

        for lone in ("zq\\ud800xj", "zq\\udc00xj", "\\udbff", "\\udfffzz", "ok\\ud83d"):
            with self.subTest(term=lone):
                channel = self.make_request(
                    "POST", SEARCH_PATH, body(lone), access_token=token, shorthand=False
                )
                self.assertEqual(channel.code, 400, channel.result)
                self.assertEqual(channel.json_body["errcode"], "M_INVALID_PARAM")
        # A surrogate pair is one character, an emoji, and fine.
        pair = self.make_request(
            "POST", SEARCH_PATH, body("\\ud83d\\ude00"), access_token=token, shorthand=False
        )
        self.assertEqual(pair.code, 200, pair.result)

    def test_limit_bounds(self) -> None:
        a, _b, _c = self.acceptance_users()
        for bad in (0, -1, 21, 1.5, "5", True, [5], {"n": 5}):
            with self.subTest(limit=bad):
                channel = self.search(a, "bea", bad)
                self.assertEqual(channel.code, 400, channel.result)
                self.assertEqual(channel.json_body["errcode"], "M_INVALID_PARAM")
        self.assertEqual(self.search(a, "bea", 1).code, 200)
        self.assertEqual(self.search(a, "bea", 20).code, 200)

    def test_limit_defaults_to_ten(self) -> None:
        a, _b, _c = self.acceptance_users()
        with self.spy_on_search() as spy:
            self.assertEqual(self.search(a, "bea").code, 200)
        spy.assert_called_once_with(a, "bea", 10)

    def test_asker_must_be_a_user_id(self) -> None:
        self.acceptance_users()
        for bad in ("", "a-user", "@a-user", "a-user:test", "@a user:test", "@a\nuser:test", "@a\ud800:test", 5, None):
            with self.subTest(asker=bad):
                channel = self.post(SEARCH_PATH, {"asker": bad, "term": "bea"}, self.tokens[self.service])
                self.assertEqual(channel.code, 400, channel.result)
                self.assertEqual(channel.json_body["errcode"], "M_INVALID_PARAM")
        missing = self.post(SEARCH_PATH, {"term": "bea"}, self.tokens[self.service])
        self.assertEqual(missing.code, 400, missing.result)

    def test_body_must_be_a_small_json_object(self) -> None:
        a, _b, _c = self.acceptance_users()
        token = self.tokens[self.service]
        for raw in (b"not json", b"", b"[1]", b'"text"', b"\xff\xfe", b"[" * 4000):
            with self.subTest(body=raw[:12]):
                channel = self.make_request(
                    "POST", SEARCH_PATH, raw, access_token=token, shorthand=False
                )
                self.assertEqual(channel.code, 400, channel.result)
        # A constant JSON does not define, in a key the module never reads: no type check
        # could refuse it, only the decoder's parse_constant does.
        for constant in (b"NaN", b"Infinity", b"-Infinity"):
            with self.subTest(constant=constant):
                raw = b'{"asker": "' + a.encode() + b'", "term": "bea", "pad": ' + constant + b"}"
                channel = self.make_request(
                    "POST", SEARCH_PATH, raw, access_token=token, shorthand=False
                )
                self.assertEqual(channel.code, 400, channel.result)
                self.assertEqual(channel.json_body["errcode"], "M_NOT_JSON")
        too_big = json.dumps({"asker": a, "term": "bea", "pad": "x" * 5000}).encode()
        channel = self.make_request("POST", SEARCH_PATH, too_big, access_token=token, shorthand=False)
        self.assertEqual(channel.code, 413, channel.result)
        self.assertEqual(channel.json_body["errcode"], "M_TOO_LARGE")

    def test_only_post_is_served(self) -> None:
        channel = self.make_request(
            "GET", SEARCH_PATH, access_token=self.tokens[self.service], shorthand=False
        )
        self.assertEqual(channel.code, 405, channel.result)

    # ----------------------------------------------------- 4.2 : the answer

    def test_row_shape_and_did_field(self) -> None:
        a, b, _c = self.acceptance_users()
        bare = self.make_user("n-user", "Nia Nofield")
        self.make_room(a, [bare], public=False)
        proof = {"did": "did:key:zFixtureB", "proof": "header.payload.signature"}
        self.set_did_field(b, proof)
        # An avatar must not leak: Synapse's own row carries it, ours does not.
        self.get_success(
            self.hs.get_profile_handler().set_avatar_url(
                target_user=UserID.from_string(b),
                requester=create_requester(b),
                new_avatar_url="mxc://test/avatar",
            )
        )
        self.settle()
        theirs = self.post(SERVLET_PATH, {"search_term": "bea"}, self.tokens[a])
        self.assertEqual(theirs.json_body["results"][0]["avatar_url"], "mxc://test/avatar")

        both = self.search(a, "b")
        self.assertEqual(both.code, 200, both.result)
        rows = {row["user_id"]: row for row in both.json_body["results"]}
        self.assertEqual(rows[b], {"user_id": b, "display_name": "Bea Beta", "did_field": proof})
        self.assertFalse(both.json_body["limited"])

        no_field = self.search(a, "nia")
        self.assertEqual(no_field.json_body["results"], [{"user_id": bare, "display_name": "Nia Nofield"}])

    @override_config(module_config(admitted_services=[SERVICE], did_field="org.example.identity"))
    def test_did_field_name_comes_from_the_config(self) -> None:
        a, b, _c = self.acceptance_users()
        bare = self.make_user("n-user", "Nia Nofield")
        self.make_room(a, [bare], public=False)
        renamed = {"did": "did:key:zFixtureRenamed", "proof": "p.q.r"}
        # b has both names; only the configured one counts. bare has the default name only.
        self.set_did_field(b, {"did": "did:key:zFixtureDefault", "proof": "x.y.z"})
        self.set_did_field(b, renamed, field="org.example.identity")
        self.set_did_field(bare, {"did": "did:key:zFixtureOther", "proof": "x.y.z"})

        found = self.search(a, "b")
        self.assertEqual(found.code, 200, found.result)
        rows = {row["user_id"]: row for row in found.json_body["results"]}
        self.assertEqual(rows[b], {"user_id": b, "display_name": "Bea Beta", "did_field": renamed})
        self.assertEqual(
            self.search(a, "nia").json_body["results"],
            [{"user_id": bare, "display_name": "Nia Nofield"}],
        )

    def test_remote_users_are_included_without_did_field(self) -> None:
        a = self.make_user("a-user", "Ada Alpha")
        lounge = self.make_room(a, [], public=True)
        remote = "@rem:elsewhere.example"
        self.add_remote_member(lounge, remote, "Remy Remote")

        channel = self.search(a, "remy")
        self.assertEqual(channel.code, 200, channel.result)
        self.assertEqual(
            channel.json_body["results"], [{"user_id": remote, "display_name": "Remy Remote"}]
        )

    def test_limit_caps_the_rows_and_sets_limited(self) -> None:
        a = self.make_user("a-user", "Ada Alpha")
        lounge = self.make_room(a, [], public=True)
        for i in range(5):
            self.helper.join(lounge, self.make_user(f"w{i}-user", f"Walt {i}"), tok=self.tokens[f"@w{i}-user:test"])
        channel = self.search(a, "walt", 2)
        self.assertEqual(len(self.user_ids(channel)), 2)
        self.assertTrue(channel.json_body["limited"])
        self.assertEqual(len(self.user_ids(self.search(a, "walt", 20))), 5)

    def test_module_set_equals_the_servlet_set_for_the_same_asker(self) -> None:
        """H1 at unit level: search_users for the asker is what Element's search gets."""
        alice = self.make_user("alice", "Ada Alpha")
        bea = self.make_user("bea", "Ada Beta")
        cyd = self.make_user("cyd", "Ada Gamma")
        dex = self.make_user("dex", "Ada Delta")
        eli = self.make_user("eli", "Ada Epsilon")
        fay = self.make_user("fay", "Ada Zeta")
        # alice and bea share a private room; fay and bea share another one (not alice's).
        self.make_room(alice, [bea], public=False)
        self.make_room(fay, [bea], public=False)
        # cyd, eli and a remote user are in a public room; dex is in no room.
        lounge = self.make_room(cyd, [eli], public=True)
        self.add_remote_member(lounge, "@ada-rem:elsewhere.example", "Ada Remote")
        self.get_success(self.store.set_user_locked_status(eli, True))
        self.set_did_field(bea, {"did": "did:key:zFixtureBea", "proof": "p.q.r"})

        for asker in (alice, bea, dex):
            for term in ("ada", "ada b", "beta", "remote", "a", "zeta", "nobody-has-this"):
                for limit in (1, 3, 20):
                    with self.subTest(asker=asker, term=term, limit=limit):
                        ours = self.search(asker, term, limit)
                        theirs = self.post(
                            SERVLET_PATH,
                            {"search_term": term, "limit": limit},
                            self.tokens[asker],
                        )
                        self.assertEqual(ours.code, 200, ours.result)
                        self.assertEqual(theirs.code, 200, theirs.result)
                        self.assertEqual(
                            [(r["user_id"], r["display_name"]) for r in ours.json_body["results"]],
                            [(r["user_id"], r["display_name"]) for r in theirs.json_body["results"]],
                        )
                        self.assertEqual(ours.json_body["limited"], theirs.json_body["limited"])

        # The scenario really exercises the rule: it is not an empty-equals-empty pass.
        found = self.user_ids(self.search(alice, "ada", 20))
        self.assertIn(bea, found)
        self.assertIn(cyd, found)
        self.assertIn("@ada-rem:elsewhere.example", found)
        self.assertNotIn(dex, found)  # no shared room
        self.assertNotIn(eli, found)  # locked
        self.assertNotIn(fay, found)  # shares a room with bea only
        # dex, with no room at all, still sees the public room's members, as in Element.
        self.assertIn(cyd, self.user_ids(self.search(dex, "ada", 20)))

    # ------------------------------------------------------------ 4.2 : logs

    def test_query_log_names_requester_asker_and_count_but_never_the_term(self) -> None:
        a, b, _c = self.acceptance_users()
        term = "zqxjvk"
        self.make_user("z-user", "Zqxjvk Zed")
        self.make_room(a, [self.make_user("y-user", "Yan Why")], public=True)
        with capture_logs() as logs:
            ok = self.search(a, term)
            empty = self.search("@nobody:test", term)
            refused = self.search(a, term, as_service=a)
            bad_limit = self.search(a, term, 999)
            garbage = self.make_request(
                "POST", SEARCH_PATH, f"{{{term} not json".encode(),
                access_token=self.tokens[self.service], shorthand=False,
            )
        self.assertEqual(ok.code, 200)
        self.assertEqual(empty.code, 200)
        self.assertEqual(refused.code, 403)
        self.assertEqual(bad_limit.code, 400)
        self.assertEqual(garbage.code, 400)

        ours = logs.messages("inblock_directory")
        self.assertIn(
            f"directory search: requester={self.service} asker={a} results=0", ours
        )
        self.assertIn(
            f"directory search: requester={self.service} asker=@nobody:test results=0", ours
        )
        # Nothing at all that mentions the term: not ours, not Synapse's HTTP layer.
        for text in logs.messages("inblock_directory", "synapse.http", "synapse.access"):
            self.assertNotIn(term, text)
        # A body that is not JSON is logged by nobody, at any level.
        for text in logs.messages():
            if "not json" in text or "{" + term in text:
                self.fail(f"the request body reached a log record: {text[:200]!r}")

    def test_search_failure_is_500_and_logs_no_term(self) -> None:
        a, _b, _c = self.acceptance_users()
        term = "zqxjvk"

        async def boom(*args: Any) -> Any:
            raise RuntimeError(f"syntax error near '{term}'")

        with capture_logs() as logs:
            with patch.object(self.directory_handler, "search_users", side_effect=boom):
                channel = self.search(a, term)
        self.assertEqual(channel.code, 500, channel.result)
        self.assertEqual(channel.json_body["errcode"], "M_UNKNOWN")
        self.assertNotIn(term, json.dumps(channel.json_body))
        for text in logs.messages("inblock_directory", "synapse.http", "synapse.access"):
            self.assertNotIn(term, text)
        self.assertTrue(
            any("RuntimeError" in text for text in logs.messages("inblock_directory")),
            "the failure class should be logged",
        )

    # ------------------------------------------------------------ 4.2 : config

    def test_parse_config_accepts_the_documented_settings(self) -> None:
        cfg = DirectoryModule.parse_config(
            {"admitted_services": [SERVICE, "@other-service:test"], "max_limit": 7}
        )
        self.assertEqual(cfg.admitted_services, frozenset({SERVICE, "@other-service:test"}))
        self.assertEqual(cfg.max_limit, 7)
        self.assertEqual(DirectoryModule.parse_config({"admitted_services": [SERVICE]}).max_limit, 20)

    def test_parse_config_markers_default_and_override(self) -> None:
        default = DirectoryModule.parse_config({"admitted_services": [SERVICE]})
        self.assertEqual(default.guest_user_type, "io.inblock.guest")
        self.assertEqual(default.did_field, "io.inblock.did")
        custom = DirectoryModule.parse_config(
            {
                "admitted_services": [SERVICE],
                "guest_user_type": "org.example.visitor",
                "did_field": "org.example.identity",
            }
        )
        self.assertEqual(custom.guest_user_type, "org.example.visitor")
        self.assertEqual(custom.did_field, "org.example.identity")

    def test_parse_config_refuses_anything_else(self) -> None:
        bad_configs: list[JsonDict] = [
            {},
            {"admitted_services": []},
            {"admitted_services": SERVICE},
            {"admitted_services": [SERVICE, "not-an-mxid"]},
            {"admitted_services": [SERVICE, 5]},
            {"admitted_services": [SERVICE, "@x y:test"]},
            {"admitted_services": [SERVICE, "@:test"]},
            {"admitted_services": [SERVICE, "@" + "x" * 300 + ":test"]},
            {"admitted_services": [SERVICE], "max_limit": 0},
            {"admitted_services": [SERVICE], "max_limit": 51},
            {"admitted_services": [SERVICE], "max_limit": "20"},
            {"admitted_services": [SERVICE], "max_limit": True},
            {"admitted_services": [SERVICE], "admitted_service": [SERVICE]},
            *({"admitted_services": [SERVICE], "guest_user_type": bad} for bad in
              ("", " ", "a b", "x" * 256, "tab\there", "ünï", 5, None, ["io.inblock.guest"])),
            *({"admitted_services": [SERVICE], "did_field": bad} for bad in
              ("", "Io.Inblock.Did", "1abc", "a b", "x" * 256, "_a", "ünï", 5, None, ["io.inblock.did"])),
        ]
        for config in bad_configs:
            with self.subTest(config=config):
                with self.assertRaises(ConfigError):
                    DirectoryModule.parse_config(config)

    def test_a_non_local_admitted_service_stops_the_start(self) -> None:
        cfg = DirectoryModule.parse_config({"admitted_services": [SERVICE, "@svc:elsewhere.example"]})
        with self.assertRaises(ConfigError):
            DirectoryModule(cfg, self.hs.get_module_api())

