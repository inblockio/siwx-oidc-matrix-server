---
name: element-x-mobile-passkey-first
description: Use when setting up, testing, or debugging passkey-first registration/login on Element X mobile (Android/iOS) against the siwx-oidc Matrix stack. Triggers on "Element X", "mobile", "passkey", "did:key", "webauthn mobile", "fingerprint login", "Face ID login", "ASWebAuthenticationSession", "Chrome Custom Tabs".
---

# Element X Mobile: Passkey-First Setup & Debugging

## Architecture overview

Element X mobile authenticates via MSC3861 delegated auth. The system browser
(not a WebView) opens the siwx-oidc login page, where the user registers or
signs in with a passkey. No wallet, no seed phrase, no prior account required.

```
Element X app
  -> /.well-known/matrix/client  (finds homeserver URL)
  -> GET /_matrix/client/v1/auth_metadata  (discovers OIDC issuer)
     (unstable: /_matrix/client/unstable/org.matrix.msc2965/auth_metadata)
  -> Dynamic client registration (POST /register, RFC 7591)
  -> System browser opens /authorize
     scope includes urn:matrix:client:device:<client-generated-id>
     Android: Chrome Custom Tabs
     iOS: ASWebAuthenticationSession
  -> User registers passkey or signs in
  -> Browser redirects back to Element X (custom URI scheme)
  -> Element X exchanges auth code for mat_/mcr_ tokens
  -> Synapse validates tokens via POST /oauth2/introspect
     introspection response includes explicit device_id field
```

## Complete registration flow (new user, passkey only)

```
Step 1:  User enters "matrix.inblock.io" as homeserver in Element X
Step 2:  Element X fetches /.well-known/matrix/client (finds homeserver URL)
Step 3:  Element X fetches /_matrix/client/v1/auth_metadata (discovers OIDC issuer)
         (unstable: /_matrix/client/unstable/org.matrix.msc2965/auth_metadata)
Step 4:  Element X dynamically registers as public OIDC client (PKCE, no secret)
Step 5:  Element X generates a random device_id, includes it in authorize scope:
         urn:matrix:org.matrix.msc2967.client:device:<generated-id>
Step 6:  System browser opens /authorize; session cookie created (verified_did: None)
Step 7:  User taps "Create one" (below "Sign in with Passkey")
Step 8:  POST /webauthn/register/start (requires only session cookie)
         Browser calls navigator.credentials.create()
         User provides biometric (fingerprint, Face ID) or device PIN
Step 9:  POST /webauthn/register/finish
         Server derives did:key from P-256 public key (deterministic)
         Stores credential in Redis: webauthn:credential/{cred_id}
Step 10: Auto-authenticate: handlePasskeySignIn() sets session.verified_did
Step 11: GET /sign_in takes server-verified path (no wallet signature needed)
Step 12: provision_synapse_device() provisions Matrix user + device
         Uses client-proposed device_id from scope if present (oidc.rs:1407-1417)
         Falls back to SIWX_{uuid} only when no device_id is in the scope
Step 13: Authorization code issued, browser redirects to Element X
Step 14: User is logged in, prompted to verify device for E2EE
```

Total user interactions: 4 taps + 1 biometric.

## Device ID lifecycle (MSC2967 scope mechanism)

Per MSC2967, the **client** generates the device_id and proposes it via the
authorization scope. The server does not assign device IDs.

```
Element X generates device_id locally (random, 10+ chars)
  -> Embeds in authorize scope: urn:matrix:org.matrix.msc2967.client:device:<id>
  -> siwx-oidc extracts device_id from scope (oidc.rs:1407-1411)
     Parses both stable prefix:   urn:matrix:client:device:
     and unstable MSC2967 prefix: urn:matrix:org.matrix.msc2967.client:device:
  -> provision_synapse_device() uses the client-proposed ID
  -> Synapse introspection response includes explicit device_id field
     AND the device_id is encoded in the scope string (belt and suspenders)
  -> Element X uses its locally-stored device_id (never reads it from server)
```

If no device_id is found in the scope (e.g., a non-Matrix OIDC client),
siwx-oidc falls back to generating `SIWX_{uuid}`.

Device_id character constraints (MSC2967): `a-z`, `A-Z`, `0-9`, `-`;
minimum 10 characters; exactly one device scope per session.

## Returning user login flow

Same as steps 1-6 above, then:
```
Step 7:  User taps "Sign in with Passkey"
Step 8:  POST /webauthn/authenticate/start
         Browser calls navigator.credentials.get()
         User provides biometric
Step 9:  POST /webauthn/authenticate/finish
         Server verifies assertion, sets session.verified_did
Step 10: GET /sign_in takes server-verified path
Step 11: provision_synapse_device() finds existing user, provisions device
         (uses client-proposed device_id from scope, same as registration)
Step 12: Authorization code, redirect, token exchange
Step 13: User is logged in with fresh device, E2EE verification prompt
```

## Identity model

| Property | did:pkh (wallet) | did:key (passkey) |
|----------|-----------------|------------------|
| Source | Blockchain address | Passkey P-256 public key |
| Format | `did:pkh:eip155:1:0x...` | `did:key:zDn...` |
| Matrix localpart | `did-pkh-eip155-1-0x...` | `did-key-zdn...` |
| Cross-device sync | Via wallet app | Via OS credential manager |
| Blockchain association | Direct | None (optional linking later) |

## Boundary conditions (verified)

| Condition | Status | Detail |
|-----------|--------|--------|
| `did:key` in `supported_did_methods` | OK | Default `["pkh", "key"]` at `config.rs:71` |
| System browser (not WebView) | OK | RFC 8252 mandated; both platforms comply |
| Passkey domain binding | OK | `siwx-oidc.inblock.io` is the RP; system browser opens that domain |
| Synapse MAS API available | OK | Same provisioning path as wallet logins |
| CORS irrelevant for mobile | OK | Native HTTP clients do not enforce CORS |
| Dynamic client registration | OK | `/register` endpoint, no redirect URI scheme restrictions |
| Public client support | OK | `SIWEOIDC_REQUIRE_SECRET=false` in docker-compose.yml |
| Stable device scope prefix | OK | `urn:matrix:client:device:*` advertised in discovery (`oidc.rs:60`) |
| Unstable MSC2967 device scope | OK | `urn:matrix:org.matrix.msc2967.client:device:*` also advertised (`oidc.rs:63`) |
| Device_id extraction from scope | OK | Both prefixes parsed at `oidc.rs:1167-1178` |
| Introspection includes device_id | OK | Explicit field in response (`introspect.rs:109`) + scope string |
| Auth metadata endpoint (MSC2965) | OK | Served by Synapse under MSC3861 delegated auth |
| QR code login (device_code, MSC4108) | OK | `msc4108_enabled = true` in entrypoint; `provision_synapse_device_additive()` handles it |

## Debugging: quick diagnosis

```
Passkey registration fails?
  |
  +-- "Create one" not visible or page won't load
  |     -> System browser issue. Check: is /authorize opening in system browser?
  |     -> If WebView: app is not RFC 8252 compliant (not Element X's fault)
  |     -> Check siwx-oidc container is running: docker compose ps
  |
  +-- Biometric prompt doesn't appear
  |     -> WebAuthn not supported in current browser context
  |     -> Verify system browser (Chrome Custom Tabs / ASWebAuthenticationSession)
  |     -> Check: navigator.credentials.create() requires HTTPS + secure context
  |     -> RP ID mismatch: passkey domain must match siwx-oidc hostname exactly
  |
  +-- "Registration failed" after biometric
  |     -> Check siwx-oidc logs: docker compose logs siwx-oidc --tail=50
  |     -> POST /webauthn/register/finish failed
  |     -> Common: session cookie expired (Redis session gone)
  |     -> Common: attestation verification failed
  |
  +-- Passkey registered but login fails
  |     -> Auto-authenticate step failed
  |     -> Check logs for handlePasskeySignIn errors
  |     -> Check: session.verified_did was set?
  |     -> Redis key: sessions/* should show verified_did after auth
  |
  +-- Login succeeds in browser but Element X shows error
  |     -> Redirect back to app failed
  |     -> Check: custom URI scheme registered correctly?
  |     -> Android: io.element.android:/ (release), io.element.android.debug:/ (debug)
  |     -> iOS: io.element.elementx:/ (uses private-use URI scheme)
  |     -> Note: single slash (:/), not double (://)
  |     -> Token exchange at /token failed (check siwx-oidc logs)
  |
  +-- "M_UNKNOWN" or "M_FORBIDDEN" after successful redirect
  |     -> Token introspection failing at Synapse
  |     -> MAS_SHARED_SECRET mismatch
  |     -> Check (fingerprints only, NEVER print the secret itself):
  |          syn=$(docker compose exec -T matrix_synapse yq -r '.matrix_authentication_service.secret' /data/homeserver.yaml | tr -d '\r\n' | sha256sum | cut -c1-12)
  |          oidc=$(docker compose exec -T siwx-oidc printenv SIWEOIDC_MAS_SHARED_SECRET | tr -d '\r\n' | sha256sum | cut -c1-12)
  |          [ "$syn" = "$oidc" ] && echo "MATCH ($syn)" || echo "MISMATCH: $syn vs $oidc"
  |
  +-- User provisioned but can't send messages / E2EE broken
        -> Device verification needed (expected on every fresh login)
        -> Cross-signing bootstrap required
        -> See /siwx-matrix-device-verify skill
```

## Debugging: log inspection

```bash
# siwx-oidc logs (WebAuthn + OIDC flow)
docker compose logs siwx-oidc --tail=100 2>&1 | grep -iE "webauthn|passkey|register|sign_in|provision|error"

# Synapse logs (user provisioning + introspection)
docker compose logs matrix_synapse --tail=100 2>&1 | grep -iE "provision|introspect|device|error|401"

# Redis state: check session exists
docker compose exec redis redis-cli KEYS 'sessions/*'

# Redis state: check WebAuthn credentials stored
docker compose exec redis redis-cli KEYS 'webauthn:credential/*'

# Redis state: check device mapping
docker compose exec redis redis-cli KEYS 'device_ids/*'

# Inspect a specific session
docker compose exec redis redis-cli HGETALL 'sessions/{session_id}'
```

## Debugging: common problems

### 1. Session cookie not set (mobile browser quirks)

**Symptoms**: /webauthn/register/start returns 401 or "no session".

**Cause**: Some mobile browser configurations block third-party cookies. The
system browser must be on the same domain as the RP.

**Diagnose**:
```bash
docker compose logs siwx-oidc --tail=20 2>&1 | grep -i "session\|cookie"
```

**Fix**: Verify siwx-oidc is served on its own domain (not as a path under the
Matrix host). The session cookie is set for the siwx-oidc domain specifically.

### 2. did:key not in allowed methods

**Symptoms**: Login fails after successful passkey auth. Logs show "unsupported DID method".

**Diagnose**:
```bash
docker compose exec siwx-oidc printenv SIWEOIDC_ALLOWED_DID_METHODS
# Should be unset (defaults to ["pkh", "key"]) or explicitly include "key"
```

**Fix**: If overridden in .env or docker-compose.yml, ensure `"key"` is included.

### 3. Passkey domain mismatch

**Symptoms**: Biometric prompt appears but registration fails with "SecurityError".

**Cause**: The WebAuthn RP ID doesn't match the domain the browser opened.

**Diagnose**: Check the `rp_id` in siwx-oidc WebAuthn config. It must match
`SIWEOIDC_HOST` exactly (minus protocol and port).

### 4. Token exchange fails (public client rejected)

**Symptoms**: Browser redirects back to Element X, but app shows error. siwx-oidc
logs show "Secret required" on POST /token.

**Fix**: Ensure `SIWEOIDC_REQUIRE_SECRET: "false"` in docker-compose.yml.
See /siwx-matrix-troubleshoot problem #8 for details.

### 5. Synapse user provisioning fails

**Symptoms**: Passkey auth succeeds, /sign_in called, but logs show
"provision_user failed" or "connection refused".

**Diagnose**:
```bash
# Can siwx-oidc reach Synapse?
docker compose exec siwx-oidc wget -qO- http://matrix_synapse:8080/health

# Check endpoint config
docker compose exec siwx-oidc printenv SIWEOIDC_SYNAPSE_ENDPOINT
```

**Fix**: Both services must be on the same Docker network. Endpoint should be
`http://matrix_synapse:8080`.

### 6. Redirect back to Element X fails

**Symptoms**: Login completes in browser but browser stays open, or shows
"page not found" instead of returning to Element X.

**Cause**: The redirect URI registered by the dynamic client doesn't match what
the OS can handle.

**Diagnose**:
```bash
# Check registered clients in Redis
docker compose exec redis redis-cli KEYS 'client:*'
# Inspect a specific client registration
docker compose exec redis redis-cli GET 'client:{client_id}'
```

**Verify**: The `redirect_uris` should include the Element X URI scheme for the
platform.

## Code references (siwx-oidc repo)

| Component | File | Lines |
|-----------|------|-------|
| "Create one" UI | `js/ui/src/App.svelte` | 420-428 |
| Registration handler (frontend) | `js/ui/src/App.svelte` | 268-329 |
| Auto sign-in after register | `js/ui/src/App.svelte` | 315-318 |
| register_start (backend) | `src/webauthn.rs` | 111-137 |
| register_finish + DID derivation | `src/webauthn.rs` | 139-181 |
| did_from_passkey | `src/webauthn.rs` | 35-66 |
| authenticate_finish (sets verified_did) | `src/webauthn.rs` | 332-360 |
| extract_device_id_from_scope | `src/oidc.rs` | 1166-1178 |
| Device_id extraction (auth_code flow) | `src/oidc.rs` | 1407-1417 |
| Server-verified sign_in path | `src/oidc.rs` | 1309-1334 |
| allowed_did_methods default | `src/config.rs` | 71 |
| Synapse user provisioning | `src/oidc.rs` | 1186-1234 |
| Additive provisioning (QR/device_code) | `src/oidc.rs` | 1239-1270 |
| Introspection response (device_id field) | `src/introspect.rs` | 106-118 |
| Session creation (no preconditions) | `src/oidc.rs` | 990-1001 |
| Supported scopes (stable + unstable) | `src/oidc.rs` | 55-63 |

## QR code login (device_code grant)

Element X also supports QR code login via RFC 8628 device_code grant (MSC4108).
This uses `provision_synapse_device_additive()` which adds a second device without
deleting the existing one. The scope-based device_id extraction works the same way.

MSC4108 is enabled in `entrypoints/matrix_server.sh:29`. The device_code flow is
handled at `oidc.rs:566-669`. For QR login issues, check the `device_code` paths
in siwx-oidc logs.

## Spec references

| Spec | Topic | Key detail |
|------|-------|------------|
| MSC2964 | Authorization code grant | PKCE S256 mandatory, refresh tokens mandatory |
| MSC2965 | Auth metadata discovery | `/_matrix/client/v1/auth_metadata` endpoint |
| MSC2966 | Dynamic client registration | RFC 7591, `token_endpoint_auth_method: "none"` for public clients |
| MSC2967 | API scopes | `urn:matrix:client:device:<id>` format, client generates device_id |
| MSC3861 | Delegated auth (MAS) | Token introspection, `mat_`/`mcr_` tokens, device provisioning |
| MSC4108 | QR code login | Device_code grant for cross-device login |
| RFC 8252 | OAuth for native apps | System browser required (no WebView) |

## Related skills

- `/siwx-matrix-troubleshoot` -- general stack debugging (non-mobile-specific)
- `/siwx-matrix-device-verify` -- E2EE device verification and cross-signing
- `/siwx-matrix-setup` -- first-time deployment and configuration
