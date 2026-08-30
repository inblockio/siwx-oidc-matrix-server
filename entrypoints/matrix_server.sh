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

# Delegated auth (Matrix Authentication Service) used to be configured here as
# `experimental_features.msc3861`, first-boot-only. Synapse 1.157.0 REMOVED that
# block outright, so it is now written by apply_mas_config() in the always-run
# section below the first-boot guard — which is also what MIGRATES an
# already-provisioned /data/homeserver.yaml off msc3861. See the block comment there.

# MatrixRTC / call-hardening config (MSC4108/4143/3266/4222, delayed events,
# rc_delayed_event_mgmt, rc_message, matrix_rtc.transports) used to live here,
# first-boot-only. It is now applied by apply_matrixrtc_config() in the
# always-run section below the first-boot guard, so template changes reach
# already-provisioned deployments too (T7,
# docs/superpowers/plans/2026-08-01-av-hardening-config.md; see
# docs/2026-06-11-call-drop-analysis.md for the incident where rc_message had
# to be hand-applied live with yq because this block was first-boot-only).

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

# -----------------------------------------------------------------------------
# MatrixRTC / call-hardening config — ALWAYS RE-ASSERTED, EVERY BOOT.
#
# These are pure `yq -i` key assignments — idempotent, since re-applying the
# same value is a no-op — so they are safe (and necessary) to run
# unconditionally whenever /data/homeserver.yaml exists: right after
# /start.py generate on first boot (above), AND on every later restart
# against an already-generated homeserver.yaml. Before this restructure, this
# block lived only inside the first-boot guard, so a template change here
# would silently never reach an existing deployment — see
# docs/2026-06-11-call-drop-analysis.md, where rc_message had to be
# hand-applied live with yq plus a manual restart. T7,
# docs/superpowers/plans/2026-08-01-av-hardening-config.md.
# -----------------------------------------------------------------------------
# -----------------------------------------------------------------------------
# Delegated auth via the STABLE Matrix Authentication Service integration —
# ALWAYS RE-ASSERTED, EVERY BOOT, because it is also the MIGRATION off MSC3861.
#
# Synapse 1.157.0 removed `experimental_features.msc3861`; a leftover non-empty
# block is now a hard ConfigError that refuses to boot
# (synapse/config/experimental.py). This entrypoint's setup block is
# first-boot-only, so an already-provisioned /data/homeserver.yaml would keep its
# msc3861 block forever and the container would crash-loop on upgrade. The
# migration therefore runs unconditionally, here, before /start.py.
#
# Stable config shape (synapse/config/mas.py, MasConfigModel):
#   matrix_authentication_service:
#     enabled: true
#     endpoint: <base URL of the OP>   # AnyHttpUrl
#     secret:   <shared secret>        # == the old client_secret AND admin_token
#
# `endpoint` is the ONLY location knob. Synapse derives BOTH
#   {endpoint}/.well-known/openid-configuration  (MasDelegatedAuth._metadata_url)
#   {endpoint}/oauth2/introspect                 (_introspection_endpoint)
# from it, and IGNORES the metadata document's own `introspection_endpoint`.
#
# There is no `issuer_metadata` override any more, and none is needed: siwx-oidc
# builds its whole discovery document from SIWEOIDC_BASE_URL (host-independent —
# it does not echo the request Host), so fetching it over the docker-internal
# address still returns the PUBLIC issuer and endpoint URLs, which Synapse then
# forwards to browsers verbatim via GET /_matrix/client/v1/auth_metadata
# (MasDelegatedAuth.auth_metadata returns the full metadata dict, and
# ServerMetadata is pydantic with extra="allow", so our extra keys — including
# account_management_actions_supported — survive). That is exactly the
# decoupling the old hand-built issuer_metadata block provided, now for free.
#
# Two knobs disappear as a consequence, both correctly:
#   * issuer — clients now see siwx-oidc's own `issuer` claim, so the RFC 8414
#     3.3 trailing-slash byte-match against .well-known/matrix/client is owned by
#     siwx-oidc alone and can no longer drift from Synapse's config. It HAD
#     drifted: dev-staging carried msc3861.issuer with no trailing slash.
#   * account_management_url — Synapse reads `account_management_uri` from the OP
#     metadata (a REQUIRED field of ServerMetadata), which siwx-oidc always emits
#     as {base_url}/account.
#
# The shared secret keeps its double duty: introspection is authenticated with
# `Authorization: Bearer <secret>` (siwx-oidc's src/introspect.rs already accepts
# a Bearer shared secret), and is_request_using_the_shared_secret() survives, so
# siwx-oidc's admin_token calls in synapse_client.rs keep working unchanged.
# -----------------------------------------------------------------------------
apply_mas_config() {
  # Where Synapse reaches siwx-oidc. Internal docker address when the compose
  # supplies one (local/e2e); otherwise the public base URL — which is what
  # prod/dev-staging already used under msc3861 (no issuer_metadata there), so
  # this preserves the existing network path exactly.
  local mas_endpoint="${SIWEOIDC_INTERNAL_URL:-${SIWEOIDC_BASE_URL:-}}"
  mas_endpoint="${mas_endpoint%/}"

  # DO NOT CLOBBER A GOOD CONFIG FROM AN INCOMPLETE ENVIRONMENT.
  #
  # Unlike the first-boot setup block, this function runs on EVERY boot and
  # re-derives both values from the environment each time. That is what makes it
  # a migration — and also what makes an env regression destructive in a way the
  # first-boot guard never was: with SIWEOIDC_BASE_URL (or MAS_SHARED_SECRET)
  # missing or empty, the yq writes below replace a WORKING on-disk config with
  # `endpoint: ""` / `secret: ""`. Synapse 1.159 then refuses to boot
  # ("Could not validate Matrix Authentication Service configuration: 1
  # validation error for MasConfigModel") and the last-known-good value is gone
  # from disk. Verified empirically, H13 phase 7, 2026-08-30.
  #
  # Both vars reach the Synapse container via compose `env_file: .env`, so a
  # single .env edit or an env_file drop is enough to trigger this.
  #
  # Skip rather than exit: if the on-disk config is already correct the server
  # stays up (nothing else in this container consumes these vars), and if it
  # still carries an msc3861 block Synapse fails loudly on its own with the
  # explicit "was removed. Use the matrix_authentication_service configuration
  # instead." ConfigError. Either way no good state is destroyed and no failure
  # is hidden.
  if [ -z "${mas_endpoint}" ] || [ -z "${MAS_SHARED_SECRET:-}" ]; then
    echo "ERROR: refusing to write matrix_authentication_service — endpoint (SIWEOIDC_INTERNAL_URL/SIWEOIDC_BASE_URL) or MAS_SHARED_SECRET is empty." >&2
    echo "ERROR: leaving /data/homeserver.yaml untouched; restore the environment and restart." >&2
    return 0
  fi

  # THE MIGRATION: drop the removed experimental block. No-op once already gone.
  yq -i "del(.experimental_features.msc3861)" /data/homeserver.yaml

  yq -i ".matrix_authentication_service.enabled = true" /data/homeserver.yaml
  yq -i ".matrix_authentication_service.endpoint = \"${mas_endpoint}\"" /data/homeserver.yaml
  yq -i ".matrix_authentication_service.secret = \"${MAS_SHARED_SECRET}\"" /data/homeserver.yaml
}

apply_matrixrtc_config() {
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
}

if [ -f /data/homeserver.yaml ]; then
  apply_mas_config
  apply_matrixrtc_config
else
  # /start.py generate above should have created this; if it somehow didn't,
  # the final /start.py below will fail loudly on its own missing config.
  echo "WARNING: /data/homeserver.yaml still missing after setup — skipping MatrixRTC config re-assert." >&2
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
