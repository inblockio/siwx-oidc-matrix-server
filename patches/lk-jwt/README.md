# lk-jwt-service vendored patches — the registry

This directory is the **complete, canonical list of every modification we apply to
upstream lk-jwt-service** (element-hq/lk-jwt-service, the MatrixRTC authorisation
service that hands out LiveKit SFU tokens). `dockerfiles/Dockerfile.lk-jwt` is the single
build source for the patched image. It fetches upstream at a pinned commit and applies
exactly the patches listed here with `git apply`, so **a patch that stops applying fails
the image build loudly**, never silently at runtime.

**License.** The patch changes lk-jwt-service files headed `AGPL-3.0-only OR
LicenseRef-Element-Commercial`; the commercial option is Element's alone, so the patch is
AGPL-3.0-only, not Apache-2.0 like the rest of the repository. See [`NOTICE`](../../NOTICE).

The rules are the same as `patches/element-web/README.md`: every entry states *what*,
*why*, the *evidence*, its *upstream status* and its *retirement condition*. Behavioral
patches name their tests. Classifications are UPSTREAM DEFECT, UPSTREAM-TRACKED and
POLICY; only POLICY is permanent. The upstream links here are picked up by the upstream
refresh of `patches/element-web/README.md` step 4b, which greps `patches/*/README.md`.

**Bump procedure** (every change of `LK_JWT_TAG`/`LK_JWT_COMMIT` in the Dockerfile):
dry-run the patch against the new commit, then compare it with its upstream PR:

```bash
d=$(mktemp -d) && git -C "$d" init -q && git -C "$d" fetch -q --depth 1 \
  https://github.com/element-hq/lk-jwt-service "<new commit>" && git -C "$d" checkout -q FETCH_HEAD \
  && git -C "$d" apply --check "$PWD/patches/lk-jwt/require-membership.patch" && echo OK; rm -rf "$d"
pm() { grep -E '^[+-]' | grep -vE '^(\+\+\+|---) '; }
diff <(gh api repos/element-hq/lk-jwt-service/pulls/250 -H 'Accept: application/vnd.github.diff' | pm) \
     <(pm < patches/lk-jwt/require-membership.patch) && echo "entry 1: no drift"
```

**Open gap.** The image is built by `dockerfiles/Dockerfile.lk-jwt` but **not shipped**:
it is not in the CI build-and-push matrix, no compose file uses it, and Synapse does not
yet enable MSC4502 or carry lk-jwt's appservice registration. Until that lands, every
stack runs unpatched upstream lk-jwt-service. Tracked as follow-up
[inblockio/siwx-oidc-matrix-server#40](https://github.com/inblockio/siwx-oidc-matrix-server/issues/40).

## 1. `require-membership.patch` — UPSTREAM-TRACKED

- **What:** a new opt-in environment variable `LIVEKIT_REQUIRE_MEMBERSHIP` (default off,
  upstream-compatible). When it is on, the standalone endpoints `/sfu/get`, `/get_token`
  and `/delegate_delayed_leave` (and the proxied `delegate_delayed_leave`) ask the
  configured homeserver whether the caller is joined to the room. They ask through
  MSC4502 `is_joined`, with the appservice token. The check runs after the OpenID
  validation and before any LiveKit room is created or delayed-leave job is registered.
  - The check goes to `hs_server_name`, never to the server named in the OpenID token.
  - Not joined is 403 `M_FORBIDDEN`, and any other failure is 502 (fail closed).
  - The service refuses to start with the flag on and no appservice configuration.
  - The README documents the flag, Synapse's `msc4502_enabled` and the AS registration
    scope.
- **Why:** upstream checks membership only on the AS-proxied `/_matrix/…/rtc/livekit/*`
  routes. The standalone endpoints that Element Call uses check only the OpenID token, so
  any user who can mint an OpenID token gets an SFU token for **any** room, including
  rooms they were never admitted to. That is unacceptable once guest accounts exist on a
  stack.
- **Evidence:** a lab on Synapse 1.162 with `msc4502_enabled` passes 21/21; unpatched
  upstream passes 14/21. A member gets a token, a non-member gets 403 on all three routes,
  and a delayed leave still fires after the member leaves.
- **Tests:** in the patch itself:
  - unit tests in `src/handler_tests.rs`: per endpoint, joined, not joined (no room
    created), error, and flag off never calls `is_joined`;
  - config-table tests;
  - integration tests in `integration-tests/tests/{sfu_get,get_token,delegate_delayed_leave}.rs`
    against the fake homeserver.

  `cargo test --locked` is green for `-p lk-jwt-service` and
  `-p lk-jwt-service-integration-tests`.
- **Upstream status:** UPSTREAM-TRACKED as
  [element-hq/lk-jwt-service#250](https://github.com/element-hq/lk-jwt-service/pull/250),
  opened 2026-10-11 from `FantasticoFox:require-membership`, rebased on upstream main.
  Its added and removed lines are identical to this patch (no drift on 2026-10-11).
  - A push to #250 must update this patch in the same change, and the other way round.
  - The related upstream PR #235 (periodic re-check and SFU kick) complements this patch
    rather than replacing it.
- **Retirement:** when a release that contains #250, or an equivalent standalone-endpoint
  membership check, is pinned in `dockerfiles/Dockerfile.lk-jwt`, or when the compose
  files move to that upstream image.
