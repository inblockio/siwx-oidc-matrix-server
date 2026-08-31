# HANDOVER — Element Web index.html `no-cache` fix (+ passkey-feature state)

**Written:** 2026-06-19. **Start a fresh session and point it at this file.**

---

## TL;DR — what to do next

1. **Task A is DONE + MERGED to `main` (NOT deployed) as of 2026-06-21.** The Element
   Web `index.html` `Cache-Control: no-cache, must-revalidate` fix shipped: feature
   commit `fda5931`, merge commit `a910f58` on `inblockio/siwx-oidc-matrix-server`
   `main`. Files: `config/element-nginx.conf` (new) + `dockerfiles/Dockerfile.element`
   (one COPY). Phase 2 local verification all-green (see Task A section). Pushing `main`
   triggers CI to build the `:main` element-web image but does **not** reach prod.
   **Remaining = prod cutover only, gated on an explicit go:** once CI has published
   `:main`, on prod `/home/deploy/matrix/stack` run `docker compose pull element-web &&
   docker compose up -d element-web`; verify `curl -sI https://element.inblock.io/ | grep
   -i cache-control` shows `no-cache, must-revalidate`. Rollback = repoint element-web to
   the prior image digest `sha256:37be72e5…` (current prod) and `up -d element-web`.
2. **Do NOT** touch siwx-oidc or redeploy the passkey feature in that task — it's solely the
   element-web nginx cache header.

---

## Task A (MERGED to main, NOT DEPLOYED): element-web `index.html` no-cache fix

**Status 2026-06-21:** shipped to `main` (commit `fda5931`, merge `a910f58`). Phase 2
local verification all-green: `nginx -t` ok; the locally-built image serves `/` and
`/index.html` with `Cache-Control: no-cache, must-revalidate` (200 and 304 via `always`)
and `/bundles/<hash>/*` WITHOUT it; the SPA boots. **H3 bundle-identity confirmed
byte-identical to deployed prod** (`element-web:main` @ `sha256:37be72e5…`): 157 bundle
files, sorted-list sha256 `05c1411e…a6c125d5`, same entry dir
`bundles/0a20451d7d3b2d55b5eb/` — the deploy changes zero chunk hashes. NOT deployed
(prod cutover gated on explicit go; see TL;DR). Implemented exactly as planned below,
with one correctness refinement: a single `location = /index.html` carrying the header
(a bare `location = /` with only `add_header` would 403 — no root/index — while `nginx -t`
still passes; the `index` directive internally redirects `/` to `/index.html`, so both
carry the header).

**Why:** RCA this session (see Task C) found `element.inblock.io` serves `index.html`
with **no `Cache-Control`** (stock `nginx-unprivileged`), so browsers heuristically cache a
stale `index.html` → it references *old* content-hashed chunks → mismatched-chunk TDZ
`Cannot access 'B' before initialization` ("Your Element is misconfigured"). Fix: make the
HTML always revalidate so clients always load the current hashed bundles.

**Where (decided):** the element-web image nginx config in **`~/siwx-oidc-matrix-server`**
(version-controlled, PR-reviewable, image-tag rollback). The portal Caddy edge was REJECTED
(its Caddyfile is not accessible / not version-controlled from this box).

**The change (Phase 2 to implement):**
- Element-web is built by `dockerfiles/Dockerfile.element` (element-web `v1.12.20` from
  source + `patches/element-web/force-first-device-recovery.patch`), served by stock
  `nginxinc/nginx-unprivileged:alpine-slim`; bundle at `/app` (symlinked to
  `/usr/share/nginx/html`); `entrypoints/element_entrypoint.sh` runs `nginx -g "daemon off;"`.
- The container's CURRENT `/etc/nginx/conf.d/default.conf` (captured live):
  ```nginx
  server { listen 8080; server_name localhost;
    location / { root /usr/share/nginx/html; index index.html index.htm; }
    error_page 500 502 503 504 /50x.html;
    location = /50x.html { root /usr/share/nginx/html; } }
  ```
- **Add** `config/element-nginx.conf` = that server block PLUS:
  ```nginx
  location = / {
      add_header Cache-Control "no-cache, must-revalidate" always;
  }
  location = /index.html {
      add_header Cache-Control "no-cache, must-revalidate" always;
  }
  ```
  (keep `location /`, `error_page`, `50x` as-is; `always` so the header is also on 304s).
- **Edit** `dockerfiles/Dockerfile.element`: add `COPY config/element-nginx.conf
  /etc/nginx/conf.d/default.conf` in the runtime stage (after the `COPY --from=builder
  /src/apps/web/webapp /app` line).

**KEY SAFETY PROPERTY (H3):** the builder stage is untouched, so the content-hashed bundles
are **byte-identical** to the deployed ones → the deploy changes **zero chunk hashes** → no
client (fresh OR stale-cached) can hit a mismatch. This is the answer to "don't break
sessions." **Verify before any prod deploy:** the rebuilt image's `/app/bundles` set +
`index.html` script refs MATCH the currently-deployed element-web image. If they ever
differ, fall back to an overlay image (`FROM <current element-web image> + COPY nginx conf`,
guaranteeing identical bundles) or a maintenance window.

**Phase 2 verification (local, no prod):**
- `nginx -t` passes; `podman build` the image; run it; curl `/` and `/index.html` → header
  present; curl a `/bundles/<hash>/*` → header ABSENT; SPA boots.
- Confirm bundle-hash identity vs current prod (H3 gate above).
- Then STOP and show evidence; the prod cutover (PR → CI element-web image → on prod set the
  element-web image tag + `docker compose up -d element-web`) is a SEPARATE explicit go.

**Element-web deploy/rollback mechanism:** prod matrix stack compose uses
`image: ghcr.io/inblockio/siwx-oidc-matrix-server/element-web:${IMAGE_TAG:-main}` (the
`IMAGE_TAG` var is shared with synapse — both built from this repo; deploy element-web ONLY
with `docker compose up -d element-web`). Rollback = repoint element-web to the prior tag.
CI for this repo: `dockerfiles/` build; tags via metadata-action (branch / `sha-<short>`).

---

## Task B (PAUSED): passkey-offer-scoping feature (siwx-oidc)

**State:** built, tested, audited, **deployed to prod then ROLLED BACK** (the rollback was
because of the Element error in Task C, which is NOT this feature's fault). Unmerged.

- Branch `feat/passkey-offer-scoping`, worktree `~/siwx-oidc-passkey-scope`, base `a074795`,
  HEAD `8e7fcfe`. **PR #15** (inblockio/siwx-oidc). 108 unit + 26 browser tests, 0 warnings,
  4-lens adversarial audit clean (2 LOW test-gaps found+closed).
- Image built: `ghcr.io/inblockio/siwx-oidc:feat-passkey-offer-scoping` (= `sha-8e7fcfe`).
- What it does: scopes the `/account/passkey/start` + `/device/passkey/start` pickers to the
  caller's own keys via the opaque `siwx_user` login cookie (self-contained, no client
  change), degrade-open, escape hatch, detected_mxid. Docs:
  `~/siwx-oidc-passkey-scope/docs/superpowers/plans/2026-06-19-passkey-offer-scoping-*.md`.
  Memory: `passkey-offer-scoping-cookie.md`.
- To re-deploy for testing (AFTER Task A makes deploys session-safe): on prod
  `/home/deploy/matrix/stack`, set `SIWX_OIDC_TAG=feat-passkey-offer-scoping` in `.env`,
  `docker compose pull siwx-oidc && docker compose up -d siwx-oidc`. To promote: merge PR #15
  → CI builds `:main` → set tag back to `main`.

---

## Task C (DONE): RCA of the Element "misconfigured" crash

**Conclusion:** the crash is a **stale Element Web bundle cache** (mismatched chunks → TDZ),
NOT a siwx-oidc content bug. Evidence:
- siwx-oidc OIDC surface (discovery/token/metadata/CORS/routes) is **byte-identical**
  between the deployed (`8e7fcfe`) and rolled-back (`db79e75`) images (source diff: `oidc.rs`,
  `config.rs`, `.well-known`, routes unchanged).
- Signing key is **pinned** (`SIWEOIDC_SIGNING_KEY_PEM` set; JWKS `kid:"key1"` stable) →
  restarts don't rotate keys / invalidate sessions.
- The crashing assets (`init.js?<ts>` + `bundle.js?<ts>`) are an OLD element-web scheme;
  current element.inblock.io serves `bundles/<hash>/bundle.js` (no init.js).
- **Trigger:** `docker compose up -d siwx-oidc` (any deploy) briefly drops OIDC; with
  element-web `config.json` `"sso_redirect_options": { "immediate": true }` +
  `"force_verification": true`, sessions force a re-auth/reload that loads the stale cache →
  TDZ. The revert was another reload cycle by which the browser had refetched a consistent
  bundle. ⇒ image CONTENT incidental; **the restart was the trigger.** Task A removes the
  crash class so future deploys are safe.

---

## Environment / access (verified this session)

- **Prod:** `ssh -p 8022 deploy@agentic.inblock.io`; stack `/home/deploy/matrix/stack`
  (`docker-compose.yml` + `.env`). This box's key is authorized. Deploys are MANUAL.
- **siwx-oidc prod NOW:** `SIWX_OIDC_TAG=sha-db79e75` (the original good image; `:main` is the
  newer `a074795` revert and was NOT the prod image — rollback target is `sha-db79e75`, never
  bare `:main`). `.env` backup: `.env.bak-pre-passkey-scope-20260619`.
- `gh` CLI authed for the `inblockio` org. GHCR images pullable.
- WSL memory governance: if a subagent spawn is denied, run inline; check
  `~/bin/resource-guard.sh verdict`.
- Concurrent agents may edit these repos — `git status`/mtimes before large edits.
