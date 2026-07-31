# HANDOVER: Element Web stale-client-state hardening (post-incident 2026-07-31)

**For:** a fresh session implementing the remaining hardening.
**Status when written:** all user-facing symptoms RESOLVED; root causes confirmed;
two fixes live on dev but NOT yet promoted to prod; one hardening item NOT yet
implemented (the most important one).

## The incident in one paragraph

After the 2026-07-31 02:06 UTC prod cutover, Element Web users lost file
downloads and (after the dev v1.12.24 bump) all UI labels. Every root cause was
**stale client-side state colliding with server-side change**, in five layers:
(1) the SW media-auth chain falls back to tokenless legacy requests (guaranteed
404) on any failure — boot-window `homeserver:undefined` answers and
hard-reload-uncontrolled pages triggered it; (2–4) three unhashed files served
with NO Cache-Control (index.html — fixed in June, `i18n/languages.json` — the
raw-i18n-keys labels bug, `usercontent/` — the download iframe doc) were
heuristically cached and referenced deleted hashed assets after deploys;
(5) **wedged service-worker registrations**: long-lived browsers held a SW whose
`respondWith()` never settled, silently hanging every media fetch forever —
no error, no network entry, download button stuck disabled (Windows
`not-allowed` cursor). Layer 5 was CONFIRMED by Tim: DevTools → Application →
Service Workers → **Unregister + reload fixed it instantly**. It affected all 4
long-lived users on the prod origin only (dev/app.element.io origins have their
own SWs), and was structurally invisible to e2e (fresh contexts = fresh SW;
headless Chromium also cannot synthesize native drags — separate blindness).

## Deployed state (verify before acting)

| Where | Image / rev | Contains |
|---|---|---|
| prod (element.inblock.io) | `element-web@sha256:ef801214…` rev `628563c` | v1.12.24 + sw-boot shim (userinfo responder, controller guard, i18n+usercontent cache repair) + no-cache on index/i18n-manifest/usercontent |
| dev (dev.element.inblock.io) | rev `7397152` | everything above + full header parity sweep (`1b03eb1`) + dragstart suppression (`7397152`) |
| repo | `main` == `dev` == `7397152` | in sync; CI builds both on push |

Prod pin: `/home/deploy/matrix/stack/.env` `ELEMENT_IMAGE_REF` (digest-pinned);
deploy = `docker compose pull element-web && docker compose up -d element-web`.
Rollback doc: `/home/deploy/matrix/stack/ROLLBACK-element-20260731-swshim.md`
(pre-incident digest `7f7fe715…` tagged `:rollback-20260731-pre-swshim`).
Dev CD: push to `dev` → CI (~12 min element source build) →
`matrix-staging-deploy.timer` on dev-aquafire pulls within 5 min.

## TASK 1 — the missing hardening: per-build sw.js identity (DO THIS FIRST)

The wedged-SW fix for the whole fleet. Browsers only replace a SW when sw.js
BYTES change; our builds produce byte-identical sw.js across deploys, so a
wedged SW stays wedged forever. Force a byte change every build:

- In `dockerfiles/Dockerfile.element` (runtime stage, near the sw-boot
  injection): `RUN printf '\n// build: %s\n' "$(sha1sum /app/index.html | cut -c1-20)" >> /app/sw.js`
  (any per-build value works; index.html bundle hash is convenient).
- This re-lands the concept from `b781b89` that `9f67ed9` reverted as "dead
  weight" — the incident proved it load-bearing. Note in the commit.
- sw.js is already served `max-age=14400, must-revalidate` (parity sweep, dev
  only until promoted); browsers bypass HTTP cache for SW update checks by
  default, so the stamp reaches them on next navigation.
- Effect: every deploy replaces every user's SW (install → skipWaiting →
  claim), evicting wedged instances WITHOUT user action.

## TASK 2 — SW liveness canary in sw-boot.js (self-heal between deploys)

`config/element-sw-boot.js` already has guards A–D. Add (E): after load, if
`navigator.serviceWorker.controller` exists, race a SW-intercepted fetch
(e.g. `fetch("/_matrix/media/v3/thumbnail/liveness-probe", {cache:"no-store"})`
— ANY settled response incl. 404 proves the SW alive) against a ~8 s timeout.
On timeout: `(await navigator.serviceWorker.getRegistration())?.unregister()`
+ one-shot `location.reload()` (sessionStorage sentinel, mirror guard B's
pattern). This automates exactly the manual fix that worked. Mind: probe URL
must be SAME-ORIGIN path the SW intercepts by pathname (it is — SW matches
pathname only); keep it out of the room-media namespace to avoid log noise
confusion (the 404 will show in Synapse logs as `{None}` — add a comment or
use a recognizable media id like `swprobe`).

## TASK 3 — promote to prod

After TASK 1+2 land on dev and validate (headers live, EW-DL1 passes, sw.js
carries the stamp): promote the dev-validated digest to prod via the .env pin
(same flow as ROLLBACK doc describes; append to it). This brings the parity
sweep + drag suppression + identity stamp + canary to prod in one step.

## TASK 4 — user + upstream follow-ups

- Other 3 affected users: after TASK 3, one normal reload heals them (new SW
  installs). If needed sooner: DevTools → Application → Service Workers →
  Unregister → reload twice.
- File upstream (element-hq/element-web): (a) SW auth chain — undefined
  homeserver during boot → `new URL(undefined)` throw → tokenless fallback to
  a guaranteed-404 URL; no `response.ok` check on /versions; no per-build SW
  identity; (b) wedged-SW hang has no watchdog; (c) native `<a href>` download
  controls are drag-cancellable (and e2e can't see it — headless Chromium
  cannot synthesize native drags).
- Cleanup: ~13 throwaway `@did-pkh-…` prod probe accounts created today
  (deactivate via admin); temp specs `ew-zz-*.spec.mjs` in
  `~/wt/siwx-durability/e2e/element/` (consider keeping the restore/labs
  variants as permanent regression coverage); worktrees `~/wt/ew-sw-boot`
  (branches fix/ew-sw-boot-guard, dev-integration, main-sync) and
  `~/wt/labels-fix`; gh CLI token is dead (SEC-0001 rotation) — reprovision.
- Unresolved side-note: a DevTools Issues entry "CSP blocks eval" appeared in
  Tim's session; likely side-noise (CSP has no unsafe-eval; some lib probes
  eval). Only chase if symptoms recur with the SW healthy.

## Where the full forensic record lives

- Memory: `element-web-download-rca-2026-07-31` (Phases 1–8: every hypothesis,
  falsification, and fix with evidence).
- Plans: `docs/superpowers/plans/2026-07-31-ew-sw-boot-shim.md` (hypothesis
  register for the shim), this file.
- e2e: `~/wt/siwx-durability/e2e/element/` — run with
  `ELEMENT_URL=… MATRIX_URL=… SIWX_URL=… npx playwright test <spec>`.

---

# STATUS ADDENDUM (2026-07-31, end of hardening marathon — all tasks executed)

- **TASK 1 DONE** — per-build sw.js identity stamp (f51308b): index.html-hash +
  build-UTC timestamp appended in Dockerfile.element. Live on prod. The
  timestamp half proved load-bearing: a config-only rebuild produced an
  IDENTICAL bundle hash and only the timestamp differentiated the builds.
- **TASK 2 DONE** — guard (E) SW liveness canary (f51308b), review-hardened
  beyond this spec: DIFFERENTIAL probe (homeserver-origin SW-intercepted fetch
  vs TWO non-intercepted controls on element + homeserver origins) so neither
  a stalled network nor a slow-but-up Synapse can cause a spurious unregister;
  verified-sentinel one-shot; hidden-tab deferral. Probe goes to the
  HOMESERVER origin (this file's original same-origin suggestion would 404 at
  element-nginx and never exercise the SW's real rewrite path).
- **TASK 3 DONE** — two digest promotions (deb4ae8c… rev 62cad3d, then
  e8e1a61a… rev fbe21a7). EW-DL1 passed against prod after each. Rollback doc
  updated on the box.
- **TASK 4** — probe accounts: 15/15 created-2026-07-31 accounts deactivated
  (erase:false, admin-reversible), positively verified. Upstream filing still
  pending (gh token dead). Worktrees left in place (active).
- **BEYOND SCOPE OF THIS FILE** — official-docs deployment audit executed:
  `scripts/element-deploy-audit.sh` + checklist doc; security headers
  (XFO/CSP frame-ancestors/XCTO/XXP + server_tokens off) in container nginx;
  HSTS + MSC1929 /.well-known/matrix/support + Synapse banner suppression in
  Caddy (dev box + prod, hash-gated runbook). Audit: **21 PASS / 0 FAIL on
  both dev and prod.** Domain separation recorded as accepted deviation.
  Full trace: docs/superpowers/plans/2026-07-31-element-hardening-marathon.md.
