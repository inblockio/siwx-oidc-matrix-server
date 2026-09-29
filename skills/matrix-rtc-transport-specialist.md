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

## Services (docker-compose.yml)

Two services carry MatrixRTC. Their full definitions, with the reasons for each
setting, are in `docker-compose.yml`; the points that matter:

```yaml
livekit:
  image: ${LIVEKIT_IMAGE_REF:-livekit/livekit-server:v1.13.7@sha256:…}   # pinned; never :latest
  command: --config /etc/livekit.yaml
  environment:
    LIVEKIT_KEYS: "${LIVEKIT_KEY}: ${LIVEKIT_SECRET}"
  ports:
    - "7881:7881/tcp"                    # WebRTC over TCP fallback
    - "20100-20200:20100-20200/udp"      # WebRTC media
    - "3478:3478/udp"                    # embedded TURN, UDP leg (TLS leg: see Embedded TURN)
  volumes:
    - ./config/livekit.yaml:/etc/livekit.yaml:ro

lk-jwt-service:
  image: ${LK_JWT_IMAGE_REF:-ghcr.io/element-hq/lk-jwt-service:0.7.0@sha256:…}   # pinned
  environment:
    LIVEKIT_URL: "wss://${MATRIX_HOST}/livekit/sfu"    # the PUBLIC URL; see below
    LIVEKIT_KEY: "${LIVEKIT_KEY}"
    LIVEKIT_SECRET: "${LIVEKIT_SECRET}"
    LIVEKIT_JWT_BIND: ":8080"
    LIVEKIT_FULL_ACCESS_HOMESERVERS: "${MATRIX_HOST}"  # explicit hostname, never "*"
  healthcheck:
    disable: true
```

- **`LIVEKIT_URL` stays the public `wss://` URL.** lk-jwt-service uses it both for the
  SFU URL it hands to clients and for its own room-creation (Twirp) call, so that call
  comes back in through the proxy. The proxy therefore admits `/livekit/sfu/twirp/*`
  only from private source addresses (see `Caddyfile.local`).
- **`LIVEKIT_FULL_ACCESS_HOMESERVERS` is mandatory** since lk-jwt-service 0.5.0 (it exits
  at startup without it). Since 0.7.0, users of other homeservers get subscribe-only
  tokens.
- **The healthcheck is disabled.** lk-jwt-service 0.6.0's image-level healthcheck cannot
  pass with any `LIVEKIT_JWT_BIND` value (the comment in `docker-compose.yml` has the
  details). Probe `/livekit/jwt/healthz` through the proxy instead.

### Why these port choices

- **7881/tcp**: LiveKit WebRTC-over-TCP fallback (for clients behind strict UDP firewalls)
- **20100-20200/udp**: WebRTC media. Must sit BELOW the Linux ephemeral range
  (32768-60999) or the host's own outbound sockets can squat the ports the SFU
  needs — the stack was on 50100-50200 until 2026-08-01 for exactly that reason.
  Keep the range small (100 ports); Docker creates individual iptables rules per
  port, and large ranges cause slow container startup. 100 ports supports ~50
  concurrent participants. The range must match `rtc.port_range_start/end` in
  `config/livekit.yaml`.
- **3478/udp**: TURN over UDP (embedded TURN).
- **7880** is NOT exposed to host; the proxy reaches it over the Docker network.

## config/livekit.yaml

The shape of the file (see the file itself for the comments):

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
  enabled: true              # only with the caddy-l4 edge; see "Embedded TURN"
  domain: turn.example.org
  external_tls: true
  tls_port: 5349
  udp_port: 3478
```

No `keys:` block: `LIVEKIT_KEYS` in the environment replaces file keys entirely,
so a placeholder here is dead config that only invites someone to trust it.

### LiveKit credentials

`start-matrix.sh` generates them when it first writes `.env`:

```bash
LIVEKIT_KEY="API$(openssl rand -hex 8)"
LIVEKIT_SECRET="$(openssl rand -base64 32)"
```

They must match between lk-jwt-service and LiveKit. An existing `.env` written before
LiveKit was added has neither; add both by hand. **The correct server variable is
`LIVEKIT_KEYS`** (not `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`, which are client SDK
variables), in the YAML key-value form `"<key>: <secret>"`.

## What the rest of the stack configures

### 1. Synapse (`entrypoints/matrix_server.sh`, every boot)

`apply_matrixrtc_config()` runs on **every** boot, not only the first, so a change to it
reaches an existing deployment at the next restart of an image that carries it:

```bash
# Enable QR code login rendezvous server (MSC4108 2024 version)
yq -i ".experimental_features.msc4108_enabled = true" /data/homeserver.yaml

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

Synapse 1.161 deprecates `livekit_service_url` in favour of `url`. Keep
`livekit_service_url` and do not add `url`: a client that sees `url` reaches the LiveKit
authorization service through the client-server API, which needs lk-jwt-service
registered as an application service, and here it is not.

### 2. Reverse proxy

Add `org.matrix.msc4143.rtc_foci` to the `.well-known/matrix/client` response (the
issuer keeps its trailing slash, byte-equal to siwx-oidc's own issuer):

```
handle /.well-known/matrix/client {
    header Access-Control-Allow-Origin *
    respond `{"m.homeserver": {"base_url": "https://matrix.example.org"}, "m.authentication": {"issuer": "https://siwx-oidc.example.org/", "account": "https://siwx-oidc.example.org/account"}, "org.matrix.msc4143.rtc_foci": [{"type": "livekit", "livekit_service_url": "https://matrix.example.org/livekit/jwt"}]}`
}
```

Route `/livekit/jwt` and `/livekit/jwt/*` to `lk-jwt-service:8080`, and `/livekit/sfu`,
`/livekit/sfu/*` to `livekit:7880`, with `/livekit/sfu/twirp/*` refused (403) for
non-private source addresses. `Caddyfile.local` has the exact blocks, including the bare
`/livekit/sfu` path that `/livekit/sfu/*` does not match.

### 3. config/element-config.json

```json
"element_call": {
  "use_exclusively": true,
  "brand": "inblock.io Call"
},
"features": {
  "feature_group_calls": true,
  "feature_video_rooms": true,
  "feature_element_call_video_rooms": true
}
```

There is no `element_call.url`: Element Web uses the Element Call build embedded in its
bundle (`@element-hq/element-call-embedded`, which moves with the Element Web tag).
`use_exclusively: true` disables legacy 1:1 calls and Jitsi; all calls go
through MatrixRTC. This is correct because the stack has no Jitsi or TURN
for legacy calls.

## Existing deployments

The Synapse settings above are re-applied on every boot, so an existing deployment picks
them up by restarting `matrix_synapse` on an image that carries them; no manual `yq` is
needed. What an existing deployment may still lack:

- `LIVEKIT_KEY` and `LIVEKIT_SECRET` in `.env` (see above);
- the proxy routes and the `rtc_foci` entry in `.well-known/matrix/client`;
- the firewall rules below.

### Firewall

The host must allow:

| Port | Protocol | Purpose |
|---|---|---|
| 7881 | TCP | LiveKit WebRTC-over-TCP fallback |
| 20100-20200 | UDP | WebRTC media (audio/video) |
| 3478 | UDP | TURN over UDP (embedded TURN) |

These are in addition to 80 and 443 for the reverse proxy.

### Synapse version

Synapse v1.140.0+ is required for `matrix_rtc` config and `/rtc/transports`.
The stack pins `matrixdotorg/synapse:v1.161.0` (`dockerfiles/Dockerfile`).

## Verification checklist

After deployment, verify each component:

```bash
# 1. .well-known includes rtc_foci
curl -sf https://matrix.example.org/.well-known/matrix/client | jq '.["org.matrix.msc4143.rtc_foci"]'
# Expected: [{"type":"livekit","livekit_service_url":"https://matrix.example.org/livekit/jwt"}]

# 2. Synapse exposes /rtc/transports (requires auth)
# Get a valid access token first, then:
curl -sf -H "Authorization: Bearer $TOKEN" \
  https://matrix.example.org/_matrix/client/v1/rtc/transports | jq .
# Expected: {"transports":[{"type":"livekit","livekit_service_url":"..."}]}

# 3. lk-jwt-service is healthy
curl -sf https://matrix.example.org/livekit/jwt/healthz
# Expected: 200 OK

# 4. LiveKit SFU reachable through the proxy
curl -sf -o /dev/null -w '%{http_code}' https://matrix.example.org/livekit/sfu/
# Expected: 200 or 101 (WebSocket upgrade)

# 5. All containers up
docker compose ps
# Expected: livekit, matrix_synapse, element-web, siwx-oidc, redis "healthy";
# lk-jwt-service "Up" (its healthcheck is disabled)

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
| "Failed to get SFU config" | lk-jwt-service unreachable or misconfigured | Check the proxy route for `/livekit/jwt`; check lk-jwt-service logs |
| lk-jwt-service rejects OpenID token | Synapse not reachable from lk-jwt-service container | Verify Docker network; lk-jwt-service validates tokens against Synapse's federation endpoint |
| lk-jwt-service exits at startup | `LIVEKIT_FULL_ACCESS_HOMESERVERS` unset | Set it to the homeserver's name (never `*`) |
| Calls stuck / never end | MSC4140 (delayed events) not configured | Set `max_event_delay_duration: 24h` in homeserver.yaml |
| "Room not found" in LiveKit | `room.auto_create: false` and lk-jwt-service could not create the room | Check that its Twirp call through the proxy is admitted (private source address) and that `LIVEKIT_FULL_ACCESS_HOMESERVERS` names this homeserver |
| WebSocket 502 on /livekit/sfu/ | Proxy not routing to the LiveKit container | Check the proxy's handle block; ensure the LiveKit container is on `portal-net` |
| Call connects, zero media, DTLS timeouts in LiveKit logs; works when both peers are on-box but not for real external clients | LiveKit is multi-homed (attached to both the compose-default net and a shared reverse-proxy net). STUN fails on the proxy-net interface and LiveKit advertises that private bridge IP as an external ICE candidate alongside the real one. A remote client that selects the private candidate can never complete DTLS. | Check `docker logs <livekit> \| grep 'using external IPs'` — more than one IP in the list confirms it. Add `rtc.ips.excludes` for the private subnet (see the `config/livekit.yaml` example above); restart LiveKit; re-check the log line shows exactly one (public) IP. |

## Diagnosing call drops

Worked example: 2026-06-11, five 1:1 drops in 15 min, root-caused to one
participant's mobile connectivity.
Recipe (read-only, in the stack directory on the host):

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

**Status:** `config/livekit.yaml` enables embedded TURN via **TLS-edge
termination (caddy-l4)**. Enable it only on a deployment whose edge carries
the `layer4` wrapper described below. ~10-20% of real-world sessions need TURN
(LiveKit guidance); before this, ICE-TCP on 7881 was the only
UDP-hostile-network fallback.

### Architecture: edge termination

```
client
  |  turns:turn.example.org:443  (TLS, SNI = turn.example.org)
  v
caddy-l4 (dockerfiles/Dockerfile.caddy-l4, layer4 listener_wrapper on :443)
  |  inspects ClientHello SNI BEFORE any TLS termination; only this exact
  |  SNI is diverted — every other :443 vhost on the box is untouched
  |  terminates TLS itself (Caddy's shared cert cache)
  v  tcp/livekit:5349  (plaintext, proxy_net, edge-internal — never host-published)
livekit (turn.external_tls: true, tls_port: 5349)
```

The TURN domain (here `turn.example.org`) needs a DNS record pointing at the host and
its own certificate at the edge.

### The turn block

```yaml
turn:
  enabled: true
  domain: turn.example.org
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
server startup itself lives in `pkg/service/turn.go`.) Caddy owns 443 on the host,
and stock Caddy has no way to route a raw TLS stream by
SNI to anything but its own HTTP handling — so a bare Caddy in front of
LiveKit left this leg permanently inert (the state before the edge
existed). **caddy-l4's `layer4` listener_wrapper is what fixes
this**: it demuxes on SNI ahead of Caddy's normal `tls` wrapper, so the
client's hardcoded `turns:turn.example.org:443` now lands exactly
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
caddy-l4`) to `ghcr.io/inblockio/siwx-oidc-matrix-server/caddy-l4`, so an
edge can pull a digest-pinnable build instead of building on the host.

The edge Caddyfile's global options block carries the wrapper:

```
servers :443 {
    listener_wrappers {
        layer4 {
            @turn_sni tls sni turn.example.org
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
turn.example.org {
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
`cert_file`/`key_file`, fed by a sync-copy of Caddy's ACME cert) is retired;
edge termination was chosen instead. It remains the passthrough alternative
(LiveKit terminating TLS directly, no edge SNI demux). For that variant: Caddy
renews a Let's Encrypt cert by atomic rename inside its own ACME storage
volume (700 root:root); never bind-mount those files directly into the
livekit container (pins the mount to a stale inode); sync-copy cert+key into
`config/livekit-tls/` on a timer, gated by a sha256 checksum state file, and
restart `livekit` only when the bytes changed (no TLS hot reload in
livekit-server).

### Verification one-liners

```bash
# TURN listeners bound on the host itself
ss -tlnp | grep 5349      # livekit's plaintext external_tls listener
ss -ulnp | grep 3478      # TURN-UDP

# End-to-end: dial :443 with the TURN SNI and confirm the LE cert for that
# name comes back THROUGH the edge (proves the layer4 SNI match + the l4
# `tls` terminator + the dummy site's cert automation all work together)
openssl s_client -connect turn.example.org:443 -servername turn.example.org </dev/null 2>/dev/null | openssl x509 -noout -subject -enddate

# Caddy debug logs confirming the SNI match and the upstream dial (needs
# `debug` log level; look for these two logger names specifically)
docker logs <caddy-container> 2>&1 | grep 'caddy.listeners.layer4'   # the SNI matcher fired
docker logs <caddy-container> 2>&1 | grep 'layer4.handlers.proxy'    # "dial upstream" to livekit:5349

# A real TURN-over-TLS allocation through the edge: scripts/turnprobe/main.go
# mints TURN credentials from the LiveKit key and secret the way LiveKit does
# (args: <LIVEKIT_KEY> <LIVEKIT_SECRET>) and allocates through TURN_PROBE_HOST:443.
# It has no go.mod: build it in a scratch module that requires
# github.com/jxskiss/base62 and github.com/pion/turn/v4.

# To prove the TLS leg carries media end to end, force a test client onto the
# relay path (ICE transport policy "relay") and run a call.
```

### Firewall

`3478/udp` (TURN-UDP) must be allowed on **both** layers: the host firewall
(`ufw allow 3478/udp`) and any cloud firewall in front of the host.
`5349/tcp` (TURN-TLS) is **edge-internal only** — it is deliberately NOT
host-published (see the `livekit` service comment in `docker-compose.yml`)
and therefore needs **no** ufw rule; only the host's existing 443/tcp
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

- **LiveKit built-in TURN** needs the caddy-l4 edge (see "Embedded TURN"
  above). A deployment without it must set `turn.enabled: false`, and then
  clients behind symmetric NAT or strict corporate firewalls may fail to
  connect.
- **No TURN for legacy calls**: the stack has no coturn. Legacy 1:1 VoIP calls
  (non-MatrixRTC) will fail behind NAT. This is acceptable because
  `use_exclusively: true` routes all calls through MatrixRTC/LiveKit.
- **Synapse v1.150.0 bug**: there is a reported issue (#19652) where the
  `/rtc/transports` endpoint does not work despite correct config. The
  `.well-known` `rtc_foci` serves as the reliable fallback; Element Web
  checks both.

## Checklist for a new deployment

1. `.env` has `LIVEKIT_KEY` and `LIVEKIT_SECRET` (`start-matrix.sh` writes them).
2. `config/livekit.yaml`: set `turn.domain` to your TURN host name, or
   `turn.enabled: false` if your edge cannot split `:443` by SNI.
3. Reverse proxy: `rtc_foci` in `.well-known/matrix/client`, the `/livekit/jwt` and
   `/livekit/sfu` routes, the Twirp restriction (see `Caddyfile.local`), and for TURN the
   `layer4` wrapper plus the certificate site for the TURN host.
4. Firewall: 7881/tcp, 20100-20200/udp, 3478/udp.
5. Start or restart the stack; the Synapse settings are applied at every boot.
6. Run the verification checklist above.
