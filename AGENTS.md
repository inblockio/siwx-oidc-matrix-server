# AGENTS.md: rules for contributors to siwx-oidc-matrix-server

This file is the canonical rules file for human and AI contributors. Claude Code reads it
through `CLAUDE.md`; other agents read it directly. It holds what you must know before
changing this repository, and why each rule exists.

## What this is

A deployment bundle that runs a Matrix homeserver with
[siwx-oidc](https://github.com/inblockio/siwx-oidc) as its authentication service:
Docker Compose files, image recipes and configuration for Synapse, Element Web, Redis,
LiveKit and lk-jwt-service, plus the siwx-oidc image built in its own repository.
siwx-oidc acts as the auth service in Synapse's stable `matrix_authentication_service`
integration, the role the Matrix Authentication Service (MAS) plays in a default
deployment. The Synapse and Element Web images built here are **patched**; every patch has
a registry entry (see [Vendored patches](#vendored-patches)).

**Status:** this bundle belongs to siwx-oidc, a pathfinder project for agent identity on
Matrix, run by inblock.io assets GmbH on a non-commercial basis. It is provided as is,
without warranty (Apache-2.0 §§7–8). There is no support offering, no SLA, and no
commitment to maintain it for third-party deployments; the maintainers maintain it for
their own use, and interfaces may change without notice. There are no tagged releases
yet; `main` is what runs.

**Scope.** Synapse is the only homeserver this bundle runs or was tested with. Element Web
is built from source with vendored patches. Element X is used unmodified from the app
stores; nothing here can patch it.

## Repository map

| Path | Role |
|---|---|
| `start-matrix.sh` | First start: writes `.env` (mode 600) with generated secrets, then `docker compose up --pull always`. `--stop`, `--reset` (destroys all data). |
| `docker-compose.yml` | The deployable stack: `matrix_synapse`, `siwx-oidc`, `redis`, `element-web`, `livekit`, `lk-jwt-service`. No reverse proxy; it joins the external `portal-net` network, where the proxy runs. |
| `docker-compose.local.yml`, `Caddyfile.local` | Local HTTP-only stack that builds the images from source and includes a stock Caddy. `Caddyfile.local` is the public reference for every route a proxy must provide. |
| `docker-compose.e2e.yml`, `Caddyfile.e2e`, `e2e-harness/` | Hermetic local end-to-end stack (podman). See [e2e-harness/README.md](e2e-harness/README.md). |
| `docker-compose.override.yml.example` | Template that binds Synapse's `/data` to a dedicated volume. |
| `dockerfiles/Dockerfile` | The Synapse image: pinned upstream base, pinned `yq`, the Synapse patches, `entrypoints/matrix_server.sh`. |
| `dockerfiles/Dockerfile.element` | The Element Web image: clones a pinned tag, applies the Element Web patches in order, builds, serves with unprivileged nginx and the runtime overlay. |
| `dockerfiles/Dockerfile.caddy-l4` | Caddy built with the `layer4` and `rate_limit` modules, for an edge that splits TURN-TLS by SNI and rate-limits `GET /resolve`. |
| `real-stack/Dockerfile.synapse` | Builds `FROM` the published Synapse image, for siwx-oidc's hand-run real-stack tests. |
| `entrypoints/matrix_server.sh` | Synapse entrypoint: writes `homeserver.yaml` (see [What runs on every boot](#what-runs-on-every-boot)). Baked into the image, not bind-mounted. |
| `entrypoints/element_entrypoint.sh` | Element entrypoint: templates `config.json`, favicons, the theme stylesheet link. Bind-mounted by `docker-compose.yml`. |
| `config/` | Element config, nginx config and security headers, service-worker boot shim, theme CSS, LiveKit config, brand assets. |
| `patches/synapse/`, `patches/element-web/` | Vendored patches and their registries (`README.md` in each). |
| `scripts/` | Registry and hunk checks (run in CI), DID-field guard acceptance test, localpart-vector check, deployment audits, the storage controller, e2e helpers. |
| `verify-deployment.sh`, `verify-theme.sh` | Read-only probe of a live deployment's public endpoints; static theme check. |
| `docs/` | Element theme contract, Element source build, audits, drafts filed upstream. |
| `skills/` | Task guides for agents (see [Skills](#skills)). |

## Build and deployment model

- **Deployed images come from CI.** `.github/workflows/docker.yml` builds `synapse`,
  `element-web` and `caddy-l4` on a push to `main` (and on tags, releases and manual
  dispatch) and publishes them to `ghcr.io/inblockio/siwx-oidc-matrix-server/<image>` with
  the tags `main`, `latest` and `sha-<commit>`. A push that touches only `docs/**` or
  `**.md` builds nothing. Images built locally (`docker-compose.local.yml`, the e2e
  harness) are for testing and are never deployed.
- **Promote digests, not tags.** CI builds are not reproducible: the Element image stamps
  a build timestamp into `sw.js`, so every build has a new digest. `docker-compose.yml`
  defaults each first-party image to a `sha-<commit>` tag plus digest; a deployment pins
  its own `*_IMAGE_REF` values in `.env`, by digest.
- **A default can only name an earlier commit's build.** No commit can contain the digest
  of its own build. Bump the defaults deliberately, together with the README's
  Dependencies table and `real-stack/Dockerfile.synapse` (`ARG SYNAPSE_IMAGE`).
- **What a deployment serves is image plus bind mounts.** `docker-compose.yml` bind-mounts
  `config/element-config.json` and `entrypoints/element_entrypoint.sh` into `element-web`,
  so an Element config change needs no rebuild, and the image digest alone does not
  describe what is served. To know what runs, inspect the deployment, not a local daemon.

## What runs on every boot

`entrypoints/matrix_server.sh` has two parts, and which part owns a setting decides how a
change reaches an existing deployment.

| Part | Settings | How a change reaches an existing deployment |
|---|---|---|
| First boot only (`/data/homeserver.yaml` absent) | `/start.py generate`, `server_name`, `public_baseurl`, the listener, `serve_server_wellknown: false`, retention, server notices | Edit `/data/homeserver.yaml` in the `matrix_data` volume, then restart |
| Every boot | `apply_mas_config` (delegated auth, and the migration off `experimental_features.msc3861`), `apply_matrixrtc_config` (MSC4108/4143/3266/4222, delayed events, `rc_*` limits, `matrix_rtc` transport), `apply_did_field_protection`, admin promotion, the final on-disk denylist check | Change the entrypoint and rebuild the image; a restart re-applies it |

- **`apply_mas_config` refuses to write empty values.** With `SIWEOIDC_BASE_URL` (or
  `SIWEOIDC_INTERNAL_URL`) or `MAS_SHARED_SECRET` missing, it leaves the file untouched
  instead of replacing a working config with `endpoint: ""`, which Synapse refuses to
  boot on. Keep that guard.
- **`apply_did_field_protection` stays last among the `apply_*` functions**, so no later
  write can clobber the denylist. The final re-read before `/start.py` backs this up.
- **Rolling Synapse back to before 1.157 is not just an image revert.** A migrated
  `homeserver.yaml` has no `msc3861` block, and an old entrypoint will not recreate it on
  an existing volume. Restore a pre-migration `homeserver.yaml` as well.

## Invariants: do not "simplify" these

### Vendored patches

- **No patch without a registry entry** stating what, why, evidence, upstream status and
  retirement condition: [patches/synapse/README.md](patches/synapse/README.md),
  [patches/element-web/README.md](patches/element-web/README.md). A patch nobody can
  retire is a fork forever.
- **One commit for a pin or patch change, its registry entry and the root README**
  (Dependencies table, Upstream deviations list). `scripts/check-patch-registry.sh`
  checks the patch half in CI: every patch on disk has a numbered registry entry, is
  applied by its Dockerfile and is listed in the README, all in the Dockerfile's order.
  The pin half is not checked; update the Dependencies row by hand.
- **Patches fail the build when they stop applying.** Synapse: `patch --forward --batch
  --fuzz=0`. Element Web: `git apply` without `--3way`. Never COPY pre-patched files
  instead: that pins our stale copy of an upstream file across a bump and silently
  reverts what upstream fixed in it, security fixes included.
- **Element patch order is load-bearing.** Several patches touch `en_EN.json`; entry 8
  depends on 7 and entry 10 on 9. Keep the Dockerfile, the registry and the README in
  the same order.
- **UPSTREAM-TRACKED and filed patches mirror their upstream PR byte for byte.** The one
  recorded exception is Element entry 6, which leads its PR by named increments. Pushing
  to a mirrored PR is not finished until the vendored patch is re-copied.
- **A Synapse bump carries a forward-port obligation.** Run the dry-run in
  [patches/synapse/README.md](patches/synapse/README.md) rule 4 before merging a new
  `FROM matrixdotorg/synapse` line, and read each failing patch's retirement condition
  before porting it: a patch that stops applying often means upstream merged it.
- **An Element bump changes `ELEMENT_WEB_TAG` and `ELEMENT_WEB_COMMIT` together.** The
  build fails when the tag resolves to a different commit, so a moved upstream tag cannot
  change what we ship. Then run registry rule 4 over every patch, in order.

### The DID profile field (`io.inblock.did`)

siwx-oidc publishes each user's DID with a provider signature in the MSC4133 custom
profile field `io.inblock.did`. On stock Synapse any user can overwrite their own copy;
the MSC4133 write-policy patch (a backport of
[element-hq/synapse#19980](https://github.com/element-hq/synapse/pull/19980), open) makes
it read-only for non-admins.

- **The field name is a three-sided contract**: siwx-oidc's
  `src/did_assertion.rs::DID_PROFILE_FIELD`, the `siwx-oidc-auth` verifier's copy, and
  the denylist written here (`SIWX_DID_PROFILE_FIELD`, default `io.inblock.did`). Renaming
  it is a migration across all three, not an edit; a denylist naming the old key leaves
  the new field user-writable.
- **Denylist, never allowlist.** `msc4133_key_allowlist` restricts every custom profile
  field on the server, and an empty list (`[]` is not `None`) blocks them all.
- **The startup guard refuses to start** unless the field name fits Synapse's
  identifier grammar, the denylist is actually on disk, and the running Synapse carries
  the patch. `SIWX_ALLOW_UNPROTECTED_DID_FIELD=1` downgrades only the last check, to a
  banner. `scripts/did-field-guard-accept.sh` falsifies each gate; keep it passing.
- **The guard cannot cover `displayname` or `avatar_url`**, which bypass the guarded
  method. That is intended: the displayname is the user's own alias.
- **Enforcement is prospective.** The patch blocks new writes; siwx-oidc re-asserts the
  field at every sign-in, which repairs an older tampered value.

### Delegated auth: Synapse and siwx-oidc

- **`matrix_authentication_service` is the only delegation mode.** Synapse 1.157 removed
  `experimental_features.msc3861`, and a leftover block is a config error. `endpoint` is
  the only location setting: Synapse derives both the discovery and the introspection
  URL from it and ignores the metadata's own `introspection_endpoint`. The entrypoint
  sets it to `SIWEOIDC_INTERNAL_URL` when that is set (local and e2e stacks), otherwise
  to `SIWEOIDC_BASE_URL`; siwx-oidc builds its discovery document from its base URL, so
  an internal address still yields the public URLs. siwx-oidc reaches Synapse at
  `SIWEOIDC_SYNAPSE_ENDPOINT`.
- **Two credentials, two route families.** The shared secret (`MAS_SHARED_SECRET`, the
  same value as siwx-oidc's `…_MAS_SHARED_SECRET`) authenticates introspection and
  `/_synapse/mas/*`. The Synapse admin API needs an admin-scoped token that siwx-oidc
  mints for itself (`POST /oauth2/admin_token`). Synapse 1.157 dropped the old
  `admin_token` setting; do not reintroduce it.
- **`/_synapse/mas/*` is an internal Synapse API designed for MAS.** It changes between
  Synapse releases, so every Synapse bump is also a compatibility check of siwx-oidc.
- **The issuer must byte-match.** `m.authentication.issuer` in
  `/.well-known/matrix/client` must equal the issuer in siwx-oidc's discovery document
  byte for byte, trailing slash included (RFC 8414 §3.3). Element Web's discovery is
  strict and rejects a mismatch.
- **The proxy routes client login, logout, refresh and device deletion to siwx-oidc**
  (`/_matrix/client/v3/{login,logout,logout/all,refresh,delete_devices}` and
  `DELETE /_matrix/client/v3/devices/{id}`). Synapse does not serve login, logout or
  refresh under delegated auth, and siwx-oidc revokes a device's tokens when it deletes
  the device. Match the method on `devices/*`: siwx-oidc serves only `DELETE` there, so
  `GET` and `PUT` of a device must stay on Synapse. `Caddyfile.local` shows the routes.
- **Never expose `/_synapse/admin/*` or `/_synapse/mas/*` at the edge.** siwx-oidc reaches
  them over the Docker network; `Caddyfile.local` answers both with 404.
- **Strip siwx-oidc's CORS headers in the proxy** (`strip_upstream_cors` in
  `Caddyfile.local`). Two `Access-Control-Allow-Origin` headers make browsers reject the
  response, and OIDC fails without a clear error.
- **Rate-limit `GET /resolve` at the edge**, not in siwx-oidc. Stock Caddy has no rate
  limiter; the `caddy-l4` image carries `rate_limit`. Stock Caddy also cannot parse
  `layer4` or `rate_limit` blocks, which is why `Caddyfile.local` and `Caddyfile.e2e`
  carry neither. Deploy the image before a Caddyfile that needs it.

### Element Web

- **Login is Element's native OIDC flow only.** Do not add auth, redirect or callback
  scripts: an earlier redirect script raced the native flow. `sso_redirect_options.immediate`
  in `config/element-config.json` is Element's own setting and sends signed-out users
  straight to siwx-oidc.
- **Recovery setup is mandatory.** `force_verification: true` alone let users reach the
  app with no recovery key; patch 1 makes 4S setup mandatory on the first device. Do not
  weaken either half.
- **Service-worker hardening is load-bearing.** The per-build `sw.js` stamp makes a
  browser replace a wedged service worker on the next deploy; the Dockerfile greps the
  built `sw.js` for the markers of patches 9 and 10; the 8 s canary in
  `config/element-sw-boot.js` is coupled to patch 10's 5 s wait. Change coupled values
  together.
- **Theme rules** are in [docs/element-theme-customization.md](docs/element-theme-customization.md).
  The room-header presence-dot rule in `config/element-theme-overrides.css` is needed,
  not redundant. Run `./verify-theme.sh` before changing a theme.
- **Encrypted search (patch 6) is behind the labs flag `feature_web_event_index`**, off
  unless set. This repository's config sets it to `true`.

### Devices and cross-signing

The device lifecycle is implemented in siwx-oidc
([docs/matrix-integration.md](https://github.com/inblockio/siwx-oidc/blob/main/docs/matrix-integration.md)).
Guides and scripts here must not contradict it:

- Sign-in upserts a device and never deletes one. A device ID is never recycled, because
  Synapse keeps a deleted device's cross-signing signatures and will not replace them.
- `POST /oauth2/revoke` never deletes a device; an explicit logout or MSC4191
  `device_delete` does. `logout/all` does not deactivate the account.
- Every sign-in calls `allow_cross_signing_reset`, which opens a window in which the
  client may upload new cross-signing keys without interactive auth. It does not reset
  keys by itself.

### MatrixRTC (LiveKit)

- **The UDP media range 20100–20200 stays below the Linux ephemeral range** and must match
  in `docker-compose.yml` and `config/livekit.yaml`.
- **`LIVEKIT_URL` stays the public `wss://` URL.** lk-jwt-service (verified through
  0.6.0) uses it both for the SFU URL it hands out and for its own room-creation call,
  which therefore comes back in through the proxy; the proxy admits
  `/livekit/sfu/twirp/*` only from private addresses.
- **`LIVEKIT_FULL_ACCESS_HOMESERVERS` names the homeserver explicitly**, never `*`, which
  would let users of any federated server create rooms on the SFU.
- **Keep `matrix_rtc.transports[0].livekit_service_url` and do not write `url`.** Synapse
  1.161 deprecates the first, but a client that sees `url` expects lk-jwt-service to be
  registered as an application service, which it is not here.
- **Embedded TURN needs the `caddy-l4` edge.** `config/livekit.yaml` ships with TURN off
  and an example domain. It is built for TLS terminated at an edge that splits `:443` by
  SNI; port 5349 is never published on the host. Enable it (`turn.enabled: true`, a real
  `turn.domain`) only on a deployment with that edge.
- **`rtc.ips.excludes` must list the proxy network's subnet** on a host where LiveKit sits
  on two networks, which otherwise makes it advertise a private address as external. The
  subnet is host-specific, so the shipped file sets none; its comment says how to find it.
- **The lk-jwt-service healthcheck is disabled in `docker-compose.yml`**; 0.6.0's image
  healthcheck cannot pass with any bind value. Re-enable it only together with an image
  it was verified against.

### Secrets and admin promotion

- **`.env` holds every secret**, mode 600, generated by `start-matrix.sh`. Never print
  it; compare two secrets by fingerprint (see the `siwx-matrix-troubleshoot` skill).
  Backups of `.env` are plaintext copies; `.gitignore` covers the common backup names.
- **The OIDC signing key lives only in `.env`.** Replacing it invalidates issued tokens,
  and DID proofs signed with it become unverifiable unless its public half is kept as a
  retired key (see siwx-oidc's configuration docs).
- **An admin's MXID is resolved, never derived from the DID.** New DIDs get opaque
  localparts, so `MATRIX_ADMIN_MXID` is used verbatim, otherwise the entrypoint looks the
  account up; `/set-admin` asks siwx-oidc's `/resolve`. Values reach Python through the
  environment, never interpolated into source.
- **Retention is off by default.** `MATRIX_MESSAGE_LIFETIME` is only the upper bound a
  room may request; purging needs `MATRIX_RETENTION_ENABLED=true` and
  `MATRIX_RETENTION_MAX_LIFETIME`. Both are first-boot settings.

## How to test

```bash
scripts/check-patch-registry.sh          # patches, registries, Dockerfiles, README agree (CI)
python3 scripts/check-patch-hunks.py     # hunk headers match their bodies (CI)
./verify-theme.sh                        # static theme invariants
node --test scripts/browser-eventindex-invariants.mjs
scripts/did-field-guard-accept.sh        # needs a container runtime; see its header
scripts/check-did-localpart-vectors.sh   # needs `gh`; compares against siwx-oidc's fixture
e2e-harness/run.sh smoke                 # hermetic stack; needs podman and a siwx-oidc checkout
```

- `.github/workflows/checks.yml` runs the first two on every pull request and push to
  `main`.
- Synapse patch tests run inside a Synapse checkout: see
  [patches/synapse/README.md](patches/synapse/README.md) rule 4.
- Element patch behaviour is covered by Playwright suites in siwx-oidc (`e2e/element/`);
  each registry entry names its leg.
- `verify-deployment.sh` and `scripts/element-deploy-audit.sh` probe a live deployment's
  public endpoints read-only. Point them at your own hosts.

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) with a scope,
  as in the history: `fix(element): …`, `docs(patches): …`, `ci(checks): …`.
- **Comments and docs state what is true and why.** History belongs in commit messages,
  registry entries and `docs/audits/`. A "do not simplify" comment says what breaks.
- **Status wording:** siwx-oidc "takes the place of MAS as Synapse's auth service" or
  "acts as the auth service in Synapse's `matrix_authentication_service` integration".
  Not "replaces MAS entirely", not "drop-in", not "MSC3861 mode".

## Public-repo hygiene

This repository is public. Never commit infrastructure access details (host names or IPs
of maintainer machines, SSH users and ports, server paths, host keys), personal data (real
users' MXIDs, wallet addresses, IP addresses), secrets or key material, or maintainer
session notes. Use `example.org` / `example.com` and placeholders in examples. Maintainers
keep deployment-specific notes in an untracked `CLAUDE.local.md`. Report vulnerabilities
as described in [SECURITY.md](SECURITY.md).

## External repos

| Repo | Role |
|---|---|
| [inblockio/siwx-oidc](https://github.com/inblockio/siwx-oidc) | The OIDC provider and Matrix auth service; its image is `ghcr.io/inblockio/siwx-oidc`. Owns the device lifecycle, the DID assertion and `/resolve`. |
| [element-hq/synapse](https://github.com/element-hq/synapse) | Upstream homeserver, patched here. |
| [element-hq/element-web](https://github.com/element-hq/element-web) | Upstream web client, built from source and patched here. |
| [inblockio/element-web](https://github.com/inblockio/element-web) | Fork holding the branches the Element patches are generated from (named in each registry entry). |

## Skills

`skills/*.md` are task guides for agents, usable by humans too. Claude Code exposes them as
`/skill-name` through the symlinks in `.claude/commands/`.

| Skill | Purpose |
|---|---|
| `siwx-matrix` | How the services connect, login end to end, what runs when |
| `siwx-matrix-setup` | First deployment: DNS, reverse proxy, first sign-in |
| `siwx-matrix-troubleshoot` | Login, token, proxy and container problems |
| `siwx-matrix-device-verify` | E2EE device verification and cross-signing |
| `set-admin` | Promote a user to server admin by DID or MXID |
| `matrix-rtc-transport-specialist` | Element Call: MatrixRTC, LiveKit, TURN |
| `matrix-custom-themes-specialist` | Custom Element Web themes |
| `element-x-mobile-passkey-first` | Passkey-first login on Element X |
