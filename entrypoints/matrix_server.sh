#!/bin/bash

mkdir /data/certs
cp /certs/${MATRIX_HOST}/* /data/certs/
chown -R 991:991 /data/certs

if [ ! -f /data/homeserver.yaml ]; then

/start.py generate


#general
yq -i --unwrapScalar=false ".server_name =\"${MATRIX_HOST}\"" /data/homeserver.yaml
yq -i ".public_baseurl = \"${MATRIX_BASE_URL}\"" /data/homeserver.yaml


#port configuration
yq -i ".listeners[0].port = ${MATRIX_PORT}" /data/homeserver.yaml
yq -i ".listeners[0].resources[0].names = [\"client\" ]" /data/homeserver.yaml
yq -i ".listeners[1].port = 8448" /data/homeserver.yaml
yq -i ".listeners[1].tls = true" /data/homeserver.yaml
yq -i ".listeners[1].type = \"http\"" /data/homeserver.yaml
yq -i ".listeners[1].x_forwarded = true" /data/homeserver.yaml
yq -i ".listeners[1].resources[0].names = [\"federation\" ]" /data/homeserver.yaml
yq -i ".listeners[1].resources[0].compress = false" /data/homeserver.yaml

#tls config
yq -i --unwrapScalar=false ".tls_certificate_path = \"/data/certs/fullchain.pem\"" /data/homeserver.yaml
yq -i --unwrapScalar=false ".tls_private_key_path = \"/data/certs/key.pem\"" /data/homeserver.yaml

#oidc-config
yq -i ".oidc_providers[0].idp_id = \"siwx-oidc\"" /data/homeserver.yaml
yq -i ".oidc_providers[0].idp_name = \"siwx-oidc\"" /data/homeserver.yaml
yq -i ".oidc_providers[0].idp_brand = \"siwx-oidc\"" /data/homeserver.yaml

#retention
yq -i ".retention.enabled=true" /data/homeserver.yaml
yq -i ".retention.default_policy.allowed_lifetime_max= \"${MATRIX_MESSAGE_LIFETIME}\"" /data/homeserver.yaml

yq -i ".oidc_providers[0].issuer = \"${SIWEOIDC_BASE_URL}\"" /data/homeserver.yaml

yq -i ".oidc_providers[0].client_id = \"${MATRIX_OIDC_CLIENT_ID}\"" /data/homeserver.yaml
yq -i ".oidc_providers[0].client_secret = \"${MATRIX_OIDC_SECRET_ID}\"" /data/homeserver.yaml

yq -i --unwrapScalar=false ".oidc_providers[0].user_mapping_provider.config.localpart_template=\"{{ user.preferred_username }}\"" /data/homeserver.yaml
yq -i --unwrapScalar=false ".oidc_providers[0].user_mapping_provider.config.display_name_template=\"{{ user.preferred_username }}\"" /data/homeserver.yaml

echo "Server needs to restart 3-5 times to get certificates and connections!"
sleep 5

else
  echo "Setup already completed! Skipping Setup"
fi

/start.py
