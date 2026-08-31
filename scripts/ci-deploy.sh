#!/usr/bin/env bash
# ci-deploy.sh — dev-staging deploy target for the matrix-staging compose
# project on dev-aquafire (207.154.209.103).
#
# ---------------------------------------------------------------------------
# THIS FILE IS THE SOURCE OF TRUTH. The copy that actually runs lives at
# /home/dev/matrix-staging/ci-deploy.sh on the box. Until 2026-08-30 that box
# copy was the ONLY copy: unversioned, unreviewed, and converging the whole
# dev-staging stack every 5 minutes. It was brought into the repo so the script
# that gates every deploy can be reviewed like any other code.
#
# To update the box: copy this file to /home/dev/matrix-staging/ci-deploy.sh
# (mode 755, owner dev). Do NOT edit the box copy in place — a drifted box copy
# is exactly the condition this file exists to end.
# ---------------------------------------------------------------------------
#
# INVOKED as an SSH forced-command (see /home/dev/.ssh/authorized_keys) by
# the push-model CI job, AND on a schedule by the box-local
# matrix-staging-deploy.timer (pull-model, primary auto-deploy mechanism —
# see docs/2026-07-30-dev-staging-dev-aquafire.md section 9). The client's
# SSH command string is never trusted or parsed — this script takes no
# arguments and ignores $SSH_ORIGINAL_COMMAND entirely.
#
# IMAGE PINS (corrected 2026-08-30 — the previous header was wrong on all
# three counts). Images are selected by per-service `*_IMAGE_REF` variables in
# .env: SYNAPSE_IMAGE_REF, ELEMENT_IMAGE_REF, SIWX_OIDC_IMAGE_REF,
# REDIS_IMAGE_REF, LK_JWT_IMAGE_REF. The single shared `IMAGE_TAG` variable the
# old header described was REMOVED on 2026-07-31 in favour of those. Synapse,
# element-web and siwx-oidc currently FLOAT on the `:dev` tag (that is what
# makes this box the CD sink); redis and lk-jwt are digest-pinned. Nothing is
# "frozen at sha-4266aa8", and the Synapse 1.157 incompatibility that froze it
# was RESOLVED by the 1.159 + MAS migration on 2026-08-30 (see
# docs/superpowers/plans/2026-08-30-dev-stack-upgrade.md). `docker compose
# pull && up -d` reads the refs from .env, so this script never overrides
# them — it only ever converges to whatever .env already pins.
#
# Idempotent: safe to run repeatedly; a no-op pull still runs the same smoke
# checks. Exits nonzero on ANY failure (bad pull, container not healthy,
# smoke check fails) so CI reflects real deploy state.
#
# Two triggers (CI push, box timer) can now fire close together, so the
# whole body runs under an exclusive, blocking flock — a timer tick waits
# out an in-flight CI-triggered deploy (and vice versa) instead of racing
# `docker compose pull`/`up -d` against it. If the lock can't be acquired
# within the timeout, this exits nonzero same as any other failure.

set -euo pipefail

STACK_DIR="/home/dev/matrix-staging"
COMPOSE_FILE="docker-compose.dev-staging.yml"
PROJECT="matrix-staging"
LOCK_FILE="/home/dev/matrix-staging/.deploy.lock"
LOCK_WAIT_SECS=120

log() {
    printf '[ci-deploy] %s\n' "$*"
}

fail() {
    printf '[ci-deploy] FAIL: %s\n' "$*" >&2
    exit 1
}

# Acquire the deploy lock (fd 9) before touching anything. Blocks up to
# LOCK_WAIT_SECS for a concurrent run (push-model CI or the timer) to
# finish; fails loudly rather than hanging forever or racing.
exec 9>"$LOCK_FILE"
if ! flock -w "$LOCK_WAIT_SECS" 9; then
    fail "could not acquire deploy lock ($LOCK_FILE) within ${LOCK_WAIT_SECS}s — another deploy is already running"
fi
log "acquired deploy lock ($LOCK_FILE)"

cd "$STACK_DIR" || fail "cannot cd to $STACK_DIR"

[ -f "$COMPOSE_FILE" ] || fail "$COMPOSE_FILE not found in $STACK_DIR"
[ -f .env ] || fail ".env not found in $STACK_DIR (secrets missing?)"

compose() {
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT" "$@"
}

log "pulling images (refs come from .env — the *_IMAGE_REF pins stay as configured)"
compose pull

log "starting/recreating changed services"
compose up -d --remove-orphans

# --- Health gate ---------------------------------------------------------
# REWRITTEN 2026-08-30. The previous gate was:
#
#     compose ps --format '{{.Name}} {{.Health}}' | awk '$2 != "" && $2 != "healthy"'
#
# which passed a stack containing a dead container, in TWO independent ways:
#
#   (1) `$2 != ""` deliberately skipped every container with an EMPTY Health
#       field — i.e. every container with no healthcheck. lk-jwt-service has
#       had `healthcheck: disable: true` since 0.6.0 (its image healthcheck is
#       unconditionally broken; see docker-compose.dev-staging.yml), so it was
#       reporting Health="" and being filtered out of its own health gate.
#       Verified on the live box 2026-08-30: the old awk printed NOTHING while
#       lk-jwt-service was entirely ungated.
#   (2) `compose ps` without --all lists only RUNNING containers, so a service
#       that had exited vanished from the list rather than being flagged. An
#       empty list read as "all healthy".
#
# The gate now uses --all, checks State as well as Health, and separately
# asserts that every service declared in the compose file actually produced a
# container — a service that failed to create one has no row to inspect.
log "waiting for services to report healthy (up to 90s)"

EXPECTED_SERVICES="$(compose config --services | sort)"
[ -n "$EXPECTED_SERVICES" ] || fail "compose config --services returned nothing — cannot verify stack completeness"

deadline=$((SECONDS + 90))
while true; do
    ps_rows="$(compose ps --all --format '{{.Service}}\t{{.Name}}\t{{.State}}\t{{.Health}}' 2>/dev/null || true)"

    # A service with no container row at all is a failure, not an absence.
    missing="$(comm -23 <(printf '%s\n' "$EXPECTED_SERVICES") \
                        <(printf '%s\n' "$ps_rows" | awk -F'\t' 'NF{print $1}' | sort -u))"

    # Bad = not running, OR has a healthcheck that is not reporting healthy.
    # NOTE: an empty Health field is NOT treated as healthy on its own; it is
    # only acceptable when State is "running" (i.e. the container has no
    # healthcheck but is up). That is what the old gate got wrong.
    bad="$(printf '%s\n' "$ps_rows" | awk -F'\t' '
        NF == 0 { next }
        $3 != "running"                  { printf "%s (%s): state=%s health=%s\n", $1, $2, $3, ($4==""?"<none>":$4); next }
        $4 != "" && $4 != "healthy"      { printf "%s (%s): state=%s health=%s\n", $1, $2, $3, $4 }
    ')"

    if [ -z "$missing" ] && [ -z "$bad" ]; then
        log "all services present and running (health-checked ones report healthy)"
        break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
        log "stack did not converge within 90s:"
        [ -n "$missing" ] && { log "  services with NO container at all:"; printf '    %s\n' $missing >&2; }
        [ -n "$bad" ]     && { log "  containers not running / not healthy:"; printf '%s\n' "$bad" >&2; }
        compose ps --all
        fail "timed out waiting for container health"
    fi
    sleep 5
done

log "compose ps summary:"
compose ps --all

# --- Smoke checks: exercise the real public HTTPS path through Caddy ---
# (Caddy is a separate compose project on this box, deliberately not
# touched here — see docker-compose.dev-staging.yml header. These checks
# only confirm the public path still works after this project's deploy.)
#
# Retry each smoke check a few times — Caddy/upstream can need a moment
# right after a container recreate even once docker reports "healthy".
#
# (A non-retrying `smoke()` helper used to be defined here and was never
# called by anything. Removed 2026-08-30: an uncalled helper in a deploy gate
# reads as coverage that does not exist.)
smoke_with_retry() {
    local name="$1" url="$2" attempt
    for attempt in 1 2 3 4 5; do
        if curl -sS --fail --max-time 15 -o /dev/null "$url"; then
            log "smoke check ok: $name ($url)"
            return 0
        fi
        log "smoke check attempt $attempt/5 failed for $name, retrying in 5s"
        sleep 5
    done
    fail "smoke check failed after retries: $name ($url)"
}

smoke_with_retry "siwx-oidc discovery"    "https://dev.siwx.inblock.io/.well-known/openid-configuration"
smoke_with_retry "matrix well-known"      "https://dev.matrix.inblock.io/.well-known/matrix/client"
smoke_with_retry "element web root"       "https://dev.element.inblock.io/"
# lk-jwt-service has no container healthcheck (0.6.0's image healthcheck is
# unconditionally broken and is disabled in the compose file), so this external
# probe is the ONLY thing gating it. The compose file promised this probe when
# it disabled the healthcheck; it was never actually added until 2026-08-30,
# leaving MatrixRTC token issuance completely ungated by the deploy. The path
# matches the `livekit_service_url` advertised in .well-known/matrix/client.
smoke_with_retry "lk-jwt healthz"         "https://dev.matrix.inblock.io/livekit/jwt/healthz"

# --- Report what actually got deployed ---
# Resolve by compose SERVICE, never by container name: Docker renames a
# container on name conflict (the live Synapse is currently
# `fa538faf65ed_matrix-staging-matrix_synapse-1`), so any hardcoded
# `<project>-<service>-1` literal would silently resolve to nothing.
log "deployed image digests:"
for svc in siwx-oidc matrix_synapse element-web livekit lk-jwt-service redis; do
    cid=$(compose ps -q "$svc" || true)
    if [ -z "$cid" ]; then
        log "  $svc: no container found"
        continue
    fi
    image_id=$(docker inspect --format='{{.Image}}' "$cid" 2>/dev/null || true)
    digest=$(docker image inspect --format='{{join .RepoDigests ", "}}' "$image_id" 2>/dev/null || true)
    log "  $svc: ${digest:-<no repo digest, locally built or untagged>}"
done

log "deploy complete"
