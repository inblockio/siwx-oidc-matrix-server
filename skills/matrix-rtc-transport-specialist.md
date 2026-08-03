---
name: matrix-rtc-transport-specialist
description: Use when enabling video/audio calls (Element Call, MatrixRTC, LiveKit) in the siwx-oidc-matrix-server stack, or diagnosing MISSING_MATRIX_RTC_TRANSPORT / MISSING_MATRIX_RTC_FOCUS errors. Triggers on "calls", "video", "audio", "Element Call", "LiveKit", "RTC", "MISSING_MATRIX_RTC_TRANSPORT".
---

# matrix-rtc-transport-specialist: Enable Element Call (MatrixRTC + LiveKit)

## Problem

Element Web / Element X shows:
> "The server is not configured to work with Element Call.
> (Error Code: MISSING_MATRIX_RTC_TRANSPORT)"

The client calls `GET /_matrix/client/v1/rtc/transports` (or the unstable prefix
`/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`), and Synapse returns
404 / `M_UNRECOGNIZED` because MSC4143 is not enabled and no `matrix_rtc` block
is configured.

## Root cause

MatrixRTC requires a **LiveKit SFU** (Selective Forwarding Unit). There is no
working peer-to-peer/native transport; the full-mesh code is deprecated and
unmaintained. LiveKit is the only implemented transport type.

## Architecture

```
Element Web
   |
   |  1. GET /.well-known/matrix/client  (discovers rtc_foci -> livekit_service_url)
   |  2. POST /livekit/jwt               (sends Matrix OpenID token, gets LiveKit JWT)
   |  3. WSS  /livekit/sfu/              (WebSocket signaling to LiveKit)
   |  4. UDP  :20100-20200               (WebRTC media, direct to host)
   v
Caddy (reverse proxy)
   |           |              |
   v           v              v
Synapse    lk-jwt-service   LiveKit SFU
           (validates        (routes
            Matrix OIDC       media)
            tokens, issues
            LiveKit JWTs)
```

### Authentication flow

1. Element obtains a Matrix **OpenID token** from Synapse
2. Element sends the OpenID token to **lk-jwt-service** at `/livekit/jwt`
3. lk-jwt-service validates the token against Synapse
4. lk-jwt-service returns a **LiveKit JWT** (signed with shared LIVEKIT_KEY/LIVEKIT_SECRET)
5. Element connects to the **LiveKit SFU** via WebSocket using the JWT
6. LiveKit routes audio/video media between participants via UDP

## Required MSCs (Synapse experimental_features)

| MSC | Purpose | Config key |
|---|---|---|
| MSC4143 | MatrixRTC core: exposes `/rtc/transports` endpoint | `msc4143_enabled: true` |
| MSC4140 | Delayed events: auto-cleans interrupted calls | via `max_event_delay_duration` |
| MSC4222 | `state_after` in sync v2: correct room state tracking | `msc4222_enabled: true` |
| MSC3266 | Room Summary API: federation knocking | `msc3266_enabled: true` |

## New services (docker-compose.yml)

Two new services are added to `docker-compose.yml`:

```yaml
livekit:
  image: livekit/livekit-server:v1.12.0   # pin; do not use :latest (deploy pulls would jump SFU versions)
  restart: unless-stopped
  command: --config /etc/livekit.yaml
  ports:
    - "7881:7881/tcp"
    - "20100-20200:20100-20200/udp"
  volumes:
    - ./config/livekit.yaml:/etc/livekit.yaml:ro
  networks:
    - portal-net
    - default

lk-jwt-service:
  image: ghcr.io/element-hq/lk-jwt-service:latest
  restart: unless-stopped
  environment:
    LIVEKIT_URL: "wss://${MATRIX_HOST}/livekit/sfu"
    LIVEKIT_KEY: "${LIVEKIT_KEY}"
    LIVEKIT_SECRET: "${LIVEKIT_SECRET}"
    LIVEKIT_JWT_BIND: ":8080"
    LIVEKIT_INSECURE_SKIP_VERIFY_TLS: "${LIVEKIT_INSECURE_SKIP_VERIFY_TLS:-false}"
  depends_on:
    matrix_synapse:
      condition: service_healthy
  networks:
    - portal-net
    - default
```

**Note:** lk-jwt-service uses a scratch/distroless image with no shell, wget, or
curl. Do not add a Docker healthcheck; monitor via Caddy route (`/livekit/jwt/healthz`).

### Why these port choices

- **7881/tcp**: LiveKit WebRTC-over-TCP fallback (for clients behind strict UDP firewalls)
- **20100-20200/udp**: WebRTC media. Must sit BELOW the Linux ephemeral range
  (32768-60999) or the host's own outbound sockets can squat the ports the SFU
  needs — the stack was on 50100-50200 until 2026-08-01 for exactly that reason.
  Keep the range small (100 ports); Docker creates individual iptables rules per
  port, and large ranges cause slow container startup. 100 ports supports ~50
  concurrent participants.
- **7880** is NOT exposed to host; Caddy proxies it internally via Docker network.

## New file: config/livekit.yaml

```yaml
port: 7880
bind_addresses:
  - "0.0.0.0"
rtc:
  tcp_port: 7881
  port_range_start: 20100
  port_range_end: 20200
  use_external_ip: true
  # If the LiveKit container is attached to more than one docker network (e.g.
  # a compose-default net PLUS a shared reverse-proxy net so Caddy can reach
  # :7880), STUN can succeed on one interface and fail with "context canceled"
  # on the other — and LiveKit then advertises the OTHER network's private IP
  # as if it were external. Exclude that subnet so it's never offered as an
  # ICE candidate. See the troubleshooting entry below ("call connects, zero
  # media").
  ips:
    excludes:
      - "172.18.0.0/16"
room:
  auto_create: false
logging:
  level: info
turn:
  enabled: false
```

No `keys:` block: `LIVEKIT_KEYS` in the environment replaces file keys entirely,
so a placeholder here is dead config that only invites someone to trust it.

**Note:** The `keys` section uses placeholder values. The entrypoint or start-matrix.sh
must template the actual `LIVEKIT_KEY` and `LIVEKIT_SECRET` into this file, or use
environment variables `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` which override
the config file.

### Generating LiveKit credentials

```bash
LIVEKIT_KEY="API$(openssl rand -hex 8)"
LIVEKIT_SECRET="$(openssl rand -base64 32)"
```

These go into `.env` and must match between lk-jwt-service and LiveKit.

## Changes to existing files

### 1. entrypoints/matrix_server.sh (first-boot block)

Add after the MSC4108 line:

```bash
# MatrixRTC: enable experimental features for Element Call
yq -i ".experimental_features.msc4143_enabled = true" /data/homeserver.yaml
yq -i ".experimental_features.msc3266_enabled = true" /data/homeserver.yaml
yq -i ".experimental_features.msc4222_enabled = true" /data/homeserver.yaml

# Delayed events (MSC4140): auto-quit interrupted calls
yq -i ".max_event_delay_duration = \"24h\"" /data/homeserver.yaml

# Rate limiting for call heartbeats (every 5s per participant)
yq -i ".rc_delayed_event_mgmt.per_second = 1" /data/homeserver.yaml
yq -i ".rc_delayed_event_mgmt.burst_count = 20" /data/homeserver.yaml

# Rate limiting for in-call E2EE key sharing (bursty room messages); values from
# Element Call docs/self_hosting.md. Synapse defaults (0.2/10) can rate-limit calls.
yq -i ".rc_message.per_second = 0.5" /data/homeserver.yaml
yq -i ".rc_message.burst_count = 30" /data/homeserver.yaml

# MatrixRTC transport: LiveKit SFU
yq -i ".matrix_rtc.transports[0].type = \"livekit\"" /data/homeserver.yaml
yq -i ".matrix_rtc.transports[0].livekit_service_url = \"https://${MATRIX_HOST}/livekit/jwt\"" /data/homeserver.yaml
```

### 2. Caddyfile.production

Add `org.matrix.msc4143.rtc_foci` to the `.well-known/matrix/client` response:

```
handle /.well-known/matrix/client {
    header Access-Control-Allow-Origin *
    respond `{"m.homeserver": {"base_url": "https://matrix.inblock.io"}, "m.authentication": {"issuer": "https://siwx-oidc.inblock.io"}, "org.matrix.msc4143.rtc_foci": [{"type": "livekit", "livekit_service_url": "https://matrix.inblock.io/livekit/jwt"}]}`
}
```

Add LiveKit proxy routes (before the catch-all `handle`):

```
# MatrixRTC: lk-jwt-service (OpenID -> LiveKit JWT exchange)
handle_path /livekit/jwt {
    reverse_proxy lk-jwt-service:8080
}
handle_path /livekit/jwt/* {
    reverse_proxy lk-jwt-service:8080
}

# MatrixRTC: LiveKit SFU WebSocket signaling
handle_path /livekit/sfu/* {
    reverse_proxy livekit:7880
}
```

### 3. Caddyfile.local

Same pattern but with `localhost` URLs:

```
handle /.well-known/matrix/client {
    header Access-Control-Allow-Origin *
    respond `{"m.homeserver": {"base_url": "http://localhost:8080"}, "m.authentication": {"issuer": "http://localhost:8081"}, "org.matrix.msc4143.rtc_foci": [{"type": "livekit", "livekit_service_url": "http://localhost:8080/livekit/jwt"}]}`
}

handle_path /livekit/jwt {
    reverse_proxy lk-jwt-service:8080
}
handle_path /livekit/jwt/* {
    reverse_proxy lk-jwt-service:8080
}
handle_path /livekit/sfu/* {
    reverse_proxy livekit:7880
}
```

### 4. config/element-config.json

Add Element Call configuration:

```json
{
  "default_server_config": {
    "m.homeserver": {
      "base_url": "%%MATRIX_BASE_URL%%",
      "server_name": "%%MATRIX_HOST%%"
    }
  },
  "disable_custom_urls": true,
  "disable_guests": true,
  "disable_login_language_selector": true,
  "brand": "inblock.io Chat",
  "element_call": {
    "url": "https://call.element.io",
    "use_exclusively": true,
    "brand": "inblock.io Call"
  },
  "features": {
    "feature_group_calls": true,
    "feature_video_rooms": true,
    "feature_element_call_video_rooms": true
  }
}
```

`use_exclusively: true` disables legacy 1:1 calls and Jitsi; all calls go
through MatrixRTC. This is correct because the stack has no Jitsi or TURN
for legacy calls.

### 5. .env.example

Add new variables:

```bash
#--- LiveKit (MatrixRTC / Element Call) ---
# [auto] API key for LiveKit SFU (generated by start-matrix.sh):
# LIVEKIT_KEY=API<random>
# [auto] Shared secret between lk-jwt-service and LiveKit (generated by start-matrix.sh):
# LIVEKIT_SECRET=<random-base64>
# Skip TLS verification for lk-jwt-service -> Synapse OpenID validation (local dev only):
# LIVEKIT_INSECURE_SKIP_VERIFY_TLS=true
```

### 6. start-matrix.sh

Add LiveKit credential generation (alongside existing SIWEOIDC_SIGNING_KEY_PEM generation):

```bash
if ! grep -q '^LIVEKIT_KEY=' .env 2>/dev/null; then
  LIVEKIT_KEY="API$(openssl rand -hex 8)"
  LIVEKIT_SECRET="$(openssl rand -base64 32)"
  echo "LIVEKIT_KEY=${LIVEKIT_KEY}" >> .env
  echo "LIVEKIT_SECRET=${LIVEKIT_SECRET}" >> .env
fi
```

### 7. config/livekit.yaml templating

The `LIVEKIT_KEY` and `LIVEKIT_SECRET` values must be injected into
`config/livekit.yaml` at container start. Two approaches:

**The correct env var is `LIVEKIT_KEYS`** (not `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`,
which are client SDK vars). Format: YAML key-value string.

```yaml
environment:
  LIVEKIT_KEYS: "${LIVEKIT_KEY}: ${LIVEKIT_SECRET}"
```

This overrides the `keys:` section in the YAML config.

## Existing deployment considerations

### First-boot vs. existing deployments

The `entrypoints/matrix_server.sh` changes only run on **first boot** (when
`/data/homeserver.yaml` does not exist). For existing deployments (where
homeserver.yaml already exists), apply the Synapse config manually:

```bash
SSH_CMD="ssh -i ~/.ssh/id_ed25519 root@agentic.inblock.io"

$SSH_CMD "cd /home/matrix/stack && docker compose exec matrix_synapse sh -c '
  yq -i \".experimental_features.msc4143_enabled = true\" /data/homeserver.yaml &&
  yq -i \".experimental_features.msc3266_enabled = true\" /data/homeserver.yaml &&
  yq -i \".experimental_features.msc4222_enabled = true\" /data/homeserver.yaml &&
  yq -i \".max_event_delay_duration = \\\"24h\\\"\" /data/homeserver.yaml &&
  yq -i \".rc_delayed_event_mgmt.per_second = 1\" /data/homeserver.yaml &&
  yq -i \".rc_delayed_event_mgmt.burst_count = 20\" /data/homeserver.yaml &&
  yq -i \".rc_message.per_second = 0.5\" /data/homeserver.yaml &&
  yq -i \".rc_message.burst_count = 30\" /data/homeserver.yaml &&
  yq -i \".matrix_rtc.transports[0].type = \\\"livekit\\\"\" /data/homeserver.yaml &&
  yq -i \".matrix_rtc.transports[0].livekit_service_url = \\\"https://matrix.inblock.io/livekit/jwt\\\"\" /data/homeserver.yaml
'"

$SSH_CMD "cd /home/matrix/stack && docker compose restart matrix_synapse"
```

### Firewall

The production server must allow:

| Port | Protocol | Purpose |
|---|---|---|
| 7881 | TCP | LiveKit WebRTC-over-TCP fallback |
| 20100-20200 | UDP | WebRTC media (audio/video) |

These are in addition to existing ports (22, 80, 443, 8448).

### Synapse version

Synapse v1.140.0+ is required for `matrix_rtc` config and `/rtc/transports`.
The stack uses `matrixdotorg/synapse:latest`, which satisfies this. If pinning
versions, ensure >= 1.140.0.

## Verification checklist

After deployment, verify each component:

```bash
# 1. .well-known includes rtc_foci
curl -sf https://matrix.inblock.io/.well-known/matrix/client | jq '.["org.matrix.msc4143.rtc_foci"]'
# Expected: [{"type":"livekit","livekit_service_url":"https://matrix.inblock.io/livekit/jwt"}]

# 2. Synapse exposes /rtc/transports (requires auth)
# Get a valid access token first, then:
curl -sf -H "Authorization: Bearer $TOKEN" \
  https://matrix.inblock.io/_matrix/client/v1/rtc/transports | jq .
# Expected: {"transports":[{"type":"livekit","livekit_service_url":"..."}]}

# 3. lk-jwt-service is healthy
curl -sf https://matrix.inblock.io/livekit/jwt/healthz
# Expected: 200 OK

# 4. LiveKit SFU WebSocket reachable (should upgrade)
curl -sf -o /dev/null -w '%{http_code}' https://matrix.inblock.io/livekit/sfu/
# Expected: 200 or 101 (WebSocket upgrade)

# 5. All containers healthy
docker compose ps
# Expected: livekit, lk-jwt-service, matrix_synapse, element-web, siwx-oidc, redis all "healthy" or "Up"

# 6. End-to-end call test
# Open Element Web in two browser tabs, log in as different users,
# start a 1:1 call. Both should hear audio and see video.
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| MISSING_MATRIX_RTC_TRANSPORT | `msc4143_enabled` not set, or Synapse < 1.140.0 | Enable MSC4143 in homeserver.yaml; verify Synapse version |
| 1:1 call ends for both ~18s after one side's network blips, even though LiveKit logged a successful resume ("ice reconnected or switched pair") | MSC4140 delayed-leave dead-man's switch fired: that client's heartbeat (`POST .../delayed_events/<id>/restart`, every ~4-5s) stopped for >18s, so Synapse sent its scheduled `m.call.member` leave; the peer's client then hangs up cleanly (`CLIENT_REQUEST_LEAVE` in LiveKit + its own `/send`) | Not server-configurable: the 18s expiry is chosen by the client SDK, and Element Call v0.15.0 removed the `membership_server_side_expiry_timeout` config. Root cause is client connectivity; see "Diagnosing call drops" below |
| MISSING_MATRIX_RTC_FOCUS | `.well-known/matrix/client` missing `rtc_foci` | Add `org.matrix.msc4143.rtc_foci` to well-known response |
| Call connects but no audio/video | UDP ports blocked by firewall | Open 20100-20200/udp on the host |
| "Failed to get SFU config" | lk-jwt-service unreachable or misconfigured | Check Caddy route for `/livekit/jwt`; check lk-jwt-service logs |
| lk-jwt-service rejects OpenID token | Synapse not reachable from lk-jwt-service container | Verify Docker network; lk-jwt-service validates tokens against Synapse's federation endpoint |
| Calls stuck / never end | MSC4140 (delayed events) not configured | Set `max_event_delay_duration: 24h` in homeserver.yaml |
| "Room not found" in LiveKit | `room.auto_create: true` but LIVEKIT_FULL_ACCESS_HOMESERVERS not set | Either set `auto_create: false` (lk-jwt-service creates rooms) or set LIVEKIT_FULL_ACCESS_HOMESERVERS |
| WebSocket 502 on /livekit/sfu/ | Caddy not routing to LiveKit container | Check Caddy handle block; ensure LiveKit container is on `portal-net` network |
| Call connects, zero media, DTLS timeouts in LiveKit logs; works when both peers are on-box but not for real external clients | LiveKit is multi-homed (attached to both the compose-default net and a shared reverse-proxy net). STUN fails on the proxy-net interface and LiveKit advertises that private bridge IP as an external ICE candidate alongside the real one. A remote client that selects the private candidate can never complete DTLS. | Check `docker logs <livekit> \| grep 'using external IPs'` — more than one IP in the list confirms it. Add `rtc.ips.excludes` for the private subnet (see the `config/livekit.yaml` example above); restart LiveKit; re-check the log line shows exactly one (public) IP. |

## Diagnosing call drops

Worked example: 2026-06-11, five 1:1 drops in 15 min, root-caused to one
participant's mobile connectivity (see `docs/2026-06-11-call-drop-analysis.md`).
Recipe (read-only SSH to production):

```bash
# 1. Who left, and why? CLIENT_REQUEST_LEAVE = deliberate client hangup;
#    DISCONNECTED/JOIN_TIMEOUT = media-layer failure.
docker compose logs --since <window> livekit | grep -E "participant closing|resuming RTC session|ice reconnected"

# 2. Did a delayed leave fire? Heartbeats are POST .../delayed_events/<syd_id>/restart
#    every ~4-5s per participant. A gap > 18s (the client-chosen expiry, visible as
#    ?org.matrix.msc4140.delay=18000 on the membership PUT) means Synapse sent that
#    user's scheduled m.call.member leave and ended the call for everyone.
docker compose logs --since <window> matrix_synapse | grep "delayed_events/syd_"

# 3. Explicit POST .../delayed_events/<syd_id>/send = clean hangup by that client
#    (it saw the call end or the user pressed hang-up), not a failure.
```

Interpretation: LiveKit media survives network blips and IP changes (resume /
ICE restart), but the MatrixRTC membership keep-alive is the stricter layer; an
outage longer than ~18s drops the call by design (MSC4140 dead-man's switch).
There is no supported server-side knob to lengthen it. If heartbeat restarts
return 429/M_LIMIT_EXCEEDED instead of gapping, fix `rc_delayed_event_mgmt`;
if in-call key sharing is rate-limited, fix `rc_message` (values above).

## Embedded TURN

**Status (2026-08-03): enabled on dev-staging only** (`config/livekit.dev-staging.yaml`),
via **TLS-edge termination (caddy-l4)**, production stays `turn: enabled:
false` (`config/livekit.yaml`) pending graduation (checklist below). Full
hypothesis register, verification evidence, and the prod-graduation
checklist live in
`docs/superpowers/plans/2026-08-03-turn-tls-edge-termination.md` (current
design) and its predecessor
`docs/superpowers/plans/2026-08-02-livekit-embedded-turn.md` (original
embedded-TURN rollout, dev-staging-only pre-edge-termination) — read both
before touching prod TURN config. ~10-20% of real-world sessions need TURN
(LiveKit guidance); before this, ICE-TCP on 7881 was the only
UDP-hostile-network fallback.

### Architecture: edge termination

```
client
  |  turns:dev.turn.matrix.inblock.io:443  (TLS, SNI = dev.turn.matrix.inblock.io)
  v
caddy-l4 (dockerfiles/Dockerfile.caddy-l4, layer4 listener_wrapper on :443)
  |  inspects ClientHello SNI BEFORE any TLS termination; only this exact
  |  SNI is diverted — every other :443 vhost on the box is untouched
  |  terminates TLS itself (Caddy's shared cert cache)
  v  tcp/livekit:5349  (plaintext, proxy_net, edge-internal — never host-published)
livekit (turn.external_tls: true, tls_port: 5349)
```

Naming (operator-mandated, applies everywhere this is documented): **dev DNS
puts `dev.` FIRST** — `dev.turn.matrix.inblock.io`, NOT
`turn.dev.matrix.inblock.io`. Prod is the bare name,
`turn.matrix.inblock.io`.

### The dev-staging turn block

```yaml
turn:
  enabled: true
  domain: dev.turn.matrix.inblock.io
  external_tls: true
  tls_port: 5349
  udp_port: 3478
```

`tls_port` and `udp_port` have **no compiled defaults** in livekit-server
v1.12.0 — omit either and TURN fails to start ("invalid TURN ports"). Both
must always be given explicitly. `external_tls: true` (not
`cert_file`/`key_file`) tells `pkg/service/turn.go` to open a bare plaintext
`net.Listen` on `tls_port` — TLS is entirely the edge's job now.

### THE 443 HARDCODE (why the edge design exists)

livekit-server v1.12.0 hardcodes the advertised TURN-TLS client URL to port
443 **regardless of `tls_port`** — the ICE-server list LiveKit hands clients
in `JoinResponse` builds the URL as:

```go
fmt.Sprintf("turns:%s:443?transport=tcp", domain)
```

(`pkg/service/roommanager.go`, `iceServersForParticipant`, v1.12.0 tag; TURN
server startup itself lives in `pkg/service/turn.go`.) Caddy owns 443 on both
dev-staging and prod, and stock Caddy has no way to route a raw TLS stream by
SNI to anything but its own HTTP handling — so a bare Caddy in front of
LiveKit left this leg permanently inert (the state described in the
predecessor plan doc). **caddy-l4's `layer4` listener_wrapper is what fixes
this**: it demuxes on SNI ahead of Caddy's normal `tls` wrapper, so the
client's hardcoded `turns:dev.turn.matrix.inblock.io:443` now lands exactly
where it needs to (see architecture diagram above). **TURN-UDP was never
affected either way**: it's advertised correctly as
`turn:<node-ip>:<udp_port>?transport=udp` straight against LiveKit's own
`udp_port`.

### The caddy-l4 image + Caddyfile wiring

`dockerfiles/Dockerfile.caddy-l4` builds Caddy via `xcaddy` with
`github.com/mholt/caddy-l4@v0.1.2`, whose `go.mod` pins
`caddyserver/caddy/v2 v2.11.4` exactly — the Dockerfile's builder/final base
tags must match that pin (see the Dockerfile header before bumping either
version). Published by `.github/workflows/docker.yml` (matrix entry `image:
caddy-l4`) to `ghcr.io/inblockio/siwx-oidc-matrix-server/caddy-l4` — this is
the prod-graduation vehicle (portal-caddy-1 needs to adopt this image before
prod TURN-TLS can graduate).

`Caddyfile.dev-aquafire`'s global options block carries the actual wrapper:

```
servers :443 {
    listener_wrappers {
        layer4 {
            @turn_sni tls sni dev.turn.matrix.inblock.io
            route @turn_sni {
                tls
                proxy tcp/livekit:5349
            }
        }
        tls
    }
}
```

`layer4` MUST precede `tls` in `listener_wrappers` — it reads the raw
ClientHello before decryption. `listener_wrappers` are TCP-only, so
h3/QUIC on udp/443 for every other vhost is untouched.

**Dummy cert-automation site is required.** The `tls` handler inside the
`route @turn_sni` block does no certificate management of its own — it reads
from Caddy's shared cert cache, which is only populated if *something* in the
Caddyfile owns automation for that hostname. That's this site block:

```
dev.turn.matrix.inblock.io {
    tls {
        issuer acme {
            disable_tlsalpn_challenge
        }
    }
    respond "TURN-over-TLS termination endpoint" 200
}
```

`disable_tlsalpn_challenge` is load-bearing, not decorative: TLS-ALPN-01
validation is itself a TLS handshake carrying this same SNI, so without
disabling it the `@turn_sni` matcher above would intercept and break
Let's Encrypt's own validation attempt. Issuance instead runs HTTP-01 on
port 80, which sits outside the `:443`-scoped `layer4` wrapper entirely.

### Cert-sync design — SUPERSEDED by edge termination

The original design (LiveKit terminating TLS itself via
`cert_file`/`key_file`, fed by a sync-copy of Caddy's ACME cert) is no longer
what dev-staging runs. `scripts/livekit-turn-cert-sync.sh` and
`systemd/livekit-turn-cert-sync.{service,timer}` are **retained in the repo**
as tooling for the passthrough alternative (LiveKit terminating TLS directly,
no edge SNI demux) — the plan doc's decision record explains why edge
termination (variant 2) was chosen instead for dev/prod. They are unused by
the current `config/livekit.dev-staging.yaml` / `docker-compose.dev-staging.yml`.
Original description, for the passthrough variant: Caddy renews a Let's
Encrypt cert by atomic rename inside its own ACME storage volume (700
root:root); never bind-mount those files directly into the livekit container
(pins the mount to a stale inode); the script sync-copies cert+key into
`config/livekit-tls/` gated by a sha256 checksum state file, restarting
`livekit` only when the bytes changed (no TLS hot reload in livekit-server).

### Verification one-liners

```bash
# TURN listeners bound on the box itself (dev-aquafire)
ss -tlnp | grep 5349      # livekit's plaintext external_tls listener
ss -ulnp | grep 3478      # TURN-UDP

# End-to-end: dial :443 with the TURN SNI and confirm the LE cert for that
# name comes back THROUGH the edge (proves the layer4 SNI match + the l4
# `tls` terminator + the dummy site's cert automation all work together)
openssl s_client -connect dev.turn.matrix.inblock.io:443 -servername dev.turn.matrix.inblock.io </dev/null 2>/dev/null | openssl x509 -noout -subject -enddate

# Caddy debug logs confirming the SNI match and the upstream dial (needs
# `debug` log level; look for these two logger names specifically)
docker logs caddy_proxy 2>&1 | grep 'caddy.listeners.layer4'   # the SNI matcher fired
docker logs caddy_proxy 2>&1 | grep 'layer4.handlers.proxy'    # "dial upstream" to livekit:5349

# Force a client onto the relay path to prove the TLS leg actually carries
# media end to end (aqua-agents, AQUA_E2E_FORCE_RELAY=1 — see T3 in the plan doc)
AQUA_E2E_FORCE_RELAY=1 <aqua-e2e run command> # relay-forced round vs dev-staging
```

### Firewall

`3478/udp` (TURN-UDP) must be allowed on **both** layers on dev-aquafire:
`ufw allow 3478/udp` and the DigitalOcean cloud firewall for the droplet.
`5349/tcp` (TURN-TLS) is **edge-internal only** — it is deliberately NOT
host-published (see `docker-compose.dev-staging.yml`'s `livekit` service
comment) and therefore needs **no** ufw rule; only the box's existing 443/tcp
rule (already open for the rest of the Caddy vhosts) matters for the TLS
leg. Verify with `ss -tlnp | grep 5349` showing a listener bound only inside
the container network namespace, not on a host-facing rule.

### Restricted-peer CIDR default — no action needed

livekit-server v1.12.0 denies TURN relay to restricted (private/loopback/
link-local) peer IPs by default (`allow_restricted_peer_cidrs` /
`deny_peer_cidrs` in the schema, both left unset here). Our SFU advertises
only the public node IP (the `rtc.ips.excludes` fix above ensures this), so
the default never blocks a real client and no override is needed.

## Known limitations

- **LiveKit built-in TURN**: enabled on **dev-staging only** as of 2026-08-03,
  via TLS-edge termination (see "Embedded TURN" above); production remains
  disabled pending the prod-graduation checklist (needs portal-caddy-1 to
  adopt the CI-built caddy-l4 image first). Until then, clients behind
  symmetric NAT or strict corporate firewalls may fail to connect on prod.
- **No TURN for legacy calls**: the stack has no coturn. Legacy 1:1 VoIP calls
  (non-MatrixRTC) will fail behind NAT. This is acceptable because
  `use_exclusively: true` routes all calls through MatrixRTC/LiveKit.
- **Synapse v1.150.0 bug**: there is a reported issue (#19652) where the
  `/rtc/transports` endpoint does not work despite correct config. The
  `.well-known` `rtc_foci` serves as the reliable fallback; Element Web
  checks both.

## Implementation order

1. Add `config/livekit.yaml`
2. Update `docker-compose.yml` (add livekit + lk-jwt-service services)
3. Update `entrypoints/matrix_server.sh` (MSC flags + matrix_rtc block)
4. Update `config/element-config.json` (element_call + features)
5. Update `.env.example` (LIVEKIT_KEY, LIVEKIT_SECRET)
6. Update `start-matrix.sh` (generate LiveKit credentials)
7. Update `Caddyfile.production` (well-known rtc_foci + proxy routes)
8. Update `Caddyfile.local` (same for local dev)
9. Deploy: `./deploy.sh <ref> --build --restart`
10. Apply Synapse config on existing deployment (yq commands above)
11. Open firewall ports 7881/tcp and 20100-20200/udp
12. Verify with checklist above
