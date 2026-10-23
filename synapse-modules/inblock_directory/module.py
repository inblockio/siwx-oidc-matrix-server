# SPDX-License-Identifier: Apache-2.0
#
# Copyright 2026 inblock.io assets GmbH
#
# Directory search for admitted service accounts.
#
# A service (for example a node's share dialog) asks "whom may this asker find
# under this term?" and gets exactly the rows Synapse's own user directory would
# give that asker, each with the raw `io.inblock.did` profile field of the local
# users. The module never verifies the proof in that field: the caller does.
#
# Contract: docs/directory-search.md. Tests: synapse-modules/inblock_directory_tests,
# run by synapse-modules/run-tests.sh against Synapse at the tag the Dockerfile pins.
#
# Public ModuleApi calls used: register_web_resource, get_user_by_req,
# get_userinfo_by_id, is_mine. Synapse-internal calls (they can change in any
# release, which is why the bump procedure runs the tests): `api._hs` and from it
# get_clock(), get_datastores().main.get_profile_field(), get_user_directory_handler()
# .search_users(), config.userdirectory.user_directory_search_enabled,
# config.ratelimiting.rc_user_directory, plus Ratelimiter and StoreError.
#
# Nothing in this file may log, echo or put into an exception message the search
# term or the request body: the term is private to the asker.

import json
import logging
import unicodedata
from dataclasses import dataclass
from typing import Any

from twisted.internet.defer import CancelledError

from synapse.api.errors import StoreError
from synapse.api.ratelimiting import Ratelimiter
from synapse.module_api import DirectServeJsonResource, ModuleApi
from synapse.module_api.errors import (
    Codes,
    ConfigError,
    InvalidClientCredentialsError,
    SynapseError,
)
from synapse.types import UserID

logger = logging.getLogger(__name__)

SEARCH_PATH = "/_synapse/client/io.inblock/directory/v1/search"

# The profile field siwx-oidc writes: {"did": ..., "proof": ...}.
DID_FIELD = "io.inblock.did"

# Our guest marker (the guest policy module's default guest_user_type). Synapse's
# own is_guest flag is never set under delegated auth, so the user type is the
# only signal there is.
GUEST_USER_TYPE = "io.inblock.guest"

MAX_BODY_BYTES = 4096
TERM_MAX_CHARS = 64
DEFAULT_LIMIT = 10
DEFAULT_MAX_LIMIT = 20
# Element's own servlet clamps `limit` to 50; a larger cap here would be a bulk export.
MAX_LIMIT_CEILING = 50
MXID_MAX_CHARS = 255

_CONFIG_KEYS = {"admitted_services", "max_limit"}


def _is_mxid(value: object) -> bool:
    """A well-formed, printable, single-token Matrix user ID."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= MXID_MAX_CHARS
        and value.isprintable()
        and " " not in value
        and UserID.is_valid(value)
        and bool(UserID.from_string(value).localpart)
    )


@dataclass(frozen=True)
class DirectoryConfig:
    admitted_services: frozenset[str]
    max_limit: int


class DirectoryModule:
    def __init__(self, config: DirectoryConfig, api: ModuleApi) -> None:
        # An admitted service is a local account (it signs in here); a foreign or
        # misspelt domain would never match and only hide the mistake.
        for service in sorted(config.admitted_services):
            if not api.is_mine(service):
                raise ConfigError(
                    f"admitted_services entry {service!r} is not a user of this homeserver"
                )
        api.register_web_resource(SEARCH_PATH, _SearchResource(config, api))
        logger.info(
            "directory search registered at %s for %d admitted service account(s), max_limit=%d",
            SEARCH_PATH,
            len(config.admitted_services),
            config.max_limit,
        )

    @staticmethod
    def parse_config(config: dict[str, Any]) -> DirectoryConfig:
        unknown = sorted(set(config) - _CONFIG_KEYS)
        if unknown:
            raise ConfigError(f"unknown directory module setting(s): {', '.join(unknown)}")

        services = config.get("admitted_services")
        if not isinstance(services, list) or not services:
            raise ConfigError("admitted_services must be a non-empty list of Matrix user IDs")
        for entry in services:
            if not _is_mxid(entry):
                raise ConfigError(f"admitted_services entry {entry!r} is not a Matrix user ID")

        max_limit = config.get("max_limit", DEFAULT_MAX_LIMIT)
        if type(max_limit) is not int or not 1 <= max_limit <= MAX_LIMIT_CEILING:
            raise ConfigError(f"max_limit must be an integer from 1 to {MAX_LIMIT_CEILING}")

        return DirectoryConfig(frozenset(services), max_limit)


class _SearchResource(DirectServeJsonResource):
    def __init__(self, config: DirectoryConfig, api: ModuleApi) -> None:
        hs = api._hs
        super().__init__(clock=hs.get_clock())
        self._api = api
        self._admitted = config.admitted_services
        self._max_limit = config.max_limit
        self._hs = hs
        self._profile_store = hs.get_datastores().main
        self._directory = hs.get_user_directory_handler()
        # The same limiter Element's servlet uses, keyed on the asker rather than
        # the calling service so that one person cannot drain another's allowance.
        self._ratelimiter = Ratelimiter(
            store=hs.get_datastores().main,
            clock=hs.get_clock(),
            cfg=hs.config.ratelimiting.rc_user_directory,
        )

    async def _async_render_POST(self, request: Any) -> tuple[int, dict[str, Any]]:
        try:
            requester = await self._api.get_user_by_req(request)
        except InvalidClientCredentialsError:
            # No token and an unknown token answer alike (contract 4.2). Synapse
            # itself would say M_MISSING_TOKEN for the first.
            raise SynapseError(401, "Unrecognised access token", Codes.UNKNOWN_TOKEN)
        service = requester.user.to_string()

        if service not in self._admitted or not await self._account_ok(service):
            logger.info("directory search refused: requester=%s is not an admitted service", service)
            raise SynapseError(403, "Not permitted", Codes.FORBIDDEN)

        asker, term, limit = self._parse_request(request)

        if not self._hs.config.userdirectory.user_directory_search_enabled:
            return self._answer(service, asker, [], False)

        # Fail closed: Synapse's search alone would still return the members of
        # public rooms for an asker that does not exist.
        if not self._api.is_mine(asker) or not await self._account_ok(asker):
            return self._answer(service, asker, [], False)

        await self._ratelimiter.ratelimit(None, key=asker)

        try:
            found = await self._directory.search_users(asker, term, limit)
            rows = [await self._row(hit) for hit in found["results"]]
        except (SynapseError, CancelledError):
            raise
        except Exception as e:
            # Only the class: the message of a database error can carry the query.
            logger.error(
                "directory search failed: requester=%s asker=%s error=%s",
                service,
                asker,
                type(e).__name__,
            )
            raise SynapseError(500, "Directory search failed", Codes.UNKNOWN)

        return self._answer(service, asker, rows, bool(found["limited"]))

    def _answer(
        self, service: str, asker: str, rows: list[dict[str, Any]], limited: bool
    ) -> tuple[int, dict[str, Any]]:
        logger.info(
            "directory search: requester=%s asker=%s results=%d", service, asker, len(rows)
        )
        return 200, {"results": rows, "limited": limited}

    async def _account_ok(self, user_id: str) -> bool:
        """Synapse's token check ignores locked and deactivated accounts, so the
        module asks the account table itself. Any lookup error is a failed check."""
        try:
            info = await self._api.get_userinfo_by_id(user_id)
        except CancelledError:
            raise
        except Exception as e:
            logger.error("account lookup failed: user=%s error=%s", user_id, type(e).__name__)
            return False
        return (
            info is not None
            and not info.is_deactivated
            and not info.locked
            and info.user_type != GUEST_USER_TYPE
        )

    def _parse_request(self, request: Any) -> tuple[str, str, int]:
        # Not parse_json_object_from_request: on bad JSON it logs the body, and the
        # body holds the term.
        raw = request.content.read(MAX_BODY_BYTES + 1)
        if len(raw) > MAX_BODY_BYTES:
            raise SynapseError(413, "Request body too large", Codes.TOO_LARGE)
        try:
            body = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
        except ValueError:  # includes UnicodeDecodeError
            raise SynapseError(400, "Content not JSON.", Codes.NOT_JSON)
        if not isinstance(body, dict):
            raise SynapseError(400, "Content must be a JSON object.", Codes.BAD_JSON)

        asker = body.get("asker")
        if not _is_mxid(asker):
            raise SynapseError(400, "`asker` must be a Matrix user ID", Codes.INVALID_PARAM)

        term = body.get("term")
        if not isinstance(term, str):
            raise SynapseError(400, "`term` must be a string", Codes.INVALID_PARAM)
        term = term.strip()
        if not 1 <= len(term) <= TERM_MAX_CHARS or any(
            unicodedata.category(c) == "Cc" for c in term
        ):
            raise SynapseError(
                400,
                f"`term` must be 1 to {TERM_MAX_CHARS} characters without control characters",
                Codes.INVALID_PARAM,
            )

        limit = body.get("limit", min(DEFAULT_LIMIT, self._max_limit))
        if type(limit) is not int or not 1 <= limit <= self._max_limit:
            raise SynapseError(
                400, f"`limit` must be an integer from 1 to {self._max_limit}", Codes.INVALID_PARAM
            )
        return asker, term, limit

    async def _row(self, hit: dict[str, Any]) -> dict[str, Any]:
        """One search hit as the contract returns it. Synapse's avatar_url is dropped."""
        user_id = hit["user_id"]
        row: dict[str, Any] = {"user_id": user_id, "display_name": hit.get("display_name")}
        if self._api.is_mine(user_id):
            try:
                value = await self._profile_store.get_profile_field(
                    UserID.from_string(user_id), DID_FIELD
                )
            except StoreError as e:
                # 404: no profile row or no such field. Anything else is an error.
                if e.code != 404:
                    raise
            else:
                if value is not None:
                    row["did_field"] = value
        return row


def _reject_constant(name: str) -> Any:
    raise ValueError(f"unsupported JSON constant {name}")
