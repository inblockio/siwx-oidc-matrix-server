#!/usr/bin/env bash
# element-call-check.sh <container> [config.json]: prove a running Element Call
# container serves the pinned build with the harness config, or exit 1.
#
# Used by up.sh right after it starts siwx-e2eh-element-call (H14, aqua-agents
# docs/handover/2026-10-08-scribe-harness-h14-element-call-design.md section 2).
# The image is pulled by digest, so the digest already pins the bytes; this
# check pins what is SERVED, which a digest alone does not cover when an
# override (ELEMENT_CALL_IMAGE_REF) or a future base change slips in:
#   1. /app/assets/index-Hj2GaSQY.js (the entry chunk, which inlines the LiveKit
#      E2EE worker) hashes to the v0.24.0 release value, and so does its .gz
#      twin (nginx gzip_static serves the .gz to any gzip-capable browser);
#   2. index.html, fetched over HTTP from the container itself, loads that chunk;
#   3. /app/config.json is a READ-ONLY bind mount whose bytes equal the repo file.
# Read-only: it never writes into the container.
set -euo pipefail

C="${1:?usage: element-call-check.sh <container> [config.json]}"
CFG="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/config/element-call.e2e.json}"
WANT="${ELEMENT_CALL_ENTRY_SHA256:-3bc23d4e53922a38e8c3c4be364793808da34994d80f064c9729f0636396bea6}"
ASSET="${ELEMENT_CALL_ENTRY_ASSET:-assets/index-Hj2GaSQY.js}"

fail() { echo "[element-call-check] FAIL: $*" >&2; exit 1; }

got="$(podman exec "$C" sha256sum "/app/${ASSET}" 2>/dev/null | cut -d' ' -f1)" || true
[ "$got" = "$WANT" ] || fail "/app/${ASSET} sha256 '${got:-unreadable}' != pinned ${WANT}"
gz="$(podman exec "$C" sh -c "gunzip -c '/app/${ASSET}.gz' | sha256sum" 2>/dev/null | cut -d' ' -f1)" || true
[ "$gz" = "$WANT" ] || fail "/app/${ASSET}.gz decompresses to '${gz:-unreadable}' != pinned ${WANT}"

# nginx needs a moment after `podman run -d`; retry the HTTP fetch briefly.
idx=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  idx="$(podman exec "$C" wget -qO- http://127.0.0.1:8080/ 2>/dev/null)" && [ -n "$idx" ] && break
  sleep 0.5
done
case "$idx" in
  *"/${ASSET}"*) ;;
  *) fail "index.html served on :8080 does not load /${ASSET}" ;;
esac

ro="$(podman inspect "$C" --format '{{range .Mounts}}{{if eq .Destination "/app/config.json"}}{{.RW}}{{end}}{{end}}')"
[ "$ro" = "false" ] || fail "/app/config.json is not a read-only bind mount (RW='${ro}')"
want_cfg="$(sha256sum "$CFG" | cut -d' ' -f1)"
got_cfg="$(podman exec "$C" sha256sum /app/config.json 2>/dev/null | cut -d' ' -f1)" || true
[ "$got_cfg" = "$want_cfg" ] || fail "/app/config.json sha256 '${got_cfg:-unreadable}' != ${CFG} ${want_cfg}"

echo "[element-call-check] OK ${C}: /${ASSET} sha256 ${WANT} (plain and .gz), served by index.html; /app/config.json read-only = ${CFG##*/}"
