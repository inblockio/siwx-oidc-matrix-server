# Element Web vendored patches — the registry

This directory is the **complete, canonical list of every modification we apply to
upstream Element Web source** before building. `dockerfiles/Dockerfile.element` is the
single build source for the element-web images (lab, dev-staging `:dev`, prod digest
promotion), and it applies exactly the patches listed here, each with
`git apply --verbose` so **a patch that stops applying fails the image build loudly** —
never silently at runtime.

Rules of this registry:

1. **No patch without an entry here.** Every entry states *what*, *why*, the *evidence*
   that made it necessary, its *upstream status*, and its *retirement condition* — the
   observable fact that lets us delete it. A patch nobody can retire is a fork forever.
2. **No behavioral patch without test coverage.** User-visible behavior gets a Playwright
   leg in the siwx-oidc repo's Element suite (`e2e/element/`); the entry names it.
3. **Upstream-first.** Patches classified UPSTREAM DEFECT are interim carriers; file the
   issue/PR against element-hq/element-web and link it here. Only POLICY patches are
   permanent residents.
4. **Tag-bump procedure** (do this for every `ELEMENT_WEB_TAG` change):
   ```bash
   git clone --depth 1 --branch <newtag> https://github.com/element-hq/element-web.git /tmp/ewcheck
   for p in $(grep -oE 'patches/element-web/[a-z-]+\.patch' dockerfiles/Dockerfile.element); do
     git -C /tmp/ewcheck apply "$PWD/$p" && echo "OK $p" || { echo "FAIL $p"; break; }
   done
   ```
   Apply IN DOCKERFILE ORDER (several patches touch `en_EN.json`; order is load-bearing).
   For each failing patch, consult its retirement condition **before** forward-porting:
   an upstream-defect patch that no longer applies often means upstream changed that
   code — check whether they fixed it, and if so DROP the patch, don't port it by reflex.
5. **Non-`.patch` deltas count too.** The runtime stage of Dockerfile.element also
   modifies the served app; those deltas are listed at the bottom of this file.

---

## Source patches (applied to the upstream tree, in Dockerfile order)

### 1. `force-first-device-recovery.patch` — POLICY (permanent)

- **What:** makes 4S recovery-key setup mandatory on the first device
  (`MatrixChat.tsx` + setup flow), and carries the raw-authed-GET 4S probes with the
  **body-read fix**: matrix-js-sdk cannot delete account data, so a "removed" default
  key is written as `{}` — a probe that only checks HTTP 200 reads that tombstone as
  "4S exists" and the recovery wizard never re-fires after a reset. The probes read the
  body and require `!!r?.key`.
- **Why we maintain it:** every later device joins via cross-signing secrets that must
  exist somewhere durable; without forced first-device recovery, accounts are created
  that can never verify a second device (the MSC4108/QR prerequisite is client-side and
  invisible to the server). The body-read fix is the root-cause fix of the
  owner-reported prod reset failure (2026-08-01).
- **Evidence:** siwx-oidc repo `docs/2026-08-01-HANDOVER-elementx-verify-open-question.md`
  §4; `docs/2026-08-02-elementx-verify-RESOLVED-identity-binding-walk.md`.
- **Upstream status:** NOT upstreamable (deployment policy). The `{}`-tombstone probe
  semantics are specific to our vendored probes.
- **Retirement:** only if upstream ships an equivalent forced-recovery deployment option.
- **Coverage:** Element suite journey walks (first-login wizard legs, reset-after-no-
  recovery walk) exercise the forced wizard on every login.

### 2. `setup-encryption-busy-wedge.patch` — UPSTREAM DEFECT (carry until fixed)

- **What:** recovers from the post-verification `Phase.Busy` dead end in
  `SetupEncryptionBody`/`SetupEncryptionStore` (verification succeeds cryptographically
  while the view sits busy with zero buttons), incl. the `usePassPhrase` 4S-unlock path.
  Log marker: `cross-signing not ready 10s after verification` (used by deploy audits).
- **Why:** the wedge is indistinguishable from "verification failed" for the user; it
  was amplifier-class in the verify-session-loop forensics.
- **Evidence:** `ew-verify-sas.spec.mjs` header (leg 8 fails on `Phase.Busy` unpatched,
  observed at 1.12.20); still applies at 1.12.24 (i.e., upstream code unchanged there).
- **Upstream status:** not yet filed — file against element-hq/element-web.
- **Retirement:** a tag bump where the patch no longer applies because upstream
  restructured/fixed the Busy handling, or an upstream fix lands. Drop, don't port.
- **Coverage:** `ew-verify-sas.spec.mjs` leg 8; H3-C completes SAS through the patched path.

### 3. `honest-qr-disabled-reason.patch` — UPSTREAM HONESTY DEFECT (carry until fixed)

- **What:** when "Show QR code" (Link new device) is blocked because *this session's own
  crypto is not ready*, upstream shows **"Not supported by your account provider"** —
  provably false here (server support verified live: rendezvous, device grant,
  metadata). Patch shows *"This session isn't verified yet, so it can't set up another
  device. Verify this session first."* plus a working **Verify session** action, and
  adds `devices` to `SessionManagerTab`'s `isCrossSigningReady` memo deps so the section
  re-probes after `refreshDevices()`.
- **Why:** the false message blames the server and hides the actual remedy; users stall
  or file server bugs for a client-side state.
- **Evidence:** siwx-oidc repo
  `docs/audits/2026-07-25-verify-with-other-device-gap-evaluation.md` §4.2.3 + §6.2(6).
- **Upstream status:** not yet filed — this misleads every MSC4108 deployment; file it.
- **Retirement:** upstream replaces the blanket "not supported" string with a
  crypto-state-aware reason.
- **Coverage:** `ew-patch-honesty.spec.mjs` PH-0/PH-1 (siwx-oidc repo).

### 4. `offer-verify-current-session.patch` — UPSTREAM DEAD END (carry until fixed)

- **What:** `DeviceVerificationStatusCard` treated the **current** session's
  `isVerified === null` as "doesn't support encryption and thus can't be verified" —
  false for any Element session — leaving destructive identity reset as the only
  visible exit. Patch: for the current device, offer **Verify session** whenever it is
  not verified; for *other* sessions keep the correct gate (an unverified session must
  not vouch for another) but say so honestly ("Verify your current session first…").
  Includes the matching upstream unit-test edit.
- **Why:** removing the only non-destructive exit funnels users into cross-signing
  identity resets — the amplifier pattern of the 2026-06-12 incident.
- **Evidence:** siwx-oidc repo `docs/audits/2026-07-25-R4-recheck-verdict.md`;
  incident analysis referenced in CLAUDE.md (device lifecycle section).
- **Upstream status:** not yet filed — patch is already PR-shaped (carries a test edit).
- **Retirement:** upstream accepts the PR or fixes the null-handling equivalently.
- **Coverage:** `ew-patch-honesty.spec.mjs` PH-0/PH-2 (siwx-oidc repo).

### 5. `auto-approve-check-code.patch` — UX POLICY (review at each bump)

- **What:** MSC4108 QR-link check-code step auto-approves once both digits are typed and
  blurs the input (no stranded caret). The deliberate read+type is the security
  property; the extra Continue click is not.
- **Why:** removes a pointless interaction from the QR device-link ceremony.
- **Evidence:** dev-staging QR walk friction, 2026-08-01.
- **Upstream status:** UX opinion; could be proposed upstream as behavior or option.
- **Retirement:** upstream streamlines the check-code step.
- **Coverage:** exercised by the QR-link browser walks (check-code leg).

### 6. `browser-eventindex.patch` — POLICY (staging only until explicit prod go-ahead)

- **What:** a `BrowserEventIndexManager` implementing Element's
  `BaseEventIndexManager` so `WebPlatform.getEventIndexingManager()` is
  non-null and `supportsEventIndexing()` is true. The stock Search UX and
  Security → Message search pane light up. Index is an in-page inverted
  index (AND of tokens, prefix on every token ≥ 2 chars, accent fold,
  mid-word substring fallback for queries ≥ 3 chars); at rest it is AES-GCM
  in a dedicated IndexedDB (`inblock-ew-eventindex`). Indexed text is
  message body + filename + caption, not media bytes. Empty results while
  the crawler is still running show `room|search|still_indexing` in the
  stock aux panel. The DEK is a non-extractable `CryptoKey` derived via
  HKDF from the session pickle key (destroyed on logout). Enabled on
  `dev.element.inblock.io` / `localhost` / `127.0.0.1`, or when
  `features.feature_inblock_encrypted_search` is `true`. Forced off when
  that flag is `false`. Production hostname stays on the stock "desktop
  only" path.
- **Why we maintain it:** every inblock room is E2EE; upstream Web has no
  EventIndex, so Search is N/A. Product client is hosted Element Web, not
  Desktop. A Seshat WASM port was evaluated and rejected (SQLCipher /
  Tantivy 0.12 / native threads / Neon).
- **Evidence:** `docs/2026-08-14-HANDOVER-encrypted-search-browser-eventindex.md`;
  audit `docs/audits/2026-08-14-encrypted-search-eventindex-audit.md`.
- **Upstream status:** NOT a Seshat port. The interface is upstream's;
  the store is ours. Do not file as "Seshat for Web".
- **Retirement:** only if upstream ships a browser EventIndex that meets
  I1–I8 (ciphertext at rest, session-bound key, logout wipe) or product
  stops requiring hosted-Web search.
- **Coverage:** Element-tree vitest in the patch
  (`BrowserEventIndexManager.test.ts`); repo
  `scripts/browser-eventindex-invariants.mjs`; staging UX1–UX8 in the
  audit. Default `enableEventIndexing` stays upstream's `true` (same as
  Desktop) — recorded in the audit.

---

## Runtime-stage deltas (not `.patch` files, still upstream deviations)

| Delta | Where | Why |
|---|---|---|
| `index.html` served no-cache | `config/element-nginx.conf` | stale-bundle TDZ crash prevention ("Your Element is misconfigured") |
| Security headers include | `config/element-nginx-security-headers.inc` | S1 hardening checklist |
| `sw-boot.js` head shim | `config/element-sw-boot.js` + build-time `sed` (fail-loud grep) | service-worker media-auth boot ordering (2026-07-31 download RCA) |
| Per-build `sw.js` stamp | Dockerfile `RUN` (bundle hash + build UTC) | byte-identical sw.js across deploys let a wedged SW survive every deploy (2026-07-31 incident); stamp forces eviction |
| inblock.io overlay | `config/element-config.json`, theme CSS, logos/favicons, welcome background | branding + deployment config (`force_verification`, `sso_redirect_options.immediate`) |
| Entrypoint templating | `entrypoints/element_entrypoint.sh` | `%%MATRIX_BASE_URL%%`/`%%MATRIX_HOST%%`/`%%CLIENT_HOST%%` substitution at container start |
| CI content marker labels | Dockerfile `LABEL io.inblock.dev-branch-ci-test*` | proves branch CI builds distinct images (S5 check) |

**History note:** the patch stack and the two "honesty" patches were validated against a
pristine `v1.12.24` tree on 2026-08-03 (full stack applies in Dockerfile order; both new
i18n keys' dependencies — `verify_session`, `unverified_session` — exist upstream at that
tag, refuting the earlier "undefined i18n key" concern recorded in the 2026-08-01
handover).
