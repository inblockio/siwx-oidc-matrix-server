# Minimum version: v1.121.0 (MSC3861 experimental support required)
# Pinned 2026-07-31 after upstream 1.157 removed experimental_features.msc3861
# (replaced by a stable matrix_authentication_service config block this repo's
# entrypoint does not yet generate — see docs/2026-07-30-dev-staging-dev-aquafire.md
# and .env.dev-staging.example). Do not float :latest; bump deliberately once
# the entrypoint is migrated to the new config schema.
FROM matrixdotorg/synapse:v1.154.0
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
