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

---

# Phase 3 AUDIT (executed 2026-07-31, end of marathon)

## Hypothesis Trace

| ID | Status | Evidence (commands actually run) |
|----|--------|----------------------------------|
| H1 | **Confirmed** | build1 sw.js sha1 `e000dd3c` ≠ baseline `1a5c8d47`, stamp `66d89731… 19:17:00Z`; build2 sha1 `31fc7c56` ≠ build1 with IDENTICAL bundle-hash half and differing timestamp half (`20:37:16Z`) — the dual-component stamp is what preserved per-build uniqueness on a config-only rebuild. `sha1sum` + `curl …/sw.js | tail -c 200` on both origins. |
| H2 | **Partial (by design, as registered)** | No-false-positive half CONFIRMED: 0 `liveness probe hung` warns across 13 e2e spec runs on dev + prod. Firing path unreachable in e2e (fresh context = fresh SW); mitigated by two opus review rounds → differential DUAL-control probe (element + homeserver origins), verified-sentinel one-shot, every ambiguous case fails toward not healing. |
| H3 | **Confirmed** | Two full CI+CD convergences observed (stamps 19:17:00Z, 20:37:16Z; staging timer logs). One transient synapse CI failure (run 30660382696) detected via unauthenticated API and hardened: `fail-fast: false` (fbe21a7). |
| H4 | **Confirmed** | After each promotion `sha1sum` prod == dev sw.js; EW-DL1 passed against prod twice (19.9 s, 22.6 s — real browser download events); container healthy; rollback doc appended both times. |
| H5 | **Confirmed** | `element-deploy-audit.sh` pre-fix: dev 6 FAIL / prod 8 FAIL, every FAIL independently curl-verified as a real deviation; post-fix: 21 PASS / 0 FAIL on BOTH dev and prod. |
| H6 | **Confirmed** | Security headers + `server_tokens off` rode CI dev→prod; per-location include coverage 12/12 (nginx add_header inheritance gotcha); 6/6 download e2e green after headers (same-origin usercontent iframe unaffected, matching app.element.io's identical header set). |
| H7 | **Confirmed** | Dev Caddy: applied via backup + inode-safe write + validate + reload; prod via hash-gated runbook, all post-checks PASS. Client well-known (incl. the load-bearing flat `m.authentication.account`), auth_metadata, versions, federation all 200 after both applies; siwx-oidc CORS `header_down` stripping verified byte-identical by reviewer. |
| H8 | **Confirmed** | 15 accounts created 2026-07-31 (13 incident probes + 2 marathon smoke accounts) deactivated `erase:false`; positive re-query with `deactivated=true` shows 15/15 deactivated, 0 active. |

## Acceptance Criteria

| # | Met? | Evidence |
|---|------|----------|
| AC1 | Yes | Prod serves stamped sw.js; stamp changed across the two prod deploys (H1/H4). |
| AC2 | Yes | Guard E live on prod (`hsControlSettled` in served sw-boot.js); 0 false-positive reloads (H2). |
| AC3 | Yes | EW-DL1 vs prod passed twice (H4). |
| AC4 | Yes | Audit 21 PASS / 0 FAIL on dev AND prod: XFO, CSP frame-ancestors, XCTO, HSTS 31536000 both origins, full no-cache set, bounded bundles/sw.js, MSC1929 support 200 JSON, banners version-free (H5–H7). |
| AC5 | Yes | Domain separation recorded as accepted deviation (checklist §Accepted deviations + audit SKIP row); no change made. |
| AC6 | Yes | 15/15 probe accounts deactivated (H8); records updated (this doc, handover addendum, rollback doc, memory). |

## Discovered during execution (outside the original register)

1. **CI matrix fail-fast defect**: a transient synapse build failure cancelled the
   healthy element-web build, stalling the staged deploy → `fail-fast: false`
   (fbe21a7). CI status is checkable WITHOUT gh auth (repo Actions API is
   public-readable) — used for monitoring, since the gh token is dead.
2. **Runbook mv-vs-bind-mount defect (caught at review, never shipped)**: `mv`
   onto the single-file-bind-mounted prod Caddyfile would have detached the
   mount and turned validate/reload into false PASSes on a config that never
   applied. Fixed to inode-preserving truncating write pre-execution.
3. **Prod portal Caddyfile drift catalogue** vs repo copy (see checklist doc),
   incl. the provenance of the flat `m.authentication.account` well-known key
   (2026-05-25 Element X fix — must NOT be "corrected" casually).
4. **Element builds produce identical index.html for config-only changes** —
   observed live; the build-timestamp half of the stamp is load-bearing, not
   belt-and-braces.

## Left open (deliberate)

- Upstream issues to file when gh auth is restored (see handover Task 4 list):
  SW auth-chain fallback, wedged-SW watchdog absence, drag-cancellable
  downloads.
- Prod/repo Caddyfile drift reconciliation (needs its own decision + Element X
  regression test).
- Worktrees (`~/wt/ew-sw-boot` etc.) left in place — active working trees.
