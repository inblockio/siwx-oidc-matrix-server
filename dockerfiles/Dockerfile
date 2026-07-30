# Minimum version: v1.121.0 (MSC3861 experimental support required)
# Pinned 2026-07-31 after upstream 1.157 removed experimental_features.msc3861
# (replaced by a stable matrix_authentication_service config block this repo's
# entrypoint does not yet generate — see docs/2026-07-30-dev-staging-dev-aquafire.md
# and .env.dev-staging.example). Do not float :latest; bump deliberately once
# the entrypoint is migrated to the new config schema.
FROM matrixdotorg/synapse:v1.154.0
RUN apt update && apt install wget -y && apt clean
RUN wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/bin/yq && chmod +x /usr/bin/yq
COPY ./entrypoints/matrix_server.sh /matrix_server.sh
ENTRYPOINT ["/matrix_server.sh"]
