---
name: siwx-matrix
description: Use when working on the siwx-oidc-matrix-server deployment stack, understanding how Synapse, siwx-oidc, Element Web, and Redis connect, or when any question touches the Matrix server architecture. Triggers on homeserver config, docker-compose, entrypoint, proxy routing, or service dependency questions.
---

# siwx-matrix: Architecture Context

## What this stack is

A Docker Compose deployment that wires four services into an MSC3861-delegated Matrix homeserver where users authenticate with cryptographic wallet signatures (CAIP-122) instead of passwords.

## Service dependency chain

```
element-web (UI)
    |
    v
matrix_synapse (homeserver, port 8080)
    |--- delegates ALL auth to siwx-oidc via matrix_authentication_service config
    |--- validates tokens via POST /oauth2/introspect (Bearer: MAS_SHARED_SECRET)
    v
siwx-oidc (OIDC provider, port 8081)
    |--- stores sessions, tokens, device IDs, WebAuthn credentials
    |--- calls /_synapse/mas/* to provision users and devices
    v
redis (persistence, AOF-enabled)
```

## How login works (end to end)

1. User opens Element at `https://{CLIENT_HOST}`
2. Element reads `m.authentication.issuer` from config.json, discovers OIDC at `{issuer}/.well-known/openid-configuration`
3. Element starts authorization_code + PKCE flow: redirects to `{issuer}/authorize`
4. siwx-oidc serves the login UI (wallet connect or passkey)
5. User signs CAIP-122 challenge with wallet (or authenticates via WebAuthn passkey)
6. siwx-oidc verifies signature, provisions user in Synapse via `/_synapse/mas/provision_user`, creates device via `/_synapse/mas/upsert_device`
7. siwx-oidc issues auth code, redirects back to Element
8. Element exchanges code for tokens at `/token` (receives `mat_` access + `mcr_` refresh tokens)
9. Element uses `mat_` tokens for all Matrix API calls
10. Synapse validates each request by calling `POST /oauth2/introspect` on siwx-oidc

## Key boundaries

| Concern | Handled by |
|---|---|
| CAIP-122 signature verification | siwx-oidc (via siwx-core crypto layer) |
| OIDC token issuance (ES256 ID tokens, opaque access/refresh) | siwx-oidc |
| Token introspection (RFC 7662) | siwx-oidc (`/oauth2/introspect`) |
| User/device provisioning | siwx-oidc calls Synapse `/_synapse/mas/*` |
| Matrix protocol (rooms, messages, sync, federation) | Synapse |
| TLS termination, routing | External reverse proxy (Caddy or nginx) |
| Login/logout/refresh compat for legacy clients | siwx-oidc (`/_matrix/client/v3/{login,logout,refresh}`) |

## Configuration flow

```
start-matrix.sh
  |-- generates .env (secrets, hostnames, ports)
  |-- runs docker compose up --build
       |
       +-- matrix_synapse container:
       |     entrypoints/matrix_server.sh
       |       if first boot: yq writes homeserver.yaml with matrix_authentication_service config
       |       every boot: promote MATRIX_ADMIN_DID if set
       |       runs /start.py (Synapse)
       |
       +-- siwx-oidc container:
       |     reads config from SIWEOIDC_* env vars (Figment: env > toml)
       |     connects to redis://redis
       |     optionally connects to Synapse at SIWEOIDC_SYNAPSE_ENDPOINT
       |
       +-- element-web container:
       |     entrypoints/element_entrypoint.sh
       |       sed templates %%VARS%% in config.json
       |       replaces favicon PNGs for branding
       |       runs nginx
       |
       +-- redis container: appendonly yes
```

## Critical design facts

- **First-boot only**: homeserver.yaml is generated once. To change config on an existing deployment, edit the file inside the `matrix_data` volume directly.
- **Env prefix**: `SIWEOIDC_` (historical, kept for backward compat with siwe-oidc).
- **Signing key lifecycle**: P-256 PEM generated once by start-matrix.sh, stored in .env. If lost, all issued tokens become invalid.
- **Shared secret**: `MAS_SHARED_SECRET` must match between Synapse config and siwx-oidc config. Mismatch causes 401 on every introspection call, breaking all auth.
- **Network topology**: siwx-oidc and Synapse communicate on the Docker `default` network. The `portal-net` external network connects to the reverse proxy.
- **Reverse proxy routing**: The proxy must route `/_matrix/client/v3/{login,logout,refresh}` to siwx-oidc (not Synapse), because Synapse disables these endpoints under MSC3861. All other `/_matrix/*` routes go to Synapse.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Editing matrix_server.sh expecting it to take effect | Nothing changes (homeserver.yaml already exists) |
| Mismatched MAS_SHARED_SECRET between services | All auth fails with 401 |
| Deleting .env and recreating (new signing key) | All existing tokens invalidated |
| Not routing login/logout/refresh to siwx-oidc | Element login fails silently or shows "M_UNKNOWN" |
| Using `--reset` without understanding it | Destroys all data, users, and keys |
| Exposing siwx-oidc port to host | Security risk; should stay Docker-internal |
