# Element Web theme customization (contract)

How the inblock.io Element Web themes are defined, who owns what, and the one
discipline that keeps semantic colors correct. This supersedes the two
`docs/2026-06-04-element-*-handover.md` notes, whose root-cause theory was
**disproved against the pinned Element source**.

Element is built from source at `ELEMENT_WEB_TAG` (currently `v1.12.20`, see
`dockerfiles/Dockerfile.element`). The facts below are cited from that tag and
its pinned `@vector-im/compound-design-tokens@10.1.1`.

## Corrected mental model (the load-bearing fact)

On v1.12.20 there is **no accent-to-green regeneration**. A custom theme's
`colors` map only ever produces legacy `--<name>` CSS variables; it never writes
any `--cpd-*` token (`apps/web/src/theme.ts:246-269`, `setCustomThemeVars` ->
`style.setProperty('--'+name, ...)`). The Compound green/red/grey scales are
static (`cpd-theme-*-base.css`), and the semantic tokens point at them by
default:

```
--cpd-color-icon-accent-primary  : var(--cpd-color-green-900)   # the online dot
--cpd-color-icon-success-primary : var(--cpd-color-green-900)   # success icons
--cpd-color-text-success-primary : var(--cpd-color-green-900)
--cpd-color-*-critical-*         : var(--cpd-color-red-900)
green-900 = #007a61 (light) / #129a78 (dark);  red-900 = #d51928 / #fd3e3c
```

Therefore **orange appears only where we explicitly paint it.** Setting
`colors.accent-color` to brand orange does not bleed into green; it only feeds
old non-Compound SCSS views. The `7b14141` / `4beb281` commits over-corrected:
they pinned *every* presence/success token to fight a single orange dot, when
two of the three presence paths are green by construction and never needed it.
Dropping those redundant pins was right. But "stop pinning, do not pin more" was
itself an over-correction: one presence path genuinely *is* orange on v1.12.20,
through a different mechanism, and does need a single scoped pin (see next).

### The online presence dot has THREE render paths (load-bearing)

Element draws the "online" dot in three places, by two different mechanisms:

| Path | Component | Colour mechanism | Result |
|---|---|---|---|
| Member list | `PresenceIconView` (`_PresenceIconView.pcss:20`) | `color: var(--cpd-color-icon-accent-primary)` | **green by construction** |
| Room-list DM avatar | `RoomAvatarView` (`RoomAvatarView.tsx:64`) | inline SVG `color="var(--cpd-color-icon-accent-primary)"` | **green by construction** |
| **Room-header DM avatar** | `WithPresenceIndicator` (`RoomHeader.tsx:465`, `_WithPresenceIndicator.pcss:35`) | `::before { background-color: $accent }` | **brand orange on custom themes** |

The first two read `--cpd-color-icon-accent-primary`, which we never override, so
they are green by construction (this is the fact the refactor verified, correctly,
for *those two paths*). The third is the exception: `WithPresenceIndicator` colours
its dot with the **compiled SCSS variable `$accent`**, and on the custom themes
Element compiles `$accent` to `var(--cpd-color-text-action-accent)` — which we
deliberately paint brand orange (`#E8611A`) for links and buttons. So the
room-header online dot inherits brand orange. (Built-in Element themes compile
`$accent` to green `#0dbd8b`, which is why this only bites custom themes.)

`$accent` is a **compiled-SCSS literal that theme JSON cannot reach** — exactly the
settings-tab-label category. So it is fixed in `config/element-theme-overrides.css`
by repainting only the online `::before` to `--cpd-color-icon-accent-primary` (the
same green the other two paths use), leaving brand accents and the away/busy/offline
states untouched. Do **not** "fix" this by pinning `icon-accent-primary` / success /
green tokens in the theme JSON — that would also recolour the two green-by-
construction paths and re-enter the phantom-fix trap. `verify-theme.sh` asserts the
header rule is present and the member-list pin is absent.

Direct `compound` overrides DO apply: Element emits them into
`@layer compound-tokens`, appended last, so they win by source order
(`apps/web/src/theme.ts:205-213`). We use that only for the palette and the
deliberate brand-orange accents.

## Single source of truth

The three themes (`inblock.io Dark` [default], `inblock.io Light`, `Nord dark
theme`) are authored **inline** in `config/element-config.json` under
`setting_defaults.custom_themes`. That file is bind-mounted, so edits apply on an
`element-web` restart. There are no standalone `theme-*.json` files (deleted; they
were unreferenced duplicates that drifted).

Each theme's `compound` map is kept to two intentional groups:

- **Neutral palette** -- surfaces and text/icon greys that define our look:
  `theme-bg`, `bg-canvas-default`, `bg-subtle-secondary`, `bg-subtle-primary`,
  `text-primary`, `text-secondary`, `icon-primary`, `icon-secondary`,
  `icon-tertiary`.
- **Brand orange** -- the only tokens we paint orange (`#E8611A`, or `#D4570F`
  for light accent text contrast): `bg-action-primary-rest`, `bg-accent-rest`,
  `text-action-accent`, `icon-accent-tertiary`, `border-interactive-primary`.

Nord is the exception: it authors a full Nord palette (including sage-green
success and Nord-red critical) on purpose, and is the green-accent **control
case** that never showed the bug. It is exempt from the protected-token rule.

## Ownership contract

| Concern | Owner |
|---|---|
| Palette (surfaces, text, icons) + deliberate brand-orange accents | theme JSON `compound` map in `element-config.json` |
| Semantic colors (success green, critical red) | nobody -- Compound defaults are correct; do not pin them |
| Online dot: member list + room-list DM avatar | nobody -- they read `icon-accent-primary`, left at its green default |
| Online dot: room-header DM avatar (`WithPresenceIndicator`) | `element-theme-overrides.css` -- it reads compiled `$accent` -> brand orange, repainted green there |
| Values theme JSON cannot express (compiled SCSS literals; layout) | `config/element-theme-overrides.css` |

The CSS side-channel (`element-theme-overrides.css`, `COPY`'d in
`Dockerfile.element` and injected into `index.html` by
`entrypoints/element_entrypoint.sh`) is reserved strictly for the last three
rows. It currently carries three rules:

1. **settings-tab label** -- restores the selected tab label, which Element drives
   from a compiled SCSS value (`$accent` / `$tab-label-active-fg-color` in
   `apps/web/res/css/structures/_TabbedView.pcss`) the runtime theme JSON cannot
   reach.
2. **room-header online dot** -- repaints `.mx_WithPresenceIndicator_icon_online`
   from compiled `$accent` (brand orange on custom themes) to
   `--cpd-color-icon-accent-primary` (green), matching the other two dot paths.
3. **profile MXID wrap** -- lets a long DID MXID wrap inside the right-panel user
   profile (frees the fixed `mx_UserInfo_profile_mxid` height and adds
   `overflow-wrap: anywhere` to its `CopyableText`). Layout, which theme JSON
   cannot express; the native copy button already exists.

## The discipline (one rule)

**Never override `--cpd-color-icon-accent-primary`, any `*success*` token, or any
`--cpd-color-green-*` token in the inblock.io themes.** Leaving them at Compound
defaults is what keeps the member-list + room-list online dots and the success
semantics green by construction. Painting any of them (especially orange) is the
phantom-fix trap this refactor removed. The room-header dot is the one exception
and is handled by a scoped CSS rule (not a theme-JSON token); do not "promote" it
to a token pin. Nord is exempt (it owns its palette).

`verify-theme.sh` enforces this statically.

## Deploy paths (they differ)

- `config/element-config.json` and `entrypoints/element_entrypoint.sh` are
  **bind-mounted** -> changes apply on an `element-web` restart, no rebuild.
- `config/element-theme-overrides.css` is **baked into the image**
  (`Dockerfile.element`) -> changes apply only via a CI image rebuild + redeploy.

## Verification

1. **Static, pre-deploy (CI + local):** `./verify-theme.sh` (and
   `./verify-theme.sh --self-test`). Asserts JSON validity, the protected-token
   discipline, and the override-CSS scope.
2. **Served, post-deploy:** `./verify-deployment.sh` section [5] runs the same
   assertions against the live instance (served `config.json` + served override
   CSS).
3. **Version-bump tripwire (run in CI after a tag bump):** confirm the dot token
   and green value have not moved under a new Element/Compound version:
   ```bash
   # member-list dot: must still read icon-accent-primary
   docker exec matrix-element-web-1 sh -c \
     'grep -rhoE "\.mx_PresenceIconView_online[^{]*\{[^}]*\}" /app/bundles/*/*.css | sort -u'
   # room-header dot: must still be the $accent ::before our override repaints
   docker exec matrix-element-web-1 sh -c \
     'grep -rhoE "\.mx_WithPresenceIndicator_icon_online[^{]*\{[^}]*\}" /app/bundles/*/*.css | sort -u'
   docker exec matrix-element-web-1 sh -c \
     'grep -rhoE "\-\-cpd-color-(icon-accent-primary|green-900):[^;}]*" /app/bundles/*/*.css | sort -u'
   ```
   Expect the member-list dot to read `icon-accent-primary` (green `green-900`),
   and the room-header dot rule (`mx_WithPresenceIndicator_icon_online::before`)
   to still exist as the selector our override targets. If the header selector or
   its `$accent` mechanism moved, update `element-theme-overrides.css` before
   shipping.
4. **Visual gate (human, before any deploy):** on a v1.12.20 instance confirm the
   online dot is green, success is green, critical is red, brand buttons/links/
   focus are orange, the settings-tab label is readable, across Dark, Light, Nord.

## References

- `apps/web/src/theme.ts:205-213, 246-269` -- custom-theme application.
- `apps/web/res/css/views/rooms/_PresenceIconView.pcss:20` -- member-list dot uses
  `icon-accent-primary`.
- `apps/web/src/components/views/avatars/RoomAvatarView.tsx:64-72` -- room-list DM
  avatar dot, inline `color="var(--cpd-color-icon-accent-primary)"`.
- `apps/web/res/css/views/avatars/_WithPresenceIndicator.pcss:35` -- room-header dot
  uses `background-color: $accent` (compiles to `text-action-accent` on custom
  themes); rendered from `RoomHeader.tsx:465`.
- `apps/web/src/components/views/right_panel/user_info/UserInfoHeaderView.tsx:86-89`
  -- MXID rendered via native `CopyableText` (the copy button already exists);
  `apps/web/res/css/views/right_panel/_UserInfo.pcss` (`mx_UserInfo_profile_mxid`).
- `@vector-im/compound-design-tokens@10.1.1` `cpd-common-semantic.css:78,80,9` and
  `cpd-theme-{light,dark}-base.css:81,25` -- semantic-to-scale mappings and hexes.
