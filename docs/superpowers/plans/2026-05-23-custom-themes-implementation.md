# Handover: Implement and Deploy Custom Themes for Element Web

> **SUPERSEDED 2026-06-04.** The standalone `config/theme-*.json` files this doc
> creates/reads were deleted; themes are now authored only inline in
> `config/element-config.json`. See `docs/element-theme-customization.md`. Kept
> for history.

**Date:** 2026-05-23
**Branch:** `matrix-custom-themes` (create from `main`)
**Target:** agentic.inblock.io (element.inblock.io)

## Context

The `/matrix-custom-themes-specialist` skill, design spec, and brand theme JSON
files were created in the previous session. Everything is committed to `main`
(commit `66a511a`). This session implements the config changes and deploys.

## What already exists (on main, merged)

| File | Status |
|---|---|
| `skills/matrix-custom-themes-specialist.md` | Complete, symlinked |
| `config/theme-inblockio-dark.json` | Complete, brand-guide compliant |
| `config/theme-inblockio-light.json` | Complete, brand-guide compliant |
| `docs/superpowers/specs/2026-05-23-matrix-custom-themes-design.md` | Complete |
| `CLAUDE.md` | Updated with skill entry |

## What needs to be done

### Step 1: Create branch

```bash
git checkout -b matrix-custom-themes main
```

### Step 2: Fetch Nord Dark theme JSON

Download the Nord Dark theme from the community repo:

```bash
curl -s 'https://raw.githubusercontent.com/aaronraimist/element-themes/master/Nord/Nord%20Dark/Nord%20Dark.json' \
  -o config/theme-nord-dark.json
```

Verify it has both `colors` and `compound` keys (modern theme with full coverage).

### Step 3: Modify element-config.json

The current config at `config/element-config.json` is:

```json
{
  "default_server_config": {
    "m.homeserver": {
      "base_url": "%%MATRIX_BASE_URL%%",
      "server_name": "%%MATRIX_HOST%%"
    }
  },
  "disable_custom_urls": true,
  "disable_guests": true,
  "disable_login_language_selector": true,
  "brand": "inblock.io Chat",
  "element_call": {
    "url": "https://call.element.io",
    "use_exclusively": true,
    "brand": "inblock.io Call"
  },
  "features": {
    "feature_group_calls": true,
    "feature_video_rooms": true,
    "feature_element_call_video_rooms": true
  }
}
```

Required changes:

1. Add `"feature_custom_themes": true` to the `features` block
2. Add a `setting_defaults` block with `custom_themes` array containing:
   - The full inblock.io Dark theme object (from `config/theme-inblockio-dark.json`)
   - The full inblock.io Light theme object (from `config/theme-inblockio-light.json`)
   - The full Nord Dark theme object (from the downloaded JSON)

Do NOT set `default_theme`. Users start with Element's built-in theme and opt in
to custom themes via Settings > Appearance.

The theme objects must be inlined directly into `element-config.json` (not
referenced as file paths). Element Web reads a single `config.json` at startup.

### Step 4: Validate JSON

```bash
python3 -m json.tool config/element-config.json > /dev/null
```

A trailing comma or missing quote breaks the entire Element Web config.

### Step 5: Commit and push

```bash
git add config/element-config.json config/theme-nord-dark.json
git commit -m "feat: pre-load custom themes (inblock.io Dark/Light + Nord Dark)"
git push -u origin matrix-custom-themes
```

### Step 6: Deploy

Use the deploy skill. The deploy script accepts branch names as refs:

```bash
./deploy.sh matrix-custom-themes --build --restart
```

This ref must exist in **both** repos (`siwx-oidc-matrix-server` and `siwx-oidc`).
Since only the matrix server repo changed, the siwx-oidc repo just needs the
same branch name pointing to its current HEAD (or use `main` if deploy.sh
supports different refs per repo; check the skill).

**Alternative:** If deploy.sh requires matching refs in both repos, either:
- Create a `matrix-custom-themes` branch in `siwx-oidc` at its current HEAD, or
- Merge to `main` first and deploy `main`

### Step 7: Verify on live instance

1. Open https://element.inblock.io
2. Log in with a wallet
3. Go to **Settings > Appearance**
4. Confirm three custom themes appear in the theme picker:
   - inblock.io Dark
   - inblock.io Light
   - Nord dark theme
5. Select each theme and verify:
   - Sidebar, room list, and timeline all change colors
   - No half-styled elements (Compound coverage check)
   - Text is readable (contrast check)
   - Brand orange (`#E8611A`) appears on accent elements (buttons, links) in inblock.io themes
6. Switch back to the built-in Dark/Light theme and confirm it still works

## Architecture notes for the implementer

- `config/element-config.json` is volume-mounted into the container as
  `/app/config.json.src` (read-only). The entrypoint copies it to `/app/config.json`
  and runs `sed` replacements for `%%PLACEHOLDER%%` tokens. No Dockerfile changes needed.
- The `setting_defaults.custom_themes` array is read by Element at startup and
  populates the theme picker. No Labs toggle needed when `feature_custom_themes`
  is enabled in the config.
- Theme JSON files in `config/theme-*.json` are reference copies for
  maintainability. They are not read by Element directly.

## Rollback

If themes cause issues:

```bash
./deploy.sh main --build --restart
```

This reverts to the `main` branch config without custom themes.

## Decision log

| Decision | Choice | Rationale |
|---|---|---|
| Default community theme | Nord Dark | Most popular, actively maintained, Compound token coverage |
| Brand themes | inblock.io Dark + Light | Brand guide compliant (see spec) |
| Default on first login | Built-in Element theme | Users opt in via Settings > Appearance |
| Labs feature | Pre-enabled via config | `feature_custom_themes: true` |
| Branch | `matrix-custom-themes` | Isolate from main until verified on live |
