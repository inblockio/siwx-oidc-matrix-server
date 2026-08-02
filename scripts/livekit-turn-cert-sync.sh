#!/usr/bin/env bash
#
# livekit-turn-cert-sync.sh
#
# Sync-copies the Caddy-managed Let's Encrypt certificate for the embedded
# LiveKit TURN-TLS listener out of Caddy's ACME storage and into the LiveKit
# compose stack's own directory, restarting the `livekit` service only when
# the copied cert/key bytes actually changed.
#
# WHY SYNC-COPY, NEVER BIND-MOUNT: Caddy renews certificates by writing the
# new cert/key to fresh files and atomically renaming them over the old
# ones. A bind-mount of Caddy's live files would pin the container to
# whatever inode was mounted at container-start time and silently stop
# tracking renewals. Copying on a timer is the safe pattern here. See
# docs/superpowers/plans/2026-08-02-livekit-embedded-turn.md.
#
# NO HOT RELOAD: livekit-server reads cert_file/key_file once at process
# start, so a cert change requires a container restart to take effect. This
# script restarts `livekit` only when the sha256 of the synced cert+key
# changes (tracked in STATE_FILE), and verifies the restart actually brought
# TURN back up before exiting successfully.
#
# Must run as root: Caddy's ACME certificate directory is 700 root:root.
#
# All parameters are env-overridable; the defaults below are dev-staging's.
#   TURN_CERT_DOMAIN   - the cert's SAN / Caddy site name
#   TURN_CERT_SRC_DIR  - directory holding <domain>.crt / <domain>.key
#   TURN_CERT_DST_DIR  - where synced tls.crt/tls.key are written (mounted
#                        read-only into the livekit container)
#   STACK_DIR          - compose project directory (cwd for `docker compose`)
#   COMPOSE_FILE       - compose file name, resolved relative to STACK_DIR
#   COMPOSE_PROJECT    - compose -p project name
#   STATE_FILE         - checksum-state file gating the restart

set -euo pipefail

log() { printf '[turn-cert-sync] %s\n' "$*"; }
fatal() { log "FATAL: $*"; exit 1; }

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  fatal "must run as root (Caddy's ACME certificate directory is 700 root:root)"
fi

TURN_CERT_DOMAIN="${TURN_CERT_DOMAIN:-dev.matrix.inblock.io}"
TURN_CERT_SRC_DIR="${TURN_CERT_SRC_DIR:-/var/lib/docker/volumes/caddy-proxy_caddy_data/_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${TURN_CERT_DOMAIN}}"
STACK_DIR="${STACK_DIR:-/home/dev/matrix-staging}"
TURN_CERT_DST_DIR="${TURN_CERT_DST_DIR:-${STACK_DIR}/config/livekit-tls}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.dev-staging.yml}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-matrix-staging}"
STATE_FILE="${STATE_FILE:-${TURN_CERT_DST_DIR}/.sync-state}"

SRC_CRT="${TURN_CERT_SRC_DIR}/${TURN_CERT_DOMAIN}.crt"
SRC_KEY="${TURN_CERT_SRC_DIR}/${TURN_CERT_DOMAIN}.key"

log "domain=${TURN_CERT_DOMAIN} src=${TURN_CERT_SRC_DIR} dst=${TURN_CERT_DST_DIR} stack=${STACK_DIR}"

[ -d "$STACK_DIR" ] || fatal "STACK_DIR not found: $STACK_DIR"
[ -f "${STACK_DIR}/${COMPOSE_FILE}" ] || fatal "compose file not found: ${STACK_DIR}/${COMPOSE_FILE}"
[ -r "$SRC_CRT" ] || fatal "source cert not found or not readable: $SRC_CRT"
[ -r "$SRC_KEY" ] || fatal "source key not found or not readable: $SRC_KEY"
command -v openssl >/dev/null 2>&1 || fatal "openssl not found on PATH"
command -v docker >/dev/null 2>&1 || fatal "docker not found on PATH"

if ! openssl x509 -noout -in "$SRC_CRT" >/dev/null 2>&1; then
  fatal "source cert does not parse as a valid X.509 certificate: $SRC_CRT"
fi
log "source cert parses OK: $(openssl x509 -noout -subject -enddate -in "$SRC_CRT" | tr '\n' ' ')"

mkdir -p "$TURN_CERT_DST_DIR"

# Combine cert+key content into one fingerprint so either changing triggers
# a resync; sha256sum of the concatenated bytes, not of filenames.
SRC_HASH="$(cat "$SRC_CRT" "$SRC_KEY" | sha256sum | awk '{print $1}')"

if [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE")" = "$SRC_HASH" ]; then
  log "up to date (sha256=${SRC_HASH:0:12}...), no restart needed"
  exit 0
fi

log "change detected (sha256=${SRC_HASH:0:12}...), syncing to ${TURN_CERT_DST_DIR}"
install -m 600 -o root -g root "$SRC_CRT" "${TURN_CERT_DST_DIR}/tls.crt"
install -m 600 -o root -g root "$SRC_KEY" "${TURN_CERT_DST_DIR}/tls.key"
printf '%s\n' "$SRC_HASH" > "$STATE_FILE"
chmod 600 "$STATE_FILE"

log "restarting livekit (compose file=${COMPOSE_FILE} project=${COMPOSE_PROJECT})"
( cd "$STACK_DIR" && docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" restart livekit )

# ---- post-restart verification -------------------------------------------
# Resolve the container id fresh (restart can recreate it) before polling.
CONTAINER_ID=""
for _ in $(seq 1 15); do
  CONTAINER_ID="$(cd "$STACK_DIR" && docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" ps -q livekit || true)"
  [ -n "$CONTAINER_ID" ] && break
  sleep 1
done
[ -n "$CONTAINER_ID" ] || fatal "could not resolve the livekit container id after restart"

log "verifying TURN came back up (container=${CONTAINER_ID:0:12}, timeout 60s)"

turn_ok=0
ext_ip_ok=0
deadline=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  logs="$(docker logs --since 2m "$CONTAINER_ID" 2>&1 || true)"

  if [ "$turn_ok" -eq 0 ] && printf '%s\n' "$logs" | grep -q 'Starting TURN server'; then
    turn_ok=1
    log "TURN startup confirmed ('Starting TURN server' seen)"
  fi

  if [ "$ext_ip_ok" -eq 0 ]; then
    ext_line="$(printf '%s\n' "$logs" | grep 'using external IPs' | tail -1 || true)"
    if [ -n "$ext_line" ]; then
      # Count ips-array ELEMENTS, not raw IPv4s: each healthy element is an
      # "external/local" PAIR (two IPv4s), so counting bare addresses reads a
      # healthy single-entry line as 2. An element starts with `"<ip>/`.
      ip_count="$(printf '%s' "$ext_line" | grep -oE '"([0-9]{1,3}\.){3}[0-9]{1,3}/' | wc -l)"
      if [ "$ip_count" -eq 1 ]; then
        ext_ip_ok=1
        log "single external IP entry confirmed: $(printf '%s' "$ext_line" | grep -oE '"([0-9]{1,3}\.){3}[0-9]{1,3}/' | tr -d '"/')"
      else
        log "WARNING: 'using external IPs' has ${ip_count} entries (want exactly 1): ${ext_line}"
      fi
    fi
  fi

  [ "$turn_ok" -eq 1 ] && [ "$ext_ip_ok" -eq 1 ] && break
  sleep 2
done

if [ "$turn_ok" -ne 1 ] || [ "$ext_ip_ok" -ne 1 ]; then
  log "FATAL: post-restart verification failed (turn_startup_seen=${turn_ok} single_external_ip_seen=${ext_ip_ok})"
  log "----- last 2m of livekit logs (diagnostics) -----"
  docker logs --since 2m "$CONTAINER_ID" 2>&1 | tail -100 || true
  exit 1
fi

log "verification OK: TURN server started and exactly one external IP advertised"
