# Auth Flow Debug Handover (2026-05-20)

## Goal

Fix the post-wallet-challenge redirect so users complete the full login flow:
Element -> siwx-oidc wallet challenge -> redirect back to Element authenticated.

## What Works

1. **CI/CD**: Both repos (siwx-oidc, siwx-oidc-matrix-server) have GitHub Actions workflows that build Docker images on push to `fork-stable` and publish to GHCR.
2. **Server deployment**: All containers are running and healthy on agentic.inblock.io (142.93.168.4).
3. **CORS**: Caddy config correctly handles cross-origin requests from element.inblock.io to siwx-oidc.inblock.io (preflight and actual responses both include correct headers).
4. **Client registration**: `POST /register` works, returns 201 with client_id.
5. **Gate script injection**: `siwx-gate.js` is injected as the first `<script>` in Element's `<head>`. The file is served correctly (HTTP 200, correct content).
6. **Redirect + callback scripts**: Both `siwx-redirect.js` and `siwx-callback.js` are served correctly from element.inblock.io.
7. **OIDC flow through sign_in**: Server logs confirm a COMPLETE successful flow at 23:56:39 UTC:
   - `POST /register` (201) - client registered
   - `GET /authorize` (303) - session created, redirected to siwx-oidc Svelte UI
   - `GET /sign_in` (200) - wallet signature verified for `did:pkh:eip155:1:0x4B23da593596D94035c57Adf6C2454216449B1B2`
   - `POST /token` (x2) - token exchange attempted

## Root Cause: Two Competing OIDC Flows

The `document.write()` approach in `siwx-gate.js` does NOT fully prevent Element from loading. When called during HTML parsing (from a synchronous `<head>` script), `document.write()` inserts content at the current parse position but does NOT stop the parser from continuing with the rest of the original HTML. The `document.close()` call is a no-op because `document.open()` was never explicitly called.

**Result**: Both our custom OIDC flow AND Element's native MSC3861 OIDC flow run simultaneously.

### Evidence from server logs

The repeating pattern every ~10 seconds is Element's native OIDC:
```
GET /.well-known/openid-configuration -> 200
GET /authorize -> 401 "Unrecognised client id."
GET /authorize -> 401 "Unrecognised client id."
```

Element caches a stale client_id (from a previous session or a failed registration). It retries `/authorize` in a loop, getting 401 each time.

Meanwhile, our scripts also run. We see successful `POST /register` (201) and `GET /authorize` (303) from our flow. The user reaches siwx-oidc, signs the wallet challenge, and `GET /sign_in` succeeds.

### The callback race

After `/sign_in` redirects back to `element.inblock.io/?code=...&state=...`:
1. The gate script sees `?code=` and writes a document with ONLY `siwx-callback.js`
2. But Element's scripts also load (gate doesn't prevent it)
3. Both our callback script and Element's native OIDC try to exchange the authorization code
4. Only one can succeed (codes are single-use)
5. If Element wins the race, it may store tokens in its own format but with mismatched state/PKCE
6. If our script wins, it stores tokens in localStorage, but Element may overwrite or ignore them

### Additional issue: stale client_id loop

Element's native OIDC caches a client_id that becomes invalid after server redeploys (Redis wipe). Element then enters an infinite retry loop: discover -> authorize (401) -> wait -> repeat. This generates constant log noise.

## Diagnosis of Element's `index.html` (as deployed)

```html
<head>
  <script src="siwx-gate.js"></script>          <!-- 1st: gate (document.write) -->
  ...meta tags, CSP, stylesheets...
  <script src="siwx-callback.js"></script>       <!-- injected before </head> -->
  <script src="siwx-redirect.js"></script>       <!-- injected before </head> -->
</head>
<body>
  <script src="bundles/.../bundle.js"></script>   <!-- Element's main app -->
</body>
```

All four scripts load regardless of the gate's `document.write()`. The callback and redirect scripts have guard clauses (`if (hasToken()) return;`, `if (params.has("code")) return;`) that prevent double-action, but Element's `bundle.js` has no such guards and starts its own OIDC.

## Proposed Fix Options

### Option A: Inline the gate logic (recommended)

Instead of `document.write()`, use an inline `<script>` that sets a global flag. Wrap Element's `bundle.js` script tag in a check:

```html
<head>
  <script>
    window.__siwx_authenticated = !!(
      localStorage.getItem("mx_access_token") ||
      localStorage.getItem("mx_has_access_token")
    );
  </script>
</head>
<body>
  <script>
    if (!window.__siwx_authenticated) {
      // Don't load Element - siwx-redirect.js or siwx-callback.js handles it
      document.getElementById('matrixchat').style.display = 'none';
    }
  </script>
  <script src="bundles/.../bundle.js"></script>
</body>
```

Problem: We don't control Element's HTML structure (it's a stock image).

### Option B: Remove the `<script>` tag for bundle.js at entrypoint time

In `element_entrypoint.sh`, use `sed` to comment out or remove Element's main bundle script. Replace it with a conditional loader:

```sh
# Remove Element's bundle.js
sed -i 's|<script src="bundles/[^"]*bundle.js"></script>||' /app/index.html

# Add conditional loader
sed -i '/<\/body>/i <script>if(localStorage.getItem("mx_access_token")||localStorage.getItem("mx_has_access_token")){var s=document.createElement("script");s.src="bundles/HASH/bundle.js";document.body.appendChild(s);}</script>' /app/index.html
```

Problem: The bundle hash changes with Element versions. Need to dynamically detect it.

### Option C: Disable Element's native OIDC via config (cleanest)

Check if Element Web has a config option to disable its native MSC3861 OIDC flow. If `m.authentication` is removed from config.json and the `.well-known/matrix/client` response, Element won't try OIDC natively. Our scripts handle everything.

This is the cleanest approach but needs verification that Element still works for the callback flow when it doesn't know about OIDC.

### Option D: Make gate script work by deferring bundle.js

Modify the entrypoint to move Element's `bundle.js` from a static `<script>` tag to a dynamically-loaded script that only fires after our gate logic completes:

```sh
# In element_entrypoint.sh:
# 1. Extract the bundle.js path
# 2. Remove the static script tag
# 3. Add gate-controlled loader
```

## Uncommitted Local Changes

These changes were made during this session and the previous one but NOT committed:

| File | Repo | Change |
|---|---|---|
| `.github/workflows/docker.yml` | siwx-oidc-matrix-server | NEW: CI/CD for synapse + element-web images |
| `.github/workflows/docker.yml` | siwx-oidc | Modified: added fork-stable to branches |
| `docker-compose.yml` | siwx-oidc-matrix-server | Added `image:` directives for GHCR |
| `deploy.sh` | siwx-oidc-matrix-server | `--build` now does `docker compose pull` |
| `config/siwx-gate.js` | siwx-oidc-matrix-server | Rewritten with 3-state logic (token/callback/redirect) |
| `config/siwx-redirect.js` | siwx-oidc-matrix-server | Always registers fresh client (no caching) |
| `src/axum_lib.rs` | siwx-oidc | Added CorsLayer (compiled, not deployed) |

## Server Details

- Host: agentic.inblock.io (142.93.168.4)
- SSH: `ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io`
- Stack dir: `/home/deploy/matrix/stack`
- Caddy config: `/home/portal/portal/Caddyfile`
- Logs: `docker compose logs siwx-oidc --tail 100`
- All services on `portal-net` Docker network, Caddy handles TLS + routing

## Key Files for Next Session

- `config/siwx-gate.js` - the gate script that needs fixing
- `config/siwx-callback.js` - the code exchange callback (need to verify it works)
- `entrypoints/element_entrypoint.sh` - where scripts are injected into Element
- `config/element-config.json` - Element Web configuration
- Server Caddyfile (on server, not in repo) - routing and CORS
