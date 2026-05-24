# Element X Mobile Compatibility Analysis

**Date:** 2026-05-23
**Stack:** siwx-oidc-matrix-server (MSC3861 delegated auth)
**Target:** Element X Android + iOS connecting to matrix.inblock.io with passkey auth

## Verdict

Element X mobile is **compatible** with this stack. No code changes required.
Users can install Element X from the app store, enter `matrix.inblock.io` as
their homeserver, and authenticate via passkey or wallet signature.

## Auth flow with Element X mobile

1. User enters `matrix.inblock.io` as homeserver in Element X
2. Element X fetches `https://matrix.inblock.io/.well-known/matrix/client`,
   discovers `m.authentication.issuer = "https://siwx-oidc.inblock.io"`
3. Element X dynamically registers itself as a public OIDC client via
   `POST https://siwx-oidc.inblock.io/register` (RFC 7591, MSC2966)
4. Element X opens a **system browser** to `siwx-oidc.inblock.io/authorize`
   with PKCE (S256)
   - Android: Chrome Custom Tabs
   - iOS: ASWebAuthenticationSession
5. User sees the siwx-oidc login page (wallet connect or passkey)
6. User authenticates; siwx-oidc provisions user in Synapse, issues auth code
7. System browser redirects back to Element X via custom URI scheme
   - Android: `io.element.android:/`
   - iOS: `https://element.io/oauth/ios/{bundleId}`
8. Element X exchanges auth code for `mat_` / `mcr_` tokens at `/token`
9. Synapse validates every request via `POST /oauth2/introspect` on siwx-oidc

## Compatibility checklist

| Requirement | Status | Detail |
|---|---|---|
| MSC3861 delegated auth | OK | Synapse: `msc3861.enabled = true`, `issuer = siwx-oidc.inblock.io` |
| OIDC discovery | OK | `.well-known/matrix/client` returns `m.authentication.issuer`; Synapse also serves `/_matrix/client/v1/auth_metadata` |
| Dynamic client registration (RFC 7591) | OK | `/register` endpoint, no redirect URI scheme restrictions |
| Public client (auth method `none`) | OK | Discovery advertises `["client_secret_post", "none"]`; `SIWEOIDC_REQUIRE_SECRET = false` |
| PKCE (S256) | OK | `code_challenge_methods_supported: ["S256"]` advertised and enforced |
| Matrix scopes | OK | Authorize endpoint requires `openid`, passes all additional scopes through (`oidc.rs:967-975`). Test at `oidc.rs:1791` confirms Matrix scopes accepted |
| Custom URI redirect schemes | OK | Registration validates only absence of fragments; both `io.element.android:/` and `https://element.io/oauth/ios/*` accepted |
| Token introspection (RFC 7662) | OK | `/oauth2/introspect` with `client_secret_post` + `bearer` auth |
| Device code / QR login (RFC 8628) | OK | `/device_authorization` endpoint + `device_code` grant type |
| Login/logout routing | OK | Caddy routes `/_matrix/client/v3/{login,logout,refresh}` to siwx-oidc |
| Account management (MSC4191) | OK | `account_management_uri` + `account_management_actions_supported` in discovery |

## Passkey compatibility

Passkeys work in Element X because the OIDC login page opens in a **system
browser**, not a WebView. Both Chrome Custom Tabs (Android) and
ASWebAuthenticationSession (iOS) have full WebAuthn/passkey support.

Key details:

- **Domain binding**: Passkeys are bound to `siwx-oidc.inblock.io`. The system
  browser opens that exact domain, so registered passkeys are available.
- **iOS**: ASWebAuthenticationSession shares the Safari keychain. iCloud Keychain
  passkeys and third-party password manager passkeys are available.
- **Android**: Chrome Custom Tabs uses Chrome's credential manager. Google
  Password Manager passkeys and third-party manager passkeys are available.
- **Cross-platform**: A passkey registered on desktop (Element Web) via
  siwx-oidc.inblock.io is available on mobile if synced through iCloud Keychain,
  Google Password Manager, or a cross-platform manager (1Password, Bitwarden).

**Prerequisite**: The user must have previously registered a passkey on
`siwx-oidc.inblock.io`. If they have only used wallet signing, their first
mobile login must use a wallet (MetaMask mobile, etc.). They can register a
passkey afterward for subsequent logins.

## Minor caveats (non-blocking)

### `scopes_supported` in discovery metadata

The OIDC discovery endpoint lists `scopes_supported: ["openid", "profile"]` but
does not advertise Matrix-specific scopes like `urn:matrix:client:api:*`. In
practice, Element X (via matrix-rust-sdk) sends these scopes regardless. A
strict conformance fix would add them to the `SCOPES` constant in
`siwx-oidc/src/oidc.rs:55`.

### CORS on siwx-oidc.inblock.io

CORS is hardcoded to `https://element.inblock.io` in `Caddyfile.production:70`.
This does **not** affect mobile apps; CORS is a browser-only restriction. Mobile
HTTP clients (OkHttp on Android, URLSession on iOS) do not enforce CORS. This
only matters if a third-party web client (not hosted on element.inblock.io) needs
to connect.

### `sub` claim format

The ID token uses the full DID (`did:pkh:eip155:1:0x...`) as the `sub` claim,
while the introspection response uses the Matrix localpart. Element X primarily
uses introspection, so user display names derive from the localpart.

### E2EE device verification

Each Element X login creates a fresh device (same behavior as Element Web with
this stack). Users see the "verify this device" prompt. This is expected and
consistent with the device lifecycle documented in `CLAUDE.md` (fresh
`SIWX_{uuid}` device_id per login, no recycling).

## User experience summary

1. Download Element X from App Store / Play Store
2. Enter `matrix.inblock.io` as homeserver
3. Element X detects OIDC mode, shows "Continue" button (no username/password)
4. System browser opens to siwx-oidc.inblock.io login page
5. User taps "Sign in with passkey" (or connects wallet)
6. Browser redirects back to Element X
7. User is logged in, prompted to verify device for E2EE

## Element X technical details

- **First OIDC release**: Element X "Ignition" (December 10, 2024)
- **Auth library**: matrix-rust-sdk (Rust `openidconnect` crate)
- **Client type**: Public (`token_endpoint_auth_method: none`), uses PKCE
- **Grant types**: `authorization_code`, `urn:ietf:params:oauth:grant-type:device_code`
- **Discovery path**: `/.well-known/matrix/client` > `m.authentication.issuer` >
  `/.well-known/openid-configuration`, with fallback to
  `/_matrix/client/v1/auth_metadata` (MSC2965)
- **No WebView**: Both platforms use system browser per RFC 8252 (OAuth 2.0 for
  Native Apps)
