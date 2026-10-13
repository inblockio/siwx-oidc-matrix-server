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
dry-run the patches against the new commit (in order: entry 2 builds on entry 1), then compare
entry 1 with its upstream PR:

```bash
d=$(mktemp -d) && git -C "$d" init -q && git -C "$d" fetch -q --depth 1 \
  https://github.com/element-hq/lk-jwt-service "<new commit>" && git -C "$d" checkout -q FETCH_HEAD \
  && git -C "$d" apply "$PWD/patches/lk-jwt/require-membership.patch" \
  && git -C "$d" apply --check "$PWD/patches/lk-jwt/restrict-screen-share.patch" && echo OK; rm -rf "$d"
pm() { grep -E '^[+-]' | grep -vE '^(\+\+\+|---) '; }
diff <(gh api repos/element-hq/lk-jwt-service/pulls/250 -H 'Accept: application/vnd.github.diff' | pm) \
     <(pm < patches/lk-jwt/require-membership.patch) && echo "entry 1: no drift"
```

**Shipping** (issue [#40](https://github.com/inblockio/siwx-oidc-matrix-server/issues/40)).
The image is built by `dockerfiles/Dockerfile.lk-jwt` and published by the CI
build-and-push matrix as `ghcr.io/inblockio/siwx-oidc-matrix-server/lk-jwt-service`, so a
patch that stops applying fails CI. It runs as the non-root user 65532. The Dockerfile applies
the patches in the order of this registry (1, then 2). `docker-compose.yml`
uses it with `LIVEKIT_REQUIRE_MEMBERSHIP=true` and the application-service tokens
`LK_JWT_AS_TOKEN`/`LK_JWT_HS_TOKEN` (`env.example`). Synapse (v1.162.0 or later) enables
`experimental_features.msc4502_enabled` and renders the registration from the same two
variables (`entrypoints/matrix_server.sh`, `apply_lk_jwt_membership`). The registration
carries the scope `urn:matrix:client:io.element.msc4502:rooms:is_joined` and a non-exclusive
`users` namespace of every local user (`^@[^:]+:<server_name>$`), which lk-jwt's
delayed-event handling needs; that namespace makes the AS token a credential that can act as
any local user. A failed write of the registration or its `app_service_config_files` entry
stops Synapse from starting. A deployment that pins
`LK_JWT_IMAGE_REF` to an upstream image keeps running unpatched upstream until it changes
that pin.

Entry 2 is opt-in: `docker-compose.yml` passes `LIVEKIT_RESTRICT_SCREEN_SHARE` from
`LK_JWT_RESTRICT_SCREEN_SHARE` in `.env` (default `false`), so a new image changes nothing
until a deployment turns the flag on (`env.example`). With the flag on the container refuses
to start without the application-service configuration, like entry 1. An image without
the patch ignores the variable.

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
- **Upstream observation (not part of this patch, not yet raised upstream):** upstream's
  `is_joined` response parser (`src/helper.rs`, from upstream #214, untouched by this
  patch) treats a response without a `joined` field as not joined (403) instead of as a
  malformed response (502). It fails closed, so it is not a bypass; it is an
  error-classification issue to raise upstream.
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

## 2. `restrict-screen-share.patch` — POLICY

Applied after entry 1 (it builds on its configuration and handler code).

- **What:** a new opt-in environment variable `LIVEKIT_RESTRICT_SCREEN_SHARE` (default
  off, upstream-compatible). When it is on, every endpoint that mints an SFU token (`/sfu/get`,
  `/get_token` and the AS-proxied `/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token`
  for local users) reads the caller's power in the room and writes `canPublishSources` into the
  grant (which supersedes `canPublish` at the SFU):
  - power at or above the room's `kick` level (`users[mxid]`, else `users_default`, default 0;
    `kick` default 50): `camera`, `microphone`, `screen_share`, `screen_share_audio`;
  - everybody else, and **any** failure: `camera`, `microphone`. The token request still
    succeeds.
  - No `m.room.power_levels` event: the creator (`m.room.create` `creator`) is 100, anybody
    else 0. Room version 12 (and later, `org.matrix.hydra.11`): the creators (sender of the
    create event, read by the event ID `$<room id without !>`, and `additional_creators`) are
    above every level.
  - The power is read as the caller: `GET /_matrix/client/v3/rooms/{room}/state/m.room.power_levels/?user_id=<caller>`
    (and `m.room.create`, and for v12 the create event) with the AS token, against the same
    base URL as entry 1 (`hs_server_name` through `LIVEKIT_CS_API_URL_OVERRIDES`, never the
    server of the OpenID token). One request for a host or a pre-v12 member, up to three for a
    v12 member below the kick level. The whole read has a 3 s limit. A user of another
    homeserver is outside the AS namespace: no request, camera and microphone. Callers that
    already have no publish right (restricted access, federated users relayed by
    the S-S route) are unchanged.
  - The service refuses to start with the flag on and no appservice configuration, and a
    value that is not true/false (a typo) is an error.
  - With the flag off there is no extra request and no `canPublishSources`.
- **Why:** upstream hands every participant every source, so who may share a screen could only
  be decided after the join (a participant lowered by the SFU's permission update, with a
  window of seconds, and no enforcement in a call without a portal participant). The
  default belongs in the token: screen share is a host power (`kick` level), and the token is
  signed by the service, so a client cannot edit it.
- **Evidence:** the SFU enforces `canPublishSources` (aqua-meet FP10 forged-share probes);
  the minting paths, the grant construction (`get_join_token`, one place) and the cheap state read
  were probed in aqua-meet card FP12 section 4. The token check against the built image runs at the swap.
- **Tests:** in the patch itself:
  - unit tests in `src/screen_share.rs` (power parsing: `users`, `users_default`, `kick` default,
    numeric strings, malformed content; no power levels event and the creator rule; room version
    12 creators and `additional_creators`; every read failure) and in `src/handler_tests.rs`
    (all three routes: flag off reads nothing, host, member, read error, malformed content,
    3 s timeout, remote user, restricted user, grant spelling), config-table tests;
  - integration tests in `integration-tests/tests/{sfu_get,get_token,get_token_cs}.rs`
    against the fake homeserver, which gained the state and event routes: host at 100 gets the
    screen sources (and the read carried the AS token and `user_id`), power-0 member gets camera
    and microphone, creator rule without a power levels event, read 500 and read timeout still
    200 with camera and microphone, flag off sends no request and carries no restriction.
    The tests decode the minted JWT.

  `cargo test --locked` is green for `-p lk-jwt-service` and
  `-p lk-jwt-service-integration-tests`.
- **Upstream status:** not raised. It is a policy of this deployment (screen share as a host
  power), not a defect of upstream, and it reads state that upstream's model leaves to the SFU
  client.
- **Retirement:** none while the policy is wanted. It is dropped when upstream grows an
  equivalent (a per-room or per-power source policy in the token), or when screen share is
  governed elsewhere.
