# Element Web SW media-auth boot shim (Trigger A + B fixes)

**Date:** 2026-07-31 · **Branch:** fix/ew-sw-boot-guard (off origin/dev) · **Pipeline:** /process-pipeline

## Problem (verified, 2026-07-31 download RCA)

Element Web's sw.js rewrites legacy media URLs to authenticated ones, but on
ANY failure in its auth chain it refetches the legacy URL **without auth**,
which Synapse (authenticated media, default-on since 1.120) 404s. Two triggers
were anchored in code + prod Synapse logs:

- **Trigger A (boot window):** `WebPlatform.onServiceWorkerPostMessage`
  (upstream `apps/web/src/vector/platform/WebPlatform.ts:96`) answers the SW's
  per-request `userinfo` query with
  `homeserver = MatrixClientPeg.get()?.getHomeserverUrl()` — `undefined` until
  the client starts. The SW (`apps/web/src/serviceworker/index.ts:73`) then
  throws on `new URL(undefined)` → single catch → tokenless legacy fetch →
  404. Log signature: tokenless-404 bursts starting 1–2 s after every page
  load. Present in v1.12.20 and v1.12.24 (SW source byte-identical).
- **Trigger B (uncontrolled page):** a hard-reloaded (shift-reload) page is
  never controlled by the SW, so ALL its media fetches bypass the rewrite for
  the page's lifetime (observed: 6.5 h × 152 tokenless 404s from one prod
  client). Only a normal navigation heals it.

## Fix (config/build-layer only — no element-web source patch)

One head-injected same-origin script `sw-boot.js` (CSP has `script-src 'self'`,
no `unsafe-inline`, so it must be a file, not inline):

- **(A)** an early `message` listener answers `userinfo` from localStorage
  (`mx_user_id`, `mx_device_id`, `mx_hs_url` — written by
  `Lifecycle.persistCredentials`, `Lifecycle.ts:884`). The SW resolves on the
  FIRST reply with its responseKey and head scripts register before app
  bundles, so this shields the boot window; post-boot both replies are equal.
- **(B)** after load+3 s, if the page is uncontrolled but an ACTIVE SW
  registration exists → one `location.reload()` (sessionStorage sentinel,
  strictly one-shot; never in iframes; no-op when no registration exists).

Delivery: `COPY config/element-sw-boot.js /app/sw-boot.js` + build-time
`sed 's|<head>|<head><script src="sw-boot.js"></script>|'` in
Dockerfile.element (same anchor the runtime entrypoint already uses for the
theme CSS), with a build-failing grep guard. nginx serves `/sw-boot.js`
no-cache (stable filename must not be heuristically cached).

## Hypothesis Register

| ID | If | Then | Assumptions | Verification |
|----|----|------|-------------|--------------|
| H1 | a logged-in session exists | `localStorage.mx_hs_url` holds the homeserver URL | upstream keeps `HOMESERVER_URL_KEY` | grep upstream v1.12.24 `Lifecycle.ts:71,575,884` — CONFIRMED pre-plan |
| H2 | the shim registers its listener in `<head>` | its `userinfo` reply reaches the SW first; SW uses it | EventTarget dispatch order; SW resolves on first matching responseKey (`serviceworker/index.ts:147-179`) | code citation + post-deploy live check |
| H3 | the SW gets a defined homeserver during boot | boot-window media requests are rewritten+authed (no tokenless legacy 404 burst) | IndexedDB token/pickle readable independent of page boot (verified in RCA C3) | dev Synapse logs after deploy: page reload produces no `{None}` media/v3 404 burst |
| H4 | page uncontrolled + active registration | one-shot reload restores controller | normal reload re-attaches controller (verified RCA/EW-DL3) | manual: Ctrl+Shift+R on dev → auto-reload once → controlled |
| H5 | sentinel + registration checks | guard can never loop or fire on first visit | sessionStorage works | code review; manual observation of exactly one reload |
| H6 | build-time sed on built index.html | script tag present in served HTML, CSP-clean | upstream index.html keeps literal `<head>`; CSP `script-src 'self'` | build grep guard; post-deploy `curl /` shows tag; `curl /sw-boot.js` = 200 no-cache |
| H7 | push to dev branch | CI builds :dev images; dev-aquafire converges ~9 min | CI on `[main, dev]`; dev CD loop healthy | watch gh run + dev box image digest + live marker |
| H8 | fixes deployed | downloads still work on dev (no regression) | e2e harness runnable | EW-DL1/EW-DL2 specs vs dev, or manual download check |

## Boundary conditions

- dev branch/deploy only — prod untouched. No element-web source patches.
- Shim must be a strict no-op when logged out, SW-less, embedded, or on first
  visit. Never breaks the app (all paths try/catch or guarded).
- Coordinated with the parallel `fix/element-labels` work; single integration
  push to dev by the orchestrator.

## Tasks

1. **[H1,H6]** Verify `mx_hs_url` + CSP + `<head>` anchor. — done pre-plan
2. **[H2,H4,H5]** Implement `config/element-sw-boot.js`.
3. **[H6]** Dockerfile COPY+sed+grep guard; nginx no-cache for `/sw-boot.js`.
4. **[H6]** Local verification: `node --check`; sed simulation on live dev index.html.
5. **[H7]** Integrate with labels fix; push dev; watch CI + convergence.
6. **[H3,H4,H8]** Post-deploy verification on dev; audit report.
