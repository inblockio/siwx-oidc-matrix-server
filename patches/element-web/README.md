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
     **One sanctioned exception exists today** (Tim, 2026-09-13): entry 6's vendored
     patch deliberately LEADS PR #34718 by the non-blocking-load work, because prod
     needed that before upstream was ready to receive it. A deliberate lead is only
     allowed when it is (a) recorded in the entry, (b) pinned to a named provenance
     commit on a branch of our fork, and (c) carries a stated condition for closing
     the gap. Unrecorded drift is still forbidden — that is the whole point of the
     rule.
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

**Updated 2026-09-13: all EIGHT patches are now live on `element.inblock.io`.**
Entries 7 and 8 (added 2026-09-11) reached prod with this promotion, and entry 6
is there in its **non-blocking labs-flag form**. Verified against the deployed
artifact `element-web@sha256:785ab46c…`, label
`org.opencontainers.image.revision=f933e7b`, and against the config prod
actually serves (`https://element.inblock.io/config.json` →
`features.feature_web_event_index: true`). Previous prod artifact, and the
rollback target for this promotion: `element-web@sha256:d7ba8b7b…`, `rev=60b037b`.
Synapse was deliberately **not** restarted (`up -d --no-deps element-web`); its
container has been up since 2026-08-31.

| # | Patch | Purpose | Active on prod |
|---|---|---|---|
| 1 | `force-first-device-recovery` | Makes 4S recovery-key setup **mandatory on the first device**, so every later device has cross-signing secrets to join against. Deployment policy, permanent. | yes, ungated |
| 2 | `setup-encryption-busy-wedge` | Recovers from an upstream post-verification `Phase.Busy` dead end that is indistinguishable from "verification failed" to the user. | yes, ungated |
| 3 | `honest-qr-disabled-reason` | When "Show QR code" is blocked by **this session's own** crypto state, stop reporting it as the account provider not supporting device link. The stock string is simply false for us and hides the actual remedy. | yes, ungated |
| 4 | `offer-verify-current-session` | `DeviceVerificationStatusCard` gave an unverified **current** session a card with no action and no reason, leaving the destructive identity reset as the only visible exit. | yes, ungated |
| 5 | `auto-approve-check-code` | MSC4108 QR device-link check-code auto-approves once both digits are typed. The deliberate read-and-type is the security property; the extra confirm click is not. | yes, ungated |
| 6 | `browser-eventindex` | A `BrowserEventIndexManager` implementing `BaseEventIndexManager` so E2EE room search works in hosted Element Web, with a **non-blocking** load so a large index cannot delay app start, bounded crawl/memory/disk budgets, a chunked encrypted store, and a streamed cold scan for what is on disk outside the resident window. Upstream PR #34718 plus increments A, B, C, D-core and E, which lead it. | **yes, via `features.feature_web_event_index: true`** (renamed on prod 2026-09-13) |

Entry 6 is the only gated one. **Its gate is now the same everywhere**, which it
was not before 2026-09-13:

```
feature_web_event_index === true   -> ON (config.json `features`, or per-device in Labs)
feature_web_event_index === false  -> off
feature_web_event_index unset      -> OFF. There is no hostname fallback any more.
```

Both `element.inblock.io` and `dev.element.inblock.io` set the key to `true` in
their bind-mounted `config/element-config.json`, so both are ON by the same
explicit mechanism. `feature_inblock_encrypted_search` is dead: nothing reads it,
and it has been removed from prod's config.

**The history matters if you read older notes.** Until 2026-09-13 the two hosts
were on by *different* mechanisms — prod by an explicit
`feature_inblock_encrypted_search: true`, dev-staging by the patch's
`STAGING_HOSTS` hostname fallback with no key set at all. Both the old key and
the hostname allowlist are gone from the patch. So any comment claiming this
feature is "dev-staging only", or "gated off on the production hostname",
describes a gate that no longer exists and was already wrong about prod as
configured.

## Which Dockerfile applies what

**One Dockerfile, all eight patches.** `dockerfiles/Dockerfile.element` on `main`
applies every numbered patch below, in this file's order. Entries 7
(`show-attested-did`) and 8 (`resolve-did-search`) were added 2026-09-11 and are
the newest; entries 1-6 are the set the paragraphs below describe. **8 depends on
7** and must stay after it — see its Order note.

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
- **Evidence:** `docs/2026-08-14-HANDOVER-encrypted-search-browser-eventindex.md`;
  audit `docs/audits/2026-08-14-encrypted-search-eventindex-audit.md`
  (staging UX1–UX8 + prod promotion 2026-08-15). Both predate the labs-flag
  and schema-v2 rework and describe the hostname gate and the
  `inblock-ew-eventindex` database; read them as the record of why the
  feature exists, not of how it is gated today.
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
- **NOW CARRIES THE NON-BLOCKING LOAD, AHEAD OF UPSTREAM (Tim's decision,
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
    recorded in the EventIndex bounded-memory ruling (memory
    `event-index-bounded-memory-design`: ~0.18 ms/event of startup decryption,
    not memory, is what hurts). Hydration now runs in the background behind a
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
    load-bearing by isolated mutation:
    `~/handovers/2026-09-12-element-web-eventindex/research/review-pr-a.md`;
    proof numbers in the sibling `measurements-pr-a.md`. Re-run on the
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
  - **Evidence:** reviews **SHIP** after several rounds —
    `~/handovers/2026-09-12-element-web-eventindex/research/review-pr-b.md` and
    `review-pr-c.md` (C took five passes; final SHIP at `af6fec256c`), proofs in
    `measurements-pr-b.md` and `measurements-pr-c.md`. Gates re-run on the
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
       window and room cap, exactly as the first enablement was (Tim's original
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
  - **Evidence:** reviews **SHIP** —
    `~/handovers/2026-09-12-element-web-eventindex/research/review-pr-d.md` (four
    sections, D-core SHIP at `2c04b3b562`) and `review-pr-e.md` (four sections,
    E-core SHIP at `c61dba1135`, both HIGH findings of the previous round verified
    fixed in both directions), proofs in `measurements-pr-d.md` and
    `measurements-pr-e.md`. Gates re-run **on the integration branch itself**:
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
  while testing, and Tim replied suspecting a federation delivery problem on his
  side. That is the SAME symptom class as the MSC4284 policy-server refusal
  tracked in memory `policyserv-blocks-did-mxids` (our sends to policy-server
  rooms are refused with a bare 400). If a reviewer cannot see test messages,
  they cannot evaluate a *search* feature — so unblocking the federation issue
  may be on the critical path to this merge. Unproven link; check it before
  assuming.
- **DEPLOYMENT ACTION DISCHARGED, 2026-09-13.** This entry previously carried a
  "DEPLOYMENT ACTION OUTSTANDING" warning: the patch had stopped reading
  `features.feature_inblock_encrypted_search` while prod's bind-mounted config
  still set only that key, so promoting the image without renaming the key would
  have shipped encrypted search **off on prod**. Both halves have now landed
  together. Prod's `/home/deploy/matrix/stack/config/element-config.json` was
  rewritten **in place, inode 559991 preserved** (a single-file bind mount
  follows the inode), a one-line diff renaming the key to
  `feature_web_event_index: true`, and the element container was switched in the
  same window. Verified on the served artifact, not just on disk:
  `https://element.inblock.io/config.json` reports the new key and no old one.
  To turn the feature off now, set that key to `false` or remove it — with the
  hostname fallback gone, removing it means off by design rather than off by
  accident.
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
  world-readable and provider-owned); `docs/2026-09-10-HANDOVER-attested-did-complete.md`.
- **Upstream status:** not upstreamable as-is — `io.inblock.did` is OUR field name, and
  upstream would need a generic custom-profile-field UI (or MSC4133 field registration)
  before anything like this could land. If upstream ships generic custom-field
  rendering, this patch should be **dropped**, not ported.
- **Retirement:** upstream renders custom profile fields generically, OR the
  `io.inblock.did` contract is retired.
- **Order:** applied LAST in `Dockerfile.element`. Its `en_EN.json` hunk was generated
  against the tree with entries 1-6 already applied; moving it earlier breaks that hunk.
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
- **What a pinned-server match proves — read this before trusting one.** What makes
  `io.inblock.did` trustworthy is that the homeserver hosting it refuses a write to it
  from its own subject, which is `patches/synapse/`'s write-ACL backport. That holds for
  our own server by construction and for a peer **exactly when the peer runs this stack**
  (ruling, Tim, 2026-09-11: a peer that publishes our field is running our provider, and
  in practice therefore our whole stack). A peer that does not is free to let its users
  write any DID into their own profile, so a pinned-server result is only as good as that
  server. This patch reads the field; it does NOT verify the ES256 proof beside it, which
  is what would make a result self-supporting rather than server-supporting. The verifier
  already exists (`siwx-oidc-auth`'s `fetch_and_verify_did`) — porting it into the client
  is the upgrade path if a peer outside the stack ever has to be trusted, and nothing here
  should be read as already having done it.
- **Deliberate limits:** only accounts that have published the field are findable — an
  account that has not signed in since publication started is not findable, and becomes
  findable by itself with no migration, because siwx-oidc re-asserts the field on every
  sign-in. The derivation is also our provider's, so a homeserver running this build with
  a different identity provider will not place its users where this computes. Typing a DID
  and pressing enter in the invite dialog does not convert it to a target
  (`convertFilter` is synchronous and resolution is not); the resolved suggestion must be
  clicked.
- **One upstream behaviour change beyond the DID path:** Spotlight's profile lookup is
  gated on `filter === Filter.People`, which is right for an MXID but would hide the only
  result a DID has, so the gate is widened by `|| looksLikeDid(trimmedQuery)`. MXIDs keep
  upstream's behaviour exactly.
- **Failure behaviour:** never throws. No extended-profile support, no such user, an
  absent or malformed field, a network error — all resolve to "no result", and a DID that
  names nobody is reported as a successful empty search, not an error.
- **Evidence:** the live dev probe behind it — `user_directory_search` holds only
  `@user:server` plus the display name; `MXID_LOCALPART_ALLOWED_CHARACTERS` read out of
  the running 1.159.0; and a full round trip `did:pkh:…0x5177…` →
  `@4pkgegvyqk1xk48d:dev.matrix.inblock.io` → the published `{did, proof}`.
- **Upstream status:** not upstreamable as-is, for the same reason as entry 7 —
  `io.inblock.did` and the localpart derivation are both ours.
- **Retirement:** the `io.inblock.did` contract is retired, OR siwx-oidc grows a
  server-side resolver endpoint (`GET /resolve?did=…`) that this can call instead of
  mirroring the derivation, which would delete the mirror and its drift risk entirely.
  **That is the preferred end state**; the mirror exists because no such endpoint does yet.
- **Order:** applied AFTER entry 7 and depends on it. It moves `DID_PROFILE_FIELD` out of
  `useAttestedDid.ts` into `utils/didLocalpart.ts` and rewrites that line into a
  re-export, so dropping 7 or swapping the two fails the build.
- **Coverage:** `didLocalpart.test.ts` ships inside the patch (14 vitest cases: the pinned
  vectors, the pkh/key case rules, shape, no-DID-leak, the legacy shape, the
  `looksLikeDid` boundary, and `parseDidQuery` — bare vs pinned, a `did:pkh` whose own id
  carries colons, a port, malformed/empty servers, and the two-`@` case that must not
  smuggle a server through). Verified locally against v1.12.26 with all eight patches
  applied: 42/42 across the new file plus the existing `useProfileInfo` and `InviteDialog`
  suites, plus a live round trip on dev for the bare, `@own-server` and `@remote` forms. No `e2e/element/` leg yet — like entry 7 it needs a lab account with a published
  DID, and the two legs should be written together.

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

**Row 6's marker is stale for anything built after 2026-09-12.** The regenerated
patch renames the database, so the marker to grep is now `element-eventindex`
(and `feature_web_event_index` for the gate). `inblock-ew-eventindex`,
`feature_inblock_encrypted_search` and `still_indexing` will find nothing in a
build made from the current patch, and finding them instead proves the image is
an OLD one. The row above is left as the record of what was checked on the
artifact that is still serving prod.

**Trap for whoever repeats this:** the EventIndex code is emitted into
`bundles/<hash>/init.js`, **not** `bundle.js`. Grepping only `bundle.js` returns zero
hits for every EventIndex marker and looks exactly like "the patch is missing". Search
the whole webroot.
