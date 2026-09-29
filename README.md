# siwx-oidc-matrix-server

Docker Compose deployment stack that runs a Synapse Matrix homeserver fronted by
siwx-oidc (CAIP-122 OIDC provider) so agents and wallets can authenticate with
EIP-191, Ed25519, or P-256 keys. Includes a self-hosted Element Web client that
sends signed-out users straight to the siwx-oidc sign-in page (wallet or passkey),
and MatrixRTC calls through LiveKit.

The Synapse and Element Web images built here are **not stock**: see
[Upstream deviations (patches)](#upstream-deviations-patches).

## Table of Contents

1. [Quick Start](#quick-start)
2. [Services](#services)
3. [Dependencies](#dependencies)
4. [Upstream deviations (patches)](#upstream-deviations-patches)
5. [Parameters](#parameters)
6. [Security](#security)
7. [Examples](#examples)
8. [Element Web Client](#element-web-client)
9. [Mobile Wallet Usage](#mobile-wallet-usage)
10. [Issues/Integrations](#issuesintegrations)
11. [Contributing](#contributing)

## Quick Start

```bash
docker network create portal-net   # once: docker-compose.yml joins it as an external network
./start-matrix.sh \
  --MATRIX_HOST matrix.example.com \
  --SIWEOIDC_HOST siwx-oidc.example.com \
  --CLIENT_HOST element.example.com
```

This writes `.env` (secrets included, mode 600) and starts the services. It does
**not** terminate TLS or route hostnames: `docker-compose.yml` contains no reverse
proxy. Run a Caddy on the `portal-net` network that proxies the three hostnames to
`matrix_synapse`, `siwx-oidc` and `element-web`, and `/livekit/*` to `livekit` and
`lk-jwt-service`; `Caddyfile.production` is the configuration the reference
deployment uses. For a local, HTTP-only stack with Caddy included, use
`docker-compose.local.yml` (see its header).

## Services

| Service | Image (default in `docker-compose.yml`) | Purpose |
|---|---|---|
| `matrix_synapse` | `ghcr.io/inblockio/siwx-oidc-matrix-server/synapse`, built from `dockerfiles/Dockerfile` (Synapse + 1 patch) | Matrix homeserver; authentication delegated to siwx-oidc |
| `siwx-oidc` | `ghcr.io/inblockio/siwx-oidc` | CAIP-122 OIDC provider (wallet and passkey sign-in); takes the place of the Matrix Authentication Service |
| `redis` | `redis` | Session and token store for siwx-oidc |
| `element-web` | `ghcr.io/inblockio/siwx-oidc-matrix-server/element-web`, built from source by `dockerfiles/Dockerfile.element` (Element Web + 10 patches) | Web client |
| `livekit` | `livekit/livekit-server` | MatrixRTC SFU for Element Call, with embedded TURN |
| `lk-jwt-service` | `ghcr.io/element-hq/lk-jwt-service` | Issues LiveKit access tokens to Matrix users |

The reverse proxy is not a service in `docker-compose.yml`. The deployments use
Caddy, custom-built with the `layer4` and `rate_limit` modules
(`dockerfiles/Dockerfile.caddy-l4`), either on the external `portal-net` network
(production) or in its own compose project (`docker-compose.caddy-proxy.yml`,
dev-staging). Federation runs on port 443 through `.well-known/matrix/server`
delegation served by that proxy; Synapse's own `serve_server_wellknown` is off.

## Dependencies

What the bundle depends on, where each version is pinned, and whether we run it
stock. The table shows the **repository defaults**. Each deployed box overrides
every `*_IMAGE_REF` in its own `.env` (digest pins), and those files are not in this
repository; the comments in `docker-compose.yml` record where production is known to
run a different version (Redis 8.8.0, LiveKit v1.12.0, lk-jwt-service 0.5.0 as of
their last update).

| Component | Version / pin | Pinned in | Stock / patched / built |
|---|---|---|---|
| Synapse | `v1.161.0` (`matrixdotorg/synapse:v1.161.0@sha256:6b95dd129e35…`, index digest) | `dockerfiles/Dockerfile:30` | **Patched**: 1 source patch, plus config written by `entrypoints/matrix_server.sh`. Built by CI as `ghcr.io/inblockio/siwx-oidc-matrix-server/synapse` |
| Synapse image the stack runs | default `…/synapse:sha-33a0c95@sha256:32abd6fa5e31…` (CI build of main at 33a0c95); dev-staging default `…/synapse@sha256:2f1b6c17406c…` | `docker-compose.yml:24`, `docker-compose.dev-staging.yml:65` (`SYNAPSE_IMAGE_REF`); `real-stack/Dockerfile.synapse:26` (same default, for the local real stack) | Built here |
| Element Web | `v1.12.29` (git tag of element-hq/element-web; the build fails unless it resolves to commit `2d90d6b7b601…`) | `dockerfiles/Dockerfile.element:24-25` (`ARG ELEMENT_WEB_TAG`, `ARG ELEMENT_WEB_COMMIT`) | **Built from source and patched**: 10 source patches, plus a runtime overlay |
| Element Web image the stack runs | default `…/element-web:sha-33a0c95@sha256:1761832069bd…` (CI build of main at 33a0c95); dev-staging default `…/element-web@sha256:8cea1873e574…` | `docker-compose.yml:115`, `docker-compose.dev-staging.yml:174` (`ELEMENT_IMAGE_REF`) | Built here |
| Element Call | `0.24.0` (`@element-hq/element-call-embedded`) | Not pinned here: Element Web `v1.12.29`'s `apps/web/package.json` and `pnpm-lock.yaml` | Stock, embedded in the Element Web bundle (`element_call.use_exclusively` in `config/element-config.json`). Moves only with the Element Web tag |
| matrix-js-sdk | `42.4.0` | Not pinned here: same, via the Element Web tag | Stock, bundled |
| Element Web build toolchain | `node:24.20.0-bullseye@sha256:25f3016fcdae…`; pnpm `11.23.0` (upstream `devEngines`, via corepack); `pnpm install --frozen-lockfile` | `dockerfiles/Dockerfile.element:22`, `:168` | Stock |
| Element Web serving base | `nginxinc/nginx-unprivileged:1.31.6-alpine-slim@sha256:c81a27f28bc2…` | `dockerfiles/Dockerfile.element:198` | Stock, with our `config/element-nginx.conf` and security headers |
| siwx-oidc | default `ghcr.io/inblockio/siwx-oidc:sha-40efae9@sha256:54739f4813bf…` (CI build of siwx-oidc main at 40efae9) | `docker-compose.yml:84`, `docker-compose.dev-staging.yml:120` (`SIWX_OIDC_IMAGE_REF`) | First-party, built in [inblockio/siwx-oidc](https://github.com/inblockio/siwx-oidc) |
| Redis | `8.10.2` (`redis:8.10.2@sha256:d5ac52db24d4…`) | `docker-compose.yml:62`, `docker-compose.dev-staging.yml:100` (`REDIS_IMAGE_REF`) | Stock, run with `--appendonly yes` |
| LiveKit server | `v1.13.7` (`livekit/livekit-server:v1.13.7@sha256:6fd3b7088874…`) | `docker-compose.yml:145`, `docker-compose.dev-staging.yml:202` (`LIVEKIT_IMAGE_REF`) | Stock, configured by `config/livekit.yaml` (embedded TURN) |
| lk-jwt-service | `0.7.0` (`ghcr.io/element-hq/lk-jwt-service:0.7.0@sha256:e0c7cecfa74e…`) | `docker-compose.yml:192`, `docker-compose.dev-staging.yml:262` (`LK_JWT_IMAGE_REF`) | Stock, configured |
| Caddy | `v2.11.4` (`caddy:2.11.4-builder@sha256:369218c81ca6…`, `caddy:2.11.4@sha256:0c994536bddb…`) | `dockerfiles/Dockerfile.caddy-l4:124`, `:129` | **Custom build** with xcaddy and the two modules below. Built by CI as `ghcr.io/inblockio/siwx-oidc-matrix-server/caddy-l4` |
| Caddy module `layer4` (mholt/caddy-l4) | `v0.1.2` | `dockerfiles/Dockerfile.caddy-l4:126` | Stock module (TURN-TLS SNI split on :443) |
| Caddy module `rate_limit` (mholt/caddy-ratelimit) | commit `5625512f24f6` (upstream has no tag after `v0.1.0`) | `dockerfiles/Dockerfile.caddy-l4:127` | Stock module at a commit (edge rate limit for siwx-oidc `GET /resolve`) |
| Caddy image the edge runs | `…/caddy-l4@sha256:1c9825f346b1…` (digest only) | `docker-compose.caddy-proxy.yml:72` (dev-staging). Production's Caddy is defined outside this repository; the `Caddyfile.production` header records the same digest | Built here |
| yq (Synapse image) | `v4.53.3`, SHA-256 checked | `dockerfiles/Dockerfile:36-38` | Stock binary |
| Debian `patch` (Synapse image build) | not version-pinned: floats within the Debian release (trixie) that the base digest fixes. Build tool only: installed, used and purged in one layer, so it is not in the image | `dockerfiles/Dockerfile:65-72` | Stock |
| Database | SQLite at `/data/homeserver.db` (Synapse's generated default) | `entrypoints/matrix_server.sh:5` (`/start.py generate`) | Stock; not a separate service |

Not part of the bundle: PostgreSQL (Synapse runs on SQLite), coturn (LiveKit's
embedded TURN serves instead), the Matrix Authentication Service (siwx-oidc takes
its place through Synapse's `matrix_authentication_service` config),
nginx-proxy/acme-companion (replaced by Caddy), and watchtower (no compose file here
defines it).

### Floating pins

A pin floats when the same reference can resolve to different bytes tomorrow. These
do:

- **`:main` defaults for first-party images**: `docker-compose.dev-staging.yml:120`
  (siwx-oidc) and the template `.env.dev-staging.example:49`, `:50`, `:55`. A stack
  started from them pulls whatever `:main` is at that moment. `docker-compose.yml`
  no longer floats: its defaults are the tag-plus-digest builds listed in the table
  above, so `start-matrix.sh` (which runs `docker compose up --pull always`) starts
  the same bytes every time. Pin by digest in `.env` to run anything newer.
- **Build-time package**: Debian `patch` in the Synapse build
  (`dockerfiles/Dockerfile:66`) floats on purpose, within the Debian release the
  base digest fixes, and is purged before its layer ends.
- **CI**: `.github/workflows/docker.yml` uses actions by major tag
  (`actions/checkout@v4`, `docker/login-action@v3`, `docker/metadata-action@v5`,
  `docker/build-push-action@v6`) on `ubuntu-latest`. `.github/workflows/checks.yml`
  pins its one action by commit and runs on `ubuntu-24.04`.

The other image references in the Dockerfiles, compose files and `e2e-harness/`
scripts are pinned by digest, with the version tag alongside wherever one exists
(the local and test stacks included); the Element Web source tag is checked against
its commit, and the yq download against its checksum.

Production, per the repository's own records: its `.env` pins Redis as
`redis:latest@sha256:aa049e68…` (`docker-compose.yml:54-61`). The tag reads `latest`,
but the digest fixes the bytes, so a pull does not move it; the production `.env` is
not in this repository, so confirm on the box. Production also carries a leftover
watchtower container that no compose file here defines; per
`docs/deployment-recovery-reference.md:75` and `:534` it is scoped to itself and
updates nothing (verified 2026-06-12).

## Upstream deviations (patches)

The Synapse and Element Web images this repository builds are **not stock**. Each
carries vendored source patches, applied at image build time so that a patch that
stops applying fails the build instead of shipping silently. Every patch has a
registry entry stating what it changes, why, the evidence, its upstream status and
its retirement condition. The registries are the source of truth; the lists below
only mirror them, and CI fails a pull request whose patches, registries, Dockerfiles
and these lists disagree (see the maintainer rule below).

**Synapse: 1 patch.** Registry: [`patches/synapse/README.md`](patches/synapse/README.md).
Applied by `dockerfiles/Dockerfile` with `patch --fuzz=0`.

1. [`msc4133-profile-field-write-policy.patch`](patches/synapse/msc4133-profile-field-write-policy.patch):
   backport of element-hq/synapse#19980. A non-admin may not write or delete a
   denylisted custom profile field, which makes the provider-published
   `io.inblock.did` field read-only for users. UPSTREAM-TRACKED.

Synapse settings that differ from upstream defaults are written by
`entrypoints/matrix_server.sh`, not patched: delegated authentication to siwx-oidc
(`matrix_authentication_service`), the `msc4133_key_denylist` with a startup guard
that refuses to run without the patch, MatrixRTC experimental features (MSC4108,
MSC4143, MSC3266, MSC4222), delayed-event and message rate limits, retention off by
default, server notices, and `serve_server_wellknown: false`.

**Element Web: 10 patches**, applied in this order by `dockerfiles/Dockerfile.element`
with `git apply`; the order is load-bearing. Registry:
[`patches/element-web/README.md`](patches/element-web/README.md).

1. [`force-first-device-recovery.patch`](patches/element-web/force-first-device-recovery.patch):
   recovery-key (4S) setup is mandatory on the first device, and the 4S probes read
   the response body so a `{}` tombstone counts as "no key". POLICY.
2. [`setup-encryption-busy-wedge.patch`](patches/element-web/setup-encryption-busy-wedge.patch):
   recovers from the post-verification `Phase.Busy` dead end. UPSTREAM DEFECT.
3. [`honest-qr-disabled-reason.patch`](patches/element-web/honest-qr-disabled-reason.patch):
   "Show QR code" names this session's own crypto state instead of blaming the
   account provider. UPSTREAM HONESTY DEFECT.
4. [`offer-verify-current-session.patch`](patches/element-web/offer-verify-current-session.patch):
   an unverified current session is offered "Verify session" instead of only the
   destructive identity reset. UPSTREAM DEAD END.
5. [`auto-approve-check-code.patch`](patches/element-web/auto-approve-check-code.patch):
   the MSC4108 QR check code approves once both digits are typed. UX POLICY.
6. [`browser-eventindex.patch`](patches/element-web/browser-eventindex.patch):
   encrypted-room search in the browser, behind the labs flag
   `feature_web_event_index`. Tracks element-hq/element-web#34718 and deliberately
   leads it. UPSTREAM-TRACKED.
7. [`show-attested-did.patch`](patches/element-web/show-attested-did.patch): shows
   the provider-attested DID (`io.inblock.did`) in the member panel and in All
   settings → Account. POLICY.
8. [`resolve-did-search.patch`](patches/element-web/resolve-did-search.patch): a DID
   typed into Spotlight or the invite dialog resolves to that user's Matrix ID, with
   the DID proof verified in the browser. Depends on 7. POLICY.
9. [`sw-versions-no-cache-on-error.patch`](patches/element-web/sw-versions-no-cache-on-error.patch):
   the service worker never caches a failed `/_matrix/client/versions` check
   (filed as element-hq/element-web#35242). UPSTREAM DEFECT.
10. [`sw-media-401-token-retry.patch`](patches/element-web/sw-media-401-token-retry.patch):
    a media request that gets a 401 waits up to 5 s for the app's token refresh and
    retries once. Depends on 9. UPSTREAM DEFECT.

Element Web also carries runtime deltas that are not `.patch` files: nginx caching
and security headers, the service-worker boot shim, a per-build `sw.js` stamp, the
inblock.io branding overlay, entrypoint templating, and a bind-mounted config. They
are listed at the end of the Element Web registry.

Caddy is not patched, but it is not the stock image either; see the Caddy rows under
[Dependencies](#dependencies).

### Maintainer rule: one commit for pin, registry and README

Whenever a pin or a patch changes, update this README and the matching registry
**in the same commit**: the Dependencies table for a version or digest, and the
lists above for a patch that is added, dropped, renamed or reordered.

The patch half of this rule is checked. `scripts/check-patch-registry.sh` requires
every `patches/*/*.patch` to have a numbered entry in its directory's registry, to be
applied by the Dockerfile that owns that directory, and to be listed above, with the
registry and the list in the Dockerfile's apply order. CI runs it together with
`scripts/check-patch-hunks.py` on every pull request and every push to `main`
(`.github/workflows/checks.yml`, the repository's first pull-request check). The pin
half is not checked: a Dependencies row is updated by hand.

```bash
scripts/check-patch-registry.sh    # one OK line per patch directory, or FAIL lines and exit 1
```

## Parameters

`start-matrix.sh` accepts only the flags listed here. Any other flag makes it print
`unknown arg` and exit without starting anything.

### General

#### --ENABLE_DEBUG

Enables debug mode: disables detached Docker Compose, sets siwx-oidc log level
to debug for real-time log output. The log level is written into `.env` only when
`.env` is first created; on later runs the value already in `.env` applies.

#### --stop

Stop all containers.

#### --reset

**Destroys all data.** Removes containers, volumes, and the `.env` file. Irreversible.

### SIWX-OIDC Config

> **Note:** Environment variable names use the `SIWEOIDC_` prefix for backward
> compatibility with configuration tooling.

#### --SIWEOIDC_HOST **Required**

Hostname for the siwx-oidc OIDC provider (e.g., `siwx-oidc.example.com`).

#### --SIWEOIDC_PORT

Port for the siwx-oidc service. Default: `8081`.

### Matrix

#### --MATRIX_HOST **Required**

Hostname for the Matrix server (e.g., `matrix.example.com`).

#### --MATRIX_PORT

Port for the Matrix server. Default: `8080`.

#### --MATRIX_MESSAGE_LIFETIME

Written to `.env` as `MATRIX_MESSAGE_LIFETIME`. Default: `4w`. It does **not**
delete messages. Message retention is off unless `MATRIX_RETENTION_ENABLED=true` is
set in `.env`, and even then this value is only the upper bound a room's own
retention policy may request (`retention.allowed_lifetime_max`). The setting that
purges messages is `MATRIX_RETENTION_MAX_LIFETIME`. All three are applied on the
first boot of a fresh data volume only; see `entrypoints/matrix_server.sh`.

#### --MATRIX_REPORT_STATS

A flag without a value: passing it turns Matrix server usage statistics reporting
on (`yes`). Default: `no`.

### Element Web Client

#### --CLIENT_HOST **Required**

Hostname for the self-hosted Element Web client (e.g., `element.example.com`).
The client sends unauthenticated users straight to the siwx-oidc sign-in page.

## Security

### .env file permissions

The `.env` file contains secrets and is created with restricted permissions:

```bash
chmod 600 .env
```

`start-matrix.sh` sets this automatically. Do not relax these permissions.

### OIDC signing key

An EC P-256 signing key is auto-generated on first run and stored in `.env`
(never as a separate file on disk). Do not delete it; tokens become invalid
if the key changes.

## Examples

### Start (production):

```bash
./start-matrix.sh \
  --MATRIX_HOST matrix.example.com \
  --SIWEOIDC_HOST siwx-oidc.example.com \
  --CLIENT_HOST element.example.com
```

### Stop:

```bash
./start-matrix.sh --stop
```

### Reset (destroys all data):

```bash
./start-matrix.sh --reset
```

### Debug mode:

```bash
./start-matrix.sh --ENABLE_DEBUG \
  --MATRIX_HOST matrix.example.com \
  --SIWEOIDC_HOST siwx-oidc.example.com \
  --CLIENT_HOST element.example.com
```

## Element Web Client

A self-hosted Element Web instance is included in the stack, accessible at
`https://<CLIENT_HOST>`. Sign-in uses Element's native OIDC support
(MSC2965/MSC3861):

1. User visits `https://element.example.com`
2. Element discovers siwx-oidc as the homeserver's OIDC issuer and, because
   `sso_redirect_options.immediate` is set in `config/element-config.json`, redirects
   straight to the siwx-oidc sign-in page
3. The user chooses **Sign in with Ethereum** (browser wallet) or **Sign in with
   Passkey**
4. After signing, the user lands back in Element, signed in

The client is pre-configured to connect to the local Synapse instance
(`default_server_config` in `config/element-config.json`, templated at container
start by `entrypoints/element_entrypoint.sh`). No homeserver configuration is needed
by the user. No login scripts are injected into Element: an earlier redirect script
raced the native flow and was removed (see the comment in
`entrypoints/element_entrypoint.sh`).

Element Web is **not** the stock `vectorim/element-web` image.
`dockerfiles/Dockerfile.element` clones element-hq/element-web at a pinned tag,
applies our vendored patches, builds it, and serves it with the inblock.io overlay
(config, theme, favicons, service-worker boot shim). See
[Upstream deviations (patches)](#upstream-deviations-patches).

## Mobile Wallet Usage

For mobile, use the self-hosted Element Web client (`https://<CLIENT_HOST>`)
in combination with a mobile wallet browser (e.g.,
[Phantom Wallet](https://phantom.app/) on iOS).

## Issues/Integrations

### Element Android

https://github.com/element-hq/element-meta/discussions/2556

## Contributing

Open contribution requests (new integrations, features, and services) are
tracked in the [request-for-contribution](https://github.com/inblockio/request-for-contribution)
repo. Browse open requests there if you want to help or propose new work.
