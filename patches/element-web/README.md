# Element Web vendored patches — the registry

This directory is the **complete, canonical list of every modification we apply to
upstream Element Web source** before building. `dockerfiles/Dockerfile.element` is the
single build source for the element-web image that CI publishes from `main`, and it
applies exactly the patches listed here, each with `git apply --verbose` so **a patch
that stops applying fails the image build loudly** — never silently at runtime.

**License.** The patches in this directory are not Apache-2.0 like the rest of the
repository. Each change is licensed like the Element Web file it changes, which for the
code the image ships means AGPL-3.0-only OR GPL-3.0-only. A docs file, an Apache-2.0 test
and two tests that adapt an AGPL-only harness differ; [`NOTICE`](../../NOTICE) lists them.

Rules of this registry:

1. **No patch without an entry here.** Every entry states *what*, *why*, the *evidence*
   that made it necessary, its *upstream status*, and its *retirement condition* — the
   observable fact that lets us delete it. A patch nobody can retire is a fork forever.
2. **No behavioral patch without test coverage.** User-visible behavior gets a Playwright
   leg in the siwx-oidc repo's Element suite (`e2e/element/`); the entry names it.
   **Unit tests a patch carries run in CI.** Every test file a patch adds or modifies
   (`*.test.ts(x)`, `*-test.ts(x)`, `*.spec.*`, except Playwright specs under `playwright/`)
   runs on the patched tag tree in the `Element patch unit tests` job of
   `.github/workflows/checks.yml`, which builds `dockerfiles/Dockerfile.element --target
   patch-tests`, i.e. runs `scripts/element-patch-tests.sh`. The files are derived from the
   patches' `+++ b/` paths, never listed by hand, and each goes to the runner that owns it
   at the tag (vitest or jest); a test file no runner would execute fails the job. A patch
   that adds a vitest config (entry 11's `vitest.browser.copy-md.config.ts`) has that config
   run too, in headless Chromium. The only exception is
   [`patch-tests-known-red.txt`](patch-tests-known-red.txt): a test that is red on the
   unpatched tag as well, with reason and evidence. A test red only with our patches is a
   defect, not an exception. The script has one fixup, documented in its header: jest at
   v1.12.29 cannot load suites that import `matrix-js-sdk` until `content-type` joins its
   `transformIgnorePatterns` allowlist, so the script adds it on the command line.
3. **Upstream-first.** Three classifications, and only one is permanent:
   - **UPSTREAM DEFECT** — interim carrier for an upstream bug. File the issue/PR and
     link it here.
   - **UPSTREAM-TRACKED** — a feature we are actively trying to get merged upstream.
     Also an interim carrier. The vendored patch and the upstream PR must be kept in
     sync; drifting them splits our deployment from what reviewers are reading.
     **One sanctioned exception exists today** (a maintainer decision, 2026-09-13): entry 6's vendored
     patch deliberately LEADS PR #34718 by the non-blocking-load work, because prod
     needed that before upstream was ready to receive it. A deliberate lead is only
     allowed when it is (a) recorded in the entry, (b) pinned to a named provenance
     commit on a branch of our fork, and (c) carries a stated condition for closing
     the gap. Unrecorded drift is still forbidden — that is the whole point of the
     rule. A second, test-only exception is approved for entry 9 (a maintainer
     decision, 2026-10-05). It takes effect only when #35242 picks up #34955; see that
     entry.
   - **POLICY** — deployment policy that is not upstreamable. The only permanent
     residents.
   Today exactly one entry is UPSTREAM-TRACKED: #6 `browser-eventindex`
   ([element-web#34718](https://github.com/element-hq/element-web/pull/34718)).
   Entry 9 stays an UPSTREAM DEFECT, but its fix is filed as
   [element-web#35242](https://github.com/element-hq/element-web/pull/35242) (see the
   policy exception below) and its vendored patch is byte-for-byte the prepared PR diff,
   so the same no-drift discipline applies to it.
   Pushing to an upstream PR that a registry entry mirrors is not finished until the
   vendored patch is re-copied (and the entry's provenance updated) in the same change:
   on 2026-09-29 the SonarCloud follow-up to #35242 (`246724f407`) drifted entry 9 by
   24 lines because this step was missing.
4. **Tag-bump procedure** (do this for every `ELEMENT_WEB_TAG` change). Change
   `ARG ELEMENT_WEB_TAG` and `ARG ELEMENT_WEB_COMMIT` in `dockerfiles/Dockerfile.element`
   **together**: the build fails when the tag does not resolve to that commit, which is what
   stops a tag moved upstream from changing what we ship. Look the commit up with
   `git ls-remote https://github.com/element-hq/element-web 'refs/tags/<newtag>^{}'`.
   Then try every patch against a fresh clone of the new tag:
   ```bash
   ewcheck="$(mktemp -d)"
   git clone --depth 1 --branch <newtag> https://github.com/element-hq/element-web.git "$ewcheck"
   for p in $(grep -oE 'patches/element-web/[a-z0-9-]+\.patch' dockerfiles/Dockerfile.element); do
     git -C "$ewcheck" apply "$PWD/$p" && echo "OK $p" || { echo "FAIL $p"; break; }
   done
   ```
   Apply IN DOCKERFILE ORDER (several patches touch `en_EN.json`; order is load-bearing).
   The character class must admit digits: until 2026-09-29 it read `[a-z-]+`, which
   silently skipped entry 10 (`sw-media-401-token-retry.patch`), so the loop reported
   nine OKs and never tried the tenth. Check that it prints one line per numbered entry.
   For each failing patch, consult its retirement condition **before** forward-porting:
   an upstream-defect patch that no longer applies often means upstream changed that
   code — check whether they fixed it, and if so DROP the patch, don't port it by reflex.

   **4b. Upstream refresh (every tag bump, from the repo root).** First, refresh the
   upstream status of every upstream link in both registries and update each entry's
   upstream-status line with what it prints:
   ```bash
   grep -ohE 'github\.com/element-hq/[a-z-]+/(pull|issues)/[0-9]+' patches/*/README.md | sort -u \
     | sed -E 's#github\.com/([^/]+/[^/]+)/(pull|issues)/#\1 #' | while read r n; do
       gh api "repos/$r/issues/$n" --jq "\"$r#$n \(.state) merged=\(.pull_request.merged_at) last=\(.updated_at[0:10])\""; done
   ```
   Second, compare every entry under the no-drift discipline (rule 3) against its PR's
   current diff. The added/removed lines must be identical (the `index` lines may
   differ, and once in effect entry 9's approved test-only deviation is the expected
   output; see entry 9); no output before the echo means no drift:
   ```bash
   pm() { grep -E '^[+-]' | grep -vE '^(\+\+\+|---) '; }
   diff <(gh api repos/element-hq/element-web/pulls/35242 -H 'Accept: application/vnd.github.diff' | pm) \
        <(pm < patches/element-web/sw-versions-no-cache-on-error.patch) && echo "entry 9: no drift"
   ```
   Entry 6 is expected to differ from #34718 by its recorded lead only; check the
   difference against its named provenance commit instead. Third, evaluate the
   #34718 gate of the upstream filing policy below (SUCCESS / FAILURE / AMBIGUOUS) and
   record the outcome and date there, as that policy requires.
5. **Non-`.patch` deltas count too.** The runtime stage of Dockerfile.element also
   modifies the served app; those deltas are listed at the bottom of this file.
6. **The repo README mirrors this list.** Its "Upstream deviations (patches)" section
   carries one line per entry, and its "Dependencies" table carries `ELEMENT_WEB_TAG` and
   `ELEMENT_WEB_COMMIT`.
   Adding, dropping or renumbering a patch, or bumping the tag, updates the README in
   the same commit.

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

**Exception (a maintainer decision, 2026-09-28): entry 9 is filed now** (issue #35241, PR #35242). This policy gates only entries
2, 3 and 4 on #34718; entry 9 (`sw-versions-no-cache-on-error`) is a defect that breaks
all media for users on servers that enforce authenticated media, and filing it was
ordered explicitly. Entry 10 is not covered by this exception (see its entry).

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

## Summary

| # | Patch | Purpose | Gate |
|---|---|---|---|
| 1 | `force-first-device-recovery` | Makes 4S recovery-key setup **mandatory on the first device**, so every later device has cross-signing secrets to join against. Deployment policy, permanent. | none |
| 2 | `setup-encryption-busy-wedge` | Recovers from an upstream post-verification `Phase.Busy` dead end that is indistinguishable from "verification failed" to the user. | none |
| 3 | `honest-qr-disabled-reason` | When "Show QR code" is blocked by **this session's own** crypto state, stop reporting it as the account provider not supporting device link. The stock string is simply false for us and hides the actual remedy. | none |
| 4 | `offer-verify-current-session` | `DeviceVerificationStatusCard` gave an unverified **current** session a card with no action and no reason, leaving the destructive identity reset as the only visible exit. | none |
| 5 | `auto-approve-check-code` | MSC4108 QR device-link check-code auto-approves once both digits are typed. The deliberate read-and-type is the security property; the extra confirm click is not. | none |
| 6 | `browser-eventindex` | A `BrowserEventIndexManager` implementing `BaseEventIndexManager` so E2EE room search works in hosted Element Web, with a **non-blocking** load so a large index cannot delay app start, bounded crawl/memory/disk budgets, a chunked encrypted store, and a streamed cold scan for what is on disk outside the resident window. Upstream PR #34718 plus increments A, B, C, D-core and E, which lead it. | labs flag `feature_web_event_index` (off unless set; this repository's config sets it) |
| 7 | `show-attested-did` | Shows the provider-attested DID (`io.inblock.did`) under the MXID in the member panel and in All settings -> Account. | none |
| 8 | `resolve-did-search` | A DID typed into Spotlight or the invite/DM dialog resolves to the user's MXID. Depends on 7. | none |
| 9 | `sw-versions-no-cache-on-error` | The service worker never caches a failed `/versions` check, retries it anonymously, and shares one check per server. | none |
| 10 | `sw-media-401-token-retry` | A media request that 401s with the stored token waits (5 s bound) for the app's refresh and retries once. | none |
| 11 | `copy-markdown` | Right-click "Copy Markdown" directly above Pin: copies a text, notice or emote message as clean CommonMark + GFM, converted from `formatted_body` (no HTML emitted), instead of the lossy rendered-text copy or the JSON of View source. | none |

Entry 6 is the only gated one:

```
feature_web_event_index === true   -> ON (config.json `features`, or per-device in Labs)
feature_web_event_index === false  -> off
feature_web_event_index unset      -> OFF. There is no hostname fallback any more.
```

`config/element-config.json` in this repository sets the key to `true`. The older key
`feature_inblock_encrypted_search` is dead: nothing reads it. Until 2026-09-13 the patch
also turned the feature on by hostname (`STAGING_HOSTS`); that fallback is gone, so a
note calling the feature "staging only" or "gated off by hostname" describes a gate that
no longer exists.

Which build a given deployment runs, and so which of these entries it carries, is
recorded by that deployment, not here.

## Which Dockerfile applies what

**One Dockerfile, all eleven patches.** `dockerfiles/Dockerfile.element` applies every
numbered patch below, in this file's order. **8 depends on 7** and **10 depends on 9**;
each must stay after the entry it depends on (see their Order notes). **11 is applied
last**: its `en_EN.json` hunk was generated against the tree with 1-10 applied. Until 2026-09-01 a
separate `dev` branch applied a different subset; that branch was merged into `main` and
deleted, so there is a single Dockerfile.

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
- **Evidence:** two siwx-oidc maintainer write-ups of 2026-08-01 and 2026-08-02 (the
  Element X verification open question, §4, and its resolution walk), no longer in that
  repository's published tree.
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
- **Evidence:** siwx-oidc repo `docs/audits/2026-07-25-R4-recheck-verdict.md`; the
  2026-06-12 login incident is summarised in siwx-oidc's `docs/matrix-integration.md`
  ("Session teardown").
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
- **Forward-ported to v1.12.29 (2026-09-25).** `DeviceVerificationStatusCard.tsx` is
  byte-identical at v1.12.26 and v1.12.29 (the follow-up diff above is therefore done:
  no upstream change to the `isVerified === null` branch). The only port is the test:
  upstream moved `test/unit-tests/.../DeviceVerificationStatusCard-test.tsx` to vitest at
  `src/components/views/settings/devices/DeviceVerificationStatusCard.test.tsx` (#34848),
  and the hunk now targets that file. Added/removed lines are identical to the v1.12.26
  patch.
- **Known red upstream tests, PRE-EXISTING (not caused by the port):** this patch renders
  `{blockedByCurrentSession && ...}` beside the button, so `DeviceSecurityCard` receives
  a children array and renders an **empty** `mx_DeviceSecurityCard_actions` div where it
  used to render none. Four upstream snapshots fail on that (2 in
  `DeviceVerificationStatusCard.test.tsx`, 2 in `SessionManagerTab.test.tsx`). Reproduced
  identically on v1.12.26 with the live patch set (jest, 2026-09-25), so prod has shipped
  the empty div since this patch landed. Cosmetic; fix or re-snapshot when this is filed
  upstream. Patches 1 and 5 carry the same kind of pre-existing red: `MatrixChat.test.tsx`
  "unskippable verification" x2 (forced 4S recovery replaces the Complete Security screen)
  and `LoginWithQR.test.tsx` "reciprocate" x2 (check-code auto-approve changes the props).
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

- **Applied by:** `dockerfiles/Dockerfile.element` (the only one), SIXTH.
- **What:** a `BrowserEventIndexManager` implementing Element's
  `BaseEventIndexManager` so `WebPlatform.getEventIndexingManager()` is
  non-null and `supportsEventIndexing()` is true. The stock Search UX and
  Security → Message search pane light up. The query engine is an in-page
  inverted index (AND of tokens, prefix on every token ≥ 2 chars, accent
  fold, mid-word substring fallback for queries ≥ 3 chars); indexed text is
  message body + filename + caption, never media bytes. At rest it is
  AES-GCM records in a dedicated IndexedDB, **`element-eventindex`**, schema
  **v2**. The DEK is a non-extractable `CryptoKey` derived with HKDF-SHA256
  from the session pickle key and bound to user + device (destroyed on
  logout); every record is AAD-bound to its own primary key, so a record
  cannot be re-filed under another user or event id and still decrypt; and
  **checkpoint records are named by an HMAC** under a separate HKDF subkey,
  so no room id, token or crawl direction is on disk in the clear. The
  v1 → v2 migration **resets** the index rather than converting it — v1
  named checkpoints by a cleartext tuple and the HMAC key cannot be computed
  for records written before it existed. ~1,000 lines of documentation ride
  along, including a threat model in the manager's header that says exactly
  what is still cleartext (event ids, hence *which rooms are indexed*), what
  the checkpoint HMAC does and does not buy (equality and count still leak),
  and that none of it defends against XSS in this origin.
- **The gate is now an upstream-shaped labs flag, `feature_web_event_index`,
  default OFF.** This REPLACES the old `feature_inblock_encrypted_search`
  key and the `STAGING_HOSTS` hostname fallback; neither name exists in the
  patch any more. Its levels are `CONFIG, DEVICE` (config prioritised), so
  `features.feature_web_event_index: true` in `config.json` turns it on for
  a whole deployment and a user can turn it on for one device under Labs.
  The gate is enforced **inside the manager**, on every path that writes,
  because `EventIndexPeg` reads `supportsEventIndexing()` once and caches
  it: a manager handed back after the flag went off would otherwise keep
  indexing and keep a database alive. `WebPlatform` deliberately keeps
  returning an already-constructed manager whatever the setting now says,
  because `Lifecycle.clearStorage()` wipes localStorage *before* it asks the
  manager to delete the index; and on a session where the flag is off and no
  manager was ever constructed it deletes a database left behind by a
  previous one, at most once. A manager is only ever *constructed* while the
  flag is on, so an untouched Element Web never opens the database at all.
- **It no longer patches `RoomSearchAuxPanel.tsx`.** Earlier versions
  rendered their own "still indexing" banner there and shipped a
  `room|search|still_indexing` string. Upstream now renders an equivalent
  warning from `SearchWarning.tsx` via `useIsIndexIncomplete`, and that
  function **is present at v1.12.26**
  (`apps/web/src/components/views/elements/SearchWarning.tsx:67`; it renders
  `seshat|warning_kind_search_partial` for `WarningKind.Search` as a polite
  live region) — re-verified against a pristine tag tree on 2026-09-12, and
  `RoomSearchAuxPanel.tsx` at the tag is byte-identical to the PR branch's
  copy. So the deletion is correct against what we build, not only against
  `develop`; without that check the deployed build would have lost the
  warning entirely. **Consequence for the artifact-grep table at the bottom
  of this file:** the marker is now `element-eventindex`, the old
  `inblock-ew-eventindex` and `still_indexing` markers will find nothing,
  and the code is still emitted into `bundles/<hash>/init.js`, not
  `bundle.js`.
- **Why we maintain it:** every inblock room is E2EE; upstream Web has no
  EventIndex, so Search is N/A. Product client is hosted Element Web, not
  Desktop. A Seshat WASM port was evaluated and rejected (SQLCipher /
  Tantivy 0.12 / native threads / Neon).
- **Evidence:** audit `docs/audits/2026-08-14-encrypted-search-eventindex-audit.md`
  (threat model, invariants, and the UX1–UX8 run on staging). It predates the labs-flag
  and schema-v2 rework and describes the hostname gate and the
  `inblock-ew-eventindex` database; read it as the record of why the feature exists,
  not of how it is gated today.
- **Regenerated against the PR, 2026-09-12.** The PR had moved substantially
  (labs gate, schema v2, checkpoint HMAC, teardown hardening, rewritten
  tests, docs) while the vendored copy still carried the 2026-08 form, which
  is exactly the drift rule 3 forbids. Rebuilt from the PR's true current
  state — the feature commit plus its uncommitted working tree, diffed
  against the `develop` commit the branch last merged, which is the
  merge-base with upstream `develop` — then re-expressed against a v1.12.26
  tree with patches 1–5 already applied, so the `en_EN.json` context stays
  correct for sixth-in-order application. The added/removed lines are
  **byte-identical** to the PR's own net diff; only context and hunk offsets
  differ. Ten files at that point (up from five), `+4167/-1`, patch 4290 lines
  (was 1412; the 2026-09-12 export was `+4142/-1` / 4265 lines, before the
  2026-09-13 resync below). The one real base difference is `apps/web/src/settings/Settings.tsx`:
  `develop` has dropped `feature_custom_themes` and `LabGroup.Themes`, which
  v1.12.26 still has, three lines from our insertion point. Resolved by a
  3-way apply against the PR's own pre-image blob, not by hand-editing hunk
  headers; `en_EN.json` and `docs/labs.md` differ only by offset, and
  `WebPlatform.ts`, `WebPlatform.test.ts`, `playwright/global.d.ts` and
  `AUTHORS.rst` are identical at the tag and on `develop`.
- **Re-synced to the pushed PR head `db54789c08`, 2026-09-13.** The 2026-09-12
  export was taken from the PR checkout's *uncommitted working tree*; that work
  was then committed and pushed as `2aeafdd443` + `db54789c08` on
  `inblockio:feat/web-event-index`, and one file moved in between. Re-derived
  from the pushed head (`git diff d06fc35ab2^2 db54789c08`, i.e. against the
  `develop` commit the branch last merged) onto a pristine v1.12.26 tree with
  patches 1-5 applied, exported with `git diff HEAD`. **Nine of the ten files
  are byte-identical to the previous export**; the only change is
  `apps/web/playwright/e2e/crypto/web-event-index.spec.ts`, 146 -> 171 added
  lines. That file is a Playwright spec and is **not** part of the built
  webapp, so the shipped artifact is unchanged by this resync; it is done
  because rule 3 requires the vendored patch and the PR to stay in sync, not
  because the deployment behaviour moved. The spec's substantive change: the
  reload test now signs in through the UI (`logIntoElement`) instead of taking
  the `user` fixture, because that fixture writes `mx_has_pickle_key: "false"`
  and an index in a session with no pickle key is memory-only by design, so the
  old form asserted persistence against a deliberately-disabled path; plus
  `test.slow()` for the 30s `searchUntilFound` poll. Verified: all eight
  patches still apply in Dockerfile order to a pristine v1.12.26 tree, and
  `node --test scripts/browser-eventindex-invariants.mjs` is 12/12.
- **NOW CARRIES THE NON-BLOCKING LOAD, AHEAD OF UPSTREAM (a maintainer decision,
  2026-09-13).** The vendored patch is no longer a mirror of the PR head. It is
  regenerated from an integration branch on our fork that merges the PR head with
  the non-blocking-load work, because prod could not ship with encrypted search
  off and the blocking load was not acceptable on prod hardware. This is the
  sanctioned exception named in rule 3 above; read that rule before "fixing" the
  divergence.

  - **Provenance commit: `27e660e434`** on
    [`inblockio/element-web`](https://github.com/inblockio/element-web/tree/integration/web-event-index-prod-20260913),
    branch **`integration/web-event-index-prod-20260913`** — a merge of
    `feat/web-event-index` @ `500f348525` (the PR head plus its docs commit) and
    `feat/web-event-index-nonblocking-load` @ `27e9537a8c`. The merge was clean
    (docs vs src, no overlapping hunks). **That branch is NOT merged into
    `feat/web-event-index`**: the PR's own line stays what upstream reviews, and
    where the non-blocking work should land upstream is a separate open question.
  - **What the non-blocking load changes.** `initEventIndex` no longer awaits a
    full read of the persisted index before returning, so opening Element with a
    large index no longer blocks app start — which was the binding constraint
    recorded in the maintainers' EventIndex bounded-memory ruling (not published:
    ~0.18 ms/event of startup decryption, not memory, is what hurts). Hydration now runs in the background behind a
    `hydrating` flag, surfaced to callers as a new `IIndexStats.loading`;
    `SearchWarning` polls it so the "results may be incomplete" notice appears
    and, unlike the checkpoint signal, **clears itself** when hydration finishes;
    reads are paged with a slice deadline and epoch-guarded teardown so a logout
    mid-hydration cannot resurrect decrypted events into cleared maps. Six files
    of the fifteen are new to the patch relative to the 2026-09-12 export:
    `SearchWarning.tsx`, `SearchWarning-test.tsx`, `BaseEventIndexManager.ts`,
    `docs/web-event-index.md`, `docs/.vitepress/config.ts`, and the enlarged
    `en_EN.json` hunk. All three newly-touched upstream source/test files are
    **byte-identical at `v1.12.26` and at the develop commit the PR branch last
    merged**, so they apply at the tag with offset differences only.
  - **Evidence it is safe to carry.** Adversarial review verdict **SHIP** at
    `27e9537a8c`, all thirteen findings fixed and each fix re-verified as
    load-bearing by isolated mutation (maintainer review notes `review-pr-a.md` and
    `measurements-pr-a.md`, not published). Re-run on the
    integration branch itself before the patch was regenerated: **vitest
    121/121** (`BrowserEventIndexManager.test.ts` + `WebPlatform.test.ts`),
    **jest 37/37** across `SearchWarning-test.tsx`, `EventIndexPanel-test.tsx`
    and `RoomSearchAuxPanel-test.tsx`, Playwright 3/3. Two residuals were
    accepted as non-blocking: F9's fix has no test (mutant M16 survives), and
    `useIsIndexIncomplete`'s last `await` sits outside its try/catch (latent
    only — our `isRoomIndexed` is a pure Map read and cannot reject, but
    Seshat's is a native call).
  - **Patch size: fifteen files, `+6116/-32`, 6411 lines.** The added/removed
    lines are byte-identical to `git diff 3028880631 27e660e434`, verified
    per-file; only context and hunk offsets differ.
  - **Bundle markers for this form** (the built code lands in
    `bundles/<hash>/init.js`, never `bundle.js`). Present only in the
    non-blocking build, and all four verified absent from the 2026-09-12
    blocking build's served bundle: **`waitForHydration`** (1),
    **`hydrationFailure`** (4), **`hydration failed`** (1), and the reworded log
    string **`a stored checkpoint could not be decrypted`** (1). Also present,
    from the feature itself: `feature_web_event_index` (3),
    `element-eventindex-v1`, `element-eventindex-cpmac`,
    `supportsEventIndexing` (4). Absent, as retired:
    `feature_inblock_encrypted_search`, `inblock-ew-eventindex`.

    > **Do NOT use `stored ciphertext could not be decrypted` as a negative
    > marker.** An earlier revision of this entry named it as "absent in the
    > non-blocking build" because the diff shows that line being deleted. It is
    > **moved, not deleted** — `initEventIndex` now logs the reworded *"a stored
    > checkpoint…"* variant while the original wording reappears verbatim inside
    > `hydrate()`'s failure path, so the string is present in **both** builds
    > and discriminates nothing. Caught by the live grep during the 2026-09-13
    > promotion, before it was trusted. `BrowserEventIndexManager` is also
    > useless as a marker: the class name is minified away, and greps for it
    > return 0 on a perfectly good bundle.
  - **Condition for closing the gap:** the non-blocking work lands on
    `feat/web-event-index` (and so into #34718), or #34718 merges without it and
    the work is re-filed as its own PR. Until one of those happens, every
    regeneration of this patch must come from the integration branch, and the
    tag-bump procedure in rule 4 must rebase that branch first, not the PR head.
- **SECOND CARRY, 2026-09-13: the patch now carries increments A, B and C, all
  ahead of upstream.** Same sanctioned-exception rule as the first carry (rule 3
  above); this entry is the record it requires.

  - **Provenance commit: `eee0f8a755`** on
    [`inblockio/element-web`](https://github.com/inblockio/element-web/tree/integration/web-event-index-prod-20260913b),
    branch **`integration/web-event-index-prod-20260913b`** — `feat/web-event-index`
    @ `500f348525` merged with `feat/web-event-index-bounds` @ `af6fec256c`, which
    is the top of the A -> B -> C stack and already contains A and B. Supersedes
    the first carry's provenance `27e660e434`. Still **not** merged into
    `feat/web-event-index`; the PR's own line stays what upstream reviews.
  - **A** (carried since the first pass): non-blocking `initEventIndex`, so a
    large index cannot block app start.
  - **B:** batched writes, `getStats()` made O(1), a sorted vocabulary searched by
    binary search instead of scanned, and a per-record folded-text memo.
  - **C:** a crawl window and room cap behind a small `shouldCrawl` hook added to
    the **shared** `apps/web/src/indexing/EventIndex.ts`; a hot-window byte budget
    whose eviction **never deletes disk rows**; a disk budget; an encrypted
    recency manifest in `meta` with a self-healing migration pass for databases
    written before it existed; `navigator.storage.persist()`; and the "Search
    covers messages newer than {date}" line.
  - **Two things operators need to know**, because users will see both:
    1. **Existing browser databases run a one-time background migration pass on
       first load** — about **10 s at 200k events**, and deliberately **off the
       start path**, so the app opens normally while it runs. It is self-healing:
       a database that predates the recency manifest gets one built rather than
       being wiped.
    2. **Events outside the hot window are not searchable** until the cold-scan
       increment lands. This is a real, deliberate reduction in what search
       reaches, not a bug: the bound is what keeps memory and disk finite. The UI
       is honest about it — the search warning states the coverage date
       (`seshat|warning_kind_search_windowed`, "Search covers messages newer than
       %(date)s"), and `docs/labs.md` states the window (90 days) and the room cap
       (100 desktop / 20 on memory-constrained devices).
  - **Evidence:** reviews **SHIP** after several rounds — maintainer review notes
    `review-pr-b.md` and `review-pr-c.md` (C took five passes; final SHIP at
    `af6fec256c`), proofs in `measurements-pr-b.md` and `measurements-pr-c.md` (not
    published). Gates re-run on the
    integration branch itself: **vitest 183/183** (`BrowserEventIndexManager`,
    `WebPlatform`, `eventIndexBounds`, `EventIndex`), **jest 44/44**
    (`SearchWarning`, `EventIndexPanel`, `RoomSearchAuxPanel`), `tsc --noEmit`
    **0 errors in project sources** (3 pre-existing inside
    `node_modules/matrix-js-sdk`), `oxlint` clean, `oxfmt --check` clean,
    `lint:knip` clean, and `pnpm run i18n` regenerating to **zero git diff**.
  - **Patch size: nineteen files, `+10476/-37`, 10892 lines** (was fifteen,
    `+6116/-32`). Added/removed lines byte-identical per file to
    `git diff 3028880631 eee0f8a755`.
  - **One merge conflict, in `docs/labs.md`**, resolved by keeping **both** sides:
    the docs commit's recency-window and CJK paragraph, then C's concrete numbers,
    then the link to `web-event-index.md`. General-to-specific, re-read as a whole
    so the section does not say the same thing twice.
  - **New base-drift risk, checked and clear.** C is the first increment to touch
    the shared `apps/web/src/indexing/EventIndex.ts`, and that file is **not**
    byte-identical at `v1.12.26` and at the develop commit the PR branch last
    merged: develop added two `await`s in front of `addRoomCheckpoint`
    (`:262`, `:296`) after the tag. The 3-way apply resolved against the PR's own
    pre-image, and the result was checked line by line: the applied tree still has
    v1.12.26's **unawaited** calls and the only delta is our `shouldCrawl` work
    (+47/-3). Upstream's fix did **not** leak in. Re-check this at every tag bump:
    a patch that silently imports unrelated develop changes is the failure mode
    here, and it is invisible unless you look.
  - **Bundle markers for this form**, on top of the A markers below:
    **`shouldCrawl`**, **`runManifestMigration`**, **`manifestCeilingBytes`**, and
    the i18n key **`warning_kind_search_windowed`**. All four are absent from the
    first-carry build (`@sha256:785ab46c…`), so they are what tells the two apart.
- **THIRD CARRY, 2026-09-14: the patch now carries increments A, B, C, D-core and
  E, all ahead of upstream.** Same sanctioned-exception rule as the first two
  carries (rule 3 above); this entry is the record it requires.

  - **Provenance commit: `7280a73f90`** on
    [`inblockio/element-web`](https://github.com/inblockio/element-web/tree/integration/web-event-index-prod-20260914),
    branch **`integration/web-event-index-prod-20260914`** — `feat/web-event-index`
    @ `5ae9fdf3dd` (the PR head: review fixes plus the refreshed design doc) merged
    with `feat/web-event-index-cold-tier-core` @ `c61dba1135`, which is the top of
    the A -> B -> C -> D-core -> E stack. Supersedes the second carry's provenance
    `eee0f8a755`. Still **not** merged into `feat/web-event-index`; the PR's own
    line stays what upstream reviews.
  - **D-core:** IndexedDB schema **v3** — events are stored as binary AES-GCM
    **chunks** rather than one record per event, so event ids are no longer in the
    clear on disk, hydration reads each chunk once, and the budget heap orders by
    chunk `maxTs`. The online v2 -> v3 conversion was deliberately **dropped**
    (it stays on `feat/web-event-index-chunks` for reference).
  - **E:** a **cold tier** — content that is on disk but outside the resident
    (hot) window is found by a streamed **newest-first scan**, walked one chunk at
    a time inside a scan **session** held behind an opaque `next_batch` token
    (bounded at four live sessions; an unknown token yields an empty page), with a
    **1 s budget per page** (`COLD_SCAN_BUDGET_MS`) so a miss can never hang the
    UI; the scan is cancelled when a new query arrives. The coverage date in the
    search warning is sourced from the **oldest indexed** event rather than the
    oldest resident one. Item 0 of E is the tier fix: `navigator.deviceMemory` is
    Chromium-only, so **Firefox and Safari desktop users used to fall to the small
    tier**; absent `deviceMemory` on a non-mobile UA (decided with
    `navigator.maxTouchPoints`, which also keeps iPadOS on the constrained tier)
    now means **desktop**.
  - **What operators and users will see, and it is the thing to announce:**
    1. **Every existing browser database is RESET once on first load.** Schema v2
       is not converted to v3 — it is dropped and re-crawled, bounded by C's crawl
       window and room cap, exactly as the first enablement was (the maintainers' original
       ruling; the window is what makes it affordable). Nothing is lost, the
       homeserver is the source of truth. **Visibly:** search coverage restarts
       from the crawl window, and the coverage date in the search warning
       ("Search covers messages newer than …") **moves forward** at the reset and
       then **back** again as the crawler refills the window.
    2. **Older messages beyond the hot window are searchable again.** Since the
       second carry, content outside the resident window was on disk but not
       reachable; E reaches it with the streamed newest-first scan described
       above. A query that has to go to disk costs seconds, not milliseconds
       (measured ~3.1 s over 200k events in 4 pages, ~7.7 s over 500k in 8), which
       is why the per-page budget exists and why the warning says the result set
       may be partial.
    3. **Firefox and Safari on the desktop get the desktop tier** rather than the
       49k-event small tier they were getting from the missing `deviceMemory`.
  - **Evidence:** reviews **SHIP** — maintainer review notes `review-pr-d.md` (four
    sections, D-core SHIP at `2c04b3b562`) and `review-pr-e.md` (four sections,
    E-core SHIP at `c61dba1135`, both HIGH findings of the previous round verified
    fixed in both directions), proofs in `measurements-pr-d.md` and
    `measurements-pr-e.md` (not published). Gates re-run **on the integration branch itself**:
    **vitest 294/294** (`BrowserEventIndexManager`, `WebPlatform`,
    `eventIndexBounds`, `ElectronPlatform`, `PWAPlatform`, `EventIndex`), **jest
    48/48** across `SearchWarning`, `EventIndexPanel` and `RoomSearchAuxPanel`
    (5 snapshots), `tsc --noEmit` **0 errors in project sources** (the 3
    pre-existing ones are inside `node_modules/matrix-js-sdk`), `oxlint` clean,
    `oxfmt --check` clean, `lint:knip` clean, `pnpm run i18n` regenerating to
    **zero git diff**.
  - **Patch size: nineteen files, `+14883/-39`, 15304 lines** (was nineteen,
    `+10476/-37`). Added/removed lines byte-identical per file to
    `git diff 3028880631 7280a73f90`, verified for all nineteen.
  - **One merge conflict, in `docs/labs.md`** again, and for the same reason: the
    docs refresh reworded the labs entry while C and E each added a sentence to
    it. Resolved by keeping the refreshed wording, then C's window/room-cap
    sentence extended with E's cold-scan sentence, then D-core's reset sentence,
    then the link to `web-event-index.md`; the whole section was re-read
    afterwards, and the refreshed "recency window" sentence was adjusted to say
    the crawler stops at the window, because with E on board "old messages are out
    of reach" is no longer true of everything on disk. `docs/web-event-index.md`
    exists only on the PR side and came through untouched.
  - **Base-drift re-check (the `indexing/EventIndex.ts` hazard from the second
    carry) is clean again:** the applied tree still has v1.12.26's **unawaited**
    `addRoomCheckpoint` calls at `:294` and `:328`, and the only delta is our
    `shouldCrawl` work (`+47/-3`). All nineteen files applied cleanly with
    `git apply --3way`; all eight patches apply in Dockerfile order to a pristine
    `v1.12.26` tree; `node --test scripts/browser-eventindex-invariants.mjs` is
    **12/12**.
  - **Bundle markers for this form, counted on the served
    `bundles/<hash>/init.js` with the second-carry build (`@sha256:162f82bf…`,
    `bundles/616d93df8ad1b8214909/init.js`) as the control** — not predicted from
    the source, because what survives minification is not obvious and this file
    has been wrong about a marker before:

    | marker | this build | second-carry control | what it proves |
    |---|---|---|---|
    | `chunkId` | 27 | **0** | D-core chunk store |
    | `"chunks"` | 17 | **0** | D-core object store name |
    | `ColdScanSession` | 3 | **0** | E scan session |
    | `searchPartial` | 8 | **0** | E partial-result signal |
    | `coldTouched` | 3 | **0** | E cold tier touched |
    | `isSearchPartial` | 1 | **0** | E signal reaching the UI |
    | `maxTouchPoints` | 2 | **0** | E item 0, the Firefox/Safari tier fix |
    | `shouldCrawl` | 2 | 2 | C, still carried |
    | `manifestCeilingBytes` | 2 | 2 | C, still carried |
    | `waitForHydration` / `hydrationFailure` | 1 / 4 | 1 / 4 | A, still carried |
    | `feature_web_event_index` / `element-eventindex` | 3 / 3 | 3 / 3 | the gate and the database |
    | `runManifestMigration` | **0** | 2 | see below |
    | `COLD_SCAN_BUDGET_MS`, `migrateToV3` | 0 | 0 | useless as markers |
    | `feature_inblock_encrypted_search`, `inblock-ew-eventindex`, `still_indexing` | 0 | 0 | retired |

    Two things in that table are worth remembering rather than re-deriving.
    **`runManifestMigration` going from 2 to 0 is correct, not a regression:** the
    v3 reset replaced the manifest-migration pass it named, so its absence is a
    *positive* discriminator for D-core. And **`COLD_SCAN_BUDGET_MS` and
    `migrateToV3` read 0 in a perfectly good build** — a module-level const and a
    module-level function both get mangled, exactly like `BrowserEventIndexManager`
    before them. Do not grep for them and conclude the increment is missing.
    The interface name `ColdScanSession` nevertheless reads 3, because it survives
    inside *method and field* names the minifier leaves alone —
    `coldScanSessions` (the session `Map`) and `pageColdScanSession` — not as the
    type itself, which TypeScript erased. Property names, method names, store
    names and string literals are the reliable class of marker here.
- **TAG BUMP to v1.12.29, 2026-09-25 (same A+B+C+D-core+E content, no new
  increment).** Provenance is unchanged (`7280a73f90`); the added/removed lines are
  byte-identical to the third-carry patch except for the three mechanical ports below,
  so every gate and bundle marker of the third carry still describes this code.
  1. `apps/web/src/settings/Settings.tsx`: the interface hunk's trailing context line
     was `"feature_custom_themes": IFeature;`, which upstream deleted (#34703, custom
     themes promoted to devtools). Context re-pointed to the next line
     (`"feature_exclude_insecure_devices"`); the inserted `feature_web_event_index`
     entry, its labs group, levels and default are unchanged.
  2. `SearchWarning-test.tsx` was deleted in the Jest->Vitest move (#34839). The hunks
     now target `apps/web/src/components/views/elements/SearchWarning.test.tsx`, with
     `jest.useFakeTimers` / `jest.advanceTimersByTimeAsync` -> `vi.*` and `vi` added to
     the vitest import. **All SearchWarning coverage is now VITEST**, so the old
     "SearchWarning is jest, run both runners" gotcha no longer applies at this tag.
  3. Patch regenerated from the applied tree (`git diff -O <original file order>`) so
     offsets and index lines match v1.12.29.
  - **Base-drift re-check (the `indexing/EventIndex.ts` hazard):** v1.12.29 now itself
    contains develop's two `await this.addRoomCheckpoint(...)` (#34586,
    no-floating-promises). The patch applied **without** `--3way`, and the only delta
    in the file is still our `shouldCrawl` work (`+47/-3`), so nothing else leaked in.
    The upstream `await`s do not touch the lines the crawl bound changes.
  - **Gates on v1.12.29 with all eight patches applied:** vitest **294/294**
    (`BrowserEventIndexManager`, `WebPlatform`, `eventIndexBounds`, `ElectronPlatform`,
    `PWAPlatform`, `EventIndex`) and **48/48** (`SearchWarning`, `EventIndexPanel`,
    `RoomSearchAuxPanel`, all vitest now), the same totals as the third carry; `tsc
    --noEmit` 0 errors in project sources (7, all inside `node_modules/matrix-js-sdk`);
    `oxlint` clean on every touched file; `pnpm run i18n` regenerates to zero diff;
    `node --test scripts/browser-eventindex-invariants.mjs` 12/12. One timing test
    (`per-flush cost ... < 10 ms`) read 12.4 ms under a 28-file parallel run and passed
    3/3 in isolation.
- **FOURTH CARRY, 2026-10-05: E-core's review cleanup on top of the same A+B+C+D-core+E
  content.** Same sanctioned-exception rule as the earlier carries (rule 3 above); this
  entry is the record it requires. No new increment, no schema change, no i18n string.

  - **Provenance commit: `cae2496d7c`** on
    [`inblockio/element-web`](https://github.com/inblockio/element-web/tree/integration/web-event-index-prod-20261005),
    branch **`integration/web-event-index-prod-20261005`** — the third carry's
    provenance `7280a73f90` plus a clean cherry-pick of `1fde9ffe2b` ("Fix E4-F1 M21
    fixture no-op, stale SearchWarning docstring, count over-report", the one commit on
    `feat/web-event-index-cold-tier-core` after `c61dba1135`). `git diff 7280a73f90
    cae2496d7c` is byte-identical to `git show 1fde9ffe2b`. Supersedes `7280a73f90`.
    Still **not** merged into `feat/web-event-index`.
  - **What the cleanup changes** (3 files, `+38/-12`):
    1. **Behaviour, one line of it:** a cold-scan page's `count`, before the cold tier is
       touched, was `hotHits.length`, the size of a snapshot that is never pruned on
       redaction, so it over-reported once a snapshotted hit was redacted or removed. The
       hot delivery loop's existing liveness predicate is factored into
       `isSnapshotHitLive()` and reused for that tally, so `count` now counts only hits a
       page could still serve. Delivery itself is unchanged (same predicate, now named).
    2. **Test (E4-F1):** the "M21/I8 ... never exceeds the requested limit" case used
       `chunkTargetBytes = 150`, so the chunk-boundary check always fired first and
       mutant M21 was a no-op. One wide chunk, 10 matches, `limit` 6, asserted `=== 6`.
    3. **Docs only (E3-F3):** `SearchWarning.tsx`'s `searchPartial` docstring and the
       warning-branch comment no longer mention a "page cap" the manager no longer has.
  - **How it was regenerated (the 2026-09-25 method):** pristine `v1.12.29` + entries 1-5
    committed as the base, the old entry 6 applied (regenerating from that state with
    `git diff --abbrev=7 -O <the patch's own file order>` reproduces the old patch
    **byte for byte**, which proves the method), then `git diff 7280a73f90 cae2496d7c`
    applied on top **without** `--3way` (clean, all 3 files), then re-exported the same
    way against the 1-5 base.
  - **Verification:**
    - **Patch size: nineteen files, `+14910/-40`, 15339 lines** (was `+14884/-40`, 15313
      lines; the third carry's `+14883/-39` figure was taken at v1.12.26, before the
      tag-bump ports). Per file, the added/removed lines equal `git diff 3028880631
      cae2496d7c` for **18 of 19** files; the 19th is the recorded tag-bump port
      (`SearchWarning-test.tsx` -> `SearchWarning.test.tsx`, jest -> vitest), whose
      section is **byte-identical** to the previous patch.
    - **Old -> new patch delta is exactly the cleanup:** only the sections of the 3
      cleanup files change; 0 context lines differ; the +/- interdiff is 12 lines gone
      and 38 lines new, and those sets are exactly the cleanup's `-` and `+` lines. The
      applied-tree delta is byte-identical to `git show 1fde9ffe2b`.
    - **Apply check (rule 4 loop, fresh `--depth 1` clone of `v1.12.29`,
      `2d90d6b7b6`):** eleven `OK` lines, one per entry, in Dockerfile order.
    - **Gates on v1.12.29 with all eleven patches applied:** vitest **294/294**
      (`BrowserEventIndexManager` 194, `ElectronPlatform` 47, `WebPlatform` 29,
      `eventIndexBounds` 15, `EventIndex` 5, `PWAPlatform` 4; same total as the tag
      bump, the cleanup changes a test rather than adding one, and the M21/I8 case
      passes), and **48/48** (`SearchWarning` 34, `EventIndexPanel` 10,
      `RoomSearchAuxPanel` 4, all vitest; 6/6 snapshots); `tsc --noEmit` **0 errors in
      project sources** (7, all inside `node_modules/matrix-js-sdk`: 3 in
      `MSC4108SignInWithQR.ts`, 4 in `embedded.ts`, as at the tag bump); `oxlint` and
      `oxfmt --check` clean on the 3 touched files; `node --test
      scripts/browser-eventindex-invariants.mjs` **12/12**.
    - **Playwright `web-event-index.spec.ts` was NOT verified for this carry.** Against
      a local `CI_PACKAGE=1` build of v1.12.29 + all eleven patches it failed 3/3 because
      the feature never came on (the search panel offered "Use the Desktop app to search
      encrypted messages", i.e. `supportsEventIndexing()` was false), which points at the
      local harness (labs flag not reaching that build), not at this cleanup, which
      touches neither the gate nor the platform wiring. Not chased within the time box;
      the last green Playwright run (3/3) is the third carry's, on the integration
      branch itself.
  - **Positive bundle marker:** **`isSnapshotHitLive`**, a method name (the minifier
    keeps method names): **3** in `bundles/<hash>/init.js` of a production
    (minified, `pnpm --filter element-web build`) build of v1.12.29 + all eleven
    patches, one definition plus its two call sites, and **0** possible in the current
    (`7280a73f90`) build because the identifier does not exist anywhere in that
    source. The cleanup adds **no string literal**, so there is no i18n or log-string
    marker. In the same build the third-carry markers read exactly as in its table
    (`chunkId` 27, `"chunks"` 17, `ColdScanSession` 3, `searchPartial` 8,
    `coldTouched` 3, `isSearchPartial` 1, `maxTouchPoints` 2, `shouldCrawl` 2,
    `manifestCeilingBytes` 2, `waitForHydration` 1, `hydrationFailure` 4,
    `feature_web_event_index` 3, `element-eventindex` 3, `runManifestMigration` 0).
- **Upstream status: FILED AND ACTIVELY TRACKED — we are trying to get this
  merged.** [element-hq/element-web#34718](https://github.com/element-hq/element-web/pull/34718)
  "Add a browser EventIndex so encrypted-room search works on the web"
  (`inblockio:feat/web-event-index` → `element-hq:develop`, author
  FantasticoFox, opened 2026-08-15). Fixes
  [element-meta#3294](https://github.com/element-hq/element-meta/issues/3294).
  Labelled `T-Enhancement` + `Z-Community-PR`. The shape of the current
  revision is a direct answer to reviewer-facing objections: an ordinary
  labs flag instead of a deployment-specific config key and a hostname
  allowlist, an upstream-neutral database name, and the gate enforced where
  it cannot be bypassed.

  This is the **one patch in this registry with a live upstream merge path**,
  so unlike the POLICY entries it is an interim carrier, not a permanent
  resident. Keep the vendored patch and the PR in sync: a change to one that
  is not mirrored in the other splits our deployment from what upstream is
  reviewing.

  Still NOT a Seshat port — the interface is upstream's, the store is ours. Do
  not describe it as "Seshat for Web" (the PR body says so explicitly, because
  the native-Seshat comparison is what makes reviewers assume WASM/SQLCipher).

  **Status as of 2026-08-31:** mergeable, CI green (6/6 check-runs + CLA), but
  **zero reviews submitted**. GitHub reports `mergeable_state: unstable`, which
  for a community PR usually means workflows awaiting maintainer approval to
  run.

  **Open reviewer-side question worth chasing:** on 2026-08-28 the maintainer
  (t3chguy) reported "I don't see any messages whatsoever" with a screenshot
  while testing, and the PR's author replied suspecting a federation delivery problem
  on our side. That is the SAME symptom class as the MSC4284 policy-server refusal
  tracked in the maintainers' notes (our sends to policy-server
  rooms are refused with a bare 400). If a reviewer cannot see test messages,
  they cannot evaluate a *search* feature — so unblocking the federation issue
  may be on the critical path to this merge. Unproven link; check it before
  assuming.
- **Deployments that used the old key must rename it.** The patch stopped reading
  `features.feature_inblock_encrypted_search` on 2026-09-12, so a bind-mounted config
  that still sets only that key serves encrypted search **off**. Rename the key to
  `feature_web_event_index: true` in the same change that moves the element image to a
  build of this patch. A single-file bind mount follows the inode: rewrite the file in
  place rather than replacing it, then check the served `config.json`. To turn the
  feature off, set the key to `false` or remove it; with the hostname fallback gone,
  removing it means off by design rather than off by accident.
- **Order:** applied SIXTH. Its `en_EN.json` hunk was generated against the
  tree with entries 1–5 applied; entry 7's `en_EN.json` hunk absorbs the two
  lines this one now adds in the `labs` section (it lands at offset +1,
  cleanly). Verified 2026-09-12 by applying all eight in Dockerfile order to
  a pristine v1.12.26 tree.
- **Retirement:** when #34718 (or an upstream equivalent) merges and ships in a
  tag we deploy, PROVIDED it still meets I1–I8 (ciphertext at rest,
  session-bound key, logout wipe) — verify those against the merged form, since
  review may change the store. Also retires if product stops requiring
  hosted-Web search.
- **Coverage:** the patch now carries its own Playwright leg,
  `apps/web/playwright/e2e/crypto/web-event-index.spec.ts` (3 tests under
  `labsFlags: ["feature_web_event_index"]`, driving the **real** room-info
  search box rather than calling the manager: a message sent through the
  composer into an encrypted room is found with one line of context either
  side and nothing further out; a term that was never sent reports "No
  results", asserted only after the index is proven live so the test cannot
  pass against an index that never started; and an indexed message is still
  found after a full page reload, i.e. rebuilt from the encrypted records).
  Element-tree vitest `BrowserEventIndexManager.test.ts` — 75 cases across 8
  suites including the labs gate and **two 5,000-event scale suites**
  (`SCALE_EVENT_COUNT = 5000` over four rooms, in-memory and persisted) —
  plus 8 new `WebPlatform.test.ts` cases pinning `getEventIndexingManager()`
  (never constructs while off, same instance once on, keeps handing one back
  after the flag is gone so logout can delete, one-shot cleanup of an
  orphaned database). Repo `scripts/browser-eventindex-invariants.mjs`
  re-states the crypto and search algorithms independently of the Element
  tree; it was written against the old HKDF info string and is updated here,
  but it does NOT yet cover the checkpoint HMAC or the v1 → v2 reset — a
  known gap, and the reason it is a supplement to the vitest rather than the
  proof. The siwx-oidc leg rule 2 asks for,
  `e2e/element/ew-encrypted-search.spec.mjs`, exists only on the unmerged
  branch `feat/ew-encrypted-search-eventindex` and is NOT on that repo's
  checked-out tree; the in-patch Playwright spec now covers the same user
  journey against upstream's own harness, so the honest statement is that
  the behaviour is covered and the siwx-oidc leg is still unlanded. Default
  `enableEventIndexing` stays upstream's `true` (same as Desktop).

---

### 7. `show-attested-did.patch` — POLICY (permanent, deployment-specific)

- **What:** renders the provider-attested DID (`io.inblock.did`, MSC4133 custom profile
  field) in the TWO places Element shows an identity: directly under the MXID in the
  member-info panel, and under the Matrix ID in **All settings → Account** (the user's
  own profile). Both use Element's own `CopyableText` affordance and label it `DID` or
  `DID (unsigned)`. The settings row renders the DID **in full and case-sensitively** —
  it is the user's own identity page, and a `did:key` multibase payload is key material
  whose middle bytes an elision hides; the width-constrained member panel abbreviates it
  and carries the full value in a tooltip/title. Adds
  `src/hooks/useAttestedDid.ts`, JSX in `UserInfoHeaderView.tsx`, an `AttestedDidBox` in
  `UserProfileSettings.tsx`, two small CSS blocks, two `en_EN.json` strings.
- **Why both surfaces:** the member panel answers "who is *that*", the settings page
  answers "who am *I*" — and the second is the one a user reaches when they want to hand
  their own identifier to somebody. Shipping only the first meant the only way to read
  your own DID in Element was to open your own member panel from a room, which most
  users never do.
- **`AttestedDidBox` is a twin of upstream's `UsernameBox`, not a refactor of it.**
  Leaving upstream's component untouched means a tag bump can change it freely without
  this patch fighting the change, and reusing its class names makes the row inherit the
  section's spacing and type. The only new CSS is `overflow-wrap` — a DID is roughly
  three times an MXID's length and has no spaces. That rule is **load-bearing** on the
  settings row, which shows the whole unbroken string; it would merely be defensive if
  the value were abbreviated there.
- **Why we maintain it:** siwx-oidc publishes each user's DID into that field and the
  homeserver refuses a write to it from anyone but the provider (see
  `patches/synapse/README.md`), but **no Element surface reads it**. Verified against
  the v1.12.26 source: the only extended-profile consumers upstream are `m.tz`
  (timezone) and `org.matrix.msc4426.status`, both specific keys — there is no generic
  custom-field rendering, so without this patch the identity that the whole
  attested-DID feature exists to publish is invisible to every user of the deployment
  that publishes it.
- **Trust framing is load-bearing, and the patch states it in code:** the row is a
  **discovery hint**, not an authorization source. It does NOT verify the ES256 proof
  client-side; what makes the value trustworthy here is the homeserver write-ACL, and a
  relying party still verifies offline (`siwx-oidc-auth --verify-did`). `DID (unsigned)`
  is shown when the provider's key was ephemeral and no `proof` was minted, so the two
  cases are never conflated in the UI.
- **Failure behaviour:** every failure path renders nothing — no published field (a
  404, which is the COMMON case for users of other homeservers), a server without
  extended-profile support, a malformed value, a network error. Logged at `debug`, never
  `warn`: this hook runs for every member panel opened against every homeserver.
- **Evidence:** siwx-oidc `docs/audits/2026-09-10-msc4133-acl-probe.md` (the field is
  world-readable and provider-owned); siwx-oidc `docs/identity-model.md` for the field
  itself.
- **Upstream status:** not upstreamable as-is — `io.inblock.did` is OUR field name, and
  upstream would need a generic custom-profile-field UI (or MSC4133 field registration)
  before anything like this could land. If upstream ships generic custom-field
  rendering, this patch should be **dropped**, not ported.
- **Retirement:** upstream renders custom profile fields generically, OR the
  `io.inblock.did` contract is retired.
- **Order:** applied SEVENTH in `Dockerfile.element` (it was last until entries 8-10
  landed). Its `en_EN.json` hunk was generated against the tree with entries 1-6
  already applied; moving it earlier breaks that hunk. Entry 8 depends on it and must
  follow it.
- **Coverage:** none yet in `e2e/element/` — both rows render from a profile field, so a
  leg needs an account with a published DID on the lab stack. **This is a rule-2
  exception and it should be closed**: add a leg that opens the member panel for a
  siwx-provisioned user, and one that opens All settings → Account, asserting in each
  case that the DID text matches the field read over the C-S API. Note that there is no
  unit-test cover to fall back on either: `apps/web/test/unit-tests/**` looks like a test
  tree but is NOT executed at v1.12.26 — the vitest project includes only
  `src/**/*.test.{ts,tsx}`, and those files use the older `*-test.tsx` spelling. Do not
  add a case there expecting it to run.

### 8. `resolve-did-search.patch` — POLICY (permanent, deployment-specific)

- **What:** makes a DID typed into a search box resolve to the Matrix user it belongs
  to, in both surfaces that accept an identifier: Spotlight (via `hooks/useProfileInfo`)
  and the invite / start-DM dialog (via `InviteDialog.updateSuggestions`). Accepts a bare
  `did:key:z6Mk…` (looked for on the searcher's own homeserver) or
  `did:key:z6Mk…@peer.example.org`, which pins the homeserver to look on. Adds
  `src/utils/didLocalpart.ts` (the derivation + `resolveDidToUserId`) and its unit test,
  and moves the shared `DID_PROFILE_FIELD` constant there from entry 7's hook, which now
  re-exports it.
- **Why we maintain it:** a DID can never *be* an MXID, so without a resolution step
  there is no way to address a user by their key at all. Synapse 1.159.0's
  `MXID_LOCALPART_ALLOWED_CHARACTERS` is `a-z 0-9 - / _ . = +`: no colon — and the first
  colon in an MXID structurally ends the localpart anyway — and no uppercase, which alone
  rules out `did:key`, whose multibase payload is case-sensitive key material. Nor can the
  directory help: `user_directory_search` is an FTS index over **user ID and display name
  only** (verified in the live dev schema), and custom profile fields are not in it. The
  forward derivation is the only handle, and siwx-oidc owns it.
- **The derivation is never trusted on its own — this is the security property.**
  `resolveDidToUserId` derives both candidate localparts (modern hash-shaped and
  grandfathered legacy), then reads `io.inblock.did` back off each candidate and requires
  it to match the DID that was searched for, under the same method-aware canonicalisation
  the account is keyed on (`did:pkh` case-folded because EIP-55 is a checksum; `did:key`
  byte-for-byte because case is key material). This matters because the file is the
  **third hand-maintained mirror** of siwx-oidc's `src/mxid.rs` and a previous hand-copy
  already diverged by lowercasing everything (siwx-oidc#17). With the read-back check, a
  drifted mirror yields **no result** — it can cost a false negative, it can never point
  at the wrong person. `didLocalpart.test.ts` additionally pins the same vectors as
  `mxid.rs`'s own tests, so drift fails in CI before it ships.
- **Why the `@server` suffix, and why `@`:** a DID names a KEY, not a server, so a bare
  DID is only expressible against one homeserver — the searcher's own. The suffix is the
  smallest thing that makes a federated lookup sayable at all. `@` is unambiguous as the
  separator because W3C DID Core's method-specific-id grammar does not admit it, for any
  method (`did:pkh`'s own colons are therefore safe). The transport needs nothing new:
  Synapse's `on_profile_query` returns custom profile fields over federation, so our
  homeserver proxies the read. A 10s bound wraps the whole resolution, because a pinned
  peer that is slow or down would otherwise stall the search box.
- **What a match proves: the proof is verified in the browser (2026-09-28).** The
  field alone is only as good as the homeserver's write ACL (`patches/synapse/`), which
  holds for our own server by construction and for a peer only when it runs this stack.
  So, per a maintainer decision of 2026-09-28, Element now verifies the ES256 compact JWS in
  the field's `proof` member itself (`src/utils/didProof.ts`, a port of
  `siwx-oidc-auth`'s `verify_did_assertion`; wire contract in siwx-oidc
  `src/did_assertion.rs`):
  - header `alg` must be ES256, no `crit`, a `kid` present; checked before any key is
    fetched, so `none`/HS* downgrades never reach a key;
  - `sub` must be the searched DID and `mxid` must be byte-equal to the candidate MXID.
    The `mxid` check is the replay guard: a genuine proof copied into another profile
    fails here;
  - `iss` is PINNED to the issuer the candidate MXID's OWN homeserver advertises in its
    `/_matrix/client/v1/auth_metadata` (ours via the client; a peer's via its
    `.well-known/matrix/client` -> `base_url`). Keys are never looked up from the
    token's own `iss`;
  - keys come from that issuer's discovery `jwks_uri` (same origin as the issuer),
    selected by `kid`, no fallback. siwx-oidc's `/jwk` lists retired keys
    (`oidc::jwks`), so proofs minted before the 2026-09-27 prod key rotation still
    verify. An unknown `kid` forces one JWKS refresh before it counts as a failure;
  - the signature is raw r||s, 64 bytes, verified with WebCrypto over the RECEIVED
    signing input;
  - discovery and JWKS are cached per issuer (10 min, failures not cached), and those
    requests carry only server names and issuer URLs, never the searched DID, with
    `credentials: "omit"` and no referrer.

  Outcomes, as rendered (a marker beside the MXID in the invite dialog and Spotlight,
  never in the display name, which the found user controls):

  | Outcome | When | Shown? |
  |---|---|---|
  | VERIFIED | every check passed | yes, "DID verified" |
  | UNVERIFIED (unchecked) | proof present and the network-free checks passed, but discovery or JWKS unreachable (CORS, network, 4 s budget, malformed document) | yes, "DID unverified: signing key unreachable" |
  | UNVERIFIED (unpublished) | OUR OWN homeserver's `/resolve` named the account, but it has no signed DID yet (field absent, or no `proof`) | yes, "DID unverified: not yet published" |
  | REJECTED | proof present and fails any check: malformed, bad signature, `sub`/`mxid`/`iss` mismatch, unknown `kid` on a reachable JWKS | no |
  | no proof, formula or remote hit | field without `proof`, or no field, on anything but an own-server `/resolve` hit | no |

  The unverified-unpublished row is maintainer decision 1 (2026-09-28) and applies to
  own-server resolver hits ONLY: the formula is a guess and a remote resolver is another
  organisation's word, so neither names an account on its own. The published `did`
  member must still match the searched DID in every row, so a lying resolver still
  gets no result.

  **Honest limit, read before trusting a VERIFIED remote result:** the signature
  proves that the issuer the candidate's homeserver advertises attested the binding.
  It removes the dependency on that server's profile ACL; it does NOT protect against
  a malicious remote OPERATOR, who controls both the homeserver and the issuer it
  advertises and can sign any DID-to-MXID binding it likes. Only a signature by the
  DID's own key would close that, and the wire format carries none. Likewise an
  attacker who can make the keys unreachable gets at most "unverified", never
  "verified", which is why the two markers must stay visibly distinct.

  **Browser traffic this adds:** verifying a REMOTE candidate fetches that peer's
  `.well-known/matrix/client`, `auth_metadata`, discovery document and JWKS from the
  searcher's browser (the peer learns the searcher's IP and that someone looked up one
  of its users shortly before, but not which DID). The remote RESOLVER (which would
  receive the DID) stays off by default (maintainer decision 2). For this to verify rather
  than show "unverified", the peer's `/jwk` and discovery must admit the searcher's
  origin in CORS; for our own issuer on prod that is branch `feat/public-jwks-cors`
  (ACAO `*` on those two paths only; today prod already admits `element.inblock.io`,
  so our own users verify on our own Element either way).
- **Deliberate limits:** on a federated server (or when our own resolver cannot answer)
  only accounts that have published a signed field are findable; an account that has
  not signed in since publication started becomes findable by itself with no migration,
  because siwx-oidc re-asserts the field on every sign-in. On our own server such an
  account IS found through `/resolve`, marked "not yet published" (see the table above). The derivation is also our provider's, so a homeserver running this build with
  a different identity provider will not place its users where this computes. Typing a DID
  and pressing enter in the invite dialog does not convert it to a target
  (`convertFilter` is synchronous and resolution is not); the resolved suggestion must be
  clicked.
- **One upstream behaviour change beyond the DID path:** Spotlight's profile lookup is
  gated on `filter === Filter.People`, which is right for an MXID but would hide the only
  result a DID has, so the gate is widened by `|| looksLikeDid(trimmedQuery)`. MXIDs keep
  upstream's behaviour exactly. The hit lands in Spotlight's Suggestions section, which
  upstream renders only under the People filter, so with NO filter the section is shown
  holding the DID hit alone (fixed 2026-09-29: before that the lookup ran but its result
  was never rendered). A DID naming someone we already have a DM with shows that DM,
  which upstream would drop because the DID is in no room or member name.
- **Failure behaviour:** never throws. No extended-profile support, no such user, an
  absent or malformed field, a network error — all resolve to "no result", and a DID that
  names nobody is reported as a successful empty search, not an error.
- **Evidence:** the live dev probe behind it — `user_directory_search` holds only
  `@user:server` plus the display name; `MXID_LOCALPART_ALLOWED_CHARACTERS` read out of
  the running 1.159.0; and a full round trip on the dev homeserver from a `did:pkh` DID
  to its 16-character localpart and on to the published `{did, proof}`.
- **Upstream status:** not upstreamable as-is, for the same reason as entry 7 —
  `io.inblock.did` and the localpart derivation are both ours.
- **Resolver first, formula as fallback (2026-09-27, branch `feat/did-search-resolve-plus-federation`).**
  The lookup now asks the provider's own `GET /resolve` (siwx-oidc c5ed83b) before it
  derives anything. Order, per searched server:
  1. **Own homeserver:** the resolver is found in our own `auth_metadata` under
     `io.inblock.resolve_endpoint` (siwx-oidc branch `feat/advertise-resolve-endpoint`
     adds it; Synapse forwards unknown issuer-metadata keys, `extra="allow"`), else
     `{issuer}/resolve`. The issuer guess is allowed for our own server only.
  2. **Pinned remote homeserver:** only when `config.json` sets
     `"io.inblock.did_search": {"remote_resolvers": true}` (default OFF). Discovery is
     the peer's `.well-known/matrix/client` -> `base_url` -> `auth_metadata` ->
     advertised key, never a guess. Off by default because it is the only step where the
     searcher's BROWSER contacts another organisation (their IP + the searched DID go to
     the peer), and it needs the peer's edge to admit our origin in CORS.
  3. **When a resolver answers, its answer is final:** "account X" means only X is
     checked; "no account" means no result. It applies the real derivation and the real
     grandfathering rule (legacy first), so it cannot drift and it names the canonical
     account in the split-brain case where both shapes publish the DID (the formula alone
     would take the modern one).
  4. **When no resolver answers** (none discovered, CORS refusal, the edge limiter's 429,
     503/5xx, a 4 s budget, a malformed body, or an answer naming a different server)
     the hand-copied formula runs as before, over federation for a pinned peer, now
     LEGACY-first to match the provider's grandfathering order.
     That is what keeps cross-server search working with no browser-to-peer traffic.
  **Every candidate, from either path, is accepted only if its `io.inblock.did` read
  through our homeserver matches**, and then its proof is verified as described above.
  A lying resolver or a drifted formula yields no result, never the wrong user.
- **Why the formula copy stays:** it is the only path to a federated server whose
  resolver we cannot or should not call from the browser, and the fallback when our own
  resolver is rate-limited or down. Its drift is now checked end to end: siwx-oidc's
  `tests/fixtures/localpart-vectors.json` is proven equal to `mxid.rs` by
  `tests/localpart_vectors.rs` (siwx-oidc), the patch's test embeds that file verbatim
  and asserts `didLocalpart.ts` reproduces it, and `scripts/check-did-localpart-vectors.sh`
  proves the embedded copy is byte-identical to the fixture.
- **Retirement:** the `io.inblock.did` contract is retired. (The previous retirement
  condition, "siwx-oidc grows `/resolve`", is met, and the answer was to put the resolver
  in front, not to delete the formula: deleting it would drop DID search on federated
  servers, because our `/resolve` answers only for its own homeserver and has no way to
  reach a peer's.)
- **Order:** applied AFTER entry 7 and depends on it. It moves `DID_PROFILE_FIELD` out of
  `useAttestedDid.ts` into `utils/didLocalpart.ts` and rewrites that line into a
  re-export, so dropping 7 or swapping the two fails the build.
- **Coverage:** `didLocalpart.test.ts` ships inside the patch (60 vitest cases): the
  pinned vectors plus the 6 embedded golden vectors, the pkh/key case rules, shape,
  no-DID-leak, the legacy shape, the `looksLikeDid` boundary, `parseDidQuery`, the
  resolver path (advertised endpoint, issuer fallback, legacy-first formula fallback
  matching the provider, "no account" is final, a lying resolver is rejected without a
  formula second guess, fallback on 429/503/malformed/wrong-server/no-OAuth/hung
  resolver, discovery caching, remote resolver default-off, remote discovery chain, no
  remote issuer guess, remote wrong-server answer), and 22 proof-verification cases on
  keys generated inside the test (no real server's key material): verified by the live
  key, by a RETIRED key, on the formula path and for a remote user; rejected for a
  replayed proof (valid JWS, wrong `mxid`), wrong `iss` with the attacker issuer never
  fetched, our issuer signing for a remote user, another `iss` under the pinned key,
  unknown `kid` (after one refresh), bad signature, wrong `sub`, `alg` none/HS256 and
  `crit` (before any key fetch); unverified for a CORS-refused JWKS and an unreachable
  remote discovery; own-server `/resolve` hit unpublished or proof-less -> unverified;
  formula and remote-resolver hits without a proof hidden; per-issuer caching. Plus
  `DMRoomTile.test.tsx` (4: the three markers, and none for a display name that
  imitates one) and 2 `useProfileInfo` cases for the marker's data path. Mutation-
  checked: disabling the `mxid`, `sub`, `iss`, `alg`, signature, pinning, `kid` refresh,
  own-only or published-`did` check each fails at least one case. Verified against
  v1.12.29 with all eight patches applied in Dockerfile order: 97/97 across
  `didLocalpart`, `useProfileInfo`, `InviteDialog` and `DMRoomTile`; `tsc --noEmit` adds
  no errors; oxlint/oxfmt clean; `pnpm --filter element-web build` succeeds. No
  `e2e/element/` leg yet: like entry 7 it needs a lab account with a published DID.
- **Stale profile cache (2026-09-29):** matrix-js-sdk's `getExtendedProfileProperty` is
  cache-first: the first read of `io.inblock.did` is written through to the client store
  (IndexedDB) and every later read returns that copy, which only an MSC4429 sync update
  for a sync-filter key would refresh (this key is not one). So a DID removed, a proof
  re-issued under a new key, or an account deactivated after the first search kept
  answering from the cache. The candidate read now uses `getExtendedProfile` (never
  cached), and writes the fresh answer back over any cached copy: a re-issued proof
  overwrites it (an account's DID itself never changes, so there is no "changed DID"
  case), a missing field is removed from the cached
  profile (the whole entry when nothing else is left), an account the server answers 404
  for loses its cached profile (any errcode: an erase-deactivated account answers
  `404 M_UNKNOWN "No row found (profiles)"` on Synapse 1.161, found by the dev browser
  run, where an `M_NOT_FOUND`-only check fell back to the stale cached copy). Only when the homeserver cannot answer (network, 5xx, unreachable
  peer) is the cached copy read, and a cached copy whose proof is REJECTED is evicted.
  No js-sdk patch needed. Not covered: `useAttestedDid` (entry 7) still reads cache-first,
  so a user-info panel opened with no DID search in between can show a deactivated
  account's DID or a proof that no longer verifies; a DID search for that user corrects
  it. 9 vitest cases (mock client modelled on js-sdk's cache-first read); disabling the
  fresh read fails 8, the proof overwrite 1, the reject eviction 1, the 404 eviction 2.
- **Spotlight coverage (2026-09-29):** 6 jest cases in `SpotlightDialog-test.tsx`
  (verified hit with no filter and with People, unverified marker with no filter, no
  other Suggestions leak in with no filter, existing DM shown, no-results). The Spotlight
  jest suite does not load at v1.12.29 as shipped (`content-type@3` is ESM and missing
  from `transformIgnorePatterns`); run it with a local config that adds `content-type`
  to that allowlist: 37/37 with the fix, 4 of the new cases fail without it.

### 9. `sw-versions-no-cache-on-error.patch` — UPSTREAM DEFECT (carry until fixed)

- **What:** in `apps/web/src/serviceworker/index.ts`, the check behind
  `tryUpdateServerSupportMap` now (a) retries `GET /_matrix/client/versions` **without**
  the `Authorization` header when the authenticated call is not `ok`, (b) never caches a
  non-`ok` or malformed answer (no `versions` array): it throws, the caller's existing
  catch serves that one request as before, and the next media request checks again,
  and (c) shares one in-flight check per server between concurrent media requests. The
  bodies of discarded error responses are cancelled. Ships the co-located vitest file
  `serverSupport.test.ts` (7 tests). Markers in the built `/app/sw.js`: `not caching
  server support`, `retrying without one` (the Dockerfile greps both and fails the build
  if either is missing).
- **Byte-for-byte the upstream PR diff.** The patch is `git diff upstream/develop` of
  branch `fix/sw-versions-not-cached-on-error` on inblockio/element-web (four commits:
  (b), (a), (c), then a SonarCloud follow-up; PR head `246724f407`), byte-identical apart
  from the `index` line of `index.ts`, which carries the v1.12.29 blob ids so that entry
  10's `index` line chains from it. Applied to v1.12.29, the only difference between
  the two trees in this file is the unrelated `ACCESS_TOKEN_IV` -> `ACCESS_TOKEN_NAME`
  rename (#35077), which no hunk touches. Keep them identical: a change here is a change to the PR, and the
  reverse.
- **Re-vendored 2026-09-29 from PR head `246724f407`** (was `4ea5f83813`). The SonarCloud
  follow-up throws a `TypeError` for an `ok` response without a `versions` list (a
  non-`ok` response keeps its own `Error`, both messages end `not caching server
  support`) and uses `??=` for the shared in-flight check; no behaviour change. The
  vendored patch again equals the PR diff (0 differing added/removed lines, rule 4b).
  Dev still runs the `4ea5f83813` copy; the dev verification below is of that copy.
- **Why:** stock sw.js does `await (await fetch(versions, auth)).json()` with no status
  check and caches `supportsAuthedMedia = versions?.versions?.includes("v1.11")` for 2 h.
  A 401 error body therefore caches `false`, and every media request of that SW instance
  goes to the legacy `/_matrix/media/v3/*` endpoints, which our Synapse (authenticated
  media enforced) answers 404: all thumbnails, avatars and downloads break until the
  browser terminates the SW. The SW reads the access token from IndexedDB, and siwx-oidc
  access tokens live 300 s (same default as MAS), so an expired stored token is routine:
  any SW-intercepted media fetch between token expiry and the app's first 401-triggered
  refresh poisons the map. A 5xx (a Synapse restart, a proxy hiccup) poisons it the same
  way. `/versions` does not require auth, and media support is a server property, so the
  anonymous retry is exact.
- **Evidence (2026-09-28, dev, headless Chromium, harness
  `scripts/element-sw-media-repro.mjs`, pre-fix builds):** SW console
  `/versions response ...: {"errcode":"M_UNKNOWN_TOKEN","error":"Token is not active"}`
  then `serverSupportMap update ...: {"supportsAuthedMedia":false,...}` then
  `media/v3/download ... 404`, image still broken after a room re-open and a normal
  reload. Which leg each result tests:
  - **Live stale-token window, SW idle-terminated** (`live`, `LIVE_STOP_SW=1`): poisoned
    in **1/1 run per arm, 2 runs total** (shim and noshim, i.e. also stock Element). This
    is the leg entry 9 fixes.
  - **Delayed-refresh reopen** (`reopen`, `TOKEN_DELAY_MS=4000`: the refresh lands after
    load+3 s, the prod ordering): poisoned 2/2 with the shim, 0/2 with only guard (E)
    disabled, 0/2 with the shim blocked. These runs exercised the **guard (E) gate**
    (runtime delta `sw-boot.js`), not the SW patch: the trigger was our own canary.
    Prod log forensics: all three observed bursts started with the canary's `/versions`
    401.
  - **Fast reopen** (refresh ~1.5 s, beats every SW fetch): 8 runs, all clean, but
    those logs (`ff-*`) were taken on the 740f227 build, i.e. after the fix. No pre-fix
    fast-reopen log survives, so the earlier "not reproduced, 0/10" claim is withdrawn
    as unsupported; the ordering argument (the refresh lands before any SW fetch) is
    the reason to expect no poisoning there.
  - With (a)-(c) alone, the one media request issued inside the stale-token window still
    got a 401 on the authenticated endpoint and that image stayed blank until
    re-rendered (4/4 live runs, also stock behaviour): that is entry 10.
- **Possibly related upstream reports:**
  [element-web#34842](https://github.com/element-hq/element-web/issues/34842) (open, "All
  media 404 in Firefox") and
  [element-web#34897](https://github.com/element-hq/element-web/issues/34897) (closed,
  "After upgrade to 1.12.27, media not loading"). Neither names this mechanism. The
  missing `response.ok` check was already on our own list on 2026-07-31 (a
  service-worker hardening handover, not published) and was not acted on then.
- **Upstream status:** Filing ordered by a maintainer decision, 2026-09-28, explicit exception: the
  2026-09-01 filing policy gates only entries 2/3/4 on #34718. Issue:
  [element-web#35241](https://github.com/element-hq/element-web/issues/35241) (filed
  2026-09-28). PR:
  [element-web#35242](https://github.com/element-hq/element-web/pull/35242) (opened
  2026-09-28, head inblockio/element-web `fix/sw-versions-not-cached-on-error` at
  `246724f407` since 2026-09-29, was `4ea5f83813`; no force-push from here on). Checked
  2026-10-05: #35241 and #35242 both open, not merged. #35242's only review requested
  changes to the description (addressed 2026-09-29, re-review pending), and its build
  and test workflows still wait for a maintainer's first-time-contributor approval.
  Drafts as filed in `docs/upstream/2026-09-28-element-sw-versions/`. Our tests live in
  `serverSupport.test.ts` so that they do not conflict with the maintainer PR #34955
  (hughns), which adds `serviceworker/index.test.ts`.
- **#34955 merged 2026-10-05** (`cd558745`, the tip of `develop` that day). It is in no
  release yet: v1.12.29 (ours) and v1.12.30 (latest) both predate it. It refactors
  `getAuthData` in `index.ts` and adds `index.test.ts`, whose `/versions` fetch mock
  returns `{ json }` without `ok`. Checked on `develop` at `cd558745` (2026-10-05):
  entries 9 and 10 apply with line offsets only; `serverSupport.test.ts` 7/7 and
  `mediaTokenRetry.test.ts` 6/6 pass; `index.test.ts` fails 2/4 with entry 9 applied,
  because entry 9 treats a response without `ok` as failed and the two token tests then
  get the legacy `/_matrix/media/v3` URL. Changing that one mock line to
  `return new Response(JSON.stringify({ versions: ["v1.11"] }));` makes all 17 pass.
  Element's `tests.yml` runs on the PR merged with `develop` and in the merge queue, so
  #35242 needs that change as soon as its CI runs. Bringing it in takes a merge of
  `develop` into the PR branch (a rebase would be a force-push).
- **Approved deviation (test-only, a maintainer decision 2026-10-05; NOT in effect
  yet).** It takes effect when #35242 picks up #34955 together with the mock change
  above. From then on the PR diff also changes `apps/web/src/serviceworker/index.test.ts`,
  which does not exist at v1.12.29 or v1.12.30, so the vendored entry 9 cannot carry that
  hunk and leaves it out. Every other added/removed line stays identical to the PR, and
  rule 3 still applies to them. (a) Recorded here. (b) Provenance: the PR head commit
  that carries the mock change; record its sha here in the same change that re-vendors
  entry 9. (c) Closes at the first tag bump to a release that contains #34955 (entry 9
  then equals the full PR diff again), or when the patch retires. While it is in effect,
  the rule 4b drift check prints exactly that hunk's removed and added mock line, and
  nothing else.
- **Retirement:** a tag bump where upstream checks `response.ok` (or otherwise stops
  caching a failed `/versions`), i.e. our PR or an equivalent merged. The patch then
  fails to apply: check, and drop it (and rebase entry 10 onto the upstream code).
- **Coverage (rule 2):** Playwright leg `e2e/element/ew-sw-media-auth.spec.mjs` in the
  siwx-oidc repo, branch `test/ew-sw-media-auth` (commit 207f4b8), legs SW-1 (authed
  `/versions` 401, anonymous retry, image renders, zero legacy requests, SW logs the
  retry marker) and SW-2 (one `/versions` check 503s; a room opened afterwards and the
  room opened during the outage both render). Plus the vitest file in the patch, and the
  harness below.
- **Verified on dev (rev 3a3dae8, `element-web@sha256:9db9df51…`, 2026-09-28):** served
  `sw.js` carries all three entry 9/10 markers. Playwright leg (siwx-oidc 207f4b8,
  re-run 2026-09-28 evening) **3/3 runs green** (SW-1, SW-2, SW-3 each pass in every
  run; maintainer run logs, not published). The same leg against the
  **stock v1.12.29 sw.js** (from `docker.io/vectorim/element-web:v1.12.29`, served
  through the spec's pass-through proxy via `EW_SW_OVERRIDE`) **fails every leg (1 stock
  run per leg)**: SW-1 in a full run (serial mode then skips SW-2/SW-3;
  `run2-stock.log`), SW-2 and SW-3 each alone with `-g` (`run-stock-SW-2.log`,
  `run-stock-SW-3.log`). SW-1 and SW-2 fail with the exact poisoning
  (`serverSupportMap update ...: {"supportsAuthedMedia":false}`), SW-3 with a blank
  image. Override verified in each stock run: the stock file carries none of the three
  markers, the proxy served it 4x, and the SW console lacks `not caching server support`.
  The 6 accounts these runs created and the 8 from earlier runs (14 in total, each
  verified as the creator of its own `sw-media-auth text` room) were deactivated with
  `erase: false` (maintainer run logs).
  Harness: live window (`live`, `LIVE_STOP_SW=1 LIVE_TRIGGER_S=300.8`) **3/3 shim
  and 3/3 noshim** clean, every one logging `retrying without one` and `retrying media
  request with a refreshed access token`, image rendered first time; fast reopen **3/3**
  clean. `element-deploy-audit.sh`: 21 PASS, 1 WARN, 0 FAIL. The harness's network
  counters recorded `swVersions401 = 0` in all six live runs although the SW console
  shows the 401 and the retry: that is the cold-SW blind spot documented in the harness
  header, and why its pass criteria are the SW console plus render state.
- **Earlier verification** (rev 740f227, `element-web@sha256:17b878c1…`, the unsplit
  patch; counts re-derived from the surviving logs): live window with the SW stopped
  6/6 clean, 3 per arm (4 plain, 2 with the `/token` response delayed 4 s), each logging
  both retry markers; delayed-refresh reopen 6/6 clean, which tests the guard (E) gate,
  not the SW patch; fast reopen 8/8 clean (the registry said 10/10). Not exercised in either round: the logged-out page under the new gate (the
  canary returns before probing without `mx_hs_url`/`mx_user_id`, by code reading only).

### 10. `sw-media-401-token-retry.patch` — UPSTREAM DEFECT (not filed; carry until fixed)

- **What:** in the same file, a media request sent with the stored access token that
  comes back **401** waits for the app to store a refreshed token and retries once. The
  wait has a **wall-clock deadline of 5000 ms**; every read of the stored credentials
  (`getAuthData`, which includes a postMessage round trip to the tab) is capped by the
  time left, so a tab that stops answering cannot stretch it. **One shared waiter per
  rejected token** (the same pattern as entry 9's shared check), so a room of thumbnails
  that all 401 polls once, not once per image. Before retrying it re-checks that the
  refreshed credentials still point at the request's homeserver, and it cancels the body
  of the 401 it discards. It also fixes an upstream leak it would otherwise multiply:
  `askClientForUserIdParams` never removed its `message` listener on timeout. Ships
  `mediaTokenRetry.test.ts` (6 vitest tests: retry, 5 s bound with no refresh, silent-tab
  bound with zero leaked listeners, 20 concurrent requests share one wait, homeserver
  change keeps the 401, discarded body cancelled). Marker in the built `/app/sw.js`:
  `retrying media request with a refreshed access token` (grepped at build time).
- **Order:** applied after entry 9, whose context it needs.
- **Header refresh (2026-09-29):** regenerated on top of entry 9 re-vendored from
  `246724f407`. It still applied (hunks 4 and 5 at offset -4), but its `index` line and
  those two hunk headers were refreshed so the chain from entry 9 holds. Added/removed
  lines unchanged (0 differences), no behaviour change.
- **Why:** with entry 9 alone, the media request issued inside the stale-token window
  (between access-token expiry and the app's 401-triggered refresh) still goes to the
  authenticated endpoint with the expired token and gets a 401; the image stays blank
  until it is rendered again (4/4 live runs on dev, stock behaviour too). The SW has no
  way to refresh a token itself, so it can only wait for the app.
- **Coupling (F3):** guard (E)'s canary in `config/element-sw-boot.js` calls the SW
  wedged when its probe does not settle within **8000 ms**. A probe sent with a rejected
  token settles only after this patch's wait, so the 5000 ms bound must stay well under
  the 8000 ms timer. Change them together; both files say so.
- **Evidence:** the 4/4 live runs above; after the patch, all six live runs of
  2026-09-28 logged the retry and rendered the image first time; Playwright leg SW-3
  (the image's own media request is answered 401 while one page `whoami` 401 makes the
  app refresh) passes on the patched build and fails on stock sw.js. The auditor's
  scratch suite (not published) against this revision:
  8/8, revoked token returns the 401 after about 5.0 s, silent tab after about 4.7 s with
  0 leaked listeners, 20 concurrent 401s cost 30 postMessages in total (was one poll loop
  per request).
- **Upstream status:** UPSTREAM DEFECT, **not filed**, and not covered by the 2026-09-28
  filing exception. Recommended as a separate issue later. Polling from the SW is our
  interim carrier; the better upstream design is the SW asking the controlling tab to
  refresh (a `postMessage` the app answers with a fresh token, or with "gone"), which
  removes the polling and the fixed bound.
- **Retirement:** upstream fixes the service worker's stale-token handling (any form:
  the tab-refresh message above, or the SW retrying a 401 itself). The patch then fails
  to apply or becomes redundant: check, and drop it.
- **Coverage (rule 2):** Playwright leg SW-3 in `e2e/element/ew-sw-media-auth.spec.mjs`
  (siwx-oidc branch `test/ew-sw-media-auth`), plus the vitest file in the patch and the
  harness `live` mode.

### 11. `copy-markdown.patch` - FEATURE, upstreamable (not filed; carry until upstream ships an equivalent)

- **What:** the message context menu gets a **Copy Markdown** item, in the quick-actions
  group directly above Pin (after Edit), on **right-click only**: the "..." options menu is
  unchanged. It is offered for `m.text`, `m.notice` and `m.emote` room messages that are not
  state events, redacted or undecryptable, and only when the message displays something to
  copy (visible text, an image Element shows, or maths). `canCopyMarkdown` is that cheap
  visibility check: it does not convert, because it runs on every menu render, and the
  conversion runs only when the item is clicked; neither function ever throws. The click
  copies through the existing `copyPlaintext` and closes the menu. The converter is the new
  `apps/web/src/utils/eventToMarkdown.ts` (`canCopyMarkdown`, `eventToMarkdown`):
  - A `formatted_body` (`org.matrix.custom.html`) is parsed with `DOMParser` into an inert
    document and **converted, not stripped** to CommonMark + GFM: everything Markdown can
    express is kept, everything it cannot is reduced to its text. `mx-reply`, `script`,
    `style`, `noscript`, `textarea` and `option` are dropped. It copies what Element
    displays, not what the sender wrote: a link is kept only when its scheme is one Element
    permits (`PERMITTED_URL_SCHEMES`), otherwise only its text is copied, and only `mxc:`
    images are kept (an image Element does not show is dropped). The output is kept valid
    CommonMark: emphasis is always validly paired or degrades to plain text; a fence info
    string is kept only when it is plain; a bare `http(s)` URL in text (its scheme matched as
    ASCII) becomes an `<url>` autolink only when it is a grammar-valid URI; control
    characters, `\`, `|` and an entity-like or numeric-reference `&` in link destinations
    are percent-encoded; image alt text has its whitespace collapsed; maths tex is normalised the way TeX reads it (inline line breaks become
    spaces, `%` comments are cut, blank lines in display maths are dropped, every display
    maths line is indented by four spaces); adjacent code spans are merged and empty ones
    dropped. No accidental GFM table can form: every `|` in text is escaped and every `|` in
    a destination is percent-encoded, display maths lines are indented so that no block
    syntax (a table delimiter row among them) starts inside maths, and each table cell is
    judged on its own the way GFM parses it (GFM splits a row into cells before it reads any
    inline syntax).
  - **No HTML in the copy is a checked guarantee, not a property of an enumeration of
    cases.** Every result is parsed back with commonmark (`isSafeMarkdown`); a result that
    holds raw HTML, a link with a scheme Element does not permit or a non-`mxc:` image makes
    the copy fall back to the escaped plain text of what Element displayed
    (`withSafetyNet`). Ordinary messages never reach the fallback. A seeded property test
    (1,000 messages and 200 plain bodies) pins the guarantee.
  - **The sender's source, judged on the raw event (algorithm v2, 2026-10-04).** Before
    converting, the copy checks whether the `body` provably is the Markdown source of what is
    displayed, for any sender (Element, the Matrix Rust SDK used by agents and bots, other
    CommonMark clients), using only the event's own content: no client setting, no renderer
    of the copying client. Then the copy is the `body` (reply fallback stripped, trailing
    ASCII whitespace trimmed). An HTML message qualifies when the `body` parsed as CommonMark
    and the `formatted_body` parsed as HTML map to the same canonical tree (`markdownCanon.ts`:
    blocks, emphasis, code, links and images by normalised target; tables, `~~`, task boxes,
    line breaks and whitespace compared renderer-independently), directly or with mention
    pills spliced in as `[Name](https://matrix.to/#/...)`. The `formatted_body` is only
    considered when it is plain Markdown-renderer HTML (a lexical gate and a strict tag
    allow-list; anything else is opaque and takes the converter), because Element displays
    sanitiser output whose tokenizer differs from an HTML5 parse exactly on what is excluded.
    A plain message (no `formatted_body`) is its own source and is copied as written; it is
    escaped only when unsafe. Every accepted source must pass `isSafeMarkdown` (which now also
    rejects link reference definitions) and `gfmCellsSafe` (each GFM cell judged alone). The
    algorithm is specified language-neutrally in
    [docs/copy-markdown/README.md](../../docs/copy-markdown/README.md) with conformance vectors
    ([docs/copy-markdown/vectors.json](../../docs/copy-markdown/vectors.json), byte-identical
    to the copy the patch adds, checked in CI), so an SDK port produces the same output.
    History: the first version (2026-10-03) compared against Element's own send path, which
    read client settings and only covered Element senders; it is replaced.
  - When the source is not provable, a message without `formatted_body` is escaped so that it
    renders as the literal text Element displayed, with its indentation kept as no-break
    spaces, and a message with HTML is converted as described above.
  - Heading text gets no line-start escapes (`### 1. x` stays as is); only a trailing run of
    `#` keeps its escape.
  - One new string, `action.copy_markdown` ("Copy Markdown"), in `en_EN.json`.
  - `apps/web/src/editor/` is **untouched** (the converter only imports
    `longestBacktickSequence` from `editor/deserialize`, read-only).
  Ships `utils/eventToMarkdown.ts`, `utils/markdownCanon.ts` (the canonical model),
  `utils/eventToMarkdown.vectors.json` (246 conformance vectors) and
  `vitest.browser.copy-md.config.ts` (runs the vectors in Chromium), plus two vitest files:
  `utils/eventToMarkdown.test.ts` (new, 1344 tests, including the vectors and the seeded
  property test) and five new tests in `MessageContextMenu.test.tsx` (45 in the file;
  the two "not offered" tests first assert that an item which must be present is, so they
  cannot pass on a menu that failed to render).
  Marker in the built bundle: the string `Copy Markdown` (not grepped at build time).
- **Order:** applied last. Its single `en_EN.json` hunk was generated against the tree with
  entries 1-10 applied.
- **Why:** [siwx-oidc-matrix-server#24](https://github.com/inblockio/siwx-oidc-matrix-server/issues/24).
  Today the only way to get at a message's source is View source, which shows the event
  JSON. Selecting and copying the rendered text loses the structure (code fences, lists,
  links, headings, tables). Copying `body` verbatim is not good enough either: depending on
  the sender it is Markdown source, a lossy plain-text fallback, or plain text with an old
  reply quote prepended. Only `formatted_body` reliably carries the formatting the reader
  saw, so it is converted, once, for every sender, except where the raw event proves that
  `body` is the sender's Markdown (see "The sender's source" above): there the copy is the
  source, so a table typed in Element or sent by an agent through the Rust SDK comes back as
  the table that was written, even though Element itself displays it as pipe text. These are
  deliberate contract changes (2026-10-03 for Element senders, 2026-10-04 for every sender
  and for plain bodies, #24).
- **Evidence:**
  - Unit suites, run against the v1.12.29 tree with entries 1-10 applied: `eventToMarkdown`
    518 tests (including the seeded property test), `MessageContextMenu` 45 tests, 563
    passed, all green; the untouched Edit composer's `serialize` suite (24 tests) passes
    alongside (587 in the three files). The 2026-10-03 sender's-source change added 60
    tests, among them a synthetic message with a GFM table, task boxes, soft breaks and a
    `### 1.` heading whose `formatted_body` is produced in the test by Element's own
    `htmlSerializeFromMdIfNeeded`; the new tests were red against the previous converter.
  - Playwright spec `e2e/element/ew-copy-markdown.spec.mjs` in the siwx-oidc repo (branch
    `feature/ew-copy-markdown`, commit `cdc248e`, unchanged between the two runs below), four
    legs: CM1 position above Pin, CM2 content after an edit, CM3 absent on an image, CM4 plain
    body escaped.
  - **Sender's source (2026-10-03).** The spec gained a fifth leg, CM5 (siwx-oidc branch
    `e2e/ew-copy-markdown-cm5`, commit `40181ab`): a synthetic message with a GFM table, task
    boxes, soft line breaks and a `### 1.` heading is pasted into Element's composer and sent
    through Element's own send path (asserted: encrypted on the wire, `body` equals the typed
    text, `formatted_body` present), then Copy Markdown must return exactly the typed text.
    **Red** against the previous entry 11 image (`2db28d070673`, the one deployed until then):
    CM1-CM4 passed, CM5 failed with the reported symptoms (`\|` rows with a trailing `\`, a
    `\` at each soft break, `\[ \]`, `### 1\.`). **Green** against the image built from this
    commit's patch (`localhost/ew-copy-md:patched6`, id `d16918fd6100`; rule-4 loop 11 `OK`
    against v1.12.29): 5 passed, 0 failed, 0 skipped; `ew-sw-media-auth.spec.mjs` 3 passed.
  - **Algorithm v2, the sender's source on the raw event (2026-10-04).** Unit: `eventToMarkdown`
    1344 tests (246 conformance vectors: 86 source, 7 source with mentions, 137 converter, 16
    escaped), the vectors also in Chromium (249 tests), `MessageContextMenu` 45, `serialize` 24;
    every converter and escaped golden of the first release is byte-identical. Three audits
    (an independent one, a re-audit, and a reduced final one) found and closed: hidden code text
    and CDATA-hidden links (the HTML side now uses its own strict grammar, so no parser
    difference applies), nested reply fallbacks, link reference definitions under GFM, a
    backslash in a link target, HTML5 formatting-element reconstruction, and a quadratic parse
    (`[a](b` repeated took about a minute at 64 KiB; guarded, every 64 KiB shape now under
    250 ms). A differential fuzz in Chromium (about 12,000 accepted inputs) found no text or
    link that the copy carries and Element does not display. Rule-4 loop: 11 `OK`.
    e2e (siwx-oidc branch `e2e/ew-copy-markdown-cm6-cm7`, commit `bcda271`), legs CM6 (Markdown
    sent through the Matrix Rust SDK's `text_markdown`, its real HTML) and CM7 (a plain-body
    Markdown bot): **red** against the previously deployed image (`d16918fd6100`): CM1-CM5
    passed, CM6 and CM7 failed on the clipboard comparison; **green** against the image built
    from this commit's patch (`localhost/ew-copy-md:patched9`, id `fe043135e457`): 7 passed,
    0 failed, 0 skipped; `ew-sw-media-auth.spec.mjs` 3 passed.
  - **Green** (2026-10-03, before the sender's-source change): the image built from the
    first `copy-markdown.patch`
    (`localhost/ew-copy-md:patched4`, id `2db28d070673`, all five files applied cleanly, the
    served i18n JSON carries `copy_markdown`) served by the local stack: 4 passed, 0 failed,
    0 skipped. The regression spec `ew-sw-media-auth.spec.mjs` on the same image: 3 passed.
  - **Red** (2026-10-02), the negative control: the same spec against the baseline image
    (`localhost/ew-copy-md:baseline`, id `34121b8b6331`, v1.12.29 plus entries 1-10, no
    feature): CM1, CM2 and CM4 failed with "the Copy Markdown menu entry is missing", CM3
    (the entry must be absent on an image) passed.
  - **Differential check** (2026-10-03): the converter's output was parsed with commonmark.js,
    markdown-it and markdown-it with `html: true` (281 probe outputs by the orchestrator, 21,521
    by the implementer's wider run): 0 outputs with raw HTML, a link with a scheme Element does
    not permit or a non-`mxc:` image. Two residuals are documented, not fixed: markdown-it
    with `linkify: true` turns visible `//host` text into a link (the text shown is the
    destination), and marked, which is not CommonMark compliant, mis-parses some adversarial
    link labels, code spans and alt text.
- **Upstream status:** **not filed.** No element-hq issue or PR for a copy-as-Markdown action
  exists (searched 2026-10-02). Filing is on hold by maintainer decision (2026-10-03), tracked
  in #27, which also decides whether the 2026-09-01 filing policy above (today it gates
  entries 2, 3 and 4 on #34718) extends to this entry. Rule 3 applies in the meantime: this is an interim carrier, and it becomes UPSTREAM-TRACKED, with
  the vendored patch kept identical to the PR diff, the day it is filed.
- **Retirement:** upstream ships a copy-as-Markdown (or equivalent) message action. The patch
  then fails to apply on the `MessageContextMenu.tsx` hunks or becomes redundant: check, and
  drop it, together with `utils/eventToMarkdown.ts` and the `action.copy_markdown` string.
- **Coverage (rule 2):** Playwright spec `e2e/element/ew-copy-markdown.spec.mjs` (siwx-oidc
  branch `feature/ew-copy-markdown`, CM5 added on `e2e/ew-copy-markdown-cm5`, CM6 and CM7 on
  `e2e/ew-copy-markdown-cm6-cm7`), plus the two vitest suites in the patch and its conformance
  vectors.
- **Potential follow-ups (not scheduled, 2026-10-05):** converter fidelity for crafted HTML,
  an independent audit of the strict grammar, and a Rust SDK port of the rule. Each is
  described in [docs/copy-markdown/README.md](../../docs/copy-markdown/README.md#potential-follow-ups)
  and needs its own go.
- **Related upstream defect:** [element-hq/element-web#35314](https://github.com/element-hq/element-web/issues/35314)
  (filed 2026-10-05, not caused by this patch). The first message context menu after a page
  load is clamped into the window before Pin and Remove are added, so it can open partly
  below the window, and a click on an entry while it is there is lost. The e2e spec works
  around it by settling the menu before it clicks (`settleMenu`); drop that once upstream
  fixes the clamp.

## Runtime-stage deltas (not `.patch` files, still upstream deviations)

| Delta | Where | Why |
|---|---|---|
| `index.html` served no-cache | `config/element-nginx.conf` | stale-bundle TDZ crash prevention ("Your Element is misconfigured") |
| Security headers include | `config/element-nginx-security-headers.inc` | S1 hardening checklist |
| `sw-boot.js` head shim | `config/element-sw-boot.js` + build-time `sed` (fail-loud grep) | service-worker media-auth boot ordering (2026-07-31 download RCA); guard (E)'s canary waits for the app to be `SYNCING` since 2026-09-28, because its probe hit the SW with an expired stored token and triggered the entry-9 poisoning; after 120 s without `SYNCING` it warns and runs anyway (safe with entries 9 and 10). The gate needs `window.mxMatrixClientPeg` in the bundle, which the Dockerfile greps for. Its 8 s timer is coupled to entry 10's 5 s wait |
| Per-build `sw.js` stamp | Dockerfile `RUN` (bundle hash + build UTC) | byte-identical sw.js across deploys let a wedged SW survive every deploy (2026-07-31 incident); stamp forces eviction |
| inblock.io overlay | `config/element-config.json`, theme CSS, logos/favicons, welcome background | branding + deployment config (`force_verification`, `sso_redirect_options.immediate`) |
| Entrypoint templating and `index.html` edits | `entrypoints/element_entrypoint.sh` (runs at every container start) | `%%MATRIX_BASE_URL%%`/`%%MATRIX_HOST%%`/`%%CLIENT_HOST%%` substitution in `config.json` (the `permalink_prefix` key is deleted when `CLIENT_HOST` is empty); copies the inblock.io favicons over Element's `vector-icons/*.png`; injects `<link rel="stylesheet" href="element-theme-overrides.css">` into `index.html` `<head>` (idempotent) |
| Config and entrypoint bind-mounted at runtime | `docker-compose.yml` (`element-web` service, `volumes`) | the running container uses the HOST's `config/element-config.json` (as `/app/config.json.src`) and `entrypoints/element_entrypoint.sh`, not the copies baked into the image, so a config change needs no rebuild. It also means the image digest alone does not describe what a box serves |
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
distinctive string in the webroot of the running dev-staging element-web container:

| # | Patch | Marker grepped in `/app` | Files |
|---|---|---|---|
| 1 | `force-first-device-recovery` | `Set up recovery to continue` | 1 |
| 2 | `setup-encryption-busy-wedge` | `cross-signing not ready` | 2 |
| 3 | `honest-qr-disabled-reason` | `Not supported by your account provider` | 2 |
| 4 | `offer-verify-current-session` | `verify_blocked_current_session_unverified` | 3 |
| 5 | `auto-approve-check-code` | `open_approval_page` | 5 |
| 6 | `browser-eventindex` | `inblock-ew-eventindex` | 2 |

**Row 6's marker is stale for anything built after 2026-09-12.** The regenerated
patch renames the database, so the marker to grep is now `element-eventindex`
(and `feature_web_event_index` for the gate). `inblock-ew-eventindex`,
`feature_inblock_encrypted_search` and `still_indexing` will find nothing in a
build made from the current patch, and finding them instead proves the image is
an OLD one. The row above is left as the record of what was checked on that
artifact.

**Trap for whoever repeats this:** the EventIndex code is emitted into
`bundles/<hash>/init.js`, **not** `bundle.js`. Grepping only `bundle.js` returns zero
hits for every EventIndex marker and looks exactly like "the patch is missing". Search
the whole webroot.
