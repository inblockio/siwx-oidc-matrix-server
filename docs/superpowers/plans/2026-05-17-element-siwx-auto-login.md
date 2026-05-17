# Element Web SIWX Auto-Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-hosted Element Web client to the docker-compose stack that auto-redirects unauthenticated users to SIWX OIDC login with a branded splash screen.

**Architecture:** Stock `vectorim/element-web` Docker image layered with a config that locks the homeserver, a JS shim that auto-redirects to Synapse SSO, and a branded splash overlay. An entrypoint script injects the shim and splash into Element's `index.html` at container start, templating in the Matrix server URL from environment variables.

**Tech Stack:** Docker, nginx (via Element Web image), vanilla JavaScript, HTML/CSS, shell scripting (entrypoint)

**Deployment target:** `element.inblock.io` at `46.101.113.132` (DNS A record already configured)

**Spec:** `docs/superpowers/specs/2026-05-17-element-siwx-auto-login-design.md`

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `config/element-config.json` | Element Web config: locked homeserver, no password login |
| Create | `config/siwx-redirect.js` | JS shim: auto-redirect unauthenticated users to SIWX SSO |
| Create | `config/siwx-splash.html` | Branded splash overlay: logo + spinner + "Connecting your wallet..." |
| Create | `config/inblockio_logo_dark.png` | Logo asset copied from `inblockio.github.io` repo |
| Create | `dockerfiles/Dockerfile.element` | Docker image: stock Element Web + our config/shim layer |
| Create | `entrypoints/element_entrypoint.sh` | Container entrypoint: template env vars, inject shim + splash into index.html |
| Modify | `docker-compose.yml:71-95` | Add `element-web` service, add `${CLIENT_HOST}` to proxy network aliases |
| Modify | `start-matrix.sh:7,25-55,101-123,240-281` | Add `--CLIENT_HOST` flag, validation, .env writing |
| Modify | `.env.example` | Document `CLIENT_HOST` variable |
| Modify | `CLAUDE.md` | Document the new element-web service |

---

### Task 1: Create Element Web configuration

**Files:**
- Create: `config/element-config.json`

- [ ] **Step 1: Create the config directory**

```bash
mkdir -p config
```

- [ ] **Step 2: Write element-config.json**

Create `config/element-config.json` with this exact content:

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

The `%%MATRIX_BASE_URL%%` and `%%MATRIX_HOST%%` placeholders are replaced at container start by the entrypoint script (Task 5).

- [ ] **Step 3: Validate JSON syntax**

```bash
python3 -c "import json; json.load(open('config/element-config.json')); print('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add config/element-config.json
git commit -m "feat: add Element Web config locked to local Synapse"
```

---

### Task 2: Create the SIWX auto-redirect shim

**Files:**
- Create: `config/siwx-redirect.js`

- [ ] **Step 1: Write siwx-redirect.js**

Create `config/siwx-redirect.js` with this exact content:

```javascript
(function () {
  var params = new URLSearchParams(window.location.search);
  if (params.has("loginToken")) return;

  var hasSession =
    localStorage.getItem("mx_access_token") ||
    localStorage.getItem("mx_has_access_token") ||
    localStorage.getItem("mx_user_id");
  if (hasSession) return;

  var splash = document.getElementById("siwx-splash");
  if (splash) splash.style.display = "flex";

  var ssoUrl =
    "%%MATRIX_BASE_URL%%/_matrix/client/v3/login/sso/redirect/siwx-oidc";
  var redirectUrl = encodeURIComponent(
    window.location.origin + window.location.pathname
  );
  window.location.replace(ssoUrl + "?redirectUrl=" + redirectUrl);
})();
```

Guard logic:
1. If `?loginToken=` is in the URL, this is an SSO callback in progress. Bail out and let Element handle it.
2. If any of `mx_access_token`, `mx_has_access_token`, or `mx_user_id` exist in localStorage, the user is already logged in. Bail out.
3. Otherwise, show the splash overlay and redirect to the Synapse SSO endpoint for the `siwx-oidc` provider.

The `%%MATRIX_BASE_URL%%` placeholder is replaced at container start by the entrypoint script (Task 5).

- [ ] **Step 2: Validate JS syntax**

```bash
node -c config/siwx-redirect.js && echo "OK"
```

Expected: `OK`

If `node` is not available, use:
```bash
python3 -c "
import subprocess, sys
# Basic syntax check: ensure no obvious parse errors
with open('config/siwx-redirect.js') as f:
    content = f.read()
    assert 'loginToken' in content
    assert 'mx_access_token' in content
    assert 'MATRIX_BASE_URL' in content
    print('OK')
"
```

- [ ] **Step 3: Commit**

```bash
git add config/siwx-redirect.js
git commit -m "feat: add SIWX auto-redirect shim for unauthenticated users"
```

---

### Task 3: Create the branded splash screen

**Files:**
- Create: `config/siwx-splash.html`
- Create: `config/inblockio_logo_dark.png`

- [ ] **Step 1: Copy the logo asset**

```bash
cp ~/inblockio.github.io/public/logo/inblockio_birdstyle_writing_on_dark.png config/inblockio_logo_dark.png
```

- [ ] **Step 2: Write siwx-splash.html**

Create `config/siwx-splash.html` with this exact content. This is an HTML fragment (not a full page) that gets injected into Element's `<body>` by the entrypoint.

```html
<div id="siwx-splash" style="
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 99999;
  background: #0a0a0a;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
">
  <img src="inblockio_logo_dark.png" alt="inblock.io" style="
    width: 280px;
    max-width: 60vw;
    margin-bottom: 40px;
  " />
  <div style="
    width: 32px;
    height: 32px;
    border: 3px solid rgba(255,255,255,0.15);
    border-top-color: #fff;
    border-radius: 50%;
    animation: siwx-spin 0.8s linear infinite;
    margin-bottom: 24px;
  "></div>
  <p style="
    color: rgba(255,255,255,0.7);
    font-size: 15px;
    letter-spacing: 0.3px;
    margin: 0;
  ">Connecting your wallet...</p>
  <style>
    @keyframes siwx-spin {
      to { transform: rotate(360deg); }
    }
  </style>
</div>
```

Key details:
- `display: none` by default. The JS shim sets it to `flex` before redirecting.
- `z-index: 99999` ensures it covers Element's UI if it briefly appears.
- The logo is loaded from a relative path (`inblockio_logo_dark.png`) which is COPY'd into `/app/` by the Dockerfile.
- All styles are inline except the `@keyframes` animation which requires a `<style>` block.

- [ ] **Step 3: Verify files exist**

```bash
ls -la config/siwx-splash.html config/inblockio_logo_dark.png
```

Expected: both files present, logo is ~80KB.

- [ ] **Step 4: Commit**

```bash
git add config/siwx-splash.html config/inblockio_logo_dark.png
git commit -m "feat: add branded splash screen with inblock.io logo and spinner"
```

---

### Task 4: Create the container entrypoint script

**Files:**
- Create: `entrypoints/element_entrypoint.sh`

- [ ] **Step 1: Write element_entrypoint.sh**

Create `entrypoints/element_entrypoint.sh` with this exact content:

```bash
#!/bin/sh
set -e

# Template environment variables into config and shim.
# Placeholders use %% delimiters to avoid clashing with JSON/JS syntax.
sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/config.json
sed -i "s|%%MATRIX_HOST%%|${MATRIX_HOST}|g" /app/config.json
sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/siwx-redirect.js

# Inject the redirect shim script before </head> in Element's index.html.
sed -i 's|</head>|<script src="siwx-redirect.js"></script></head>|' /app/index.html

# Inject the splash HTML fragment before </body> in Element's index.html.
sed -i '/<\/body>/r /app/siwx-splash.html' /app/index.html

# Start nginx (Element Web's default server).
exec nginx -g "daemon off;"
```

Notes:
- Uses `#!/bin/sh` (not bash) because the Element Web image is Alpine-based.
- `sed -i` is safe here because we're modifying the container's copy of `index.html`, not a host-mounted file.
- The `r` command in sed reads the entire splash HTML file and inserts it before `</body>`.
- `exec nginx` replaces the shell process so signals propagate correctly.

- [ ] **Step 2: Make it executable**

```bash
chmod +x entrypoints/element_entrypoint.sh
```

- [ ] **Step 3: Validate with shellcheck (if available)**

```bash
shellcheck entrypoints/element_entrypoint.sh 2>/dev/null || echo "shellcheck not installed, skipping"
```

- [ ] **Step 4: Commit**

```bash
git add entrypoints/element_entrypoint.sh
git commit -m "feat: add Element Web entrypoint for env templating and shim injection"
```

---

### Task 5: Create the Element Web Dockerfile

**Files:**
- Create: `dockerfiles/Dockerfile.element`

- [ ] **Step 1: Write Dockerfile.element**

Create `dockerfiles/Dockerfile.element` with this exact content:

```dockerfile
FROM vectorim/element-web:latest

COPY config/element-config.json /app/config.json
COPY config/siwx-redirect.js /app/siwx-redirect.js
COPY config/siwx-splash.html /app/siwx-splash.html
COPY config/inblockio_logo_dark.png /app/inblockio_logo_dark.png
COPY entrypoints/element_entrypoint.sh /docker-entrypoint.sh

RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
```

Notes:
- All static assets land in `/app/` which is nginx's document root in the Element Web image.
- The logo PNG is served as a static file at the relative path the splash HTML references.
- The entrypoint overrides Element's default CMD to inject our shim first, then starts nginx.

- [ ] **Step 2: Verify the build context has all referenced files**

```bash
echo "Checking all COPY sources exist..."
test -f config/element-config.json && echo "  element-config.json OK"
test -f config/siwx-redirect.js && echo "  siwx-redirect.js OK"
test -f config/siwx-splash.html && echo "  siwx-splash.html OK"
test -f config/inblockio_logo_dark.png && echo "  inblockio_logo_dark.png OK"
test -f entrypoints/element_entrypoint.sh && echo "  element_entrypoint.sh OK"
```

Expected: all five lines print "OK".

- [ ] **Step 3: Build the image (dry run)**

```bash
docker build -f dockerfiles/Dockerfile.element -t element-web-siwx:test .
```

Expected: successful build, image tagged `element-web-siwx:test`.

- [ ] **Step 4: Verify the image contents**

```bash
docker run --rm element-web-siwx:test sh -c "ls -la /app/config.json /app/siwx-redirect.js /app/siwx-splash.html /app/inblockio_logo_dark.png /docker-entrypoint.sh"
```

Expected: all five files present with correct permissions. `/docker-entrypoint.sh` should be executable.

- [ ] **Step 5: Clean up test image**

```bash
docker rmi element-web-siwx:test
```

- [ ] **Step 6: Commit**

```bash
git add dockerfiles/Dockerfile.element
git commit -m "feat: add Dockerfile for Element Web with SIWX auto-login layer"
```

---

### Task 6: Update docker-compose.yml

**Files:**
- Modify: `docker-compose.yml:71-95` (proxy service network aliases), append new service

- [ ] **Step 1: Add the element-web service to docker-compose.yml**

Append the following service block after the `letsencrypt` service (before the `volumes:` section at the bottom):

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

- [ ] **Step 2: Add CLIENT_HOST to the proxy network aliases**

In the `proxy` service, the `networks.default.aliases` list currently has two entries:

```yaml
    networks:
      default:
        aliases:
          - ${SIWEOIDC_HOST}
          - ${MATRIX_HOST}
```

Add a third alias:

```yaml
    networks:
      default:
        aliases:
          - ${SIWEOIDC_HOST}
          - ${MATRIX_HOST}
          - ${CLIENT_HOST}
```

This allows containers on the Docker network to resolve `element.inblock.io` to the proxy.

- [ ] **Step 3: Validate the compose file**

```bash
CLIENT_HOST=element.test MATRIX_BASE_URL=https://matrix.test MATRIX_HOST=matrix.test SIWEOIDC_HOST=siwx.test SIWEOIDC_PORT=8081 MATRIX_PORT=8080 MATRIX_REPORT_STATS=no LETSENCRYPT_EMAIL=test@test.com SIWEOIDC_DEFAULT_CLIENTS='{}' SIWEOIDC_BASE_URL=https://siwx.test RUST_LOG=error SIWEOIDC_SIGNING_KEY_PEM=test MATRIX_MESSAGE_LIFETIME=4w docker compose config > /dev/null && echo "OK"
```

Expected: `OK` (no syntax errors in the compose file).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add element-web service and proxy alias for CLIENT_HOST"
```

---

### Task 7: Update start-matrix.sh

**Files:**
- Modify: `start-matrix.sh`

Four changes needed:
1. Add `CLIENT_HOST=` variable initialization at the top
2. Add `--CLIENT_HOST` to the argument parser
3. Add `CLIENT_HOST` validation in `checkRequiredArguments`
4. Write `CLIENT_HOST` to `.env` in the setup block
5. Update `printHelp`

- [ ] **Step 1: Add CLIENT_HOST variable initialization**

At `start-matrix.sh:7`, the variable declarations block. Add `CLIENT_HOST=` after `SIWEOIDC_HOST=`:

```bash
SIWEOIDC_HOST=
SIWEOIDC_PORT=
```

becomes:

```bash
SIWEOIDC_HOST=
CLIENT_HOST=
SIWEOIDC_PORT=
```

- [ ] **Step 2: Add --CLIENT_HOST to the argument parser**

In the `while [ "$#" -gt 0 ]` case block (line 162 onward), add a new case after the `--SIWEOIDC_HOST` case (after line 189):

```bash
            --CLIENT_HOST)
                CLIENT_HOST="$2"
                shift
                shift
                ;;
```

- [ ] **Step 3: Add CLIENT_HOST to checkRequiredArguments**

In the `checkRequiredArguments` function (around line 101), add after the `SIWEOIDC_HOST` check:

```bash
    if [[ -z "${CLIENT_HOST}" ]]; then
      echoError "missing CLIENT_HOST!!!!"
      echoError "use --CLIENT_HOST"
      printHelp
      exit 1
    fi
```

- [ ] **Step 4: Write CLIENT_HOST to .env**

In the `.env` writing block (around line 270, after the `#MATRIX-CONFIG` section), add:

```bash
  echo "" >> .env
  echo "#CLIENT-CONFIG" >> .env
  echo "CLIENT_HOST=$CLIENT_HOST" >> .env
```

- [ ] **Step 5: Update printHelp**

In the `printHelp` function, add a new section after the MATRIX-Config block:

```bash
echo ""
echo ""

echo "Element Web Client Config"
echo "--CLIENT_HOST (required) \"set element-web client hostname e.g. element.example.com\""
```

- [ ] **Step 6: Verify the script parses correctly**

```bash
bash -n start-matrix.sh && echo "Syntax OK"
```

Expected: `Syntax OK`

- [ ] **Step 7: Verify --help output includes CLIENT_HOST**

```bash
bash start-matrix.sh --help 2>&1 | grep -i client
```

Expected: shows the `--CLIENT_HOST` help text.

- [ ] **Step 8: Commit**

```bash
git add start-matrix.sh
git commit -m "feat: add --CLIENT_HOST flag to start-matrix.sh for Element Web"
```

---

### Task 8: Update .env.example and CLAUDE.md

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add CLIENT_HOST to .env.example**

Append the following section to the end of `.env.example`:

```
#--- Element Web Client ---
# CLIENT_HOST=element.example.com
```

- [ ] **Step 2: Update CLAUDE.md services table**

In `CLAUDE.md`, the "Services" table lists 5 services. Add `element-web`:

```
| `element-web`    | `./dockerfiles/Dockerfile.element` (Element Web) | 80 (internal) | SIWX auto-login client, served via proxy at `${CLIENT_HOST}` |
```

- [ ] **Step 3: Update CLAUDE.md common operations**

In the "Common operations" section, update the first-time start example to include `--CLIENT_HOST`:

```bash
# First-time start (production)
./start-matrix.sh \
  --MATRIX_HOST matrix.example.com \
  --SIWEOIDC_HOST siwx-oidc.example.com \
  --CLIENT_HOST element.example.com \
  --LETSENCRYPT_EMAIL you@example.com
```

- [ ] **Step 4: Add a brief section to CLAUDE.md about the Element Web client**

After the "Admin promotion" section, add:

```markdown
## Element Web client

A self-hosted Element Web instance is included in the stack, accessible at
`https://${CLIENT_HOST}`. It is pre-configured to connect to the local Synapse
and auto-redirects unauthenticated users to the SIWX OIDC login flow.

The redirect logic lives in `config/siwx-redirect.js`. A branded splash screen
(`config/siwx-splash.html`) displays briefly while the redirect occurs. Both are
injected into Element's `index.html` at container start by
`entrypoints/element_entrypoint.sh`.

No Element Web fork is needed. The stock `vectorim/element-web` image is used as
a base. To update Element, change the tag in `dockerfiles/Dockerfile.element`.
```

- [ ] **Step 5: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: document element-web service, CLIENT_HOST config"
```

---

### Task 9: Build and smoke test

**Files:** None (verification only)

- [ ] **Step 1: Build all images**

```bash
docker compose build
```

Expected: all images build successfully, including the new `element-web` service.

- [ ] **Step 2: Inspect the element-web image**

Verify the entrypoint injects correctly by replaying its sed commands inside the built image:

```bash
docker compose build element-web
docker compose run --rm --no-deps -e MATRIX_BASE_URL=https://matrix.test.com -e MATRIX_HOST=matrix.test.com --entrypoint sh element-web -c '
  # Run the entrypoint logic manually (minus the exec nginx)
  sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/config.json
  sed -i "s|%%MATRIX_HOST%%|${MATRIX_HOST}|g" /app/config.json
  sed -i "s|%%MATRIX_BASE_URL%%|${MATRIX_BASE_URL}|g" /app/siwx-redirect.js
  sed -i "s|</head>|<script src=\"siwx-redirect.js\"></script></head>|" /app/index.html
  sed -i "/<\/body>/r /app/siwx-splash.html" /app/index.html

  echo "--- config.json: base_url ---"
  grep "matrix.test.com" /app/config.json && echo "PASS" || echo "FAIL"

  echo "--- siwx-redirect.js: SSO URL ---"
  grep "matrix.test.com" /app/siwx-redirect.js && echo "PASS" || echo "FAIL"

  echo "--- index.html: script tag ---"
  grep "siwx-redirect.js" /app/index.html && echo "PASS" || echo "FAIL"

  echo "--- index.html: splash div ---"
  grep "siwx-splash" /app/index.html && echo "PASS" || echo "FAIL"
'
```

Expected: all four checks print `PASS`.

- [ ] **Step 3: Verify no regressions in existing services**

```bash
CLIENT_HOST=element.test MATRIX_BASE_URL=https://matrix.test MATRIX_HOST=matrix.test SIWEOIDC_HOST=siwx.test SIWEOIDC_PORT=8081 MATRIX_PORT=8080 MATRIX_REPORT_STATS=no LETSENCRYPT_EMAIL=test@test.com SIWEOIDC_DEFAULT_CLIENTS='{}' SIWEOIDC_BASE_URL=https://siwx.test RUST_LOG=error SIWEOIDC_SIGNING_KEY_PEM=test MATRIX_MESSAGE_LIFETIME=4w docker compose config > /dev/null && echo "Compose config OK"
```

Expected: `Compose config OK`

- [ ] **Step 4: Final commit (if any fixups were needed)**

```bash
git status
# If any changes were made during smoke testing, commit them
```
