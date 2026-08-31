# A/V hardening — config-only backlog from the 2026-08-01 call-incident audit

**Status:** IMPLEMENTED + REVIEWED on `fix/av-hardening-config`; NOT deployed anywhere. Next gate is T10 (dev-staging validation) — see the checklist at the end.
**Scope:** repo `siwx-oidc-matrix-server`, config/deploy files only. No service code. No prod deployment in this pipeline (manual promotion per prod policy).
**Origin:** 2026-08-01 failed-call investigation. Root cause of the incident itself was **client-side** (iOS Element X camera capture); these tasks fix what the audit found around it. Evidence: forensics + config-audit + upstream-source research (see session summary; memory `av-call-incident-2026-08-01`).

## Why now (the time bomb)

Prod runs `ghcr.io/element-hq/lk-jwt-service:latest` resolved to a **pre-2026-06-03 build**: it logs the "defaulting to wildcard (*)" warning, which v0.5.0+ replaced with a **hard startup failure** when `LIVEKIT_FULL_ACCESS_HOMESERVERS` is unset. Consequences:

1. **Today:** wildcard default → any user of any federated homeserver can obtain full-access LiveKit tokens (open-relay exposure, S2).
2. **Any future `docker compose pull` / image prune + `up -d`:** the newer image refuses to boot without the var → **all calling breaks** (C1/C2).

## Hypothesis register

| ID | If | Then | Assumptions | Verification |
|----|----|------|-------------|--------------|
| H1 | `LIVEKIT_FULL_ACCESS_HOMESERVERS: "matrix.inblock.io"` is set and lk-jwt is pinned ≥ v0.5.0 | service boots; local users full access; foreign homeservers denied room-create | server_name is `matrix.inblock.io`; upstream tag available | dev logs the parsed allowlist at startup — `LIVEKIT_FULL_ACCESS_HOMESERVERS: [dev.matrix.inblock.io]`, NOT `[*]` — container stays up (no restart loop), local user's call sets up |
| H2 | lk-jwt + synapse images pinned by tag (digest recorded) | `compose pull` can no longer change call behavior unannounced | pinned tags exist on GHCR/Docker Hub | `docker image inspect` digest matches pin after pull on dev |
| H3 | placeholder `keys:` block deleted from `config/livekit.yaml` | livekit boots and verifies tokens purely from `LIVEKIT_KEYS` (env REPLACES file keys — verified in livekit source) | `LIVEKIT_KEYS` set in all envs | e2e call succeeds; livekit logs no key errors |
| H4 | UDP range moved to 20100–20200 in `livekit.yaml` **and** compose **and** host firewall | media flows on the new range; ephemeral-port squatting hazard gone | firewall change applied on dev before validation; prod at promotion | e2e/dev test call; `ss -ulnp` shows 101 bindings in new range; livekit rtpStats packets > 0 |
| H5 | `/livekit/sfu/twirp/*` blocked for public clients AND lk-jwt's RoomService calls routed internally | public `ListRooms` → 403 while call setup still works | **lk-jwt's hairpin arrives at Caddy with a PRIVATE source address** (no CS-API override exists — see T6; this assumption is not testable off-box and is the single way this change can break calling) | curl twirp from the internet → 403; on the box, lk-jwt's CreateRoom succeeds and Caddy's access log shows a private `remote_ip` for it |
| H6 | SFU route also matches bare `/livekit/sfu` | bare path stops 404ing | Caddy matcher semantics as documented | `curl -w '%{http_code}'` → not 404 |
| H7 | MatrixRTC/rc yq block moved out of the first-boot guard | restarted container re-asserts config; no more manual `yq` after template changes | yq assignments are idempotent (they are) | e2e: remove a key from generated homeserver.yaml, restart, key restored |
| H8 | `element_call.url` removed from `element-config.json` | zero behavior change on EW 1.12.20 (key is not read; widget is bundled, backend comes from `.well-known` rtc_foci) | EW stays on 1.12.x until revisited | dev browser: widget URL is `/widgets/element-call/…`; call connects |

## Tasks

### T1 — lk-jwt-service: explicit access allowlist + pin (C1/C2/S2) — **Hypotheses:** H1, H2
`docker-compose.yml` (lk-jwt-service): add `LIVEKIT_FULL_ACCESS_HOMESERVERS: "matrix.inblock.io"` (verify server_name vs `${MATRIX_HOST}` in env templates); pin `image:` to the newest upstream release tag (record digest in a comment). Document the var in `env.example`/`.env-template`. **Ordering note for every environment: the env var must be present before the pinned image first boots.**

### T2 — Pin Synapse base image (C3) — **Hypotheses:** H2
`dockerfiles/Dockerfile`, `real-stack/Dockerfile.synapse`: `FROM matrixdotorg/synapse:v<currently-running prod version>` — pin to what prod runs today (no accidental upgrade); upgrades become deliberate.

### T3 — livekit.yaml hygiene (C9/S1) — **Hypotheses:** H3
Delete the `keys: placeholder:` block from `config/livekit.yaml` (matching `livekit.e2e.yaml`); confirm no `development: true` anywhere.

### T4 — Move UDP media range out of the ephemeral range (C6) — **Hypotheses:** H4
`config/livekit.yaml` + `docker-compose.yml`: 50100–50200 → 20100–20200 (matching e2e). Execution includes opening 20100:20200/udp on the **dev** firewall before validation. Prod firewall change goes into the promotion runbook only.

### T5 — Caddy: block public Twirp + fix bare SFU path (S3, latent-404) — **Hypotheses:** H5, H6 — *lands together with T6*
`Caddyfile.production` (+ `.e2e`/`.local` parity): 403 `/livekit/sfu/twirp/*` for non-internal clients; make the SFU route match bare `/livekit/sfu` as well (LiveKit's Twirp management API shares port 7880 with signaling, JWT-only auth, no upstream disable flag — proxy block is the only mitigation).

### T6 — Route lk-jwt's RoomService calls internally (C7) — **Hypotheses:** H5
**Outcome: NOT POSSIBLE at v0.5.0 — fallback taken.** `LIVEKIT_URL` is the only
LiveKit-facing URL the binary has; it is both the client-facing SFU URL and the
endpoint of the server-side RoomService client, and no released version exposes an
override for the latter (`LIVEKIT_CS_API_URL_OVERRIDES` on `main` is the Matrix
CS-API, not LiveKit). Pointing it at `http://livekit:7880` would fix the hairpin
and break every client. So `LIVEKIT_URL` stays public and T5's Twirp block is
scoped to non-private `remote_ip` instead of an unconditional 403.

**This leaves ONE unverifiable assumption, and it gates promotion.** The 403 is
correct only if lk-jwt's hairpin (container → public DNS name → back into the same
host → Caddy) presents a private source address to Caddy. Docker's NAT normally
makes it so, but a floating/anchor IP or an egress path that leaves and re-enters
the network would present a public one — and then **full-access room creation
starts 403ing and calls break**. It cannot be tested off-box. **MANDATORY on
dev-staging before any prod promotion:** start a call as a local user, confirm
lk-jwt's CreateRoom succeeds, and confirm the `remote_ip` Caddy saw for that Twirp
request is private. If it is public, the block must become path/method-scoped or
move to an `extra_hosts` + internal-listener arrangement before promotion.

### T7 — Re-assert Synapse MatrixRTC config on every boot (C5) — **Hypotheses:** H7
`entrypoints/matrix_server.sh`: move the MatrixRTC/msc/rc yq block out of the `if [ ! -f /data/homeserver.yaml ]` guard into an always-run idempotent section. (Prod values are live today; this prevents the documented recurrence where template changes silently never apply.)

### T8 — element-config cleanup (C4-phantom) — **Hypotheses:** H8
Remove `element_call.url` from `config/element-config.json` (no-op at EW 1.12.20, prevents a future version silently loading the third-party widget). Keep `use_exclusively: true`.

### T9 — livekit healthcheck + dependency (C10) — no hypothesis, quality
Compose: HTTP healthcheck on livekit 7880; add `livekit` to lk-jwt-service `depends_on`.

### T10 — Validation gate (dev-staging + e2e)
1. Local hermetic e2e harness run (`e2e-harness/up.sh`) green.
2. Dev-staging: apply config to the dev stack (stack dir is **not** a git checkout — configs are scp'd/bind-mounted), open dev firewall for the new UDP range, converge, then run the checklist below.
3. Only then: write the prod promotion runbook (digest pin, env-var-before-pull ordering, UFW change, verification curls). **Prod deployment itself is manual and out of scope.**

## Review status (2026-08-01, review lead)

Verified locally during review — no dev-staging evidence needed:

- **H2 (lk-jwt half):** GHCR tag `0.5.0` resolves to `sha256:29918567…`; `v0.5.0` does not exist as a tag. Same digest as `latest` today, so the pin is byte-identical to what prod runs.
- **H1 (startup half):** the pinned digest exits immediately with `LIVEKIT_FULL_ACCESS_HOMESERVERS environment variable must be set` when the var is absent, and echoes the parsed list at startup when present. The old "wildcard warning" is gone at this version, so its *absence* proves nothing — check the echoed value instead.
- **H3:** livekit v1.12.0 boots clean from the `keys:`-less `config/livekit.yaml` with only `LIVEKIT_KEYS` in the env.
- **H4 (config half):** the same boot logs `rtc.portICERange [20100, 20200]`. The firewall/media half is still live-only.
- **H5 (Caddy half) + H6:** `caddy validate` passes on all three Caddyfiles; the adapted JSON puts `/livekit/sfu/twirp/*` ahead of `/livekit/sfu/*` in one mutually-exclusive group, and `private_ranges` expands to 10/8, 172.16/12, 192.168/16, 127.0.0.1/8, fd00::/8, ::1. Live-served: bare `/livekit/sfu` reaches the upstream as `/` (it is NOT matched by `/livekit/sfu/*`), twirp paths strip correctly, and the `remote_ip` matcher fires as expected in both directions. What remains unverifiable is only H5's source-address assumption (T6).
- **T9:** the healthcheck command works against the real image; LiveKit answers `406` on `GET /` until its first node-stats tick (~8s from container start, mostly the `use_external_ip` STUN lookup), then `200 OK`. `start_period: 30s` covers it.

Scope added during review (defects found against the plan):

- `docker-compose.dev-staging.yml` mounts the SAME `config/livekit.yaml` but still published `50100-50200/udp` — that alone would have killed media on the box the validation gate runs on. Given the same pin, healthcheck and `depends_on` as production so dev validates what prod will run.
- `docker-compose.e2e.yml` published `50100-50200/udp` against a `20100-20200` config (pre-existing drift; the live `up.sh` path was already correct).
- Stale `50100-50200` in `CLAUDE.md`, `skills/matrix-rtc-transport-specialist.md` (which also still taught the `keys:` placeholder) and the dev-aquafire ufw runbook.

Known, deliberately not fixed here:

- `e2e-harness/up.sh` still runs `lk-jwt-service:latest` unpinned with `LIVEKIT_FULL_ACCESS_HOMESERVERS="*"`. Harmless in a hermetic single-homeserver harness, but it means the harness does not exercise the pinned binary. Pinning it invalidates any earlier green run, so it belongs with the next harness run, not this diff.
- `docker-compose.local.yml` has no `livekit`/`lk-jwt-service` service at all, so `Caddyfile.local`'s `/livekit/*` routes (old and new) point at upstreams that do not exist there. Pre-existing.
- **T7 reaches a deployed box only through a rebuilt Synapse image.** `entrypoints/matrix_server.sh` is baked in at build time, so the re-assert does nothing until the synapse image is rebuilt and its digest promoted.

## Dev-staging validation checklist

Executed 2026-08-01 (validation lead) on dev-aquafire. Verdict: **9 PASS, 1 PARTIAL, 0 FAIL.**

- [x] `ufw allow 20100:20200/udp` applied BEFORE converging; old 50100 rule left until calls pass. **PASS** — added additively at 19:17Z, `50100:50200/udp` deleted only after the media checks below.
- [x] lk-jwt logs `LIVEKIT_FULL_ACCESS_HOMESERVERS: [dev.matrix.inblock.io]` and is not restart-looping. **PASS** — `LIVEKIT_FULL_ACCESS_HOMESERVERS: [dev.matrix.inblock.io]`, `RestartCount=0`.
- [x] `docker image inspect` digests match the pins. **PASS** — lk-jwt `sha256:29918567…`, synapse `sha256:67b27c4e…` (`:dev`, built from the dev merge, created 19:13:35Z).
- [x] livekit `healthy` and lk-jwt started after it. **PASS** — converge order `livekit Healthy` → `lk-jwt-service Starting`.
- [x] `ss -ulnp` across 20100-20200, nothing on 50100-50200; media packets > 0. **PASS** — 101 UDP listeners on 20100-20200, 0 on 50100-50200; `lk perf load-test` through `wss://dev.matrix.inblock.io/livekit/sfu`: audio 750 pkts @ 20.9kbps, video 2040 pkts @ 1.2mbps, 0% loss; selected publisher candidate `udp4 host 207.154.209.103:20199`. Caveat: the test client ran ON the box, so the DNAT + range are proven but no off-box UDP source was used.
- [x] **Twirp hairpin (T6, gates promotion).** **PASS on dev** — a real lk-jwt `POST /livekit/jwt/sfu/get` (Matrix OpenID token from a throwaway `did:key` login) returned a full-access JWT, and the Caddy access log shows its `CreateRoom` as `remote_ip: 172.18.0.1` (the Docker bridge gateway — PRIVATE) with `status: 200`. Same log window: the off-box `ListRooms` shows `remote_ip: 95.90.182.63` (public) → `403`. **This does NOT transfer to prod** — re-run it there before trusting the block (prod's floating/anchor IP is exactly the failure mode; see the runbook).
- [x] off-box `ListRooms` → 403. **PASS** — `status=403`, empty body.
- [x] bare `https://dev.matrix.inblock.io/livekit/sfu` → 200. **PASS** — `status=200` (control: `/livekit/sfu/rtc/validate` → 401, i.e. it still reaches the SFU).
- [x] entrypoint re-asserts the MatrixRTC block after a restart. **PASS** — `rc_message` deleted from the live `/data/homeserver.yaml` (copy-edit-`docker cp` back, original backed up in-container), `docker restart` → healthy → `rc_message: {per_second: 0.5, burst_count: 30}` present again.
- [ ] Element browser check (H8). **PARTIAL** — served `config.json` has no `element_call.url` (the `branding` block survives), the bundled widget is served (`/widgets/element-call/index.html` → 200), `.well-known` still advertises `livekit_service_url: https://dev.matrix.inblock.io/livekit/jwt`, and headless Chromium boots Element cleanly through to the siwx-oidc sign-in page. NOT verified: an in-browser click producing a `/widgets/element-call/…` widget URL and a connected call — that needs an interactive wallet/passkey login.

Drift found and fixed during validation: the dev box's bind-mounted `config/element-config.json` still carried `element_call.url` (it is scp'd separately from the images, so T8 does not reach a box by merging alone). Applied from the merged `dev` branch file, preserving the box's welcome-branding block.

Infrastructure finding (affects how much the UFW step is worth): `DOCKER-USER` is empty on dev, so ufw does NOT filter docker-published ports — media reaches 20100-20200 through the FORWARD/DNAT path regardless of the ufw rule. The rule is defence-in-depth and documentation, not the thing that opens the range. Expect the same on prod; do not read a green call as proof the firewall rule worked.

## Prod promotion runbook (NOT executed — manual, deliberate)

Written 2026-08-01 by the validation lead after the dev-staging gate above.
Nothing here has been run against prod. Prod is `deploy@142.93.168.4`
(`agentic.inblock.io`); stack dir `/home/deploy/matrix/stack/` (compose + `.env`
only, no git checkout); edge is `portal-caddy-1` with the **bind-mounted**
`/home/portal/portal/Caddyfile`.

**Read first — three prod-specific traps.**

1. **`deploy.sh` APPENDS Caddy blocks.** `deploy.sh` step [3/4] does
   `grep -q "matrix.inblock.io" "$CADDYFILE" || cat >> "$CADDYFILE"` with a
   hard-coded 2024-era vhost body (no `/livekit/*` routes, no MSC4143 rtc_foci
   in `.well-known`). It is skipped only because the string is already present.
   Never let it run against a Caddyfile that has been repaired by hand, and
   never "clean up" the existing block hoping deploy.sh will re-add a good one —
   it will append a WORSE one.
2. **Never `mv` or `sed -i` the portal Caddyfile.** It is bind-mounted into
   `portal-caddy-1`; `mv`/`sed -i` replace the inode and the container keeps
   reading the old file (or an empty one). Always: back up, write a NEW file
   elsewhere, `cp` it over the original (preserving the inode), validate, reload.
3. **Ordering: `LIVEKIT_FULL_ACCESS_HOMESERVERS` must exist BEFORE the pinned
   lk-jwt image first boots.** v0.5.0 exits at startup without it. In this diff
   the var lives in `docker-compose.yml` (`${MATRIX_HOST}`), so it arrives with
   the compose file — copy compose BEFORE `pull`/`up -d`, and confirm
   `MATRIX_HOST` in prod's `.env` equals Synapse's `server_name`
   (`matrix.inblock.io`), or local users lose full access.

### 0. Pre-flight (record the rollback target)

```bash
ssh deploy@142.93.168.4
cd /home/deploy/matrix/stack
TS=$(date +%Y%m%d-%H%M)
docker compose ps
docker inspect $(docker compose ps -q lk-jwt-service) --format '{{.Image}}'
docker compose images                     # record every digest, this is the rollback target
sudo ufw status numbered
grep -c '^MATRIX_HOST=matrix.inblock.io$' .env      # want 1
docker compose exec -T matrix_synapse grep -E '^(server_name|rc_message)' /data/homeserver.yaml
cp -p docker-compose.yml docker-compose.yml.bak-$TS
cp -p .env .env.bak-$TS
cp -p config/livekit.yaml config/livekit.yaml.bak-$TS
cp -p config/element-config.json config/element-config.json.bak-$TS
sudo cp -p /home/portal/portal/Caddyfile /home/portal/portal/Caddyfile.bak-$TS
```

### 1. Firewall (additive; keep the old rule)

```bash
sudo ufw allow 20100:20200/udp comment 'livekit media (new range)'
sudo ufw status numbered            # both ranges present now
sudo iptables -S DOCKER-USER        # if empty, ufw does NOT filter docker-published
                                    # ports — the rule is defence-in-depth only
```
Do **not** delete `50100:50200/udp` until step 6's media check passes. Also check
the DigitalOcean cloud firewall for the droplet (dev-aquafire has none; prod was
**not verified** by this pipeline — if a cloud firewall exists it must allow
20100-20200/udp too, and that is invisible from inside the box).

### 2. Configs (copy, never `mv`; `livekit.yaml` and `element-config.json` are bind-mounted)

From the workstation, with `fix/av-hardening-config` merged to `main`:

```bash
scp docker-compose.yml       deploy@142.93.168.4:/home/deploy/matrix/stack/.staging-compose.yml
scp config/livekit.yaml      deploy@142.93.168.4:/home/deploy/matrix/stack/.staging-livekit.yaml
scp config/element-config.json deploy@142.93.168.4:/home/deploy/matrix/stack/.staging-element.json
```
On the box (backups from step 0 already exist):
```bash
cd /home/deploy/matrix/stack
cp .staging-compose.yml  docker-compose.yml
cp .staging-livekit.yaml config/livekit.yaml
cp .staging-element.json config/element-config.json     # diff FIRST — prod may carry
                                                        # branding/host edits not in git
docker compose config >/dev/null && echo "compose parses"
```
`config/element-config.json` is the one file most likely to have hand-applied
prod-only content: `diff` it against the repo copy and hand-merge rather than
blind-overwrite (this exact drift bit dev — see the checklist note).

### 3. Portal Caddyfile (the bind-mount procedure)

```bash
sudo cp -p /home/portal/portal/Caddyfile /tmp/Caddyfile.work
# edit /tmp/Caddyfile.work: inside the matrix.inblock.io site block, replace the
# single `handle_path /livekit/sfu/*` with the three blocks from
# Caddyfile.production (@livekit_twirp_public + handle /livekit/sfu/twirp/*,
# handle_path /livekit/sfu, handle_path /livekit/sfu/*), in that order.
grep -n 'livekit' /tmp/Caddyfile.work            # sanity: twirp block precedes the wildcard
sudo cp /tmp/Caddyfile.work /home/portal/portal/Caddyfile    # cp, NOT mv — keeps the inode
# portal-caddy-1 is not part of this stack's compose project, so resolve by
# name filter (Docker renames on a name conflict) rather than trust the literal.
CADDY_CID="$(docker ps -q --filter name=portal-caddy | head -1)"
docker exec "${CADDY_CID:-portal-caddy-1}" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "${CADDY_CID:-portal-caddy-1}" caddy reload  --config /etc/caddy/Caddyfile
```
Duplication check before editing: `grep -c 'matrix.inblock.io {' /home/portal/portal/Caddyfile`
must be 1. If deploy.sh ever appended a second block, fix that first — Caddy
merges duplicate site blocks and the routing becomes unreadable.

### 4. Images (digest-pinned; T7 needs the REBUILT synapse)

Prod runs digest-pinned refs. Update `.env` image refs to the digests validated
on dev (lk-jwt `sha256:29918567…` — same bytes as today's `latest`, only the tag
label changes; synapse to the new `main` build that carries the
`apply_matrixrtc_config` entrypoint — **T7 does nothing until that image is
promoted**):

```bash
cd /home/deploy/matrix/stack
sed 's|^LK_JWT_IMAGE_REF=.*|LK_JWT_IMAGE_REF=ghcr.io/element-hq/lk-jwt-service:0.5.0@sha256:29918567e6b7cd920e2853b4cd6848ce01b79947c3d19a9f1ed5b74f0a2a88bf|' .env > .env.new
cp .env.new .env && rm .env.new && chmod 600 .env      # cp, not mv
docker compose pull
docker compose up -d
docker compose ps                                       # livekit healthy, lk-jwt after it
```

### 5. Verification (each one is a gate)

```bash
# lk-jwt booted with an EXPLICIT allowlist, no restart loop
docker logs --tail 5 $(docker compose ps -q lk-jwt-service)   # LIVEKIT_FULL_ACCESS_HOMESERVERS: [matrix.inblock.io]
docker inspect $(docker compose ps -q lk-jwt-service) --format '{{.RestartCount}}'   # 0

# media range moved, old range empty
sudo ss -ulnp | grep -cE ':201[0-9][0-9]\b'      # 101
sudo ss -ulnp | grep -cE ':50[12][0-9][0-9]\b'   # 0

# entrypoint re-assert (only meaningful on the rebuilt image)
docker compose exec -T matrix_synapse grep -c apply_matrixrtc_config /matrix_server.sh   # >0
```
From OFF the box:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://matrix.inblock.io/livekit/sfu/twirp/livekit.RoomService/ListRooms      # 403
curl -s -o /dev/null -w '%{http_code}\n' https://matrix.inblock.io/livekit/sfu   # 200 (was 404)
curl -s https://matrix.inblock.io/.well-known/matrix/client | jq '.["org.matrix.msc4143.rtc_foci"]'
curl -s https://element.inblock.io/config.json | jq '.element_call'              # no "url" key
```

**The prod-specific gate — re-run the hairpin check here.** The dev result
(`remote_ip 172.18.0.1`, private) does **not** transfer: prod has a
floating/anchor IP, which is precisely the arrangement that would make lk-jwt's
hairpin arrive with a PUBLIC source address and start 403ing full-access room
creation. Prod's Caddy has **no access log**, so add one temporarily using the
same bind-mount procedure as step 3 (`log { output stdout \n format json }`
inside the `matrix.inblock.io` block), then:

1. Start a real call as a local user (or replay the dev method: register an OIDC
   client, authenticate a throwaway `did:key` with `siwx-oidc-auth`, mint a
   Matrix OpenID token via `POST /_matrix/client/v3/user/{mxid}/openid/request_token`,
   `POST /livekit/jwt/sfu/get`). Deactivate the throwaway account afterwards.
2. Resolve the Caddy container and tail its log (`CID=$(docker ps -q --filter
   name=portal-caddy | head -1); docker logs --since 5m "${CID:-portal-caddy-1}"
   | grep CreateRoom`) — the request must show a PRIVATE `remote_ip` and
   `status: 200`.
3. If it is PUBLIC: **roll back the Caddy change immediately** (step 7) and
   re-scope the block (method/path-scoped, or `extra_hosts` + an internal
   listener) before retrying. Calling is broken while it is public.

Only after the media check passes:
```bash
sudo ufw delete allow 50100:50200/udp
```

### 6. Post-checks
`docker compose ps` all healthy · a real Element Web call connects with audio and
video · `docker compose logs matrix_synapse | grep -i cross-signing` clean ·
`scripts/element-deploy-audit.sh` still 21/0.

### 7. Rollback (any step, in reverse)

```bash
cd /home/deploy/matrix/stack
cp docker-compose.yml.bak-$TS docker-compose.yml
cp config/livekit.yaml.bak-$TS config/livekit.yaml
cp config/element-config.json.bak-$TS config/element-config.json
cp .env.bak-$TS .env && chmod 600 .env
docker compose up -d                              # back to the recorded digests
sudo cp /home/portal/portal/Caddyfile.bak-$TS /home/portal/portal/Caddyfile   # cp, not mv
CADDY_CID="$(docker ps -q --filter name=portal-caddy | head -1)"
docker exec "${CADDY_CID:-portal-caddy-1}" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "${CADDY_CID:-portal-caddy-1}" caddy reload  --config /etc/caddy/Caddyfile
sudo ufw allow 50100:50200/udp comment 'livekit media (rollback)'
sudo ufw delete allow 20100:20200/udp
```
The Caddy revert alone is enough to un-break calling if the hairpin turns out
public — it is the only change in this set that can break a working call
(the media-range move is the other; it reverts with the compose + livekit.yaml
pair, which must move together).

## Boundary conditions
- Work in a fresh git worktree off `main`; do not touch the dirty `fix/4s-tombstone-probe` checkout.
- Config/deploy files only; no service source code.
- Nothing is applied to prod by this pipeline. Dev-staging changes are reversible and coordinated (firewall additions additive).
- Never `mv`/`sed -i` the bind-mounted portal Caddyfile on prod (promotion runbook must respect this).
- Out of scope: TURN/coturn for legacy VoIP (legacy is disabled via `use_exclusively`), LiveKit embedded TURN enablement (needs 443/5349 planning — record as future work), the mis-nested Synapse retention block (separate known issue, needs Tim's intent), apex-domain `.well-known` 404, focus_selection interop divergence (upstream, tracking only).

## 2026-08-02 addendum

The T10 checklist's 1-PARTIAL result (Element browser check, H8) is now explained: it wasn't a gap in that check, it was validating the wrong layer. On-box/synthetic test calls ride the private docker-bridge path end to end, which masks a separate, more serious defect — LiveKit being multi-homed (compose-default net + shared proxy net) and advertising the private proxy-net IP as if it were an external ICE candidate, so a *real* external client's ICE selection can pick the unreachable candidate and get zero media even though the server side looks perfectly healthy. This was root-caused and fixed (dev-staging, validated live) on 2026-08-02; see `docs/superpowers/plans/2026-08-02-video-call-audit.md` for the full hypothesis register, the fix (`config/livekit.yaml` `rtc.ips.excludes`), and the prod promotion addendum.
