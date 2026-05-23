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
   |  4. UDP  :50100-50200               (WebRTC media, direct to host)
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
  image: livekit/livekit-server:latest
  restart: unless-stopped
  command: --config /etc/livekit.yaml
  ports:
    - "7881:7881/tcp"
    - "50100-50200:50100-50200/udp"
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
- **50100-50200/udp**: WebRTC media. Keep the range small (100 ports); Docker creates
  individual iptables rules per port, and large ranges cause slow container startup.
  100 ports supports ~50 concurrent participants.
- **7880** is NOT exposed to host; Caddy proxies it internally via Docker network.

## New file: config/livekit.yaml

```yaml
port: 7880
bind_addresses:
  - "0.0.0.0"
rtc:
  tcp_port: 7881
  port_range_start: 50100
  port_range_end: 50200
  use_external_ip: true
room:
  auto_create: false
logging:
  level: info
turn:
  enabled: false
keys:
  LIVEKIT_API_KEY: "LIVEKIT_API_SECRET_PLACEHOLDER"
```

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

**Option A (recommended):** LiveKit supports env var overrides:
```
LIVEKIT_API_KEY=<key> LIVEKIT_API_SECRET=<secret>
```
These override the `keys:` section in the YAML config. Pass them via
docker-compose environment.

**Option B:** Template the YAML at deploy time in `deploy.sh` or an
entrypoint script using `sed`/`envsubst`.

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
| 50100-50200 | UDP | WebRTC media (audio/video) |

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
| MISSING_MATRIX_RTC_FOCUS | `.well-known/matrix/client` missing `rtc_foci` | Add `org.matrix.msc4143.rtc_foci` to well-known response |
| Call connects but no audio/video | UDP ports blocked by firewall | Open 50100-50200/udp on the host |
| "Failed to get SFU config" | lk-jwt-service unreachable or misconfigured | Check Caddy route for `/livekit/jwt`; check lk-jwt-service logs |
| lk-jwt-service rejects OpenID token | Synapse not reachable from lk-jwt-service container | Verify Docker network; lk-jwt-service validates tokens against Synapse's federation endpoint |
| Calls stuck / never end | MSC4140 (delayed events) not configured | Set `max_event_delay_duration: 24h` in homeserver.yaml |
| "Room not found" in LiveKit | `room.auto_create: true` but LIVEKIT_FULL_ACCESS_HOMESERVERS not set | Either set `auto_create: false` (lk-jwt-service creates rooms) or set LIVEKIT_FULL_ACCESS_HOMESERVERS |
| WebSocket 502 on /livekit/sfu/ | Caddy not routing to LiveKit container | Check Caddy handle block; ensure LiveKit container is on `portal-net` network |

## Known limitations

- **LiveKit built-in TURN is disabled** in this config. Clients behind symmetric NAT
  or strict corporate firewalls may fail to connect. To enable, set `turn.enabled: true`
  in `config/livekit.yaml` with a valid TLS cert (requires a dedicated subdomain).
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
11. Open firewall ports 7881/tcp and 50100-50200/udp
12. Verify with checklist above
