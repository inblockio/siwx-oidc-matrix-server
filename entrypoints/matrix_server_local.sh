#!/bin/bash

if [ ! -f /data/homeserver.yaml ]; then

/start.py generate

#general
yq -i --unwrapScalar=false ".server_name =\"${MATRIX_HOST}\"" /data/homeserver.yaml
yq -i ".public_baseurl = \"${MATRIX_BASE_URL}\"" /data/homeserver.yaml

#port configuration
yq -i ".listeners[0].port = ${MATRIX_PORT}" /data/homeserver.yaml
yq -i ".listeners[0].resources[0].names = [\"client\" ]" /data/homeserver.yaml
yq -i ".listeners[0].tls = false" /data/homeserver.yaml

# remove federation listener (not needed locally)
yq -i 'del(.listeners[1])' /data/homeserver.yaml

# no TLS locally
yq -i 'del(.tls_certificate_path)' /data/homeserver.yaml
yq -i 'del(.tls_private_key_path)' /data/homeserver.yaml

#oidc-config
yq -i ".oidc_providers[0].idp_id = \"siwe-oidc\"" /data/homeserver.yaml
yq -i ".oidc_providers[0].idp_name = \"siwe-oidc\"" /data/homeserver.yaml
yq -i ".oidc_providers[0].idp_brand = \"siwe-oidc\"" /data/homeserver.yaml

#retention
yq -i ".retention.enabled=true" /data/homeserver.yaml
yq -i ".retention.default_policy.allowed_lifetime_max= \"${MATRIX_MESSAGE_LIFETIME}\"" /data/homeserver.yaml

yq -i ".oidc_providers[0].issuer = \"${SIWEOIDC_BASE_URL}\"" /data/homeserver.yaml
yq -i ".oidc_providers[0].skip_verification = true" /data/homeserver.yaml

yq -i ".oidc_providers[0].client_id = \"${MATRIX_OIDC_CLIENT_ID}\"" /data/homeserver.yaml
yq -i ".oidc_providers[0].client_secret = \"${MATRIX_OIDC_SECRET_ID}\"" /data/homeserver.yaml

yq -i --unwrapScalar=false ".oidc_providers[0].user_mapping_provider.config.localpart_template=\"{{ user.preferred_username }}\"" /data/homeserver.yaml
yq -i --unwrapScalar=false ".oidc_providers[0].user_mapping_provider.config.display_name_template=\"{{ user.name }}\"" /data/homeserver.yaml

else
  echo "Setup already completed! Skipping Setup"
fi

/start.py
