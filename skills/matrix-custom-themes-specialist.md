---
name: matrix-custom-themes-specialist
description: Use when adding, configuring, troubleshooting, or creating custom themes for Element Web. Covers pre-loading themes via config.json, enabling the Labs feature, adding community themes (Nord, Dracula, Catppuccin, etc.), creating brand-aligned themes, and diagnosing theme rendering issues. Triggers on "theme", "custom theme", "dark mode", "appearance", "Nord", "Dracula", "Catppuccin", "element theme", "color scheme".
---

# Element Web Custom Themes Specialist

## How Element Themes Work

Element Web themes are JSON objects with three sections:

```
{
  "name": "Theme Name",
  "is_dark": true | false,
  "colors": { ... },       // CSS custom properties for legacy UI
  "compound": { ... },     // --cpd-* tokens for Compound design system
  "fonts": { ... }         // Optional: custom font faces and families
}
```

- `is_dark` determines which built-in theme (light or dark) serves as the base. Getting this wrong produces a half-light/half-dark UI.
- `colors` keys become CSS variables. Element does not validate key names; typos silently produce no effect.
- `compound` tokens override the newer Compound design system. Older themes lack this section, so some modern UI elements may not match.
- `fonts` is optional. Omit to use Element's default fonts.

### Two ways to add themes

| Method | Scope | Requires restart? |
|---|---|---|
| **Pre-load in config.json** | All users on this instance | Yes (container restart) |
| **Runtime URL** | Individual user (Settings > Appearance) | No |

Pre-loading is the recommended approach for self-hosted instances.

---

## Pre-loading Themes via config.json

### Step 1: Enable the custom themes feature

Add `feature_custom_themes` to the `features` block in `config/element-config.json`:

```json
"features": {
    "feature_custom_themes": true,
    "feature_group_calls": true,
    "feature_video_rooms": true,
    "feature_element_call_video_rooms": true
}
```

### Step 2: Add themes to setting_defaults

Add a `setting_defaults` block with the `custom_themes` array. Each entry is a
complete theme object:

```json
{
    "setting_defaults": {
        "custom_themes": [
            { "name": "Theme One", "is_dark": true, "colors": { ... } },
            { "name": "Theme Two", "is_dark": false, "colors": { ... } }
        ]
    },
    "default_server_config": { ... },
    ...
}
```

### Step 3: Apply the change

```bash
# Restart the Element Web container to pick up config changes
docker compose restart element-web
```

No image rebuild is needed. The config is volume-mounted and re-read at startup.

### Setting a custom theme as default (optional)

To make a custom theme the default for new users, add `default_theme` with the
`custom-` prefix:

```json
{
    "default_theme": "custom-inblock.io Dark",
    "setting_defaults": {
        "custom_themes": [ ... ]
    }
}
```

The `custom-` prefix is required. Without it, Element will not find the theme.

---

## Adding Themes at Runtime (Per-User)

For users who want to add themes without changing the server config:

1. Go to **Settings > Labs**
2. Enable **"Support adding custom themes"** (`feature_custom_themes`)
3. Go to **Settings > Appearance**
4. Paste the raw URL to a theme JSON file in the **Custom theme URL** field
5. Click **Add theme**

The theme appears in the Theme selector immediately.

Example URL for Nord Dark:
```
https://raw.githubusercontent.com/aaronraimist/element-themes/master/Nord/Nord%20Dark/Nord%20Dark.json
```

---

## Nord Dark Theme

The recommended community theme. Includes both legacy `colors` and modern
`compound` token coverage.

Fetch the theme JSON:
```bash
curl -s 'https://raw.githubusercontent.com/aaronraimist/element-themes/master/Nord/Nord%20Dark/Nord%20Dark.json'
```

To pre-load, add the downloaded JSON object to the `setting_defaults.custom_themes`
array in `config/element-config.json`.

---

## inblock.io Brand Themes

Two brand-aligned themes (inblock.io Dark, inblock.io Light), plus a Nord control
theme, map the inblock.io design system to Element's theme keys.

**Single source of truth:** the themes are authored inline in
`config/element-config.json` under `setting_defaults.custom_themes` (a bind-mounted
file, applied on an `element-web` restart). There are no standalone `theme-*.json`
files; edit the inline array directly. See `docs/element-theme-customization.md` for
the palette-vs-routing ownership contract and the protected-token discipline (never
override `--cpd-color-icon-accent-primary` or any success/green token, or the online
presence dot and success icons stop being green).

### Brand color mapping

| Element Key | Dark | Light | Brand Token |
|---|---|---|---|
| `accent-color` | `#E8611A` | `#E8611A` | `--accent` (brand orange) |
| `warning-color` | `#d97706` | `#d97706` | `--enforce-amber` |
| `sidebar-color` | `#0f0f13` | `#f5f5f4` | `--bg` / `--surface2` |
| `roomlist-background-color` | `#1a1a20` | `#ffffff` | `--surface` |
| `timeline-background-color` | `#0f0f13` | `#fafaf9` | `--bg` |
| `timeline-text-color` | `#e4e4e7` | `#1c1917` | `--text` |
| `timeline-text-secondary-color` | `#71717a` | `#78716c` | `--dim` |

**Brand rules applied:**
- Orange is never used for large filled areas (sidebar, panels use neutral surfaces)
- Warm neutrals for light, cool neutrals for dark (no mixing)
- Light theme accent text uses `#D4570F` (accent-hover) for better contrast
- Selected reactions use the brand's subtle accent tint (`--accent-glow` / `--accent-soft`)

### Editing the brand themes

Edit the theme objects in place in `config/element-config.json`
(`setting_defaults.custom_themes`), then restart:

```bash
# Validate before restarting -- a JSON parse error blanks all of Element.
./verify-theme.sh
docker compose restart element-web
```

Keep each theme's `compound` map to two intentional groups only: the neutral palette
(surfaces + text/icon greys) and the brand-orange accents (`bg-action-primary-rest`,
`bg-accent-rest`, `text-action-accent`, `icon-accent-tertiary`,
`border-interactive-primary`). Do NOT pin success/critical/green tokens: on the pinned
Element version they are already correct by Compound default, and pinning them is the
phantom-fix trap that this skill's themes were cleaned up to avoid.

---

## Creating a Custom Theme

### Color key reference

**Core keys** (used by all themes):

| Key | Purpose |
|---|---|
| `accent-color` | Buttons, links, active elements |
| `primary-color` | Primary UI color |
| `warning-color` | Warning/error states |
| `sidebar-color` | Left sidebar background |
| `roomlist-background-color` | Room list panel background |
| `roomlist-text-color` | Room list primary text |
| `roomlist-text-secondary-color` | Room list secondary text |
| `roomlist-highlights-color` | Hover/selection highlight |
| `roomlist-separator-color` | Divider lines |
| `timeline-background-color` | Message timeline background |
| `timeline-text-color` | Message text color |
| `timeline-text-secondary-color` | Timestamps, metadata |
| `timeline-highlights-color` | Highlighted messages background |
| `secondary-content` | Secondary content |
| `tertiary-content` | Tertiary content |
| `reaction-row-button-selected-bg-color` | Selected reaction button |

**Extended keys** (optional):

| Key | Purpose |
|---|---|
| `username-colors` | Array of 8 hex colors for username display |
| `avatar-background-colors` | Array of 3-8 hex colors for default avatars |
| `other-user-pill-bg-color` | Mention pill background for other users |
| `menu-selected-color` | Selected menu item background |
| `focus-bg-color` | Focused element background |
| `togglesw-off-color` | Toggle switch off-state |

**Compound tokens** (for modern UI elements):

Place in the `compound` key (not `colors`). Must match the pattern `--cpd-[a-z0-9-]+`.

Key tokens to override:

| Token | Purpose |
|---|---|
| `--cpd-color-theme-bg` | Main background |
| `--cpd-color-bg-canvas-default` | Canvas/panel background |
| `--cpd-color-bg-subtle-secondary` | Subtle secondary background |
| `--cpd-color-bg-subtle-primary` | Subtle primary background |
| `--cpd-color-bg-action-primary-rest` | Primary action button background |
| `--cpd-color-bg-critical-primary` | Error/destructive background |
| `--cpd-color-text-primary` | Primary text |
| `--cpd-color-text-secondary` | Secondary text |
| `--cpd-color-text-action-accent` | Accent links/text |
| `--cpd-color-icon-primary` | Primary icons |
| `--cpd-color-border-interactive-primary` | Focus/active borders |

### Starter template

```json
{
    "name": "My Custom Theme",
    "is_dark": true,
    "colors": {
        "accent-color": "#YOUR_ACCENT",
        "primary-color": "#YOUR_ACCENT",
        "warning-color": "#YOUR_WARNING",
        "sidebar-color": "#YOUR_DARKEST_BG",
        "roomlist-background-color": "#YOUR_DARK_BG",
        "roomlist-text-color": "#YOUR_TEXT",
        "roomlist-text-secondary-color": "#YOUR_DIM_TEXT",
        "roomlist-highlights-color": "#YOUR_HIGHLIGHT_BG",
        "roomlist-separator-color": "#YOUR_BORDER",
        "timeline-background-color": "#YOUR_MAIN_BG",
        "timeline-text-color": "#YOUR_TEXT",
        "timeline-text-secondary-color": "#YOUR_DIM_TEXT",
        "timeline-highlights-color": "#YOUR_HIGHLIGHT_BG",
        "secondary-content": "#YOUR_DIM_TEXT",
        "tertiary-content": "#YOUR_DIMMER_TEXT"
    },
    "compound": {
        "--cpd-color-theme-bg": "#YOUR_MAIN_BG",
        "--cpd-color-bg-canvas-default": "#YOUR_MAIN_BG",
        "--cpd-color-bg-action-primary-rest": "#YOUR_ACCENT",
        "--cpd-color-text-primary": "#YOUR_TEXT",
        "--cpd-color-text-secondary": "#YOUR_DIM_TEXT",
        "--cpd-color-text-action-accent": "#YOUR_ACCENT"
    }
}
```

---

## Troubleshooting

### Theme not appearing in settings

```
Is feature_custom_themes enabled in config?
  |
  +-- No --> Add "feature_custom_themes": true to "features" in element-config.json
  |          Restart: docker compose restart element-web
  |
  +-- Yes --> Is the theme in setting_defaults.custom_themes?
                |
                +-- No --> Add the theme JSON object to the array
                |
                +-- Yes --> Check JSON syntax:
                            docker compose exec element-web cat /app/config.json | python3 -m json.tool
                            Look for parse errors. A trailing comma or missing quote breaks the entire config.
```

### Theme loads but looks wrong (partial styling)

**Symptom:** Some elements match the theme, others show default colors.

**Cause:** The theme only has `colors` but no `compound` overrides. Newer Element
UI components use the Compound design system and ignore legacy color keys.

**Fix:** Add `compound` tokens to the theme. Use the inblock.io theme files as a
reference for which tokens to include.

### is_dark mismatch

**Symptom:** Light text on light backgrounds, or dark text on dark backgrounds.

**Cause:** `is_dark` does not match the actual color palette. Element uses this flag
to choose which built-in theme serves as the base layer.

**Fix:** Set `is_dark: true` for themes with dark backgrounds, `false` for light.

### Config changes not taking effect

**Symptom:** Restarted the container but the old config persists.

**Cause:** The entrypoint reads `/app/config.json.src` (volume-mounted from
`config/element-config.json`). If the mount is stale or cached:

```bash
# Force a fresh copy
docker compose down element-web && docker compose up -d element-web

# Verify the config inside the container
docker compose exec element-web cat /app/config.json | python3 -m json.tool
```

### Theme URL not working (runtime method)

**Symptom:** Pasting a URL in Settings > Appearance does nothing or shows an error.

**Possible causes:**
1. The URL does not return raw JSON (e.g., GitHub HTML page instead of raw content). Use `raw.githubusercontent.com` URLs.
2. CORS: the URL's server does not allow cross-origin requests from your Element domain.
3. The JSON is malformed. Validate with `curl <url> | python3 -m json.tool`.

---

## Community Themes Catalog

Source: [aaronraimist/element-themes](https://github.com/aaronraimist/element-themes)

| Theme | Raw URL |
|---|---|
| Nord Dark | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Nord/Nord%20Dark/Nord%20Dark.json` |
| Nord Light | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Nord/Nord%20Light/Nord%20Light.json` |
| Dracula | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Dracula/Non-flat/Dracula.json` |
| Dracula Flat | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Dracula/Flat/DraculaFlat.json` |
| Catppuccin Mocha | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Catppuccin/Mocha/Catppuccin-Mocha-Theme.json` |
| Catppuccin Macchiato | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Catppuccin/Macchiato/Catppuccin-Macchiato-Theme.json` |
| Catppuccin Frappe | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Catppuccin/Frappe/Catppuccin-Frappe-Theme.json` |
| Catppuccin Latte | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Catppuccin/Latte/Catppuccin-Latte-Theme.json` |
| Solarized Dark | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Solarized/Solarized%20Dark/Solarized%20Dark.json` |
| Solarized Light | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Solarized/Solarized%20Light/Solarized%20Light.json` |
| Gruvbox Dark | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Gruvbox/Gruvbox%20Dark/Gruvbox%20Dark.json` |
| Gruvbox Light | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Gruvbox/Gruvbox%20Light/Gruvbox%20Light.json` |
| Discord Dark | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Discord/Discord-Dark/Discord-Dark-Theme.json` |
| Discord Black | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Discord/Discord-Black/Discord-Black-Theme.json` |
| Monokai Pro | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Monokai%20Pro/Monokai-Pro.json` |
| Everforest Dark Hard | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Everforest%20Dark%20Hard/everforest-dark-hard.json` |
| ThomCat Black | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/ThomCat/ThomCat-Black.json` |
| Luxury Dark | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Luxury/Luxury%20Dark/Luxury%20Dark.json` |
| Night Owl Dark | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Night%20Owl/Night%20Owl%20Dark/Night-Owl-Dark-Theme.json` |
| Selenized Light | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Selenized/Selenized%20Light/Selenized%20Light.json` |
| Selenized Dark | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Selenized/Selenized%20Dark/Selenized%20Dark.json` |
| Selenized Black | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Selenized/Selenized%20Black/Selenized%20Black.json` |
| Geeko Dark | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Geeko%20Dark/Geeko%20Dark.json` |
| Covalence | `https://raw.githubusercontent.com/aaronraimist/element-themes/master/Covalence/covalence.json` |

### Limitations

- **Colors and fonts only.** Element's theme system cannot change layout, spacing, borders, or button shapes. Structural CSS changes require a browser extension (Stylus) or a custom Element build.
- **No live-reload.** Config.json themes are read at startup. Changes require a container restart.
- **Older themes lack Compound tokens.** Some community themes predate the Compound design system. Newer UI elements will fall back to the built-in theme for unstyled tokens.
