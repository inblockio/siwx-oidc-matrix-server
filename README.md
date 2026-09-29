# siwx-oidc-matrix-server

A Docker Compose bundle that runs a Synapse Matrix homeserver with
[siwx-oidc](https://github.com/inblockio/siwx-oidc) as its authentication service.
siwx-oidc takes the place of the Matrix Authentication Service (MAS) as Synapse's auth
service: people sign in with a passkey or an Ethereum wallet, and software agents sign in
with their own Ed25519 or P-256 key, without a password. The bundle also runs a
self-hosted Element Web client, which sends signed-out users straight to the siwx-oidc
sign-in page, and MatrixRTC calls through LiveKit.

The Synapse and Element Web images built here are **not stock**: see
[Upstream deviations (patches)](#upstream-deviations-patches).

> [!IMPORTANT]
> **Status: pathfinder project, non-commercial, provided as is.**
> This bundle belongs to siwx-oidc, a pathfinder project for agent identity on Matrix, run
> by inblock.io assets GmbH on a non-commercial basis. It is provided **as is**, without
> warranty (Apache-2.0 §§7–8). There is **no support offering, no SLA, and no commitment to
> maintain it for third-party deployments**: the maintainers maintain it for their own
> use, and interfaces may change without notice. There are no tagged releases yet; `main`
> is what runs. Contributions and security reports are welcome and handled best-effort;
> see [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). **No CLA** is
> required: contributions are licensed under Apache-2.0 per its §5. Rules for
> contributors and coding agents: [AGENTS.md](AGENTS.md).

## Table of Contents

1. [What is and is not supported](#what-is-and-is-not-supported)
2. [Quick Start](#quick-start)
3. [Services](#services)
4. [Dependencies](#dependencies)
5. [Upstream deviations (patches)](#upstream-deviations-patches)
6. [Parameters](#parameters)
7. [Security](#security)
8. [Examples](#examples)
9. [Element Web Client](#element-web-client)
10. [Mobile Wallet Usage](#mobile-wallet-usage)
11. [Contributing](#contributing)
12. [License](#license)

## What is and is not supported

- **Homeserver: Synapse only.** The bundle runs Synapse `v1.161.0`, patched (see below).
  Other homeservers (Tuwunel, Dendrite, Conduit) are untested and unsupported.
- **Delegated auth through Synapse's stable `matrix_authentication_service`
  integration.** Synapse's side of it, `/_synapse/mas/*`, is an internal API designed for
  MAS, and siwx-oidc tracks it per Synapse release, so every Synapse bump is also a
  compatibility check. What siwx-oidc itself supports, and what it does not (password
  login, upstream identity providers, an admin API, legacy `POST /login`), is described in
  its [Matrix integration guide](https://github.com/inblockio/siwx-oidc/blob/main/docs/matrix-integration.md).
- **Clients must implement the Matrix OAuth 2.0 authentication API.** Clients that only
  know password login cannot sign in.
- **Element Web is built from source** at `v1.12.29` with 10 vendored patches and a runtime
  overlay (configuration, theme, branding, a service-worker boot shim).
- **Element X is used unmodified**, as distributed through the app stores. This repository
  does not patch it.
- **The `io.inblock.did` profile field is write-protected only by the patched Synapse**
  built here. The Synapse entrypoint refuses to start on a Synapse without the patch,
  unless that check is explicitly overridden (see
  [patches/synapse/README.md](patches/synapse/README.md)).
- **Not included:** a reverse proxy (bring your own; the routes are in
  `Caddyfile.local`), PostgreSQL (Synapse runs on SQLite), coturn (LiveKit's embedded TURN
  is used instead), and MAS.
- **Brand assets are not licensed.** The inblock.io logos, favicons and welcome background
  in `config/`, and the logo at the repository root, are not licensed for reuse. The ones
  in `config/` go into the Element image, so a deployment must replace them (see
  [License](#license)).

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
proxy. Run a reverse proxy on the `portal-net` network that proxies the three hostnames
to `matrix_synapse`, `siwx-oidc` and `element-web`, and `/livekit/*` to `livekit` and
`lk-jwt-service`. `Caddyfile.local` (HTTP-only, one port per service) lists every route
the proxy must provide, including the client login, logout and refresh paths that go to
siwx-oidc, and the `/_synapse/admin/*` and `/_synapse/mas/*` paths it must not expose. The
`/siwx-matrix-setup` skill ([skills/siwx-matrix-setup.md](skills/siwx-matrix-setup.md))
has a hostname-based Caddy example. For a local, HTTP-only stack with Caddy included, use
`docker-compose.local.yml` (see its header).

Calls go through LiveKit. Its embedded TURN is **off** in `config/livekit.yaml`, so
clients behind symmetric NAT or strict firewalls cannot join a call. Enabling it needs an
edge that splits `:443` by SNI (the `caddy-l4` image), a DNS record for the TURN host,
3478/udp open, and `turn.enabled: true` with your `turn.domain` in `config/livekit.yaml`;
the `/siwx-matrix-setup` skill has the steps.

## Services

| Service | Image (default in `docker-compose.yml`) | Purpose |
|---|---|---|
| `matrix_synapse` | `ghcr.io/inblockio/siwx-oidc-matrix-server/synapse`, built from `dockerfiles/Dockerfile` (Synapse + 1 patch) | Matrix homeserver; authentication delegated to siwx-oidc |
| `siwx-oidc` | `ghcr.io/inblockio/siwx-oidc` | OIDC provider (passkey, wallet and agent-key sign-in); takes the place of MAS as Synapse's auth service |
| `redis` | `redis:8.10.2` | Session and token store for siwx-oidc |
| `element-web` | `ghcr.io/inblockio/siwx-oidc-matrix-server/element-web`, built from source by `dockerfiles/Dockerfile.element` (Element Web + 10 patches) | Web client |
| `livekit` | `livekit/livekit-server` | MatrixRTC SFU for Element Call; embedded TURN is off by default |
| `lk-jwt-service` | `ghcr.io/element-hq/lk-jwt-service` | Issues LiveKit access tokens to Matrix users |

The reverse proxy is not a service in `docker-compose.yml`. The maintainers' deployments
use Caddy, custom-built with the `layer4` and `rate_limit` modules
(`dockerfiles/Dockerfile.caddy-l4`), outside this compose project. Federation runs on port
443 through `.well-known/matrix/server` delegation served by that proxy; Synapse's own
`serve_server_wellknown` is off.

## Dependencies

What the bundle depends on, where each version is pinned, and whether we run it
stock. The table shows the **repository defaults**. A deployment overrides every
`*_IMAGE_REF` in its own `.env`, pinned by digest, and those files are not in this
repository; the comments in `docker-compose.yml` record where the maintainers' production
deployment is known to run a different version.

| Component | Version / pin | Pinned in | Stock / patched / built |
|---|---|---|---|
| Synapse | `v1.161.0` (`matrixdotorg/synapse:v1.161.0@sha256:6b95dd129e35…`, index digest) | `dockerfiles/Dockerfile` (`FROM`) | **Patched**: 1 source patch, plus config written by `entrypoints/matrix_server.sh`. Built by CI as `ghcr.io/inblockio/siwx-oidc-matrix-server/synapse` |
| Synapse image the stack runs | default `…/synapse:sha-33a0c95@sha256:32abd6fa5e31…` (CI build of main at 33a0c95) | `docker-compose.yml` (`SYNAPSE_IMAGE_REF`); `real-stack/Dockerfile.synapse` (`ARG SYNAPSE_IMAGE`, same default, for the local real stack) | Built here |
| Element Web | `v1.12.29` (git tag of element-hq/element-web; the build fails unless it resolves to commit `2d90d6b7b601…`) | `dockerfiles/Dockerfile.element` (`ARG ELEMENT_WEB_TAG`, `ARG ELEMENT_WEB_COMMIT`) | **Built from source and patched**: 10 source patches, plus a runtime overlay |
| Element Web image the stack runs | default `…/element-web:sha-33a0c95@sha256:1761832069bd…` (CI build of main at 33a0c95) | `docker-compose.yml` (`ELEMENT_IMAGE_REF`) | Built here |
| Element Call | `0.24.0` (`@element-hq/element-call-embedded`) | Not pinned here: Element Web `v1.12.29`'s `apps/web/package.json` and `pnpm-lock.yaml` | Stock, embedded in the Element Web bundle (`element_call.use_exclusively` in `config/element-config.json`). Moves only with the Element Web tag |
| matrix-js-sdk | `42.4.0` | Not pinned here: same, via the Element Web tag | Stock, bundled |
| Element Web build toolchain | `node:24.20.0-bullseye@sha256:25f3016fcdae…`; pnpm `11.23.0` (upstream `devEngines`, via corepack); `pnpm install --frozen-lockfile` | `dockerfiles/Dockerfile.element` (builder `FROM`, `corepack enable` step) | Stock |
| Element Web serving base | `nginxinc/nginx-unprivileged:1.31.6-alpine-slim@sha256:c81a27f28bc2…` | `dockerfiles/Dockerfile.element` (runtime `FROM`) | Stock, with our `config/element-nginx.conf` and security headers |
| siwx-oidc | default `ghcr.io/inblockio/siwx-oidc:sha-40efae9@sha256:54739f4813bf…` (CI build of siwx-oidc main at 40efae9) | `docker-compose.yml` (`SIWX_OIDC_IMAGE_REF`) | First-party, built in [inblockio/siwx-oidc](https://github.com/inblockio/siwx-oidc) |
| Redis | `8.10.2` (`redis:8.10.2@sha256:d5ac52db24d4…`) | `docker-compose.yml` (`REDIS_IMAGE_REF`) | Stock, run with `--appendonly yes` |
| LiveKit server | `v1.13.7` (`livekit/livekit-server:v1.13.7@sha256:6fd3b7088874…`) | `docker-compose.yml` (`LIVEKIT_IMAGE_REF`) | Stock, configured by `config/livekit.yaml` (embedded TURN, off by default) |
| lk-jwt-service | `0.7.0` (`ghcr.io/element-hq/lk-jwt-service:0.7.0@sha256:e0c7cecfa74e…`) | `docker-compose.yml` (`LK_JWT_IMAGE_REF`) | Stock, configured |
| Caddy | `v2.11.4` (`caddy:2.11.4-builder@sha256:369218c81ca6…`, `caddy:2.11.4@sha256:0c994536bddb…`) | `dockerfiles/Dockerfile.caddy-l4` (builder and final `FROM`) | **Custom build** with xcaddy and the two modules below. Built by CI as `ghcr.io/inblockio/siwx-oidc-matrix-server/caddy-l4` |
| Caddy module `layer4` (mholt/caddy-l4) | `v0.1.2` | `dockerfiles/Dockerfile.caddy-l4` (`xcaddy build`) | Stock module (TURN-TLS SNI split on :443) |
| Caddy module `rate_limit` (mholt/caddy-ratelimit) | commit `5625512f24f6` (upstream has no tag after `v0.1.0`) | `dockerfiles/Dockerfile.caddy-l4` (`xcaddy build`) | Stock module at a commit (edge rate limit for siwx-oidc `GET /resolve`) |
| Caddy image an edge runs | a CI build of `caddy-l4`, pinned by digest | Not in this repository: the edge is configured per deployment | Built here |
| yq (Synapse image) | `v4.53.3`, SHA-256 checked, binary and `LICENSE` | `dockerfiles/Dockerfile` (`yq` download step and the `ADD` of its `LICENSE`) | Stock binary |
| License texts (Element and caddy-l4 images) | SPDX license-list-data `v3.29.0`, one SHA-256 per text | `dockerfiles/Dockerfile.element`, `dockerfiles/Dockerfile.caddy-l4` (`alpine_licenses` stage) | Stock texts; which ones is checked against the base image's packages at build time |
| Debian `patch` (Synapse image build) | not version-pinned: floats within the Debian release (trixie) that the base digest fixes. Build tool only: installed, used and purged in one layer, so it is not in the image | `dockerfiles/Dockerfile` (patch step) | Stock |
| Database | SQLite at `/data/homeserver.db` (Synapse's generated default) | `entrypoints/matrix_server.sh` (`/start.py generate`) | Stock; not a separate service |

Not part of the bundle: PostgreSQL (Synapse runs on SQLite), coturn (LiveKit's
embedded TURN serves instead), the Matrix Authentication Service (siwx-oidc takes
its place through Synapse's `matrix_authentication_service` config),
nginx-proxy/acme-companion (replaced by Caddy), and watchtower (no compose file here
defines it).

### Floating pins

A pin floats when the same reference can resolve to different bytes tomorrow. These
do:

- **Any image ref set to a tag without a digest.** `docker-compose.yml` no longer floats:
  its defaults are the tag-plus-digest builds listed in the table above, so
  `start-matrix.sh` (which runs `docker compose up --pull always`) starts the same bytes
  every time. A `*_IMAGE_REF` set in `.env` to a bare tag such as `:main` pulls whatever
  that tag names at the moment. Pin by digest to run anything newer.
- **Build-time package**: Debian `patch` in the Synapse build (`dockerfiles/Dockerfile`)
  floats on purpose, within the Debian release the base digest fixes, and is purged
  before its layer ends.
- **CI runner image**: both workflows run on `ubuntu-24.04`, which GitHub updates within
  that release. Every action they use is pinned by commit, with the release named in a
  comment, so the actions themselves do not float.

The other image references in the Dockerfiles, compose files and `e2e-harness/`
scripts are pinned by digest, with the version tag alongside wherever one exists
(the local and test stacks included); the Element Web source tag is checked against
its commit, and the yq download and the license texts against their checksums.

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
(`.github/workflows/checks.yml`). The pin half is not checked: a Dependencies row is
updated by hand. [CONTRIBUTING.md](CONTRIBUTING.md) describes how to bump Synapse and
Element Web.

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

> **Note:** `start-matrix.sh` and `docker-compose.yml` use the legacy `SIWEOIDC_` prefix
> for siwx-oidc's environment variables. siwx-oidc still accepts it; its current prefix
> is `SIWXOIDC_`, which wins when both are set. See siwx-oidc's
> [configuration reference](https://github.com/inblockio/siwx-oidc/blob/main/docs/configuration.md).

#### --SIWEOIDC_HOST **Required**

Hostname for the siwx-oidc OIDC provider (e.g., `siwx-oidc.example.com`).

#### --SIWEOIDC_PORT

Port for the siwx-oidc service. Default: `8081`.

#### Opt-ins set in `.env` (no flag)

`docker-compose.yml` passes three more siwx-oidc settings through from `.env`. Each is
off when unset or empty; they need a siwx-oidc build from 2026-09-30 on. See
`.env.example` and siwx-oidc's
[configuration reference](https://github.com/inblockio/siwx-oidc/blob/main/docs/configuration.md).

- `SIWXOIDC_ENS_API_URL`: an ENS API that puts Ethereum users' ENS names in the `name`
  claim. Setting it sends each Ethereum user's address to that service.
- `SIWXOIDC_OP_TOS_URI`, `SIWXOIDC_OP_POLICY_URI`: your terms of service and privacy
  policy, advertised in OIDC discovery. Unset, discovery leaves them out.

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

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

### .env file permissions

The `.env` file contains secrets and is created with restricted permissions:

```bash
chmod 600 .env
```

`start-matrix.sh` sets this automatically. Do not relax these permissions.

### OIDC signing key

An EC P-256 signing key is auto-generated on first run and stored in `.env`
(never as a separate file on disk). Back it up with `.env`. Access and refresh tokens are
opaque entries in Redis, so a new key signs no one out. What a key change breaks: ID
tokens signed with the old key no longer verify against siwx-oidc's JWKS, and neither
does any `io.inblock.did` proof already published in a user's profile, until that user's
next sign-in publishes a new one. To keep the old proofs verifiable, list the old key's
public half in `SIWXOIDC_RETIRED_SIGNING_KEYS_PEM` (siwx-oidc,
[Key rotation](https://github.com/inblockio/siwx-oidc/blob/main/docs/configuration.md#key-rotation)). `docker-compose.yml` does not pass that variable through: add it to
the `siwx-oidc` service's `environment`, for example in `docker-compose.override.yml`.

### Reverse proxy

Do not expose `/_synapse/admin/*` or `/_synapse/mas/*` through the proxy: siwx-oidc
reaches them over the Docker network, and `Caddyfile.local` shows the deny rules.

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
`https://<CLIENT_HOST>`. Sign-in uses Element's native support for the Matrix OAuth 2.0
API (MSC2965 discovery, MSC3861):

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
[Upstream deviations (patches)](#upstream-deviations-patches) and
[docs/element-web-source-build.md](docs/element-web-source-build.md).

## Mobile Wallet Usage

On a phone, open the self-hosted Element Web client (`https://<CLIENT_HOST>`) in the
built-in browser of a mobile wallet app that injects an Ethereum provider (EIP-1193), or
sign in with a passkey, which needs no wallet. Wallet sign-in inside Element's own mobile
apps is an open upstream topic; see the element-meta discussion
[MetaMask Integration](https://github.com/element-hq/element-meta/discussions/2556).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md) for the rules and
invariants a change must respect. Open contribution requests (new integrations,
features, and services) are tracked in the
[request-for-contribution](https://github.com/inblockio/request-for-contribution) repo.

## License

The files in this repository are licensed under the
[Apache License, Version 2.0](LICENSE). [NOTICE](NOTICE) lists the third-party material
they contain and sets out two exceptions in full:

- **Patches.** The `.patch` files under `patches/` change Synapse and Element Web, so
  each change takes the license of the upstream file it changes: AGPL-3.0-or-later for
  Synapse (and for the test in `patches/synapse/tests/`, which carries Synapse's notice for
  the set-up code it reuses), and for the Element Web code the image ships,
  AGPL-3.0-only OR GPL-3.0-only.
- **Brand assets.** The inblock.io logos, favicons and welcome background are not
  licensed. A deployment must replace them with its own.

**Images.** Each image ships this repository's LICENSE and NOTICE, and the license texts
of what it adds: yq's in the Synapse image, Element Web's AGPL-3.0 and GPL-3.0 texts in
the Element image, and the texts of every license its Alpine packages declare in the
Element and caddy-l4 images (a build step fails when those disagree). NOTICE, "Container
images", names the Alpine releases and their source. An image's corresponding source is
the upstream release its Dockerfile pins plus this repository at the commit its
`org.opencontainers.image.revision` label names.

**AGPL and conveying (not legal advice).** A deployment of this bundle serves modified
AGPL-3.0 programs to its users over a network: Synapse, and Element Web when it is used
under the AGPL. Section 13 of the AGPL then requires the operator to offer those users
the Corresponding Source of the modified programs. Element Web is also *conveyed*: its
JavaScript is sent to every browser that loads it, so the source obligations for
conveying apply to it under either license, AGPL-3.0 or GPL-3.0. The patches and
Dockerfiles published here are the modifications. If you run this bundle, link your
users to the source you run (for example from the client's About page), and check your
obligations with counsel.
