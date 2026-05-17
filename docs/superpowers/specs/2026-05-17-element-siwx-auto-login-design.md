# Element Web with SIWX Auto-Login

**Date:** 2026-05-17
**Status:** Draft
**Scope:** Login flow only (no chat UI modifications)

## Problem

Users who want to log into the Matrix server via SIWX must:

1. Navigate to app.element.io (or another client)
2. Click through the welcome/sign-in screens
3. Manually enter the custom homeserver URL
4. Find and click the SIWX OIDC login option

This is 4+ clicks and requires knowing the homeserver URL. The goal is **zero clicks**: visit the URL, wallet popup appears.

## Solution

Add a self-hosted Element Web instance to the existing docker-compose stack, pre-configured for the local Synapse and with a JavaScript shim that auto-redirects unauthenticated users to the SIWX OIDC flow. A branded splash screen (inblock.io logo + spinner + "Connecting your wallet...") displays during the ~1 second redirect.

## Architecture

### Login Flow

```
User visits chat.example.com
  -> JS shim checks localStorage for Matrix session
  -> No session found:
      1. Show branded splash (logo + spinner + "Connecting your wallet...")
      2. Redirect to:
           https://matrix.example.com/_matrix/client/v3/login/sso/redirect/siwx-oidc
             ?redirectUrl=https://chat.example.com/
      3. Synapse redirects to siwx-oidc provider
      4. Wallet popup appears, user signs
      5. siwx-oidc redirects back to Synapse callback
      6. Synapse redirects to https://chat.example.com/?loginToken=xxx
      7. Element picks up loginToken, creates session, loads chat
  -> Session exists:
      Element loads directly into chat (shim does nothing)
```

### Shim Guard Conditions

The redirect shim must check two conditions before redirecting:

1. **`?loginToken=` in URL**: SSO callback in progress. Bail out, let Element handle it.
2. **`mx_user_id` / `mx_access_token` / `mx_has_access_token` in localStorage**: User already logged in. Bail out.

Only when both checks fail does the shim show the splash and redirect.

### Service Topology

Existing services unchanged. One new service added:

| Service | Image / Build | Port | Notes |
|---|---|---|---|
| `element-web` | `dockerfiles/Dockerfile.element` (based on `vectorim/element-web`) | 80 (internal) | Served via nginx-proxy at `${CLIENT_HOST}` |

The existing nginx-proxy + acme-companion handle TLS and routing. Adding `VIRTUAL_HOST=${CLIENT_HOST}` wires up the subdomain with auto-provisioned LetsEncrypt certs.

## New Files

```
siwx-oidc-matrix-server/
  config/
    element-config.json        # Element Web configuration
    siwx-redirect.js           # Auto-redirect shim
    siwx-splash.html           # Branded splash screen (HTML fragment)
  dockerfiles/
    Dockerfile.element         # Stock Element Web + config/shim layer
  entrypoints/
    element_entrypoint.sh      # Injects shim + splash at container start
```

### config/element-config.json

Locks Element to the local Synapse, disables all alternative login methods:

```json
{
  "default_server_config": {
    "m.homeserver": {
      "base_url": "%%MATRIX_BASE_URL%%",
      "server_name": "%%MATRIX_HOST%%"
    }
  },
  "disable_custom_urls": true,
  "disable_guests": true,
  "disable_login_language_selector": true,
  "brand": "inblock.io Chat"
}
```

Placeholders are replaced by the entrypoint script at container start.

### config/siwx-redirect.js

```javascript
(function() {
  var params = new URLSearchParams(window.location.search);
  if (params.has("loginToken")) return;

  var hasSession = localStorage.getItem("mx_access_token")
                || localStorage.getItem("mx_has_access_token")
                || localStorage.getItem("mx_user_id");
  if (hasSession) return;

  var splash = document.getElementById("siwx-splash");
  if (splash) splash.style.display = "flex";

  var ssoUrl = "%%MATRIX_BASE_URL%%/_matrix/client/v3/login/sso/redirect/siwx-oidc";
  var redirectUrl = encodeURIComponent(window.location.origin + window.location.pathname);
  window.location.replace(ssoUrl + "?redirectUrl=" + redirectUrl);
})();
```

### config/siwx-splash.html

HTML fragment injected into `<body>`. Contains:

- Full-viewport overlay with dark background
- Centered inblock.io logo (source: `inblockio.github.io/public/logo/inblockio_birdstyle_writing_on_dark.png`, embedded as base64 data URI)
- CSS pulse/spinner animation
- "Connecting your wallet..." text

Uses only inline styles (no external CSS dependency). Element's React app mounts over it when it loads, so no explicit teardown is needed.

### dockerfiles/Dockerfile.element

```dockerfile
FROM vectorim/element-web:latest

COPY config/element-config.json /app/config.json
COPY config/siwx-redirect.js /app/siwx-redirect.js
COPY config/siwx-splash.html /app/siwx-splash.html
COPY entrypoints/element_entrypoint.sh /docker-entrypoint.sh

RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
```

### entrypoints/element_entrypoint.sh

Runs at container start:

1. Replaces `%%MATRIX_BASE_URL%%` and `%%MATRIX_HOST%%` placeholders in `config.json` and `siwx-redirect.js`
2. Injects `<script src="siwx-redirect.js"></script>` before `</head>` in Element's `index.html`
3. Injects the splash HTML fragment before `</body>` in Element's `index.html`
4. Starts nginx (`exec nginx -g "daemon off;"`)

## Docker Compose Changes

### New service

```yaml
element-web:
  build:
    context: .
    dockerfile: dockerfiles/Dockerfile.element
  restart: unless-stopped
  environment:
    MATRIX_BASE_URL: ${MATRIX_BASE_URL}
    MATRIX_HOST: ${MATRIX_HOST}
    VIRTUAL_HOST: ${CLIENT_HOST}
    VIRTUAL_PORT: 80
    LETSENCRYPT_HOST: ${CLIENT_HOST}
    LETSENCRYPT_EMAIL: ${LETSENCRYPT_EMAIL}
  depends_on:
    matrix_synapse:
      condition: service_healthy
```

### Proxy network alias

Add `${CLIENT_HOST}` to the proxy service's network aliases so internal container DNS resolves it.

## start-matrix.sh Changes

- New required flag: `--CLIENT_HOST` (e.g., `chat.example.com`)
- Writes `CLIENT_HOST` to `.env`
- Adds `CLIENT_HOST` to the `checkRequiredArguments` validation
- Updates `printHelp` output

Example usage after changes:

```bash
./start-matrix.sh \
  --MATRIX_HOST matrix.example.com \
  --SIWEOIDC_HOST siwx-oidc.example.com \
  --CLIENT_HOST chat.example.com \
  --LETSENCRYPT_EMAIL admin@example.com
```

## Edge Cases

| Scenario | Behavior |
|---|---|
| User logs out | Element clears localStorage. Next load, shim redirects to SIWX. Clean re-auth loop. |
| Token expired | Element SDK handles refresh internally. Shim sees `mx_user_id`, does nothing. |
| `?loginToken=` in URL | Shim bails immediately. Element handles SSO callback. |
| User bookmarks the URL | Works. Shim checks session on every cold load. |
| JS disabled | Splash stays visible. Acceptable: wallet auth requires JS anyway. |
| Element version bump | Change tag in Dockerfile.element. Entrypoint re-injects into new `index.html`. |
| Multiple browser tabs | localStorage shared across tabs. No issue. |

## Upgrade Path

If Element Web adds native "auto-redirect to single SSO provider" support in `config.json` (under discussion upstream), the shim can be removed entirely. The splash would also become unnecessary since Element could handle it natively. At that point the Dockerfile.element simplifies to just config.json.

## Not In Scope

- Chat UI modifications, branding beyond the splash screen
- Mobile native apps (Element iOS/Android)
- Custom room layouts or Aqua-specific panels
- Password or other non-SIWX login methods
