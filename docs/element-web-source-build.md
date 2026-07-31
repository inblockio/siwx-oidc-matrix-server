# Building Element Web from source

`dockerfiles/Dockerfile.element` builds Element Web **from source at a pinned
tag** instead of consuming the prebuilt `vectorim/element-web` image, then layers
the inblock.io overlay (config, theme, favicons) on top via the existing
`entrypoints/element_entrypoint.sh`.

## Why from source

We carry a patch that makes a **recoverable identity mandatory on first login**:
`patches/element-web/force-first-device-recovery.patch`. It modifies
`apps/web/src/components/structures/MatrixChat.tsx` so `shouldForceVerification`
also requires secret storage (4S) to be ready, and drives Element's recovery-key
creation flow when a lone first device has cross-signing but no recovery key.
This cannot be applied to a prebuilt image, so we build the source ourselves.

The patch in `patches/element-web/` is the **single source of truth** and is
identical to the corresponding upstream PR to `element-hq/element-web`.

## Pinned tag

- **Tag:** `v1.12.24` (set as `ARG ELEMENT_WEB_TAG` in `Dockerfile.element`).
- Element Web v1.12.24 is a pnpm + nx monorepo (`pnpm@10.33.3`, Node >= 22.18).
  The builder uses `node:24-bullseye` to match upstream.
- Bumped from v1.12.20 on 2026-07-31. v1.12.24 carries upstream PR #33997,
  "Fetch authenticated media through the session". The vendored patch was rebased
  onto the new tag: upstream split the `IMatrixClientCreds` import out of
  `MatrixClientPeg`, so the import hunk no longer applied.

## Media and the service worker (debugging note)

Element authenticates ALL media inside its service worker (`sw.js`): the app
emits legacy `/_matrix/media/v3/*` URLs, and the worker rewrites them to the
authenticated `/_matrix/client/v1/media/*` endpoints and injects the bearer
token. Our Synapse enforces authenticated media, so **any** failure of that
worker makes media requests go out tokenless, Synapse answers 404, and
downloads/images fail silently — nothing appears in the page console, because
the worker logs to its own.

When debugging that: a **hard reload (Ctrl+Shift+R) makes media symptoms worse**,
since it loads the page uncontrolled by the service worker, which is exactly the
broken state. Use a normal reload. The worker's own errors are visible only under
DevTools → Application → Service Workers → inspect.

## How the build works

1. Shallow-clone `element-hq/element-web` at `${ELEMENT_WEB_TAG}` (keeps `.git`
   so version-stamping scripts can `git describe`).
2. `git apply --verbose` our patch. **The build fails loudly** if it does not
   apply cleanly, so a tag bump that breaks the patch is caught at build time.
3. `corepack enable && pnpm install --frozen-lockfile`.
4. `pnpm --filter element-web build` (the nx `build` target) produces the
   complete bundle at `apps/web/webapp/` (index.html, bundles, vector-icons/,
   themes, i18n, version).
5. Runtime stage: `nginxinc/nginx-unprivileged:alpine-slim` (same base family as
   the old prebuilt image, serves on 8080 as the `nginx` user). The bundle is
   copied to `/app`, `/usr/share/nginx/html` is symlinked to `/app`, our overlay
   files are copied in, and `entrypoints/element_entrypoint.sh` runs unchanged.

The runtime image is drop-in compatible with the `element-web` service in
`docker-compose.yml` (same `/app` layout, same `/docker-entrypoint.sh`, same
8080 listen port and healthcheck). Production images are built by GitHub Actions
(`.github/workflows/docker.yml`, build context = repo root, so `patches/` is in
context); local builds are throwaway sanity checks only.

## Refreshing the patch when bumping the Element Web tag

When moving to a newer Element Web tag:

1. Clone the new tag fresh:
   `git clone --branch <new-tag> https://github.com/element-hq/element-web.git`
2. Apply the existing patch; if it fails, rebase it manually onto the new
   `apps/web/src/components/structures/MatrixChat.tsx`:
   `git apply --3way patches/element-web/force-first-device-recovery.patch`
   then resolve conflicts.
3. Re-export the patch:
   `git diff apps/web/src/components/structures/MatrixChat.tsx > \
     /path/to/siwx-oidc-matrix-server/patches/element-web/force-first-device-recovery.patch`
4. Update `ARG ELEMENT_WEB_TAG` in `dockerfiles/Dockerfile.element`.
5. Rebuild locally to confirm the patch applies and the bundle is complete, then
   let CI build the production image.
