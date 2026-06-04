# Custom Matrix Themes: Deploy Pipeline

> **SUPERSEDED 2026-06-04.** The standalone `config/theme-*.json` files this
> pipeline creates were deleted; themes are authored only inline in
> `config/element-config.json`. See `docs/element-theme-customization.md`. Kept
> for history.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable three custom themes (inblock.io Dark as default, inblock.io Light, Nord Dark) in Element Web at element.inblock.io so all users see them in Settings > Appearance.

**Architecture:** Inline all three theme JSON objects into `config/element-config.json` under `setting_defaults.custom_themes`, enable `feature_custom_themes`, and set `default_theme` to `custom-inblock.io Dark`. Deploy via CI-built images to agentic.inblock.io.

**Tech Stack:** Element Web config JSON, Docker Compose, GitHub Actions CI/CD, deploy.sh

---

## Hypothesis Register

| ID | If | Then | Assumptions | Verification |
|----|-----|------|-------------|--------------|
| H1 | We set `"feature_custom_themes": true` in `features` | Element Web shows custom themes in Settings > Appearance without needing Labs toggle | Element Web reads `features` from config.json at startup | Open Settings > Appearance, confirm theme picker shows custom themes |
| H2 | We inline theme objects into `setting_defaults.custom_themes` array | All three themes appear as selectable options | Element parses the `setting_defaults` block and registers themes by their `name` field | Count exactly 3 custom themes in the theme picker |
| H3 | We set `"default_theme": "custom-inblock.io Dark"` | New users and fresh sessions start with the inblock.io Dark theme active | Element's `default_theme` key accepts `custom-` prefix for custom theme names | Open element.inblock.io in incognito; confirm dark branded UI with orange accents |
| H4 | The `%%PLACEHOLDER%%` tokens remain intact in the modified config | Entrypoint `sed` replacements still work, Synapse connection succeeds | entrypoint processes config.json.src before Element reads it | Element connects to homeserver (not "cannot reach homeserver" error) |
| H5 | We push to branch `matrix-custom-themes` and CI builds | Docker image `ghcr.io/inblockio/siwx-oidc-matrix-server/element-web:matrix-custom-themes` exists | GitHub Actions workflow triggers on branch push and builds element-web image | `docker pull ghcr.io/inblockio/siwx-oidc-matrix-server/element-web:matrix-custom-themes` succeeds on server |
| H6 | We run `./deploy.sh matrix-custom-themes --build --restart` | The server pulls the new image and restarts element-web with the new config | SSH access works, deploy.sh handles branch refs, siwx-oidc repo has a compatible ref or deploy.sh falls back | `curl -s https://element.inblock.io` returns HTTP 200 |

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `config/element-config.json` | Modify | Add themes array, feature flag, default_theme |
| `config/theme-nord-dark.json` | Create | Nord Dark theme reference copy (not read by Element directly) |
| `config/theme-inblockio-dark.json` | Read only | Source for inlining into element-config.json |
| `config/theme-inblockio-light.json` | Read only | Source for inlining into element-config.json |

---

## Task 1: Create branch and fetch Nord Dark theme

**Hypotheses:** H5
**Files:**
- Create: `config/theme-nord-dark.json`

- [ ] **Step 1: Create branch from main**

```bash
cd /home/system-001/siwx-oidc-matrix-server
git checkout -b matrix-custom-themes main
```

- [ ] **Step 2: Download Nord Dark theme JSON**

```bash
curl -s 'https://raw.githubusercontent.com/aaronraimist/element-themes/master/Nord/Nord%20Dark/Nord%20Dark.json' \
  -o config/theme-nord-dark.json
```

- [ ] **Step 3: Validate the downloaded JSON has required keys**

```bash
python3 -c "
import json, sys
with open('config/theme-nord-dark.json') as f:
    t = json.load(f)
assert 'name' in t and 'is_dark' in t and 'colors' in t and 'compound' in t, 'Missing required keys'
print(f'OK: {t[\"name\"]} (is_dark={t[\"is_dark\"]}, {len(t[\"colors\"])} color keys, {len(t[\"compound\"])} compound keys)')
"
```

Expected: `OK: Nord dark theme (is_dark=True, 16 color keys, 19 compound keys)`

---

## Task 2: Inline themes into element-config.json

**Hypotheses:** H1, H2, H3, H4
**Files:**
- Modify: `config/element-config.json`

- [ ] **Step 1: Replace element-config.json with the complete themed config**

The new `config/element-config.json` must contain:
1. All existing config (server, branding, element_call) with `%%PLACEHOLDER%%` tokens preserved
2. `"feature_custom_themes": true` added to `features`
3. `"default_theme": "custom-inblock.io Dark"` at root level
4. `"setting_defaults"` with `"custom_themes"` array containing all three theme objects inlined

Write this exact content to `config/element-config.json`:

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
  "default_theme": "custom-inblock.io Dark",
  "element_call": {
    "url": "https://call.element.io",
    "use_exclusively": true,
    "brand": "inblock.io Call"
  },
  "features": {
    "feature_group_calls": true,
    "feature_video_rooms": true,
    "feature_element_call_video_rooms": true,
    "feature_custom_themes": true
  },
  "setting_defaults": {
    "custom_themes": [
      {
        "name": "inblock.io Dark",
        "is_dark": true,
        "colors": {
          "accent-color": "#E8611A",
          "primary-color": "#E8611A",
          "warning-color": "#d97706",
          "sidebar-color": "#0f0f13",
          "roomlist-background-color": "#1a1a20",
          "roomlist-text-color": "#e4e4e7",
          "roomlist-text-secondary-color": "#a1a1aa",
          "roomlist-highlights-color": "#22222a",
          "roomlist-separator-color": "#2a2a32",
          "timeline-background-color": "#0f0f13",
          "timeline-text-color": "#e4e4e7",
          "timeline-text-secondary-color": "#71717a",
          "timeline-highlights-color": "#22222a",
          "secondary-content": "#a1a1aa",
          "tertiary-content": "#71717a",
          "reaction-row-button-selected-bg-color": "rgba(232, 97, 26, 0.15)"
        },
        "compound": {
          "--cpd-color-theme-bg": "#0f0f13",
          "--cpd-color-bg-canvas-default": "#0f0f13",
          "--cpd-color-bg-subtle-secondary": "#1a1a20",
          "--cpd-color-bg-subtle-primary": "#22222a",
          "--cpd-color-bg-action-primary-rest": "#E8611A",
          "--cpd-color-bg-critical-primary": "#dc2626",
          "--cpd-color-bg-accent-rest": "#E8611A",
          "--cpd-color-text-primary": "#e4e4e7",
          "--cpd-color-text-secondary": "#a1a1aa",
          "--cpd-color-text-action-accent": "#E8611A",
          "--cpd-color-text-critical-primary": "#dc2626",
          "--cpd-color-text-success-primary": "#16a34a",
          "--cpd-color-icon-primary": "#e4e4e7",
          "--cpd-color-icon-secondary": "#a1a1aa",
          "--cpd-color-icon-tertiary": "#71717a",
          "--cpd-color-icon-accent-tertiary": "#E8611A",
          "--cpd-color-border-interactive-primary": "#E8611A",
          "--cpd-color-border-critical-primary": "#dc2626",
          "--cpd-color-border-success-subtle": "#2a8a5a"
        }
      },
      {
        "name": "inblock.io Light",
        "is_dark": false,
        "colors": {
          "accent-color": "#E8611A",
          "primary-color": "#E8611A",
          "warning-color": "#d97706",
          "sidebar-color": "#f5f5f4",
          "roomlist-background-color": "#ffffff",
          "roomlist-text-color": "#1c1917",
          "roomlist-text-secondary-color": "#292524",
          "roomlist-highlights-color": "#f5f5f4",
          "roomlist-separator-color": "#e7e5e4",
          "timeline-background-color": "#fafaf9",
          "timeline-text-color": "#1c1917",
          "timeline-text-secondary-color": "#78716c",
          "timeline-highlights-color": "#f5f5f4",
          "secondary-content": "#292524",
          "tertiary-content": "#78716c",
          "reaction-row-button-selected-bg-color": "rgba(232, 97, 26, 0.10)"
        },
        "compound": {
          "--cpd-color-theme-bg": "#fafaf9",
          "--cpd-color-bg-canvas-default": "#fafaf9",
          "--cpd-color-bg-subtle-secondary": "#ffffff",
          "--cpd-color-bg-subtle-primary": "#f5f5f4",
          "--cpd-color-bg-action-primary-rest": "#E8611A",
          "--cpd-color-bg-critical-primary": "#dc2626",
          "--cpd-color-bg-accent-rest": "#E8611A",
          "--cpd-color-text-primary": "#1c1917",
          "--cpd-color-text-secondary": "#292524",
          "--cpd-color-text-action-accent": "#D4570F",
          "--cpd-color-text-critical-primary": "#dc2626",
          "--cpd-color-text-success-primary": "#16a34a",
          "--cpd-color-icon-primary": "#1c1917",
          "--cpd-color-icon-secondary": "#292524",
          "--cpd-color-icon-tertiary": "#78716c",
          "--cpd-color-icon-accent-tertiary": "#E8611A",
          "--cpd-color-border-interactive-primary": "#E8611A",
          "--cpd-color-border-critical-primary": "#dc2626",
          "--cpd-color-border-success-subtle": "#2a8a5a"
        }
      },
      {
        "name": "Nord dark theme",
        "is_dark": true,
        "colors": {
          "accent-color": "#a3be8c",
          "primary-color": "#88c0d0",
          "warning-color": "#bf616a",
          "sidebar-color": "#2e3440",
          "roomlist-background-color": "#3b4252",
          "roomlist-text-color": "#ebcb8b",
          "roomlist-text-secondary-color": "#e5e9f0",
          "roomlist-highlights-color": "#2e3440",
          "roomlist-separator-color": "#434c5e",
          "timeline-background-color": "#434c5e",
          "timeline-text-color": "#eceff4",
          "secondary-content": "#eceff4",
          "tertiary-content": "#eceff4",
          "timeline-text-secondary-color": "#81a1c1",
          "timeline-highlights-color": "#3b4252",
          "reaction-row-button-selected-bg-color": "#bf616a"
        },
        "compound": {
          "--cpd-color-theme-bg": "#2e3440",
          "--cpd-color-bg-canvas-default": "#434c5e",
          "--cpd-color-bg-subtle-secondary": "#2e3440",
          "--cpd-color-bg-subtle-primary": "#3b4252",
          "--cpd-color-bg-action-primary-rest": "#88c0d0",
          "--cpd-color-bg-critical-primary": "#bf616a",
          "--cpd-color-bg-accent-rest": "#a3be8c",
          "--cpd-color-text-primary": "#eceff4",
          "--cpd-color-text-secondary": "#81a1c1",
          "--cpd-color-text-action-accent": "#88c0d0",
          "--cpd-color-text-critical-primary": "#bf616a",
          "--cpd-color-text-success-primary": "#a3be8c",
          "--cpd-color-icon-primary": "#eceff4",
          "--cpd-color-icon-secondary": "#81a1c1",
          "--cpd-color-icon-tertiary": "#e5e9f0",
          "--cpd-color-icon-accent-tertiary": "#a3be8c",
          "--cpd-color-border-interactive-primary": "#434c5e",
          "--cpd-color-border-critical-primary": "#bf616a",
          "--cpd-color-border-success-subtle": "#a3be8c"
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Validate JSON syntax**

```bash
python3 -m json.tool config/element-config.json > /dev/null && echo "JSON valid"
```

Expected: `JSON valid`

- [ ] **Step 3: Verify placeholder tokens survived**

```bash
grep -c '%%' config/element-config.json
```

Expected: `2` (one for `%%MATRIX_BASE_URL%%`, one for `%%MATRIX_HOST%%`)

---

## Task 3: Commit and push

**Hypotheses:** H5
**Files:**
- Stage: `config/element-config.json`, `config/theme-nord-dark.json`

- [ ] **Step 1: Stage files and commit**

```bash
git add config/element-config.json config/theme-nord-dark.json
git commit -m "feat: pre-load custom themes (inblock.io Dark default, inblock.io Light, Nord Dark)"
```

- [ ] **Step 2: Push branch to origin**

```bash
git push -u origin matrix-custom-themes
```

- [ ] **Step 3: Verify CI build starts**

```bash
gh run list --branch matrix-custom-themes --limit 3
```

Expected: A workflow run in `in_progress` or `queued` status.

- [ ] **Step 4: Wait for CI to complete**

```bash
gh run watch --exit-status
```

Expected: Workflow completes successfully. The image `ghcr.io/inblockio/siwx-oidc-matrix-server/element-web:matrix-custom-themes` is now available.

---

## Task 4: Deploy to agentic.inblock.io

**Hypotheses:** H5, H6
**Files:**
- Run: `./deploy.sh`

- [ ] **Step 1: Run deploy**

```bash
./deploy.sh matrix-custom-themes --build --restart
```

Expected: Script SSHes to server, pulls new images, restarts containers.

- [ ] **Step 2: Verify element-web container is healthy**

```bash
ssh deploy@agentic.inblock.io 'cd siwx-oidc-matrix-server && docker compose ps element-web'
```

Expected: `element-web` service is `Up (healthy)`.

- [ ] **Step 3: Verify HTTP response**

```bash
curl -sI https://element.inblock.io | head -5
```

Expected: `HTTP/2 200` response.

---

## Task 5: Verify themes on live instance

**Hypotheses:** H1, H2, H3, H4, H6

- [ ] **Step 1: Verify config was applied (check served config)**

```bash
curl -s https://element.inblock.io/config.json | python3 -c "
import json, sys
c = json.load(sys.stdin)
themes = c.get('setting_defaults', {}).get('custom_themes', [])
print(f'custom_themes count: {len(themes)}')
for t in themes:
    print(f'  - {t[\"name\"]} (is_dark={t[\"is_dark\"]})')
print(f'default_theme: {c.get(\"default_theme\", \"NOT SET\")}')
print(f'feature_custom_themes: {c.get(\"features\", {}).get(\"feature_custom_themes\", \"NOT SET\")}')
"
```

Expected output:
```
custom_themes count: 3
  - inblock.io Dark (is_dark=True)
  - inblock.io Light (is_dark=False)
  - Nord dark theme (is_dark=True)
default_theme: custom-inblock.io Dark
feature_custom_themes: True
```

- [ ] **Step 2: Manual verification in browser**

Open https://element.inblock.io in an incognito window:
1. Confirm the page loads with the inblock.io Dark theme (dark background, orange accents)
2. Log in with a wallet
3. Go to **Settings > Appearance**
4. Confirm three custom themes appear in the theme picker:
   - inblock.io Dark (should be active/selected)
   - inblock.io Light
   - Nord dark theme
5. Switch to inblock.io Light: verify warm neutral backgrounds, readable text, orange accents
6. Switch to Nord dark theme: verify Nord color palette (blue/green tones)
7. Switch back to inblock.io Dark: verify it re-applies correctly
8. Switch to built-in Dark/Light themes: verify they still work (no regression)

---

## Rollback

If themes cause issues:

```bash
./deploy.sh main --build --restart
```

This reverts to the `main` branch config without custom themes.
