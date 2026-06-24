#!/bin/bash
# Custom Synapse entrypoint for the LOCAL REAL stack (siwx-real-*).
# Based on ../entrypoints/matrix_server.sh but adapted so the MSC3861
# issuer the homeserver advertises (http://localhost:8081, the test's
# SIWEOIDC_HOST) is decoupled from the internal address Synapse uses to
# reach siwx-oidc for token introspection (http://siwx-real-oidc:8081).
#
# The decoupling is done with msc3861.issuer_metadata, which Synapse uses
# verbatim instead of fetching {issuer}/.well-known/openid-configuration.
#
# Required env:
#   MATRIX_HOST            server_name (e.g. localhost)
#   MATRIX_PORT            internal HTTP listener port (e.g. 8008)
#   MATRIX_BASE_URL        public_baseurl (e.g. http://localhost:8448)
#   SIWEOIDC_PUBLIC_ISSUER public OIDC issuer the test/clients see (http://localhost:8081)
#   SIWEOIDC_INTERNAL_URL  in-network siwx-oidc base (http://siwx-real-oidc:8081)
#   MAS_SHARED_SECRET      shared secret == client_secret == admin_token
set -e

if [ ! -f /data/homeserver.yaml ]; then
  /start.py generate

  # general
  yq -i --unwrapScalar=false ".server_name = \"${MATRIX_HOST}\"" /data/homeserver.yaml
  yq -i ".public_baseurl = \"${MATRIX_BASE_URL}\"" /data/homeserver.yaml

  # single plain-HTTP listener (client + federation), x_forwarded for the proxy
  yq -i ".listeners[0].port = ${MATRIX_PORT}" /data/homeserver.yaml
  yq -i ".listeners[0].resources[0].names = [\"client\", \"federation\"]" /data/homeserver.yaml
  yq -i ".listeners[0].tls = false" /data/homeserver.yaml
  yq -i ".listeners[0].type = \"http\"" /data/homeserver.yaml
  yq -i ".listeners[0].x_forwarded = true" /data/homeserver.yaml
  yq -i ".listeners[0].bind_addresses = [\"0.0.0.0\"]" /data/homeserver.yaml
  yq -i "del(.listeners[1])" /data/homeserver.yaml

  # MSC3861 delegated auth
  yq -i ".experimental_features.msc3861.enabled = true" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer = \"${SIWEOIDC_PUBLIC_ISSUER}\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.account_management_url = \"${SIWEOIDC_PUBLIC_ISSUER%/}/account\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.client_id = \"0000000000000000000SYNAPSE\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.client_auth_method = \"client_secret_post\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.client_secret = \"${MAS_SHARED_SECRET}\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.admin_token = \"${MAS_SHARED_SECRET}\"" /data/homeserver.yaml

  # issuer_metadata: override MSC2965 discovery so Synapse reaches siwx-oidc on
  # the docker network while still advertising the public issuer to clients.
  # The "issuer" field here MUST byte-match msc3861.issuer above.
  yq -i ".experimental_features.msc3861.issuer_metadata.issuer = \"${SIWEOIDC_PUBLIC_ISSUER}\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer_metadata.authorization_endpoint = \"${SIWEOIDC_INTERNAL_URL%/}/authorize\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer_metadata.token_endpoint = \"${SIWEOIDC_INTERNAL_URL%/}/token\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer_metadata.introspection_endpoint = \"${SIWEOIDC_INTERNAL_URL%/}/oauth2/introspect\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer_metadata.revocation_endpoint = \"${SIWEOIDC_INTERNAL_URL%/}/oauth2/revoke\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer_metadata.registration_endpoint = \"${SIWEOIDC_INTERNAL_URL%/}/register\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer_metadata.jwks_uri = \"${SIWEOIDC_INTERNAL_URL%/}/jwk\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer_metadata.account_management_uri = \"${SIWEOIDC_PUBLIC_ISSUER%/}/account\"" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer_metadata.response_types_supported = [\"code\"]" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer_metadata.grant_types_supported = [\"authorization_code\", \"refresh_token\"]" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer_metadata.response_modes_supported = [\"query\", \"fragment\"]" /data/homeserver.yaml

  echo "First boot: Synapse configured with MSC3861 delegated auth (issuer_metadata override)."
else
  echo "Setup already completed! Skipping setup."
fi

/start.py
