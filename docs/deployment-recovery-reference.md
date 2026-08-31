# Deployment Recovery Reference

Last verified: 2026-07-31
Stack: siwx-oidc-matrix-server (MSC3861 delegated auth)

**Read "Image pinning policy" below before running ANY command in this
document.** This runbook used to instruct recovery via bare `./deploy.sh main
--build --restart`, which pulls images by a mutable tag with no verification
— that is exactly the mechanism that poisoned `:main` on 2026-07-31 (see
"Incident references"). The commands further down are now written to verify
digests; do not shortcut them back to a bare tag pull.

## Server Identity

| Field | Value |
|---|---|
| Domain | agentic.inblock.io |
| IP (as of 2026-05-24) | 142.93.168.4 (DNS A record) |
| Previous IP | 139.59.144.60 |
| Provider | DigitalOcean (inferred from IP range) |
| SSH user | deploy |
| SSH key | ~/.ssh/id_ed25519 |
| SSH port | 22 (standard) |

## Remote Directory Layout

```
/home/deploy/matrix/
  stack/                          # siwx-oidc-matrix-server repo (cloned by deploy.sh)
    .env                          # CRITICAL: all secrets, chmod 600
    docker-compose.yml
    start-matrix.sh
    dockerfiles/
    entrypoints/
    config/
  siwx-oidc/                     # siwx-oidc repo (cloned by deploy.sh)

/home/portal/portal/
  Caddyfile                       # TLS + reverse proxy for all services

/var/lib/docker/volumes/
  matrix_matrix_data/_data/       # Synapse DB (homeserver.db) + homeserver.yaml + signing keys
  matrix_redis_data/_data/        # Redis persistence (sessions, device mappings)
```

## Docker Network

External network `portal-net` connects all Matrix containers to the Caddy proxy
(`portal-caddy-1`). This network is created by the portal infrastructure, not
by docker-compose.yml.

## Services (COMPOSE_PROJECT_NAME=matrix)

| Container | Image | Internal Port | External Domain |
|---|---|---|---|
| matrix-matrix_synapse-1 | ghcr.io/inblockio/siwx-oidc-matrix-server/synapse:main | 8080 | matrix.inblock.io |
| matrix-siwx-oidc-1 | ghcr.io/inblockio/siwx-oidc:main | 8081 | siwx-oidc.inblock.io |
| matrix-element-web-1 | ghcr.io/inblockio/siwx-oidc-matrix-server/element-web:main | 8080 | element.inblock.io |
| matrix-redis-1 | redis | 6379 | (internal) |
| matrix-livekit-1 | livekit/livekit-server:latest | 7880 WS, 7881 TCP | matrix.inblock.io/livekit/* |
| matrix-lk-jwt-service-1 | ghcr.io/element-hq/lk-jwt-service:latest | 8080 | matrix.inblock.io/livekit/jwt |
| matrix-watchtower-1 | (watchtower) | - | - |

**These container names are compose-generated (`<project>-<service>-<N>`)
and are reference/identification data, not stable identifiers.** Docker
renames a container on a name conflict (prefixing the colliding id), so a
literal like `matrix-matrix_synapse-1` can silently stop matching any running
container. Commands must resolve by service instead, e.g.
`docker compose -p matrix ps -q <service>` or `docker compose exec -T
<service> ...` from `/home/deploy/matrix/stack`.

**The `:main`/`:latest` tags above are for identification only — they say
what a healthy stack currently runs, not what is safe to pull.** Never pull
or deploy by these bare tags without resolving and verifying a digest first;
see "Image pinning policy" below. `matrix-watchtower-1` does not auto-deploy
anything in this stack (see `../siwx-oidc/CLAUDE.md`, "Deploys are MANUAL").

## Secrets Inventory (names only, values in .env on server)

**Critical (never regenerate, tokens become invalid):**
- `SIWEOIDC_SIGNING_KEY_PEM` - ES256 P-256 private key, single-line PEM with \n escapes
- `MAS_SHARED_SECRET` - 64-char random string, shared between Synapse and siwx-oidc

**Important (regeneration breaks active sessions only):**
- `LIVEKIT_KEY` - format: API + 16 hex chars
- `LIVEKIT_SECRET` - 32-byte base64

**Configurable (safe to change):**
- `SIWEOIDC_HOST=siwx-oidc.inblock.io`
- `SIWEOIDC_PORT=8081`
- `SIWEOIDC_BASE_URL=https://siwx-oidc.inblock.io`
- `SIWEOIDC_REQUIRE_SECRET=false`
- `MATRIX_HOST=matrix.inblock.io`
- `MATRIX_PORT=8080`
- `MATRIX_BASE_URL=https://matrix.inblock.io`
- `MATRIX_REPORT_STATS=no`
- `MATRIX_MESSAGE_LIFETIME=4w`
- `CLIENT_HOST=element.inblock.io`
- `RUST_LOG=siwx_oidc=info,tower_http=info`
- `IMAGE_TAG=main`
- `COMPOSE_PROJECT_NAME=matrix`

**Optional:**
- `MATRIX_ADMIN_DID` - DID for auto-admin promotion on every boot
- `LIVEKIT_INSECURE_SKIP_VERIFY_TLS` - only for local dev

## Caddy Routing (as deployed)

The Caddyfile.production in this repo is the source of truth for Caddy routing.
deploy.sh appends these entries to `/home/portal/portal/Caddyfile` on the server.
Key routing decisions:

- `matrix.inblock.io` routes login/logout/refresh to siwx-oidc, everything else to Synapse
- `.well-known/matrix/client` includes `m.authentication.issuer` for OIDC discovery
- `.well-known/matrix/server` delegates federation to port 443
- LiveKit WebSocket signaling at `/livekit/sfu/*`, JWT exchange at `/livekit/jwt`
- MSC4108 QR code rendezvous at `/_matrix/client/unstable/org.matrix.msc4108/*`
- CORS: public (`*`) on siwx-oidc and Matrix login/logout endpoints

## Synapse First-Boot Configuration

The entrypoint (`entrypoints/matrix_server.sh`) generates `homeserver.yaml`
only on first boot. After that, the file in the `matrix_data` volume is
authoritative. Key settings baked in:

- MSC3861 delegated auth (issuer, client_id `0000000000000000000SYNAPSE`, introspection)
- MSC4108 QR code login enabled
- MSC4143/3266/4222 MatrixRTC with LiveKit SFU
- MSC4140 delayed events
- Message retention: 4 weeks
- Federation via .well-known delegation (no direct TLS on 8448)
- SQLite database (at /data/homeserver.db)

## Image pinning policy — READ BEFORE RUNNING ANY RECOVERY COMMAND

**Standing rule: recovery and deploy pulls are always by DIGEST, or a
digest-verified tag — never a bare mutable tag (`:main`, `:latest`, or any
`sha-<hash>` tag taken on faith).** This is the permanent invariant for this
stack, not a one-time caution. It has bitten this stack twice, for two
different reasons — see "Incident references" below:

1. **Upstream base images float underneath you if the Dockerfile doesn't pin
   them.** `dockerfiles/Dockerfile` used to do `FROM matrixdotorg/synapse:latest`.
   Every CI rebuild of `:main` silently tracked whatever upstream Synapse was
   current *at build time*, with no commit to this repo marking the change.
2. **GHCR tags are republishable — a tag string, including a commit-sha tag,
   is not proof of contents.** `element-web:sha-4a3d434` was observed to
   resolve to different bytes at two different times under the identical tag
   string. A tag is a label someone (or some CI run) can move; a digest
   (`sha256:...`) is the only thing that names an immutable set of bytes.

**Practical rule for every recovery command below:** resolve and record the
digest you intend to deploy *before* pulling, and confirm what is actually
*running* afterward matches it — never trust the tag name at either end.

```bash
# Resolve what a tag CURRENTLY points at, without pulling (safe, read-only).
# `docker buildx imagetools inspect` prints a `Digest:` line for the ref as
# requested — unlike `docker manifest inspect`, it does this correctly for
# both single-arch and multi-arch images without extra flags:
docker buildx imagetools inspect ghcr.io/inblockio/siwx-oidc-matrix-server/synapse:main
docker buildx imagetools inspect ghcr.io/inblockio/siwx-oidc:main

# After a pull + restart, confirm what is actually RUNNING (not just what
# was requested) — this is the step that would have caught the tag-drift
# incident, since the pull itself reported success either way. Resolve
# containers by compose service, not by the compose-generated names in the
# Services table above — Docker renames a container on a name conflict, so
# a literal like matrix-matrix_synapse-1 can stop matching silently:
cd /home/deploy/matrix/stack
SYNAPSE_CID="$(docker compose ps -q matrix_synapse)"
SIWX_CID="$(docker compose ps -q siwx-oidc)"
docker inspect --format='{{.Image}}' "$SYNAPSE_CID" \
  | xargs docker image inspect --format='{{join .RepoDigests ", "}}'
docker inspect --format='{{.Image}}' "$SIWX_CID" \
  | xargs docker image inspect --format='{{join .RepoDigests ", "}}'
```

If the running digest does not match the digest you resolved and intended to
deploy, **STOP** — do not consider the recovery complete, and do not paper
over the mismatch by re-running the same tag pull again.

## Recovery Procedures

### If SSH is restored
```bash
# 1. Decide and VERIFY the exact ref you are recovering to. Never pass
#    "main" to deploy.sh — it becomes IMAGE_TAG verbatim, i.e. a bare
#    mutable-tag pull with no verification (the exact trap this doc used to
#    document by example). Prefer the last known-good sha-tag — from this
#    doc's "Deployed Versions" table, from a rollback anchor tag such as
#    `:rollback-YYYYMMDD` if one exists (see "Current prod reality" below),
#    or from a `docker compose images` capture taken before the incident.
REF=sha-<known-good-short-sha>   # NOT "main"

docker buildx imagetools inspect ghcr.io/inblockio/siwx-oidc-matrix-server/synapse:${REF}
docker buildx imagetools inspect ghcr.io/inblockio/siwx-oidc:${REF}
# Record both "Digest:" lines — this is what you compare against after step 2.

# 2. Deploy.
./deploy.sh ${REF} --build --restart

# 3. Verify the RUNNING containers match the digests recorded in step 1 (per
#    the Image pinning policy above — do not skip this). Resolve by compose
#    service (run on the server, from /home/deploy/matrix/stack), not by the
#    compose-generated container names — Docker renames on a name conflict.
SYNAPSE_CID="$(docker compose ps -q matrix_synapse)"
SIWX_CID="$(docker compose ps -q siwx-oidc)"
docker inspect --format='{{.Image}}' "$SYNAPSE_CID" \
  | xargs docker image inspect --format='{{join .RepoDigests ", "}}'
docker inspect --format='{{.Image}}' "$SIWX_CID" \
  | xargs docker image inspect --format='{{join .RepoDigests ", "}}'

# 4. Functional verify:
curl -sf https://siwx-oidc.inblock.io/.well-known/openid-configuration | jq .issuer
curl -sf https://matrix.inblock.io/_matrix/client/versions | jq '.versions[-1]'
curl -sf -o /dev/null -w '%{http_code}' https://element.inblock.io
```

### If server is lost (full rebuild on new VPS)
1. Provision new VPS, point DNS for matrix/siwx-oidc/element.inblock.io to new IP
2. Install Docker + Docker Compose
3. Create deploy user, install SSH key
4. Create portal-net Docker network
5. Set up Caddy container (portal-caddy-1) with the Caddyfile.production from this repo
6. Run the "If SSH is restored" procedure above (resolve + verify a specific
   `sha-` ref, deploy, verify running digests) to clone repos and start
   containers — **do not** deploy `main` bare here either; a full rebuild is
   exactly when you most want to be certain of what you are standing up.
7. SSH in and run `start-matrix.sh` to generate new secrets (.env)
8. All user sessions will be invalidated (new signing key)
9. E2EE history will be lost unless matrix_data volume was backed up
10. Users must re-register (new Synapse database)

### If only siwx-oidc needs rebuild
```bash
# 1. Trigger a fresh CI build off main. This is a build trigger only — it
#    does NOT tell you what to deploy, because `main` keeps moving after it
#    (the same reason it's unsafe to deploy directly).
gh workflow run docker.yml --ref main --repo inblockio/siwx-oidc

# 2. Wait for the run to finish, then find the SPECIFIC sha it published —
#    never assume `:main` still points at it by the time you deploy:
gh run list --repo inblockio/siwx-oidc --workflow docker.yml --limit 1
NEWSHA=<short-sha-from-that-run>

# 3. Verify the image exists and record its digest BEFORE deploying:
docker buildx imagetools inspect ghcr.io/inblockio/siwx-oidc:sha-${NEWSHA}

# 4. Deploy by that exact sha ref, never by "main":
./deploy.sh sha-${NEWSHA} --build --restart

# 5. Verify the running container's digest matches step 3's (per the Image
#    pinning policy above). Resolve by compose service, not by the
#    compose-generated container name (run on the server, from
#    /home/deploy/matrix/stack) — Docker renames on a name conflict.
SIWX_CID="$(docker compose ps -q siwx-oidc)"
docker inspect --format='{{.Image}}' "$SIWX_CID" \
  | xargs docker image inspect --format='{{join .RepoDigests ", "}}'
```

### Redis: snapshot before any change that writes to `webauthn:*`

There is deliberately **no scheduled Redis backup**. The reasoning, settled
2026-09-01: for host loss or service loss a DigitalOcean droplet snapshot already
contains Redis, so a second copy buys nothing and you restore the whole box
anyway. A separate copy only earns its keep in the one case the droplet snapshot
serves badly, namely **Redis damaged while Synapse is healthy** (a bad write or
delete against the credential keyspace). There, a full restore is not just
expensive, it is destructive: it discards every message since the snapshot to
repair something that never touched messages.

That is a **change** risk, not a random-failure risk, so the instrument is a gate
in the change procedure rather than a timer:

> Before any change that writes to `webauthn:credential/*`, `webauthn:link/*` or
> `webauthn:by_did/*`, snapshot Redis. Specifically: enabling the aqua-auth
> credential-store dual-write, and anything exercising `purge_identity`, which
> does a `KEYS`-scan-and-delete across the first two.

```bash
# on the box, as the user that owns the stack
TS=$(date -u +%Y%m%dT%H%M%SZ)
C=$(docker ps -qf name=redis | head -1)
docker exec "$C" redis-cli BGREWRITEAOF
until [ "$(docker exec "$C" redis-cli info persistence | grep -c 'aof_rewrite_in_progress:0')" = 1 ]; do sleep 1; done
docker exec "$C" redis-cli BGSAVE
until [ "$(docker exec "$C" redis-cli info persistence | grep -c 'rdb_bgsave_in_progress:0')" = 1 ]; do sleep 1; done
sudo cp -a /var/lib/docker/volumes/matrix_redis_data/_data "/home/deploy/backups/redis/data-$TS"
echo "$TS" | sudo tee /home/deploy/backups/redis/LATEST
```

Copy the **whole `/data` tree**, not just one file. With `appendonly yes` Redis
loads from `appendonlydir/` and ignores `dump.rdb`, so an RDB-only copy restores
nothing; the RDB is kept alongside as a consistent point-in-time image for
inspection. A torn AOF tail is safe because `aof-load-truncated` defaults on.
This is the exact artifact shape whose restore was exercised on 2026-08-31, so
the procedure is tested rather than assumed.

Restore: stop the container, replace `/data` with the snapshot, start it.

**Rolling Redis back does not lock anyone out.** `siwx-oidc`
`src/webauthn.rs:499` rejects a login only when `new_counter < stored_counter`.
Restoring an older snapshot *lowers* the stored counter, so the authenticator's
counter is higher and the clone check passes. Old snapshots stay usable.

Handle the artifact as credential-bearing: `0600` under a `0700` directory, never
inside a git working tree, and never off-host unencrypted. On-host encryption is
pointless here, since a droplet snapshot captures the live unencrypted volume
anyway; encryption only earns anything for a copy that leaves the machine.

## The prod edge (portal-caddy-1)

`portal-caddy-1` terminates TLS for **eleven** hostnames on `agentic.inblock.io`,
not just the Matrix ones: agentic, aqua-registry, audit, element, matrix,
openwitness.org, projects, siwx-oidc, timestamps, turn.matrix and viewer. Any
restart of it is an outage for all of them, so treat it as a scheduled change.

It is a **hand-run container, not compose-managed** (it carries no
`com.docker.compose.*` labels), created 2026-08-03. Its config, captured
2026-09-01, is:

```
docker run -d --name portal-caddy-1 --restart unless-stopped \
  --network portal-net -p 80:80 -p 443:443 \
  -v /home/portal/portal/Caddyfile:/etc/caddy/Caddyfile \
  -v /home/deploy/caddy/config:/config \
  -v /home/deploy/caddy/data:/data \
  --entrypoint "" <IMAGE> \
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
```

It carries no custom environment (all four vars are image defaults) and
publishes only 80/tcp and 443/tcp. 443/udp is exposed but NOT published, so
HTTP/3 is not served. 5349 is deliberately not published: TURN-TLS terminates
here via the layer4 SNI split and reaches LiveKit over the proxy network.

**2026-09-01: pinned to a digest.** It ran the moving tag `caddy-l4:dev`, which
went stale the moment the `dev` branch was consolidated into `main`. It now runs
`caddy-l4@sha256:3976e411...` (the `:main` build). Note that deleting the `dev`
branch does NOT delete the `caddy-l4:dev` GHCR tag; the tag survives and simply
stops being rebuilt. So this pin was hygiene, not an outage-forced fix.

Gates used before the swap, and the ones to reuse next time:

1. `caddy list-modules | grep ^layer4` against the NEW image must be non-empty.
   caddy-l4 is a custom build; a stock caddy image silently lacks layer4 and the
   TURN SNI split would fail with the Caddyfile still "valid".
2. `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` run inside
   the NEW image against the LIVE bind-mounted Caddyfile.
3. Probe all eleven hostnames before and after and compare status codes. Do not
   assert 200: audit/projects/viewer legitimately return 401, agentic 303,
   matrix 302, timestamps 301. Compare before/after, do not assume a value.
4. Confirm the layer4 path specifically:
   `openssl s_client -connect turn.matrix.inblock.io:443 -servername turn.matrix.inblock.io`
   must present `CN = turn.matrix.inblock.io` with verify code 0. A plain HTTP
   probe cannot detect a broken SNI split.

Rollback: the previous container is kept, stopped, as `portal-caddy-rollback`
(image `caddy-l4@sha256:fcb829ec...`). To revert: `docker rm -f portal-caddy-1
&& docker rename portal-caddy-rollback portal-caddy-1 && docker start
portal-caddy-1`. Remove it once the new edge has soaked.

Still open: converting this to a small compose file so the edge stops being an
undeclared container. Deliberately not done during the 2026-09-01 window, to
keep that change to a single variable.

## Data Loss Impact Assessment

| Data | Location | Backed Up? | Impact if Lost |
|---|---|---|---|
| Synapse DB (users, rooms, messages) | matrix_data volume | No | All history, accounts, room state lost |
| homeserver.yaml | matrix_data volume | No | Must regenerate from entrypoint (first-boot) |
| Synapse signing keys | matrix_data volume | No | Federation identity changes; other servers reject |
| OIDC signing key | .env file | No | All tokens invalidated; users must re-login |
| MAS shared secret | .env file | No | Synapse cannot introspect tokens; regenerate in both |
| **Redis data** | redis_data volume | No | **Permanent account loss for passkey-only users, and silent identity forks for linked accounts.** See below; this is the worst entry in this table. |
| LiveKit keys | .env file | No | Active calls drop; regenerate |
| Caddy TLS certs | portal volumes | Auto-renewed | ACME re-issues within minutes |

### Why Redis loss is worse than "users must re-login"

This row used to read *"Active sessions lost; users must re-login."* That is
true of only part of the keyspace and badly understates the rest. Of ~983 keys
on prod, ~823 carry a TTL and are genuinely ephemeral (`token/*`, sessions,
device mappings). Losing those does mean "log in again."

The remaining ~160 keys have **no TTL and no other copy anywhere**:

| Keyspace | Holds | Consequence of loss |
|---|---|---|
| `webauthn:credential/*` | passkey public key, credential ID, sign counter | A passkey-only user **cannot authenticate at all**. There is no reset flow, no email recovery, no password. The account is gone. |
| `webauthn:link/*` | credential -> primary DID + label | See the identity-fork note below. |
| `webauthn:by_did/*` | reverse index | Credential enumeration for a DID breaks. |

The link table is the subtle one. `resolve_credential_identity()` looks up
`webauthn:link/{cred}`; on a hit the user is the linked **primary DID** (their
wallet), on a miss it falls back to the DID *derived from the passkey itself*.
Those are two different Matrix users. So losing `webauthn:link/*` does not
produce an error the user can see. It produces a **successful login as somebody
else**: an empty account with the same passkey, no rooms, no history, and no
signal that anything is wrong. Failing loudly would be far safer than this.

**Consequence for backup design:** a whole-droplet snapshot is a poor fit for
this data even though it technically contains it. Recovering one corrupted or
deleted credential keyspace by rolling the entire droplet back also discards
every message, room and account change since the snapshot. The remedy has to be
restorable in isolation, or it will not be used.

**Consequence for handling:** a Redis backup is a credential-bearing artifact.
The `token/*` keyspace uses the raw bearer token AS THE KEY NAME, so a dump
contains live credentials in plaintext. Keep such artifacts at `0600` under a
`0700` directory, never in a git working tree, and never off-host unencrypted.

## Current prod reality (dated snapshot — 2026-07-31, post-S6)

The "Image pinning policy" section above is the permanent invariant. This
section is what that invariant looks like in practice on prod, **as of
2026-07-31 after S6 landed**. Expect it to go stale; when it does, replace
this snapshot with a new one and do not delete or weaken the invariant
above it.

**S6 is done: prod runs GitHub-built images, pinned by DIGEST.** The
local-build era is over. Prod no longer builds images on the server, and no
longer uses local-only tags.

- Prod's `.env` pins all three stack images by **digest-only ref**
  (`repo@sha256:…`), via the full-ref env vars `SYNAPSE_IMAGE_REF`,
  `ELEMENT_IMAGE_REF` and `SIWX_OIDC_IMAGE_REF`. The old shared `IMAGE_TAG`
  and bare `SIWX_OIDC_TAG` were retired in `e55059e`; compose no longer
  reads them. Both lines survive in prod's `.env` **commented out and marked
  INERT**, purely as provenance for what the local-build era ran.
- **Why digest and not a tag — not even a commit-sha tag:** GHCR tags are
  republishable (see the tag-republish drift incident below), and the
  promoted images are tagged `:dev` upstream while `:main` resolves to
  different bytes (builds are not reproducible). Any tag name in prod's
  `.env` would therefore *misdescribe* the running image. Only a `sha256:`
  digest names immutable content.
- **`docker compose pull` on prod works again, and that is now correct.**
  The previous local-only tags existed to make a stray pull fail LOUDLY
  rather than silently float to `:main`. A digest ref cannot float — it
  fetches those exact bytes or fails — so the pin *is* the guard, in a
  stronger form. Do not reintroduce nonexistent tags to recreate the old
  fail-loudly behaviour.
- **`deploy.sh <ref>` overrides the `.env` pins on the command line**, which
  on a digest-pinned host is a downgrade to a floating tag. Prefer editing
  prod's `.env`; pass a full `repo@sha256:…` if deploy.sh must be used.
- Two generations of rollback anchor tags exist on the server for fast,
  network-free reverts: `:rollback-20260731` (older state; cleanup on/after
  2026-08-01) and `:rollback-20260731b` (the pre-S6 images; cleanup on/after
  2026-08-02).
- Quiesced prod DB snapshots exist at
  `/mnt/volume_matrix_service/backup-20260731/` and `…/backup-20260731b/`
  (the latter taken with containers stopped, immediately before the S6
  switch). Per the "One-way migrations" process rule in
  `docs/2026-07-30-dev-staging-dev-aquafire.md`, a snapshot precedes any
  version-crossing deploy — though **S6 itself was same-version**
  (Synapse 1.154.0 → 1.154.0, no migration), so its snapshot is insurance
  only and a DB restore would *destroy* real messages written since.
- The deploy-specific procedures live **on the server**, in
  `/home/deploy/matrix/stack/`: `PROMOTION-20260731.md` (the S6 promotion —
  old→new digests, anchors, exact rollback commands) and the older
  `ROLLBACK-20260731.md`. They are not checked into this repo because they
  document server-local state (paths, digests, tag values) that would go
  stale the moment it was copied here.
- **`matrix-watchtower-1` is an orphan container** in the `matrix` compose
  project: it carries the project label but is not in the compose model.
  **Never run `docker compose ... --remove-orphans` on this stack** — use an
  explicit service list for stop/up.

## Incident references

- **2026-07-31 — Synapse 1.157.1 removed `experimental_features.msc3861`.**
  `dockerfiles/Dockerfile` floated `FROM matrixdotorg/synapse:latest`, so
  every CI rebuild of `:main` silently tracked whatever upstream Synapse was
  current at build time — with no commit to this repo marking the change.
  Upstream 1.157.1 removed `experimental_features.msc3861` (hard startup
  error: `experimental_features.msc3861 was removed. Use the
  matrix_authentication_service configuration instead.`), poisoning `:main`
  for this stack's config schema; dev-staging had to be pinned to a
  pre-drift `sha-4a3d434` build as a workaround while this was diagnosed.
  Fixed in `29beb88` by pinning the Dockerfile to
  `matrixdotorg/synapse:v1.154.0` (the last version before the removal) and
  ceasing to float `latest`. **Lesson: never float an upstream base image in
  a `FROM` line; pin it explicitly and bump deliberately.** `:main` is
  currently good again post-fix — that does not license going back to
  pulling it unverified; see "Image pinning policy" above. Full context:
  `.env.dev-staging.example` and `docs/2026-07-30-dev-staging-dev-aquafire.md`.
- **2026-07-30/31 — GHCR tag-republish drift.** `element-web:sha-4a3d434`
  was observed to resolve to different bytes at two different times, under
  the identical tag string. Root cause: GHCR sha-tags are republishable — a
  tag, including a commit-sha tag, is a movable label, not a content hash.
  **Lesson: tags are hints; only a `sha256:` digest names immutable
  content.** This is why `docker-compose.dev-staging.yml` moved off one
  shared `IMAGE_TAG` to independent `SYNAPSE_IMAGE_REF` / `ELEMENT_IMAGE_REF`,
  each meant to carry a full `tag@digest` reference so two independently
  built images can be pinned to two different digests (see `29beb88`).

## Deployed Versions (as of 2026-05-24)

**Stale — see "Current prod reality" above for what prod actually runs
today.** Kept here as a historical record of the last time this table was
refreshed by hand; do not treat it as current.

| Component | Commit | Key Change |
|---|---|---|
| siwx-oidc | 266a4bd | Matrix scopes in OIDC discovery |
| matrix-server stack | 0493c37 | OIDC callback race fix |
