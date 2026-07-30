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
- Never reboot this box as part of any procedure here.

---

## 0. LANDMINES — read before running anything

### Landmine 1: `restart: always` on the old proxy resurrects it

`/home/dev/aquafier-rs/deployment/docker-compose-proxy.yml` declares
`restart: always` for BOTH `aqua_proxy` and `aqua_acme`. Docker's `always`
policy does **not** respect a manual `docker stop` across a **daemon restart or
host reboot** — the container comes back. During the burn-in window the old
proxy is supposed to stay stopped-but-present; if dockerd restarts, it would
wake up and fight Caddy for ports 80/443, and whichever loses the race leaves
vhosts dark.

Therefore the cutover is, in this exact order:

```bash
docker compose -f /home/dev/aquafier-rs/deployment/docker-compose-proxy.yml stop
docker update --restart=no aqua_proxy aqua_acme
```

`stop`, **never `down`** — `down` would REMOVE the containers and destroy the
one-command rollback. `docker update --restart=no` is what actually defuses the
resurrection; stopping alone does not.

Rollback re-arms it (see section 7).

### Landmine 2: a duplicate proxy pair in the aquafier-js directory

`/home/dev/aquafier-js/deployment/docker-compose-dev.yml` defines its **own**
`proxy` + `letsencrypt` services — a second nginx-proxy/acme-companion pair
that would also bind 80/443. They are neutralized ONLY by the sibling
`docker-compose.override.yml` (`profiles: never`), which compose picks up
automatically **only when invoked from that directory with no explicit `-f`
list**.

**Never run `docker compose` in `/home/dev/aquafier-js/deployment/`**, and in
particular never run it there with an explicit `-f docker-compose-dev.yml`:
that drops the override and resurrects the duplicate proxy pair. The
`deployment` project is already running (`docker compose ls`); leave it alone.
If that app ever needs a restart, restart the *container*
(`docker restart deployment-aqua-container-1`), not the compose project.

### Landmine 3 (design): the proxy must not live in an app's compose project

Caddy is deployed from its own standalone project, `docker-compose.caddy-proxy.yml`
in `/home/dev/caddy-proxy/`, and is deliberately **not** a service in
`docker-compose.dev-staging.yml`. This box already suffered the coupled version
of this once — the header of `docker-compose-proxy.yml` records it: the proxy
used to live inside the aquafier-js project, so a `docker compose down` there
removed the proxy and took every other site on the box down with it. Caddy
fronts eight vhosts across five independent projects; keep its lifecycle
independent.

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

## 2. Deploy directory layout — TWO independent projects

The reverse proxy and the application stack are separate compose projects with
separate directories (see Landmine 3):

```
/home/dev/caddy-proxy/                # project: caddy-proxy   (T3, DONE)
  docker-compose.caddy-proxy.yml      # standalone: caddy only, owns 80/443
  Caddyfile.dev-aquafire              # all 8 vhosts, upstreams verified

/home/dev/matrix-staging/             # project: matrix-staging (T4)
  .env                                # secrets, chmod 600, on the box, NOT committed
  docker-compose.dev-staging.yml      # app services only — NO caddy service
  config/                             # livekit.yaml, element-config.json (repo)
  entrypoints/                        # matrix_server.sh, element_entrypoint.sh (repo)
```

They meet at exactly one place: the **external** Docker network `proxy_net`
(pre-existing, created by the old proxy project with an explicit `name:`).
Caddy joins only `proxy_net`; the app services join `proxy_net` in addition to
their own project default network, so Caddy resolves them by service name.
`redis` deliberately stays off `proxy_net`.

`/home/dev/matrix-staging` is a `git clone` of `siwx-oidc-matrix-server` at the
`dev-staging` branch (until merged to `main`; switch to `main` after merge).
Everything under `config/` and `entrypoints/` is consumed by bind mounts in the
compose file exactly as in production — do not hand-edit copies, edit the repo
and re-pull.

```bash
sudo mkdir -p /home/dev/matrix-staging
sudo chown dev:dev /home/dev/matrix-staging
cd /home/dev/matrix-staging
git clone -b dev-staging https://github.com/inblockio/siwx-oidc-matrix-server.git .
cp .env.dev-staging.example .env
chmod 600 .env
```

The proxy directory holds only the two files it needs; the bind mount path in
`docker-compose.caddy-proxy.yml` is relative (`./Caddyfile.dev-aquafire`), so
the two files must stay side by side. To update the config, copy in a new
Caddyfile and reload with **zero downtime** (no restart, no dropped
connections):

```bash
docker exec caddy_proxy caddy reload --config /etc/caddy/Caddyfile
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

## 4. Pre-cutover pre-flight (T3) — everything verifiable without touching 80/443

All of this runs while `aqua_proxy` is still serving traffic. Nothing here is
disruptive.

### 4.1 Verified upstream map

Read off the LIVE generated nginx config (2026-07-30). This is the single most
important input to the migration — re-verify it in one shot before any cutover:

```bash
docker exec aqua_proxy cat /etc/nginx/conf.d/default.conf \
  | grep -nE '^upstream|server [0-9.]+:[0-9]+|server_name'
docker network inspect proxy_net \
  --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{println}}{{end}}'
```

| vhost | nginx upstream | container:port |
|---|---|---|
| `aquafier-api.inblock.io` | `172.18.0.7:3000` | `deployment-aqua-container-1:3000` |
| `aquafier.inblock.io` | `172.18.0.7:3600` | `deployment-aqua-container-1:3600` |
| `dev.aqua-node.inblock.io` | `172.18.0.2:80` | `aqua-explorer:80` |
| `dev.aquafire.inblock.io` | `172.18.0.6:3000` | `aquafier-rs:3000` |
| `draw.inblock.io` | `172.18.0.4:80` | `excalidraw:80` |

**The two `aquafier*` vhosts are the same container on two different ports**
(3000 = API, 3600 = UI). Swapping them is the single easiest way to break this
migration silently — both would still return 200, just the wrong content.

All five backends sit on `proxy_net`, and `proxy_net` alone is enough — Caddy
needs no other network.

### 4.2 nginx behaviors that must be carried over

Everything else the generated config did is a Caddy default (HTTP/2, HTTP/3 +
`alt-svc`, WebSocket upgrade, HTTP→HTTPS redirect, OCSP stapling, ACME
challenge handling). `/etc/nginx/vhost.d/` was **empty** — no per-vhost
snippets to port. What is NOT a default and is reproduced explicitly in
`Caddyfile.dev-aquafire`:

| nginx | Caddy | Why it matters |
|---|---|---|
| `add_header Strict-Transport-Security "max-age=31536000" always` (all 5 vhosts) | `(hsts)` snippet, `header +Strict-Transport-Security` | `+` = ADD not SET. `dev.aquafire` upstream emits its own stricter `includeSubDomains` header; a SET would silently downgrade it |
| `client_max_body_size 200m` (global, `conf.d/inblock_custom.conf`; `PROXY_BODY_SIZE=200M`) | `(legacy_body_limit)` snippet, `request_body { max_size 200MB }` | Caddy has **no** default body limit — without this the box gets more permissive than it was |
| `DEFAULT_EMAIL=hello@inblock.io` on `aqua_acme` | `email hello@inblock.io` in the global block | Keeps LE expiry notices going to the same inbox |

One deliberate, benign difference: the HTTP→HTTPS redirect is **308** under
Caddy where nginx issued **301**. 308 is the method-preserving equivalent.

### 4.3 Validation (nothing binds a port)

```bash
# Caddyfile parses, all modules provision. Does NOT listen, does NOT hit ACME.
docker run --rm -v /home/dev/caddy-proxy/Caddyfile.dev-aquafire:/etc/caddy/Caddyfile:ro \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
# want: "Valid configuration"
# (a "Caddyfile input is not formatted" warning is expected and ignored: the
#  repo's Caddyfiles use 4-space indent, `caddy fmt` wants tabs. Cosmetic.)

# Both compose files parse and resolve.
cd /home/dev/caddy-proxy && docker compose -f docker-compose.caddy-proxy.yml config >/dev/null && echo OK
cd /home/dev/matrix-staging && docker compose -f docker-compose.dev-staging.yml --env-file .env config >/dev/null && echo OK

# proxy_net exists and is the external network both projects reference.
docker network inspect proxy_net --format '{{.Name}} {{.Driver}}'
```

**Prove the upstreams are reachable BY NAME before cutover.** This is the real
H1 de-risk — it exercises exactly the DNS names and ports the Caddyfile uses,
from a container on the same network Caddy will join, with zero disruption:

```bash
docker run --rm --network proxy_net alpine:latest sh -c '
for t in deployment-aqua-container-1:3600 deployment-aqua-container-1:3000 \
         aqua-explorer:80 aquafier-rs:3000 excalidraw:80; do
  code=$(wget -q -S -O /dev/null --timeout=8 "http://$t/" 2>&1 | grep -m1 "HTTP/" | awk "{print \$2}")
  echo "$t -> ${code:-NO_RESPONSE}"
done'
# want: 200 on all five
```

### 4.4 Baseline capture (run from your workstation, not the box)

Record what the vhosts do *under nginx* so the post-cutover check is a
comparison, not a guess:

```bash
for h in aquafier.inblock.io aquafier-api.inblock.io dev.aqua-node.inblock.io \
         dev.aquafire.inblock.io draw.inblock.io; do
  echo "--- $h ---"
  curl -sSI --max-time 20 "https://$h" | grep -iE '^(HTTP|strict-transport|content-type)'
done
```

Baseline 2026-07-30 pre-cutover: **all five HTTP/2 200**, all with
`strict-transport-security: max-age=31536000`, all Let's Encrypt issuers
(`server: nginx/1.29.4`). `dev.aquafire` additionally carried the upstream's
own `max-age=31536000; includeSubDomains` first.

### 4.5 Firewall (T4 prerequisite, done during T3)

ufw is active and default-deny. LiveKit needs two rules; add them here so T4
does not have to touch the firewall during a stack bring-up. Touch nothing else.

```bash
sudo ufw allow 7881/tcp comment 'livekit sfu'
sudo ufw allow 50100:50200/udp comment 'livekit media'
sudo ufw status verbose
```

No `8448` rule is needed — federation uses `.well-known` delegation to 443.

## 5. Cutover

Order matters. Read Landmine 1 first: `stop`, never `down`; and
`--restart=no` is what actually prevents resurrection.

```bash
date -u +%H:%M:%S   # T0

# 1. Stop the old proxy project (containers are KEPT, for rollback).
docker compose -f /home/dev/aquafier-rs/deployment/docker-compose-proxy.yml stop

# 2. Defuse `restart: always` so a dockerd restart cannot resurrect it
#    into a port fight with Caddy during burn-in.
docker update --restart=no aqua_proxy aqua_acme

# 3. Start Caddy on 80/443.
cd /home/dev/caddy-proxy
docker compose -f docker-compose.caddy-proxy.yml up -d

date -u +%H:%M:%S   # T1 — downtime window is T0..T1 plus cert issuance

# 4. Watch certificate issuance for all 8 vhosts.
docker compose -f docker-compose.caddy-proxy.yml logs -f
```

Expect `certificate obtained successfully` for each of the 8 domains. The five
legacy vhosts are the ones that matter here — the three `dev.*` vhosts will
answer **502** until T4 stands up the stack behind them, which is expected and
fine; their **certificates must still issue**, because ACME HTTP-01 is served
by Caddy itself and does not depend on the upstream being up.

Caddy issues certificates **on demand at first request** for a hostname it
manages, so a domain may not appear in the log until something asks for it.
Nudge all eight rather than waiting:

```bash
for h in aquafier.inblock.io aquafier-api.inblock.io dev.aqua-node.inblock.io \
         dev.aquafire.inblock.io draw.inblock.io \
         dev.matrix.inblock.io dev.siwx.inblock.io dev.element.inblock.io; do
  curl -sS -o /dev/null -w "$h %{http_code}\n" --max-time 30 "https://$h"
done
```

## 6. Verification (AC1-AC4, H1-H7)

```bash
# H1 — all 5 pre-existing vhosts serve identically over HTTPS via Caddy.
# Checks status + HSTS + issuer in one pass. Compare against the section 4.4
# baseline: same status, same HSTS value, Let's Encrypt issuer (NOT a Caddy
# self-signed / internal cert, which is what a failed ACME run leaves behind).
for h in aquafier.inblock.io aquafier-api.inblock.io dev.aqua-node.inblock.io \
         dev.aquafire.inblock.io draw.inblock.io; do
  echo "== $h =="
  curl -sSI --max-time 20 "https://$h" | grep -iE '^(HTTP|strict-transport|server|content-type)'
  curl -sSv --max-time 20 -o /dev/null "https://$h" 2>&1 | grep -iE 'issuer:'
done

# HTTP->HTTPS redirect still happens (308 under Caddy, was 301 under nginx).
curl -sSI --max-time 20 http://aquafier.inblock.io | head -3

# The 3 dev.* vhosts pre-T4: TLS handshake MUST succeed (cert issued) even
# though the app behind them is not up yet, so 502 is the expected status.
for h in dev.matrix.inblock.io dev.siwx.inblock.io dev.element.inblock.io; do
  echo "== $h =="
  curl -sS -o /dev/null -w 'status=%{http_code}\n' --max-time 20 "https://$h"
  curl -sSv --max-time 20 -o /dev/null "https://$h" 2>&1 | grep -iE 'issuer:|SSL certificate verify'
done

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

**Abort criterion:** if any of the five legacy vhosts is broken for more than
~10 minutes after cutover and the cause is not obviously fixable, roll back.
Do not leave the box half-migrated.

Three commands, no rebuild, no re-pull. It is the exact inverse of section 5:

```bash
# 1. Free 80/443.
docker compose -f /home/dev/caddy-proxy/docker-compose.caddy-proxy.yml stop

# 2. Re-arm the old proxy's restart policy (undo Landmine-1 defusal).
docker update --restart=always aqua_proxy aqua_acme

# 3. Bring the old proxy back.
docker start aqua_proxy aqua_acme

# 4. Confirm the 5 legacy vhosts serve again.
for h in aquafier.inblock.io aquafier-api.inblock.io dev.aqua-node.inblock.io \
         dev.aquafire.inblock.io draw.inblock.io; do
  curl -sSI --max-time 20 "https://$h" | head -1
done
```

Why this is safe to rely on:
- The old containers were `stop`ped, never `down`ed, so they still exist with
  their original config — `docker start` is all that is required.
- The old certificates live in the untouched `proxy_proxy_data_certs` volume
  (plus `proxy_proxy_data_acme`, `_html`, `_vhost`). Caddy stores its own certs
  in the separate `caddy-proxy_caddy_data` volume and never writes to theirs.
- Caddy having issued its own certificates for the same domains does **not**
  invalidate the old ones. Both sets stay valid; only one proxy binds 80/443.
- The new stack's containers are in a different project and are untouched by
  either direction of this switch.

## 8. 24-hour burn-in rule

After a successful cutover, `aqua_proxy` and `aqua_acme` stay **stopped, not
removed**, for at least 24 hours:

```bash
docker ps -a --filter name=aqua_proxy --filter name=aqua_acme \
  --format '{{.Names}}\t{{.Status}}\t{{.State}}'
# Both should show "Exited" — present in `docker ps -a`, not absent.

docker inspect aqua_proxy aqua_acme \
  --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}'
# Both should say restart=no for the duration of the burn-in.
```

Do not `docker rm` them, do not prune their images, and above all **do not
remove the `proxy_proxy_data_*` volumes** until the full 24h has passed with
all 8 vhosts stable (re-run the section 6 checks at least once more after
several hours). Only after that window should you consider the migration final
— and even then, keep the images and cert volumes for a while longer in case a
fast rollback is ever needed again.

Note that with `--restart=no` the old proxy will NOT come back on a reboot,
which is the desired burn-in state. When the migration is declared final, the
old proxy project should be `down`ed properly rather than left as a stopped
husk.

## 9. CI auto-deploy note (T5, separate task)

This runbook covers the manual stand-up. Once T5 wires CI auto-deploy for
this box, routine updates become `git pull && docker compose pull && docker
compose up -d` on push to `main` (see the plan's T5). Until then, redeploys
here are the same manual pattern used on production (`docker compose pull
<svc> && docker compose up -d <svc>` from this directory).
