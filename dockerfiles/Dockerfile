# Minimum version: v1.157.0 (stable matrix_authentication_service integration).
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
FROM matrixdotorg/synapse:v1.161.0
# apt-get (not the apt CLI, which is documented as script-unstable) with
# --no-install-recommends so this layer stays deterministic in shape. Debian
# security-repo package versions are not pinned here — pinning wget to an
# exact Debian package version is impractical against a floating
# `matrixdotorg/synapse` base (the base image's own apt sources rotate), so
# this only removes the non-determinism we CAN control (the yq download
# below, and unpinned recommends bloat).
RUN apt-get update && apt-get install -y --no-install-recommends wget patch && apt-get clean
# Pinned to yq v4.53.3 (resolved from the /releases/latest redirect at the
# time this was written) with a SHA-256 check against the binary — was
# `.../releases/latest/download/...`, which re-resolves to whatever is
# newest on every image rebuild, churning the layer digest for a tool-fetch
# reason unrelated to any actual dependency bump. Bump deliberately: update
# both the version and the checksum together.
RUN wget https://github.com/mikefarah/yq/releases/download/v4.53.3/yq_linux_amd64 -O /usr/bin/yq \
    && echo "fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4  /usr/bin/yq" | sha256sum -c - \
    && chmod +x /usr/bin/yq
# ---------------------------------------------------------------------------
# Vendored Synapse patches. patches/synapse/README.md is the registry: no patch
# ships without an entry there stating why, the evidence, and its retirement
# condition.
#
# `patch`, not `git apply`: this base image ships neither `git` nor `patch`
# (hence the apt line above), and the installed tree under site-packages is not
# a git repository.
#
# The synapse package directory is resolved at build time rather than
# hard-coded as python3.13 — a base image that bumps its Python would otherwise
# leave the patch silently unapplied. --fuzz=0 so a hunk that only *nearly*
# matches fails instead of landing somewhere plausible, and the whole RUN fails
# the build loudly if the patch no longer applies. That is the point: see rule 6
# in the registry for why we do not COPY pre-patched files instead.
COPY ./patches/synapse/msc4133-profile-field-write-policy.patch /tmp/synapse-msc4133-acl.patch
RUN SYNAPSE_PKG="$(python -c 'import synapse, os; print(os.path.dirname(synapse.__file__))')" \
    && patch -p1 --forward --batch --fuzz=0 --verbose \
         -d "$(dirname "$SYNAPSE_PKG")" < /tmp/synapse-msc4133-acl.patch \
    && python -c 'import synapse.handlers.profile, synapse.config.experimental' \
    && rm -f /tmp/synapse-msc4133-acl.patch

COPY ./entrypoints/matrix_server.sh /matrix_server.sh
ENTRYPOINT ["/matrix_server.sh"]

# Harmless content marker: proves the `dev` branch CI trigger produces a
# genuinely new, distinct :dev image (not a coalesced/reused build from a
# simultaneous `main` push). See docs/2026-07-30-dev-staging-dev-aquafire.md
# §9 (branch-based CI deploys).
LABEL io.inblock.dev-branch-ci-test="2026-07-31"
LABEL io.inblock.dev-branch-ci-test-s5-live-check="2026-07-31T00:48Z"
