#!/bin/bash

if [ ! -f /data/homeserver.yaml ]; then

/start.py generate


#general
yq -i --unwrapScalar=false ".server_name =\"${MATRIX_HOST}\"" /data/homeserver.yaml
yq -i ".public_baseurl = \"${MATRIX_BASE_URL}\"" /data/homeserver.yaml


#port configuration
yq -i ".listeners[0].port = ${MATRIX_PORT}" /data/homeserver.yaml
yq -i ".listeners[0].resources[0].names = [\"client\", \"federation\"]" /data/homeserver.yaml
yq -i ".listeners[0].tls = false" /data/homeserver.yaml
yq -i ".listeners[0].type = \"http\"" /data/homeserver.yaml
yq -i ".listeners[0].x_forwarded = true" /data/homeserver.yaml
yq -i "del(.listeners[1])" /data/homeserver.yaml

#msc3861 delegated auth
yq -i ".experimental_features.msc3861.enabled = true" /data/homeserver.yaml
# Public issuer clients see (must byte-match siwx-oidc metadata / .well-known).
# Prefer SIWEOIDC_PUBLIC_ISSUER when set (local/e2e), else SIWEOIDC_BASE_URL.
PUBLIC_ISSUER="${SIWEOIDC_PUBLIC_ISSUER:-${SIWEOIDC_BASE_URL}}"
# Ensure trailing slash for RFC 8414 issuer byte-match with siwx metadata.
case "${PUBLIC_ISSUER}" in
  */) ;;
  *) PUBLIC_ISSUER="${PUBLIC_ISSUER}/" ;;
esac
yq -i ".experimental_features.msc3861.issuer = \"${PUBLIC_ISSUER}\"" /data/homeserver.yaml
# Account-management deep link must point at the /account page, NOT the bare issuer
# root. Synapse echoes this verbatim into the cross-signing-reset UIA 401 it hands
# clients (rest/client/keys.py, msc3861 branch); a bare root dead-ends Element Web at
# the sign-in SPA (/client/null) so the reset approval is never reached. `${VAR%/}/account`
# is correct whether or not the issuer carries a trailing slash.
yq -i ".experimental_features.msc3861.account_management_url = \"${PUBLIC_ISSUER%/}/account\"" /data/homeserver.yaml
yq -i ".experimental_features.msc3861.client_id = \"0000000000000000000SYNAPSE\"" /data/homeserver.yaml
yq -i ".experimental_features.msc3861.client_auth_method = \"client_secret_post\"" /data/homeserver.yaml
yq -i ".experimental_features.msc3861.client_secret = \"${MAS_SHARED_SECRET}\"" /data/homeserver.yaml
yq -i ".experimental_features.msc3861.admin_token = \"${MAS_SHARED_SECRET}\"" /data/homeserver.yaml

# When SIWEOIDC_INTERNAL_URL is set (local/e2e compose), pin issuer_metadata so
# Synapse reaches siwx-oidc on the docker network for introspection while still
# advertising the public issuer to clients. Without this, issuer=http://localhost:N
# is unreachable from inside the Synapse container and every whoami returns 503.
#
# CRITICAL: Synapse forwards issuer_metadata VERBATIM to browsers via
# GET /_matrix/client/v1/auth_metadata — it does NOT merge in the OP's real
# metadata. A hand-written endpoints-only dict therefore breaks Element Web
# twice over: (a) internal http://siwx-oidc:PORT endpoint URLs are
# unreachable from a browser, and (b) missing capability fields
# (response_types_supported, grant_types_supported,
# code_challenge_methods_supported) fail matrix-js-sdk's issuer validation.
# Either way Element falls back to the legacy /login/sso/redirect, which
# 404s under MSC3861 (siwx has no MAS compat shim) — a login dead-end.
#
# Correct pattern (as MAS documents): take the OP's FULL metadata (siwx
# advertises public URLs because SIWEOIDC_BASE_URL is host-facing) and
# override ONLY introspection_endpoint to the docker-internal URL — the one
# endpoint Synapse itself calls.
if [ -n "${SIWEOIDC_INTERNAL_URL:-}" ]; then
  INTERNAL="${SIWEOIDC_INTERNAL_URL%/}"
  for i in $(seq 1 30); do
    curl -fsS "${INTERNAL}/.well-known/openid-configuration" -o /tmp/op-metadata.json && break
    echo "waiting for siwx-oidc metadata at ${INTERNAL} (${i}/30)..."
    sleep 2
  done
  if [ ! -s /tmp/op-metadata.json ]; then
    echo "FATAL: could not fetch ${INTERNAL}/.well-known/openid-configuration" >&2
    exit 1
  fi
  yq -i ".experimental_features.msc3861.issuer_metadata = load(\"/tmp/op-metadata.json\")" /data/homeserver.yaml
  yq -i ".experimental_features.msc3861.issuer_metadata.introspection_endpoint = \"${INTERNAL}/oauth2/introspect\"" /data/homeserver.yaml
fi

# Enable QR code login rendezvous server (MSC4108 2024 version)
yq -i ".experimental_features.msc4108_enabled = true" /data/homeserver.yaml

# MatrixRTC: enable experimental features for Element Call
yq -i ".experimental_features.msc4143_enabled = true" /data/homeserver.yaml
yq -i ".experimental_features.msc3266_enabled = true" /data/homeserver.yaml
yq -i ".experimental_features.msc4222_enabled = true" /data/homeserver.yaml

# Delayed events (MSC4140): auto-quit interrupted calls
yq -i ".max_event_delay_duration = \"24h\"" /data/homeserver.yaml

# Rate limiting for call heartbeats (every 5s per participant)
yq -i ".rc_delayed_event_mgmt.per_second = 1" /data/homeserver.yaml
yq -i ".rc_delayed_event_mgmt.burst_count = 20" /data/homeserver.yaml

# Rate limiting for in-call E2EE key sharing (bursty room messages); values from
# Element Call docs/self_hosting.md. Synapse defaults (0.2/10) can rate-limit calls.
yq -i ".rc_message.per_second = 0.5" /data/homeserver.yaml
yq -i ".rc_message.burst_count = 30" /data/homeserver.yaml

# MatrixRTC transport: LiveKit SFU
yq -i ".matrix_rtc.transports[0].type = \"livekit\"" /data/homeserver.yaml
yq -i ".matrix_rtc.transports[0].livekit_service_url = \"https://${MATRIX_HOST}/livekit/jwt\"" /data/homeserver.yaml

#federation via well-known delegation (Caddy serves .well-known on port 443)
yq -i ".serve_server_wellknown = false" /data/homeserver.yaml

#retention
yq -i ".retention.enabled=true" /data/homeserver.yaml
yq -i ".retention.default_policy.allowed_lifetime_max= \"${MATRIX_MESSAGE_LIFETIME}\"" /data/homeserver.yaml

# Server notices: the channel the storage controller (scripts/matrix-storage-controller.sh)
# pushes WARN/CRIT storage alerts through. Synapse force-creates @notices and a
# "Server Alerts" room and posts via POST /_synapse/admin/v1/send_server_notice
# (authed by the msc3861 admin_token). Verified to work under MSC3861.
yq -i ".server_notices.system_mxid_localpart = \"notices\"" /data/homeserver.yaml
yq -i ".server_notices.system_mxid_display_name = \"${MATRIX_HOST} storage alerts\"" /data/homeserver.yaml
yq -i ".server_notices.room_name = \"Server Alerts\"" /data/homeserver.yaml

echo "First boot: Synapse configured with MSC3861 delegated auth."

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
