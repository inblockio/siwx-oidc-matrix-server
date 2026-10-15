# lk-jwt-service vendored patches — the registry

This directory is the **complete, canonical list of every modification we apply to
upstream lk-jwt-service** (element-hq/lk-jwt-service, the MatrixRTC authorisation
service that hands out LiveKit SFU tokens). **There are none at present: the image is
upstream v0.9.0, built unmodified.** `dockerfiles/Dockerfile.lk-jwt` is the single build
source of our own image. It fetches upstream at a pinned commit and would apply exactly the
patches listed here with `git apply`, so **a patch that stops applying fails the image
build loudly**, never silently at runtime.

The rules are the same as `patches/element-web/README.md`: every entry states *what*,
*why*, the *evidence*, its *upstream status* and its *retirement condition*. Behavioral
patches name their tests. Classifications are UPSTREAM DEFECT, UPSTREAM-TRACKED and
POLICY; only POLICY is permanent. The upstream links here are picked up by the upstream
refresh of `patches/element-web/README.md` step 4b, which greps `patches/*/README.md`.
A new patch also needs its `NOTICE` entry (AGPL-3.0-only: the upstream files are headed
`AGPL-3.0-only OR LicenseRef-Element-Commercial` and the commercial option is Element's alone).

**Bump procedure** (every change of `LK_JWT_TAG`/`LK_JWT_COMMIT` in the Dockerfile): with
patches, dry-run each against the new commit; in any case run upstream's `cargo test --locked`
(root and `integration-tests/`) on the tree the image is built from:

```bash
d=$(mktemp -d) && git -C "$d" init -q && git -C "$d" fetch -q --depth 1 \
  https://github.com/element-hq/lk-jwt-service "<new commit>" && git -C "$d" checkout -q FETCH_HEAD \
  && git -C "$d" apply --check "$PWD/patches/lk-jwt/<patch>" && echo OK; rm -rf "$d"
```

**Shipping** (issue [#40](https://github.com/inblockio/siwx-oidc-matrix-server/issues/40)).
The image is built by `dockerfiles/Dockerfile.lk-jwt` and published by the CI
build-and-push matrix as `ghcr.io/inblockio/siwx-oidc-matrix-server/lk-jwt-service`, so a
patch that stops applying fails CI. It runs as the non-root user 65532. The Dockerfile builds
upstream v0.9.0 as it is. The room-membership check is upstream's (formerly `require-membership.patch`): it is on
when lk-jwt runs as an application service and `LIVEKIT_FULL_ACCESS_HOMESERVERS` is exactly
`LIVEKIT_HS_SERVER_NAME`. `docker-compose.yml` sets both from `MATRIX_HOST` and passes the
application-service tokens `LK_JWT_AS_TOKEN`/`LK_JWT_HS_TOKEN` (`env.example`); without the
tokens lk-jwt refuses to start. Synapse (v1.162.0 or later) enables
`experimental_features.msc4502_enabled` and renders the registration from the same two
variables (`entrypoints/matrix_server.sh`, `apply_lk_jwt_membership`). The registration
carries the scope `urn:matrix:client:io.element.msc4502:rooms:is_joined` and a non-exclusive
`users` namespace of every local user (`^@[^:]+:<server_name>$`), which lk-jwt's
delayed-event handling needs; that namespace makes the AS token a credential that can act as
any local user. A failed write of the registration or its `app_service_config_files` entry
stops Synapse from starting. A deployment that pins
`LK_JWT_IMAGE_REF` to an upstream image checks membership only from v0.9.0 on.

`scripts/lk-jwt-membership-accept.sh` is the acceptance test for `apply_lk_jwt_membership`
(CI job `lk-jwt-membership-accept`; locally `scripts/lk-jwt-membership-accept.sh --image <synapse image>`
if no mikefarah yq v4 is on the PATH). It extracts the function from the entrypoint and
checks idempotency, the users-namespace regex (matched with `re.match`, as Synapse does),
the unconfigured path and each refusal path. Run it when you touch the function.

**Operator note: watch `application_services_txns`.** The registration has `url: null`, so
Synapse has nowhere to deliver events and the service should accumulate no transactions.
Read-only check against Synapse's database (SQLite: `sqlite3 -readonly /data/homeserver.db`):

```sql
SELECT as_id, count(*) FROM application_services_txns GROUP BY as_id;
```

(columns `as_id`, `txn_id`, `event_ids`, schema unchanged in Synapse 1.162). Expect no row
for `lk-jwt-service`. A count that grows means Synapse is queueing events for it and never
delivering them, because the registration gained a `url` or something else changed its
delivery; the table, and the disk it sits on, grow without bound until that is fixed.

## Retired: `restrict-screen-share.patch` (2026-10-15)

A POLICY patch (opt-in `LIVEKIT_RESTRICT_SCREEN_SHARE`): callers below the room's `kick`
level got tokens whose `canPublishSources` was camera and microphone only. Deleted on
purpose, not superseded: screen share is parked as a feature, and the restriction does not exist at all in this repository any more, in any
room. A first rework limited it to meeting rooms; that was dropped too. Consequences:

- lk-jwt hands out upstream's grant. Who may share is decided by the clients, and by the
  SFU's permission updates after the join, as with any stock lk-jwt.
- The variable `LIVEKIT_RESTRICT_SCREEN_SHARE` and the `.env` key `LK_JWT_RESTRICT_SCREEN_SHARE`
  are gone from `docker-compose.yml` and `env.example`. An `.env` that still sets the key is
  ignored by compose; an image that still contains the patch (the current default pin) reads
  only the container variable, which compose no longer passes, so it stays off.
- The default `LK_JWT_IMAGE_REF` pin (build of main at 42ac0f4) still contains the patch,
  inert. It moves to the first CI build of main without the patch in a pin-only commit.
- The patch stays in this repository's history (`patches/lk-jwt/restrict-screen-share.patch`
  at commit 42ac0f4, PR #48) should the policy return.

## Retired: `require-membership.patch` (2026-10-13)

Upstream merged it, reworked, as
[element-hq/lk-jwt-service#250](https://github.com/element-hq/lk-jwt-service/pull/250)
(squash `0e176b1eca44e67b11484d0bdf56999807bf2b8e`) and released it as v0.9.0 the same day
(`gh api repos/element-hq/lk-jwt-service/compare/v0.9.0...0e176b1eca44e67b11484d0bdf56999807bf2b8e --jq .status`
is `identical`). The Dockerfile pins v0.9.0 and the patch is deleted. Differences from the
patch that matter here:

- **No `LIVEKIT_REQUIRE_MEMBERSHIP`.** The check is on when the service runs as an application
  service and `LIVEKIT_FULL_ACCESS_HOMESERVERS` is exactly one entry equal to
  `LIVEKIT_HS_SERVER_NAME` (`verifies_legacy_membership` in `src/handler.rs`). Compose feeds
  both from `MATRIX_HOST`, so they cannot diverge.
- **It fails open.** Upstream does not refuse to start when the check is off; it logs a `warn`
  ("... do not verify room membership ..."), and `info` ("... verify room membership through
  the homeserver") when it is on. Compose always sets the server name, so lk-jwt refuses to
  start without the two tokens.

Still open:

- Done 2026-10-15: the default `LK_JWT_IMAGE_REF` moved to the build of main at 42ac0f4
  (v0.9.0 plus the then-current screen-share patch) and `LIVEKIT_REQUIRE_MEMBERSHIP` left `docker-compose.yml` in the same
  commit. The aqua-meet stacks (`stack/up.sh`, `tools/fps-lab.sh`) drop it when they move to
  such an image.
- Verify enforcement on the built image: the startup log shows the `info` line, and a
  non-member gets 403 on `/sfu/get`, `/get_token` and `/delegate_delayed_leave` (the
  21-case MSC4502 lab).
- Upstream observation, not raised: the `is_joined` parser (`src/helper.rs`) treats a
  response without `joined` as not joined (403) instead of malformed (502). It fails closed.
