---
name: siwx-matrix
description: Use when working on the siwx-oidc-matrix-server deployment stack, understanding how Synapse, siwx-oidc, Element Web, and Redis connect, or when any question touches the Matrix server architecture. Triggers on homeserver config, docker-compose, entrypoint, proxy routing, or service dependency questions.
---

# siwx-matrix: Architecture Context

## What this stack is

A Docker Compose deployment of a Synapse homeserver whose authentication is delegated to siwx-oidc through Synapse's `matrix_authentication_service` integration (the role MAS plays by default). Users sign in with a passkey, an Ethereum wallet (CAIP-122) or, for agents, their own key; there are no passwords. Besides the four services below, the stack runs `livekit` and `lk-jwt-service` for calls (see `/matrix-rtc-transport-specialist`).

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
2. Element takes the homeserver from config.json (`default_server_config`) and asks it for its auth metadata (`GET /_matrix/client/v1/auth_metadata`, or the MSC2965 unstable path on servers older than spec v1.15); Synapse answers with siwx-oidc's discovery document, which names the issuer and its endpoints
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
| CAIP-122 signature verification | siwx-oidc (via the aqua-auth crate) |
| OIDC token issuance (ES256 ID tokens, opaque access/refresh) | siwx-oidc |
| Token introspection (RFC 7662) | siwx-oidc (`/oauth2/introspect`) |
| User/device provisioning | siwx-oidc calls Synapse `/_synapse/mas/*` |
| Matrix protocol (rooms, messages, sync, federation) | Synapse |
| TLS termination, routing | External reverse proxy on `portal-net` (not part of the compose file) |
| Matrix `login`/`logout`/`refresh` endpoints | siwx-oidc (`/_matrix/client/v3/{login,logout,refresh}`); `GET /login` advertises SSO only, there is no password login |

## Configuration flow

```
start-matrix.sh
  |-- generates .env (secrets, hostnames, ports)
  |-- runs docker compose up --pull always (pinned images from GHCR)
       |
       +-- matrix_synapse container:
       |     entrypoints/matrix_server.sh (baked into the image)
       |       first boot only: /start.py generate, server name, listener, retention, notices
       |       every boot: matrix_authentication_service config, MatrixRTC config,
       |                   io.inblock.did denylist + startup guard, admin promotion
       |       runs /start.py (Synapse)
       |
       +-- siwx-oidc container:
       |     reads config from SIWEOIDC_* env vars (legacy prefix, still accepted; SIWXOIDC_* wins)
       |     connects to redis://redis
       |     optionally connects to Synapse at SIWEOIDC_SYNAPSE_ENDPOINT
       |
       +-- element-web container:
       |     entrypoints/element_entrypoint.sh (bind-mounted, like config/element-config.json)
       |       sed templates %%VARS%% in config.json
       |       replaces favicon PNGs for branding
       |       runs nginx
       |
       +-- redis container: appendonly yes
```

## Critical design facts

- **First boot vs every boot**: `homeserver.yaml` is generated once; the first-boot keys (server name, listener, retention, server notices) change only by editing the file inside the `matrix_data` volume. Delegated auth, MatrixRTC and the DID-field denylist are rewritten on every boot. AGENTS.md has the full table.
- **Env prefix**: the stack uses siwx-oidc's legacy `SIWEOIDC_` prefix; siwx-oidc still reads it and prefers `SIWXOIDC_` when both are set.
- **Signing key lifecycle**: P-256 PEM generated once by start-matrix.sh, stored in .env. Access and refresh tokens are opaque Redis entries, so a new key signs no one out; it breaks verification of ID tokens signed with the old key and of every published `io.inblock.did` proof, until each user's next sign-in, unless the old public key is listed in `SIWXOIDC_RETIRED_SIGNING_KEYS_PEM`.
- **Shared secret**: `MAS_SHARED_SECRET` must match between Synapse config and siwx-oidc config. Mismatch causes 401 on every introspection call, breaking all auth.
- **Network topology**: siwx-oidc and Synapse communicate on the Docker `default` network. The `portal-net` external network connects to the reverse proxy.
- **Reverse proxy routing**: The proxy must route `/_matrix/client/v3/{login,logout,logout/all,refresh,delete_devices}` and `DELETE /_matrix/client/v3/devices/{id}` to siwx-oidc (not Synapse); Synapse does not serve login, logout or refresh under delegated auth. Only `DELETE` goes to siwx-oidc on `devices/*`: `GET` and `PUT` of a device stay on Synapse, which siwx-oidc would answer with 405. All other `/_matrix/*` routes go to Synapse, except `/_synapse/admin/*` and `/_synapse/mas/*`, which the proxy must not expose. `Caddyfile.local` has the routes.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Editing matrix_server.sh expecting it to take effect | Nothing changes until the Synapse image is rebuilt (the entrypoint is baked in); first-boot keys never change on an existing volume |
| Mismatched MAS_SHARED_SECRET between services | All auth fails with 401 |
| Deleting .env and recreating (new signing key and secrets) | Published DID proofs stop verifying until each user signs in again; the new `MAS_SHARED_SECRET` needs both Synapse and siwx-oidc recreated |
| Not routing login/logout/refresh to siwx-oidc | Element login fails silently or shows "M_UNKNOWN" |
| Using `--reset` without understanding it | Destroys all data, users, and keys |
| Exposing siwx-oidc port to host | Security risk; should stay Docker-internal |
