#!/usr/bin/env bash
# =============================================================================
# use-fixed-oidc.sh — swap the e2eh `siwx-e2eh-oidc` container to run the
# FIXED siwx-oidc binary built from the working tree, instead of the prebuilt
# `localhost/siwx-oidc:local-grace` image (which lacks the cross-signing-reset
# honesty fix, B1).
#
# WHY a binary mount (not a rebuilt image): this box builds deploy images via CI,
# not locally, and the proven local pattern (see the long-lived `siwx-real-oidc`
# container) is `docker.io/library/ubuntu:rolling` + the freshly-built
# `target/debug/siwx-oidc` bind-mounted in and run directly. That is what this
# script does, mirroring the EXISTING `siwx-e2eh-oidc` env/network/port verbatim
# (captured live from the running container, so secrets/PEM never need hardcoding).
#
# This makes "run the e2e harness against the fix" a single deliberate step.
# It is idempotent: re-running rebuilds (fast if cached) and recreates the
# container. The rest of the stack (redis/synapse/livekit/lk-jwt/caddy) is left
# untouched, so `run.sh full` works immediately afterwards.
#
# Usage:
#   e2e-harness/use-fixed-oidc.sh            # build + swap (default)
#   SIWX_OIDC_SRC=/path/to/tree e2e-harness/use-fixed-oidc.sh
#
# Env:
#   SIWX_OIDC_SRC   source tree to build + mount (default: the investigate tree
#                   /home/waldknoten-01/siwx-oidc-investigate, where the fix lives).
#                   Must contain the working tree with the B1 fix and be buildable.
#   CONTAINER       container to swap (default: siwx-e2eh-oidc)
#   NET             network (default: siwx-e2eh-net)
#   RUNNER_IMAGE    base image to run the binary in (default: docker.io/library/ubuntu:rolling)
#
# Requires the e2eh stack to be UP (run `up.sh` first if not). It swaps ONLY the
# oidc container; if that container does not exist it errors (bring the stack up).
# =============================================================================
set -euo pipefail

SIWX_OIDC_SRC="${SIWX_OIDC_SRC:-/home/waldknoten-01/siwx-oidc-investigate}"
CONTAINER="${CONTAINER:-siwx-e2eh-oidc}"
NET="${NET:-siwx-e2eh-net}"
RUNNER_IMAGE="${RUNNER_IMAGE:-docker.io/library/ubuntu:rolling}"
BIN_REL="target/debug/siwx-oidc"
BIN="${SIWX_OIDC_SRC}/${BIN_REL}"

log() { printf '[use-fixed-oidc] %s\n' "$*" >&2; }

[ -d "$SIWX_OIDC_SRC" ] || { log "FATAL: source tree $SIWX_OIDC_SRC not found"; exit 2; }

# 1. Build the fixed binary (debug is fine; fast if already built).
log "building fixed siwx-oidc from $SIWX_OIDC_SRC ..."
( cd "$SIWX_OIDC_SRC" && cargo build --bin siwx-oidc ) >&2
[ -x "$BIN" ] || { log "FATAL: $BIN not produced"; exit 2; }

# 2. Sanity: confirm the fix markers are actually in the binary (so we never
#    silently mount the unfixed code). These strings exist ONLY in the fixed code
#    (the `has_cross_signing_keys` readback + the truthful-success log + guidance).
log "verifying fix markers in the built binary ..."
for s in "has_cross_signing_keys" "derived effectiveness decision" "could not confirm your encryption identity reset"; do
  grep -qa "$s" "$BIN" || { log "FATAL: fix marker missing from binary: '$s' — is the B1 fix in $SIWX_OIDC_SRC?"; exit 3; }
done
log "fix markers present — this IS the fixed binary."

# 3. Snapshot the EXISTING container's env + that it is on the expected network,
#    so we recreate it with byte-identical config (secrets/PEM included) without
#    hardcoding anything here.
podman container exists "$CONTAINER" || {
  log "FATAL: $CONTAINER does not exist. Bring the stack up first (e2e-harness/up.sh).";
  exit 2;
}

log "capturing current $CONTAINER env (to mirror exactly) ..."
mapfile -t ENV_KV < <(podman inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}')

# Build the -e args, dropping container-runtime-injected vars we must NOT re-set.
# The signing-key PEM is handled SEPARATELY below: a multi-line value cannot
# survive the `podman inspect` -> bash-array round-trip (its real newlines get
# flattened to a single line, which `EcdsaSigningKey::from_pem` rejects with
# "PEM type label invalid"). So we skip it here and re-inject the canonical PEM
# from .env.e2e with real newlines (the exact approach up.sh uses).
ENV_ARGS=()
SAW_RUST_LOG=""
for kv in "${ENV_KV[@]}"; do
  [ -z "$kv" ] && continue
  key="${kv%%=*}"
  case "$key" in
    PATH|HOME|HOSTNAME|container|TERM|_) continue ;;        # runtime-injected; let the runner set its own
    SIWEOIDC_SIGNING_KEY_PEM) continue ;;                   # re-injected with real newlines below
    RUST_LOG) SAW_RUST_LOG="${kv#RUST_LOG=}"; continue ;;   # augmented below to surface the reset target
  esac
  ENV_ARGS+=( -e "$kv" )
done

# Augment RUST_LOG so the cross-signing-reset honesty fix's decision line is
# VISIBLE. Those logs use a custom tracing target ("cross_signing_reset") which
# the default e2eh filter (siwx_oidc=debug,...,warn) drops at INFO level (the
# global `warn` directive governs the custom target). Add an explicit
# `cross_signing_reset=debug` directive so the readback decision INFO line (and
# any WARN) is captured live on a reset — this is how the harness proves the new
# code path runs. (Reproducible: it is baked into this documented swap step.)
RUST_LOG_BASE="${SAW_RUST_LOG:-siwx_oidc=debug,tower_http=info}"
case "$RUST_LOG_BASE" in
  *cross_signing_reset=*) RUST_LOG_AUG="$RUST_LOG_BASE" ;;
  *)                      RUST_LOG_AUG="${RUST_LOG_BASE},cross_signing_reset=debug" ;;
esac
ENV_ARGS+=( -e "RUST_LOG=${RUST_LOG_AUG}" )
log "RUST_LOG set to: ${RUST_LOG_AUG}"

# Re-inject the signing-key PEM with REAL newlines. Source it from .env.e2e (the
# canonical single-line, \n-escaped form per the harness contract) and un-escape
# with printf '%b' — identical to up.sh. This keeps the SAME key the rest of the
# stack/tokens use, so nothing else has to change.
ENV_FILE_E2E="${ENV_FILE_E2E:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env.e2e}"
[ -f "$ENV_FILE_E2E" ] || { log "FATAL: $ENV_FILE_E2E not found (needed for the signing-key PEM)"; exit 2; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE_E2E"; set +a
PEM_REAL="$(printf '%b' "${SIWEOIDC_SIGNING_KEY_PEM:?SIWEOIDC_SIGNING_KEY_PEM missing from $ENV_FILE_E2E}")"
case "$PEM_REAL" in
  *"-----BEGIN PRIVATE KEY-----"$'\n'*) : ;;  # has a real newline after the label — good
  *) log "FATAL: PEM did not un-escape to real newlines"; exit 3 ;;
esac
ENV_ARGS+=( -e "SIWEOIDC_SIGNING_KEY_PEM=${PEM_REAL}" )

# 4. Recreate ONLY the oidc container as the ubuntu runner with the fixed binary
#    bind-mounted. Same name (so Caddy resolves siwx-e2eh-oidc), same network,
#    same internal port (SIWEOIDC_PORT, carried in the captured env). No host
#    port is published on this container in the e2eh design (the edge Caddy
#    publishes 18081 -> this container's :8081), so we don't add -p.
log "removing old $CONTAINER (prebuilt local-grace image) ..."
podman rm -f "$CONTAINER" >/dev/null

log "recreating $CONTAINER on $NET as $RUNNER_IMAGE running the fixed $BIN_REL ..."
podman run -d --name "$CONTAINER" --network "$NET" --restart unless-stopped \
  "${ENV_ARGS[@]}" \
  -v "${SIWX_OIDC_SRC}:/app:ro" \
  --workdir /app \
  --health-cmd "bash -c 'exec 3<>/dev/tcp/127.0.0.1/\${SIWEOIDC_PORT:-8081} && printf \"GET /health HTTP/1.0\r\n\r\n\" >&3 && grep -q \"200 OK\" <&3'" \
  --health-interval 10s --health-timeout 5s --health-retries 6 --health-start-period 8s \
  "$RUNNER_IMAGE" /app/${BIN_REL} >/dev/null

# 5. Wait for health and verify /health is 200 via the edge (Caddy publishes 18081).
log "waiting for $CONTAINER to become healthy ..."
deadline=$(( $(date +%s) + 90 ))
while :; do
  st="$(podman inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)"
  [ "$st" = "healthy" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "WARNING: $CONTAINER not healthy after 90s (status=$st). Recent logs:"
    podman logs --tail 40 "$CONTAINER" >&2 || true
    break
  fi
  sleep 2
done

EDGE_HEALTH="${EDGE_HEALTH:-http://localhost:18081/health}"
log "probing edge $EDGE_HEALTH ..."
if curl -fsS "$EDGE_HEALTH" >/dev/null 2>&1; then
  log "OK: $EDGE_HEALTH returns success."
else
  log "WARNING: $EDGE_HEALTH did not return success yet (it may still be warming up)."
fi

log "DONE. $CONTAINER now runs the FIXED siwx-oidc ($BIN)."
log "Image: $(podman inspect "$CONTAINER" --format '{{.ImageName}}')   Cmd: $(podman inspect "$CONTAINER" --format '{{json .Config.Cmd}}')"
log "Run the e2e contract-lock tests with:"
log "  SIWEOIDC_HOST=http://localhost:18081 MATRIX_HOST=http://localhost:18080 \\"
log "    cargo test --test e2e_msc4191_live cross_signing_reset -- --ignored --nocapture   (from the oidc test tree)"
