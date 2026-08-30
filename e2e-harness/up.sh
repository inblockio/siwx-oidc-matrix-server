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

# Same env-overridable digest pin as docker-compose.yml / docker-compose.e2e.yml.
LK_JWT_IMAGE_REF="${LK_JWT_IMAGE_REF:-ghcr.io/element-hq/lk-jwt-service:0.5.0@sha256:29918567e6b7cd920e2853b4cd6848ce01b79947c3d19a9f1ed5b74f0a2a88bf}"

# Env-overridable image refs, same convention as LK_JWT_IMAGE_REF above. The
# defaults are exactly what the harness has always run, so an unset environment
# behaves identically. Overriding lets a version-bump branch validate a candidate
# image WITHOUT clobbering the shared localhost/* tags the siwx-real-* stack uses:
#   SYNAPSE_IMAGE_REF=localhost/siwx-real-synapse:mas e2e-harness/up.sh
SYNAPSE_IMAGE_REF="${SYNAPSE_IMAGE_REF:-localhost/siwx-real-synapse:local}"
SIWX_OIDC_IMAGE_REF="${SIWX_OIDC_IMAGE_REF:-localhost/siwx-oidc:local-grace}"
LIVEKIT_IMAGE_REF="${LIVEKIT_IMAGE_REF:-livekit/livekit-server:v1.12.0}"

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

# 1b. Ensure the self-signed federation cert for the lk-jwt -> Synapse TLS shim.
"${REPO_ROOT}/scripts/gen-e2e-fed-cert.sh"
FED_CERT_DIR="${REPO_ROOT}/e2e-harness/certs"

# 2. Tear down any prior e2e containers (NOT the volumes/network unless --fresh).
#    Remove the fed-proxy first: it shares siwx-e2eh-lk-jwt's network namespace,
#    so it must go before the container that owns that namespace.
echo "[up] removing any existing siwx-e2eh-* containers ..."
for c in siwx-e2eh-fed-proxy siwx-e2eh-caddy siwx-e2eh-lk-jwt siwx-e2eh-livekit siwx-e2eh-synapse siwx-e2eh-oidc siwx-e2eh-redis; do
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
  docker.io/library/redis:7-alpine redis-server --appendonly yes >/dev/null

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
#    First boot generates homeserver.yaml from the env contract in synapse_entrypoint.sh.
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
#    Digest-pinned to the SAME ref production runs (docker-compose.yml), so the
#    harness exercises the pinned binary rather than the moving `latest` label.
#    LIVEKIT_FULL_ACCESS_HOMESERVERS is the harness's own server name, not "*":
#    v0.5.0 refuses to boot without it, and an explicit host exercises the same
#    allowlist parsing prod uses (startup echoes the parsed value).
#    INSECURE_SKIP_VERIFY must be the EXACT magic string YES_I_KNOW_WHAT_I_AM_DOING
#    ("true" is silently ignored), so lk-jwt accepts the self-signed cert the
#    federation TLS shim (step 8b) presents on localhost:8448.
echo "[up] starting siwx-e2eh-lk-jwt"
podman run -d --name siwx-e2eh-lk-jwt --network "${NET}" --restart unless-stopped \
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
  docker.io/library/caddy:2-alpine >/dev/null

# 9. caddy edge (publish 18080 + 18081)
echo "[up] starting siwx-e2eh-caddy (host ${CADDY_EDGE_PORT} + ${SIWEOIDC_HOST_PORT})"
podman run -d --name siwx-e2eh-caddy --network "${NET}" --restart unless-stopped \
  -p "${CADDY_EDGE_PORT}:18080" \
  -p "${SIWEOIDC_HOST_PORT}:18081" \
  -v "${REPO_ROOT}/Caddyfile.e2e:/etc/caddy/Caddyfile:ro" \
  docker.io/library/caddy:2-alpine >/dev/null

echo "[up] all siwx-e2eh-* containers launched. Current state:"
podman ps --filter "name=siwx-e2eh-" --format '  {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo "[up] done. Edge: http://localhost:${CADDY_EDGE_PORT}  OIDC: http://localhost:${SIWEOIDC_HOST_PORT}  Synapse: http://localhost:${SYNAPSE_HOST_PORT}"
