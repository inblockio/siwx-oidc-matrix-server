# Minimum version: v1.157.0. The stable matrix_authentication_service block
# exists since v1.136.0 (2025-08-12); v1.157.0 is the first release that
# REQUIRES it, because it removed experimental_features.msc3861.
# Pinned to v1.159.0 (2026-08-30). This bump was FORCED: 1.157.2 is a security
# release (6 high / 3 moderate / 2 low) with no backport to 1.156.x, and 1.157.0
# removed experimental_features.msc3861 outright — so taking the security fix
# required migrating the entrypoint to the stable matrix_authentication_service
# config block. entrypoints/matrix_server.sh::apply_mas_config() now writes that
# block AND deletes any leftover msc3861 on every boot (the migration path for
# already-provisioned deployments, whose homeserver.yaml is otherwise
# first-boot-only). Do NOT roll this image back without also restoring a
# pre-migration homeserver.yaml: the old entrypoint will not re-create the
# msc3861 block on an existing volume. Do not float :latest; bump deliberately.
#
# Bumped to v1.161.0 (2026-09-25, latest stable, released 2026-09-15). Picks up
# 1.160.0's rustls-webpki / pyo3 advisory updates (GHSA-82j2-j2ch-gfr8,
# GHSA-36hh-v3qg-5jq4, GHSA-chgr-c6px-7xpp). The MSC4133 patch was forward-ported
# (its header records the 403-before-404 ordering decision against upstream
# #20172). DB rollback to v1.159.0 is schema-compatible (SCHEMA_VERSION 94 and
# SCHEMA_COMPAT_VERSION 84 at both tags), but 1.161 queues three new background
# updates (9408-9410); roll back only once they have finished, see
# patches/synapse/README.md "Rollback".
#
# Pinned by tag AND by the multi-arch index digest: the tag says which release,
# the digest fixes the bytes (a re-pushed tag cannot change what we build on),
# and it also fixes the Debian release the apt step below resolves against. A
# bump changes both; resolve the digest with
#   skopeo inspect --raw docker://docker.io/matrixdotorg/synapse:vX.Y.Z | sha256sum
# and run the bump procedure in patches/synapse/README.md first.
FROM matrixdotorg/synapse:v1.161.0@sha256:6b95dd129e35e97e8032cb759e5db4a516a5f7ef6c98d34d716fea1ae239b62a
# yq, pinned by version and SHA-256 (was `.../releases/latest/download/...`,
# which re-resolved to whatever was newest on every rebuild). Bump deliberately:
# the version and the checksum change together. Fetched with curl, which the
# base image already ships (its own HEALTHCHECK uses it), so no package manager
# is involved.
RUN curl -fsSL https://github.com/mikefarah/yq/releases/download/v4.53.3/yq_linux_amd64 -o /usr/bin/yq \
    && echo "fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4  /usr/bin/yq" | sha256sum -c - \
    && chmod +x /usr/bin/yq
# ---------------------------------------------------------------------------
# Vendored Synapse patches. patches/synapse/README.md is the registry: no patch
# ships without an entry there stating why, the evidence, and its retirement
# condition.
#
# `patch`, not `git apply`: this base image ships neither `git` nor `patch`,
# and the installed tree under site-packages is not a git repository.
#
# `patch` comes from apt and is NOT version-pinned, on purpose. Exact Debian
# version pins break the build whenever the security archive supersedes that
# version, and the digest-pinned base above already fixes the Debian release,
# so the package floats only within that release and keeps getting its security
# fixes. It is a build tool only: installed, used and purged in this ONE layer,
# so no package from the floating index remains in the image, and what the
# image carries is decided by the patch file (`--fuzz=0` applies it exactly or
# fails), not by which `patch` build apt delivered. The cost: once that Debian
# release leaves the mirrors, `apt-get update` fails and so does the build,
# loudly. The fix then is a base-image bump, never an archive workaround.
#
# The synapse package directory is resolved at build time rather than
# hard-coded as python3.13 — a base image that bumps its Python would otherwise
# leave the patch silently unapplied. --fuzz=0 so a hunk that only *nearly*
# matches fails instead of landing somewhere plausible, and the whole RUN fails
# the build loudly if the patch no longer applies. That is the point: see rule 6
# in the registry for why we do not COPY pre-patched files instead.
COPY ./patches/synapse/msc4133-profile-field-write-policy.patch /tmp/synapse-msc4133-acl.patch
RUN apt-get update \
    && apt-get install -y --no-install-recommends patch \
    && SYNAPSE_PKG="$(python -c 'import synapse, os; print(os.path.dirname(synapse.__file__))')" \
    && patch -p1 --forward --batch --fuzz=0 --verbose \
         -d "$(dirname "$SYNAPSE_PKG")" < /tmp/synapse-msc4133-acl.patch \
    && python -c 'import synapse.handlers.profile, synapse.config.experimental' \
    && apt-get purge -y patch \
    && rm -rf /var/lib/apt/lists/* /tmp/synapse-msc4133-acl.patch

COPY ./entrypoints/matrix_server.sh /matrix_server.sh

# LICENSE and NOTICE travel with the image. It redistributes this repository's
# files (Apache-2.0 §4(a) and (d)), and NOTICE states the license of the patch
# applied above and where the upstream source lives.
COPY LICENSE NOTICE /usr/share/licenses/siwx-oidc-matrix-server/

ENTRYPOINT ["/matrix_server.sh"]

# Harmless content marker: proves the `dev` branch CI trigger produces a
# genuinely new, distinct :dev image (not a coalesced/reused build from a
# simultaneous `main` push). See docs/2026-07-30-dev-staging-dev-aquafire.md
# §9 (branch-based CI deploys).
LABEL io.inblock.dev-branch-ci-test="2026-07-31"
LABEL io.inblock.dev-branch-ci-test-s5-live-check="2026-07-31T00:48Z"
