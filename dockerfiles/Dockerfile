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
FROM matrixdotorg/synapse:v1.159.0
# apt-get (not the apt CLI, which is documented as script-unstable) with
# --no-install-recommends so this layer stays deterministic in shape. Debian
# security-repo package versions are not pinned here — pinning wget to an
# exact Debian package version is impractical against a floating
# `matrixdotorg/synapse` base (the base image's own apt sources rotate), so
# this only removes the non-determinism we CAN control (the yq download
# below, and unpinned recommends bloat).
RUN apt-get update && apt-get install -y --no-install-recommends wget && apt-get clean
# Pinned to yq v4.53.3 (resolved from the /releases/latest redirect at the
# time this was written) with a SHA-256 check against the binary — was
# `.../releases/latest/download/...`, which re-resolves to whatever is
# newest on every image rebuild, churning the layer digest for a tool-fetch
# reason unrelated to any actual dependency bump. Bump deliberately: update
# both the version and the checksum together.
RUN wget https://github.com/mikefarah/yq/releases/download/v4.53.3/yq_linux_amd64 -O /usr/bin/yq \
    && echo "fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4  /usr/bin/yq" | sha256sum -c - \
    && chmod +x /usr/bin/yq
COPY ./entrypoints/matrix_server.sh /matrix_server.sh
ENTRYPOINT ["/matrix_server.sh"]

# Harmless content marker: proves the `dev` branch CI trigger produces a
# genuinely new, distinct :dev image (not a coalesced/reused build from a
# simultaneous `main` push). See docs/2026-07-30-dev-staging-dev-aquafire.md
# §9 (branch-based CI deploys).
LABEL io.inblock.dev-branch-ci-test="2026-07-31"
LABEL io.inblock.dev-branch-ci-test-s5-live-check="2026-07-31T00:48Z"
