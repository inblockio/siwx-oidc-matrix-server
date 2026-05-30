# Force First-Device Recovery (4S) Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `force_verification: true` actually mandate interactive recovery-key (4S) setup on a user's first device, before the Element Web UI loads.

**Architecture:** Element Web is currently consumed as the prebuilt `vectorim/element-web:latest` image (config overlay only). We switch `dockerfiles/Dockerfile.element` to a multi-stage build that compiles element-web from the pinned `v1.12.20` tag with a single vendored source patch applied to `MatrixChat.tsx`. The same patch is submitted upstream as an atomic PR. GitHub Actions (`.github/workflows/docker.yml`) builds and pushes the image to GHCR on tag push; validation uses the tag-based `/deploy` flow.

**Tech Stack:** element-web (TypeScript/React, yarn build), Docker multi-stage, nginx, GitHub Actions, GHCR.

---

## Hypothesis Register

| ID | If | Then | Assumptions | Verification |
|----|-----|------|-------------|--------------|
| H1 | `shouldForceVerification()` releases on `isCrossSigningReady()` and `InitialCryptoSetupStore` makes cross-signing ready without creating 4S | the first-device gate opens before any recovery key exists (the observed flash) | v1.12.20 source matches the extracts read this session | Read confirmed: MatrixChat.tsx:1389 gates on `isCrossSigningReady()`; InitialCryptoSetupStore.doSetup() runs only createCrossSigning + resetKeyBackup |
| H2 | the gate is changed to require secret-storage (4S) readiness **and** the post-bootstrap path routes a force-verify-still-true first device into the interactive `SetupEncryptionStore` flow | the first device is forced to create+save a recovery key with no skip, before LOGGED_IN | `SetupEncryptionStore`, on a device with cross-signing ready but no 4S, drives recovery creation; `force_verification` hides the skip control in `<SetupEncryptionBody>` | Manual first-login test: fresh DID login presents non-dismissible recovery setup; app does not load until a recovery key is generated |
| H3 | `Dockerfile.element` is rewritten as a multi-stage build cloning element-web `v1.12.20` + `git apply` of the vendored patch + `yarn install && yarn dist`, served via nginx | a GitHub-built image carries our patched bundle while preserving the existing config/favicon/theme overlay and entrypoint behavior | element-web v1.12.20 builds cleanly in the GitHub `ubuntu-latest` runner within time/memory limits; entrypoint's index.html theme injection still applies to the freshly built bundle | CI run for the build job succeeds; deployed Element shows inblock.io theming + patched behavior |
| H4 | the patch is byte-identical to a branch off `element-hq/element-web` `develop` | the local validation build and the upstream PR share one source change (single source of truth) | upstream `develop` has not refactored `postLoginSetup` away from this shape | `git apply` of the vendored patch succeeds on a fresh `v1.12.20` checkout; PR diff equals the vendored patch content |
| H5 | element-web is built only on tag push (CI triggers on `main`, `tags`, `release`, `workflow_dispatch`; feature-branch push does not build) | validation must go through a pushed tag, not a plain branch push or the (broken) `workflow_dispatch` | GHCR push permission via `GITHUB_TOKEN` works on tag builds (it does for `main`) | Tag push produces `ghcr.io/inblockio/siwx-oidc-matrix-server/element-web:<tag>` |

---

## Confirmed root cause (evidence)

- `MatrixChat.postLoginSetup` (apps/web/src/components/structures/MatrixChat.tsx:459-465): first-device branch calls `InitialCryptoSetupStore.startInitialCryptoSetup(...)` and shows `Views.E2E_SETUP`.
- `InitialCryptoSetupStore.doSetup()`: runs `createCrossSigning` + `checkKeyBackupAndEnable`/`resetKeyBackup` only — **never** 4S / secret storage. (Docstring: "transparent to the user, not requiring interaction".)
- `shouldForceVerification()` (MatrixChat.tsx:1378-1391): returns `!isCrossSigningReady()`. Once the transparent setup runs, cross-signing is ready → returns false → `onCompleteSecurityE2eSetupFinished` (2135) forwards to LOGGED_IN. Recovery key never created; only dismissible toasts remain.

## Design (the atomic change)

Two coordinated edits in `MatrixChat.tsx`, mediated by the existing `force_verification` config:

1. **Release condition** — `shouldForceVerification()` must require recovery (secret-storage / 4S) readiness, not merely cross-signing readiness. Change line 1389-1390 to gate on secret-storage readiness (e.g. `crypto.isSecretStorageReady()`), so the gate stays closed until a recovery key exists.
2. **Path to the UI** — after the transparent cross-signing bootstrap completes, a still-true `shouldForceVerification()` must route the first device into the interactive `SetupEncryptionStore` flow (`Views.COMPLETE_SECURITY`), which on a device with cross-signing ready but no 4S drives recovery-key creation, with skip suppressed by `force_verification`. The chokepoint is `onCompleteSecurityE2eSetupFinished` (2135): when force-verify is still true, transition to `Views.COMPLETE_SECURITY` instead of calling `onLoggedIn`.

The exact lines are authored and verified against a fresh `v1.12.20` checkout in Task 2 (the manual login test in Task 6 is the behavioral acceptance gate). This keeps the change minimal and aligned with Element's own state machine and config.

---

## File Structure

- `dockerfiles/Dockerfile.element` — rewritten: multi-stage (builder: clone+patch+`yarn dist`; runtime: nginx + our config/favicon/theme overlay + entrypoint). One responsibility: produce the patched, branded Element image.
- `patches/element-web/force-first-device-recovery.patch` (new) — the single source-of-truth diff against `v1.12.20`; also the upstream PR content.
- `docs/element-web-source-build.md` (new) — short rationale + how to refresh the patch when bumping the element-web tag.
- `.github/workflows/docker.yml` — unchanged in structure (already builds `element-web` from `dockerfiles/Dockerfile.element` on tag push); verify it tolerates the longer source build.

---

## Task 1: Fork + pinned checkout scaffolding (manual/CI prep)

**Files:** none in this repo yet.
**Hypotheses:** H4, H5

- [ ] **Step 1:** Create the fork `inblockio/element-web` (GitHub UI or `gh repo fork element-hq/element-web --org inblockio --clone=false`). Skip if it already exists.
- [ ] **Step 2:** Clone to a scratch dir and wire remotes:
```bash
cd /tmp && rm -rf ew-src && git clone https://github.com/inblockio/element-web.git ew-src
cd ew-src && git remote add upstream https://github.com/element-hq/element-web.git && git fetch upstream --tags
```
- [ ] **Step 3:** Confirm the deployed tag exists and inspect the target file region:
```bash
git checkout v1.12.20
sed -n '449,470p' apps/web/src/components/structures/MatrixChat.tsx
```
Expected: the first-device branch matches lines 459-465 in this plan.

## Task 2: Author + verify the source patch against v1.12.20

**Files:** Create `patches/element-web/force-first-device-recovery.patch`
**Hypotheses:** H1, H2, H4

- [ ] **Step 1:** In `/tmp/ew-src` (at `v1.12.20`), create branch `force-first-device-recovery`.
- [ ] **Step 2:** Implement Design edit 1 (release on secret-storage readiness) in `shouldForceVerification` (MatrixChat.tsx ~1378-1391).
- [ ] **Step 3:** Implement Design edit 2 (route still-force-verify first device into `Views.COMPLETE_SECURITY`) in `onCompleteSecurityE2eSetupFinished` (~2135).
- [ ] **Step 4:** Read `SetupEncryptionStore` + `<SetupEncryptionBody>`/`<CompleteSecurity>` in the real tree to confirm: (a) a cross-signing-ready/no-4S device drives recovery creation, (b) `force_verification` suppresses skip. Adjust edits 1-2 if the real behavior differs.
- [ ] **Step 5:** Build from source to prove the patch compiles:
```bash
cd /tmp/ew-src && yarn install --frozen-lockfile && yarn lint:types && yarn dist
```
Expected: type-check passes; `dist/` produced.
- [ ] **Step 6:** Export the diff into this repo:
```bash
cd /tmp/ew-src && git diff v1.12.20 -- apps/web/src/components/structures/MatrixChat.tsx \
  > /home/system-001/siwx-oidc-matrix-server/patches/element-web/force-first-device-recovery.patch
```
- [ ] **Step 7:** Verify clean re-apply on a pristine checkout:
```bash
cd /tmp && rm -rf ew-verify && git clone --depth 1 --branch v1.12.20 https://github.com/element-hq/element-web.git ew-verify
cd ew-verify && git apply --check /home/system-001/siwx-oidc-matrix-server/patches/element-web/force-first-device-recovery.patch && echo APPLIES-CLEAN
```
- [ ] **Step 8:** Commit the patch file.
```bash
git add patches/element-web/force-first-device-recovery.patch && git commit -m "feat(element): vendor force-first-device-recovery patch for v1.12.20"
```

## Task 3: Rewrite Dockerfile.element as a multi-stage source build

**Files:** Modify `dockerfiles/Dockerfile.element`; reference `entrypoints/element_entrypoint.sh` (unchanged), `config/*`.
**Hypotheses:** H3

- [ ] **Step 1:** Write the builder stage: `FROM node:<version-from-element-web-.nvmrc> AS builder`, `git clone --branch v1.12.20 --depth 1 element-hq/element-web`, `COPY patches/element-web/force-first-device-recovery.patch`, `git apply` it, `yarn install --frozen-lockfile`, `yarn dist`.
- [ ] **Step 2:** Write the runtime stage: `FROM nginx:alpine` (or match upstream's runtime base), copy the built bundle from the builder into `/app`, then re-apply the existing overlay COPYs (`config/element-config.json` → `/app/config.json`, theme CSS, favicons) and `entrypoints/element_entrypoint.sh` → `/docker-entrypoint.sh`, `ENTRYPOINT ["/docker-entrypoint.sh"]`.
- [ ] **Step 3:** Confirm `element_entrypoint.sh`'s index.html theme-injection + favicon swap still target the freshly built bundle paths (`/app/index.html`, `/app/vector-icons/*`). Adjust paths only if the source build differs from the prebuilt image layout.
- [ ] **Step 4:** Commit.
```bash
git add dockerfiles/Dockerfile.element docs/element-web-source-build.md && git commit -m "feat(element): build element-web v1.12.20 from source with recovery patch"
```

## Task 4: Local build sanity (no deploy) — optional fast feedback

**Hypotheses:** H3
**Note:** Per project policy images ship via GitHub Actions, not local builds. This step is a *throwaway* local build only to catch Dockerfile errors before pushing a tag; the artifact is discarded.

- [ ] **Step 1:** `docker build -f dockerfiles/Dockerfile.element -t ew-localtest .` and confirm it completes.
- [ ] **Step 2:** `docker run --rm -p 8099:80 ew-localtest` and `curl -s localhost:8099 | grep -q element-theme-overrides.css` to confirm overlay intact. Then `docker rmi ew-localtest`.

## Task 5: Build via GitHub Actions on a tag

**Hypotheses:** H5, H3
**Files:** none (uses existing `.github/workflows/docker.yml`).

- [ ] **Step 1:** Push the branch, then create + push a test tag:
```bash
git push origin fix/cross-signing-identity-stability
git tag element-force-recovery-test-1 && git push origin element-force-recovery-test-1
```
- [ ] **Step 2:** Watch the run; require success for the `element-web` matrix leg:
```bash
gh run watch "$(gh run list --workflow docker.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```
Expected: image `ghcr.io/inblockio/siwx-oidc-matrix-server/element-web:element-force-recovery-test-1` pushed (also `:synapse` at same tag).

## Task 6: Deploy + manual validation (acceptance gate for H2)

**Hypotheses:** H2, H3
**Files:** uses `deploy.sh` (tag-based), `verify-deployment.sh`.

- [ ] **Step 1:** Confirm with the user before touching production (agentic.inblock.io serves live element.inblock.io). Deploy the tag (synapse + element-web at the tag; siwx-oidc stays on main):
```bash
IMAGE_TAG=element-force-recovery-test-1 ./deploy.sh --build --restart   # exact flags per /deploy skill
```
- [ ] **Step 2:** Run `./verify-deployment.sh`; expect endpoints healthy.
- [ ] **Step 3:** Manual test with a fresh DID (or cleared 4S): log in at element.inblock.io. **Expected:** a non-dismissible recovery-key setup screen appears and the app does NOT load until a recovery key is generated and confirmed. Capture a screenshot.
- [ ] **Step 4:** Second-login regression: log in again on a second device/profile; expect the existing "verify this device" (COMPLETE_SECURITY) flow, unchanged.

## Task 7: Upstream PR

**Hypotheses:** H4
**Files:** none in this repo.

- [ ] **Step 1:** In `/tmp/ew-src`, rebase the `force-first-device-recovery` change onto `upstream/develop`; resolve only if `postLoginSetup` shape changed.
- [ ] **Step 2:** `git commit -s` (DCO sign-off required) with a clear message describing the first-device 4S gap and the fix.
- [ ] **Step 3:** Push to `inblockio/element-web` and open a targeted PR against `element-hq/element-web:develop`, linking the behavior (force_verification should mandate recovery on first device) and noting it is config-gated (no behavior change when `force_verification` is unset).

---

## Boundary conditions / invariants

- **No behavior change when `force_verification` is unset** — both edits are gated by the existing config; default Element behavior is preserved.
- **No image built locally for production** — production image comes from GitHub Actions (tag build). Task 4 local build is throwaway only.
- **Production deploy requires explicit user confirmation** — element.inblock.io is live.
- **Single source of truth** — the vendored `.patch` is exactly the upstream PR diff (H4); do not hand-edit one without the other.
- **siwx-oidc and synapse unchanged** — this is an element-web-only change; siwx-oidc stays on `main`.
- **Secrets stay out of context** — no `.env`, tokens, or signing keys printed during build/deploy.

## Acceptance criteria

| # | Criterion | Hypotheses |
|---|-----------|-----------|
| AC1 | Fresh first-device DID login is forced through non-dismissible recovery-key (4S) creation before the app loads | H1, H2 |
| AC2 | Second-device login still uses the unchanged COMPLETE_SECURITY verify flow | H2 |
| AC3 | When `force_verification` is unset, login behavior is identical to stock element-web | H2 |
| AC4 | The deployed Element image is GitHub-built from `v1.12.20` source + our patch, with inblock.io theming intact | H3, H5 |
| AC5 | The vendored patch applies cleanly to a pristine `v1.12.20` checkout and equals the upstream PR diff | H4 |
