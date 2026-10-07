#!/usr/bin/env bash
# up.sh — bring up the hermetic LOCAL e2e harness (siwx-e2eh-*) via raw podman.
#
# This box has no working docker-compose plugin and no podman-compose, so this
# script is the live bring-up. It mirrors docker-compose.e2e.yml (the canonical
# declarative artifact) and the siwx-real-* run pattern. Idempotent: re-running
# removes any prior siwx-e2eh-* containers first (volumes/network are preserved
# unless --fresh is passed).
#
# Usage:
#   e2e-harness/up.sh           # bring up (reuse existing volumes)
#   e2e-harness/up.sh --fresh   # also wipe the matrix + redis data volumes first
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.e2e"
NET="siwx-e2eh-net"

# Same env-overridable digest pin as docker-compose.e2e.yml (0.6.0; see the
# note there on why it is not docker-compose.yml's 0.7.0).
LK_JWT_IMAGE_REF="${LK_JWT_IMAGE_REF:-ghcr.io/element-hq/lk-jwt-service:0.6.0@sha256:822f0c03a3bdd924da92afc2e8ec59de5dda17af42d32e71e11f269c3517abf7}"

# siwx-oidc + Synapse image refs. Both are DERIVED from source and built on
# demand by e2e-harness/images.sh (see its header for the scheme and why the
# old hand-built defaults, `siwx-oidc:e2eh-5f47a9b` / `siwx-real-synapse:local`,
# were replaced). Overrides keep working exactly as before, e.g. to validate a
# candidate image without touching the shared tags:
#   SYNAPSE_IMAGE_REF=localhost/siwx-real-synapse:mas e2e-harness/up.sh
#   SIWX_OIDC_IMAGE_REF=localhost/siwx-oidc:t3-final   e2e-harness/up.sh
# Resolved (and built if missing) BEFORE any running container is removed, so a
# missing image can never leave you with a half-torn-down stack.
# shellcheck source=images.sh
. "${REPO_ROOT}/e2e-harness/images.sh"
e2eh_ensure_images || { echo "[up] FATAL: harness images unavailable (see above)." >&2; exit 1; }
echo "[up] siwx-oidc image: ${SIWX_OIDC_IMAGE_REF}"
echo "[up] synapse image  : ${SYNAPSE_IMAGE_REF}"
LIVEKIT_IMAGE_REF="${LIVEKIT_IMAGE_REF:-livekit/livekit-server:v1.13.6@sha256:e37d68f172556d02aa77968b9fc55ef481468c0315fa38e4fa6c56ce72e3a815}"

# Element Call standalone SPA, the version production embeds (v0.24.0, revision
# 6f7dac31). Pinned by the multi-arch index digest; element-call-check.sh then
# pins what is SERVED (entry chunk sha256, plain and .gz). H14 design:
# aqua-agents docs/handover/2026-10-08-scribe-harness-h14-element-call-design.md.
ELEMENT_CALL_IMAGE_REF="${ELEMENT_CALL_IMAGE_REF:-ghcr.io/element-hq/element-call:v0.24.0@sha256:e5ffed2141f4807a7437f4bf55da131fb6ac180f8d058d4ad3a32a581d991316}"

FRESH=0
[ "${1:-}" = "--fresh" ] && FRESH=1

# 1. Ensure .env.e2e exists (generate if missing).
if [ ! -f "${ENV_FILE}" ]; then
  echo "[up] .env.e2e missing — generating via scripts/gen-e2e-env.sh"
  "${REPO_ROOT}/scripts/gen-e2e-env.sh"
fi
# shellcheck disable=SC1090
set -a; . "${ENV_FILE}"; set +a

# The PEM is stored in .env.e2e as a single line with literal \n escapes (per the
# A1 spec). siwx-oidc's EcdsaSigningKey::from_pem expects REAL newlines and does
# NOT un-escape, so convert \n -> newline here before injecting into the container.
# (godotenv/compose would do this automatically; raw `podman -e` does not.)
SIWEOIDC_SIGNING_KEY_PEM="$(printf '%b' "${SIWEOIDC_SIGNING_KEY_PEM}")"

# Element Call's edge port. An .env.e2e generated before 2026-10-08 has no such
# line, so default it here instead of forcing a regeneration.
ELEMENT_CALL_HOST_PORT="${ELEMENT_CALL_HOST_PORT:-18082}"
# MSC4143 rtc/transports must name a focus the browser can reach. The entrypoint
# default (https://${MATRIX_HOST}/livekit/jwt = https://localhost/livekit/jwt)
# has no listener here, and Element Call 0.24.0 no longer reads .well-known.
MATRIX_RTC_LIVEKIT_SERVICE_URL="${MATRIX_BASE_URL}/livekit/jwt"
echo "[up] synapse rtc/transports livekit_service_url: ${MATRIX_RTC_LIVEKIT_SERVICE_URL}"

# 1b. Ensure the self-signed federation cert for the lk-jwt -> Synapse TLS shim.
"${REPO_ROOT}/scripts/gen-e2e-fed-cert.sh"
FED_CERT_DIR="${REPO_ROOT}/e2e-harness/certs"

# 2. Tear down any prior e2e containers (NOT the volumes/network unless --fresh).
#    Remove the fed-proxy first: it shares siwx-e2eh-lk-jwt's network namespace,
#    so it must go before the container that owns that namespace.
echo "[up] removing any existing siwx-e2eh-* containers ..."
for c in siwx-e2eh-fed-proxy siwx-e2eh-caddy siwx-e2eh-element-call siwx-e2eh-lk-jwt siwx-e2eh-livekit siwx-e2eh-synapse siwx-e2eh-oidc siwx-e2eh-redis; do
  podman rm -f "$c" >/dev/null 2>&1 || true
done

# 3. Network + volumes.
podman network exists "${NET}" || { echo "[up] creating network ${NET}"; podman network create "${NET}" >/dev/null; }
if [ "${FRESH}" = "1" ]; then
  echo "[up] --fresh: removing data volumes"
  podman volume rm siwx-e2eh-matrix-data siwx-e2eh-redis-data >/dev/null 2>&1 || true
fi
podman volume exists siwx-e2eh-matrix-data || podman volume create siwx-e2eh-matrix-data >/dev/null
podman volume exists siwx-e2eh-redis-data  || podman volume create siwx-e2eh-redis-data  >/dev/null

# 4. redis
echo "[up] starting siwx-e2eh-redis"
podman run -d --name siwx-e2eh-redis --network "${NET}" --restart unless-stopped \
  -v siwx-e2eh-redis-data:/data \
  --health-cmd "redis-cli ping" --health-interval 10s --health-timeout 5s --health-retries 5 \
  docker.io/library/redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 redis-server --appendonly yes >/dev/null

# 5. siwx-oidc (SIWX_OIDC_IMAGE_REF; listens on 8081 internally)
echo "[up] starting siwx-e2eh-oidc"
podman run -d --name siwx-e2eh-oidc --network "${NET}" --restart unless-stopped \
  -e SIWEOIDC_ADDRESS=0.0.0.0 \
  -e SIWEOIDC_PORT=8081 \
  -e SIWEOIDC_BASE_URL="${SIWEOIDC_BASE_URL}" \
  -e SIWEOIDC_MATRIX_SERVER_NAME="${MATRIX_SERVER_NAME}" \
  -e SIWEOIDC_REQUIRE_SECRET=false \
  -e SIWEOIDC_SUPPORTED_DID_METHODS='["pkh","key"]' \
  -e SIWEOIDC_REDIS_URL="${REDIS_INTERNAL_URL}" \
  -e SIWEOIDC_SYNAPSE_ENDPOINT="${SYNAPSE_INTERNAL_ENDPOINT}" \
  -e SIWEOIDC_MAS_SHARED_SECRET="${MAS_SHARED_SECRET}" \
  -e SIWEOIDC_SIGNING_KEY_PEM="${SIWEOIDC_SIGNING_KEY_PEM}" \
  -e RUST_LOG="${RUST_LOG}" \
  --health-cmd "wget --no-verbose --tries=1 --spider http://127.0.0.1:8081/.well-known/openid-configuration" \
  --health-interval 10s --health-timeout 5s --health-retries 5 --health-start-period 10s \
  "${SIWX_OIDC_IMAGE_REF}" >/dev/null

# 6. synapse (SYNAPSE_IMAGE_REF; internal 8008, published 18448)
#    First boot generates homeserver.yaml from the env contract in entrypoints/matrix_server.sh.
echo "[up] starting siwx-e2eh-synapse (host ${SYNAPSE_HOST_PORT} -> 8008)"
podman run -d --name siwx-e2eh-synapse --network "${NET}" --restart unless-stopped \
  -p "127.0.0.1:${SYNAPSE_HOST_PORT}:8008" \
  -e SYNAPSE_SERVER_NAME="${MATRIX_SERVER_NAME}" \
  -e SYNAPSE_REPORT_STATS=no \
  -e MATRIX_HOST="${MATRIX_SERVER_NAME}" \
  -e MATRIX_PORT=8008 \
  -e MATRIX_BASE_URL="${MATRIX_BASE_URL}" \
  -e SIWEOIDC_PUBLIC_ISSUER="${SIWEOIDC_PUBLIC_ISSUER}" \
  -e SIWEOIDC_INTERNAL_URL="${SIWEOIDC_INTERNAL_URL}" \
  -e MAS_SHARED_SECRET="${MAS_SHARED_SECRET}" \
  -e MATRIX_RTC_LIVEKIT_SERVICE_URL="${MATRIX_RTC_LIVEKIT_SERVICE_URL}" \
  -v siwx-e2eh-matrix-data:/data \
  --health-cmd "curl -fSs http://localhost:8008/health || exit 1" \
  --health-interval 15s --health-timeout 5s --health-retries 5 --health-start-period 30s \
  "${SYNAPSE_IMAGE_REF}" >/dev/null

# 7. livekit (publish 7880 for the AV check + 7881/tcp + 20100-20200 (below the ephemeral range)/udp)
echo "[up] starting siwx-e2eh-livekit"
podman run -d --name siwx-e2eh-livekit --network "${NET}" --restart unless-stopped \
  -p "${LIVEKIT_HOST_PORT}:7880" \
  -p "${LIVEKIT_RTC_TCP_PORT}:7881/tcp" \
  -p "${LIVEKIT_RTC_UDP_START}-${LIVEKIT_RTC_UDP_END}:${LIVEKIT_RTC_UDP_START}-${LIVEKIT_RTC_UDP_END}/udp" \
  -e LIVEKIT_KEYS="${LIVEKIT_KEY}: ${LIVEKIT_SECRET}" \
  -v "${REPO_ROOT}/config/livekit.e2e.yaml:/etc/livekit.yaml:ro" \
  "${LIVEKIT_IMAGE_REF}" --config /etc/livekit.yaml >/dev/null

# 8. lk-jwt-service (internal :8080; reached via caddy /livekit/jwt)
#    Digest-pinned (LK_JWT_IMAGE_REF above), so the harness exercises one fixed
#    binary rather than the moving `latest` label.
#    LIVEKIT_FULL_ACCESS_HOMESERVERS is the harness's own server name, not "*":
#    v0.5.0 refuses to boot without it, and an explicit host exercises the same
#    allowlist parsing prod uses (startup echoes the parsed value).
#    INSECURE_SKIP_VERIFY must be the EXACT magic string YES_I_KNOW_WHAT_I_AM_DOING
#    ("true" is silently ignored), so lk-jwt accepts the self-signed cert the
#    federation TLS shim (step 8b) presents on localhost:8448.
#    --no-healthcheck: 0.6.0 ships an image-level HEALTHCHECK whose helper
#    builds "http://localhost:" + LIVEKIT_JWT_BIND, so ":8080" yields
#    "http://localhost::8080/healthz" and fails forever; a bare "8080" fixes
#    the helper but makes the server exit 1 ("missing port in address").
#    Mutually exclusive -> disable it (matches this service's long-standing
#    "no healthcheck by design"); probe /healthz externally instead.
echo "[up] starting siwx-e2eh-lk-jwt"
podman run -d --name siwx-e2eh-lk-jwt --network "${NET}" --restart unless-stopped \
  --no-healthcheck \
  -e LIVEKIT_URL="ws://siwx-e2eh-livekit:7880" \
  -e LIVEKIT_KEY="${LIVEKIT_KEY}" \
  -e LIVEKIT_SECRET="${LIVEKIT_SECRET}" \
  -e LIVEKIT_JWT_BIND=":8080" \
  -e LIVEKIT_FULL_ACCESS_HOMESERVERS="${MATRIX_SERVER_NAME}" \
  -e LIVEKIT_INSECURE_SKIP_VERIFY_TLS="YES_I_KNOW_WHAT_I_AM_DOING" \
  "${LK_JWT_IMAGE_REF}" >/dev/null

# 8b. Federation TLS shim — runs IN siwx-e2eh-lk-jwt's network namespace so its
#     localhost:8448 IS the loopback lk-jwt dials when resolving the "localhost"
#     server-name. TLS-terminates with the self-signed cert and reverse-proxies
#     plain HTTP to the e2eh Synapse federation port (siwx-e2eh-synapse:8008,
#     resolvable because the namespace is on ${NET}). See config/fed-proxy.e2e.Caddyfile.
echo "[up] starting siwx-e2eh-fed-proxy (lk-jwt netns -> localhost:8448 TLS -> synapse:8008)"
podman run -d --name siwx-e2eh-fed-proxy --network "container:siwx-e2eh-lk-jwt" --restart unless-stopped \
  -v "${REPO_ROOT}/config/fed-proxy.e2e.Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "${FED_CERT_DIR}/fed.crt:/certs/fed.crt:ro" \
  -v "${FED_CERT_DIR}/fed.key:/certs/fed.key:ro" \
  docker.io/library/caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b >/dev/null

# 8c. Element Call SPA (internal :8080; reached via the caddy edge :18082).
#     config.json is a read-only bind mount of config/element-call.e2e.json
#     (production's widget config plus the homeserver and LiveKit service URL a
#     standalone SPA needs). The check fails the bring-up unless the container
#     serves the pinned entry chunk and that exact config.
echo "[up] starting siwx-e2eh-element-call"
podman run -d --name siwx-e2eh-element-call --network "${NET}" --restart unless-stopped \
  -v "${REPO_ROOT}/config/element-call.e2e.json:/app/config.json:ro" \
  "${ELEMENT_CALL_IMAGE_REF}" >/dev/null
"${REPO_ROOT}/e2e-harness/element-call-check.sh" siwx-e2eh-element-call "${REPO_ROOT}/config/element-call.e2e.json" || {
  echo "[up] FATAL: siwx-e2eh-element-call does not serve the pinned build; removing it." >&2
  podman rm -f siwx-e2eh-element-call >/dev/null 2>&1 || true
  exit 1
}

# 9. caddy edge (publish 18080 + 18081 + 18082)
echo "[up] starting siwx-e2eh-caddy (host ${CADDY_EDGE_PORT} + ${SIWEOIDC_HOST_PORT} + ${ELEMENT_CALL_HOST_PORT})"
podman run -d --name siwx-e2eh-caddy --network "${NET}" --restart unless-stopped \
  -p "${CADDY_EDGE_PORT}:18080" \
  -p "${SIWEOIDC_HOST_PORT}:18081" \
  -p "${ELEMENT_CALL_HOST_PORT}:18082" \
  -v "${REPO_ROOT}/Caddyfile.e2e:/etc/caddy/Caddyfile:ro" \
  docker.io/library/caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b >/dev/null

echo "[up] all siwx-e2eh-* containers launched. Current state:"
podman ps --filter "name=siwx-e2eh-" --format '  {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo "[up] done. Edge: http://localhost:${CADDY_EDGE_PORT}  OIDC: http://localhost:${SIWEOIDC_HOST_PORT}  Synapse: http://localhost:${SYNAPSE_HOST_PORT}  Element Call: http://localhost:${ELEMENT_CALL_HOST_PORT}"
