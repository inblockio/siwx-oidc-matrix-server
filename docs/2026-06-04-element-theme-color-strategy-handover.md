# Handover: rethink the Element custom-theme color strategy

Date: 2026-06-04
Branch in flight: `fix/element-success-icon-token` (commit `4beb281`, NOT merged, NOT deployed)
Skill to load first: `/matrix-custom-themes-specialist`

## Your mission

A point fix for "online presence dot renders orange instead of green" is sitting on a
branch. It works, but it is the latest in a series of per-token patches. Step back and
look at the **whole** custom-theme color scheme, then answer one question:

> Is there a simpler refactor that achieves the same goal (inblock.io brand orange for
> brand surfaces, correct semantic colors everywhere else) with a cleaner, more
> version-robust approach?

Do not just rubber-stamp the point fix. Decide whether to keep it as a stopgap, fold it
into a cleaner design, or replace the whole approach.

## TL;DR of the current state

- Production is `agentic.inblock.io`, stack at `/home/deploy/matrix/stack`, images
  `ghcr.io/inblockio/...:main` (CI-built, watchtower auto-pulls). Element is **built from
  source at v1.12.20** with the force-first-device-recovery patch. `config/element-config.json`
  is **bind-mounted** on prod, so theme changes apply on an `element-web` restart, no image
  rebuild.
- The orange-dot bug is NOT a deploy gap. The `7b14141` fix is live and served correctly.
  It is simply ineffective against v1.12.20's theming. See root cause below.
- The branch adds one token to fix it (stopgap). The strategic rethink is this session.

## Root cause (the load-bearing insight)

In Element's Compound design tokens, **the brand accent IS the green color scale.** Both
of these resolve to the same underlying scale value:

```
--cpd-color-icon-accent-primary  : var(--cpd-color-green-900)   <- stock online-dot color
--cpd-color-icon-success-primary : var(--cpd-color-green-900)   <- what 7b14141 switched to
```

Our themes set `accent-color: #E8611A` (legacy `colors` key). At runtime Element
**regenerates the entire `--cpd-color-green-*` palette from that accent**, so `green-900`
becomes an orange shade. Therefore BOTH `icon-accent-primary` and `icon-success-primary`
turn orange. The `7b14141` fix swapped the dot from the accent token to the success token
believing they were independent greens; they are the same regenerated scale, so it could
never escape orange.

Proof (deductive, airtight): the stock dot uses `accent-primary` and renders orange, so
`green-900` resolves to orange at runtime; `success-primary` is the same `green-900`, so it
is orange too.

## Current strategy and why it smells

There are **two overlapping patch mechanisms** both correcting color:

1. `config/element-config.json` -> each custom theme's `compound` map. This hand-pins
   **20 Compound tokens** back to intended values (orange for brand surfaces, green for
   success, red for critical, greys for icons/text). The branch just bumped this from 19 to
   20 by adding `--cpd-color-icon-success-primary: #16a34a`. The full Dark list is in the
   commit / in the file at lines ~49-69.
2. `config/element-theme-overrides.css` (injected into `index.html` by
   `entrypoints/element_entrypoint.sh`). This file routes the online dot to the success
   token and fixes the settings-tab label:
   ```css
   .mx_PresenceIconView_online,
   .mx_RoomAvatarView_PresenceDecoration[aria-label="Online"] {
       color: var(--cpd-color-icon-success-primary) !important;
   }
   ```

Smells:

- **Whack-a-mole.** The list is hand-maintained and incomplete by construction. We only just
  discovered `icon-success-primary` was missing; other success/semantic icon or border
  tokens may also be silently orange. Nobody can tell by reading the file what is still wrong.
- **Version-fragile.** The presence-dot assumption was authored against Element **1.12.18**
  and silently broke when prod moved to **1.12.20** the next day (which token a component
  reads can change between versions). No regression caught it.
- **Two mechanisms, unclear ownership.** Theme JSON `compound` and the injected CSS both
  patch color. Which owns palette vs. semantic routing is not defined anywhere.
- **Inverted default.** The approach is "regenerate everything to orange via `accent-color`,
  then pin the non-orange tokens back." That fights the framework instead of using it.

## Candidate cleaner approaches (evaluate, do not assume)

### A. Stop regenerating the green scale; positively paint only brand surfaces (primary hypothesis)

Hypothesis: the orange bleed comes from the legacy `colors.accent-color` key forcing a
full `--cpd-color-green-*` regeneration. If we **drop `accent-color`/`primary-color`** from
`colors` and instead set ONLY the genuine brand-accent tokens to orange in `compound`
(`bg-action-primary-rest`, `bg-accent-rest`, `text-action-accent`, `icon-accent-primary`,
`border-interactive-primary`, link tokens, etc.), then the green scale stays real green,
and success + the online dot are green **by default with zero pinning**.

Key experiment to run first: on a 1.12.20 instance, remove `accent-color` and observe
whether `--cpd-color-green-900` stays green at runtime (DevTools: computed style of a
`.mx_PresenceIconView_online`, or `getComputedStyle(document.documentElement)
.getPropertyValue('--cpd-color-green-900')`). If yes, this collapses ~20 pinned tokens to a
handful of accent tokens and removes the whole "forgot to pin X" bug class. This is the
complexity-collapse candidate (see global CLAUDE.md "complexity collapse rule").

Note the accent/dot conflict to design around: call buttons and the online dot both use the
accent family, but we want buttons orange and the dot green. The CSS override (route
`mx_PresenceIconView_online` -> `icon-success-primary`) is the right tool to split them, and
under approach A `icon-success-primary` is green for free. So the override likely stays, but
the per-success-token pins in the theme JSON can probably be deleted.

### B. Consolidate to one mechanism with clear ownership

Define explicitly: theme JSON `compound` owns the **palette**; the injected CSS owns
**semantic component routing** (e.g. "the online dot reads as success, not accent"). Or fold
both into one. Document the contract so the next version bump has a checklist.

### C. Use Compound's intended theming surface

Check whether Element/Compound v1.12.20 exposes a cleaner custom-theme API (a design-tokens
override) that separates palette from semantic tokens, rather than the legacy `colors` +
ad-hoc `compound` map. `/matrix-custom-themes-specialist` and
`docs/superpowers/plans/2026-05-23-custom-themes-implementation.md` are the starting points.

### D. Regression guard (do this regardless of A/B/C)

Add a check to `verify-deployment.sh` (or a small Playwright probe) that asserts the served
theme keeps success / the online dot green, so a future Element bump cannot silently regress
this again. This directly addresses the failure mode that caused this bug.

## Acceptance criteria for a better strategy

- Fewer hand-pinned tokens than today (20), ideally a short, self-explanatory accent set.
- Semantic colors (success green, critical red) are correct without per-token babysitting.
- Survives an Element version bump without silent color regressions (guarded by a test).
- One clear owner per concern (palette vs. component routing), documented.
- Light, Dark, and Nord all correct. (Nord has a green accent so it never showed the bug;
  it is the natural control case.)

## Immediate state and decision for this session

- Stopgap branch `fix/element-success-icon-token` (`4beb281`) adds
  `--cpd-color-icon-success-primary: #16a34a` to inblock.io Dark + Light. Verified: JSON
  valid, token present in both, valid Compound token. NOT visually confirmed (needs a
  1.12.20 instance), NOT merged, NOT pushed, NOT deployed.
- Decide: (a) deploy the stopgap now for an immediate green dot, then refactor; or
  (b) refactor directly and let the cleaner change supersede the stopgap. Either way, prod
  deploy + push require explicit user authorization (per global CLAUDE.md).

## Reference

Files:
- `config/element-config.json` (custom_themes: colors + compound maps)
- `config/element-theme-overrides.css` (injected presence + tab-label CSS)
- `entrypoints/element_entrypoint.sh` (injects the CSS link, templates config)
- `dockerfiles/Dockerfile.element` (source build, `ARG ELEMENT_WEB_TAG=v1.12.20`)
- `docs/superpowers/plans/2026-05-23-custom-themes-implementation.md`
- `docs/element-web-source-build.md`

Relevant commits:
- `7b14141` original green-dot + tab-label fix (the false-premise one)
- `0907ea9` preload custom themes; `c996f35` light-theme contrast
- `4beb281` this stopgap

Read-only prod diagnosis recipe (reproduces the whole finding):
```bash
ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io
# what is live:
cd /home/deploy/matrix/stack && git log -1 --oneline && docker compose ps
# Element version + served theme assets:
docker exec matrix-element-web-1 sh -c 'cat /app/version'
curl -sS -D- https://element.inblock.io/element-theme-overrides.css -o /dev/null
# how the dot is colored + what the tokens resolve to statically:
docker exec matrix-element-web-1 sh -c \
  'grep -rhoE "\.mx_PresenceIconView_online[^{]*\{[^}]*\}" /app/bundles/*/*.css | sort -u'
docker exec matrix-element-web-1 sh -c \
  'grep -rhoE "\-\-cpd-color-(icon-(accent|success)-primary|green-900):[^;}]*" /app/bundles/*/*.css | sort -u'
```
The definitive runtime check (does the green scale go orange) needs a browser/DevTools on a
logged-in 1.12.20 session, since the regeneration is client-side JS.
