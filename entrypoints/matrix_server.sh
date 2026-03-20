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
yq -i ".oidc_providers[0].client_auth_method = \"client_secret_post\"" /data/homeserver.yaml

yq -i --unwrapScalar=false ".oidc_providers[0].user_mapping_provider.config.localpart_template=\"{{ user.preferred_username | replace(':', '-') }}\"" /data/homeserver.yaml
yq -i --unwrapScalar=false ".oidc_providers[0].user_mapping_provider.config.display_name_template=\"{{ user.name or user.preferred_username }}\"" /data/homeserver.yaml

echo "First boot: Synapse may restart once while Let's Encrypt provisions TLS certificates."
sleep 5

else
  echo "Setup already completed! Skipping Setup"
fi

# Promote admin user if MATRIX_ADMIN_DID is set (idempotent, runs every boot).
# The user must have completed at least one OIDC login before this takes effect.
if [ -n "${MATRIX_ADMIN_DID}" ]; then
  # Validate format before use — reject anything that isn't a well-formed DID.
  if ! echo "${MATRIX_ADMIN_DID}" | grep -qE '^did:[a-z]+:[a-z0-9]+:[a-z0-9]+:0x[0-9a-fA-F]{40}$'; then
    echo "WARNING: MATRIX_ADMIN_DID='${MATRIX_ADMIN_DID}' has invalid format — skipping admin promotion."
  else
    ADMIN_LOCALPART=$(echo "${MATRIX_ADMIN_DID}" | tr ':' '-' | tr '[:upper:]' '[:lower:]')
    ADMIN_USER="@${ADMIN_LOCALPART}:${MATRIX_HOST}"
    # Values are passed as env vars; the Python source is a literal heredoc (single-quoted
    # terminator = no shell expansion inside). Nothing is interpolated into Python code.
    ADMIN_USER="${ADMIN_USER}" python3 << 'PYEOF'
import sqlite3, sys, os

user = os.environ['ADMIN_USER']   # never comes from shell interpolation into source

try:
    conn = sqlite3.connect('/data/homeserver.db')
    c = conn.cursor()
    c.execute('UPDATE users SET admin=1 WHERE name=?', (user,))
    if c.rowcount:
        print(f'Admin promoted: {user}')
    else:
        print(f'Admin promotion deferred: {user} not found (user must log in first)')
    conn.commit()
    conn.close()
except Exception as e:
    print(f'Admin promotion error: {e}')
PYEOF
  fi
fi

/start.py
