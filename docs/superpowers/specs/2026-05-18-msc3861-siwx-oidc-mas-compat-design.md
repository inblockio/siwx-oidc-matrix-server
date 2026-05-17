# Design: siwx-oidc as MAS-Compatible Auth Service (MSC3861)

## Problem

Every SIWX-OIDC login creates a new "device" in Synapse. Synapse's E2EE cross-signing layer treats device trust as separate from authentication, requiring users to verify each new device or lose access to encrypted history. This creates a redundant second authentication challenge despite the wallet signature already being cryptographically strong.

## Solution

Make siwx-oidc implement the Matrix Authentication Service (MAS) internal API so Synapse delegates all authentication to it via the stable `matrix_authentication_service` config (Synapse 1.136+). siwx-oidc owns device lifecycle and can grant cross-signing trust directly after wallet verification.

## Architecture

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  Element /  │         │    siwx-oidc     │         │  Synapse        │
│  Client     │         │  (MAS-compat)    │         │  (delegated)    │
└──────┬──────┘         └────────┬─────────┘         └────────┬────────┘
       │                         │                            │
       │ 1. OAuth2+PKCE          │                            │
       │    (wallet sign)        │                            │
       │ ───────────────────────>│                            │
       │                         │ 2. provision_user          │
       │                         │    upsert_device           │
       │                         │ ──────────────────────────>│
       │                         │                            │
       │                         │ 3. allow_cross_signing_reset
       │                         │ ──────────────────────────>│
       │                         │                            │
       │<─── access_token ───────│                            │
       │                         │                            │
       │ 4. Matrix C-S API call  │                            │
       │ ────────────────────────────────────────────────────>│
       │                         │                            │
       │                         │<── 5. POST /oauth2/introspect
       │                         │    (validate token)        │
       │                         │ ──────────────────────────>│
       │                         │                            │
       │<───────────── response ──────────────────────────────│
```

## Components

### Synapse Configuration (this repo)

Replaces the current `oidc_providers[]` block with:

```yaml
matrix_authentication_service:
  enabled: true
  endpoint: "http://siwx-oidc:8081"
  secret: "${MAS_SHARED_SECRET}"
```

This disables all other auth methods in Synapse (password, registration, SAML, CAS, JWT). Authentication is fully owned by siwx-oidc.

### siwx-oidc Changes (companion repo)

siwx-oidc gains the following capabilities:

#### New: Token Introspection Endpoint

```
POST /oauth2/introspect
Authorization: Bearer {shared_secret}
Content-Type: application/x-www-form-urlencoded

token=mat_abc123def&token_type_hint=access_token
```

Response:
```json
{
  "active": true,
  "username": "did-pkh-eip155-1-0xabc123",
  "device_id": "SIWX_a1b2c3",
  "scope": "urn:matrix:client:api:* urn:matrix:client:device:SIWX_a1b2c3",
  "sub": "01J...",
  "client_id": "synapse",
  "token_type": "access_token",
  "exp": 1716100000,
  "expires_in": 300,
  "iat": 1716099700
}
```

Implementation: look up opaque token in Redis, return stored metadata. Called on every Synapse request (cached 2 min by Synapse). Must be fast (<10ms).

#### New: Opaque Token Issuance

Replace (or supplement) current JWT tokens with opaque tokens:
- Format: `mat_` prefix + 32 random bytes base62-encoded
- Stored in Redis with key `token:{token_value}` containing: user localpart, device_id, scopes, issued_at, expires_at, client_id
- TTL: 5 minutes (short-lived, refresh via refresh token)
- Refresh tokens: `mcr_` prefix, longer TTL (24h), stored similarly

#### New: PKCE Support (RFC 7636)

Add to existing authorization code flow:
- Client sends `code_challenge` + `code_challenge_method=S256` in authorize request
- Store challenge alongside auth code in Redis
- On token exchange, verify `code_verifier` against stored challenge
- Reject token requests without valid PKCE when client registered as public

#### New: Synapse Provisioning Client

HTTP client that calls Synapse's `/_synapse/mas/` endpoints using the shared secret:

| Lifecycle Event | Synapse Call | When |
|---|---|---|
| First login | `POST /_synapse/mas/provision_user` | User not yet in Synapse |
| Every login | `POST /_synapse/mas/upsert_device` | Session starts |
| Login (new device) | `POST /_synapse/mas/allow_cross_signing_reset` | Wallet verified, grant trust |
| Logout | `POST /_synapse/mas/delete_device` | Session ends |
| Token revoke all | `POST /_synapse/mas/sync_devices` | Reconcile active devices |

#### New: Matrix-Specific OAuth2 Scopes

Tokens include:
- `urn:matrix:client:api:*` (full Matrix client API access)
- `urn:matrix:client:device:{DEVICE_ID}` (binds token to device)
- `urn:synapse:admin:*` (if user is admin, based on config)

#### New: Device ID Generation

- Generate stable device IDs: `SIWX_` + 8 random alphanumeric chars
- Track in Redis per user session: `device:{localpart}:{device_id}` -> session metadata
- On logout/expiry, delete from Redis and call `delete_device` on Synapse

#### Updated: OIDC Discovery

`GET /.well-known/openid-configuration` adds:
```json
{
  "introspection_endpoint": "https://siwx-oidc.example.com/oauth2/introspect",
  "introspection_endpoint_auth_methods_supported": ["bearer"],
  "code_challenge_methods_supported": ["S256"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "none"]
}
```

#### New: Legacy Compatibility Endpoints

Matrix clients that don't support native OIDC need these proxied through Synapse:
- `/_matrix/client/v3/login` (list flows, handle `m.login.sso`)
- `/_matrix/client/v3/logout` (revoke token, delete device)
- `/_matrix/client/v3/refresh` (exchange refresh token)

These are served on the Matrix host domain (`MATRIX_HOST`). The reverse proxy routes these specific paths to siwx-oidc instead of Synapse. siwx-oidc implements them as thin wrappers that translate between legacy Matrix auth format and the internal OAuth2 token lifecycle.

### Deployment Stack Changes (this repo)

#### docker-compose.yml

- `siwx-oidc` service: add `SYNAPSE_ENDPOINT` and `MAS_SHARED_SECRET` env vars
- `matrix_synapse`: remove OIDC client_id/secret env vars, add `MAS_SHARED_SECRET`
- Synapse image: must be >= 1.136 (pin version tag instead of latest)
- Reverse proxy: route `/_matrix/client/v3/login`, `/logout`, `/refresh` to siwx-oidc

#### entrypoints/matrix_server.sh

Replace the `oidc_providers` yq block with:
```bash
yq -i ".matrix_authentication_service.enabled = true" /data/homeserver.yaml
yq -i ".matrix_authentication_service.endpoint = \"http://siwx-oidc:${SIWEOIDC_PORT}\"" /data/homeserver.yaml
yq -i ".matrix_authentication_service.secret = \"${MAS_SHARED_SECRET}\"" /data/homeserver.yaml
```

Remove:
- `oidc_providers[0].*` configuration block
- `MATRIX_OIDC_CLIENT_ID` / `MATRIX_OIDC_SECRET_ID` from .env

Add:
- `MAS_SHARED_SECRET` generation in `start-matrix.sh` (64 random chars)

#### .env changes

Remove:
```
MATRIX_OIDC_CLIENT_ID=...
MATRIX_OIDC_SECRET_ID=...
SIWEOIDC_DEFAULT_CLIENTS=...
```

Add:
```
MAS_SHARED_SECRET=<64-char-random>
```

### Database Considerations

- **Synapse**: Can remain on SQLite for small deployments. The `matrix_authentication_service` config does not require PostgreSQL on the Synapse side.
- **siwx-oidc**: Continues using Redis for token/session storage. No new database needed.
- **No PostgreSQL required**: Unlike running MAS as a separate service (which mandates PostgreSQL), our custom implementation uses Redis, which is already in the stack.

## Auth Flow: Detailed Sequence

### First Login (New User)

1. Client fetches `/.well-known/matrix/client` from Synapse, gets `m.authentication` pointing to siwx-oidc issuer
2. Client starts OAuth2 Authorization Code + PKCE flow:
   - `GET /oauth2/authorize?client_id=element&redirect_uri=...&code_challenge=...&code_challenge_method=S256&scope=urn:matrix:client:api:*&response_type=code`
3. siwx-oidc presents wallet-sign challenge (CAIP-122 message)
4. User signs with wallet (EIP-191 / Ed25519 / P-256)
5. siwx-oidc verifies signature, derives localpart: `did-pkh-eip155-1-0xabc123`
6. siwx-oidc checks with Synapse: `GET /_synapse/mas/is_localpart_available?localpart=did-pkh-eip155-1-0xabc123`
7. User is new -> `POST /_synapse/mas/provision_user` with localpart + display name (ENS or DID)
8. Generate device_id `SIWX_k8m2p4q7`, call `POST /_synapse/mas/upsert_device`
9. Call `POST /_synapse/mas/allow_cross_signing_reset` (first device, no prior keys to verify against)
10. Generate auth code, store in Redis with user/device metadata
11. Redirect client back with auth code
12. Client exchanges code + code_verifier at `POST /oauth2/token`
13. siwx-oidc validates PKCE, generates opaque access token `mat_...`, stores in Redis
14. Returns `{"access_token": "mat_...", "refresh_token": "mcr_...", "expires_in": 300, "device_id": "SIWX_k8m2p4q7"}`
15. Client uses `mat_...` for all Matrix API calls
16. Synapse introspects token on first request, caches result for 2 min

### Returning User (Existing Device via Refresh)

1. Client has refresh token `mcr_...`
2. `POST /oauth2/token` with `grant_type=refresh_token&refresh_token=mcr_...`
3. siwx-oidc validates refresh token in Redis, issues new `mat_...` for same device_id
4. No Synapse provisioning calls needed (user + device already exist)

### Returning User (New Session / Lost Refresh Token)

1. Full OAuth2 + PKCE flow again (steps 1-5 from first login)
2. User already exists -> skip `provision_user`
3. New device_id generated, `upsert_device` called
4. `allow_cross_signing_reset` called -> no verification prompt
5. New tokens issued

### Logout

1. Client calls `POST /oauth2/revoke` with access or refresh token
2. siwx-oidc deletes token from Redis
3. siwx-oidc calls `POST /_synapse/mas/delete_device` for the device_id
4. Client is logged out; Synapse will reject the token on next introspection (returns `{"active": false}`)

## Reverse Proxy Routing

The nginx-proxy must route certain paths to siwx-oidc instead of Synapse:

| Path Pattern | Target | Reason |
|---|---|---|
| `/_matrix/client/*/login` | siwx-oidc | Legacy login flow discovery |
| `/_matrix/client/*/logout` | siwx-oidc | Token revocation |
| `/_matrix/client/*/refresh` | siwx-oidc | Token refresh |
| Everything else under `/_matrix/` | Synapse | Normal Matrix C-S/federation API |
| `/oauth2/*` | siwx-oidc | OAuth2 endpoints (direct, not via Matrix host) |
| `/.well-known/openid-configuration` | siwx-oidc | OIDC discovery |

Note: The siwx-oidc host (`SIWEOIDC_HOST`) already routes to siwx-oidc. The above overrides apply only to the Matrix host (`MATRIX_HOST`) for legacy client compatibility.

## Security

| Concern | Mitigation |
|---|---|
| Shared secret exposure | Generated with 64 random chars, stored in `.env` (chmod 600), passed via env var |
| Introspection endpoint public access | Rejects requests without valid Bearer shared secret |
| Token brute-force | Opaque tokens are 32+ random bytes (256 bits entropy); Redis TTL limits window |
| Device spoofing | device_id is server-generated, never client-supplied |
| Cross-signing reset abuse | Only called after successful wallet signature verification |
| Replay attacks | PKCE prevents auth code interception; tokens are single-use (refresh) or short-lived (access) |

## Migration Path (Existing Deployments)

For deployments currently running with traditional OIDC:

1. Stop the stack
2. Update to new docker-compose.yml + entrypoint (feature branch)
3. Delete `/data/homeserver.yaml` from the `matrix_data` volume (forces re-generation with new config)
4. Existing user accounts in Synapse DB are preserved (same localparts)
5. Users must log in again (old OIDC sessions are invalid under new auth model)
6. On first login, `provision_user` is a no-op (user exists), `upsert_device` creates fresh device

Since this is dev/staging only, a clean reset (`--reset`) is also acceptable.

## Success Criteria

1. Wallet login produces a trusted session with no verification prompt
2. Cross-signing reset happens automatically without secondary auth challenge
3. Subsequent logins on new clients are seamless (no "verify this device" dialog)
4. Token introspection responds in <10ms (Redis lookup + shared secret comparison)
5. Legacy Matrix clients (Element Web with traditional login) can authenticate via compat endpoints
6. `docker compose up` works end-to-end on the feature branch
7. Master branch remains deployable with current traditional OIDC throughout development

## Out of Scope

- Full MAS admin API (user management REST API)
- Account management UI (self-service sessions/emails/passwords)
- Policy engine (OPA/WASM)
- Dynamic client registration (RFC 7591) (can be added later)
- Device authorization grant / RFC 8628 (CLI login; can be added later)
- PostgreSQL migration for Synapse (stays on SQLite)
- Federation testing (focus is on client-server auth UX)

## Branch Strategy

| Repo | Branch | Contains |
|---|---|---|
| `inblockio/siwx-oidc` | `feat/msc3861` | Introspection endpoint, PKCE, opaque tokens, Synapse provisioning client, device management, compat endpoints |
| `inblockio/siwx-oidc-matrix-server` | `feat/msc3861` | New Synapse config, updated entrypoint, shared secret generation, proxy routing, updated docker-compose |

Both branches are developed in parallel. Integration testing happens with both on their feature branches. Merge to master when the full flow works end-to-end.

## Dependencies

- Synapse >= 1.136.0 (stable `matrix_authentication_service` config)
- siwx-oidc: `reqwest` or `hyper` HTTP client (for Synapse provisioning calls)
- siwx-oidc: PKCE implementation (SHA-256 of code_verifier, standard)
- Redis: already in stack, no version constraints
