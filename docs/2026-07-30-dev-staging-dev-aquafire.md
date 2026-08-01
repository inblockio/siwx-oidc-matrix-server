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
sudo ufw allow 20100:20200/udp comment 'livekit media'
sudo ufw status verbose
```

The media range moved from 50100-50200 to 20100-20200 on 2026-08-01 (below the
Linux ephemeral range; see the av-hardening plan, T4). A box provisioned before
that has the old rule: add the new one BEFORE converging the stack, then
`sudo ufw delete allow 50100:50200/udp` once calls are verified on the new range.

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
#
# BUG (fixed 2026-07-31): this used to read
#   `siwx-oidc-auth --server https://dev.siwx.inblock.io \
#      --client-id dev-staging-smoke --redirect-uri https://dev.element.inblock.io`
# `dev-staging-smoke` was never a registered client — the token exchange
# 401s with "Unrecognised client id". There is no static smoke client;
# register an ephemeral one per run via RFC 7591 dynamic client registration
# first. This is the exact sequence used repeatedly this week (verified
# live against dev.siwx.inblock.io — see
# `docs/audits/2026-07-30-dev-staging-audit-evidence.md`, H3 section, in the
# siwx-oidc repo, for a full transcript with real IDs/tokens redacted).

# 1. Generate a throwaway Ed25519 identity for the smoke test (produces a
#    did:key — the server must have "key" in SIWEOIDC_SUPPORTED_DID_METHODS,
#    which dev-staging does).
openssl genpkey -algorithm Ed25519 -out /tmp/dev-staging-smoke-key.pem

# 2. Register an ephemeral public OAuth client (no secret needed for this
#    flow). The registration_endpoint is advertised in OIDC discovery
#    (`/register`); redirect_uris just needs to be a URI the client controls
#    — it does not need to resolve to anything for this smoke test.
curl -sS -X POST https://dev.siwx.inblock.io/register \
  -H 'Content-Type: application/json' \
  -d '{"redirect_uris": ["https://dev.siwx.inblock.io/smoke-test-callback"]}'
# -> HTTP 201, body includes "client_id": "<uuid>" — use that uuid below.

# 3. Authenticate: signs a challenge with the ephemeral key and exchanges it
#    for OIDC tokens via the registered client.
siwx-oidc-auth --server https://dev.siwx.inblock.io \
  --client-id <client_id from step 2> \
  --redirect-uri https://dev.siwx.inblock.io/smoke-test-callback \
  --key-file /tmp/dev-staging-smoke-key.pem
# -> prints access_token (mat_... in MSC3861 mode), refresh_token, id_token.

# 4. Confirm the returned access_token resolves via Synapse:
curl -sS -H "Authorization: Bearer <access_token from step 3>" \
  https://dev.matrix.inblock.io/_matrix/client/v3/account/whoami
# -> HTTP 200, {"user_id":"@did-key-...:dev.matrix.inblock.io", "device_id":"SIWX_..."}

# 5. Clean up the throwaway key (it is not a secret worth keeping around):
rm -f /tmp/dev-staging-smoke-key.pem

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

### Rollback procedure — updated after teardown (2026-07-31)

The three-command procedure above assumed `aqua_proxy`/`aqua_acme` were
**stopped, not removed** (the section 8 burn-in state). That assumption ended
on 2026-07-31 when the old proxy project was torn down (see section 8,
"EXECUTED — teardown"): `docker start aqua_proxy aqua_acme` will now fail —
those containers no longer exist. `down` (without `-v`) removes containers and
networks, not volumes or images, so rollback is still fast, just one command
different:

```bash
# 1. Free 80/443.
docker compose -f /home/dev/caddy-proxy/docker-compose.caddy-proxy.yml stop

# 2. Recreate the old proxy pair from the retained compose file, images, and
#    volumes — same certs, same config, no rebuild, no re-pull.
docker compose -f /home/dev/aquafier-rs/deployment/docker-compose-proxy.yml up -d

# 3. Confirm the 5 legacy vhosts serve again.
for h in aquafier.inblock.io aquafier-api.inblock.io dev.aqua-node.inblock.io \
         dev.aquafire.inblock.io draw.inblock.io; do
  curl -sSI --max-time 20 "https://$h" | head -1
done
```

Why this still works: the compose file
(`/home/dev/aquafier-rs/deployment/docker-compose-proxy.yml`), the
`ghcr.io/inblockio/ngnix-proxy:master` / `nginxproxy/acme-companion:latest`
images, and the `proxy_proxy_data_{acme,certs,html,vhost}` volumes were all
**retained** by design during teardown (`down` with no `-v`, images never
pruned) — only the containers and the (shared, still-in-use) `proxy_net`
membership were removed. `up -d` recreates `aqua_proxy`/`aqua_acme` from that
exact state, certs included.

Note the compose file bakes in `restart: always` for both services (Landmine
1). For a genuine emergency rollback that is the correct behavior once Caddy
is stopped in step 1. If instead this is a temporary test bring-up, re-apply
`docker update --restart=no aqua_proxy aqua_acme` afterward before stopping
them again, exactly as Landmine 1 describes.

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

### EXECUTED — teardown, 2026-07-31

The 24h window above was **ended early by explicit user order**, not run to
completion: Caddy had served all 8 vhosts cleanly since cutover T0
(2026-07-30T17:44:01Z, section 8b) with multiple clean audits in between, and
the order judged that sufficient to stop the burn-in and finalize the
migration ahead of schedule (characterized at order time as "~11h in";
measured wall-clock from T0 to the teardown below was closer to ~14h — the
window was cut short either way, well inside the intended 24h, on explicit
instruction rather than a full clock run).

Pre-teardown check confirmed the burn-in invariants had held throughout: both
containers present in `docker ps -a` as `Exited` (`aqua_proxy` code 2,
`aqua_acme` code 0) with `restart=no`, `caddy_proxy` healthy with
`RestartCount=0`, and all 8 vhosts at their known-good status codes.

```bash
docker compose -f /home/dev/aquafier-rs/deployment/docker-compose-proxy.yml down
```

Run with **no `-v`** — volumes were never in scope for removal. Output:

```
Container aqua_acme   Stopping / Stopped / Removing / Removed
Container aqua_proxy  Stopping / Stopped / Removing / Removed
Network proxy_net     Removing
Network proxy_net     Resource is still in use
```

The trailing "Resource is still in use" on `proxy_net` is **expected, not an
error**: the network is shared with `caddy_proxy` and the five live legacy
backends, so Docker correctly refuses to delete it. Verified post-teardown:

- `aqua_proxy` / `aqua_acme` absent from `docker ps -a`.
- `proxy_net` still exists, with `caddy_proxy` and all five legacy backends
  (plus the matrix-staging containers) still attached — unchanged from the
  pre-teardown membership list.
- `caddy_proxy` still `healthy`, `RestartCount=0` (unchanged) — the teardown
  did not touch or restart it.
- All 8 vhosts re-swept immediately after: identical status codes to the
  pre-teardown sweep (200 ×7, 302 on `dev.matrix.inblock.io`, matching the
  known baseline both times).
- `proxy_proxy_data_{acme,certs,html,vhost}` volumes: present, untouched
  (`docker volume ls`).
- `ghcr.io/inblockio/ngnix-proxy:master` and `nginxproxy/acme-companion:latest`
  images: present, untouched (`docker images`) — kept intentionally as
  last-resort rollback material, see updated section 7.

**Rollback-to-nginx is now:**

```bash
docker compose -f /home/dev/aquafier-rs/deployment/docker-compose-proxy.yml up -d
```

(file, volumes, and images all retained on the box — see the updated section
7 rollback procedure for the full sequence including freeing 80/443 first.)

**Cleanup candidates, not yet acted on.** The old cert volumes
(`proxy_proxy_data_{acme,certs,html,vhost}`) and the two retired images
(`ghcr.io/inblockio/ngnix-proxy:master`, `nginxproxy/acme-companion:latest`)
are being kept deliberately as last-resort rollback material per section 7.
Once Caddy has run stable for **~30 days** past this teardown (i.e. from
~2026-08-30), they become candidates for actual removal
(`docker volume rm` / `docker image rm`) to reclaim disk — not before, and not
automatically.

## 8b. EXECUTED — cutover record, 2026-07-30 (T3)

The migration described above was executed on 2026-07-30. Verbatim record.

### Timeline (UTC)

| Time | Event |
|---|---|
| 17:33–17:43 | Pre-flight: upstream map re-verified, `caddy validate` OK, both compose files OK, all 5 upstreams reachable by name from `proxy_net` (200×5), ufw LiveKit rules added, external baseline captured |
| 17:44:01.345 | **T0** — cutover begins |
| 17:44:02.079 | `docker compose -f .../docker-compose-proxy.yml stop` returned (aqua_proxy + aqua_acme stopped, **kept**) |
| 17:44:02.136 | `docker update --restart=no aqua_proxy aqua_acme` returned |
| 17:44:02.734 | **T1** — `docker compose -f docker-compose.caddy-proxy.yml up -d` returned, Caddy listening |
| 17:44:02.9 | ACME account registered (`hello@inblock.io`), 8 parallel cert orders begin |
| 17:44:09.5 | Last failing external probe sample |
| 17:44:10.6 | **All 5 legacy vhosts back to HTTP 200** |
| ~17:44:20 | All 8 certificates issued (`certificate obtained successfully` ×8) |
| 17:47:58 | Zero-downtime reload #1 — HSTS `+` → `?` fix (159 ms, no restart) |
| 17:49:18 | Zero-downtime reload #2 — body limit `200MB` → `200MiB` fix (159 ms, no restart) |

**Cutover commands: 1.39 s.** No image pull was in the window (`caddy:2-alpine`
was pre-pulled during pre-flight — do this, it matters).

### Measured downtime

External probe from a workstation, all 5 legacy vhosts in parallel, ~1.1 s
sampling interval, 395 samples over 17:43:33–17:45:05:

| vhost | failed samples | outage |
|---|---|---|
| `aquafier-api.inblock.io` | 6 | ~6.5 s |
| `aquafier.inblock.io` | 7 | ~7.6 s |
| `dev.aquafire.inblock.io` | 7 | ~7.6 s |
| `dev.aqua-node.inblock.io` | 8 | ~8.7 s |
| `draw.inblock.io` | 8 | ~8.7 s |

**Worst case ~8.7 s, against a <60 s target.** Failure modes seen, in order:
one round of `curl exit 7` (connection refused — old proxy stopped, Caddy not
yet bound), then `curl exit 35` (TLS error — Caddy bound but that hostname's
certificate not yet issued). The tail is dominated by ACME issuance, not by
the container swap, which is why pre-pulling the image and letting all 8
orders run in parallel is what keeps the window short.

### Verification (H1/AC1)

Post-cutover vs. pre-cutover baseline — identical status, byte size and
content-type on every vhost, which is also what proves the
`deployment-aqua-container-1` **3000-vs-3600** ports were not swapped (the two
vhosts return visibly different payloads):

| vhost | baseline | after | HSTS | issuer |
|---|---|---|---|---|
| `aquafier.inblock.io` | 200, text/html, 1808 B | 200, text/html, 1808 B | `max-age=31536000` | LE YE1 |
| `aquafier-api.inblock.io` | 200, application/json, 15 B | 200, application/json, 15 B | `max-age=31536000` | LE YE2 |
| `dev.aqua-node.inblock.io` | 200, text/html, 1719 B | 200, text/html, 1719 B | `max-age=31536000` | LE YE2 |
| `dev.aquafire.inblock.io` | 200, text/html, 52199 B | 200, text/html, 52199 B | `max-age=31536000; includeSubDomains` | LE YE2 |
| `draw.inblock.io` | 200, text/html, 6843 B | 200, text/html, 6843 B | `max-age=31536000` | LE YE1 |

All HTTP/2; HTTP→HTTPS redirect confirmed (`308`, `Location: https://…`).

The 3 dev vhosts, cert-only as expected pre-T4: `dev.matrix`, `dev.siwx`,
`dev.element` all return **502 with a valid Let's Encrypt certificate** — TLS
handshake succeeds, only the upstream is missing. Caddy's log shows the
matching `dial tcp: lookup <svc> ... server misbehaving` errors; these are
expected and clear once T4 starts the stack on `proxy_net`.

### Two defects found and fixed during verification

Both were found *because* the post-cutover check compared against a baseline
rather than just looking for HTTP 200. Both were fixed by zero-downtime reload,
no restart, no additional downtime.

1. **HSTS order inversion (`header +` was wrong).** `+` (add) put Caddy's
   weaker header FIRST on `dev.aquafire.inblock.io`, whose upstream emits
   `includeSubDomains`. Per RFC 6797 §8.1 the UA processes only the first
   header, so the effective policy was silently downgraded — while a header
   dump still *showed* `includeSubDomains` and looked fine. Fixed to `?`
   (default: set only if absent), verified against both a HSTS-emitting and a
   non-emitting upstream. `dev.aquafire` now returns exactly one STS header,
   the upstream's stricter one.
2. **`200MB` ≠ `200m`.** Caddy's `200MB` is decimal (200,000,000 B); nginx's
   `200m` is binary (209,715,200 B). The first config was 4.6% *stricter* than
   nginx, which would have rejected uploads in that 9.7 MB band. Fixed to
   `200MiB`; the running config now reports `max_size: 209715200` ×5.

### Rollback status: REHEARSED AND READY, NOT EXECUTED

Not needed — no legacy vhost was ever broken beyond the 8.7 s cutover window.
State left behind, confirmed:

```
aqua_proxy   Exited (2)   restart=no
aqua_acme    Exited (0)   restart=no
volumes: proxy_proxy_data_{acme,certs,html,vhost}   (untouched)
```

Both containers present and startable; old certificates intact in their own
volumes; Caddy's certs live separately in `caddy-proxy_caddy_data`. The
section 7 procedure is three commands and was validated by inspection of this
state, not by execution.

### Box state after cutover

8 containers running (`caddy_proxy` healthy + the 7 pre-existing app/db
containers), 2 stopped by design (`aqua_proxy`, `aqua_acme`). Memory:
1200 MB used, **2715 MB available**, swap 1 MB — ample headroom for T4's
stack (H5 pre-check).

## 9. CI auto-deploy (T5)

**Status: the box auto-deploys today, with no GitHub secret involved.**
Auto-deploy has two independent mechanisms, and only one of them is
currently live:

- **Pull-model systemd timer (PRIMARY, live now).** `matrix-staging-deploy.timer`
  runs on the box itself, polling `ci-deploy.sh` on a schedule. It needs no
  GitHub secret, no PAT, and no inbound reachability from GitHub Actions to
  the box — the box reaches out to GHCR, not the other way around. This is
  what actually keeps dev-staging converged to `main` today.
- **Push-model CI job (SECONDARY, dormant until a secret exists).** The
  `deploy-dev-staging` job in both repos' `docker.yml` SSHes into the box
  right after a `main` build. It is fully built and wired but guarded to
  **skip cleanly (green, with a `::notice::`)** whenever
  `DEV_STAGING_DEPLOY_KEY` is unset, rather than fail — see "What's in
  place" item 4 below. Wiring the secret in (once the `inblockio` PAT is
  rotated/restored — `~/.claude/CLAUDE.md`, "GitHub Authentication") is
  **optional**: it shortens the worst-case convergence lag from ~5 minutes
  (next timer tick) to effectively immediate, but the box no longer depends
  on it for correctness.

Both mechanisms invoke the same idempotent `ci-deploy.sh`, now serialized
against each other by an exclusive flock (`/home/dev/matrix-staging/.deploy.lock`,
120s wait before failing) so a timer tick and a CI-triggered run can never
race `docker compose pull`/`up -d` against each other — one simply waits
for the other to finish.

### Pull-model systemd timer — installed and verified 2026-07-30

- `/etc/systemd/system/matrix-staging-deploy.service` — `Type=oneshot`,
  `User=dev`, `ExecStart=/home/dev/matrix-staging/ci-deploy.sh`.
- `/etc/systemd/system/matrix-staging-deploy.timer` — `OnBootSec=2min`,
  `OnUnitActiveSec=5min`, `Persistent=false`, `WantedBy=timers.target`.
- Enabled with `sudo systemctl enable --now matrix-staging-deploy.timer`.
  Since the box had already been up for ~39h when the timer was enabled,
  `OnBootSec=2min` was already in the past, so systemd ran the service
  immediately on enable rather than waiting for a reboot — this doubled as
  the first live verification run.
- Verified: `systemctl list-timers matrix-staging-deploy.timer` shows a
  `NEXT` ~5 minutes out and a `LAST`/`PASSED` from the immediate first run;
  `journalctl -u matrix-staging-deploy.service` shows the full `ci-deploy.sh`
  transcript ending `[ci-deploy] deploy complete` with `status=0/SUCCESS`
  (a no-op deploy — images were already current, all three smoke checks
  passed). A manual concurrency test (holding the flock in a background
  shell, then launching `ci-deploy.sh`) confirmed the script blocks until
  the lock is free rather than racing or erroring.

### What's in place (push-model CI job)

1. **Deploy key.** A dedicated ed25519 keypair, generated on the DevOps
   laptop, private half never printed or committed:
   `~/.ssh/dev_aquafire_ci_deploy{,.pub}`. Public fingerprint:
   `SHA256:JKGfdN+aDHhLfUPhiz0cZ8woLRy8ZkQxWrYO4wu3kqE`.

2. **Forced-command authorized_keys entry**, appended to
   `/home/dev/.ssh/authorized_keys` on the box (backup taken first at
   `/home/dev/.ssh/authorized_keys.bak-20260730T181241Z`; the pre-existing 6
   entries are untouched):

   ```
   command="/home/dev/matrix-staging/ci-deploy.sh",no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEiNAST2CzPvOzSX3AqCszoUEc0bAn21IRfesckFy5kZ github-actions-dev-staging-deploy
   ```

   Verified from this machine with the new PRIVATE key: `ssh -p 8022 -i
   ~/.ssh/dev_aquafire_ci_deploy dev@... "whoami"` runs `ci-deploy.sh` (not
   `whoami` — no `dev` in the output), `cat /etc/shadow` and `rm -rf
   /home/dev/matrix-staging` were both silently ignored (directory intact
   after), `-L` port forwarding is refused (forwarded port never opens), and
   `-t` pty allocation gets no interactive session. The only thing this key
   can ever do is run `ci-deploy.sh`.

3. **`/home/dev/matrix-staging/ci-deploy.sh`** (mode 755, owner `dev`):
   `docker compose -f docker-compose.dev-staging.yml pull && ... up -d`
   (tags come from `.env`, so `IMAGE_TAG=sha-4266aa8` stays pinned and only
   `SIWX_OIDC_TAG=main` actually floats), waits for container health (90s
   budget), prints `docker compose ps`, smoke-checks the three public HTTPS
   endpoints through Caddy with retries (`dev.siwx` discovery doc,
   `dev.matrix` `.well-known/matrix/client`, `dev.element` root), then
   echoes the running `siwx-oidc`/`matrix_synapse`/`element-web` image
   digests so CI logs show exactly what got deployed. `set -euo pipefail`;
   any failure (bad pull, unhealthy container, failed smoke check) exits
   nonzero. Takes no arguments and ignores `SSH_ORIGINAL_COMMAND` — trusting
   client-supplied command strings would defeat the point of the forced
   command above. **Manually run end-to-end from this machine (as `dev`
   directly, not via the forced key) — exit 0, all three smoke checks ok,
   idempotent on a second run** (see this doc's verification log / the T5
   implementation report for the full transcript).

4. **Workflow job `deploy-dev-staging`** appended to `docker.yml` in both
   repos (`needs: build-and-push`, fires on push to `main` — not on tag
   pushes, `fork-stable`, or releases, which also satisfy each repo's `on:
   push` trigger — or on `workflow_dispatch`): installs the deploy key from
   secret `DEV_STAGING_DEPLOY_KEY`, pins the box's host key from a
   `ssh-keyscan` capture embedded in the workflow (no TOFU in CI), then SSHs
   in; the forced command runs `ci-deploy.sh` regardless of the `deploy`
   argument in the workflow (kept only for a readable Actions log line).
   **Guarded** (added 2026-07-30): a first `Check deploy key configured`
   step writes `ok=${{ secrets.DEV_STAGING_DEPLOY_KEY != '' }}` to
   `GITHUB_OUTPUT`; every subsequent step (`if: steps.check-secret.outputs.ok
   == 'true'`) — install key, pin host key, deploy, clean up — is
   conditioned on it, plus one step for the inverse that prints a
   `::notice::` explaining the job is dormant and pointing at the pull-model
   timer above. Net effect: with no secret, the job is entirely made of
   skipped steps and one notice — **green**, not red. Both `docker.yml`
   files still pass `python3 -c 'import yaml; yaml.safe_load(...)'`.

### Branch-based CI deploys (S5, 2026-07-31)

**Status: LIVE.** `docker.yml` in both repos now builds on a push to `dev`
as well as `main` (`docker/metadata-action`'s `type=ref,event=branch` tag
rule, already in place for `main`, applies identically — no other workflow
change was needed). The flow:

- **`dev` branch -> `:dev` images -> dev-staging auto-converges.** Both
  repos' `dev` branches float independently for fast iteration. dev-staging's
  `.env` now pins `SYNAPSE_IMAGE_REF`/`ELEMENT_IMAGE_REF` to the `:dev` tag
  and `SIWX_OIDC_TAG=dev` (was `:main`/`main`); `REDIS_IMAGE_REF`/
  `LK_JWT_IMAGE_REF` are untouched digest pins. The existing pull-model
  `matrix-staging-deploy.timer` (above) is the ENTIRE convergence mechanism
  — it needed zero changes, because it always pulled whatever tag `.env`
  named; only the tag name changed, not the mechanism.
- **`main` branch -> `:main` images**, kept for later prod promotion (S6).
  Prod's `.env` is untouched by this change — it still digest-pins,
  independent of what `:main` currently resolves to.
- **`paths-ignore: ['docs/**', '**.md']`** on the `push` trigger (only —
  `release`/`workflow_dispatch` are unaffected) stops a docs-only commit
  from rebuilding+moving a floating tag's digest with no code change, which
  is what silently happened to `:main` earlier in the 2026-07-31 digest
  incidents this doc's Process Rule 1 already describes. Deliberately does
  **not** exclude `.github/workflows/**` — a workflow-file edit must still
  build. Both `docker.yml` files parse clean under `python3 -c 'import
  yaml; yaml.safe_load(...)'`.

**Live-verified, 2026-07-31 (all times UTC):**

| Repo | Push | Run | Conclusion | Build done | Box tick | Deploy complete | Push->converged |
|---|---|---|---|---|---|---|---|
| siwx-oidc-matrix-server (`dev`) | `d5ad705` 00:48:32 | [30594598088](https://github.com/inblockio/siwx-oidc-matrix-server/actions/runs/30594598088) | success | 00:51:40 | 00:56:50 | 00:57:21 | ~8m50s |
| siwx-oidc (`dev`) | `b6c8d63` 00:48:16 | [30594585961](https://github.com/inblockio/siwx-oidc/actions/runs/30594585961) | success | 00:52:57 | 00:56:50 | 00:57:21 | ~9m07s |

Both comfortably inside the "next tick or two" (~15 min / 3-tick) budget.
Post-convergence battery: all 3 public endpoints 200, all 6 containers
healthy with `RestartCount=0`, Synapse still `1.154.0`, and a fresh
throwaway `did:key` RFC 7591 + auth-code login round-tripped to a `mat_`
token and a 200 `whoami` with a `SIWX_` device id (then `POST
/_matrix/client/v3/logout` to revoke the token and delete the throwaway
device — cleanup verified via the endpoint's `{}` 200).

**paths-ignore proof (step 6):** a docs-only commit to `dev`
(`b2a7488`, docs/, no code) produced **zero** check-suites for that SHA
(`GET /repos/.../commits/b2a7488/check-suites` -> `total_count: 0`) — not
just a skipped job, no run was ever created. Verified again on `main`
itself when this very doc's update landed there (see the commit that
introduced this paragraph — same `total_count: 0` result expected/required).

**Landmine (new): simultaneous same-SHA pushes to two branches can coalesce
into one check-suite.** The very first `dev` push in this rollout
(`git push origin dev-staging:main` immediately followed by `git push
origin dev` from the same commit, in the same shell invocation) landed on
the identical commit SHA as the `main` push seconds earlier. GitHub created
only ONE check-suite for that SHA (`head_branch: main`); `dev` got no
distinct run and no `:dev` tag was published. Confirmed via `GET
.../commits/{sha}/check-suites` -> `total_count: 1`, and `GET
.../actions/runs?branch=dev` -> `total_count: 0`. Fix: give the second
branch a genuinely new commit (don't just move a second ref onto a
just-pushed SHA) — that's what the `e3f9a21` harmless-LABEL commit did.
Anyone scripting a "push the same commit to two trigger branches" flow
should stagger the pushes by more than a few seconds, or expect to verify
per-branch and re-push if coalesced.

**Landmine (confirms Process Rule 1): identical source, different image
bytes.** siwx-oidc's `dev` and `main` were both built from commit `b6c8d63`
(the `dev` push, then a later FF-push of the same commit to `main`) via two
separate `docker/build-push-action` runs. Their digests differ —
`:dev` = `sha256:5a8be625e31bb704c0259265547d8e7977ba36eb4ee1a67785d42ab3ee2cdfeb`,
`:main` = `sha256:7aa8426c95927bdfa317a92d2c91d6e6359a6974a2353cba3bc2f7c94914279d`
— despite byte-identical source. This is not a bug (no `SOURCE_DATE_EPOCH`
pinning, standard for these Dockerfiles); it is exactly why **the S6
promotion gate must never treat "same tag" or even "same source commit" as
"same image"** — always digest-compare (Process Rule 1 above, restated
here because this branch flow makes it easy to accidentally reach for the
wrong evidence: "`main` was built from the commit `dev` validated" is
NOT the same claim as "`main` resolves to the digest `dev` validated").

**Current dev-validated digests (for S6 promotion — pin these exact
digests in prod's `.env`, not `:dev`/`:main` tags):**

```
siwx-oidc:            sha256:5a8be625e31bb704c0259265547d8e7977ba36eb4ee1a67785d42ab3ee2cdfeb
synapse:               sha256:60c30d63bd2eadb216994b63b667ceec9be66869295be78e87edd33419230f99
element-web:            sha256:7f7fe71567535ef86f3b6f32367958cc9275e01e7bf63ece7639023f80f4dfba
```

These are the exact digests dev-staging pulled, ran, smoke-tested, and
completed a live e2e login against on 2026-07-31 — not just "whatever
`:dev`/`:main` happen to resolve to when S6 runs".

**Promotion path:** FF-merge `dev` -> `main` in both repos (clean, since
`dev` only ever adds commits on top of the shared history — never rebased,
never force-pushed) once the digests above are what you want to ship, then
apply the S6-style digest-pinned prod `.env` update using the table above
(never the floating `:main` tag — see the "identical source, different
bytes" landmine just above for why `:main` alone is not sufficient
evidence).

### Optional: enabling the push-model job (only if/when the PAT returns)

This is no longer required for the box to converge — the pull-model timer
above already does that — but it shortens the worst-case lag from "next
timer tick" (~5 min) to effectively immediate, and it's the only way to
verify AC4 via an actual GitHub-Actions-triggered run rather than the box
polling on its own. `gh` commands below remain listed for when the
`inblockio` PAT is rotated/restored; nothing in this runbook currently
depends on them:

```bash
# 1. Set the secret in both repos (private key file, never paste the value elsewhere)
gh secret set DEV_STAGING_DEPLOY_KEY --repo inblockio/siwx-oidc \
  < ~/.ssh/dev_aquafire_ci_deploy
gh secret set DEV_STAGING_DEPLOY_KEY --repo inblockio/siwx-oidc-matrix-server \
  < ~/.ssh/dev_aquafire_ci_deploy

# 2. Confirm both are set (lists metadata only, never the value)
gh secret list --repo inblockio/siwx-oidc | grep DEV_STAGING_DEPLOY_KEY
gh secret list --repo inblockio/siwx-oidc-matrix-server | grep DEV_STAGING_DEPLOY_KEY

# 3. Dispatch a test run on each repo's branch that already carries the
#    new workflow (no need to wait for/merge to main — workflow_dispatch
#    works on any branch containing the workflow file, and the deploy job's
#    `if` explicitly allows workflow_dispatch regardless of ref):
gh workflow run docker.yml --repo inblockio/siwx-oidc --ref ci/dev-staging-deploy
gh workflow run docker.yml --repo inblockio/siwx-oidc-matrix-server --ref dev-staging

# 4. Watch it run
gh run watch --repo inblockio/siwx-oidc
gh run watch --repo inblockio/siwx-oidc-matrix-server
```

**Alternative to `gh secret set`** (no PAT restored yet, or prefer the UI):
GitHub web UI → repo → Settings → Secrets and variables → Actions → "New
repository secret" → name `DEV_STAGING_DEPLOY_KEY` → paste the full
contents of `~/.ssh/dev_aquafire_ci_deploy` (the PEM private key, including
the `-----BEGIN/END OPENSSH PRIVATE KEY-----` lines) → Save. Repeat in the
other repo. Same effect as step 1 above.

**What a successful run looks like:** the `deploy-dev-staging` job goes
green, and its "Deploy to dev-staging" step log ends with lines matching:

```
[ci-deploy] pulling images (tags come from .env — IMAGE_TAG and SIWX_OIDC_TAG stay pinned as configured)
[ci-deploy] starting/recreating changed services
[ci-deploy] waiting for services to report healthy (up to 90s)
[ci-deploy] all health-checked services report healthy (or have no healthcheck)
[ci-deploy] compose ps summary:
...
[ci-deploy] smoke check ok: siwx-oidc discovery (https://dev.siwx.inblock.io/.well-known/openid-configuration)
[ci-deploy] smoke check ok: matrix well-known (https://dev.matrix.inblock.io/.well-known/matrix/client)
[ci-deploy] smoke check ok: element web root (https://dev.element.inblock.io/)
[ci-deploy] deployed image digests:
[ci-deploy]   siwx-oidc: ghcr.io/inblockio/siwx-oidc@sha256:...
[ci-deploy]   matrix_synapse: ghcr.io/inblockio/siwx-oidc-matrix-server/synapse@sha256:...
[ci-deploy]   element-web: ghcr.io/inblockio/siwx-oidc-matrix-server/element-web@sha256:...
[ci-deploy] deploy complete
```

A red job (nonzero exit) with no lasting damage is also an acceptable
outcome to debug from — `ci-deploy.sh` never leaves the stack partially
applied beyond what `docker compose up -d` itself guarantees, and the box's
existing containers are untouched until the pull succeeds.

### H6 verification procedure (image digest changes after a CI run)

```bash
# Baseline BEFORE triggering the run — capture the currently-running
# siwx-oidc image digest on the box:
ssh -p 8022 -i ~/.ssh/id_inblock_deploy dev@207.154.209.103 \
  "docker inspect --format='{{.Image}}' matrix-staging-siwx-oidc-1 \
     | xargs docker image inspect --format='{{join .RepoDigests \", \"}}'"

# Trigger (step 3 above), wait for the run to finish green.

# AFTER — re-run the same command. Expect the digest to differ from the
# baseline whenever `main` produced a new image since the last deploy (a
# workflow_dispatch always rebuilds via build-and-push, so in practice the
# digest changes on essentially every dispatched run even without a new
# commit, since the image layers/labels are freshly built).
ssh -p 8022 -i ~/.ssh/id_inblock_deploy dev@207.154.209.103 \
  "docker inspect --format='{{.Image}}' matrix-staging-siwx-oidc-1 \
     | xargs docker image inspect --format='{{join .RepoDigests \", \"}}'"

# Cross-check against what GHCR actually published (from the Actions log
# for the build-and-push job, or):
gh api /orgs/inblockio/packages/container/siwx-oidc/versions --jq \
  '.[0].metadata.container.tags, .[0].name'
```

**H6 status via the pull-model timer: independently satisfiable without the
PAT.** The systemd timer (section above) proves the box-converges-to-newest-
`main` half of H6 on its own: `ci-deploy.sh` pulls `ghcr.io/inblockio/siwx-oidc:main`
by tag every 5 minutes and re-`up -d`s if the resolved digest changed,
verified by a live no-op run (exit 0, unchanged digest, all smoke checks
passed) plus the concurrency/flock test above. A push to `main` that
produces a new image is expected to be picked up within one timer interval;
this is the mechanism actually exercised for T5b's end-to-end H6 check (see
that task's report for the specific before/after digest pair and elapsed
time).

**Push-model (`deploy-dev-staging` CI job) status: PARTIAL, and now
explicitly non-blocking.** The script itself (manual run, box-side, exit 0),
the forced-command key restriction (four negative tests: arbitrary command
ignored, `rm -rf`/`cat /etc/shadow` ignored, port forwarding refused, no
pty), the workflow YAML (parses clean, correct `needs`/`if` gating, and now
the secret-presence guard — see "What's in place" item 4), and port 8022
reachability (ufw: `8022/tcp ALLOW Anywhere` + `Anywhere (v6)`, same port
this doc's own SSH commands use) are all verified. **The one thing NOT
verified is an actual GitHub-Actions-runner-triggered run of this specific
job** — that still requires `DEV_STAGING_DEPLOY_KEY` to exist as a secret,
which requires the currently-invalid `inblockio` PAT. Once the PAT is
restored and the optional steps above are run once, this graduates to a
fully verified secondary path — faster than the timer, but no longer load-
bearing for AC4/H6, which the pull-model timer already carries.

## Process rules (2026-07-31)

Cross-cutting rules distilled from this week's dev-staging work and the
2026-07-31 msc3861/digest incidents (full incident write-up: the sibling
`docs/deployment-recovery-reference.md`, "Incident references" and "Image
pinning policy" sections). These apply beyond this one runbook — to any
promotion or recovery on this stack, dev-staging or prod.

1. **Digests are truth, tags are hints.** All promotion decisions, parity
   checks, and recovery pulls compare/pull image DIGESTS — never verify by
   tag name. Proven necessary, not theoretical: `element-web:sha-4a3d434`
   was observed to resolve to different bytes at two different points this
   week, under the identical tag string (see `29beb88`). A tag, including a
   commit-sha tag, is a label someone (or some CI run) can move; a
   `sha256:` digest is the only thing that names immutable content. Compare
   with `docker buildx imagetools inspect <image>:<tag>` (prints a
   `Digest:` line without pulling) and, for what is actually running,
   `docker inspect --format='{{.Image}}' <container>` piped into
   `docker image inspect --format '{{join .RepoDigests ", "}}'` — never by
   eyeballing the tag string. See `docs/deployment-recovery-reference.md`,
   "Image pinning policy", for the full worked commands.

2. **Promotion gate.** Before anything ships to prod, dev-staging must have
   run the EXACT digest being promoted, verified by the standard battery
   (section 6 above) plus an end-to-end login. "Ran something with the same
   tag name" does not satisfy this gate — see rule 1. **Live since the S5
   branch-based CI deploy change (2026-07-31, §9 "Branch-based CI deploys"):**
   `dev` floats `:dev` continuously on dev-staging for fast iteration, `main`
   floats `:main` for later prod promotion, but the dev→main promotion step
   itself stays a digest comparison, never a tag comparison — proven
   necessary in practice, not just in theory: `siwx-oidc:dev` and
   `siwx-oidc:main`, built from the byte-identical commit `b6c8d63`, resolved
   to two different digests (see §9). Promote by pinning the exact
   dev-validated `sha256:` digests in prod's `.env`, the same way dev-staging
   itself pins `REDIS_IMAGE_REF`/`LK_JWT_IMAGE_REF` — never by pointing prod
   at `:main` and trusting it matches what dev-staging ran.

3. **.env hygiene.** Never `cat`/print a `.env` file anywhere — not in a
   terminal transcript, not in chat, not in a CI log. Two signing-key
   exposures happened THIS WEEK via careless dumps. Verify a key/line is
   present with `grep -c '^KEY_NAME=' .env` (a count, never the content);
   edit with `sed` or a scripted replacement, not an interactive editor
   session that could be screen-shared or logged. Treat any secret that WAS
   printed as burned — rotate it immediately, don't wait to see whether it
   "probably" leaked.

4. **One-way migrations.** Synapse schema migrations do not roll back.
   Snapshot the DB before any version-crossing deploy, on dev-staging as
   well as prod — dev-staging is not exempt just because it is
   disposable-in-theory; in practice it's where the same one-way migration
   gets exercised first, and a broken dev-staging DB still costs a rebuild.

5. **Landmines and timer semantics stay load-bearing — don't let them rot.**
   This rule set sits on top of the box-specific notes already in this doc,
   it does not replace them. In particular:
   - **Landmine 2** (the dormant `aquafier-js` duplicate proxy pair, §0) is
     a standing hazard, not a one-time gotcha: `docker compose` invoked from
     `/home/dev/aquafier-js/deployment/` with an explicit
     `-f docker-compose-dev.yml` still resurrects a second nginx-proxy/acme
     pair that would fight Caddy for 80/443, on this box, today. Any future
     runbook or agent touching that directory must restate this, not assume
     the reader (human or agent) remembers it from here.
   - The **CI timer semantics** in §9 (pull-model
     `matrix-staging-deploy.timer` as PRIMARY convergence mechanism; the
     push-model `deploy-dev-staging` CI job as SECONDARY and dormant without
     `DEV_STAGING_DEPLOY_KEY`) are the current source of truth for "how does
     dev-staging actually converge." Re-verify both still hold — which
     mechanism is primary, whether the secret has since been wired in —
     before relying on either in a future recovery; treat this section as a
     dated snapshot, the same way "Current prod reality" in
     `docs/deployment-recovery-reference.md` is dated.
