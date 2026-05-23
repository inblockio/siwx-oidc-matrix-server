# Custom Themes for Element Web: Design Spec

## Goal

Enable custom theme selection in the self-hosted Element Web instance. Pre-load
Nord Dark (community favorite) and inblock.io branded themes (Dark + Light) so
users can pick them from Settings > Appearance without manual URL pasting.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Default community theme | Nord Dark | Most popular, actively maintained, includes Compound token coverage |
| Brand themes | inblock.io Dark + Light | Maps brand color system to Element theme keys |
| Default on first login | Built-in Element theme | Users opt in to custom themes via Settings > Appearance |
| Labs feature | Pre-enabled via config | `feature_custom_themes: true` so the theme picker shows without manual Labs toggle |

## Architecture

### How Element Web themes work

Element Web supports custom themes via a JSON format with three sections:

- `colors`: key-value pairs that become CSS custom properties (accent, sidebar, timeline, etc.)
- `compound`: overrides for the newer Compound design system tokens (`--cpd-*`)
- `fonts`: optional custom font faces and families

Themes are either:
1. **Pre-loaded** in `config.json` under `setting_defaults.custom_themes` (self-hosted, all users)
2. **Added at runtime** by users via Settings > Labs > "Support adding custom themes", then pasting a JSON URL in Settings > Appearance

### Integration with this stack

The Element Web config lives at `config/element-config.json`. The entrypoint
(`entrypoints/element_entrypoint.sh`) copies it to `/app/config.json` and runs
`sed` replacements for `%%PLACEHOLDER%%` tokens at container start.

Adding themes requires only editing `element-config.json` to include the
`setting_defaults.custom_themes` array and `feature_custom_themes: true` in
`features`. No Dockerfile changes needed.

Theme JSON files are stored separately in `config/theme-*.json` for
maintainability. They are embedded into `element-config.json` by reference
in documentation, or can be inlined directly.

## Theme files

| File | Theme | Source |
|---|---|---|
| `config/theme-inblockio-dark.json` | inblock.io Dark | Brand guide color mapping |
| `config/theme-inblockio-light.json` | inblock.io Light | Brand guide color mapping |
| Nord Dark | Fetched from aaronraimist/element-themes | Community |

### Brand color mapping rationale

- `accent-color` / `primary-color`: `#E8611A` (brand orange, singular chromatic accent)
- Surfaces follow the three-level stack: `--bg` > `--surface` > `--surface2`
- Warm neutrals for light theme, cool neutrals for dark theme (brand rule)
- Orange never used for large filled areas (sidebar, panels use neutral surfaces)
- `warning-color`: `#d97706` (enforce-amber, semantically correct)
- Light theme accent text uses `#D4570F` (accent-hover) for better contrast on warm backgrounds

## Skill scope

The `/matrix-custom-themes-specialist` skill covers:

1. How Element themes work (JSON structure, color keys, Compound tokens)
2. Pre-loading themes via config.json (config changes, container restart)
3. Adding themes at runtime (Labs toggle, URL method)
4. Nord Dark setup (concrete config)
5. inblock.io brand theme (ready-to-use JSON, brand guide alignment)
6. Creating custom themes (key reference, template)
7. Troubleshooting (theme not appearing, partial styling, Compound gaps)
8. Community themes catalog (24 themes with raw URLs)

## Out of scope

- CSS injection or Element Web forks for structural changes (layout, spacing, borders)
- Theming Element Desktop or mobile apps (different config mechanisms)
- Dynamic theme switching via API (not supported by Element)
