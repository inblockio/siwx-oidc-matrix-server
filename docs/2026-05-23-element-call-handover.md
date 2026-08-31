# Handover: MatrixRTC / Element Call Integration

**Date:** 2026-05-23
**Branch:** `feat/matrix-rtc-transport` (6 commits ahead of main)
**Goal:** Ensure video/audio calls work end-to-end between Element Web (browser) and Element X (mobile).
**Validated test:** User calls from mobile phone (Element X) and browser instance (Element Web).

## Current Status

| Test case | Status |
|---|---|
| Browser-to-browser (Element Web) | Working |
| Element X mobile calls | Pending retest after LIVEKIT_KEYS fix |

## What was done

### Infrastructure deployed

- **LiveKit SFU** (`livekit/livekit-server:latest`) added to Docker Compose stack
- **lk-jwt-service** (`ghcr.io/element-hq/lk-jwt-service:latest`) added for OpenID-to-LiveKit JWT exchange
- **Synapse** configured with MSC4143 (MatrixRTC), MSC3266, MSC4222 experimental features
- **Caddy** updated with `handle_path` routes for `/livekit/jwt` and `/livekit/sfu/*`
- **`.well-known/matrix/client`** includes `org.matrix.msc4143.rtc_foci` pointing to `https://matrix.inblock.io/livekit/jwt`
- **Element Web config** has `element_call.use_exclusively: true` and feature flags enabled
- **Firewall** ports 7881/tcp and 50100-50200/udp opened on production server
- **Skill** created: `/matrix-rtc-transport-specialist` for future reference

### Bugs found and fixed during deployment

1. **`handle` vs `handle_path` in Caddy** (commit 91ae32d): Caddy's `handle` preserves the URL path, but lk-jwt-service expects requests at its root (e.g., `/healthz` not `/livekit/jwt/healthz`). Fixed by switching to `handle_path`.

2. **lk-jwt-service healthcheck removed** (commit 91ae32d): The image is scratch/distroless with no shell, wget, or curl. Docker healthcheck cannot work. Monitor externally via `curl https://matrix.inblock.io/livekit/jwt/healthz`.

3. **Element config bind mount** (commit eb88083): `sed -i` fails on Docker bind-mounted files ("Resource busy"). Fixed by mounting as `/app/config.json.src` (read-only) and copying to `/app/config.json` in the entrypoint before templating runs.

4. **`LIVEKIT_KEYS` env var** (commit c7eef9a): `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` are **client SDK variables**, not server config overrides. The correct env var is `LIVEKIT_KEYS: "key: secret"` (YAML format). Without this, LiveKit used the placeholder key from the config file, causing authenticated API calls from lk-jwt-service to fail.

## Element X OPEN_ID_ERROR: Root Cause Analysis

The error message `OPEN_ID_ERROR` from Element X is misleading. The actual failure chain:

```
Element X -> POST /openid/request_token -> Synapse -> 200 OK (works)
Element X -> POST /livekit/jwt (legacy /sfu/get) -> lk-jwt-service
  lk-jwt-service -> validates OpenID token against Synapse -> 200 OK (works)
  lk-jwt-service -> CreateRoom on LiveKit API -> 401 Unauthorized <- FAILURE
    Root cause: LiveKit server had invalid API keys (placeholder from config file)
    Fix: LIVEKIT_KEYS env var (commit c7eef9a, deployed)
```

Key difference between Element Web and Element X:
- **Element Web** uses the newer `/get_token` endpoint (MSC4195), which may not require server-side room creation
- **Element X** uses the legacy `/sfu/get` endpoint, which requires lk-jwt-service to create a room on LiveKit via authenticated API call

## What needs to happen next

### Immediate: retest Element X

The `LIVEKIT_KEYS` fix has been deployed. Element X should now be able to make calls. Test:
1. Open Element X on mobile
2. Open Element Web in browser
3. Both users in the same room
4. Initiate a call from either side
5. Verify audio and video work in both directions

### If Element X still fails

Check lk-jwt-service logs for new errors:
```bash
ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io \
  "cd /home/deploy/matrix/stack && docker compose logs lk-jwt-service --tail 20"
```

Possible remaining issues:
- **lk-jwt-service cannot reach LiveKit via public URL** (`wss://matrix.inblock.io/livekit/sfu`): lk-jwt-service runs inside Docker and connects to LiveKit through the public internet (DNS -> Caddy -> LiveKit). If this fails, fix by adding `extra_hosts` to resolve `matrix.inblock.io` to Caddy's Docker IP, or set a separate internal LiveKit URL.
- **WebSocket upgrade issues**: Caddy's `handle_path` should pass WebSocket upgrades through, but verify with `CID=$(docker ps -q --filter name=portal-caddy | head -1); docker logs "${CID:-portal-caddy-1}" 2>&1 | grep livekit`.
- **`LIVEKIT_INSECURE_SKIP_VERIFY_TLS`**: Currently `false`. If lk-jwt-service fails TLS verification when connecting to LiveKit via the public URL, try setting to `true` temporarily.

### After Element X works: merge to main

```bash
git checkout main
git merge feat/matrix-rtc-transport
git push origin main
./deploy.sh main --restart
```

## Server state snapshot

**Server:** agentic.inblock.io (142.93.168.4)
**Repo on server:** `/home/deploy/matrix/stack/` checked out at `c7eef9a` (detached HEAD)
**Containers running:** matrix_synapse, siwx-oidc, redis, element-web, livekit, lk-jwt-service, watchtower

**Synapse homeserver.yaml** (inside `matrix_data` volume) has been modified directly via `yq` to add:
- `experimental_features.msc4143_enabled: true`
- `experimental_features.msc3266_enabled: true`
- `experimental_features.msc4222_enabled: true`
- `max_event_delay_duration: "24h"`
- `rc_delayed_event_mgmt.per_second: 1`
- `rc_delayed_event_mgmt.burst_count: 20`
- `matrix_rtc.transports[0].type: "livekit"`
- `matrix_rtc.transports[0].livekit_service_url: "https://matrix.inblock.io/livekit/jwt"`

**Caddy** (`/home/portal/portal/Caddyfile`) has been modified directly on the server to add:
- `rtc_foci` in `.well-known/matrix/client` response
- `handle_path /livekit/jwt` and `handle_path /livekit/sfu/*` routes

**`.env`** on server has `LIVEKIT_KEY` and `LIVEKIT_SECRET` generated.

**Firewall:** `ufw` rules added for 7881/tcp and 50100-50200/udp.

## Verification commands

```bash
# .well-known
curl -sf https://matrix.inblock.io/.well-known/matrix/client | jq '."org.matrix.msc4143.rtc_foci"'

# lk-jwt-service health
curl -sf -o /dev/null -w '%{http_code}' https://matrix.inblock.io/livekit/jwt/healthz

# LiveKit SFU
curl -sf -o /dev/null -w '%{http_code}' https://matrix.inblock.io/livekit/sfu/

# Element Web config
curl -sf https://element.inblock.io/config.json | jq '{element_call, features}'

# Container status
ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io \
  "cd /home/deploy/matrix/stack && docker compose ps"

# lk-jwt-service logs (look for "Error processing request" or "Unable to create room")
ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io \
  "cd /home/deploy/matrix/stack && docker compose logs lk-jwt-service --tail 20"

# LiveKit logs (look for "secret is too short" error)
ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io \
  "cd /home/deploy/matrix/stack && docker compose logs livekit --tail 10"
```

## Commits on this branch

```
8fec3a4 docs: update deploy skill examples to use main instead of fork-stable
c7eef9a fix: use LIVEKIT_KEYS env var for LiveKit server API key injection
eb88083 fix: mount element config as .src and copy at startup to avoid sed -i bind mount error
6894e60 fix: mount element-config.json as volume so config updates apply without image rebuild
91ae32d fix: use handle_path for LiveKit routes, remove lk-jwt-service healthcheck
3ca4107 feat: add MatrixRTC/LiveKit support for Element Call (video/audio calls)
```
