---
name: deploy
description: Use when deploying the siwx-oidc-matrix-server stack to agentic.inblock.io, updating to a specific git tag or ref, rebuilding containers, verifying a deploy, or rolling back. Triggers on "deploy", "push to server", "update server", "release", "rollback".
---

# deploy: Tag-Based Server Deployment + Verification

The deploy is a three-stage process, in order:

1. **Tag + build** — push an immutable git tag; CI builds identically-named GHCR images.
2. **Deploy** — `deploy.sh <tag> --build --restart` pulls those images and recreates containers.
3. **Verify** — automated post-deploy checks, then manual browser tests.

Each stage gates the next. A deploy is not "done" until verification is green.

## How it works

`deploy.sh` runs **locally** and SSHes to the server. On the server it checks out
the `siwx-oidc-matrix-server` repo at `<ref>` and pulls **pre-built GHCR images**
(it does **not** build locally — all images come from GitHub Actions CI). No files
are copied from the local machine.

The `<ref>` is any git ref: a tag, branch (`main`), or commit SHA. Prefer an
**immutable tag** for production deploys so the running version is unambiguous and
rollback targets a known artifact.

## Image versioning model

| Image | Tag source | Notes |
|---|---|---|
| `synapse`, `element-web` | stack `IMAGE_TAG` (= the deploy `<ref>`) | Co-versioned by this repo's tag |
| `siwx-oidc` | `SIWX_OIDC_TAG` (defaults `main`) | Built by the **separate** `siwx-oidc` repo; versioned independently |

A stack tag (e.g. `native-oidc-v3`) only co-versions synapse + element-web. siwx-oidc
stays on `:main` unless you set `SIWX_OIDC_TAG`. This is deliberate: a stack tag never
demands a matching siwx-oidc tag that may not exist. **There is no "ref must exist in
both repos" requirement** (that was the old two-repo model).

## Server layout

```
/home/deploy/matrix/
  stack/              # siwx-oidc-matrix-server repo (cloned/fetched by deploy.sh)
    .env              # secrets + COMPOSE_PROJECT_NAME=matrix (chmod 600)
    docker-compose.yml
    start-matrix.sh
    dockerfiles/  entrypoints/  config/

/home/portal/portal/
  Caddyfile           # shared TLS + reverse proxy (portal-caddy-1 serves it)
```

SSH user is **`deploy@`** (never `root@`). `COMPOSE_PROJECT_NAME=matrix` is pinned in
`.env` so volume names stay `matrix_matrix_data` / `matrix_redis_data` regardless of
directory name. See `docs/deployment-recovery-reference.md` for the full server
identity, secrets inventory, and disaster-recovery procedures.

## Stage 1 — Tag + build

```bash
# Tag the stack repo at the commit you want to ship, then push the tag.
git tag <tag-name> <commit>
git push origin <tag-name>          # CI builds ghcr.io/.../{synapse,element-web}:<tag-name>

# (Only if siwx-oidc also changed) tag + push it in its own repo:
git -C ~/siwx-oidc tag <tag-name> && git -C ~/siwx-oidc push origin <tag-name>
```

Wait for the `Publish Docker` workflow to go green before deploying — the tag's
images must exist in GHCR. The workflow triggers on `tags: ['*']` and emits a
`type=ref,event=tag` (raw tag name) image, so the GHCR tag matches the git tag
byte-for-byte.

## Stage 2 — Deploy

```bash
# Full deploy: sync repo, pull images, recreate containers
./deploy.sh <tag> --build --restart

# Pre-stage images without restart
./deploy.sh <tag> --build

# Quick restart at a ref (no pull, uses cached images)
./deploy.sh <tag> --restart

# Sync repo only (no pull, no restart)
./deploy.sh <tag>
```

`--build` alone never restarts; `--restart` alone never pulls new images. **After a
CI build you must use `--build --restart`** or you will restart the old image.

`--build` pulls **only** the three stack GHCR images (`matrix_synapse siwx-oidc
element-web`). The external images (redis, livekit, lk-jwt-service) are cached and
pulled by `up -d` only when missing, so a deploy never gates on Docker Hub's flaky
anonymous-token endpoint.

## Stage 3 — Verify

### 3a. Automated checks (run locally after deploy)

```bash
MATRIX_HOST=matrix.inblock.io; OIDC_HOST=siwx-oidc.inblock.io; ELEMENT_HOST=element.inblock.io
EXPECTED_ISSUER="https://siwx-oidc.inblock.io/"   # trailing slash is load-bearing

# Containers healthy
ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io \
  "cd /home/deploy/matrix/stack && docker compose ps --format 'table {{.Name}}\t{{.Status}}'"

# well-known issuer carries the trailing slash (RFC 8414 §3.3 byte-match)
WK=$(curl -fsS "https://${MATRIX_HOST}/.well-known/matrix/client" | jq -r '.["m.authentication"].issuer')
[ "$WK" = "$EXPECTED_ISSUER" ] && echo "PASS issuer=$WK" || echo "FAIL issuer=$WK"

# OIDC metadata issuer byte-matches the well-known issuer
META=$(curl -fsS "https://${OIDC_HOST}/.well-known/openid-configuration")
[ "$(echo "$META" | jq -r .issuer)" = "$WK" ] && echo "PASS metadata byte-match" || echo "FAIL issuer mismatch"

# Core OIDC machinery + PKCE
echo "$META" | jq -e '.authorization_endpoint and .token_endpoint and .registration_endpoint' >/dev/null && echo "PASS endpoints"
echo "$META" | jq -e '.code_challenge_methods_supported | index("S256")' >/dev/null && echo "PASS S256"

# Synapse MSC2965 auth metadata
curl -fsS "https://${MATRIX_HOST}/_matrix/client/v1/auth_metadata" | jq -e .issuer >/dev/null && echo "PASS auth_metadata"

# CORS allows the Element origin on OIDC discovery
curl -fsS -o /dev/null -D - -H "Origin: https://${ELEMENT_HOST}" \
  "https://${OIDC_HOST}/.well-known/openid-configuration" | tr -d '\r' \
  | grep -qi '^access-control-allow-origin:' && echo "PASS CORS"

# Element config still pins the homeserver (native discovery source)
curl -fsS "https://${ELEMENT_HOST}/config.json" \
  | jq -e '.default_server_config["m.homeserver"].base_url' >/dev/null && echo "PASS config pins homeserver"
```

> When checking that a path is **gone** (e.g. removed assets should 404), do **not**
> use `curl -f`: with `-f` curl exits non-zero on 404, so `-w '%{http_code}'` prints
> `404` and a `|| echo 000` fallback also fires, yielding the bogus `404000`. Use
> `curl -sS -o /dev/null -w '%{http_code}'` (no `-f`) for status-code assertions.

### 3b. Manual browser tests (a human must run these)

Open DevTools (Network + Console), filter Network by `token`:

1. **Golden path** (fresh incognito at `https://element.inblock.io`): native OIDC
   screen (single Continue button, no splash, no blank page) → Continue → siwx-oidc
   `/authorize` → wallet/passkey auth → back to `/?code=...` →
   **exactly one** `/token` 200 (not two), **no** repeated `/authorize` 401 loop,
   lands logged in, console clean of CORS / "issuer mismatch / discovery failed".
2. **Reload while authenticated**: boots straight in, no redirect, no second `/token`.
3. **Back button to `/?code=...`**: no second token exchange, no error (code is single-use).
4. **Logout**: Element's own logout clears the session. Do **not** re-introduce any
   logout interception (hard project rule).

## Staged rollback / revert model

Deploys are immutable-tag based, so revert = redeploy the last-good tag. `compose down`
removes only **containers**, never the named volumes (`matrix_data`, `redis_data`), so
data survives a rollback.

```bash
./deploy.sh <last-good-tag> --build --restart
```

`set -euo pipefail` in deploy.sh means most failures abort **before** `down && up -d`,
so a broken pull/checkout leaves the running stack untouched. The window of exposure is
between `down` and a healthy `up -d`; immutable tags keep that window's rollback target
unambiguous.

## Caddy / well-known editing (inode-safe)

The well-known block and routes live in the **shared** `/home/portal/portal/Caddyfile`,
which is a single-file **bind mount** into `portal-caddy-1`. deploy.sh only writes the
matrix block on a *fresh* install; on the running server it sees the block and skips.

**Never edit that file with `sed -i`.** `sed -i` writes a new inode and silently
detaches the bind mount — the host file changes but the container keeps serving the old
inode. Edit in place and re-push the same inode into the container:

```bash
ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io bash -s <<'EOF'
CF=/home/portal/portal/Caddyfile
cp "$CF" "$CF.bak.$(date +%Y%m%d%H%M%S)"
tmp=$(mktemp); sed 's|OLD|NEW|g' "$CF" > "$tmp"; cat "$tmp" > "$CF"   # host file, same inode
docker exec -i portal-caddy-1 sh -c 'cat > /etc/caddy/Caddyfile' < "$CF"  # container, same inode
rm -f "$tmp"
docker exec portal-caddy-1 caddy reload --config /etc/caddy/Caddyfile
EOF
```

The `m.authentication.issuer` in the well-known **must** byte-match siwx-oidc's
canonical metadata issuer `https://siwx-oidc.inblock.io/` (trailing slash) or Element's
strict RFC 8414 discovery rejects login. Keep the slash in `Caddyfile.production`,
`Caddyfile.local`, and `deploy.sh`.

## Single-service test override (no full branch deploy)

To test one service without rebuilding the others (e.g. iterating on siwx-oidc while
synapse/element-web stay on `:main`):

```bash
# 1. Build just the changed repo
gh workflow run docker.yml --ref <branch> --repo inblockio/siwx-oidc

# 2. Drop an override on the server (untracked by git; deploy.sh won't wipe it)
ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io 'cat > /home/deploy/matrix/stack/docker-compose.override.yml <<EOF
services:
  siwx-oidc:
    image: ghcr.io/inblockio/siwx-oidc:<branch>
EOF
cd /home/deploy/matrix/stack && docker compose pull siwx-oidc && \
  docker compose up -d --force-recreate --no-deps siwx-oidc'

# 3. Roll back by removing the override
ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io \
  'rm /home/deploy/matrix/stack/docker-compose.override.yml && \
   cd /home/deploy/matrix/stack && docker compose up -d --force-recreate --no-deps siwx-oidc'
```

**Delete the override before the next full deploy** or the pinned service stays pinned.

## First-time setup on a fresh server

If `.env` does not exist yet, SSH in and run `start-matrix.sh` after the first deploy:

```bash
ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io
cd /home/deploy/matrix/stack
./start-matrix.sh \
  --MATRIX_HOST matrix.inblock.io \
  --SIWEOIDC_HOST siwx-oidc.inblock.io \
  --CLIENT_HOST element.inblock.io
```

This generates `.env` with `MAS_SHARED_SECRET`, `SIWEOIDC_SIGNING_KEY_PEM`, and all
config. Subsequent deploys preserve this file. Never regenerate the signing key or
shared secret on a live server — see the recovery reference for impact.

## Troubleshooting

| Problem | Fix |
|---|---|
| `tag would clobber existing tag` | deploy.sh uses `git fetch --tags --force` |
| Wrong volume names (`stack_*` vs `matrix_*`) | `COMPOSE_PROJECT_NAME=matrix` pinned in `.env` |
| `docker compose pull` 404s on livekit/redis | Expected Docker Hub token flakiness — deploy pulls only GHCR images; externals come via `up -d` |
| `siwx-oidc:<stack-tag>` not found | siwx-oidc is versioned independently; leave it on `:main` or set `SIWX_OIDC_TAG` |
| well-known slash fix "didn't apply" | `sed -i` detached the bind mount — use the inode-safe method above |
| Server checkout aborts on local drift | Inspect server-side `git status`; fold load-bearing drift into the repo, then `git checkout --` the file |
| Restart didn't pick up new image | `--restart` alone doesn't pull; use `--build --restart` |

## Checklist

- [ ] Immutable tag pushed; CI `Publish Docker` green (GHCR images exist for the tag)
- [ ] `./deploy.sh <tag> --build --restart` completed; all containers healthy
- [ ] Automated verify (Stage 3a) all PASS — issuer slash, metadata byte-match, endpoints, CORS, config
- [ ] Manual browser tests (Stage 3b) pass — one `/token`, no 401 loop, reload/back/logout clean
- [ ] Rollback target known: last-good tag recorded
