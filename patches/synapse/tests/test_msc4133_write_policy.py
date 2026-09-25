#
# Regression tests for patches/synapse/msc4133-profile-field-write-policy.patch.
#
# NOT shipped in the image. The Dockerfile patches the installed tree under
# site-packages, which has no `tests` package. These run against an upstream
# Synapse CHECKOUT carrying the patch, as step 5 of the bump procedure in
# patches/synapse/README.md:
#
#   cp patches/synapse/tests/test_msc4133_write_policy.py \
#      <synapse-checkout>/tests/handlers/
#   (cd <synapse-checkout> && poetry run trial tests.handlers.test_msc4133_write_policy)
#
# They pin the two properties of OUR policy that the upstream PR's own tests
# (element-hq/synapse#19980) do not:
#
#   1. The real field name, `io.inblock.did`, is guarded on both the stable REST
#      route and the handler, for PUT and DELETE, while the siwx-oidc admin path
#      (by_admin=True) still writes it.
#   2. ORDERING against upstream #20172 (v1.161.0): the policy refusal (403)
#      is decided BEFORE upstream's user-existence lookup (404). A non-admin
#      write of a denied field is 403 whatever the store says; an admin write
#      is exempt from the policy and gets upstream's 404 for a user that does
#      not exist, exactly as unpatched Synapse would.
#

from twisted.internet.testing import MemoryReactor

from synapse.api.errors import Codes, SynapseError
from synapse.rest import admin
from synapse.rest.client import login, profile
from synapse.server import HomeServer
from synapse.types import UserID, create_requester
from synapse.util.clock import Clock

from tests import unittest

DID_FIELD = "io.inblock.did"
DENYLIST = {"experimental_features": {"msc4133_key_denylist": [DID_FIELD]}}


class Msc4133WritePolicyTestCase(unittest.HomeserverTestCase):
    servlets = [
        admin.register_servlets_for_client_rest_resource,
        login.register_servlets,
        profile.register_servlets,
    ]

    def prepare(self, reactor: MemoryReactor, clock: Clock, hs: HomeServer) -> None:
        self.handler = hs.get_profile_handler()
        self.store = hs.get_datastores().main
        self.owner = self.register_user("owner", "pass")
        self.owner_tok = self.login("owner", "pass")
        self.owner_id = UserID.from_string(self.owner)
        self.ghost_id = UserID.from_string("@never-existed:test")

    def _set(self, target: UserID, field: str, by_admin: bool) -> None:
        self.get_success_or_raise(
            self.handler.set_profile_field(
                target_user=target,
                requester=create_requester(target),
                field_name=field,
                new_value="did:example:attacker",
                by_admin=by_admin,
            )
        )

    def _stored(self, field: str) -> object:
        return self.get_success(self.store.get_profile_field(self.owner_id, field))

    # -- handler level: ordering against upstream's 404 -----------------------

    @unittest.override_config(DENYLIST)
    def test_nonadmin_denied_field_is_403_even_for_unknown_user(self) -> None:
        """Policy is decided before existence: a denied field never yields 404."""
        with self.assertRaises(SynapseError) as cm:
            self._set(self.ghost_id, DID_FIELD, by_admin=False)
        self.assertEqual(cm.exception.code, 403)
        self.assertEqual(cm.exception.errcode, Codes.FORBIDDEN)

    @unittest.override_config(DENYLIST)
    def test_admin_denied_field_unknown_user_keeps_upstream_404(self) -> None:
        """Admins are exempt from the policy, so upstream's 404 applies to them."""
        with self.assertRaises(SynapseError) as cm:
            self._set(self.ghost_id, DID_FIELD, by_admin=True)
        self.assertEqual(cm.exception.code, 404)
        self.assertEqual(cm.exception.errcode, Codes.NOT_FOUND)

    @unittest.override_config(DENYLIST)
    def test_nonadmin_unlisted_field_unknown_user_keeps_upstream_404(self) -> None:
        """Control: the patch does not alter upstream's path for unlisted fields."""
        with self.assertRaises(SynapseError) as cm:
            self._set(self.ghost_id, "org.example.free", by_admin=False)
        self.assertEqual(cm.exception.code, 404)

    @unittest.override_config(DENYLIST)
    def test_admin_write_then_user_cannot_overwrite_or_delete(self) -> None:
        """The provider (admin) writes the DID; the user can neither replace nor
        remove it, and the stored value survives both attempts."""
        self.get_success(
            self.handler.set_profile_field(
                target_user=self.owner_id,
                requester=create_requester(self.owner_id),
                field_name=DID_FIELD,
                new_value="did:key:provider-asserted",
                by_admin=True,
            )
        )
        self.assertEqual(self._stored(DID_FIELD), "did:key:provider-asserted")

        with self.assertRaises(SynapseError) as cm:
            self._set(self.owner_id, DID_FIELD, by_admin=False)
        self.assertEqual(cm.exception.code, 403)

        with self.assertRaises(SynapseError) as cm:
            self.get_success_or_raise(
                self.handler.delete_profile_field(
                    self.owner_id,
                    create_requester(self.owner_id),
                    DID_FIELD,
                    by_admin=False,
                )
            )
        self.assertEqual(cm.exception.code, 403)
        self.assertEqual(self._stored(DID_FIELD), "did:key:provider-asserted")

    # -- REST level: the real field name on the stable route -----------------

    @unittest.override_config(DENYLIST)
    def test_rest_user_put_and_delete_of_did_field_are_403(self) -> None:
        path = f"/_matrix/client/v3/profile/{self.owner}/{DID_FIELD}"
        for channel in (
            self.make_request(
                "PUT",
                path,
                content={DID_FIELD: "did:key:x"},
                access_token=self.owner_tok,
            ),
            self.make_request("DELETE", path, access_token=self.owner_tok),
        ):
            self.assertEqual(channel.code, 403, channel.result)
            self.assertEqual(channel.json_body["errcode"], Codes.FORBIDDEN)

        # An unlisted custom field stays user-writable.
        channel = self.make_request(
            "PUT",
            f"/_matrix/client/v3/profile/{self.owner}/org.example.free",
            content={"org.example.free": "ok"},
            access_token=self.owner_tok,
        )
        self.assertEqual(channel.code, 200, channel.result)

    @unittest.override_config(DENYLIST)
    def test_rest_admin_put_of_did_field_succeeds(self) -> None:
        self.register_user("admin", "pass", admin=True)
        admin_tok = self.login("admin", "pass")
        channel = self.make_request(
            "PUT",
            f"/_matrix/client/v3/profile/{self.owner}/{DID_FIELD}",
            content={DID_FIELD: "did:key:provider-asserted"},
            access_token=admin_tok,
        )
        self.assertEqual(channel.code, 200, channel.result)
        self.assertEqual(self._stored(DID_FIELD), "did:key:provider-asserted")

    def test_no_config_leaves_did_field_writable(self) -> None:
        """Without the denylist the patch is inert (stock behaviour)."""
        channel = self.make_request(
            "PUT",
            f"/_matrix/client/v3/profile/{self.owner}/{DID_FIELD}",
            content={DID_FIELD: "did:key:x"},
            access_token=self.owner_tok,
        )
        self.assertEqual(channel.code, 200, channel.result)
