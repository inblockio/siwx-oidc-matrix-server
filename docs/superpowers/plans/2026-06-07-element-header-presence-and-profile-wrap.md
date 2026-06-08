# Plan: Element header online-dot green + profile MXID wrap/copy (2026-06-07)

Two front-end fixes for `element.inblock.io`, both resolving to **CSS-only** edits in
the baked `config/element-theme-overrides.css` (no source patch, no theme-JSON change).

## Context / findings (verified, not assumed)

**Deployment state (task 1 step 1 — already answered):** the prior "online dot"
refactor (`4a3d434`, merged 2026-06-04, which *removed* the green override on the
premise the dot is "green by construction") **IS deployed.** Production `element-web`
runs `:main` built `2026-06-07T01:06`; served `element-theme-overrides.css` has the
tab-label rule and **no** `mx_PresenceIconView_online` rule. So this is **case 3**:
deployed, yet the room-header dot is still orange — the "green by construction" claim
was incomplete.

**Three presence render paths in element-web v1.12.20 (all read from source + live bundle):**

| Path | Component | Color source | Result |
|---|---|---|---|
| Member list | `PresenceIconView` (`_PresenceIconView.pcss:20`) | `color: var(--cpd-color-icon-accent-primary)` | green by construction |
| Sidebar DM avatar | `RoomAvatarView` (`RoomAvatarView.tsx:64-72`) | inline `color="var(--cpd-color-icon-accent-primary)"` | green by construction |
| **Room header DM avatar** | `WithPresenceIndicator` (`RoomHeader.tsx:465`, `_WithPresenceIndicator.pcss:35`) | `::before { background-color: $accent }` → custom-theme compiles `$accent`→`var(--cpd-color-text-action-accent)` = **`#E8611A`** | **orange** |

`WithPresenceIndicator` renders **only** in the room header. Built-in Element themes
compile `$accent`→`#0dbd8b` (green), so this only breaks because *our* brand accent is
orange. It is a compiled-SCSS-literal value theme JSON cannot reach — the same class of
fix as the existing settings-tab-label rule.

**Task 2 collapse:** `UserInfoHeaderView.tsx:86-89` **already** wraps the MXID in
Element-native `<CopyableText>` — the clipboard copy button already exists in v1.12.20.
It is merely pushed out of view: `.mx_UserInfo_profile_mxid` is fixed at `height:28px`
and `.mx_CopyableText` is `width:max-content` with no `overflow-wrap`, so the unbroken
`0x…` hex run overflows the panel. **No source patch needed** — a CSS wrap fix brings the
existing copy button into view. (The copy button is `flex-shrink:0; position:sticky`, so
it stays reachable as the MXID wraps to multiple lines.)

## Hypothesis Register

| ID | If | Then | Assumptions | Verification |
|----|-----|------|-------------|--------------|
| H1 | inspect deployed `:main` element-web | refactor `4a3d434` is live (tab rule present, no PresenceIconView rule) | SSH read-only access | **CONFIRMED**: served override CSS grep (tab=2, presence=0); image built post-merge |
| H2 | header dot is `WithPresenceIndicator ::before{background-color:$accent}`, `$accent`→`text-action-accent`=#E8611A, sidebar/member use `icon-accent-primary` | header renders orange, sidebar/member green | custom-theme `$accent` mapping holds on v1.12.20 | **CONFIRMED**: live bundle custom-theme rule reads `text-action-accent`; source for the other two |
| H3 | add `.mx_WithPresenceIndicator_icon_online::before{background-color:var(--cpd-color-icon-accent-primary)!important}` to override CSS | header dot turns green, matching sidebar; brand accents + away/busy/offline unchanged | `!important` beats non-important bundle rule; component is header-only | served CSS has rule; **human visual gate**: green header dot, away/busy/offline + links/buttons unchanged |
| H4 | `UserInfoHeaderView.tsx:87` wraps MXID in `<CopyableText>` | copy button already exists; no patch needed | v1.12.20 source as cloned | **CONFIRMED**: source read |
| H5 | free `.mx_UserInfo_profile_mxid` height + `overflow-wrap:anywhere` on its `.mx_CopyableText` | long MXID wraps inside panel; native copy button reachable | `overflow-wrap:anywhere` shrinks the anonymous text flex item's min-content | served CSS has rule; **human visual gate**: full MXID wraps within panel, copy icon visible |
| H6 | update `verify-theme.sh` + `verify-deployment.sh` (require WithPresenceIndicator rule + profile wrap rule; keep forbidding PresenceIconView rule) | guards pass on new CSS; `--self-test` still catches a bad theme | jq present | `./verify-theme.sh` exit 0; `./verify-theme.sh --self-test` exit 0 |
| H7 | merge to main, push, CI builds `:main`, `deploy.sh main --build --restart` | rebuilt image bakes the new override CSS; live served CSS satisfies H3/H5 | CI healthy; watchtower/deploy access | `verify-deployment.sh` [5] passes against live |

## Acceptance Criteria

| # | Criterion | Hyp |
|---|----------|-----|
| AC1 | Room-header online presence dot is GREEN (matches sidebar) | H2,H3,H7 |
| AC2 | No regression: brand-orange links/buttons, away/busy/offline dots, sidebar/member dots unchanged | H3 |
| AC3 | Profile panel: long DID/wallet MXID wraps fully inside the panel (no overflow past wrapper) | H5,H7 |
| AC4 | Clipboard copy button present at the MXID and usable | H4,H5 |
| AC5 | `verify-theme.sh` + `verify-deployment.sh` encode regression guards for AC1/AC3 | H6 |
| AC6 | `docs/element-theme-customization.md` corrected to the 3-path model | — |
| AC7 | Deployed to production and verified live | H7 |

## Tasks (branch `fix/element-header-presence-and-profile-wrap`)

- **Task A** [H3,H5] — `config/element-theme-overrides.css`: add the room-header online-dot
  rule and the profile-MXID wrap rules; rewrite the header comment to the 3-path model.
- **Task B** [H6] — `verify-theme.sh`: require `mx_WithPresenceIndicator_icon_online` +
  the profile wrap rule; keep forbidding `mx_PresenceIconView_online`. Run it + `--self-test`.
- **Task C** [H6] — `verify-deployment.sh` [5]: mirror the new served-CSS assertions.
- **Task D** [AC6] — `docs/element-theme-customization.md`: correct the mental model
  (3 paths; header path routes through `$accent`/`text-action-accent`), ownership row,
  references.
- **Task E** [H7] — staged commits; merge to main; **push (gated)**; CI build; deploy
  `./deploy.sh main --build --restart`; run `verify-deployment.sh`; request human visual gate.

## Execution note

Tasks A–D are ~60 lines across four tightly-coupled files (the CSS rule that the guard
asserts that the doc describes). They are implemented directly with staged commits rather
than fanned out to subagents (coordination overhead would exceed the work). Parallel
agents are reserved for **Phase 3 AUDIT** (independent adversarial verification), where
divergent perspectives add real value.

## Deploy / verification discipline

- `element-theme-overrides.css` is **baked into the image** → a CI rebuild + `--build`
  redeploy is mandatory (a restart alone won't pick it up).
- Push to origin/main + production deploy are **outward-facing** → gated on explicit
  user go-ahead.
- Final correctness for AC1/AC3/AC4 uses the project's established **human visual gate**
  (same as `docs/element-theme-customization.md` verification step 4), since login is
  OIDC-gated and the change is purely visual.

## Phase 3 — Audit trace (2026-06-07)

Three parallel adversarial auditors (Explore agents) tried to refute correctness
against the v1.12.20 clone + the live bundle rules. All returned **confirmed**.

| ID | Status | Evidence |
|----|--------|----------|
| H1 | Confirmed | SSH: served override CSS has tab rule, no PresenceIconView rule; image built post-merge |
| H2 | Confirmed | live bundle: custom-theme `WithPresenceIndicator_icon_online::before` reads `text-action-accent` (#E8611A); other two paths read `icon-accent-primary` (green) |
| H3 | Confirmed (code) | cascade audit: `!important` beats the non-important bundle rule at equal specificity; `icon-accent-primary` unoverridden→green; only ONE other rule targets the selector. Live visual gate pending |
| H4 | Confirmed | source: `UserInfoHeaderView.tsx:87` already wraps MXID in native `CopyableText` |
| H5 | Confirmed (code) | flex audit: `overflow-wrap:anywhere` shrinks the anonymous text item's min-content→wraps; `height:auto !important` beats `28px`; `width:100%` makes it deterministic. Live visual gate pending |
| H6 | Confirmed | `./verify-theme.sh` 6/6 + `--self-test` OK; `verify-deployment.sh` syntax + stdin-strip simulation OK; awk multi-line comment strip tested |
| H7 | Pending | deploy + `verify-deployment.sh` against live |

**Acceptance criteria:** AC1 code-confirmed (live pending), AC2 confirmed (away/busy/
offline use separate classes; `text-action-accent` unchanged so brand links/buttons
intact; `WithPresenceIndicator` is header-only; profile selector scoped 0,3,0 matches
only the intended MXID), AC3 code-confirmed (live pending), AC4 confirmed (native copy
button), AC5 confirmed, AC6 confirmed. AC7 pending deploy.

**Auditor minors actioned:** added explicit `width:100%` (deterministic wrap). Left as
Element-intended: button centered vertically + non-sticky in this view (minimal override
surface; reachability unaffected).
