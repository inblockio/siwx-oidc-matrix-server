# MSC3861 Implementation: Orchestrator Handover

## Context

This document is a self-contained briefing for an orchestrator session that will implement the MSC3861 integration using parallel agents. Read the design spec at `docs/superpowers/specs/2026-05-18-msc3861-siwx-oidc-mas-compat-design.md` for full architectural context.

**Goal**: Make siwx-oidc act as a MAS-compatible auth service so Synapse delegates all authentication to it. This eliminates the cross-signing verification prompt that currently plagues every login.

**Success gate**: `cargo test --test e2e_msc3861` passes against a fresh `docker compose up`.

## Repositories

| Repo | Location | Branch | Remote |
|---|---|---|---|
| siwx-oidc-matrix-server | `/home/system-001/siwx-oidc-matrix-server` | create `feat/msc3861` from `master` | `git@github.com:inblockio/siwx-oidc-matrix-server.git` |
| siwx-oidc | **NOT CLONED** - clone to `/home/system-001/siwx-oidc` | create `feat/msc3861` from `main` | `git@github.com:inblockio/siwx-oidc.git` |
| aqua-rs-auth | `/home/system-001/aqua-rs-auth` | use as dependency (path or crates.io) | local |

**First step**: Clone siwx-oidc if not present:
```bash
cd /home/system-001
git clone git@github.com:inblockio/siwx-oidc.git
cd siwx-oidc
git checkout -b feat/msc3861
```

## Shared Dependency: aqua-rs-auth

**Crate name**: `aqua-auth` (at `/home/system-001/aqua-rs-auth`)

aqua-rs-auth is inblock.io's universal CAIP-122 authentication library. It provides the cryptographic primitives that both siwx-oidc and the integration test need. Using it eliminates duplicate crypto code and guarantees that server and test produce/verify identical message formats.

### What aqua-auth provides (use these, don't reimplement)

| Function | Purpose | Used by |
|---|---|---|
| `verify_caip122(did, message, signature)` | Dispatch signature verification (EIP-191, Ed25519, P-256) | siwx-oidc server |
| `build_message(MessageParams)` | Construct spec-compliant CAIP-122 messages | siwx-oidc server + test |
| `address_from_verifying_key(key)` | Derive Ethereum address from k256 key | Integration test |
| `eip55_checksum(addr)` | EIP-55 checksum an address | Both |
| `address_from_did(did)` | Extract address bytes from eip155 DID | siwx-oidc server |
| `identifier_from_did(did)` | Extract the identifier portion for localpart derivation | siwx-oidc server |
| `parse_did_namespace(did)` | Determine which verifier to use | siwx-oidc server |
| `client::authenticate(http, base_url, did, sign_fn)` | Drive full challenge-response flow (feature: `client`) | Integration test |

### What aqua-auth does NOT own (stays in siwx-oidc)

| Concern | Why not in aqua-auth |
|---|---|
| Redis storage (tokens, sessions, challenges) | aqua-auth is storage-agnostic; siwx-oidc owns its Redis backend |
| Synapse provisioning HTTP calls | Matrix-specific; not generic auth |
| OIDC token issuance (mat_, mcr_ tokens) | Protocol-specific to Matrix/MAS |
| HTTP route handlers (Axum) | aqua-auth is transport-agnostic |

### Design principle

aqua-auth = **pure crypto + protocol types + message format**. Storage and transport are the consumer's concern. If a pluggable storage trait is needed later, it goes in aqua-auth as a trait; Redis impl stays in siwx-oidc.

### Cargo.toml additions for siwx-oidc

```toml
[dependencies]
aqua-auth = { path = "../aqua-rs-auth" }
# OR when published: aqua-auth = "0.1"

[dev-dependencies]
aqua-auth = { path = "../aqua-rs-auth", features = ["client"] }
```

### Impact on siwx-oidc code

When agents modify siwx-oidc's signature verification or message construction:
1. **Replace** any custom `verify_eip191`, `verify_ed25519`, `verify_p256` with `aqua_auth::verify_caip122`
2. **Replace** custom DID parsing with `aqua_auth::{address_from_did, identifier_from_did, parse_did_namespace}`
3. **Replace** custom CAIP-122 message building with `aqua_auth::build_message`
4. **Verify** that the existing siwx-oidc message format matches aqua-auth's output (compare a known test vector). If they differ, align on aqua-auth's format (it's spec-compliant).
5. If siwx-oidc has helper functions like `eth_address_from_key` or `eip55_checksum`, replace with aqua-auth equivalents

## Parallelization Map

```
Wave 1 (4 independent agents):
┌─────────────────────┐  ┌──────────────────────┐  ┌─────────────────────────┐  ┌────────────────────────┐
│ Agent A:            │  │ Agent B:             │  │ Agent C:                │  │ Agent D:               │
│ Introspection +    │  │ PKCE Support         │  │ Synapse Provisioning    │  │ Deployment Config      │
│ Opaque Tokens      │  │                      │  │ Client                  │  │ (this repo)            │
│ (siwx-oidc)        │  │ (siwx-oidc)          │  │ (siwx-oidc)             │  │                        │
└─────────────────────┘  └──────────────────────┘  └─────────────────────────┘  └────────────────────────┘
         │                        │                          │                           │
         ▼                        ▼                          ▼                           ▼
Wave 2 (after Wave 1 merges into feat/msc3861):
┌──────────────────────────────────┐  ┌──────────────────────────────────────┐
│ Agent E:                         │  │ Agent F:                             │
│ Legacy Compat Endpoints +        │  │ OIDC Discovery Update +              │
│ Token Revocation                 │  │ Device ID Lifecycle                  │
│ (siwx-oidc)                      │  │ (siwx-oidc)                          │
└──────────────────────────────────┘  └──────────────────────────────────────┘
         │                                       │
         ▼                                       ▼
Wave 3 (integration, after all siwx-oidc work is on feat/msc3861):
┌────────────────────────────────────────────────────────────────────────────┐
│ Agent G: Integration Test (Rust e2e test)                                  │
│ Runs docker compose up with both repos on feat/msc3861, executes test      │
└────────────────────────────────────────────────────────────────────────────┘
```

## Agent Prompts

### Agent A: Token Introspection + Opaque Tokens

**Repo**: `/home/system-001/siwx-oidc` (branch: `feat/msc3861`)
**Isolation**: worktree

**Task**: Add a `POST /oauth2/introspect` endpoint and switch token issuance from JWT to opaque tokens stored in Redis.

**Acceptance criteria**:
1. `POST /oauth2/introspect` accepts `Authorization: Bearer {shared_secret}`, body `token=X&token_type_hint=access_token`
2. Returns RFC 7662 JSON: `{active, username, device_id, scope, sub, client_id, token_type, exp, expires_in, iat}`
3. Returns `{"active": false}` for unknown/expired tokens
4. Rejects requests without valid Bearer token (401)
5. Reads `MAS_SHARED_SECRET` from env var (new config field)
6. Access tokens: `mat_` prefix + 32 random bytes base62, stored in Redis with TTL 300s
7. Refresh tokens: `mcr_` prefix + 32 random bytes base62, stored in Redis with TTL 86400s
8. Token Redis key: `token:{token_value}` -> JSON `{username, device_id, scope, client_id, iat, exp}`
9. Existing JWT token flow can remain as a parallel path (don't break current behavior on master)

**Key files to read first**:
- `src/oidc.rs` (existing token endpoint, authorize flow)
- `src/db.rs` or equivalent Redis interaction layer
- `Cargo.toml` (existing dependencies)

**Implementation hints**:
- The introspection handler is a new Axum route
- Shared secret comparison: constant-time compare (`ring::constant_time::verify_slices_are_equal` or equivalent)
- Token generation: `rand::thread_rng().gen::<[u8; 32]>()` then base62 encode with prefix
- Redis storage: use existing Redis connection pool, `SET token:{value} {json} EX {ttl}`
- Look at how the existing `/token` endpoint returns tokens and where to hook in opaque token generation

**New config fields** (env vars):
- `MAS_SHARED_SECRET`: shared secret for introspection auth
- `SYNAPSE_ENDPOINT`: URL of Synapse (e.g., `http://matrix_synapse:8080`) - needed by Agent C but define the config struct field here

---

### Agent B: PKCE Support

**Repo**: `/home/system-001/siwx-oidc` (branch: `feat/msc3861`)
**Isolation**: worktree

**Task**: Add PKCE (RFC 7636) to the existing authorization code flow.

**Acceptance criteria**:
1. `/authorize` accepts optional `code_challenge` + `code_challenge_method=S256` params
2. Challenge is stored alongside the auth code in Redis
3. `/token` endpoint requires `code_verifier` when a challenge was stored
4. Verification: `BASE64URL(SHA256(code_verifier)) == code_challenge`
5. Reject token exchange if verifier doesn't match (400 `invalid_grant`)
6. When no challenge was sent in authorize, token exchange works without verifier (backward compat)

**Key files to read first**:
- `src/oidc.rs` - find the `authorize` handler and the `token` handler
- Look at how auth codes are currently stored (Redis key structure, what metadata is saved)

**Implementation hints**:
- SHA-256: `use sha2::{Sha256, Digest}; let hash = Sha256::digest(code_verifier.as_bytes());`
- Base64url encode (no padding): `base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&hash)`
- Store `code_challenge` in the same Redis entry as the auth code
- On token exchange, read the stored challenge, compute SHA256(code_verifier), compare
- Only `S256` method needed (don't implement `plain`)

---

### Agent C: Synapse Provisioning Client

**Repo**: `/home/system-001/siwx-oidc` (branch: `feat/msc3861`)
**Isolation**: worktree

**Task**: Create an HTTP client module that calls Synapse's `/_synapse/mas/` management endpoints.

**Acceptance criteria**:
1. New module `src/synapse_client.rs` (or similar)
2. Struct `SynapseClient` with fields: `endpoint: String`, `shared_secret: String`, `http: reqwest::Client`
3. Methods:
   - `async fn provision_user(&self, localpart: &str, display_name: &str) -> Result<()>`
   - `async fn upsert_device(&self, localpart: &str, device_id: &str, display_name: Option<&str>) -> Result<()>`
   - `async fn delete_device(&self, localpart: &str, device_id: &str) -> Result<()>`
   - `async fn allow_cross_signing_reset(&self, localpart: &str) -> Result<()>`
   - `async fn is_localpart_available(&self, localpart: &str) -> Result<bool>`
   - `async fn sync_devices(&self, localpart: &str, devices: &[String]) -> Result<()>`
4. All calls use `Authorization: Bearer {shared_secret}` header
5. All calls target `{endpoint}/_synapse/mas/{path}`
6. Handle HTTP errors gracefully (log + return Result)
7. `SynapseClient` is constructed from env vars `SYNAPSE_ENDPOINT` + `MAS_SHARED_SECRET`

**API contract (what Synapse expects)**:

```
POST /_synapse/mas/provision_user
Body: {"localpart": "did-pkh-eip155-1-0xabc", "set_displayname": "vitalik.eth"}
Response: {} (200/201)

POST /_synapse/mas/upsert_device
Body: {"localpart": "...", "device_id": "SIWX_abc123", "display_name": "Element Web"}
Response: {} (200/201)

POST /_synapse/mas/delete_device
Body: {"localpart": "...", "device_id": "SIWX_abc123"}
Response: (204)

POST /_synapse/mas/allow_cross_signing_reset
Body: {"localpart": "..."}
Response: {} (200)

GET /_synapse/mas/is_localpart_available?localpart=...
Response: {} (200 = available) or 4xx with errcode M_USER_IN_USE

POST /_synapse/mas/sync_devices
Body: {"localpart": "...", "devices": ["DEV1", "DEV2"]}
Response: {} (200)
```

**Implementation hints**:
- Add `reqwest` to Cargo.toml (with `json` feature)
- Keep the client stateless (no internal state beyond config)
- Use `reqwest::Client` with connection pooling (create once, share via Arc)
- Don't integrate into the auth flow yet (that's Wave 2 work); just build the client module + unit tests with mock HTTP

---

### Agent D: Deployment Configuration

**Repo**: `/home/system-001/siwx-oidc-matrix-server` (branch: `feat/msc3861`)
**Isolation**: worktree

**Task**: Update the Docker Compose stack and Synapse configuration for MSC3861 delegated auth.

**Acceptance criteria**:
1. `docker-compose.yml`:
   - `siwx-oidc` service gets new env vars: `MAS_SHARED_SECRET`, `SYNAPSE_ENDPOINT=http://matrix_synapse:${MATRIX_PORT}`
   - `matrix_synapse` service gets `MAS_SHARED_SECRET` env var
   - Remove `SIWEOIDC_DEFAULT_CLIENTS` from siwx-oidc environment
   - Pin Synapse base image to >= 1.136.0 in `dockerfiles/Dockerfile`
2. `entrypoints/matrix_server.sh`:
   - Replace the entire `#oidc-config` yq block (lines 32-47 in current file) with:
     ```bash
     yq -i ".matrix_authentication_service.enabled = true" /data/homeserver.yaml
     yq -i ".matrix_authentication_service.endpoint = \"http://siwx-oidc:${SIWEOIDC_PORT}\"" /data/homeserver.yaml
     yq -i ".matrix_authentication_service.secret = \"${MAS_SHARED_SECRET}\"" /data/homeserver.yaml
     ```
   - Remove `localpart_template` and `display_name_template` lines (MAS handles user provisioning)
   - Keep everything else (TLS, listeners, retention, admin promotion)
3. `start-matrix.sh`:
   - Add `MAS_SHARED_SECRET` generation: `MAS_SHARED_SECRET=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 64; echo)`
   - Write it to .env
   - Remove `SIWEOIDC_CLIENT_ID`, `SIWEOIDC_SECRET_ID`, `SIWEOIDC_DEFAULT_CLIENTS` generation
   - Remove `MATRIX_OIDC_CLIENT_ID` and `MATRIX_OIDC_SECRET_ID` from .env output
4. `.env.example`: Update to reflect new vars, remove old OIDC client vars
5. `dockerfiles/Dockerfile`: Change `FROM matrixdotorg/synapse` to `FROM matrixdotorg/synapse:v1.136.0` (or latest >= 1.136)

**Key files**:
- `docker-compose.yml` (full stack definition)
- `entrypoints/matrix_server.sh` (Synapse first-boot config)
- `start-matrix.sh` (CLI entry point, .env generation)
- `dockerfiles/Dockerfile` (Synapse image build)
- `.env.example` (reference config)

**Important**: Do NOT remove the admin promotion logic in `matrix_server.sh` (the `MATRIX_ADMIN_DID` block at the bottom). That must stay.

**Important**: The `siwx-oidc` service healthcheck currently hits `/.well-known/openid-configuration`. This endpoint will still exist, so the healthcheck remains valid.

---

### Agent E: Legacy Compat Endpoints + Token Revocation (Wave 2)

**Repo**: `/home/system-001/siwx-oidc` (branch: `feat/msc3861`)
**Depends on**: Agent A (opaque token model must exist)

**Task**: Implement Matrix legacy login/logout/refresh endpoints and OAuth2 token revocation.

**Acceptance criteria**:
1. `POST /oauth2/revoke`:
   - Accepts `token={value}&token_type_hint=access_token|refresh_token`
   - Deletes the token from Redis
   - Calls `SynapseClient::delete_device` for the device_id associated with the token
   - Returns 200 regardless of whether the token existed (RFC 7009)
2. `/_matrix/client/v3/login` (GET):
   - Returns `{"flows": [{"type": "m.login.sso", "identity_providers": [{"id": "siwx-oidc", "name": "Sign in with Wallet"}]}]}`
   - Also include `m.login.application_service` if needed
3. `/_matrix/client/v3/logout` (POST):
   - Reads Bearer token from Authorization header
   - Delegates to revocation logic (same as /oauth2/revoke)
   - Returns `{}` (200)
4. `/_matrix/client/v3/refresh` (POST):
   - Accepts `{"refresh_token": "mcr_..."}`
   - Issues new access token for same device_id
   - Returns `{"access_token": "mat_...", "expires_in_ms": 300000, "refresh_token": "mcr_new..."}`

**Implementation hints**:
- These endpoints are mounted on siwx-oidc but served on the Matrix host domain via reverse proxy (the proxy routing is handled by Agent D)
- Token revocation must be idempotent
- The `SynapseClient` from Agent C is used here for `delete_device`

---

### Agent F: OIDC Discovery Update + Device Lifecycle (Wave 2)

**Repo**: `/home/system-001/siwx-oidc` (branch: `feat/msc3861`)
**Depends on**: Agent A (token model), Agent C (SynapseClient)

**Task**: Update OIDC discovery metadata and wire device lifecycle into the auth flow.

**Acceptance criteria**:
1. `GET /.well-known/openid-configuration` response includes:
   ```json
   {
     "introspection_endpoint": "{base_url}/oauth2/introspect",
     "introspection_endpoint_auth_methods_supported": ["bearer"],
     "code_challenge_methods_supported": ["S256"],
     "grant_types_supported": ["authorization_code", "refresh_token"],
     "revocation_endpoint": "{base_url}/oauth2/revoke",
     "token_endpoint_auth_methods_supported": ["client_secret_post", "none"]
   }
   ```
2. Device ID generation: `SIWX_` + 8 random alphanumeric chars
3. On successful auth (after signature verification in the sign_in flow):
   - Check if user exists: `SynapseClient::is_localpart_available`
   - If new user: `SynapseClient::provision_user(localpart, display_name)`
   - Always: generate device_id, `SynapseClient::upsert_device`
   - Always: `SynapseClient::allow_cross_signing_reset`
   - Store device_id in the auth code Redis entry (so token endpoint can embed it in the token)
4. Redis key for device tracking: `device:{localpart}:{device_id}` -> `{created_at, last_used}`
5. On token exchange: embed the device_id from the auth code entry into the issued token metadata

**Key integration point**: The `sign_in` handler in `src/oidc.rs` is where wallet verification happens. After signature verification succeeds, before generating the auth code, insert the Synapse provisioning calls.

**aqua-auth integration**: If the `sign_in` handler currently has custom signature verification logic, replace it with `aqua_auth::verify_caip122(did, message, signature)`. Use `aqua_auth::identifier_from_did(did)` to derive the localpart for Synapse provisioning calls. Use `aqua_auth::address_from_did(did)` if you need the raw address bytes.

---

### Agent G: Integration Test (Wave 3)

**Repo**: `/home/system-001/siwx-oidc` (branch: `feat/msc3861`)
**Depends on**: ALL previous agents

**Task**: Write the Rust integration test that drives the full MSC3861 flow headlessly.

**Acceptance criteria**:
1. File: `tests/e2e_msc3861.rs` in siwx-oidc repo
2. Four test functions: `full_lifecycle`, `returning_user_new_device`, `refresh_token_flow`, `introspection_performance`
3. Each test generates its own Ethereum keypair (no pre-existing state)
4. Uses `reqwest` with `redirect(Policy::none())` to manually follow redirects
5. Reads `MATRIX_HOST`, `SIWEOIDC_HOST` from env (defaults to localhost for CI)
6. All assertions are self-contained (no human verification needed)

**Test flow for `full_lifecycle`** (the critical path):
```rust
use k256::ecdsa::SigningKey;
use rand::rngs::OsRng;
use reqwest::{Client, redirect::Policy};
use sha2::{Sha256, Digest};
use aqua_auth::{address_from_verifying_key, eip55_checksum, build_message, MessageParams};

#[tokio::test]
async fn full_lifecycle() {
    let client = Client::builder().redirect(Policy::none()).build().unwrap();
    let matrix_host = std::env::var("MATRIX_HOST").unwrap_or("http://localhost:8080".into());
    let siwx_host = std::env::var("SIWEOIDC_HOST").unwrap_or("http://localhost:8081".into());

    // 1. Generate keypair (aqua-auth provides address derivation)
    let signing_key = SigningKey::random(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let addr_bytes = address_from_verifying_key(verifying_key);
    let address = eip55_checksum(&addr_bytes);
    let did = format!("did:pkh:eip155:1:{}", address);

    // 2. Discover auth endpoints
    let auth_meta = client.get(format!("{matrix_host}/_matrix/client/v1/auth_metadata"))
        .send().await.unwrap().json::<serde_json::Value>().await.unwrap();
    let authz_endpoint = auth_meta["authorization_endpoint"].as_str().unwrap();
    let token_endpoint = auth_meta["token_endpoint"].as_str().unwrap();

    // 3. PKCE
    let code_verifier: String = /* 43+ random URL-safe chars */;
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));

    // 4. Authorize (capture session cookie + nonce from redirect)
    let authz_resp = client.get(authz_endpoint)
        .query(&[("client_id", "test"), ("redirect_uri", "http://localhost:9999/cb"),
                  ("code_challenge", &code_challenge), ("code_challenge_method", "S256"),
                  ("scope", "urn:matrix:client:api:*"), ("response_type", "code"),
                  ("state", "test123")])
        .send().await.unwrap();
    let session_cookie = extract_cookie(&authz_resp, "session");
    let nonce = extract_nonce_from_redirect(&authz_resp);

    // 5. Build CAIP-122 message (aqua-auth ensures format matches server)
    let message = build_message(&MessageParams {
        did: &did,
        domain: &siwx_host,
        uri: "http://localhost:9999/cb",
        nonce: &nonce,
        issued_at: chrono::Utc::now(),
        expiration_time: chrono::Utc::now() + chrono::Duration::minutes(5),
    }).unwrap();
    let signature = eip191_sign(&signing_key, &message); // custom helper (aqua-auth verifies, doesn't sign)
    let siwx_cookie = serde_json::json!({"did": did, "message": message, "signature": signature});

    // 6. Submit to /sign_in
    let signin_resp = client.get(format!("{siwx_host}/sign_in"))
        .query(&[("redirect_uri", "http://localhost:9999/cb"), ("state", "test123"),
                  ("client_id", "test")])
        .header("Cookie", format!("session={}; siwx={}", session_cookie, urlencoding::encode(&siwx_cookie.to_string())))
        .send().await.unwrap();
    assert_eq!(signin_resp.status(), 302);
    let code = extract_code_from_location(&signin_resp);

    // 7. Exchange code for token
    let token_resp = client.post(token_endpoint)
        .form(&[("grant_type", "authorization_code"), ("code", &code),
                ("code_verifier", &code_verifier), ("redirect_uri", "http://localhost:9999/cb"),
                ("client_id", "test")])
        .send().await.unwrap().json::<serde_json::Value>().await.unwrap();
    let access_token = token_resp["access_token"].as_str().unwrap();
    assert!(access_token.starts_with("mat_"));

    // 8. Whoami
    let whoami = client.get(format!("{matrix_host}/_matrix/client/v3/account/whoami"))
        .bearer_auth(access_token)
        .send().await.unwrap().json::<serde_json::Value>().await.unwrap();
    assert!(whoami["user_id"].as_str().unwrap().contains("did-pkh-eip155-1"));

    // 9. Create room
    let room = client.post(format!("{matrix_host}/_matrix/client/v3/createRoom"))
        .bearer_auth(access_token)
        .json(&serde_json::json!({"preset": "private_chat"}))
        .send().await.unwrap();
    assert_eq!(room.status(), 200);

    // 10-11. Send message + revoke + verify 401
    // ... (similar pattern)
}
```

**Cargo.toml additions** (dev-dependencies):
```toml
[dev-dependencies]
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["json", "cookies"] }
aqua-auth = { path = "../aqua-rs-auth", features = ["client"] }
k256 = { version = "0.13", features = ["ecdsa"] }
sha2 = "0.10"
serde_json = "1"
urlencoding = "2"
rand = "0.8"
hex = "0.4"
```

**aqua-auth provides** (do NOT reimplement):
- `aqua_auth::address_from_verifying_key(key)` -> `[u8; 20]` (replaces custom keccak256 + slice)
- `aqua_auth::eip55_checksum(addr)` -> `String` (replaces custom EIP-55)
- `aqua_auth::build_message(MessageParams)` -> CAIP-122 message (replaces custom message construction)
- `aqua_auth::client::authenticate(http, base_url, did, sign_fn)` -> drives the challenge-response flow (optional: can simplify the test significantly if the siwx-oidc API matches the expected flow)

**Helper functions still needed** (write these in the test file):
- `eip191_sign(key: &SigningKey, message: &str) -> String` (EIP-191 prefix + keccak256 + sign + recovery byte; aqua-auth verifies but doesn't sign)
- `extract_cookie(response, name) -> String`
- `extract_nonce_from_redirect(response) -> String`
- `extract_code_from_location(response) -> String`

**Note on signing**: aqua-auth is a verification library, not a signing library. The test must sign messages itself using `k256::ecdsa::SigningKey`. Reference implementation: `aqua-rs-auth/src/verify_eip191.rs` shows the exact prefix format and hash construction to replicate in reverse (sign instead of verify).

**Running**: 
```bash
cd /home/system-001/siwx-oidc-matrix-server && docker compose up -d
cd /home/system-001/siwx-oidc && MATRIX_HOST=http://localhost:8080 SIWEOIDC_HOST=http://localhost:8081 cargo test --test e2e_msc3861
```

---

## Orchestration Notes

### Merge Strategy for siwx-oidc Feature Branch

Agents A, B, C work in isolated worktrees. After Wave 1 completes:
1. Review each agent's diff
2. Merge all into the `feat/msc3861` branch of siwx-oidc (they touch different files/modules, so conflicts are unlikely)
3. Then spawn Wave 2 agents on the merged branch

### Docker Image Build

After siwx-oidc changes are complete, the Docker image must be rebuilt:
```bash
cd /home/system-001/siwx-oidc
docker build -t siwx-oidc-local:msc3861 .
```

Then update `docker-compose.yml` on the `feat/msc3861` branch of this repo to use `siwx-oidc-local:msc3861` instead of `ghcr.io/inblockio/siwx-oidc:latest`.

### Synapse Version Check

Before starting, verify a Synapse image >= 1.136 exists:
```bash
docker pull matrixdotorg/synapse:v1.136.0
```

If the tag doesn't exist, check for the latest available:
```bash
# Check Docker Hub for latest Synapse tags
docker search matrixdotorg/synapse --limit 5
```

### Environment for Integration Test

The integration test needs both services accessible. For local testing:
- Synapse: `http://localhost:8080` (via port mapping or Docker network)
- siwx-oidc: `http://localhost:8081` (via port mapping or Docker network)

The test may need to run INSIDE the Docker network to reach services, or ports need to be exposed in docker-compose.yml for testing.

### What NOT to Touch

- `master` branch of either repo (all work on `feat/msc3861`)
- The admin promotion logic in `entrypoints/matrix_server.sh`
- The Element Web deployment (separate parallel effort by another agent)
- Federation config (port 8448, TLS certs)

### Stop Conditions (Report Back, Don't Proceed)

An agent should STOP and report if:
- siwx-oidc repo structure is significantly different from expected (e.g., no `src/oidc.rs`)
- Synapse v1.136+ doesn't have `/_synapse/mas/` endpoints (version mismatch)
- The existing `e2e_flow` test in siwx-oidc doesn't compile (indicates breaking changes upstream)
- Redis connection handling is fundamentally different from expected (not a simple connection pool)
