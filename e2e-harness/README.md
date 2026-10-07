# e2e-harness — hermetic local E2E stack (`siwx-e2eh-*`)

A podman-only stack (redis, siwx-oidc, Synapse, LiveKit, lk-jwt + federation
TLS shim, Caddy edge) plus an orchestrator that points the existing suites of
siwx-oidc, the connector (`aqua-matrix-agent`) and the AV check at it. Nothing
here talks to production.

```bash
e2e-harness/run.sh smoke            # 5 checks, one per surface
e2e-harness/run.sh full             # every wired check (20)
e2e-harness/run.sh full --list      # show the tier, touch nothing
KEEP_STACK=0 e2e-harness/run.sh full   # tear the stack down afterwards
e2e-harness/up.sh [--fresh]         # stack only; --fresh wipes its data volumes
e2e-harness/down.sh [--volumes] [--network]
```

This harness tests the working tree. To rehearse an upgrade from the images a deployment runs,
use the qualification lab instead (`docker-compose.local.yml` plus `docker-compose.qualify.yml`,
every image by digest; see the root README, "Qualification lab").

Host ports: edge `18080`, siwx-oidc `18081`, Element Call `18082`, Synapse `18448`, LiveKit
`7880`, `7881/tcp`, `20100-20200/udp`. Artifacts and `summary.json` land in
`e2e-harness/artifacts/<run-id>/`.

Sibling checkouts it uses: siwx-oidc at `SIWX_OIDC_DIR` (default
`../siwx-oidc` next to this repo) and the connector at `CONNECTOR_DIR`
(default `~/aqua-matrix-agent`).

## Images

Two images are built locally; everything else is pulled by version tag plus
digest. Both local images are **derived from source and built automatically
when missing**. `e2e-harness/images.sh` is the single place that decides them.

| Image | Default ref | Built from |
|---|---|---|
| siwx-oidc | `localhost/siwx-oidc:e2eh-<short HEAD of SIWX_OIDC_DIR>` | `git archive HEAD` of that checkout + its `Dockerfile` |
| Synapse | `localhost/siwx-e2eh-synapse:<vX.Y.Z>-<inputs hash>` | `dockerfiles/Dockerfile` (the deployed Synapse) |

- **siwx-oidc** is built from the commit, never the working tree, so the image
  holds exactly what its tag names. Uncommitted server edits are not in it:
  commit them (new HEAD, new tag, rebuild). An uncached build takes about
  7 minutes.
- **Synapse** uses the same Dockerfile the deployed image does: the version
  pinned in its `FROM` line (v1.161.0, what prod and dev run), the MSC4133
  write-policy patch from `patches/synapse/`, and `entrypoints/matrix_server.sh`.
  The tag suffix hashes the Dockerfile and every file it COPYs, so editing the
  entrypoint or a patch rebuilds it and an unchanged tree reuses it. It is
  deliberately **not** `real-stack/Dockerfile.synapse`: that one runs the
  published image, and the harness exists to test the working tree.

```bash
e2e-harness/images.sh print        # resolved refs, default vs override, present vs missing
e2e-harness/images.sh build        # build whichever default is missing
E2E_REBUILD=1 e2e-harness/images.sh build   # rebuild even if the tag exists
eval "$(e2e-harness/images.sh env)"         # export the refs (docker-compose.e2e.yml needs them)
```

| Variable | Effect |
|---|---|
| `SIWX_OIDC_IMAGE_REF`, `SYNAPSE_IMAGE_REF` | Use this image instead. Never built: if it is missing you get a clear error. |
| `E2E_AUTO_BUILD=0` | Do not build a missing default; print the build command and stop. |
| `E2E_REBUILD=1` | Rebuild the default images even when present. |
| `E2EH_BUILD_CACHE` | Scratch for build contexts, default `~/.cache/siwx-e2eh-build`. |

These tags are harness-owned and disposable. Deleting them in an image
cleanup is fine, because the next run rebuilds them. They are for testing
only and are never deployed (deploy images come from CI, see `CLAUDE.md`).

`run.sh` then checks that the containers actually running match the resolved
refs (a stack left up from another image fails the run under the default
`E2E_STRICT_SKIPS=1`), and that the siwx-oidc image is not older than the
checkout's HEAD. `summary.json` records both images under `under_test`.

### Why (2026-09-27)

The defaults used to be hand-built tags, `localhost/siwx-oidc:e2eh-5f47a9b` and
`localhost/siwx-real-synapse:local`, hard-coded in `up.sh` and `run.sh`.
Nothing in the repo could rebuild them, so ordinary image cleanups
(2026-09-12 and 2026-09-25) deleted them and the harness stopped starting from
its defaults. The Synapse tag was also misleading: at the end it pointed at a
build of `dockerfiles/Dockerfile`, not `real-stack/Dockerfile.synapse` as its
name suggests.

## Element Call (H14, 2026-10-08)

`siwx-e2eh-element-call` serves the standalone Element Call SPA at the version production embeds
(v0.24.0, revision `6f7dac31`) on `http://localhost:18082`, for browser tests that need a real
Element Call publisher (aqua-agents, `docs/handover/2026-10-08-scribe-harness-h14-element-call-design.md`).

| Piece | Where |
|---|---|
| Image, pinned by digest (`ELEMENT_CALL_IMAGE_REF` overrides) | `up.sh` |
| Config, read-only bind mount to `/app/config.json` | `config/element-call.e2e.json` (production's widget config plus `default_server_config` and `livekit.livekit_service_url`) |
| Served-build check, run by `up.sh` right after the start; a failure removes the container and stops the bring-up | `element-call-check.sh <container>`: entry chunk `assets/index-Hj2GaSQY.js` sha256 (plain and `.gz`), `index.html` loads it, config is read-only and byte-equal to the repo file |
| Edge site `:18082` (an origin root: the SPA uses absolute `/assets` paths) | `Caddyfile.e2e` |

Synapse advertises its LiveKit focus through MSC4143 `rtc/transports`, and Element Call 0.24.0
reads only that (and `config.json`), not `.well-known`. The entrypoint's default,
`https://${MATRIX_HOST}/livekit/jwt`, is `https://localhost/livekit/jwt` here, where nothing
listens, so `up.sh` sets `MATRIX_RTC_LIVEKIT_SERVICE_URL=${MATRIX_BASE_URL}/livekit/jwt`.
Deployments leave it unset and keep the default byte for byte. The entrypoint applies it on
every boot, so an existing data volume picks it up on the next `up.sh`.
