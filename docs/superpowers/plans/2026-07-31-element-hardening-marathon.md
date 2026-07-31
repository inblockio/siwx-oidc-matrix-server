# Element deployment hardening marathon (2026-07-31)

**Mode:** unsupervised end-to-end (user pre-authorized plan + deploy gates in the
session brief). Staged: dev → validate → prod, twice (Stage A, Stage B).
**Follows:** `2026-07-31-sw-hardening-handover.md` (Tasks 1–4) + official-docs
audit scope from the session brief.

## Goal

Prod serves the dev-validated hardened Element build (per-build sw.js identity +
SW liveness canary + header/cache parity), and both environments pass an
official-docs-derived deployment audit — with client/server domain separation
recorded as an accepted deviation, not fixed.

## Hypothesis Register

| ID | If | Then | Assumptions | Verification |
|----|----|------|-------------|--------------|
| H1 | sw.js bytes change every build (stamp appended in Dockerfile) | every deploy replaces every user's SW on next navigation → wedged SWs evicted fleet-wide | upstream sw.js does `skipWaiting`+`clients.claim` (VERIFIED: both present in v1.12.24 bundle); browsers bypass HTTP cache for SW update checks (spec default `updateViaCache:"imports"`) | two consecutive CI builds → different sw.js sha1, both containing `// build:` stamp; dev sw.js ≠ baseline `1a5c8d478105…` |
| H2 | guard E races a SW-intercepted fetch vs ~8 s timeout and unregisters+reloads once on hang | a wedged SW self-heals between deploys (automates the confirmed manual fix) | SW matches by pathname only; ANY settled response (incl. 404) proves liveness; sessionStorage sentinel prevents reload loops | code review (opus gate) + e2e proves NO false-positive reload on healthy dev; firing path not e2e-reachable (fresh contexts = fresh SW) → status ceiling: Partial by design |
| H3 | push to `dev` branch | CI builds `:dev` image, dev-aquafire converges ≤ ~17 min | CI green; staging timer runs ≤5 min | dev.element serves new sw.js stamp + guard E in sw-boot.js |
| H4 | dev-validated digest pinned in prod `.env` + compose pull/up | prod byte-identical to dev → downloads work, parity sweep + drag suppression reach prod | digest-pin promotion flow works (established 2026-07-31) | prod sw.js == dev sw.js sha1; prod headers == dev headers; download smoke on prod |
| H5 | audit checklist derived from official element-web/Synapse docs, encoded as a curl-based script | deviations (headers, cache, well-known, banners) are detected categorically, not anecdotally | official docs reachable; docs actually specify the checks (XFO, CSP frame-ancestors, XCTO, no-cache set) | script flags the KNOWN prod gaps (no HSTS/XFO/XCTO) and passes where dev is already correct |
| H6 | element-origin security headers added in `config/element-nginx.conf` | they ride the normal CI pipeline (dev first) and appear on both origins without breaking the app | XFO SAMEORIGIN / frame-ancestors 'self' don't break same-origin iframes (usercontent/ download iframe, jitsi.html) | audit green on dev + EW e2e still passes (download via usercontent iframe exercised) |
| H7 | proxy-level fixes (HSTS on prod, banner suppression, `/.well-known/matrix/support`) applied to dev Caddy then prod Caddy | audit green on matrix+element origins without breaking federation, clients, or OIDC | Caddy edits don't touch siwx-oidc CORS-strip blocks; federation unaffected by header changes | audit script + federation tester + OIDC login smoke after each Caddy change |
| H8 | ~13 throwaway `@did-pkh-…` probe accounts deactivated via Synapse admin API | no orphaned probe accounts remain active on prod | admin token valid; accounts enumerable via admin API | admin API user list query shows them deactivated |

## Acceptance Criteria

| # | Criterion | Hypotheses |
|---|-----------|------------|
| AC1 | prod sw.js carries per-build stamp and changes across deploys | H1, H3, H4 |
| AC2 | canary guard E live on prod; zero false-positive reloads on healthy origins | H2 |
| AC3 | prod file downloads verified working post-promotion | H4 |
| AC4 | audit script green on dev AND prod: XFO SAMEORIGIN, CSP frame-ancestors 'self', XCTO nosniff, HSTS, no-cache on unhashed entrypoints, bundle-retention note, `/.well-known/matrix/support` 200 JSON, server banners suppressed | H5, H6, H7 |
| AC5 | domain separation (element.inblock.io / matrix.inblock.io share eTLD+1) recorded as ACCEPTED decision, unchanged | — |
| AC6 | probe accounts deactivated; records/memory updated; upstream-issue list recorded (gh token dead → file later) | H8 |

## Tasks (mirror of session task ledger #1–#6)

### Task A1 — sw.js stamp + canary guard E
**Hypotheses:** H1, H2
**Files:** `dockerfiles/Dockerfile.element` (stamp after sw-boot injection),
`config/element-sw-boot.js` (guard E).
Sonnet implementer → opus review gate → push.

### Task A2 — dev validation
**Hypotheses:** H1, H2, H3
Push to `dev`; watch CI+CD converge; verify stamp, guard E, headers; run
EW-DL1 + labels/restore specs from `~/wt/siwx-durability/e2e/element/`.
Second build (Stage B push) must produce a DIFFERENT sw.js sha1 → completes H1.

### Task A3 — prod promotion
**Hypotheses:** H4
Pin dev-validated digest in `/home/deploy/matrix/stack/.env`
(`ELEMENT_IMAGE_REF`), compose pull/up, append to
`ROLLBACK-element-20260731-swshim.md`, verify parity + download smoke.

### Task B1 — official-docs checklist + audit script
**Hypotheses:** H5
Research element-web install docs / repo nginx guidance / Synapse config manual
/ MSC1929. Deliver: checklist doc (this repo, `docs/`) + `scripts/element-deploy-audit.sh`
(pure curl, per-origin, exit non-zero on any FAIL, domain-separation explicitly
listed as ACCEPTED-SKIP).

### Task B2 — harden dev → prod
**Hypotheses:** H6, H7
Element-origin headers in `element-nginx.conf` (CI pipeline); HSTS/banners/
well-known-support in dev-aquafire Caddy then prod Caddy (backup first; never
touch siwx-oidc CORS-strip blocks). Audit green on dev → promote → audit green
on prod.

### Task C — cleanup + records
**Hypotheses:** H8
Deactivate probe accounts; record accepted domain-separation decision +
upstream-issue list; update memory + handover doc; keep valuable `ew-zz-*`
specs as permanent regression coverage.

## Boundary conditions

- **Exclusions:** domain separation (record only); no Synapse/MAS upgrades; no
  gh-API-dependent steps (token dead — pushes are SSH and work).
- **Invariants:** prod changes only after dev validation; prod Caddyfile backed
  up before edit; siwx-oidc CORS stripping preserved; no secrets in logs/session.
- **Top risks:** (1) CI element source build ~12 min/iteration → batch changes;
  (2) prod Caddy edit blast radius → backup + immediate smoke + rollback doc;
  (3) e2e blindness to SW replacement → byte-diff validation, not e2e, proves H1.
