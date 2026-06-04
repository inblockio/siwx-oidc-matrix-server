# Refactor: Element front-end theme customization (collapse the phantom-fix layers)

## Context — why this change

The Element Web theming for `agentic.inblock.io` accreted across four commits
(`0907ea9` themes -> `c996f35` light contrast -> `7b14141` presence dot + tab label
-> `4beb281` stopgap) into **three overlapping mechanisms, one dead**, all built on a
root-cause theory that turns out to be **false for the pinned Element version**.

The branch `fix/element-success-icon-token` was created to fix an "orange online
presence dot" by pinning `--cpd-color-icon-success-primary` green. Both handover docs
theorized that setting `colors.accent-color: #E8611A` makes Element regenerate the whole
`--cpd-color-green-*` scale to orange, dragging success and the dot orange with it, and
that the cure is to hand-pin ~20 Compound tokens back per theme.

**I verified that theory against the real v1.12.20 source. It is false on v1.12.20.**

| Claim | Source evidence | Verdict |
|---|---|---|
| `colors.accent-color` regenerates the green scale | `apps/web/src/theme.ts:246-269` — `setCustomThemeVars` only does `setProperty('--'+name)`; `colors` keys become legacy `--accent-color` vars, never any `--cpd-*` | **REFUTED**: no accent->green derivation exists anywhere in element-web or compound |
| Online dot is orange | `_PresenceIconView.pcss:20-21` dot uses `--cpd-color-icon-accent-primary` = `green-900` (`cpd-common-semantic.css:78`); we never override `icon-accent-primary` or `green-*` | **Dot is GREEN by construction** (#007a61 light / #129a78 dark) |
| Direct `compound` overrides apply | `theme.ts:205-213` emits them into `@layer compound-tokens`, appended last -> win by source order | Confirmed — pins work, but most are unnecessary |

The orange-dot observation came from Element **1.12.18** (the handover says so); the premise
did not survive the bump to **1.12.20**, and nobody re-verified. **On v1.12.20, orange appears
only where we explicitly paint it.** We never paint the dot, success, or green tokens orange.
So the `4beb281` stopgap and the online-dot CSS rule both fix a phantom, and ~6 semantic pins
per theme restore colors Compound already gets right.

**Intended outcome:** one authored source per theme, semantic colors correct by Compound
default (zero semantic pinning), a small self-explanatory palette + brand-orange set, one
documented CSS rule for the one thing theme JSON genuinely cannot express, and a regression
guard so a future Element bump cannot silently regress this again.

## Decisions taken (confirmed with user)
- **Semantic colors:** use Compound defaults (drop the `#16a34a` / `#dc2626` pins).
- **Cleanup scope:** full collapse (delete dead files; remove stopgap AND online-dot CSS rule;
  keep only the tab-label CSS rule; add regression guard; document the ownership contract).

## Hypothesis register (audit trace target)

| ID | If | Then | Verification |
|----|----|------|--------------|
| H1 | Drop the 6 semantic pins from inblock.io Dark/Light | success renders Compound green (#007a61/#129a78), critical renders Compound red (#d51928/#fd3e3c) — both correct | `verify-theme.sh` + source mapping; visual gate pre-deploy |
| H2 | Remove the online-dot CSS rule + the `4beb281` stopgap | dot stays green (reads untouched `icon-accent-primary`=green-900) | `_PresenceIconView.pcss:20` + config grep + served check; visual gate |
| H3 | Delete the 3 standalone `theme-*.json` | nothing changes at runtime (unreferenced, never `COPY`'d) | repo-wide grep = 0 refs; identical built bundle |
| H4 | Keep the tab-label CSS rule | the active settings-tab label stays readable (it is driven by compiled `$accent`/`$tab-label-active-fg-color`, which theme JSON cannot reach) | `_TabbedView.pcss` source; visual confirmation |
| H5 | A theme paints a protected token non-green, or the dot rule reappears | `verify-theme.sh` fails loudly | negative-fixture test |

## Work breakdown (one commit per coherent stage, on the existing branch)

### Commit 1 — Single source of truth
- **Delete** `config/theme-inblockio-dark.json`, `config/theme-inblockio-light.json`,
  `config/theme-nord-dark.json` (dead duplicates: zero references, never `COPY`'d, already
  drifted — they lack the later inline edits).
- **Update** `skills/matrix-custom-themes-specialist.md` (the "inblock.io Brand Themes" section,
  ~lines 132-174) to state the single source of truth is the inline
  `setting_defaults.custom_themes` in `config/element-config.json`, and drop the instructions
  that reference the deleted files. Add a one-line pointer to the new contract doc.

### Commit 2 — Collapse the compound maps (`config/element-config.json`)
For **inblock.io Dark** and **inblock.io Light**, remove these 6 keys each (semantic pins that
merely re-state Compound's correct defaults; includes the `4beb281` stopgap, which is thereby
subsumed):
`--cpd-color-bg-critical-primary`, `--cpd-color-text-critical-primary`,
`--cpd-color-text-success-primary`, `--cpd-color-icon-success-primary`,
`--cpd-color-border-critical-primary`, `--cpd-color-border-success-subtle`.

Keep the 14 tokens that are genuine intent — two clear groups:
- **Neutral palette** (surfaces + text/icon grays): `theme-bg`, `bg-canvas-default`,
  `bg-subtle-secondary`, `bg-subtle-primary`, `text-primary`, `text-secondary`,
  `icon-primary`, `icon-secondary`, `icon-tertiary`.
- **Brand orange** (deliberate, the only orange we paint): `bg-action-primary-rest`,
  `bg-accent-rest`, `text-action-accent`, `icon-accent-tertiary`, `border-interactive-primary`.

Net: Dark 20->14, Light 20->14. **Nord is left unchanged** — its `compound` map (sage green
+ Nord red) is intentional Nord palette, not phantom-fix cruft, and it is the green-accent
control case that never showed the bug.

### Commit 3 — Remove the redundant online-dot CSS rule (`config/element-theme-overrides.css`)
- Remove the presence-dot block (the `.mx_PresenceIconView_online` / `mx_RoomAvatarView_PresenceDecoration` rule + its comment).
- Keep the settings-tab-label rule; rewrite the file header comment to state this file now
  exists solely for the compiled-SCSS-literal tab-label fix, and point to the contract doc.
- **No change** to `dockerfiles/Dockerfile.element` or `entrypoints/element_entrypoint.sh` —
  the file is still needed (and still injected) for the tab rule.

### Commit 4 — Regression guard
- **Add `verify-theme.sh`** (static, no network, CI- and locally-runnable):
  1. `config/element-config.json` is valid JSON.
  2. No theme's `compound` map paints a **protected token** to a non-green value —
     `icon-accent-primary`, `icon-success-primary`, `text-success-primary`,
     `bg-success-*`, `border-success-*`, or any `green-*`. (Encodes the discipline that keeps
     the dot + success green by construction.)
  3. `config/element-theme-overrides.css` no longer contains the presence-dot selector and
     still contains the tab-label selector.
  Include a negative-fixture self-test (H5).
- **Wire a served-side check into `verify-deployment.sh`** (new section, public endpoints, no
  SSH): `curl` `/config.json` and `/element-theme-overrides.css` from `${CLIENT_HOST}` and run
  the same assertions on the served artifacts.
- **Document** the optional image/bundle tripwire for the version-bump failure mode (the
  handover's `docker exec ... grep /app/bundles/*/*.css` recipe asserting the dot token still
  resolves to green), to run in CI post-build.

### Commit 5 — Ownership contract + resolve handovers
- **Add `docs/element-theme-customization.md`:** the corrected mental model (no accent->green
  regeneration on 1.12.20; orange only where painted; green scale static), the ownership
  contract (theme JSON `compound` owns palette + brand-orange; CSS side-channel owns only
  compiled-literal fixes; the dot is owned by the "never override `icon-accent-primary` /
  success tokens" discipline), the protected-token list, the version-bump checklist, and the
  two deploy paths (config = restart, override CSS = image rebuild).
- **Mark resolved** (header note, not deletion) the two `docs/2026-06-04-element-*-handover.md`
  docs, pointing to the outcome.
- Copy this plan to `docs/superpowers/plans/2026-06-04-element-theme-refactor.md` (convention)
  and add a one-line pointer in repo `CLAUDE.md` to the contract doc.

## Verification (how this is tested without deploying)
- **Static (I run during execution):** `jq . config/element-config.json` valid; `./verify-theme.sh`
  passes (incl. negative fixture); repo-wide grep proves the deleted files had 0 references.
- **Source cross-check (already done, re-citable):** protected tokens resolve to green in pinned
  compound 10.1.1; dropped semantic pins map to Compound green-900 / red-900.
- **Served (user-run, post-redeploy):** `./verify-deployment.sh` theme section against
  `element.inblock.io`.
- **Visual gate (user-side, before any deploy):** on a 1.12.20 instance confirm — online dot
  green, success green, critical red, brand buttons/links/focus orange, settings-tab label
  readable, all three themes correct. This is the human gate; deploy needs user auth regardless.

## Deploy story (no deploy in this task)
- `element-config.json` change (Commits 1-2) applies on an `element-web` **restart** (bind-mounted).
- `element-theme-overrides.css` change (Commit 3) applies only via a **CI image rebuild + redeploy**.
- Because the dot is green either way, there is no broken intermediate state if the two land
  at different times.

## Boundary conditions / invariants
- **No push, no prod deploy** without explicit user authorization.
- `element-config.json` must stay valid JSON (a parse error blanks all of Element).
- Do **not** touch auth/login/redirect, the issuer trailing slash, favicons, or the
  force-first-device-recovery patch.
- Do **not** override `--cpd-color-icon-accent-primary` or any success/green token (the new
  discipline; guarded by `verify-theme.sh`).
- Branch-only work, incremental commits; merge to local `main` only after `verify-theme.sh`
  and `jq` pass; push waits for the user. No em dashes in docs.

## Out of scope
- Pushing/deploying; bumping the Element version; Nord theme changes; any palette redesign
  (brand colors are unchanged); the Element source patch.
