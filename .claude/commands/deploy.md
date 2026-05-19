---
name: deploy
description: Use when deploying the siwx-oidc-matrix-server stack to agentic.inblock.io, updating to a specific git tag or ref, rebuilding containers, or checking deployment status. Triggers on "deploy", "push to server", "update server", "release", "rollback".
---

# deploy: Tag-Based Server Deployment

## How it works

`deploy.sh` clones both repos (`siwx-oidc-matrix-server` and `siwx-oidc`) on the server and checks them out at a given git ref. No files are copied from the local machine; the server pulls directly from GitHub.

## Server layout

```
/home/matrix/
  stack/              # siwx-oidc-matrix-server repo (cloned from GitHub)
    .env              # secrets + COMPOSE_PROJECT_NAME=matrix
    docker-compose.yml
    start-matrix.sh
    dockerfiles/
    entrypoints/
    config/
  siwx-oidc/          # siwx-oidc repo (cloned from GitHub)
```

`COMPOSE_PROJECT_NAME=matrix` is pinned in `.env` so Docker volume names stay `matrix_matrix_data` and `matrix_redis_data` regardless of the directory name.

## Usage

```bash
# Full deploy: sync repos, rebuild images, restart containers
./deploy.sh fork-stable --build --restart

# Rebuild without restart (pre-stage images)
./deploy.sh fork-stable --build

# Quick restart at a ref (skip rebuild, uses cached images)
./deploy.sh main --restart

# Just sync repos (dry run, no build or restart)
./deploy.sh fork-stable
```

The `<ref>` argument accepts any git ref: a tag (`fork-stable`), branch (`main`), or commit SHA. The ref must exist in **both** repos.

## Deploy steps (what the script does)

1. **Sync siwx-oidc-matrix-server**: clone or fetch + checkout `<ref>` into `/home/matrix/stack/`
2. **Sync siwx-oidc**: clone or fetch + checkout `<ref>` into `/home/matrix/siwx-oidc/`
3. **Prepare build context**: migrate `.env` if needed, pin `COMPOSE_PROJECT_NAME`, set file permissions
4. **Ensure Caddy routes**: idempotent; only adds entries if `matrix.inblock.io` is absent from the Caddyfile
5. **Build and restart**: `docker compose build --no-cache` (if `--build`), `docker compose down && up -d` (if `--restart`)

## Creating a new release tag

Tags must exist in both repos. To tag and deploy:

```bash
# Tag both repos at their current HEAD
git -C ~/siwx-oidc tag <tag-name>
git -C ~/siwx-oidc-matrix-server tag <tag-name>

# Push tags to GitHub
git -C ~/siwx-oidc push origin <tag-name>
git -C ~/siwx-oidc-matrix-server push origin <tag-name>

# Deploy
cd ~/siwx-oidc-matrix-server
./deploy.sh <tag-name> --build --restart
```

To move an existing tag (e.g., after a fix):

```bash
git -C ~/siwx-oidc tag -f <tag-name> <commit>
git -C ~/siwx-oidc push origin <tag-name> --force

git -C ~/siwx-oidc-matrix-server tag -f <tag-name> <commit>
git -C ~/siwx-oidc-matrix-server push origin <tag-name> --force
```

## Verifying a deployment

After deploy, confirm all four services are healthy:

```bash
SSH_CMD="ssh -i ~/.ssh/id_ed25519 root@agentic.inblock.io"

# Container status
$SSH_CMD "cd /home/matrix/stack && docker compose ps"

# OIDC discovery
curl -sf https://siwx-oidc.inblock.io/.well-known/openid-configuration | jq .issuer

# Synapse API
curl -sf https://matrix.inblock.io/_matrix/client/versions | jq '.versions[-1]'

# Element Web
curl -sf -o /dev/null -w '%{http_code}' https://element.inblock.io

# Check deployed commits
$SSH_CMD "cd /home/matrix/stack && git log --oneline -1"
$SSH_CMD "cd /home/matrix/siwx-oidc && git log --oneline -1"
```

## Rollback

Rolling back is just deploying an older ref:

```bash
./deploy.sh fork-stable --build --restart
```

## First-time setup on a fresh server

If `.env` does not exist yet, SSH to the server and run `start-matrix.sh` after the first deploy to generate secrets:

```bash
ssh -i ~/.ssh/id_ed25519 root@agentic.inblock.io
cd /home/matrix/stack
./start-matrix.sh \
  --MATRIX_HOST matrix.inblock.io \
  --SIWEOIDC_HOST siwx-oidc.inblock.io \
  --CLIENT_HOST element.inblock.io
```

This generates `.env` with `MAS_SHARED_SECRET`, `SIWEOIDC_SIGNING_KEY_PEM`, and all config. Subsequent deploys preserve this file.

## Troubleshooting

| Problem | Fix |
|---|---|
| `tag would clobber existing tag` | Fixed: deploy.sh uses `git fetch --tags --force` |
| Wrong volume names (`stack_*` vs `matrix_*`) | Fixed: `COMPOSE_PROJECT_NAME=matrix` pinned in `.env` |
| `.env` not found after migration | deploy.sh auto-migrates `.env` from `/home/matrix/` to `/home/matrix/stack/` |
| Ref not found in one repo | The ref must exist in both repos; tag both before deploying |
| Build context path wrong | `docker-compose.yml` uses `../siwx-oidc`; server layout is `stack/` + `siwx-oidc/` so the relative path resolves correctly |

## Checklist

- [ ] Ref exists in both `siwx-oidc` and `siwx-oidc-matrix-server` repos on GitHub
- [ ] `.env` exists in `/home/matrix/stack/` with secrets
- [ ] `COMPOSE_PROJECT_NAME=matrix` is set in `.env`
- [ ] All four containers report healthy after restart
- [ ] OIDC discovery, Synapse versions, and Element all respond
