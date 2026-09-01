# Element Web vendored patches — the registry

This directory is the **complete, canonical list of every modification we apply to
upstream Element Web source** before building. `dockerfiles/Dockerfile.element` is the
single build source for the element-web images (lab, dev-staging, prod digest
promotion; all now built from `main`), and it applies exactly the patches listed here, each with
`git apply --verbose` so **a patch that stops applying fails the image build loudly** —
never silently at runtime.

Rules of this registry:

1. **No patch without an entry here.** Every entry states *what*, *why*, the *evidence*
   that made it necessary, its *upstream status*, and its *retirement condition* — the
   observable fact that lets us delete it. A patch nobody can retire is a fork forever.
2. **No behavioral patch without test coverage.** User-visible behavior gets a Playwright
   leg in the siwx-oidc repo's Element suite (`e2e/element/`); the entry names it.
3. **Upstream-first.** Three classifications, and only one is permanent:
   - **UPSTREAM DEFECT** — interim carrier for an upstream bug. File the issue/PR and
     link it here.
   - **UPSTREAM-TRACKED** — a feature we are actively trying to get merged upstream.
     Also an interim carrier. The vendored patch and the upstream PR must be kept in
     sync; drifting them splits our deployment from what reviewers are reading.
   - **POLICY** — deployment policy that is not upstreamable. The only permanent
     residents.
   Today exactly one entry is UPSTREAM-TRACKED: #6 `browser-eventindex`
   ([element-web#34718](https://github.com/element-hq/element-web/pull/34718)).
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

## Upstream filing policy (ruling, 2026-09-01)

Three patches (2, 3, 4) are marked "not yet filed upstream". **Do not file them
yet.** Filing is gated on the outcome of entry 6.

**The reasoning:** upstream engagement has an unknown price here. Rather than
pay it three more times on faith, entry 6 (`browser-eventindex`,
element-hq/element-web PR **#34718**) is the pilot. Its outcome decides whether
filing is worth repeating.

- **If #34718 succeeds** -> file 2, 3 and 4. Entry 4 goes first: it is already
  PR-shaped and carries the upstream unit-test edit, so it is the cheapest.
- **If #34718 fails** -> do NOT file the others. Carry them as vendored patches
  and stop treating "not yet filed" as a TODO.

**The gate must be evaluable, so define the outcomes rather than eyeballing it:**

| Outcome | Meaning |
|---|---|
| SUCCESS | Merged, **or** a maintainer explicitly commits to merging it after changes. |
| FAILURE | Closed unmerged, explicitly rejected, **or** no maintainer engagement for 3 months. |
| AMBIGUOUS | Maintainers want a substantially different implementation. Engagement works but costs more than one PR's worth; re-decide, do not auto-file. |

**Evaluate at the next Element tag bump, or 2026-12-01, whichever comes first.**
Without a date this becomes an indefinite wait and the three patches stay in
limbo by default.

**Baseline as of 2026-09-01** (so drift is measurable, not remembered):

- #34718 open, not draft, not merged. Opened 2026-08-15, last activity
  2026-08-31.
- CI **green** (4 passed, 2 skipped, 0 failed). `mergeable_state: unstable`
  reflects a pending required check, NOT a broken build. Nothing here is
  blocked on us.
- 9 conversation comments, **0 review comments**. Discussion is at the
  should-we/how-should-we level, not line-by-line review.
- Labels `T-Enhancement`, `Z-Community-PR`. Framed as a feature rather than a
  defect, and flagged as an outside contribution, both of which historically
  move slower than maintainer-authored fixes.

## Entry 5: keep (ruling, 2026-09-01)

`auto-approve-check-code` was challenged on cost/benefit: it is the only patch
here that fixes no defect, it modifies an MSC4108 device-linking security
ceremony, and it carries a standing re-review obligation at every Element bump,
all to remove one click. **Ruled: keep it.** The deliberate read-and-type of the
check code is the security property; the extra Continue click is not, and the
ceremony friction it removes is worth the maintenance. Recorded so this is not
re-litigated each time someone audits the registry.

## What runs on prod today

**All six patches are built into the production image and all six are active on
`element.inblock.io`.** Verified 2026-09-01 against the deployed artifact
(`element-web@sha256:d7ba8b7b`, label `org.opencontainers.image.revision=60b037b`)
and the config prod actually serves.

| # | Patch | Purpose | Active on prod |
|---|---|---|---|
| 1 | `force-first-device-recovery` | Makes 4S recovery-key setup **mandatory on the first device**, so every later device has cross-signing secrets to join against. Deployment policy, permanent. | yes, ungated |
| 2 | `setup-encryption-busy-wedge` | Recovers from an upstream post-verification `Phase.Busy` dead end that is indistinguishable from "verification failed" to the user. | yes, ungated |
| 3 | `honest-qr-disabled-reason` | When "Show QR code" is blocked by **this session's own** crypto state, stop reporting it as the account provider not supporting device link. The stock string is simply false for us and hides the actual remedy. | yes, ungated |
| 4 | `offer-verify-current-session` | `DeviceVerificationStatusCard` gave an unverified **current** session a card with no action and no reason, leaving the destructive identity reset as the only visible exit. | yes, ungated |
| 5 | `auto-approve-check-code` | MSC4108 QR device-link check-code auto-approves once both digits are typed. The deliberate read-and-type is the security property; the extra confirm click is not. | yes, ungated |
| 6 | `browser-eventindex` | A `BrowserEventIndexManager` implementing `BaseEventIndexManager` so E2EE room search works in hosted Element Web. Upstream PR #34718. | **yes, via explicit flag** |

Entry 6 is the only gated one, and the gate is easy to read backwards:

```
flag === false  -> off
flag === true   -> ON, and this OVERRIDES the hostname check
flag unset      -> on only for STAGING_HOSTS (dev.element.inblock.io, localhost, 127.0.0.1)
```

Prod serves `features.feature_inblock_encrypted_search: true`, so encrypted
search is **on in production by explicit opt-in**. dev-staging leaves the flag
unset and gets it from the `STAGING_HOSTS` fallback. Both are on, by different
mechanisms. Any comment claiming this patch is "dev-staging only" or "gated off
on the production hostname" describes only the unset-flag fallback and is wrong
about prod as configured.

To turn it off in production, set the flag to `false` in prod's bind-mounted
`config/element-config.json`. Removing the key is NOT equivalent: it falls
through to the hostname check, which also yields off, but only by accident of
prod's hostname not being in `STAGING_HOSTS`.

## Which Dockerfile applies what

**One Dockerfile, all six patches.** `dockerfiles/Dockerfile.element` on `main`
applies every numbered patch below, in this file's order.

This section used to describe a split: the `dev` Dockerfile applied all six
while the `main` one applied 1, 5 and 6 only, with entries 2–4 described as
"policy we maintain; they ship on staging until promoted". Both halves of that
are now wrong. `dev` was merged into `main` on 2026-09-01 and deleted, so there
is a single Dockerfile. And the "not yet on prod" half was **already** false
before that merge: prod's element image was built from `dev` (revision
`60b037b`), so production has been running all six patches, entries 2–4
included, since it adopted that build.

A tag bump must try every patch in this file's order.

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
- **Upstream status:** the forced-setup half is NOT upstreamable (deployment policy).
  The `{}`-tombstone half IS an upstream defect and is already reported.
- **Tracking:** [element-hq/element-web#29133](https://github.com/element-hq/element-web/issues/29133)
  "Element offers to verify with Security Key when security key has been deleted",
  **open**, `T-Defect S-Minor A-E2EE-Cross-Signing`, filed by **richvdh (Element's
  crypto lead)** 2025-01-29, no activity since. Its repro sets
  `m.secret_storage.default_key` to `{}`: the exact tombstone our probes handle.
  Do not file a duplicate.
- **No upstream fix is coming for the root cause.** MSC3391 ("API to delete account
  data", matrix-spec-proposals#3391) was **closed after FCP with no maintainer
  interest**, and matrix-js-sdk `setDefaultKeyId` documents the `{}`-as-delete
  convention as deliberate. So the tombstone half of this patch is effectively
  permanent, not "carry until fixed". Verified 2026-09-01.
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
  observed at 1.12.20); still applies cleanly at 1.12.24 **and at 1.12.26** (2026-08-30
  bump) — i.e. upstream has NOT restructured or fixed the Busy handling, so the
  retirement condition below is NOT met and the patch is carried forward unchanged.
- **Upstream status:** related upstream report exists; ours is not separately filed.
- **Tracking:** [element-hq/element-web#29553](https://github.com/element-hq/element-web/issues/29553)
  "In verification dialog, 'Verify with Recovery Key or Phrase' does nothing if 4S
  secrets are encrypted with the wrong 4S key", **open**, **`S-Major`**, filed by
  **richvdh**, last updated 2025-08-22, still unfixed after a year. Same symptom class
  (recovery-key verification silently dead-ends) but a **different trigger**: theirs is
  a 4S key mismatch, ours is `Phase.Busy` after a verification that already SUCCEEDED.
  Treat as related, not identical. #30551 was closed as a duplicate of it.
  Verified 2026-09-01.
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
- **Upstream status:** not filed, and **searched 2026-09-01: no upstream match exists**,
  so filing fresh carries no duplicate risk. Searched the literal
  "Not supported by your account provider" string, `SessionManagerTab`,
  `isCrossSigningReady`, and MSC4108 QR disabled-reason. Nearest adjacent item is
  [#28371](https://github.com/element-hq/element-web/issues/28371), **closed as
  not-planned**, which is about the *login* flow rather than the Link-new-device
  section, so it is not our bug. Filing is gated: see "Upstream filing policy" above.
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
- **Upstream status:** not filed, and **searched 2026-09-01: no upstream match exists**.
  Patch is already PR-shaped (carries the upstream unit-test edit), so it is the
  cheapest of the three to file. Nearest adjacent item is
  [#30755](https://github.com/element-hq/element-web/issues/30755) "Don't offer to
  verify other devices if we don't have all the secrets", **open**, which is the
  *inverse* concern (other devices, not the current one) and does not cover ours.
  Filing is gated: see "Upstream filing policy" above.
- **Follow-up before the next bump:** [#29258](https://github.com/element-hq/element-web/issues/29258)
  closed via **merged PR #30596** (2025-09-12), a redesign of the verify-device modal
  that landed in the same UI area this patch touches. It reportedly does not alter the
  `isVerified === null` branch, but that could NOT be confirmed from source (GitHub code
  search requires login). **Manually diff `DeviceVerificationStatusCard.tsx` against this
  patch at the next Element bump.** This is the one patch whose clean application is
  strong evidence of continued necessity, because it edits an upstream unit test, so a
  silent shift here matters more than elsewhere.
- **Retirement:** upstream accepts the PR or fixes the null-handling equivalently.
- **Coverage:** `ew-patch-honesty.spec.mjs` PH-0/PH-2 (siwx-oidc repo).

### 5. `auto-approve-check-code.patch` — UX POLICY (review at each bump)

- **What:** MSC4108 QR-link check-code step auto-approves once both digits are typed and
  blurs the input (no stranded caret). The deliberate read+type is the security
  property; the extra Continue click is not.
- **Why:** removes a pointless interaction from the QR device-link ceremony.
- **Evidence:** dev-staging QR walk friction, 2026-08-01.
- **Upstream status:** UX opinion; could be proposed upstream as behavior or option.
  **Searched 2026-09-01: no upstream issue or PR exists** for MSC4108 check-code
  auto-approval, in element-web, element-desktop, the archived matrix-react-sdk, or
  matrix-authentication-service. Filing fresh is safe. See also the keep ruling above.
- **Retirement:** upstream streamlines the check-code step.
- **Coverage:** exercised by the QR-link browser walks (check-code leg).

### 6. `browser-eventindex.patch` — UPSTREAM-TRACKED (PR #34718 open; carry until merged)

- **Applied by:** `dockerfiles/Dockerfile.element` (the only one).
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
  HKDF from the session pickle key (destroyed on logout). On by hostname
  for `dev.element.inblock.io` / `localhost` / `127.0.0.1`. On prod via
  bind-mounted `features.feature_inblock_encrypted_search: true` (set
  `false` to force off without a rebuild).
- **Why we maintain it:** every inblock room is E2EE; upstream Web has no
  EventIndex, so Search is N/A. Product client is hosted Element Web, not
  Desktop. A Seshat WASM port was evaluated and rejected (SQLCipher /
  Tantivy 0.12 / native threads / Neon).
- **Evidence:** `docs/2026-08-14-HANDOVER-encrypted-search-browser-eventindex.md`;
  audit `docs/audits/2026-08-14-encrypted-search-eventindex-audit.md`
  (staging UX1–UX8 + prod promotion 2026-08-15).
- **1.12.26 forward-port (2026-08-30):** the only patch of the six that did not
  apply at v1.12.26, and purely from context drift — NOT because upstream shipped
  an EventIndex (rule 4 checked: upstream still has no browser EventIndex, so the
  retirement condition is unmet). Upstream reformatted `<SearchWarning>` in
  `RoomSearchAuxPanel.tsx` onto multiple lines with new `scope`/`roomId` props, and
  added an `oxlint-disable-next-line` comment above `WebPlatform.VERSION`.
  Regenerated against a v1.12.26 tree with patches 1–5 already applied (so the
  `en_EN.json` context stays correct for last-in-order application). The
  regenerated patch has byte-identical added/removed lines and an identical
  numstat (6 / 2-1 / 383 / 938 / 9) to the previous version — a pure context
  refresh with zero behavior change.
- **Upstream status: FILED AND ACTIVELY TRACKED — we are trying to get this
  merged.** [element-hq/element-web#34718](https://github.com/element-hq/element-web/pull/34718)
  "Add a browser EventIndex so encrypted-room search works on the web"
  (`inblockio:feat/web-event-index` → `element-hq:develop`, author
  FantasticoFox, opened 2026-08-15, 10 files, +1734/-1). Fixes
  [element-meta#3294](https://github.com/element-hq/element-meta/issues/3294).
  Labelled `T-Enhancement` + `Z-Community-PR`.

  This is the **one patch in this registry with a live upstream merge path**, so
  unlike the other POLICY entries it is an interim carrier, not a permanent
  resident. Keep the vendored patch and the PR in sync: a change to one that is
  not mirrored in the other splits our deployment from what upstream is
  reviewing.

  Still NOT a Seshat port — the interface is upstream's, the store is ours. Do
  not describe it as "Seshat for Web" (the PR body says so explicitly, because
  the native-Seshat comparison is what makes reviewers assume WASM/SQLCipher).

  **Status as of 2026-08-31:** mergeable, CI green (6/6 check-runs + CLA), but
  **zero reviews submitted**. GitHub reports `mergeable_state: unstable`, which
  for a community PR usually means workflows awaiting maintainer approval to
  run. Last activity: Tim rebased and force-pushed CI fixes 2026-08-30 21:18Z.

  **Open reviewer-side question worth chasing:** on 2026-08-28 the maintainer
  (t3chguy) reported "I don't see any messages whatsoever" with a screenshot
  while testing, and Tim replied suspecting a federation delivery problem on his
  side. That is the SAME symptom class as the MSC4284 policy-server refusal
  tracked in memory `policyserv-blocks-did-mxids` (our sends to policy-server
  rooms are refused with a bare 400). If a reviewer cannot see test messages,
  they cannot evaluate a *search* feature — so unblocking the federation issue
  may be on the critical path to this merge. Unproven link; check it before
  assuming.
- **Retirement:** when #34718 (or an upstream equivalent) merges and ships in a
  tag we deploy, PROVIDED it still meets I1–I8 (ciphertext at rest,
  session-bound key, logout wipe) — verify those against the merged form, since
  review may change the store. Also retires if product stops requiring
  hosted-Web search.
- **Coverage:** Element-tree vitest in the patch
  (`BrowserEventIndexManager.test.ts`); repo
  `scripts/browser-eventindex-invariants.mjs`;
  `~/siwx-oidc/e2e/element/ew-encrypted-search.spec.mjs`. Default
  `enableEventIndexing` stays upstream's `true` (same as Desktop).

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

**v1.12.24 -> v1.12.26 bump (2026-08-30), per-patch outcome** (rule 4 procedure run
against a pristine tree, in Dockerfile order):

| # | Patch | Outcome at v1.12.26 |
|---|---|---|
| 1 | `force-first-device-recovery` | applies clean, carried |
| 2 | `setup-encryption-busy-wedge` | applies clean → upstream still unfixed, **carried** (not retired) |
| 3 | `honest-qr-disabled-reason` | applies clean, carried |
| 4 | `offer-verify-current-session` | applies clean, carried |
| 5 | `auto-approve-check-code` | applies clean, carried |
| 6 | `browser-eventindex` | **forward-ported** (context-only; see entry 6) |

Verified afterwards in BOTH apply orders against a pristine v1.12.26 tree: the
all-six order and the then-`main` subset (1, 5, 6). Only the all-six order still
exists; the subset is kept here as the record of what was checked.

**Verified in the DEPLOYED artifact, not just against a tree (2026-08-31).** "Applies
clean" only proves a patch can be applied; it does not prove the code reached the
served app. After the `5089872` converge, every patch was confirmed by grepping its own
distinctive string in the running `matrix-staging-element-web-1` webroot:

| # | Patch | Marker grepped in `/app` | Files |
|---|---|---|---|
| 1 | `force-first-device-recovery` | `Set up recovery to continue` | 1 |
| 2 | `setup-encryption-busy-wedge` | `cross-signing not ready` | 2 |
| 3 | `honest-qr-disabled-reason` | `Not supported by your account provider` | 2 |
| 4 | `offer-verify-current-session` | `verify_blocked_current_session_unverified` | 3 |
| 5 | `auto-approve-check-code` | `open_approval_page` | 5 |
| 6 | `browser-eventindex` | `inblock-ew-eventindex` | 2 |

**Trap for whoever repeats this:** the EventIndex code is emitted into
`bundles/<hash>/init.js`, **not** `bundle.js`. Grepping only `bundle.js` returns zero
hits for every EventIndex marker and looks exactly like "the patch is missing". Search
the whole webroot.
