# Deployment Recovery Reference

Last verified: 2026-05-24
Stack: siwx-oidc-matrix-server (MSC3861 delegated auth)

## Server Identity

| Field | Value |
|---|---|
| Domain | agentic.inblock.io |
| IP (as of 2026-05-24) | 142.93.168.4 (DNS A record) |
| Previous IP | 139.59.144.60 |
| Provider | DigitalOcean (inferred from IP range) |
| SSH user | deploy |
| SSH key | ~/.ssh/id_ed25519 |
| SSH port | 22 (standard) |

## Remote Directory Layout

```
/home/deploy/matrix/
  stack/                          # siwx-oidc-matrix-server repo (cloned by deploy.sh)
    .env                          # CRITICAL: all secrets, chmod 600
    docker-compose.yml
    start-matrix.sh
    dockerfiles/
    entrypoints/
    config/
  siwx-oidc/                     # siwx-oidc repo (cloned by deploy.sh)

/home/portal/portal/
  Caddyfile                       # TLS + reverse proxy for all services

/var/lib/docker/volumes/
  matrix_matrix_data/_data/       # Synapse DB (homeserver.db) + homeserver.yaml + signing keys
  matrix_redis_data/_data/        # Redis persistence (sessions, device mappings)
```

## Docker Network

External network `portal-net` connects all Matrix containers to the Caddy proxy
(`portal-caddy-1`). This network is created by the portal infrastructure, not
by docker-compose.yml.

## Services (COMPOSE_PROJECT_NAME=matrix)

| Container | Image | Internal Port | External Domain |
|---|---|---|---|
| matrix-matrix_synapse-1 | ghcr.io/inblockio/siwx-oidc-matrix-server/synapse:main | 8080 | matrix.inblock.io |
| matrix-siwx-oidc-1 | ghcr.io/inblockio/siwx-oidc:main | 8081 | siwx-oidc.inblock.io |
| matrix-element-web-1 | ghcr.io/inblockio/siwx-oidc-matrix-server/element-web:main | 8080 | element.inblock.io |
| matrix-redis-1 | redis | 6379 | (internal) |
| matrix-livekit-1 | livekit/livekit-server:latest | 7880 WS, 7881 TCP | matrix.inblock.io/livekit/* |
| matrix-lk-jwt-service-1 | ghcr.io/element-hq/lk-jwt-service:latest | 8080 | matrix.inblock.io/livekit/jwt |
| matrix-watchtower-1 | (watchtower) | - | - |

## Secrets Inventory (names only, values in .env on server)

**Critical (never regenerate, tokens become invalid):**
- `SIWEOIDC_SIGNING_KEY_PEM` - ES256 P-256 private key, single-line PEM with \n escapes
- `MAS_SHARED_SECRET` - 64-char random string, shared between Synapse and siwx-oidc

**Important (regeneration breaks active sessions only):**
- `LIVEKIT_KEY` - format: API + 16 hex chars
- `LIVEKIT_SECRET` - 32-byte base64

**Configurable (safe to change):**
- `SIWEOIDC_HOST=siwx-oidc.inblock.io`
- `SIWEOIDC_PORT=8081`
- `SIWEOIDC_BASE_URL=https://siwx-oidc.inblock.io`
- `SIWEOIDC_REQUIRE_SECRET=false`
- `MATRIX_HOST=matrix.inblock.io`
- `MATRIX_PORT=8080`
- `MATRIX_BASE_URL=https://matrix.inblock.io`
- `MATRIX_REPORT_STATS=no`
- `MATRIX_MESSAGE_LIFETIME=4w`
- `CLIENT_HOST=element.inblock.io`
- `RUST_LOG=siwx_oidc=info,tower_http=info`
- `IMAGE_TAG=main`
- `COMPOSE_PROJECT_NAME=matrix`

**Optional:**
- `MATRIX_ADMIN_DID` - DID for auto-admin promotion on every boot
- `LIVEKIT_INSECURE_SKIP_VERIFY_TLS` - only for local dev

## Caddy Routing (as deployed)

The Caddyfile.production in this repo is the source of truth for Caddy routing.
deploy.sh appends these entries to `/home/portal/portal/Caddyfile` on the server.
Key routing decisions:

- `matrix.inblock.io` routes login/logout/refresh to siwx-oidc, everything else to Synapse
- `.well-known/matrix/client` includes `m.authentication.issuer` for OIDC discovery
- `.well-known/matrix/server` delegates federation to port 443
- LiveKit WebSocket signaling at `/livekit/sfu/*`, JWT exchange at `/livekit/jwt`
- MSC4108 QR code rendezvous at `/_matrix/client/unstable/org.matrix.msc4108/*`
- CORS: public (`*`) on siwx-oidc and Matrix login/logout endpoints

## Synapse First-Boot Configuration

The entrypoint (`entrypoints/matrix_server.sh`) generates `homeserver.yaml`
only on first boot. After that, the file in the `matrix_data` volume is
authoritative. Key settings baked in:

- MSC3861 delegated auth (issuer, client_id `0000000000000000000SYNAPSE`, introspection)
- MSC4108 QR code login enabled
- MSC4143/3266/4222 MatrixRTC with LiveKit SFU
- MSC4140 delayed events
- Message retention: 4 weeks
- Federation via .well-known delegation (no direct TLS on 8448)
- SQLite database (at /data/homeserver.db)

## Recovery Procedures

### If SSH is restored
```bash
./deploy.sh main --build --restart
# Verify:
curl -sf https://siwx-oidc.inblock.io/.well-known/openid-configuration | jq .issuer
curl -sf https://matrix.inblock.io/_matrix/client/versions | jq '.versions[-1]'
curl -sf -o /dev/null -w '%{http_code}' https://element.inblock.io
```

### If server is lost (full rebuild on new VPS)
1. Provision new VPS, point DNS for matrix/siwx-oidc/element.inblock.io to new IP
2. Install Docker + Docker Compose
3. Create deploy user, install SSH key
4. Create portal-net Docker network
5. Set up Caddy container (portal-caddy-1) with the Caddyfile.production from this repo
6. Run `./deploy.sh main --build --restart` to clone repos and start containers
7. SSH in and run `start-matrix.sh` to generate new secrets (.env)
8. All user sessions will be invalidated (new signing key)
9. E2EE history will be lost unless matrix_data volume was backed up
10. Users must re-register (new Synapse database)

### If only siwx-oidc needs rebuild
```bash
# Trigger CI build
gh workflow run docker.yml --ref main --repo inblockio/siwx-oidc
# Wait, then deploy
./deploy.sh main --build --restart
```

## Data Loss Impact Assessment

| Data | Location | Backed Up? | Impact if Lost |
|---|---|---|---|
| Synapse DB (users, rooms, messages) | matrix_data volume | No | All history, accounts, room state lost |
| homeserver.yaml | matrix_data volume | No | Must regenerate from entrypoint (first-boot) |
| Synapse signing keys | matrix_data volume | No | Federation identity changes; other servers reject |
| OIDC signing key | .env file | No | All tokens invalidated; users must re-login |
| MAS shared secret | .env file | No | Synapse cannot introspect tokens; regenerate in both |
| Redis data | redis_data volume | No | Active sessions lost; users must re-login |
| LiveKit keys | .env file | No | Active calls drop; regenerate |
| Caddy TLS certs | portal volumes | Auto-renewed | ACME re-issues within minutes |

## Deployed Versions (as of 2026-05-24)

| Component | Commit | Key Change |
|---|---|---|
| siwx-oidc | 266a4bd | Matrix scopes in OIDC discovery |
| matrix-server stack | 0493c37 | OIDC callback race fix |
