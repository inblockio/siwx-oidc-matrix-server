# Plan: Fix the OIDC Callback Race by Going Matrix-Native (Delete the Custom Scripts)

**Date:** 2026-05-29
**Branch:** `fix/callback-race`
**Supersedes:** `2026-05-24-callback-race-fix.md` (URL-scrub + sessionStorage handoff — patched the symptom, kept two competing flows)

**Goal (one sentence):** Eliminate the Element Web OIDC callback race by removing the custom auth scripts and letting Element Web's built-in MSC2965/MSC3861 native OIDC flow handle login, exactly as Element X mobile already does.

**Acceptance criterion:** A fresh Element Web visit completes login through siwx-oidc with exactly **one** OIDC consumer, no duplicate `/token` exchange, no 401 `/authorize` loop, no blank page — and `config/siwx-gate.js`, `config/siwx-redirect.js`, `config/siwx-callback.js` no longer exist.

---

## Part 1 — Root Cause (Logic Model)

### The structural race (the real bug)

Element Web ships a complete **native** OIDC client (MSC2964 authorization-code + PKCE, MSC2965 discovery, MSC2966 dynamic registration, MSC2967 device scope, MSC3861 delegated auth). When `.well-known/matrix/client` advertises `m.authentication`, Element Web discovers the issuer and **makes native OIDC the only login option**, then registers, redirects, and exchanges the code itself.

The stack *also* injects three hand-written scripts that re-implement the same dance:

| Script | What it duplicates |
|---|---|
| `siwx-redirect.js` | dynamic registration + PKCE + redirect to `/authorize` |
| `siwx-callback.js` | `/token` exchange + whoami + localStorage session write |
| `siwx-gate.js` | tries to suppress Element's bundle via `document.write()` |

Two independent OIDC consumers run in the same page. Both try to consume the single-use `?code=`. **That is the race** — it is structural, not a timing accident. `document.write()` never prevents it because, per the HTML spec, `document.write()` during a parser-blocking script inserts into the input stream but does **not** halt parsing; Element's bundle and the entrypoint-injected duplicate scripts still load.

### Why `window.stop()` (commit `0493c37`) produced a blank screen

**The if-then chain that broke:**

```
IF window.stop() is called in the gate's first <head> script,
  THEN the browser runs "abort the document": it halts the HTML parser
       AND cancels every in-flight network fetch, non-selectively.
IF all fetches are cancelled,
  THEN the <script src="siwx-redirect.js"> / <script src="siwx-callback.js">
       and <img src="inblockio_logo_dark.png"> that document.write() injects
       are ALSO cancelled (they are new network loads on the same context).
IF the injected recovery script never fetches/executes,
  THEN no redirect and no token exchange happen; the document is left in an
       aborted state that never reaches "complete".
THEREFORE: splash markup may be written into the DOM, but nothing runs —
       a blank, frozen page. The "fix" killed the recovery path, not just Element.
```

**The defect in one line:** `window.stop()` is too broad an instrument — it cannot distinguish "Element's bundle" (what we wanted to stop) from "our own injected scripts and assets" (what we needed to keep). Suppressing one flow by aborting the whole page also aborts the other flow.

**Falsifiable test of this hypothesis:** in the reverted build, the network panel shows `siwx-redirect.js`/`siwx-callback.js` as `(canceled)` and no `/authorize` or `/token` request fires. If true, the hypothesis holds.

### The original sin (why the scripts exist at all)

The `2026-05-17` auto-login plan treated siwx-oidc as a **legacy SSO** provider (`/_matrix/client/v3/login/sso/redirect/siwx-oidc`), not a native OIDC provider. When the stack moved to MSC3861, Synapse disabled `/_matrix/client/v3/login` (→ `M_UNRECOGNIZED`), the legacy redirect broke, and each failure was patched with more custom JS instead of switching to the native flow. The scripts are legacy cruft.

---

## Part 2 — The Matrix-Native Solution

**Approach:** delete the custom auth layer; rely on Element Web's native OIDC flow — the same code path Element X mobile uses successfully today. This is "complexity collapse": fewer concepts (no custom JS, no injection, no splash race), same or larger scope (native handles login + refresh + logout + account management uniformly).

### Why this is robust and already de-risked

Everything the native flow needs is **already deployed and proven**:

| Prereq | Evidence it already works |
|---|---|
| Native OIDC stack in siwx-oidc | Element X mobile passkey flow is verified end-to-end (`skills/element-x-mobile-passkey-first.md` boundary table — all OK) |
| `.well-known/matrix/client` advertises `m.authentication` + `m.authentication.account` | commit `8a3e8ee` (MSC4191) |
| Synapse serves `/_matrix/client/v1/auth_metadata` (MSC2965) | Element X skill confirms "OK" |
| CORS open for Element Web → siwx-oidc | commit `3f57a60` ("open public CORS on siwx-oidc routes to allow Element Web from any origin") |
| Element Web makes native OIDC the only option on MSC2965 discovery | Element official docs (web-docs.element.dev/Element Web/oidc.html) |
| Dynamic client registration (RFC 7591) | siwx-oidc `/register`, used by mobile |

The CORS commit and the well-known account commit show the stack was **already being prepared** for native web OIDC. This plan finishes that turn.

---

## Part 3 — Tasks

> Implement on `fix/callback-race`. Verify in a real browser before declaring done (per repo standards). Images build via CI/CD, not locally (see `feedback_no_local_builds`).

### Task 1 — Remove the custom auth scripts and their injection
- Delete `config/siwx-gate.js`, `config/siwx-redirect.js`, `config/siwx-callback.js`.
- Decide on `config/siwx-splash.html`: drop it, or keep ONLY as a static loading overlay that does no auth and starts hidden (no script that touches `?code=`). Recommendation: drop it for now; re-add a non-racing splash later if desired.
- `dockerfiles/Dockerfile.element`: remove the `COPY` lines for the three scripts (+ splash if dropped).
- `entrypoints/element_entrypoint.sh`: remove all four `sed` injection lines (gate, callback, redirect, splash) and the `%%SIWEOIDC_BASE_URL%%` templating of those scripts. Keep favicon branding and `config.json` templating.

### Task 2 — Confirm Element Web config triggers native OIDC
- `config/element-config.json` already locks the homeserver via `default_server_config` → Element fetches its `.well-known/matrix/client`, sees `m.authentication`, and offers native OIDC only. No `m.login.password`, no custom URLs (`disable_custom_urls: true`) — good.
- **Verify** the pinned `vectorim/element-web:latest` enables native OIDC by default (recent versions do; the old `feature_oidc_native_flow` labs flag has graduated). If the pinned build still gates it, add the flag under `features` in `element-config.json`.
- **Optional (recommended):** configure a **static OIDC `client_id`** in `element-config.json` so Element stops re-registering a fresh client on every load. This removes the "stale client_id after Redis wipe → `/authorize` 401 loop" noise documented in `2026-05-20-auth-flow-debug-handover.md`. Register one long-lived client for `https://element.inblock.io/` and pin it. (If siwx-oidc's discovery omits a `registration_endpoint`, Element won't attempt dynamic registration and a static `client_id` becomes mandatory — check discovery output in Task 4.)

### Task 3 — Reconcile the Caddy `/_matrix/client/v3/login` route
- Current Caddyfiles proxy `/_matrix/client/v3/login|logout|refresh` to siwx-oidc. The native flow does not use `/v3/login` for login (it uses `/authorize` on the issuer), but Element may still probe it. Confirm siwx-oidc returns something that does **not** trigger an error dialog (ideally the OIDC-aware response), or that Element's well-known-first discovery means the probe result is ignored. Leave `/logout` and `/refresh` proxied (native session lifecycle uses them).

### Task 4 — Verify discovery end-to-end (pre-browser sanity)
```bash
# Element will follow this chain. Confirm each link from the element origin.
curl -s https://matrix.inblock.io/.well-known/matrix/client | jq .          # m.authentication present
curl -s https://siwx-oidc.inblock.io/.well-known/openid-configuration | jq . # authorization_endpoint, token_endpoint,
                                                                             # registration_endpoint?, grant_types,
                                                                             # code_challenge_methods_supported (S256)
curl -s https://matrix.inblock.io/_matrix/client/v1/auth_metadata | jq .     # MSC2965 metadata served by Synapse
# CORS: confirm Access-Control-Allow-Origin for the element origin on the OIDC endpoints
curl -s -I -H "Origin: https://element.inblock.io" https://siwx-oidc.inblock.io/.well-known/openid-configuration
```

### Task 5 — Browser verification (golden path + edges)
1. **Fresh incognito** → element.inblock.io → Element shows native OIDC login (single "Continue" option) → redirect to siwx-oidc → wallet/passkey → redirect back → **exactly one** `/token` request (Network tab) → Element boots logged in. No blank page.
2. **Reload while authenticated** → boots straight in, no redirect.
3. **Back button after login** → no re-exchange, no `?code=` artifact.
4. **Stale/again after Redis wipe** → if static `client_id` is set, no `/authorize` 401 loop; if dynamic, Element re-registers cleanly.
5. **Logout** → session cleared; confirm no logout interception is re-introduced (`feedback_no_logout_handling`).

### Task 6 — Docs + cleanup
- Update `CLAUDE.md` "Element Web client" section: native OIDC, no injected scripts.
- Mark `2026-05-24-callback-race-fix.md` superseded (or delete it).
- Commit; deploy via `deploy.sh <ref> --build --restart` after CI builds (`feedback_deploy_build_flag`), SSH as `deploy@` (`feedback_ssh_deploy_user`).

---

## Part 4 — Boundary Conditions

**Assumptions (verify, don't trust):**
- A1: `vectorim/element-web:latest` has native OIDC on by default. *Risk if false:* add labs flag. (Task 2)
- A2: siwx-oidc discovery advertises a `registration_endpoint` OR we pin a static `client_id`. *Risk if false:* Element offers no login. (Task 2/4)
- A3: CORS (commit `3f57a60`) covers discovery + `/register` + `/token` for the element origin. *Risk if false:* CORS errors in console. (Task 4)

**Exclusions (out of scope):** no logout interception or button relabeling (hard NO — `feedback_no_logout_handling`); no changes to the mobile/Element X flow (already working); no siwx-oidc protocol changes unless Task 4 reveals a discovery gap.

**Invariants:** exactly one OIDC consumer in Element Web; images built via CI only; `.env` secrets untouched.

**Known trade-off:** the native flow likely shows a one-click "Continue with inblock.io" screen instead of the old zero-click auto-redirect. Acceptable and more standard. If zero-click is a hard requirement, layer a *thin* enhancement that programmatically clicks Element's own native login button — it must NOT touch `?code=` or run a second OIDC flow (that would re-introduce the race).

**Convergence / loop exit:** done when Task 5 path #1 shows a single `/token` request and a booted session in a clean browser profile, on the live deployment.

---

## Part 5 — Rollback

Pure deletion of presentation-layer files; no DB/volume/protocol changes. To roll back: `git revert` the branch merge and rebuild+restart `element-web`. Tokens, signing keys, and Synapse state are unaffected.
