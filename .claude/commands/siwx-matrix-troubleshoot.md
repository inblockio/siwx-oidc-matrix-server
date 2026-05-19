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
# Check what Synapse has
docker compose exec matrix_synapse yq '.matrix_authentication_service.secret' /data/homeserver.yaml

# Check what siwx-oidc receives
docker compose exec siwx-oidc printenv SIWEOIDC_MAS_SHARED_SECRET
```

**Fix**: If they differ, update homeserver.yaml to match .env, then restart Synapse.

### 2. Reverse proxy not routing login/logout/refresh to siwx-oidc

**Symptoms**: Element login flow returns "M_UNRECOGNIZED" or hangs. Synapse disables `/_matrix/client/v3/{login,logout,refresh}` under MSC3861.

**Diagnose**:
```bash
# Should return {"flows": [{"type": "m.login.sso", ...}]}
curl -s https://{MATRIX_HOST}/_matrix/client/v3/login | jq .

# If you get 404 or Synapse error, the route goes to Synapse instead of siwx-oidc
```

**Fix**: Add proxy rules to route these three paths to siwx-oidc:8081.

### 3. CORS errors in browser console

**Symptoms**: Element shows network errors. Browser console shows `Access-Control-Allow-Origin` blocked.

**Fix**: The reverse proxy must set CORS headers:
- `siwx-oidc.example.com`: Allow origin `https://element.example.com`
- `matrix.example.com`: Allow origin `https://element.example.com`
- `.well-known/matrix/client`: Allow origin `*` (federation requirement)

### 4. homeserver.yaml not updated after entrypoint change

**Symptoms**: Synapse still uses old config despite entrypoint changes.

**Diagnose**:
```bash
docker compose exec matrix_synapse cat /data/homeserver.yaml | head -50
```

**Fix**: Edit homeserver.yaml inside the volume directly:
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

**Symptoms**: All existing tokens stop working. Users must re-login.

**Prevention**: Back up `.env` before any destructive operation.

**Recovery**: There is no recovery for the old key. Users re-login and get new tokens. If the signing key in .env was regenerated, Synapse's homeserver.yaml still has the old MAS_SHARED_SECRET, so also update that.

### 7. Redis data lost

**Symptoms**: All sessions, tokens, device IDs, and WebAuthn credentials gone. Every user must re-register passkeys.

**Diagnose**:
```bash
docker compose exec redis redis-cli DBSIZE
# Should return non-zero for an active deployment
```

**Prevention**: The `redis_data` volume uses AOF persistence. Do not use `--reset` unless you intend to destroy everything.

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
docker compose exec redis redis-cli KEYS 'sessions/*'

# Active tokens
docker compose exec redis redis-cli KEYS 'token:*'

# Device ID mappings
docker compose exec redis redis-cli KEYS 'device:*'

# WebAuthn credentials
docker compose exec redis redis-cli KEYS 'webauthn:credential/*'

# Inspect a specific key
docker compose exec redis redis-cli GET 'token:mat_XXXX'
```
