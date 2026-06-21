# Element Web index.html `no-cache` — durable fix for the stale-bundle TDZ crash

**Repo:** `siwx-oidc-matrix-server` (builds the element-web image).
**Date:** 2026-06-19. **Scope:** element-web nginx only. NOT siwx-oidc; NOT the passkey feature.

## Context (logic-model CONTEXT)
This session's RCA: `element.inblock.io` serves `index.html` with no `Cache-Control`
(stock `nginx-unprivileged` default.conf — confirmed live), so browsers heuristically
cache a stale `index.html` that references *old* content-hashed chunks → mismatched-chunk
`Cannot access 'B' before initialization` TDZ ("Your Element is misconfigured"). The
content-hashed bundles (`/bundles/<hash>/*`) are immutable-safe; only the HTML entrypoint
must always be revalidated. The portal Caddy edge is not version-controlled / not
accessible here (Caddyfile path absent) → rejected; the image nginx config is the
reviewable, rollback-able layer.

## Goal (one sentence)
Serve element-web's `index.html` (and `/`) with `Cache-Control: no-cache, must-revalidate`
via the image's nginx config, so browsers always revalidate the HTML and load the current
hashed bundles — **without changing the bundles or breaking sessions.**

## Acceptance criteria
- AC1: `GET /` and `GET /index.html` return `Cache-Control: no-cache, must-revalidate`.
- AC2: `/bundles/<hash>/*` and other static assets are NOT given `no-cache` (unchanged).
- AC3: The webapp bundle is byte-identical to the current deployment (only nginx differs)
  — same `index.html` bundle references / same `/app/bundles` set.
- AC4: `nginx -t` passes; a local container serves `/` → 200 + the header + the SPA loads.
- AC5: Reviewable PR to `siwx-oidc-matrix-server`; rollback = repoint the element-web image tag.
- AC6: No siwx-oidc change; passkey feature NOT redeployed.

## Hypothesis register
| ID | If | Then | Assumptions | Verification |
|----|----|------|-------------|--------------|
| H1 | `index.html` served `Cache-Control: no-cache, must-revalidate` | browsers revalidate it every load → always reference the current hashed bundles → no mismatched-chunk TDZ | browser honors no-cache (standard) | curl `/` + `/index.html` show the header (200 and 304 via `always`) |
| H2 | a `location = /index.html` (+ `=/`) block adds the header | ONLY the HTML gets `no-cache`; `/bundles/<hash>/*` + assets keep default caching | exact-match locations don't leak | curl a hashed bundle → NO `no-cache`; index.html → has it |
| H3 | only the nginx config changes (builder stage untouched) | the served webapp (bundle hashes) is identical to current prod → deploy changes zero chunks → safe for fresh AND stale-cached clients | frozen-lockfile + pinned tag ⇒ deterministic hashes | diff new image `/app/bundles` listing + `index.html` refs vs current image; they match |
| H4 | `nginx -t` passes and a local container serves `/`→200+header and the SPA boots | the config is valid and non-breaking | — | `docker run` the built image; `nginx -t`; curl |
| H5 | the change ships as a PR + image-tag deploy | reviewable; rollback = repoint element-web image tag (matrix stack `IMAGE_TAG` / per-service tag) | prod tag mechanism unchanged | PR URL; documented rollback command |

## Activities → Outputs
1. **Add** `config/element-nginx.conf` = the stock server block + an exact-match
   `location = /index.html { add_header Cache-Control "no-cache, must-revalidate" always; }`
   and the same on `location = /` (covers the `index` internal redirect). Keep
   `error_page`/`50x` as-is. → the config file.
2. **Edit** `dockerfiles/Dockerfile.element`: `COPY config/element-nginx.conf /etc/nginx/conf.d/default.conf`
   in the runtime stage (after the bundle COPY). → Dockerfile change.
3. **Build + verify locally**: `nginx -t`; run the container; curl `/` (header present),
   `/index.html` (header), a `/bundles/<hash>/*` (NO no-cache), SPA boots. → local evidence.
4. **Verify bundle identity (H3/AC3)**: compare the new image's `/app/bundles` set +
   `index.html` script refs against the currently-deployed element-web image. Identical ⇒
   the prod deploy changes no chunks ⇒ cannot break any client. → hash-match evidence.
5. **(Gate) Ship**: PR to `siwx-oidc-matrix-server`; CI builds the element-web image;
   deploy element-web only on prod; verify live header + a clean load. Rollback = prior tag.

## Boundary conditions
- **Invariants:** only `index.html` is `no-cache`; hashed bundles unchanged; no siwx-oidc
  change; no passkey redeploy.
- **Assumptions (→ risks):** (R1) rebuild yields identical bundle hashes — *verified in
  Activity 4 before any prod deploy*; if they ever differ, fall back to an overlay image
  (`FROM <current element-web image> + COPY nginx conf`) which guarantees identical bundles,
  or deploy in a maintenance window. (R2) bad nginx config → element-web won't serve —
  caught by `nginx -t` + local container test. (R3) deploy restart blip — element-web is a
  static server; a restart does NOT force open tabs to reload, and bundles are unchanged, so
  no client hits a mismatch.
- **Exclusions:** hashed-asset `immutable` long-cache (a perf optimization) — out of scope;
  Caddy edge — rejected.

## Out of scope
siwx-oidc; the passkey-offer-scoping feature (stays rolled back/unmerged); Synapse.
