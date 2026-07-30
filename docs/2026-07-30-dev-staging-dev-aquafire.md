# Dev-staging runbook: siwx-matrix stack on dev-aquafire + Caddy migration

Date: 2026-07-30
Plan: `docs/superpowers/plans/2026-07-30-dev-staging-deploy-caddy-migration.md`
(siwx-oidc repo) — this doc is the operational companion for tasks T3/T4
(live migration + stand-up), consumed on the box itself.

**Read the plan first.** It has the full Hypothesis Register (H1-H7),
Acceptance Criteria (AC1-AC6), and Boundary Conditions this runbook
operationalizes. This doc does not restate the rationale, only the exact
commands.

**Boundary conditions (non-negotiable, from the plan):**
- Never touch prod (`142.93.168.4`) or the bare aquafire box (`46.101.241.226`).
- The 5 pre-existing vhosts may be down only during the cutover window
  (<~60s target per vhost); rollback stays one command away until burn-in
  passes.
- Secrets are generated ON THE BOX, never committed, never pasted into
  chat/CI logs.
- Do not rely on watchtower; deploys are explicit (`docker compose pull && up -d`).

---

## 1. Box access

```bash
ssh -p 8022 -i ~/.ssh/id_inblock_deploy dev@207.154.209.103
```

Ubuntu 24.04, 2 vCPU, 3.9 GB RAM (~2.77 GB available at last check), 103 GB
disk free. Passwordless sudo for the `dev` user.

**Already running on this box (must not break):** `aqua_proxy`
(`ghcr.io/inblockio/ngnix-proxy:master`, docker-gen `VIRTUAL_HOST` pattern) +
`aqua_acme` (acme-companion), fronting 9 containers. Live vhosts today:
`aquafier.inblock.io`, `aquafier-api.inblock.io` (-> `deployment-aqua-container-1`),
`dev.aqua-node.inblock.io` (-> `aqua-explorer`), `dev.aquafire.inblock.io`
(-> `aquafier-rs:3000`), `draw.inblock.io` (-> `excalidraw`). Plus 2x
`postgres:18` and MinIO (no vhost, internal only).

## 2. Deploy directory layout

```
/home/dev/matrix-staging/
  .env                              # secrets, chmod 600, generated on the box, NOT committed
  docker-compose.dev-staging.yml    # from this branch
  Caddyfile.dev-aquafire            # from this branch, upstreams T3-filled
  config/                           # livekit.yaml, element-config.json (repo)
  entrypoints/                      # matrix_server.sh, element_entrypoint.sh (repo)
```

This is a `git clone` of `siwx-oidc-matrix-server` at the `dev-staging`
branch (until merged to `main`; switch to `main` after merge). Everything
under `config/` and `entrypoints/` is consumed by bind mounts in the compose
file exactly as in production — do not hand-edit copies, edit the repo and
re-pull.

```bash
sudo mkdir -p /home/dev/matrix-staging
sudo chown dev:dev /home/dev/matrix-staging
cd /home/dev/matrix-staging
git clone -b dev-staging https://github.com/inblockio/siwx-oidc-matrix-server.git .
cp .env.dev-staging.example .env
chmod 600 .env
```

## 3. Secret generation (on the box only)

Fill in the three `[secret, required]` blanks left in `.env` (full context
and rationale for each is in `.env.dev-staging.example`, reproduced here for
copy-paste convenience):

```bash
cd /home/dev/matrix-staging

# ES256 P-256 PKCS#8 signing key for siwx-oidc tokens
PEM=$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 2>/dev/null)
PEM_LINE=$(printf '%s' "$PEM" | sed ':a;N;$!ba;s/\n/\\n/g')
echo "SIWEOIDC_SIGNING_KEY_PEM=\"${PEM_LINE}\"" >> .env

# MSC3861 shared secret (Synapse <-> siwx-oidc introspection + admin API)
echo "MAS_SHARED_SECRET=$(openssl rand -hex 32)" >> .env

# LiveKit SFU key/secret
echo "LIVEKIT_KEY=API$(openssl rand -hex 8)" >> .env
echo "LIVEKIT_SECRET=$(openssl rand -base64 32)" >> .env
```

Verify `.env` is `-rw-------` (chmod 600) and has no blank `[secret,
required]` lines left before proceeding.

## 4. Pre-cutover staging (T3, before touching 80/443)

Do this BEFORE stopping `aqua_proxy`/`aqua_acme` — validate everything that
can be validated without a live port conflict first.

```bash
cd /home/dev/matrix-staging

# H7 pre-check: LiveKit's ports must be free before anything binds them.
ss -tlnp | grep -E ':7881\b' || echo "7881/tcp free"
ss -ulnp | grep -E ':(501[0-9][0-9]|502[0-9][0-9])\b' || echo "50100-50200/udp free"

# Compose file parses and env substitution resolves cleanly.
docker compose -f docker-compose.dev-staging.yml --env-file .env config >/dev/null \
  && echo "compose config OK"

# Caddyfile syntax is valid (this does NOT bind 80/443 — `caddy validate`
# only parses/checks the config, matching Caddy's own recommended pre-flight).
docker run --rm -v "$PWD/Caddyfile.dev-aquafire:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
```

**Fill in the real upstreams.** Dump the live nginx-proxy generated config
and the legacy containers' network membership, then replace every
`# TODO(T3-verify)` line in `Caddyfile.dev-aquafire` and every
`# TODO(T3-verify)` network placeholder in `docker-compose.dev-staging.yml`:

```bash
docker exec aqua_proxy cat /etc/nginx/conf.d/default.conf > /tmp/aqua-nginx.conf
less /tmp/aqua-nginx.conf   # find upstream container:port per vhost

docker inspect aqua_proxy --format '{{json .NetworkSettings.Networks}}' | jq
docker inspect deployment-aqua-container-1 aqua-explorer aquafier-rs excalidraw \
  --format '{{.Name}}: {{json .NetworkSettings.Networks}}' | jq
```

Re-run the `caddy validate` command above after editing until it passes with
the real upstreams filled in — do not proceed to cutover on a file that still
has an unverified TODO in it.

**Bring the new stack up WITHOUT Caddy on 80/443 yet**, so app-level health
can be checked first while the old proxy is still serving traffic:

```bash
docker compose -f docker-compose.dev-staging.yml --env-file .env up -d \
  matrix_synapse redis siwx-oidc element-web livekit lk-jwt-service
docker compose -f docker-compose.dev-staging.yml --env-file .env ps
```

Do NOT start the `caddy` service in this step — it would try to bind 80/443,
which `aqua_proxy`/`aqua_acme` still hold.

## 5. Cutover

**Check the old proxy containers' restart policy first.** If either is
`restart: always`, a host reboot during the burn-in window (below) would
silently resurrect it and fight the new Caddy for 80/443. `unless-stopped`
respects a manual `docker stop`; `always` does not.

```bash
docker inspect aqua_proxy aqua_acme \
  --format '{{.Name}}: {{.HostConfig.RestartPolicy.Name}}'

# If either says "always", relax it for the duration of the burn-in window
# (restores nothing by itself — this only stops it coming back on reboot;
# rollback still uses `docker start`, see section 7):
docker update --restart unless-stopped aqua_proxy aqua_acme
```

**Cutover** (target <60s downtime per vhost; time it):

```bash
date -u +%T   # start timestamp for the log

docker stop aqua_proxy aqua_acme

cd /home/dev/matrix-staging
docker compose -f docker-compose.dev-staging.yml --env-file .env up -d caddy

# Watch certificate issuance for all 8 vhosts.
docker compose -f docker-compose.dev-staging.yml --env-file .env logs -f caddy
```

Watch for `certificate obtained successfully` (or `already have certificate`
on a re-run) for each of the 8 domains before declaring the cutover done.

```bash
date -u +%T   # end timestamp for the log
```

## 6. Verification (AC1-AC4, H1-H7)

```bash
# H1 — all 5 pre-existing vhosts serve identically over HTTPS via Caddy.
for h in aquafier.inblock.io aquafier-api.inblock.io dev.aqua-node.inblock.io \
         dev.aquafire.inblock.io draw.inblock.io; do
  echo "== $h =="
  curl -sSI "https://$h" | head -5
done
# Expect the SAME status codes these returned under nginx-proxy (record a
# baseline with the same curl BEFORE cutover in section 4 for comparison),
# and a Let's Encrypt issuer in each TLS chain, not a fresh self-signed cert.

# H4 / AC2 — dev.matrix.inblock.io discovery + .well-known.
curl -sS https://dev.matrix.inblock.io/.well-known/matrix/client | jq .
curl -sS https://dev.matrix.inblock.io/.well-known/matrix/server | jq .

# AC2 — dev.siwx.inblock.io OIDC discovery (also proves the CORS strip: only
# ONE Access-Control-Allow-Origin header should be present on this response).
curl -sSI https://dev.siwx.inblock.io/.well-known/openid-configuration \
  | grep -i access-control-allow-origin
curl -sS https://dev.siwx.inblock.io/.well-known/openid-configuration | jq .issuer

# AC2 — dev.element.inblock.io loads.
curl -sS -o /dev/null -w '%{http_code}\n' https://dev.element.inblock.io

# H3 / AC3 — end-to-end login (headless client, did:key). Run from a
# machine with the siwx-oidc-auth binary (or `cargo run -p siwx-oidc-auth`
# from a siwx-oidc checkout).
siwx-oidc-auth --server https://dev.siwx.inblock.io \
  --client-id dev-staging-smoke --redirect-uri https://dev.element.inblock.io
# then, against Synapse, confirm the returned access_token resolves via
# GET https://dev.matrix.inblock.io/_matrix/client/v3/account/whoami

# H5 — RAM headroom after a 30-minute burn-in.
free -m
docker stats --no-stream

# H7 — LiveKit ports bound and healthy.
ss -tlnp | grep 7881
ss -ulnp | grep -E ':(501[0-9][0-9]|502[0-9][0-9])\b'
docker compose -f docker-compose.dev-staging.yml --env-file .env ps livekit lk-jwt-service
```

Record results (pass/fail + evidence) per the plan's T6/T7 tasks.

## 7. Rollback

One command away at any point before burn-in is declared complete:

```bash
cd /home/dev/matrix-staging
docker compose -f docker-compose.dev-staging.yml --env-file .env stop caddy

docker start aqua_proxy aqua_acme

# Confirm the 5 legacy vhosts serve again.
for h in aquafier.inblock.io aquafier-api.inblock.io dev.aqua-node.inblock.io \
         dev.aquafire.inblock.io draw.inblock.io; do
  curl -sSI "https://$h" | head -1
done
```

This does not touch the new stack's containers (`matrix_synapse`, `siwx-oidc`,
`element-web`, `livekit`, `lk-jwt-service`) — they stay up, just unreachable
from the internet with `caddy` stopped, so a re-attempt at cutover does not
need to re-pull images or re-run first-boot Synapse setup.

## 8. 24-hour burn-in rule

After a successful cutover, `aqua_proxy` and `aqua_acme` stay **stopped, not
removed**, for at least 24 hours:

```bash
docker ps -a --filter name=aqua_proxy --filter name=aqua_acme
# Both should show "Exited", not absent from `docker ps -a` output.
```

Do not `docker rm` them, do not prune their images/volumes, until the full
24h has passed with all 8 vhosts stable (re-run the section 6 checks at
least once more after several hours). Only after that window should you
consider the migration final and clean up the old containers — and even
then, keep the images pulled locally for a while longer in case a fast
rollback is ever needed again.

## 9. CI auto-deploy note (T5, separate task)

This runbook covers the manual stand-up. Once T5 wires CI auto-deploy for
this box, routine updates become `git pull && docker compose pull && docker
compose up -d` on push to `main` (see the plan's T5). Until then, redeploys
here are the same manual pattern used on production (`docker compose pull
<svc> && docker compose up -d <svc>` from this directory).
