# Contributing to siwx-oidc-matrix-server

Contributions are welcome: bug reports, fixes, documentation, patch forward-ports, and
reports of what did or did not work in your deployment. Agent-assisted contributions are
welcome too. The same rules apply to them (see [AGENTS.md](AGENTS.md)), and the person who
submits is responsible for what they submit.

## What to expect

This bundle belongs to siwx-oidc, a pathfinder project for agent identity on Matrix, run by
inblock.io assets GmbH on a non-commercial basis and provided as is. The maintainers
maintain it for their own use, so:

- review is **best-effort**, with no timelines;
- scope is decided by what the maintainers need; a good change can still be declined if it
  adds something we cannot maintain;
- interfaces may change without notice, and there are no tagged releases yet (`main` is
  what runs).

For anything larger than a small fix, please **open an issue first** and describe what you
want to change and why. That saves you work if the direction does not fit.

## Getting started

Read [AGENTS.md](AGENTS.md) first: it lists the invariants this repository depends on and
why. Many settings look simplifiable and are not (for example why the Synapse entrypoint
refuses to start without the MSC4133 patch, or why the lk-jwt-service healthcheck is off).

These checks need only the working tree:

```bash
scripts/check-patch-registry.sh          # patches, registries, Dockerfiles and README agree
python3 scripts/check-patch-hunks.py     # every hunk header matches its body
./verify-theme.sh                        # Element theme invariants
node --test scripts/browser-eventindex-invariants.mjs
```

CI (`.github/workflows/checks.yml`) runs the first two on every pull request, and in a
second job the unit tests the Element Web patches carry, on the patched upstream tree
(`docker build --target patch-tests -f dockerfiles/Dockerfile.element .`; it needs network
and a few minutes). Heavier tests are listed under "How to test" in [AGENTS.md](AGENTS.md):
the DID-field guard acceptance test, the hermetic end-to-end harness in
[e2e-harness/](e2e-harness/README.md), and the Synapse patch's own tests.

To run a stack locally, use `docker-compose.local.yml` (see its header). It builds the
images from source and is for testing only; deployed images come from CI.

## The maintainer rule: pin, registry and README in one commit

Any change to a pinned version or digest, or to a file under `patches/`, updates in the
**same commit**:

- the root [README.md](README.md): the Dependencies table for a pin, the "Upstream
  deviations" list for a patch that is added, dropped, renamed or reordered;
- the matching registry: [patches/synapse/README.md](patches/synapse/README.md) or
  [patches/element-web/README.md](patches/element-web/README.md). A new patch needs a
  numbered entry with what, why, evidence, upstream status and retirement condition.

CI enforces the patch half: `scripts/check-patch-registry.sh` fails when a patch lacks a
registry entry, is not applied by its Dockerfile, is missing from the README list, or when
the registry, the README and the Dockerfile disagree on the order. The pin half is checked
by review only.

## Bumping Synapse

Every Synapse bump carries a forward-port obligation for the vendored patch, and is also a
compatibility check of siwx-oidc, because Synapse's `/_synapse/mas/*` API is internal and
changes between releases.

1. Read the upstream changelog and upgrade notes for every release you skip, in
   particular changes to `matrix_authentication_service`, `/_synapse/mas/*`, profile
   fields and MatrixRTC.
2. Run the dry-run in [patches/synapse/README.md](patches/synapse/README.md) rule 4 with
   the new tag. For each patch that fails, read its retirement condition before porting it:
   upstream may have merged the change, and then the patch is dropped, not ported.
3. Forward-port what remains so it applies with `--fuzz=0`, and run the patch's tests in a
   Synapse checkout of the new tag, as rule 4 describes.
4. Change the `FROM` line in `dockerfiles/Dockerfile` to the new tag and its index digest
   (`skopeo inspect --raw docker://docker.io/matrixdotorg/synapse:vX.Y.Z | sha256sum`).
5. In the same commit, update the registry entry (what changed in the forward-port, and
   the rollback notes if the database schema moved) and the README's Synapse row.
6. Once CI has published the new `main` build, move the image defaults
   (`SYNAPSE_IMAGE_REF` in `docker-compose.yml`, `ARG SYNAPSE_IMAGE` in
   `real-stack/Dockerfile.synapse`) and the README row to that build's tag and digest, in
   one later commit.

## Bumping Element Web

1. Change **both** `ARG ELEMENT_WEB_TAG` and `ARG ELEMENT_WEB_COMMIT` in
   `dockerfiles/Dockerfile.element`. The build fails when the tag does not resolve to that
   commit, so a tag moved upstream cannot change what we ship. Look the commit up with
   `git ls-remote https://github.com/element-hq/element-web 'refs/tags/<tag>^{}'`.
2. Run rule 4 of [patches/element-web/README.md](patches/element-web/README.md): apply
   every patch, in Dockerfile order, to a fresh clone of the new tag, then the upstream
   refresh in step 4b. The order is load-bearing.
3. For each patch that fails, read its retirement condition first. Forward-port the rest,
   keep patches that mirror an upstream PR identical to that PR, and run
   `python3 scripts/check-patch-hunks.py`.
4. In the same commit, update the registry entries and the README rows: the Element Web
   tag and commit, and the Element Call and matrix-js-sdk versions, which come from the new
   tag's `apps/web/package.json`. Bump the node and nginx base images too if upstream's
   builder changed.
5. As for Synapse, move `ELEMENT_IMAGE_REF` in `docker-compose.yml` to the new CI build in
   a later commit.

The Caddy image has its own pairing rule for the Caddy version and its two modules; read
the header of `dockerfiles/Dockerfile.caddy-l4` before bumping any of them.

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) with
  a scope, as in the history: `fix(element): …`, `docs(patches): …`, `ci(checks): …`. Say
  *why* in the body.
- Keep a pull request to one concern.
- Update the documentation that describes what you changed: the registries, the README,
  [AGENTS.md](AGENTS.md), `docs/` or the skills in `skills/`.
- Never commit secrets, host names, IP addresses or credentials of a real deployment. Use
  `example.org` / `example.com` and placeholders.

## Licensing

This repository is licensed under Apache-2.0. By submitting a contribution you agree that it
is licensed under Apache-2.0, as section 5 of the license provides (inbound = outbound).
There is **no CLA**. You confirm that you have the right to submit the contribution under
that license.

Two exceptions are set out in [NOTICE](NOTICE):

- **Patches** under `patches/` change Synapse and Element Web, so each change takes the
  license of the upstream file it changes: AGPL-3.0-or-later for Synapse, and
  AGPL-3.0-only OR GPL-3.0-only for the Element Web code the image ships (NOTICE lists the
  few files that differ). A contribution to a patch is licensed the same way.
- **Brand assets** (the inblock.io logos, favicons and welcome background) are not
  licensed under Apache-2.0 or any other license. A deployment must replace them with its
  own.

## Security issues

Do not report vulnerabilities in public issues or pull requests. See
[SECURITY.md](SECURITY.md).
