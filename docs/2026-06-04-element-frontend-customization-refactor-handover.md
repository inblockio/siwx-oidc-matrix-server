# Handover: refactor the Element front-end customization (review of 4 commits)

> **RESOLVED 2026-06-04.** The refactor is done; see
> `docs/element-theme-customization.md` for the outcome and contract. The
> central premise below (that `colors.accent-color` regenerates the green scale,
> requiring ~20 pinned tokens) was **disproved against the v1.12.20 source**:
> there is no accent-to-green regeneration, the online dot is green by
> construction, and the fix was to remove pins, not add them. The dead theme
> files were deleted, the inblock.io compound maps collapsed (20 -> 14 tokens),
> the `4beb281` stopgap and the online-dot CSS rule removed, and a regression
> guard (`verify-theme.sh`) added. Kept below for history.

Date: 2026-06-04
Branch: `fix/element-success-icon-token` (holds the stopgap + both handovers)
Companion doc: `docs/2026-06-04-element-theme-color-strategy-handover.md` (deep dive on the
color mechanism). This document is the broader, commit-level review.
Skill to load first: `/matrix-custom-themes-specialist`

## Status of the prior task (confirmed done)

"Implement step 1-2 on a branch, then write a handover" is complete:

- Stopgap fix `4beb281` on this branch: adds `--cpd-color-icon-success-primary: #16a34a`
  to the inline `inblock.io Dark` + `Light` themes. Verified static (JSON valid, token
  present, valid Compound token). NOT visually confirmed (needs a 1.12.20 instance), NOT
  merged, NOT pushed, NOT deployed.
- First handover `f2446bb`: `docs/2026-06-04-element-theme-color-strategy-handover.md`.

## Your mission

Look at the **whole** Element front-end customization as it accreted across these commits
and answer: knowing the end state now, what is the clean version? Produce a refactor plan
(or do the refactor). Decide whether the `4beb281` stopgap survives, folds into the
refactor, or is replaced.

## The 4 front-end commits (how it accreted)

| Commit | What it added | Files |
|---|---|---|
| `0907ea9` | Pre-load 3 custom themes (inblock.io Dark default, Light, Nord) | `element-config.json` inline `custom_themes` (+137 lines) AND standalone `theme-nord-dark.json` |
| `c996f35` | Light-theme selected-item contrast tweaks | `element-config.json` AND `theme-inblockio-light.json` (BOTH copies edited) |
| `7b14141` | Green online dot + readable settings-tab label | new `element-theme-overrides.css` (injected CSS) + `element_entrypoint.sh` injection |
| `4beb281` | Pin `icon-success-primary` green (the stopgap) | `element-config.json` inline only |

The history shows the accretion: themes added two ways at once, then a CSS side-channel
bolted on, then a one-token patch. Nobody stepped back. That is what this session fixes.

## Current architecture: three overlapping mechanisms (one is dead)

1. **Inline `custom_themes` in `config/element-config.json`** — the ACTUAL loaded themes.
   Each has a `colors` map (legacy Element keys) plus a `compound` map hand-pinning ~20
   `--cpd-*` tokens. This is what production renders.

2. **Standalone `config/theme-*.json`** (`theme-inblockio-dark.json`,
   `theme-inblockio-light.json`, `theme-nord-dark.json`) — DEAD DUPLICATES. They define the
   same three themes by name, but are referenced **nowhere** (not in `element-config.json`,
   `element_entrypoint.sh`, `Dockerfile.element`, or any compose file) and are **not even
   COPY'd into the image**. They have already drifted: `c996f35` edited both copies, but
   `7b14141` and `4beb281` edited only the inline copy, so the standalone files are now
   stale. This is live double-maintenance debt with a drift trap.

3. **`config/element-theme-overrides.css`** — a CSS side-channel for what the theme JSON
   cannot reach. Two rules: route the online presence dot to the success token, and restore
   a readable settings-tab label. Wired by `Dockerfile.element` (`COPY ... /app/`) plus an
   idempotent `sed` in `element_entrypoint.sh` that injects `<link ...>` into `index.html`.

## Why this needs a refactor (the smells)

- **Dead duplicate theme files (mechanism 2).** Two sources of truth for the same themes;
  one is unreferenced and already stale. Pure drift hazard.
- **Fighting the framework.** In Compound the brand accent IS the green color scale. Setting
  `accent-color: #E8611A` regenerates `--cpd-color-green-*` to orange at runtime, which
  bleeds orange into success + the online dot. The current response is to hand-pin ~20
  tokens back per theme (whack-a-mole). We only just found `icon-success-primary` was
  missing; the list is incomplete by construction. See the companion color-strategy doc for
  the full mechanism and proof.
- **Two patch layers, unclear ownership.** The `compound` map and the injected CSS both
  correct color, with no documented contract for which owns palette vs. component routing.
- **Version-fragile, unguarded.** The presence-dot rule was authored on Element 1.12.18 and
  silently broke when prod moved to 1.12.20 the next day. No test caught it. A future Element
  bump can regress this again with zero signal.

## Refactor directions (knowing what we know now)

Evaluate, do not assume. Run the key experiment before committing to A.

- **A. Single source of truth.** Delete the dead `config/theme-*.json` files (or, if a file
  layout is preferred, generate the inline `custom_themes` from them at build time so there
  is exactly one authored copy). Pick one mechanism.
- **B. Decouple brand accent from the green scale (primary hypothesis).** Hypothesis: the
  orange bleed comes from the legacy `colors.accent-color` key forcing a full green-scale
  regeneration. If we drop `accent-color`/`primary-color` and instead set ONLY the genuine
  brand-accent tokens orange in `compound`, the green scale stays green, and success + the
  online dot are green for free, with no per-token pinning. This collapses ~20 pins to a
  short accent set and removes the "forgot to pin X" bug class (global CLAUDE.md complexity
  collapse rule). KEY EXPERIMENT: on a 1.12.20 instance, remove `accent-color` and check in
  DevTools whether `getComputedStyle(document.documentElement).getPropertyValue(
  '--cpd-color-green-900')` stays green.
- **C. Define ownership.** Theme JSON owns the palette; the CSS override owns component-level
  semantic routing (e.g. "the online dot reads as success, not accent"). Document the
  contract so the next Element bump has a checklist. After B, re-evaluate whether the CSS
  override and its entrypoint injection are still needed at all, or shrink to only the rules
  the theme JSON genuinely cannot express.
- **D. Regression guard (do regardless of A/B/C).** Extend `verify-deployment.sh` (or add a
  small Playwright probe) to assert the served theme keeps success / the online dot green, so
  a version bump cannot silently regress it.

## Acceptance criteria for the refactored front-end

- Exactly one authored source per theme (no dead/duplicate theme files).
- Far fewer hand-pinned tokens than today's 20; semantic colors (success green, critical red)
  correct without babysitting.
- Clear, documented ownership: palette vs. component routing.
- Survives an Element version bump without silent color regressions (guarded by a test).
- Light, Dark, and Nord all correct (Nord has a green accent, so it never showed the bug and
  is the natural control case).
- The `4beb281` stopgap is either unnecessary (subsumed by B) or kept as a deliberate,
  documented routing rule.

## Reference

Files:
- `config/element-config.json` (inline `custom_themes`: `colors` + `compound`) — live
- `config/theme-inblockio-dark.json`, `theme-inblockio-light.json`, `theme-nord-dark.json` — DEAD duplicates
- `config/element-theme-overrides.css` — injected CSS side-channel
- `entrypoints/element_entrypoint.sh` (line ~24: the `<link>` injection)
- `dockerfiles/Dockerfile.element` (line ~59: `COPY ... element-theme-overrides.css`)
- `docs/superpowers/plans/2026-05-23-custom-themes-implementation.md`

Commits: `0907ea9`, `c996f35`, `7b14141`, `4beb281` (this branch).

Deploy reality (see repo CLAUDE.md "Build and deployment model"): images are CI-built and
published to GHCR; prod is `agentic.inblock.io` running `:main`; `config/element-config.json`
is bind-mounted, so theme edits apply on an `element-web` restart with no image rebuild. The
definitive visual check (does the green scale go orange) needs DevTools on a logged-in
1.12.20 session, since the regeneration is client-side. Push and prod deploy require explicit
user authorization.
