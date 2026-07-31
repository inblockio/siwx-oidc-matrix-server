#!/usr/bin/env bash
#
# element-deploy-audit.sh — curl-only deployment-hardening audit for the
# Element Web / Synapse stack fronted by Caddy.
#
# Checks security headers, cache-correctness (per the 2026-07-31 stale-cache/
# wedged-SW incident), MSC1929 support well-known, and version-disclosure
# banners. See docs/2026-07-31-element-deploy-audit-checklist.md for the
# official-source citation behind every check below.
#
# Usage:
#   element-deploy-audit.sh <element-origin> <matrix-origin> [--server-name <name>]
#
# Example:
#   element-deploy-audit.sh https://dev.element.inblock.io https://dev.matrix.inblock.io
#   element-deploy-audit.sh https://element.inblock.io https://matrix.inblock.io
#
# Dependencies: curl, grep, awk (POSIX-ish). jq is used opportunistically for
# the MSC1929 JSON check if present on PATH; a grep-level fallback covers its
# absence.
#
# Exit code: non-zero if any check FAILs. WARNs never affect the exit code.

set -uo pipefail

TIMEOUT=10
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

usage() {
    echo "Usage: $0 <element-origin> <matrix-origin> [--server-name <name>]" >&2
    echo "Example: $0 https://dev.element.inblock.io https://dev.matrix.inblock.io" >&2
    exit 2
}

[ $# -lt 2 ] && usage

ELEMENT_ORIGIN="${1%/}"
MATRIX_ORIGIN="${2%/}"
shift 2
SERVER_NAME=""

while [ $# -gt 0 ]; do
    case "$1" in
        --server-name)
            [ $# -lt 2 ] && usage
            SERVER_NAME="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage
            ;;
    esac
done

if [ -z "$SERVER_NAME" ]; then
    SERVER_NAME_ORIGIN="$MATRIX_ORIGIN"
else
    SERVER_NAME_ORIGIN="https://${SERVER_NAME}"
fi

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  PASS  %-55s %s\n' "$1" "$2"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  FAIL  %-55s %s\n' "$1" "$2"; }
warn() { WARN_COUNT=$((WARN_COUNT + 1)); printf '  WARN  %-55s %s\n' "$1" "$2"; }
skip() { printf '  SKIP  %-55s %s\n' "$1" "$2"; }

section() { printf '\n== %s ==\n' "$1"; }

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

# Populates globals HEADERS and HTTP_CODE for $1 (a URL).
HEADERS=""
HTTP_CODE=""
fetch_headers() {
    local url="$1"
    HEADERS=$(curl -s -D - -o /dev/null --max-time "$TIMEOUT" "$url" 2>/dev/null)
    HTTP_CODE=$(printf '%s\n' "$HEADERS" | head -1 | awk '{print $2}')
}

# Extracts a header's value (case-insensitive name match) from a headers blob.
# $1 = headers blob, $2 = header name.
header_value() {
    printf '%s\n' "$1" | grep -i "^$2:" | head -1 | sed -E 's/^[^:]+:[[:space:]]*//' | tr -d '\r'
}

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

# $1=label $2=url $3=header name $4=grep -E pattern the value must match (case-insensitive)
check_header_matches() {
    local label="$1" url="$2" header="$3" want_regex="$4"
    fetch_headers "$url"
    if [ -z "$HTTP_CODE" ]; then
        fail "$label" "unreachable: $url"
        return
    fi
    local val
    val=$(header_value "$HEADERS" "$header")
    if [ -z "$val" ]; then
        fail "$label" "$header header absent (HTTP $HTTP_CODE @ $url)"
        return
    fi
    if printf '%s' "$val" | grep -qiE "$want_regex"; then
        pass "$label" "$header: $val"
    else
        fail "$label" "$header: '$val' (want /$want_regex/)"
    fi
}

# $1=label $2=url $3=minimum max-age (seconds)
check_hsts() {
    local label="$1" url="$2" min_maxage="$3"
    fetch_headers "$url"
    if [ -z "$HTTP_CODE" ]; then
        fail "$label" "unreachable: $url"
        return
    fi
    local val
    val=$(header_value "$HEADERS" "Strict-Transport-Security")
    if [ -z "$val" ]; then
        fail "$label" "Strict-Transport-Security header absent (HTTP $HTTP_CODE @ $url)"
        return
    fi
    local ma
    ma=$(printf '%s' "$val" | grep -oiE 'max-age=[0-9]+' | head -1 | awk -F= '{print $2}')
    if [ -z "$ma" ]; then
        fail "$label" "Strict-Transport-Security present but no max-age parsed: '$val'"
        return
    fi
    if [ "$ma" -ge "$min_maxage" ] 2>/dev/null; then
        pass "$label" "Strict-Transport-Security: $val"
    else
        fail "$label" "Strict-Transport-Security: $val (max-age=$ma < required $min_maxage)"
    fi
}

# $1=label $2=url — requires Cache-Control to contain both no-cache and must-revalidate.
check_cache_no_store() {
    local label="$1" url="$2"
    fetch_headers "$url"
    if [ -z "$HTTP_CODE" ]; then
        fail "$label" "unreachable: $url"
        return
    fi
    local cc
    cc=$(header_value "$HEADERS" "Cache-Control")
    if printf '%s' "$cc" | grep -qi 'no-cache' && printf '%s' "$cc" | grep -qi 'must-revalidate'; then
        pass "$label" "Cache-Control: $cc"
    else
        fail "$label" "Cache-Control: '$cc' (want no-cache + must-revalidate, HTTP $HTTP_CODE @ $url)"
    fi
}

# $1=label $2=url $3=expected max-age — requires bounded caching + must-revalidate.
check_cache_bounded() {
    local label="$1" url="$2" maxage="$3"
    fetch_headers "$url"
    if [ -z "$HTTP_CODE" ]; then
        fail "$label" "unreachable: $url"
        return
    fi
    local cc
    cc=$(header_value "$HEADERS" "Cache-Control")
    if printf '%s' "$cc" | grep -qi "max-age=$maxage" && printf '%s' "$cc" | grep -qi 'must-revalidate'; then
        pass "$label" "Cache-Control: $cc"
    else
        fail "$label" "Cache-Control: '$cc' (want max-age=$maxage + must-revalidate, HTTP $HTTP_CODE @ $url)"
    fi
}

# Scrapes index.html for a hashed bundle path (bundles/<hash>/bundle.js or similar).
discover_bundle_path() {
    curl -s --max-time "$TIMEOUT" "$ELEMENT_ORIGIN/index.html" 2>/dev/null \
        | grep -oE 'bundles/[A-Za-z0-9._/-]+\.js' | head -1
}

# $1=label $2=origin — sw.js must end with a '// build:' identity stamp.
check_swjs_stamp() {
    local label="$1" origin="$2"
    local tail
    tail=$(curl -s --max-time "$TIMEOUT" "$origin/sw.js" 2>/dev/null | tail -c 200)
    if [ -z "$tail" ]; then
        fail "$label: sw.js reachable" "empty/unreachable response from $origin/sw.js"
        return
    fi
    if printf '%s' "$tail" | grep -q '// build:'; then
        local stamp
        stamp=$(printf '%s' "$tail" | grep '// build:' | tail -1 | sed 's/^[[:space:]]*//')
        pass "$label: sw.js per-build stamp" "$stamp"
    else
        fail "$label: sw.js per-build stamp" "no '// build:' marker in last 200 bytes (Task A1/A3 not yet deployed here?)"
    fi
}

# $1=label $2=origin
check_version_endpoint() {
    local label="$1" origin="$2"
    local url="$origin/version"
    local code body
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$url" 2>/dev/null)
    body=$(curl -s --max-time "$TIMEOUT" "$url" 2>/dev/null)
    if [ "$code" = "200" ] && [ -n "$body" ]; then
        pass "$label: /version returns content" "HTTP $code, '$(printf '%s' "$body" | head -c 60)'"
    else
        fail "$label: /version returns content" "HTTP $code, body='$(printf '%s' "$body" | head -c 60)'"
    fi
}

# $1=label $2=origin — MSC1929 /.well-known/matrix/support.
check_wellknown_support() {
    local label="$1" origin="$2"
    local url="$origin/.well-known/matrix/support"
    local code body
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$url" 2>/dev/null)
    if [ "$code" != "200" ]; then
        fail "$label: /.well-known/matrix/support" "HTTP $code (expected 200) @ $url"
        return
    fi
    body=$(curl -s --max-time "$TIMEOUT" "$url" 2>/dev/null)
    if command -v jq >/dev/null 2>&1; then
        if printf '%s' "$body" | jq -e 'has("contacts") or has("support_page")' >/dev/null 2>&1; then
            pass "$label: /.well-known/matrix/support JSON (jq)" "contacts/support_page present"
        else
            fail "$label: /.well-known/matrix/support JSON (jq)" "no contacts/support_page key, or invalid JSON: $(printf '%s' "$body" | head -c 120)"
        fi
    else
        if printf '%s' "$body" | grep -q '{' \
            && printf '%s' "$body" | grep -qE '"contacts"|"support_page"'; then
            pass "$label: /.well-known/matrix/support JSON (grep-level)" "contains contacts/support_page key"
        else
            fail "$label: /.well-known/matrix/support JSON (grep-level)" "malformed or missing contacts/support_page: $(printf '%s' "$body" | head -c 120)"
        fi
    fi
}

# $1=label $2=url $3=header name — FAIL if the value discloses a version number.
check_banner() {
    local label="$1" url="$2" header="$3"
    fetch_headers "$url"
    if [ -z "$HTTP_CODE" ]; then
        fail "$label" "unreachable: $url"
        return
    fi
    local val
    val=$(header_value "$HEADERS" "$header")
    if [ -z "$val" ]; then
        pass "$label" "$header header absent"
        return
    fi
    if printf '%s' "$val" | grep -qE '[0-9]+\.[0-9]+'; then
        fail "$label" "$header: '$val' discloses a version number"
    else
        pass "$label" "$header: '$val' (bare product name, no version)"
    fi
}

# $1=origin — informational only, never affects exit code.
check_federation_version() {
    local origin="$1"
    local url="$origin/_matrix/federation/v1/version"
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$url" 2>/dev/null)
    warn "matrix: /_matrix/federation/v1/version (informational)" "HTTP $code @ $url"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

echo "======================================================================"
echo "Element/Matrix deployment-hardening audit"
echo "Element origin:      $ELEMENT_ORIGIN"
echo "Matrix origin:       $MATRIX_ORIGIN"
if [ -z "$SERVER_NAME" ]; then
    echo "Server-name origin:  $SERVER_NAME_ORIGIN (defaulted to matrix origin — pass --server-name to override)"
else
    echo "Server-name origin:  $SERVER_NAME_ORIGIN"
fi
echo "======================================================================"

section "Security headers — element origin"
check_header_matches "element: X-Frame-Options"       "$ELEMENT_ORIGIN/" "X-Frame-Options"        '^SAMEORIGIN$'
check_header_matches "element: CSP frame-ancestors"    "$ELEMENT_ORIGIN/" "Content-Security-Policy" "frame-ancestors[[:space:]]+'self'"
check_header_matches "element: X-Content-Type-Options" "$ELEMENT_ORIGIN/" "X-Content-Type-Options"  '^nosniff$'
check_hsts            "element: HSTS >= 15552000"      "$ELEMENT_ORIGIN/" 15552000

section "Core headers — matrix origin"
check_hsts "matrix: HSTS >= 15552000" "$MATRIX_ORIGIN/" 15552000

section "Cache-Control correctness — element origin (2026-07-31 incident set)"
check_cache_no_store "element: / no-cache"                       "$ELEMENT_ORIGIN/"
check_cache_no_store "element: /index.html no-cache"              "$ELEMENT_ORIGIN/index.html"
check_cache_no_store "element: /version no-cache"                 "$ELEMENT_ORIGIN/version"
check_cache_no_store "element: /config.json no-cache"             "$ELEMENT_ORIGIN/config.json"
check_cache_no_store "element: /i18n/languages.json no-cache"     "$ELEMENT_ORIGIN/i18n/languages.json"
check_cache_no_store "element: /sw-boot.js no-cache"               "$ELEMENT_ORIGIN/sw-boot.js"
check_cache_no_store "element: /usercontent/ no-cache"             "$ELEMENT_ORIGIN/usercontent/"

bundle_path=$(discover_bundle_path)
if [ -n "$bundle_path" ]; then
    check_cache_bounded "element: /$bundle_path bounded cache" "$ELEMENT_ORIGIN/$bundle_path" 14400
else
    warn "element: /bundles/ bounded cache" "could not discover a bundle path from index.html — skipped"
fi
check_cache_bounded "element: /sw.js bounded cache" "$ELEMENT_ORIGIN/sw.js" 14400

section "Per-build sw.js identity stamp"
check_swjs_stamp "element" "$ELEMENT_ORIGIN"

section "/version endpoint"
check_version_endpoint "element" "$ELEMENT_ORIGIN"

section "MSC1929 /.well-known/matrix/support"
check_wellknown_support "matrix origin" "$MATRIX_ORIGIN"
if [ "$SERVER_NAME_ORIGIN" = "$MATRIX_ORIGIN" ]; then
    skip "server-name origin /.well-known/matrix/support" "same host as matrix origin ($MATRIX_ORIGIN) — not re-checked"
else
    check_wellknown_support "server-name origin" "$SERVER_NAME_ORIGIN"
fi

section "Version-disclosure banners"
check_banner "element: Server header"      "$ELEMENT_ORIGIN/" "Server"
check_banner "element: X-Powered-By header" "$ELEMENT_ORIGIN/" "X-Powered-By"
check_banner "matrix: Server header"        "$MATRIX_ORIGIN/"  "Server"
check_banner "matrix: X-Powered-By header"  "$MATRIX_ORIGIN/"  "X-Powered-By"

section "Federation version (informational only)"
check_federation_version "$MATRIX_ORIGIN"

section "Client/server domain separation"
skip "domain separation (element vs matrix eTLD+1)" "SKIP (accepted deviation, recorded 2026-07-31)"

echo
echo "======================================================================"
echo "Summary: $PASS_COUNT PASS, $WARN_COUNT WARN, $FAIL_COUNT FAIL"
echo "======================================================================"

if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
fi
exit 0
