---
name: siwx-matrix-troubleshoot
description: Use when debugging Matrix server login failures, OIDC errors, token introspection problems, Element connection issues, container startup failures, or any operational issue with the siwx-oidc-matrix-server stack. Triggers on "error", "not working", "can't login", "401", "502", "connection refused", "token invalid".
---

# siwx-matrix-troubleshoot: Debugging Guide

## Quick diagnosis flow

```
Login fails?
  |
  +-- Element shows blank or "Unable to load"
  |     -> Check: element-web container running? Config templated correctly?
  |     -> curl https://{CLIENT_HOST}/ (should return HTML)
  |
  +-- Element redirects to OIDC but gets error
  |     -> Check: OIDC discovery works?
  |     -> curl https://{SIWEOIDC_HOST}/.well-known/openid-configuration
  |     -> If 502/503: siwx-oidc container not running or proxy misconfigured
  |
  +-- Wallet signs but login fails after redirect
  |     -> Check siwx-oidc logs: docker compose logs siwx-oidc --tail=50
  |     -> Common: "Nonce mismatch" (session expired), "Signature verification failed"
  |
  +-- Token exchange 400: "invalid_client" / "Secret required"
  |     -> Public client (Element) registered with token_endpoint_auth_method: "none"
  |        but siwx-oidc requires a secret (SIWEOIDC_REQUIRE_SECRET=true or code bug)
  |     -> See problem #8 below
  |
  +-- Element says "M_UNKNOWN" or "M_FORBIDDEN" after login
  |     -> Token introspection failing
  |     -> Check: MAS_SHARED_SECRET matches between services
  |     -> docker compose logs matrix_synapse --tail=50 (look for 401 on introspect)
  |
  +-- "User not found" or profile missing
        -> Synapse provisioning failed
        -> Check siwx-oidc logs for "provision_user failed"
        -> Verify SIWEOIDC_SYNAPSE_ENDPOINT reaches Synapse
```

## Service health checks

```bash
# All services running?
docker compose ps

# siwx-oidc OIDC discovery
docker compose exec siwx-oidc wget -qO- http://127.0.0.1:8081/.well-known/openid-configuration

# Synapse health
docker compose exec matrix_synapse curl -sf http://localhost:8080/health

# Redis connectivity
docker compose exec redis redis-cli ping

# Element config (check templating worked)
docker compose exec element-web cat /app/config.json
```

## Common problems and fixes

### 1. MAS_SHARED_SECRET mismatch

**Symptoms**: Every API call returns 401. Synapse logs show introspection failures.

**Diagnose**:
```bash
# Compare WITHOUT printing either secret. The question is only "do they match?",
# which a fingerprint answers. NEVER echo the value: anything printed in an agent
# session is transmitted off-machine.
syn=$(docker compose exec -T matrix_synapse yq -r '.matrix_authentication_service.secret' \
        /data/homeserver.yaml | tr -d '\r\n' | sha256sum | cut -c1-12)
oidc=$(docker compose exec -T siwx-oidc printenv SIWEOIDC_MAS_SHARED_SECRET \
        | tr -d '\r\n' | sha256sum | cut -c1-12)
[ "$syn" = "$oidc" ] && echo "MATCH ($syn)" || echo "MISMATCH: synapse=$syn oidc=$oidc"
```

**Fix**: The Synapse entrypoint rewrites `matrix_authentication_service.secret` from
`MAS_SHARED_SECRET` on every boot, so a mismatch means the two containers were started
from different `.env` contents. Recreate both from the current `.env`:
`docker compose up -d --force-recreate matrix_synapse siwx-oidc`.

### 2. Reverse proxy not routing login/logout/refresh to siwx-oidc

**Symptoms**: Element login flow returns "M_UNRECOGNIZED" or hangs. Synapse does not serve `/_matrix/client/v3/{login,logout,refresh}` under delegated auth; siwx-oidc does.

**Diagnose**:
```bash
# Should return {"flows": [{"type": "m.login.sso", ...}]}
curl -s https://{MATRIX_HOST}/_matrix/client/v3/login | jq .

# If you get 404 or Synapse error, the route goes to Synapse instead of siwx-oidc
```

**Fix**: Route these paths, plus `/_matrix/client/v3/logout/all`,
`/_matrix/client/v3/delete_devices` and `DELETE /_matrix/client/v3/devices/{id}`, to
siwx-oidc:8081. Match the method on `devices/*`: siwx-oidc serves only `DELETE` there,
so a `GET` or `PUT` of a device routed to it answers 405 (renaming a session fails).
`Caddyfile.local` has the blocks.

### 3. CORS errors in browser console

**Symptoms**: Element shows network errors. Browser console shows `Access-Control-Allow-Origin` blocked.

**Fix**: The reverse proxy must set CORS headers:
- `siwx-oidc.example.com`: Allow origin `https://element.example.com`
- `matrix.example.com`: Allow origin `https://element.example.com`
- `.well-known/matrix/client`: Allow origin `*` (clients read it cross-origin)

If the console complains about **multiple** `Access-Control-Allow-Origin` values, the
proxy is passing siwx-oidc's own CORS headers through next to its own: strip them in the
`reverse_proxy` block (`strip_upstream_cors` in `Caddyfile.local`).

### 4. homeserver.yaml not updated after entrypoint change

**Symptoms**: Synapse still uses old config despite entrypoint changes.

**Cause**: Two possibilities. The entrypoint is baked into the Synapse image, so an edit
to `entrypoints/matrix_server.sh` does nothing until the image is rebuilt and the
container recreated. And the first-boot keys (server name, listener, retention, server
notices) are only written when `/data/homeserver.yaml` does not exist yet; delegated
auth, MatrixRTC and the DID-field denylist are rewritten on every boot.

**Diagnose**:
```bash
docker compose exec matrix_synapse yq '.matrix_authentication_service.enabled, .retention' /data/homeserver.yaml
```

**Fix** for a first-boot key: edit homeserver.yaml inside the volume directly:
```bash
docker compose exec matrix_synapse yq -i '.key.path = "new_value"' /data/homeserver.yaml
docker compose restart matrix_synapse
```

### 5. siwx-oidc cannot reach Synapse (provisioning fails)

**Symptoms**: Login succeeds at OIDC level but user has no profile in Matrix. siwx-oidc logs show "provision_user failed" or connection refused.

**Diagnose**:
```bash
# Test connectivity from siwx-oidc to Synapse
docker compose exec siwx-oidc wget -qO- http://matrix_synapse:8080/health
```

**Fix**: Both services must be on the same Docker network. Check docker-compose.yml `networks` section.

### 6. Signing key lost (new .env generated)

**Symptoms**: Signed-in users stay signed in: access and refresh tokens are opaque Redis
entries that do not depend on the key. What fails is verification against siwx-oidc's
JWKS: an ID token signed with the old key (a sign-in in flight during the change), and
every `io.inblock.did` proof already in a user's profile (`siwx-oidc-auth --verify-did`
reports a `kid` that is not in the JWKS) until that user's next sign-in publishes a new
one.

**Prevention**: Back up `.env` before any destructive operation.

**Recovery**: The old private key cannot be recovered. If you still have the old key or
its public half, list the public half in `SIWXOIDC_RETIRED_SIGNING_KEYS_PEM` so the old
proofs keep verifying (siwx-oidc, [Key rotation](https://github.com/inblockio/siwx-oidc/blob/main/docs/configuration.md#key-rotation)); `docker-compose.yml` does not
pass that variable through, so add it to the `siwx-oidc` service's `environment`. If the
whole `.env` was regenerated, `MAS_SHARED_SECRET` changed too; the Synapse entrypoint
writes the new value at its next boot, so recreate both `matrix_synapse` and `siwx-oidc`.

### 7. Redis data lost

**Symptoms**: All sessions, tokens and WebAuthn credentials gone. Every user must sign in again and re-register passkeys.

**Diagnose**:
```bash
docker compose exec redis redis-cli DBSIZE
# Should return non-zero for an active deployment
```

**Prevention**: The `redis_data` volume uses AOF persistence. Do not use `--reset` unless you intend to destroy everything.

### 8. Token exchange rejects public clients ("Secret required")

**Symptoms**: Browser console shows `POST /token` returns 400 `{"error":"invalid_client","error_description":"Secret required."}`. Element then shows "We asked the browser to remember which homeserver... but your browser has forgotten it." The second error is a red herring; the real failure is the token exchange.

**Cause**: Element Web registers via `/register` with `token_endpoint_auth_method: "none"` (public client, PKCE only). If siwx-oidc's token endpoint doesn't respect the per-client auth method and falls back to the global `require_secret` flag (default `true`), it rejects all requests without a secret.

**Diagnose**:
```bash
# Check if require_secret is overridden
docker compose exec siwx-oidc printenv SIWEOIDC_REQUIRE_SECRET
# Should be "false"
```

**Fix**: Ensure `SIWEOIDC_REQUIRE_SECRET: "false"` is set in docker-compose.yml for the siwx-oidc service. The code fix (oidc.rs) also checks the client's registered `token_endpoint_auth_method` so public clients work regardless of the global flag.

## Log inspection

```bash
# Tail all services
docker compose logs -f --tail=50

# Specific service with timestamps
docker compose logs -f --tail=100 siwx-oidc 2>&1 | grep -i error

# Synapse introspection failures
docker compose logs matrix_synapse 2>&1 | grep -i "introspect\|401\|auth"

# Redis operations
docker compose exec redis redis-cli MONITOR  # live command stream (Ctrl+C to stop)
```

## Redis inspection

```bash
# Active sessions
docker compose exec redis redis-cli --scan --pattern 'sessions/*'

# Active tokens (access and refresh)
docker compose exec redis redis-cli --scan --pattern 'token/*'

# Tokens per user and device (the revocation index)
docker compose exec redis redis-cli --scan --pattern 'idx:user_device/*'

# WebAuthn credentials
docker compose exec redis redis-cli --scan --pattern 'webauthn:credential/*'

# Inspect a specific key
docker compose exec redis redis-cli GET 'token/mat_XXXX'

# The full keyspace: siwx-oidc docs/architecture.md, "Redis keyspace"
```
