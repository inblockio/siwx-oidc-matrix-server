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

# ---------------------------------------------------------------------------
# RETENTION — the knob is now REAL, and it is DELIBERATELY OFF.
#
# What was wrong (memory: synapse-retention-silent-noop):
#   yq -i ".retention.default_policy.allowed_lifetime_max = ${MATRIX_MESSAGE_LIFETIME}"
# `allowed_lifetime_max` is a TOP-LEVEL retention key: it CLAMPS what a room's
# own m.room.retention event may request. It is not a key Synapse reads inside
# `default_policy`, which accepts only `min_lifetime` / `max_lifetime`. Written
# there it was silently ignored, so there was NO default policy at all and no
# room lacking its own m.room.retention event was ever purged.
#
# MATRIX_MESSAGE_LIFETIME therefore did nothing whatsoever. Confirmed live on
# dev-staging 2026-08-30: retention = {enabled: true, default_policy:
# {allowed_lifetime_max: 4w}} — a setting that reads like a 4-week retention
# policy and purges nothing.
#
# THE KEY THAT ACTUALLY DELETES MESSAGES is `retention.default_policy.max_lifetime`.
# It is left UNSET here on purpose: turning it on has real, irreversible purge
# blast radius and is Tim's call, not the entrypoint's default. Enabling it
# needs a measured blast-radius number first — see
# docs/superpowers/plans/2026-08-30-dev-stack-upgrade.md (R10).
#
# TWO THINGS HAD TO CHANGE, not one. Fixing this template alone does NOT reach
# dev-staging or prod: this whole block sits inside the first-boot guard, so it
# only ever runs on a fresh volume (plan D20 — the retention keys are "frozen").
# An existing deployment keeps its wrong config until someone either hand-edits
# it or the guard is replaced by the one-shot versioned migration proposed in
# the plan's escalation #2. This change makes NEW deployments correct and
# honest; it changes NOTHING on any existing box, which is exactly the intent.
#
#   MATRIX_RETENTION_ENABLED         default "false" -> nothing is ever purged
#   MATRIX_RETENTION_MAX_LIFETIME    the purging knob; only read when enabled
#   MATRIX_MESSAGE_LIFETIME          legacy name, now used as the CLAMP, which
#                                    is what the key it fed always meant
# ---------------------------------------------------------------------------
if [ "${MATRIX_RETENTION_ENABLED:-false}" = "true" ]; then
  yq -i ".retention.enabled = true" /data/homeserver.yaml
  # The clamp, at its correct TOP-LEVEL position (not under default_policy).
  yq -i ".retention.allowed_lifetime_max = \"${MATRIX_MESSAGE_LIFETIME}\"" /data/homeserver.yaml
  # The key that actually purges. Only written when explicitly configured.
  if [ -n "${MATRIX_RETENTION_MAX_LIFETIME:-}" ]; then
    yq -i ".retention.default_policy.max_lifetime = \"${MATRIX_RETENTION_MAX_LIFETIME}\"" /data/homeserver.yaml
    echo "First boot: retention ENABLED, default_policy.max_lifetime=${MATRIX_RETENTION_MAX_LIFETIME} (messages WILL be purged)"
  else
    echo "First boot: retention enabled as a CLAMP only (allowed_lifetime_max=${MATRIX_MESSAGE_LIFETIME}); no default_policy.max_lifetime, so nothing is purged"
  fi
else
  # Explicitly off, and explicitly written, so the config states the intent
  # rather than leaving a reader to infer it from a key that does nothing.
  yq -i ".retention.enabled = false" /data/homeserver.yaml
  echo "First boot: message retention DISABLED (no purging). Set MATRIX_RETENTION_ENABLED=true to change."
fi

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

# -----------------------------------------------------------------------------
# THE DID PROFILE FIELD — a THREE-SIDED wire contract whose sides are deployed
# independently and fail APART, silently:
#
#   provider    siwx-oidc          src/did_assertion.rs::DID_PROFILE_FIELD
#   consumer    siwx-oidc-auth     src/did_assertion.rs::DID_PROFILE_FIELD
#   homeserver  THIS denylist entry
#
# Overridable for a deployment that renames it, but all three move TOGETHER:
# changing it on one side alone silently unprotects the live field. Hoisted to a
# script-level export (it used to be a one-shot prefix assignment on the `yq`
# line) because the verification, the failure banner and the write all have to
# name the same string, and `strenv()` needs it exported anyway.
# -----------------------------------------------------------------------------
SIWX_DID_PROFILE_FIELD="${SIWX_DID_PROFILE_FIELD:-io.inblock.did}"
export SIWX_DID_PROFILE_FIELD

# The ONE place the "what / what it means / what to do" text lives, so the hard
# fail and the SIWX_ALLOW_UNPROTECTED_DID_FIELD warn-mode downgrade can never
# drift apart into two different descriptions of the same hole. $1 is the one
# line that differs: the specific defect detected.
did_field_unprotected_banner() {
  echo "" >&2
  echo "################################################################################" >&2
  echo "##  DID PROFILE FIELD '${SIWX_DID_PROFILE_FIELD}' IS NOT PROTECTED" >&2
  echo "##" >&2
  echo "##  WHAT:  $1" >&2
  echo "##" >&2
  echo "##  MEANS: '${SIWX_DID_PROFILE_FIELD}' is then an ordinary, USER-WRITABLE" >&2
  echo "##         MSC4133 custom profile field. Stock Synapse authorizes a custom-" >&2
  echo "##         field write with an ownership check and NOTHING else (1.159.0" >&2
  echo "##         handlers/profile.py:700-704 — no value validation anywhere in the" >&2
  echo "##         path), so ANY user can overwrite their OWN copy of this field with" >&2
  echo "##         SOMEONE ELSE'S DID and misrepresent their cryptographic identity to" >&2
  echo "##         every client and every federating server that reads it — the field" >&2
  echo "##         is world-readable by default (config/server.py:561," >&2
  echo "##         require_auth_for_profile_requests = False) and federates via" >&2
  echo "##         handlers/profile.py::on_profile_query. siwx-oidc's ES256 assertion" >&2
  echo "##         makes such tampering DETECTABLE; only this denylist makes it" >&2
  echo "##         IMPOSSIBLE." >&2
  echo "##" >&2
  echo "##  DO:    run the PATCHED Synapse image this repo builds — dockerfiles/" >&2
  echo "##         Dockerfile applies patches/synapse/msc4133-profile-field-write-" >&2
  echo "##         policy.patch (element-hq/synapse#19980) and FAILS THE BUILD if it" >&2
  echo "##         stops applying. Production pins that image by DIGEST and promotion" >&2
  echo "##         is a human editing .env, so the usual cause is a digest that" >&2
  echo "##         predates the patch, or one that points at a stock" >&2
  echo "##         matrixdotorg/synapse. Full registry: patches/synapse/README.md." >&2
  echo "################################################################################" >&2
  echo "" >&2
}

# Can the Synapse in THIS container actually enforce the denylist?
#
# The build-time guarantee is real, but it is not THIS guarantee. `patch
# --forward --batch --fuzz=0` failing the image build protects the image we
# BUILD; it says nothing about the image a deployment actually PINNED. Prod runs
# a digest chosen by hand in .env, so "accidentally running a stock Synapse" is a
# realistic deploy mistake rather than a hypothetical — and it is the worst kind,
# because on stock Synapse `msc4133_key_denylist` is simply an unknown
# `experimental_features` entry that is silently IGNORED. The write below still
# succeeds, the config still LOOKS right, and every user's provider-asserted DID
# is user-writable with ZERO signal anywhere. (The previous version of this
# function's comment noted that "it does not gate startup" as a safety property.
# That was exactly backwards: it is the hole.)
#
# Probed by SOURCE MARKER, not by a live 403: this runs before Synapse is
# listening, and a live probe would need a user access token we do not have here.
#
# TWO markers, and both are the CONFIG KEY NAME, because they are the two
# independent halves of "this config has any effect at all":
#   config/experimental.py  — the key we write is PARSED (not silently ignored)
#   handlers/profile.py     — the parsed key is READ on the profile write path
# Deliberately NOT the patch's private helper `_is_profile_field_disallowed`
# (verified to discriminate correctly on 2026-09-13, patched vs stock): it is an
# internal name upstream may rename at will, whereas patches/synapse/README.md
# keeps the upstream CONFIG key names verbatim precisely so that adopting the
# merged PR is a no-op for this config. And a rename of the config key would
# break the `yq` write below anyway, so it MUST fail here rather than pass.
#
# The package directory is resolved via `import synapse` rather than hard-coded
# as python3.13/site-packages, for the same reason dockerfiles/Dockerfile does:
# a base image that bumps its Python would otherwise make this probe read
# "absent" (fail-closed, but for the wrong reason) or, worse, miss the file.
synapse_enforces_did_field_denylist() {
  local pkg
  pkg="$(python3 -c 'import synapse, os; print(os.path.dirname(synapse.__file__))' 2>/dev/null)"
  [ -n "${pkg}" ] || return 1
  grep -q 'msc4133_key_denylist' "${pkg}/config/experimental.py" 2>/dev/null || return 1
  grep -q 'msc4133_key_denylist' "${pkg}/handlers/profile.py"    2>/dev/null || return 1
  return 0
}

# Re-read what is ACTUALLY ON DISK. "`yq -i` was invoked" and "/data/homeserver.yaml
# contains the value" are different facts and only the second one protects anyone:
# this script runs without `set -e`, so a failed write is otherwise a no-op that
# startup sails straight past.
#
# `grep -Fxq` rather than a `yq ... | contains(...)` expression: the field name is
# full of dots, F makes it a fixed string and x anchors the whole line, so no part
# of the value can be re-interpreted as a pattern or a yq path.
did_field_denylist_on_disk_contains_field() {
  [ -f /data/homeserver.yaml ] || return 1
  yq '.experimental_features.msc4133_key_denylist // [] | .[]' /data/homeserver.yaml 2>/dev/null \
    | grep -Fxq "${SIWX_DID_PROFILE_FIELD}"
}

apply_did_field_protection() {
  # Make the provider-asserted DID profile field immutable to the user.
  #
  # siwx-oidc publishes each user's DID into their MSC4133 profile under
  # `io.inblock.did`, signed with the provider's ES256 key. On stock Synapse
  # that field is freely user-writable with no value validation
  # (handlers/profile.py:700-704 checks ownership and nothing else) — see the
  # banner above for the full consequence. The signature makes tampering
  # detectable; this denylist makes it impossible.
  #
  # Requires the vendored patch dockerfiles/Dockerfile applies —
  # patches/synapse/msc4133-profile-field-write-policy.patch, a backport of
  # element-hq/synapse#19980 — and, since 2026-09-13, VERIFIES that it is
  # present rather than assuming it.
  #
  # DENYLIST, never msc4133_key_allowlist: the allowlist is a hard whitelist
  # over EVERY custom profile field on the homeserver, which would forbid every
  # other field our users might ever set. Upstream's key name is used verbatim
  # so that adopting the merged PR is a no-op for this config.

  # The field name must satisfy Synapse's Common Namespaced Identifier Grammar
  # (1.159.0 util/stringutils.py:53, unchanged at 1.161.0; enforced by is_namedspaced_grammar() at
  # rest/client/profile.py:138/179/240 on EVERY custom-field GET/PUT/DELETE).
  # A name that fails it is unreachable on the C-S API for everybody — including
  # siwx-oidc's own admin PUT — so a denylist carrying one is inert and the whole
  # feature is silently off. Hard fail with NO escape hatch: this is a typo in
  # our own configuration, never a deployment shape anyone deliberately chooses.
  if [[ ! "${SIWX_DID_PROFILE_FIELD}" =~ ^[a-z][a-z0-9_.-]{0,254}$ ]]; then
    did_field_unprotected_banner "SIWX_DID_PROFILE_FIELD='${SIWX_DID_PROFILE_FIELD}' violates Synapse's Common Namespaced Identifier Grammar ^[a-z][a-z0-9_.-]{0,254}\$, so no such profile field can exist and the denylist entry would protect nothing."
    echo "REFUSING TO START: this is a typo in our own configuration, not a deployment shape; there is no override." >&2
    exit 1
  fi

  # `yq` is given the field name as a strenv() so the dots in "io.inblock.did"
  # are never parsed as a yq path expression.
  if ! yq -i '.experimental_features.msc4133_key_denylist = [strenv(SIWX_DID_PROFILE_FIELD)]' \
        /data/homeserver.yaml; then
    did_field_unprotected_banner "the yq write of experimental_features.msc4133_key_denylist into /data/homeserver.yaml FAILED (yq exited non-zero — unwritable file, malformed YAML, or no yq)."
    echo "REFUSING TO START: a config write that silently did not happen must not become a running server." >&2
    exit 1
  fi

  # THE GATE. Default is a hard fail, deliberately: a homeserver that publishes
  # provider-signed DID assertions into a field any user can overwrite is worse
  # than a homeserver that refuses to start. The first is a silent identity
  # forgery surface that nobody will notice; the second is an outage somebody
  # fixes in ten minutes.
  if synapse_enforces_did_field_denylist; then
    echo "DID field protection: '${SIWX_DID_PROFILE_FIELD}' denylisted, and this Synapse carries the MSC4133 write-ACL patch (msc4133_key_denylist parsed in config/experimental.py and read in handlers/profile.py)."
  elif [ "${SIWX_ALLOW_UNPROTECTED_DID_FIELD:-}" = "1" ]; then
    # Escape hatch, named so that nobody sets it without understanding it. It
    # downgrades ONLY this check — an operator may deliberately run a stock
    # Synapse (a version-bump dry run, a bisect, a standalone deployment that
    # publishes no DIDs). It does NOT downgrade the write verification: a config
    # write that did not land is never an intended deployment shape.
    SIWX_DID_FIELD_UNPROTECTED_WARN=1
    did_field_unprotected_banner "this Synapse does NOT carry the MSC4133 write-ACL patch — 'msc4133_key_denylist' is an unknown experimental_features key here and Synapse IGNORES it."
    echo "WARNING: SIWX_ALLOW_UNPROTECTED_DID_FIELD=1 is set — starting anyway, with the field UNPROTECTED. You are accepting everything above." >&2
  else
    did_field_unprotected_banner "this Synapse does NOT carry the MSC4133 write-ACL patch — 'msc4133_key_denylist' is an unknown experimental_features key here and Synapse IGNORES it."
    echo "REFUSING TO START. Set SIWX_ALLOW_UNPROTECTED_DID_FIELD=1 to start anyway (you are then accepting everything above)." >&2
    exit 1
  fi
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
  #
  # Synapse 1.161.0 DEPRECATES `livekit_service_url` and adds an optional sibling
  # `url` (the SFU WebSocket URL). We deliberately keep `livekit_service_url`
  # and do NOT write `url`: upstream says to keep listing the deprecated key for
  # older clients, and a client that sees `url` switches to reaching the LiveKit
  # authorization service through the C-S API, which only works when
  # lk-jwt-service is registered as an application service. Ours is not (it
  # runs as a plain HTTP service behind /livekit/jwt), so adding `url` would
  # break calls for exactly the newer clients. Adopt `url` together with the
  # appservice registration, never on its own. 1.161 also starts validating
  # every transport entry (strict strings, and a livekit transport needs `url`
  # or `livekit_service_url`), which the two keys below satisfy.
  yq -i ".matrix_rtc.transports[0].type = \"livekit\"" /data/homeserver.yaml
  yq -i ".matrix_rtc.transports[0].livekit_service_url = \"https://${MATRIX_HOST}/livekit/jwt\"" /data/homeserver.yaml
}

if [ -f /data/homeserver.yaml ]; then
  apply_mas_config
  apply_matrixrtc_config
  # KEEP LAST among the apply_* functions. apply_mas_config deletes
  # .experimental_features.msc3861 and apply_matrixrtc_config writes four
  # .experimental_features.* keys; running the denylist write after both means a
  # clobber by either is impossible by construction. This is belt; the braces are
  # the final on-disk re-read immediately before /start.py, which makes the
  # guarantee independent of this ordering if a future apply_* is appended here.
  apply_did_field_protection
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

# -----------------------------------------------------------------------------
# LAST GATE, at the last possible moment before Synapse takes over the process.
#
# apply_did_field_protection() verified its own `yq` exit status; this verifies
# the FILE, after every other apply_* has had its turn at it. Those are different
# claims: "the write command succeeded" does not survive a later function
# replacing the key, the map, or the whole file, and this script deliberately
# runs without `set -e`, so nothing else would notice.
#
# Skipped when /data/homeserver.yaml is absent, on purpose: that path is already
# owned by the WARNING above plus /start.py's own explicit "Config file does not
# exist" error, and stealing it would replace a precise diagnosis with a vaguer
# one. (`/start.py` with no args is run-mode and never rewrites the config —
# verified against v1.159.0's start.py (docker/ unchanged at 1.161.0), which only generates in `generate` /
# `migrate_config` modes — so there is no post-gate write to worry about.)
# -----------------------------------------------------------------------------
if [ -f /data/homeserver.yaml ]; then
  if ! did_field_denylist_on_disk_contains_field; then
    did_field_unprotected_banner "/data/homeserver.yaml does NOT contain '${SIWX_DID_PROFILE_FIELD}' in experimental_features.msc4133_key_denylist at startup — the write never landed, or something later in this entrypoint clobbered it."
    echo "REFUSING TO START: a config write that silently did not happen must not become a running server." >&2
    exit 1
  fi
fi

# Repeat the warning here so it is the LAST thing in the log before Synapse's own
# (very noisy) startup output, rather than something that scrolled away minutes
# ago. An unprotected DID field is a standing condition, not a startup event.
if [ "${SIWX_DID_FIELD_UNPROTECTED_WARN:-}" = "1" ]; then
  did_field_unprotected_banner "STARTING WITH THE FIELD UNPROTECTED because SIWX_ALLOW_UNPROTECTED_DID_FIELD=1 was set. This Synapse does not carry the MSC4133 write-ACL patch."
fi

/start.py
