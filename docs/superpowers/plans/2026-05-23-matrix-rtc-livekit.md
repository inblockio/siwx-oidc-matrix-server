# Plan: Enable MatrixRTC / Element Call via LiveKit

**Date:** 2026-05-23
**Branch:** `feat/matrix-rtc-transport`
**Goal:** Enable end-to-end video and audio calls in the siwx-oidc-matrix-server stack by adding LiveKit SFU + lk-jwt-service and configuring Synapse + Element Web for MatrixRTC.
**Success criteria:** Two users on element.inblock.io can initiate a 1:1 call with working audio and video.

---

## Hypothesis Register

| ID | If | Then | Assumptions | Verification |
|----|-----|------|-------------|--------------|
| H1 | LiveKit config file exists with correct port/key structure | LiveKit container starts and listens on 7880/7881 | `livekit/livekit-server:latest` image is available | `docker compose ps livekit` shows healthy |
| H2 | docker-compose.yml adds livekit + lk-jwt-service with correct env vars | Both containers start on portal-net and can reach each other | Docker network `portal-net` exists; LIVEKIT_KEY/SECRET match between services | `docker compose ps` shows both healthy |
| H3 | Synapse homeserver.yaml has MSC4143/3266/4222 + matrix_rtc block | Synapse exposes `/_matrix/client/v1/rtc/transports` endpoint | Synapse version >= 1.140.0 | `curl -H "Authorization: Bearer $TOKEN" .../rtc/transports` returns transports array |
| H4 | Element Web config has element_call + features block | Element Web UI shows call buttons using MatrixRTC (not legacy VoIP) | Element Web version supports embedded Element Call | Call button visible in room header |
| H5 | Caddy .well-known/matrix/client includes org.matrix.msc4143.rtc_foci | Element discovers LiveKit SFU endpoint | Caddy is the authoritative .well-known responder | `curl .well-known/matrix/client \| jq .["org.matrix.msc4143.rtc_foci"]` returns livekit entry |
| H6 | Caddy routes /livekit/jwt to lk-jwt-service and /livekit/sfu/ to livekit | Clients can exchange OpenID tokens for LiveKit JWTs and establish WebSocket signaling | Caddy can proxy WebSocket upgrades to LiveKit | `curl .../livekit/jwt/healthz` returns 200 |
| H7 | Firewall allows 7881/tcp + 50100-50200/udp | WebRTC media flows between clients and LiveKit | Server firewall is configurable via ufw/iptables | `nc -z` or actual call test with media |
| H8 | lk-jwt-service can validate Matrix OpenID tokens against Synapse | Authenticated users get valid LiveKit JWTs | Synapse federation/openid listener is accessible from lk-jwt-service container | Call setup succeeds (no "Failed to get SFU config" error) |

---

## Tasks

### Task 1: Add config/livekit.yaml

**Hypotheses:** H1
**Files:**
- Create: `config/livekit.yaml`

- [ ] Create LiveKit config with port 7880, RTC ports 50100-50200, tcp_port 7881
- [ ] Set `room.auto_create: false` (lk-jwt-service manages room creation)
- [ ] Use placeholder keys (overridden by env vars at runtime)

### Task 2: Update docker-compose.yml with LiveKit services

**Hypotheses:** H1, H2
**Files:**
- Modify: `docker-compose.yml`

- [ ] Add `livekit` service: image, command, ports (7881/tcp, 50100-50200/udp), volume mount for config, networks
- [ ] Add `lk-jwt-service` service: image, env vars (LIVEKIT_URL, KEY, SECRET, BIND), depends_on matrix_synapse, healthcheck, networks
- [ ] Pass LIVEKIT_KEY/LIVEKIT_SECRET as env vars to livekit service (LIVEKIT_API_KEY/LIVEKIT_API_SECRET override config file keys section)

### Task 3: Update entrypoints/matrix_server.sh

**Hypotheses:** H3
**Files:**
- Modify: `entrypoints/matrix_server.sh`

- [ ] Add MSC4143, MSC3266, MSC4222 experimental features (yq commands in first-boot block)
- [ ] Add `max_event_delay_duration: 24h` for MSC4140
- [ ] Add `rc_delayed_event_mgmt` rate limiting
- [ ] Add `matrix_rtc.transports[0]` with type livekit and livekit_service_url

### Task 4: Update config/element-config.json

**Hypotheses:** H4
**Files:**
- Modify: `config/element-config.json`

- [ ] Add `element_call` block: url, use_exclusively: true, brand
- [ ] Add `features` block: feature_group_calls, feature_video_rooms, feature_element_call_video_rooms

### Task 5: Update .env.example

**Hypotheses:** H2
**Files:**
- Modify: `.env.example`

- [ ] Add LIVEKIT_KEY, LIVEKIT_SECRET, LIVEKIT_INSECURE_SKIP_VERIFY_TLS vars with comments

### Task 6: Update start-matrix.sh with LiveKit credential generation

**Hypotheses:** H2
**Files:**
- Modify: `start-matrix.sh`

- [ ] Add idempotent LIVEKIT_KEY/LIVEKIT_SECRET generation (if not already in .env)

### Task 7: Update Caddyfile.production

**Hypotheses:** H5, H6
**Files:**
- Modify: `Caddyfile.production`

- [ ] Add `org.matrix.msc4143.rtc_foci` to .well-known/matrix/client response
- [ ] Add `/livekit/jwt` and `/livekit/jwt/*` routes to lk-jwt-service:8080
- [ ] Add `/livekit/sfu/*` route to livekit:7880

### Task 8: Update Caddyfile.local

**Hypotheses:** H5, H6
**Files:**
- Modify: `Caddyfile.local`

- [ ] Same pattern as production but with localhost URLs

### Task 9: Deploy to agentic.inblock.io

**Hypotheses:** H1-H8
**Files:**
- Run: `deploy.sh`

- [ ] Commit all changes
- [ ] Tag both repos
- [ ] Deploy with `--build --restart`
- [ ] Apply Synapse config on existing deployment (yq commands via SSH)
- [ ] Generate LIVEKIT_KEY/SECRET in server .env

### Task 10: Open firewall ports

**Hypotheses:** H7

- [ ] Open 7881/tcp on production server
- [ ] Open 50100-50200/udp on production server

### Task 11: Verify end-to-end

**Hypotheses:** H1-H8

- [ ] Verify .well-known includes rtc_foci
- [ ] Verify lk-jwt-service healthz
- [ ] Verify all containers healthy
- [ ] Test actual audio/video call between two users
