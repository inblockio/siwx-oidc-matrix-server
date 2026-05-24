# Element X Mobile: Passkey-First Registration Flow

**Date:** 2026-05-24
**Stack:** siwx-oidc-matrix-server (MSC3861 delegated auth)
**Target:** First-time user registration on Element X (Android + iOS) via passkey only

## Verdict

First-time passkey registration on Element X mobile is a **fully supported code
path**. No wallet, no prior account, no prior passkey required. A brand-new user
can install Element X, enter the homeserver, and register with a passkey in a
single flow.

## Prior assumption (invalidated)

The compatibility doc (`docs/2026-05-23-element-x-mobile-compatibility.md`)
previously stated:

> The user must have previously registered a passkey on siwx-oidc.inblock.io.

This was an **assumption, not ground truth**. Code analysis proves the login page
offers inline passkey registration ("Create one" at `App.svelte:420-428`), and
the backend requires only a session cookie to start registration
(`webauthn.rs:111-137`). No prior account or DID is needed.

## Complete flow: new user, passkey only

```
Step 1: Element X app
  User enters "matrix.inblock.io" as homeserver

Step 2: OIDC discovery
  Element X fetches /.well-known/matrix/client
  Discovers m.authentication.issuer = "https://siwx-oidc.inblock.io"
  Dynamically registers as public OIDC client (RFC 7591)

Step 3: System browser opens
  Element X opens /authorize in system browser (not WebView)
  Android: Chrome Custom Tabs
  iOS: ASWebAuthenticationSession

Step 4: Session created
  /authorize creates SessionEntry with verified_did: None
  Sets session cookie
  Redirects to login page (App.svelte)

Step 5: User registers passkey
  User sees three options:
    [Sign in with Ethereum]  [Sign in with Passkey]
    "Don't have a passkey? Create one"
  User taps "Create one"

Step 6: WebAuthn registration
  POST /webauthn/register/start (requires only session cookie)
  Browser calls navigator.credentials.create()
  User provides biometric (fingerprint, Face ID) or device PIN
  Authenticator creates P-256 key pair

Step 7: DID derivation
  POST /webauthn/register/finish
  Server verifies attestation
  Derives did:key from P-256 public key (deterministic)
  Stores credential in Redis: webauthn:credential/{cred_id}
  Returns { did: "did:key:zDn...", credential_id: "..." }

Step 8: Auto-authenticate
  Frontend shows "Passkey registered! DID: did:key:zDn..."
  Immediately calls handlePasskeySignIn()
  POST /webauthn/authenticate/start + authenticate/finish
  Sets session.verified_did = "did:key:zDn..."

Step 9: Sign-in (server-verified path)
  GET /sign_in reads session.verified_did
  Takes server-verified path (oidc.rs:1298-1323)
  No wallet signature needed, no CAIP-122 cookie needed

Step 10: Synapse user provisioned
  provision_synapse_device() called (oidc.rs:1181-1224)
  is_localpart_available() returns true (new user)
  provision_user() creates Matrix account
  upsert_device() creates SIWX_{uuid} device
  allow_cross_signing_reset() fires

Step 11: Tokens issued
  Authorization code generated
  Browser redirects to Element X via custom URI scheme
  Element X exchanges code for mat_/mcr_ tokens

Step 12: Logged in
  User is in Element X with a new Matrix account
  Prompted to set up device verification (E2EE)
```

## If-then hypothesis chain (validated)

Each link was verified against the source code.

| ID | Hypothesis | Evidence | Status |
|----|-----------|----------|--------|
| H1 | IF Element X opens /authorize, THEN session cookie is created | `oidc.rs:990-1000`, `verified_did: None`, no preconditions | TRUE |
| H2 | IF session cookie exists, THEN /webauthn/register/start accepts it | `webauthn.rs:111-137`, only checks `SESSION_COOKIE_NAME` | TRUE |
| H3 | IF system browser (not WebView), THEN WebAuthn works | Chrome Custom Tabs + ASWebAuthenticationSession both support passkeys | TRUE |
| H4 | IF registration succeeds, THEN did:key derived from P-256 public key | `webauthn.rs:160`, `did_from_passkey()` at lines 63-66 | TRUE |
| H5 | IF did:key derived, THEN auto-authenticate sets session.verified_did | `App.svelte:318` calls `handlePasskeySignIn()`, `webauthn.rs:348` sets field | TRUE |
| H6 | IF session.verified_did set, THEN /sign_in uses server-verified path | `oidc.rs:1298-1323` checks `verified_did` before CAIP-122 path | TRUE |
| H7 | IF did:key used in /sign_in, THEN allowed_did_methods accepts it | `config.rs:71` default `["pkh", "key"]`, not overridden in .env | TRUE |
| H8 | IF new DID in /sign_in, THEN Synapse user auto-created | `oidc.rs:1202-1210`, `is_localpart_available` + `provision_user` | TRUE |
| H9 | IF tokens issued, THEN Element X receives them via redirect | Standard OIDC code exchange, custom URI schemes accepted | TRUE |

## Boundary conditions

| Condition | Status | Detail |
|-----------|--------|--------|
| `did:key` in `supported_did_methods` | OK | Default `["pkh", "key"]` at `config.rs:71`, not overridden |
| System browser (not WebView) | OK | RFC 8252 mandated; both platforms comply |
| Passkey domain binding | OK | `siwx-oidc.inblock.io` is the RP; system browser opens that domain |
| Synapse MAS API available | OK | Already working for wallet-based logins |
| CORS irrelevant for mobile | OK | Native HTTP clients (OkHttp, URLSession) do not enforce CORS |
| Dynamic client registration | OK | `/register` endpoint has no redirect URI scheme restrictions |

## Identity model

The passkey-first flow produces a `did:key` identity (not `did:pkh`). Key
differences:

| Property | did:pkh (wallet) | did:key (passkey) |
|----------|-----------------|------------------|
| Source | Blockchain address | Passkey P-256 public key |
| Format | `did:pkh:eip155:1:0x...` | `did:key:zDn...` |
| Matrix localpart | `did-pkh-eip155-1-0x...` | `did-key-zdn...` |
| Cross-device sync | Via wallet (MetaMask, etc.) | Via OS credential manager (iCloud, Google) |
| Blockchain association | Direct | None |

A user who registers via passkey gets a `did:key` account. If they later want to
associate an Ethereum address, the account linking flow (`/webauthn/link`) can
bind the passkey to a wallet DID. This is a separate, optional step.

## UX summary for end users

1. Download Element X from App Store / Play Store
2. Enter `matrix.inblock.io` as homeserver
3. Tap "Continue" (Element X detects OIDC mode)
4. System browser opens to siwx-oidc.inblock.io
5. Tap "Create one" (below the passkey sign-in button)
6. Authenticate with fingerprint, Face ID, or device PIN
7. Passkey registered, auto-login completes
8. Browser redirects back to Element X
9. User is logged in, prompted to verify device for E2EE

Total interactions: 4 taps + 1 biometric. No wallet extension, no seed phrase, no
blockchain knowledge required.

## Code references

| Component | File | Lines |
|-----------|------|-------|
| "Create one" UI | `siwx-oidc/js/ui/src/App.svelte` | 420-428 |
| Registration handler (frontend) | `siwx-oidc/js/ui/src/App.svelte` | 268-330 |
| Auto sign-in after register | `siwx-oidc/js/ui/src/App.svelte` | 315-318 |
| register_start (backend) | `siwx-oidc/src/webauthn.rs` | 111-137 |
| register_finish + DID derivation | `siwx-oidc/src/webauthn.rs` | 139-181 |
| did_from_passkey | `siwx-oidc/src/webauthn.rs` | 35-66 |
| authenticate_finish (sets verified_did) | `siwx-oidc/src/webauthn.rs` | 332-360 |
| Server-verified sign_in path | `siwx-oidc/src/oidc.rs` | 1298-1323 |
| allowed_did_methods default | `siwx-oidc/src/config.rs` | 71 |
| Synapse user provisioning | `siwx-oidc/src/oidc.rs` | 1181-1224 |
| Session creation (no preconditions) | `siwx-oidc/src/oidc.rs` | 990-1000 |
