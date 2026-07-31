#!/usr/bin/env bash
#
# prod-caddy-harden-20260731.sh — Stage-B2 hardening for the LIVE prod Caddy
# config (/home/portal/portal/Caddyfile on the `agentic.inblock.io` box,
# mounted into the `portal-caddy-1` container). NOT YET RUN. This script is
# the deploy vehicle for the changes already made to the repo copy
# (Caddyfile.production) and to Caddyfile.dev-aquafire in this same commit —
# see docs/2026-07-31-element-deploy-audit-checklist.md, "Chosen fix
# locations, 2026-07-31" section.
#
# Applies EXACTLY three things to the LIVE file, nothing else:
#   1. HSTS (`header ?Strict-Transport-Security "max-age=31536000"`) on the
#      element.inblock.io AND matrix.inblock.io site blocks.
#   2. `/.well-known/matrix/support` (MSC1929) on matrix.inblock.io.
#   3. Synapse `Server` banner suppression (`header_down -Server`) on the
#      matrix.inblock.io block's matrix_synapse:8080 handles.
#
# Does NOT touch: any other site block (siwx-oidc.inblock.io, portal,
# openwitness, timestamps, audit, viewer, projects, ...), the existing
# header_down -Access-Control-* CORS stripping anywhere in the file, the
# MSC4191 device-delete redirect, or the pre-existing
# `"m.authentication.account"` well-known quirk. Those are catalogued,
# unrelated drift — see the checklist doc — and are explicitly out of scope.
#
# Design:
#   - Idempotent: if all three changes are already present, the script
#     prints PASS-idempotent and exits 0 without touching anything.
#   - Safety gate: BEFORE patching, the live file's sha256 must match
#     EXPECTED_SHA256 below (the hash of the exact baseline this script's
#     patch logic was written against — a snapshot of the live file taken
#     2026-07-31, copied to this repo's audit scratchpad and diffed against
#     Caddyfile.production; see the checklist doc's drift note). A mismatch
#     means the live file changed since this script was authored (someone
#     else edited it, or a previous run partially applied) — ABORT rather
#     than guess.
#   - Patch is anchor-based exact string replacement (python3), not a blind
#     append/regex — each anchor must match EXACTLY ONCE in the live file or
#     the script aborts before writing anything.
#   - Backup, validate-before-reload, and a restore path on any failure.
#     Post-deploy header/content checks are informational: they PASS/FAIL
#     per check but never auto-restore (headers are non-fatal to the stack;
#     the operator decides).
#
# Usage (on the prod box, as the `portal` deploy user or with sudo docker):
#   ./prod-caddy-harden-20260731.sh
#
# Testing override (used to verify this script's patch logic against a
# scratch copy WITHOUT touching prod — see the Stage-B2 prep task): set
# CADDY_FILE to a scratch path. Never set this in production use.
set -euo pipefail

CADDY_FILE="${CADDY_FILE:-/home/portal/portal/Caddyfile}"
CADDY_CONTAINER="${CADDY_CONTAINER:-portal-caddy-1}"
# Host-side source path as it appears in `docker inspect`'s Mounts[].Source
# for the real deployment. Kept independently overridable (defaults to
# CADDY_FILE's default, not to $CADDY_FILE) purely so this script's
# mount-discovery logic can be exercised against a scratch container during
# testing without touching prod; never override this in production use.
CADDY_HOST_SOURCE="${CADDY_HOST_SOURCE:-/home/portal/portal/Caddyfile}"

# sha256 of the live file as captured 2026-07-31 for this task (see
# docs/2026-07-31-element-deploy-audit-checklist.md's drift note — this is
# the exact byte content the anchors below were written against).
EXPECTED_SHA256="ac38d47432e275cefef2b603b96d6e73f3a16db6c4c82c83b640584ae318dfd8"

log()  { printf '%s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*" >&2; }
pass() { printf 'PASS  %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 0. Idempotency check — if all three markers are already present, no-op.
# ---------------------------------------------------------------------------
if [ ! -f "$CADDY_FILE" ]; then
    fail "live file not found: $CADDY_FILE"
    exit 1
fi

already_applied() {
    grep -qF 'header ?Strict-Transport-Security "max-age=31536000"' "$CADDY_FILE" \
        && grep -qF 'handle /.well-known/matrix/support' "$CADDY_FILE" \
        && grep -qF 'header_down -Server' "$CADDY_FILE"
}

if already_applied; then
    log "Stage-B2 markers already present in $CADDY_FILE — idempotent no-op, skipping patch."
    SKIP_PATCH=1
else
    SKIP_PATCH=0
fi

# ---------------------------------------------------------------------------
# 1. Backup + 2. sha256 gate + patch (skipped if already applied)
# ---------------------------------------------------------------------------
if [ "$SKIP_PATCH" -eq 0 ]; then
    ACTUAL_SHA256="$(sha256sum "$CADDY_FILE" | awk '{print $1}')"
    if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
        fail "live file sha256 mismatch — refusing to patch blind."
        fail "  expected: $EXPECTED_SHA256"
        fail "  actual:   $ACTUAL_SHA256"
        fail "The live file changed since this script's anchors were written against it."
        fail "Re-diff $CADDY_FILE against the checklist doc's baseline, update the anchors"
        fail "and EXPECTED_SHA256 above, and re-run. Do not bypass this check blindly."
        exit 1
    fi

    BACKUP="${CADDY_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    cp "$CADDY_FILE" "$BACKUP"
    log "Backed up $CADDY_FILE -> $BACKUP"

    NEW_FILE="$(mktemp)"
    trap 'rm -f "$NEW_FILE"' EXIT

    # Anchor-based exact-string patch. Each OLD string must appear exactly
    # once in the live file (verified by the python script itself, which
    # aborts loudly otherwise instead of silently patching zero or N times).
    python3 - "$CADDY_FILE" "$NEW_FILE" <<'PYEOF'
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path, "r", encoding="utf-8") as f:
    content = f.read()

def apply(content, old, new, label):
    n = content.count(old)
    if n != 1:
        sys.stderr.write(f"FAIL  anchor '{label}' matched {n} times (expected exactly 1) — aborting, no changes written.\n")
        sys.exit(1)
    return content.replace(old, new, 1)

# --- 1a. HSTS on matrix.inblock.io ---
content = apply(
    content,
    'matrix.inblock.io {\n    encode zstd gzip\n\n    handle /.well-known/matrix/server {',
    'matrix.inblock.io {\n    encode zstd gzip\n\n'
    '    # Stage-B2 hardening (2026-07-31): HSTS. See\n'
    '    # docs/2026-07-31-element-deploy-audit-checklist.md, "Chosen fix\n'
    '    # locations" section. No snippet infrastructure exists in this live\n'
    '    # file (unlike the repo copy / Caddyfile.dev-aquafire), so the\n'
    '    # directive is inlined here rather than introducing one.\n'
    '    header ?Strict-Transport-Security "max-age=31536000"\n\n'
    '    handle /.well-known/matrix/server {',
    "HSTS on matrix.inblock.io",
)

# --- 1b. MSC1929 support well-known on matrix.inblock.io ---
content = apply(
    content,
    '    handle /.well-known/matrix/client {\n'
    '        header Access-Control-Allow-Origin *\n'
    '        respond `{"m.homeserver": {"base_url": "https://matrix.inblock.io"}, '
    '"m.authentication": {"issuer": "https://siwx-oidc.inblock.io/"}, '
    '"m.authentication.account": "https://siwx-oidc.inblock.io/account", '
    '"org.matrix.msc4143.rtc_foci": [{"type": "livekit", '
    '"livekit_service_url": "https://matrix.inblock.io/livekit/jwt"}]}`\n'
    '    }\n\n'
    '    handle /_matrix/client/v3/login {',
    '    handle /.well-known/matrix/client {\n'
    '        header Access-Control-Allow-Origin *\n'
    '        respond `{"m.homeserver": {"base_url": "https://matrix.inblock.io"}, '
    '"m.authentication": {"issuer": "https://siwx-oidc.inblock.io/"}, '
    '"m.authentication.account": "https://siwx-oidc.inblock.io/account", '
    '"org.matrix.msc4143.rtc_foci": [{"type": "livekit", '
    '"livekit_service_url": "https://matrix.inblock.io/livekit/jwt"}]}`\n'
    '    }\n'
    '    # Stage-B2 hardening (2026-07-31): MSC1929 (ratified) support-contact\n'
    '    # discovery. Checklist S6, Section 4 — 404 confirmed live 2026-07-31.\n'
    '    # Same JSON as Caddyfile.dev-aquafire. Contact =\n'
    '    # tim.bansemer@inblock.io (operator org address; no support_page\n'
    '    # exists so that key is omitted).\n'
    '    handle /.well-known/matrix/support {\n'
    '        header Content-Type application/json\n'
    '        header Access-Control-Allow-Origin *\n'
    '        respond `{"contacts":[{"email_address":"tim.bansemer@inblock.io",'
    '"role":"m.role.admin"},{"email_address":"tim.bansemer@inblock.io",'
    '"role":"m.role.security"}]}`\n'
    '    }\n\n'
    '    handle /_matrix/client/v3/login {',
    "MSC1929 support well-known",
)

# --- 1c. header_down -Server on the MSC4108 handles (matrix_synapse:8080) ---
content = apply(
    content,
    '    # MSC4108: QR code login rendezvous.\n'
    '    handle /_matrix/client/unstable/org.matrix.msc4108/* {\n'
    '        reverse_proxy matrix_synapse:8080\n'
    '    }\n'
    '    handle /_synapse/client/rendezvous/* {\n'
    '        reverse_proxy matrix_synapse:8080\n'
    '    }\n',
    '    # MSC4108: QR code login rendezvous.\n'
    '    # Stage-B2 hardening (2026-07-31): header_down -Server on these two\n'
    '    # Synapse-proxying handles + the catch-all below (checklist Section 5\n'
    '    # — confirmed live "Server: Synapse/1.154.0"). Scoped to\n'
    '    # matrix_synapse:8080 only; the siwx-oidc handles elsewhere in this\n'
    '    # block are untouched (out of scope, and their CORS header_down\n'
    '    # lines are load-bearing — do not add -Server there).\n'
    '    handle /_matrix/client/unstable/org.matrix.msc4108/* {\n'
    '        reverse_proxy matrix_synapse:8080 {\n'
    '            header_down -Server\n'
    '        }\n'
    '    }\n'
    '    handle /_synapse/client/rendezvous/* {\n'
    '        reverse_proxy matrix_synapse:8080 {\n'
    '            header_down -Server\n'
    '        }\n'
    '    }\n',
    "header_down -Server on MSC4108 handles",
)

# --- 1d. header_down -Server on the catch-all handle ---
content = apply(
    content,
    '    handle /_matrix/client/v3/delete_devices {\n'
    '        reverse_proxy siwx-oidc:8081 {\n'
    '            header_down -Access-Control-Allow-Origin\n'
    '            header_down -Access-Control-Allow-Methods\n'
    '            header_down -Access-Control-Allow-Headers\n'
    '            header_down -Vary\n'
    '        }\n'
    '    }\n'
    '    handle {\n'
    '        reverse_proxy matrix_synapse:8080\n'
    '    }\n'
    '}\n',
    '    handle /_matrix/client/v3/delete_devices {\n'
    '        reverse_proxy siwx-oidc:8081 {\n'
    '            header_down -Access-Control-Allow-Origin\n'
    '            header_down -Access-Control-Allow-Methods\n'
    '            header_down -Access-Control-Allow-Headers\n'
    '            header_down -Vary\n'
    '        }\n'
    '    }\n'
    '    handle {\n'
    '        reverse_proxy matrix_synapse:8080 {\n'
    '            header_down -Server\n'
    '        }\n'
    '    }\n'
    '}\n',
    "header_down -Server on catch-all handle",
)

# --- 1e. HSTS on element.inblock.io ---
content = apply(
    content,
    'element.inblock.io {\n'
    '    encode zstd gzip\n'
    '    reverse_proxy element-web:8080\n'
    '}\n',
    'element.inblock.io {\n'
    '    encode zstd gzip\n'
    '    # Stage-B2 hardening (2026-07-31): HSTS (checklist Section 1, S8/S9 —\n'
    '    # FAIL confirmed live before this change).\n'
    '    header ?Strict-Transport-Security "max-age=31536000"\n'
    '    reverse_proxy element-web:8080\n'
    '}\n',
    "HSTS on element.inblock.io",
)

with open(dst_path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF

    log ""
    log "=== Diff: $CADDY_FILE (current) -> patched ==="
    diff -u "$CADDY_FILE" "$NEW_FILE" || true
    log "=== end diff ==="
    log ""

    # Truncating in-place write, NEVER mv/rename: $CADDY_FILE is a
    # single-file bind mount into $CADDY_CONTAINER, and replacing the inode
    # (mv, sed -i) silently detaches the mount — the host file changes but
    # the container keeps serving (and validating!) the old inode, turning
    # the validate/reload gates below into false PASSes on a config that
    # never applied. See skills/deploy.md ("Never edit that file with
    # sed -i"); the restore path below (cp) is inode-safe for the same
    # reason.
    cat "$NEW_FILE" > "$CADDY_FILE"
    rm -f "$NEW_FILE"
    trap - EXIT
    log "Patched $CADDY_FILE in place (inode-preserving write). Backup remains at $BACKUP."
fi

# ---------------------------------------------------------------------------
# 3. Validate before reload
# ---------------------------------------------------------------------------
# Discover the in-container config path from the actual bind mount rather
# than assuming /etc/caddy/Caddyfile — this box's mount path was not
# independently confirmed for this task (no prod SSH access; see the
# checklist doc's open questions). Falls back to /etc/caddy/Caddyfile (the
# documented convention, and what Caddyfile.dev-aquafire's box uses) with a
# loud warning if discovery fails, rather than guessing silently.
CONTAINER_CONFIG_PATH="$(
    docker inspect "$CADDY_CONTAINER" \
        --format '{{range .Mounts}}{{if eq .Source "'"$CADDY_HOST_SOURCE"'"}}{{.Destination}}{{end}}{{end}}' \
        2>/dev/null || true
)"
if [ -z "$CONTAINER_CONFIG_PATH" ]; then
    log "WARNING: could not discover the in-container mount path for $CADDY_HOST_SOURCE"
    log "  via 'docker inspect $CADDY_CONTAINER'. Falling back to the documented"
    log "  convention /etc/caddy/Caddyfile. VERIFY this is correct before trusting"
    log "  the validate/reload result below."
    CONTAINER_CONFIG_PATH="/etc/caddy/Caddyfile"
fi
log "Using in-container config path: $CONTAINER_CONFIG_PATH"

restore_and_abort() {
    if [ -n "${BACKUP:-}" ] && [ -f "$BACKUP" ]; then
        cp "$BACKUP" "$CADDY_FILE"
        fail "Restored $CADDY_FILE from $BACKUP."
    fi
    exit 1
}

if [ "$SKIP_PATCH" -eq 0 ]; then
    if ! docker exec "$CADDY_CONTAINER" caddy validate --config "$CONTAINER_CONFIG_PATH" 2>&1; then
        fail "caddy validate FAILED — restoring backup, not reloading."
        restore_and_abort
    fi
    pass "caddy validate"

    # -----------------------------------------------------------------------
    # 4. Reload (zero-downtime; admin API stays localhost-only in the container)
    # -----------------------------------------------------------------------
    if ! docker exec "$CADDY_CONTAINER" caddy reload --config "$CONTAINER_CONFIG_PATH" 2>&1; then
        fail "caddy reload FAILED — restoring backup file (does NOT undo a partial"
        fail "reload if caddy already read the bad config; check 'docker logs $CADDY_CONTAINER')."
        restore_and_abort
    fi
    pass "caddy reload"
else
    log "Skipping validate/reload (idempotent no-op, live file untouched this run)."
fi

# ---------------------------------------------------------------------------
# 5. Post-check: curl the three changed behaviors. Never auto-restores.
# ---------------------------------------------------------------------------
POST_FAIL=0

check_hsts() {
    # Caveat: Caddy's deferred `?` response ops are bypassed on the
    # reverse_proxy ERROR path, so a 502 during an unrelated upstream
    # (Synapse) outage carries no HSTS and this check FAILs spuriously.
    # Read a FAIL here alongside upstream health before treating it as a
    # config regression.
    local url="$1" val
    val="$(curl -sI --max-time 10 "$url" 2>/dev/null | grep -i '^strict-transport-security:' || true)"
    if printf '%s' "$val" | grep -qi 'max-age=31536000'; then
        pass "HSTS @ $url — $val"
    else
        fail "HSTS @ $url — header absent or wrong: '$val'"
        POST_FAIL=1
    fi
}

check_support() {
    local url="https://matrix.inblock.io/.well-known/matrix/support"
    local code body
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null)"
    body="$(curl -s --max-time 10 "$url" 2>/dev/null)"
    if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"contacts"'; then
        pass "/.well-known/matrix/support — HTTP $code, contacts present"
    else
        fail "/.well-known/matrix/support — HTTP $code, body='$(printf '%s' "$body" | head -c 120)'"
        POST_FAIL=1
    fi
}

check_no_server_banner() {
    local url="https://matrix.inblock.io/"
    local val
    val="$(curl -sI --max-time 10 "$url" 2>/dev/null | grep -i '^server:' || true)"
    if [ -z "$val" ]; then
        pass "Server banner @ $url — absent"
    elif printf '%s' "$val" | grep -qE '[0-9]+\.[0-9]+'; then
        fail "Server banner @ $url — still discloses a version: '$val'"
        POST_FAIL=1
    else
        pass "Server banner @ $url — bare, no version: '$val'"
    fi
}

log ""
log "=== Post-deploy checks ==="
check_hsts "https://element.inblock.io/"
check_hsts "https://matrix.inblock.io/"
check_support
check_no_server_banner
log "=== end post-deploy checks ==="

if [ "$POST_FAIL" -ne 0 ]; then
    fail ""
    fail "One or more post-deploy checks FAILed. Headers are non-fatal to the"
    fail "stack, so this script does NOT auto-restore. To roll back manually:"
    if [ -n "${BACKUP:-}" ]; then
        fail "  cp $BACKUP $CADDY_FILE && docker exec $CADDY_CONTAINER caddy reload --config $CONTAINER_CONFIG_PATH"
    else
        fail "  (no backup was taken this run — patch was skipped as already-applied;"
        fail "   find the most recent ${CADDY_FILE}.bak.* if a rollback is actually needed)"
    fi
    exit 1
fi

log ""
log "All checks PASS."
exit 0
