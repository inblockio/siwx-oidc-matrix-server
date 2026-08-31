#!/bin/bash
# Custom Synapse entrypoint for the LOCAL REAL stack (siwx-real-*).
# Based on ../entrypoints/matrix_server.sh but adapted so the OIDC issuer the
# homeserver advertises (http://localhost:8081, the test's SIWEOIDC_HOST) is
# decoupled from the internal address Synapse uses to reach siwx-oidc for token
# introspection (http://siwx-real-oidc:8081).
#
# Since Synapse 1.157.0 (msc3861 removed) that decoupling is FREE: the stable
# matrix_authentication_service block has a single `endpoint`, and siwx-oidc
# builds its discovery document from SIWEOIDC_BASE_URL rather than the request
# Host — so pointing `endpoint` at the in-network address still yields the public
# issuer/endpoint URLs in the metadata Synapse re-exports to clients.
#
# Required env:
#   MATRIX_HOST            server_name (e.g. localhost)
#   MATRIX_PORT            internal HTTP listener port (e.g. 8008)
#   MATRIX_BASE_URL        public_baseurl (e.g. http://localhost:8448)
#   SIWEOIDC_INTERNAL_URL  in-network siwx-oidc base (http://siwx-real-oidc:8081)
#   MAS_SHARED_SECRET      shared secret (introspection Bearer + admin_token)
# No longer consumed (kept in compose, harmless): SIWEOIDC_PUBLIC_ISSUER — the
# advertised issuer now comes from siwx-oidc's own discovery document.
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

  echo "First boot: Synapse base config written (delegated auth applied below)."
else
  echo "Setup already completed! Skipping setup."
fi

# -----------------------------------------------------------------------------
# Stable Matrix Authentication Service integration — ALWAYS RE-ASSERTED, and it
# is the MIGRATION off the removed experimental_features.msc3861 (Synapse
# 1.157.0+ hard-ConfigErrors on a leftover block, and the setup section above is
# first-boot-only). Mirrors apply_mas_config() in ../entrypoints/matrix_server.sh.
#
# `endpoint` drives BOTH {endpoint}/.well-known/openid-configuration and
# {endpoint}/oauth2/introspect; the metadata's own introspection_endpoint is
# ignored. SIWEOIDC_PUBLIC_ISSUER is no longer consumed here — the issuer clients
# see now comes from siwx-oidc's own metadata, which is where it should always
# have come from.
# -----------------------------------------------------------------------------
MAS_ENDPOINT="${SIWEOIDC_INTERNAL_URL:-}"
MAS_ENDPOINT="${MAS_ENDPOINT%/}"

# Same "do not clobber a good config from an incomplete environment" guard as
# apply_mas_config() in ../entrypoints/matrix_server.sh — see the long comment
# there. Because this block runs on every boot, an empty SIWEOIDC_INTERNAL_URL or
# MAS_SHARED_SECRET would otherwise overwrite working values with `endpoint: ""` /
# `secret: ""`, which Synapse 1.159 rejects with a MasConfigModel validation
# error, destroying the last-known-good value on disk.
if [ -z "${MAS_ENDPOINT}" ] || [ -z "${MAS_SHARED_SECRET:-}" ]; then
  echo "ERROR: refusing to write matrix_authentication_service — SIWEOIDC_INTERNAL_URL or MAS_SHARED_SECRET is empty." >&2
  echo "ERROR: leaving /data/homeserver.yaml untouched; restore the environment and restart." >&2
  exec /start.py
fi

yq -i "del(.experimental_features.msc3861)" /data/homeserver.yaml
yq -i ".matrix_authentication_service.enabled = true" /data/homeserver.yaml
yq -i ".matrix_authentication_service.endpoint = \"${MAS_ENDPOINT}\"" /data/homeserver.yaml
yq -i ".matrix_authentication_service.secret = \"${MAS_SHARED_SECRET}\"" /data/homeserver.yaml

/start.py
