# Building Element Web from source

`dockerfiles/Dockerfile.element` builds Element Web **from source at a pinned
tag** instead of consuming the prebuilt `vectorim/element-web` image, then layers
the inblock.io overlay (config, theme, favicons, service-worker boot shim) on top and
runs `entrypoints/element_entrypoint.sh`.

## Why from source

We carry eleven vendored patches that cannot ship on the prebuilt
`vectorim/element-web` image. The **canonical list** — what, why, upstream status,
retirement condition, and the order they are applied in — is
[`patches/element-web/README.md`](../patches/element-web/README.md). A patch without an
entry there is a fork we will forget how to delete.

Two examples of why:

- `force-first-device-recovery.patch` (POLICY) makes a recoverable identity (4S)
  mandatory on first login (`MatrixChat.tsx`).
- `browser-eventindex.patch` (UPSTREAM-TRACKED, element-hq/element-web#34718) gives
  hosted Element Web encrypted-room search through Element's EventIndex hook, behind
  the labs flag `features.feature_web_event_index` (off unless set). It retires when
  the upstream PR merges.

Source patches cannot be applied to a prebuilt image, so we build the source
ourselves.

## Pinned tag

- **Tag:** `v1.12.29` (`ARG ELEMENT_WEB_TAG` in `Dockerfile.element`), checked against
  commit `2d90d6b7b601…` (`ARG ELEMENT_WEB_COMMIT`): the build fails if the tag resolves
  to a different commit.
- Element Web v1.12.29 is a pnpm + nx monorepo (`pnpm@11.23.0`, Node >= 22.18).
- Bumped from v1.12.26 on 2026-09-25 for GHSA-9r5h-8m2x-w7q6 (URL-preview
  sanitisation, fixed 1.12.27) and GHSA-wqmv-r2qj-2j9p (XSS in HTML export,
  fixed 1.12.28). Two patches were forward-ported because upstream moved their
  jest tests into vitest (`src/**/*.test.tsx`); see `patches/element-web/README.md`
  entries 4 and 6. Since 1.12.29 most unit tests are vitest, and the jest
  suite needs `content-type` added to `transformIgnorePatterns` to run locally
  (matrix-js-sdk 42.4 pulls the ESM-only content-type 3.0.0).
  The builder uses `node:24.20.0-bullseye`, pinned by digest, to match upstream.
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
2. `git apply --verbose` each vendored patch, in registry order. **The build fails
   loudly** if one does not apply cleanly, so a tag bump that breaks a patch is caught
   at build time.
3. `corepack enable && pnpm install --frozen-lockfile`. Steps 1 to 3 are the `deps`
   stage. The `patch-tests` stage starts from it and runs the unit tests our patches
   carry (`docker build --target patch-tests -f dockerfiles/Dockerfile.element .`, run
   by CI on every pull request); nothing copies from it, so it is never part of the
   image. Locally, `scripts/element-patch-tests.sh <tree>` does the same on a tag tree
   you patched and installed yourself.
4. `pnpm --filter element-web build` (the nx `build` target) produces the
   complete bundle at `apps/web/webapp/` (index.html, bundles, vector-icons/,
   themes, i18n, version).
5. The build fails if the built `sw.js` lacks the markers of patches 9 and 10, or the
   bundle no longer exposes `window.mxMatrixClientPeg`.
6. Runtime stage: `nginxinc/nginx-unprivileged:1.31.6-alpine-slim`, pinned by digest
   (same base family as the old prebuilt image, serves on 8080 as the `nginx` user).
   The bundle is copied to `/app`, `/usr/share/nginx/html` is symlinked to `/app`, our
   overlay files are copied in, `sw.js` gets a per-build stamp, and
   `entrypoints/element_entrypoint.sh` is the entrypoint.

The runtime image fits the `element-web` service in `docker-compose.yml` (the same
`/app` layout, `/docker-entrypoint.sh`, 8080 listen port and healthcheck as the
prebuilt image). Deployed images are built by GitHub Actions
(`.github/workflows/docker.yml`, build context = repo root, so `patches/` is in
context); local builds are throwaway sanity checks only.

## Refreshing the patches when bumping the Element Web tag

When moving to a newer Element Web tag:

1. Change `ARG ELEMENT_WEB_TAG` and `ARG ELEMENT_WEB_COMMIT` in
   `dockerfiles/Dockerfile.element` together. Look the commit up with
   `git ls-remote https://github.com/element-hq/element-web 'refs/tags/<new-tag>^{}'`.
2. Run the tag-bump procedure, rule 4 of
   [`patches/element-web/README.md`](../patches/element-web/README.md): apply every patch
   in order to a fresh clone of the new tag. For a patch that fails, read its
   retirement condition before forward-porting it; upstream may have fixed the defect.
3. Forward-port a failing patch in that clone (for example
   `git apply --3way patches/element-web/<name>.patch`, then resolve the conflicts),
   re-export it with `git diff`, and run `python3 scripts/check-patch-hunks.py`. A patch
   that mirrors an upstream PR must stay identical to that PR.
4. Update the registry entries and the README's Dependencies rows in the same commit
   (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
5. Rebuild locally to confirm every patch applies and the bundle is complete, then
   let CI build the image that is deployed.
