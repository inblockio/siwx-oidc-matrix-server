#!/usr/bin/env bash
#
# element-patch-markers.sh — are our vendored Element Web patches in the build a
# deployment is serving?
#
# Reads patches/element-web/markers.tsv (entry<TAB>served-path<TAB>fixed-string; see
# its header) and, with read-only GETs, checks every marker against the Element Web
# at <element_url>. One line per registry entry, in the format promote tooling parses:
#
#   CHECK id=ew-marker.<entry> result=pass|fail :: <detail>
#
# An entry passes when ALL of its markers are present. Each marker is a string that is
# present in a build carrying the entry and absent from stock upstream Element Web at
# the same tag (proof: "Marker discrimination record" in patches/element-web/README.md),
# so a pass means "this entry's code reached the served app", not "the entry works".
#
# --absent N[,N..] turns the listed entries into "must be ABSENT": the differential
# on a build that is expected to lack them (for example a deployment that predates
# entries 9-11). An entry in that list passes when NONE of its markers is present.
#
# Usage:
#   element-patch-markers.sh [--absent N[,N..]] [--markers FILE] <element_url>
#
# Example:
#   element-patch-markers.sh https://element.example.org
#   element-patch-markers.sh --absent 9,10,11 https://element.example.org
#
# Fetches: index.html (always; it names the bundle directory), i18n/languages.json
# (only when a marker is in an i18n file; it names the hashed file) and each file a
# marker names, once. Dependencies: bash (4+), curl, grep, mktemp.
#
# Exit code: 0 every entry passed, 1 at least one failed, 2 usage error, unreadable
# markers file, or the deployment could not be read (connection error, timeout,
# HTTP 5xx or 429 on any fetch, or HTTP error on index.html).
set -uo pipefail
export LC_ALL=C

CONNECT_TIMEOUT=10
MAX_TIME=90
TAB=$'\t'

usage() {
  cat >&2 <<'EOF'
Usage: element-patch-markers.sh [--absent N[,N..]] [--markers FILE] <element_url>
  --absent N[,N..]  entries that must be ABSENT from the served build
  --markers FILE    markers file (default: patches/element-web/markers.tsv next to this script)
  <element_url>     origin of the Element Web to check, e.g. https://element.example.org
Prints one `CHECK id=ew-marker.<entry> result=pass|fail :: <detail>` line per entry.
Exit: 0 all pass, 1 any fail, 2 usage or network error.
EOF
  exit 2
}
die() { printf 'element-patch-markers: %s\n' "$*" >&2; exit 2; }

MARKERS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/patches/element-web/markers.tsv"
ABSENT_ARG=""
URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --absent) [ $# -ge 2 ] || usage; ABSENT_ARG="$2"; shift 2 ;;
    --markers) [ $# -ge 2 ] || usage; MARKERS="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) printf 'unknown option: %s\n' "$1" >&2; usage ;;
    *) [ -z "$URL" ] || usage; URL="$1"; shift ;;
  esac
done
[ -n "$URL" ] || usage
URL="${URL%/}"
[[ $URL =~ ^https?://[^/?#[:space:]]+(/[^?#[:space:]]*)?$ ]] || die "element_url must be http(s)://host[/prefix] without query or fragment: $URL"
URL="${URL%/}"

# ---- markers file ----------------------------------------------------------
[ -r "$MARKERS" ] || die "cannot read markers file: $MARKERS"
M_ENTRY=(); M_PATH=(); M_STR=()
lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  [ -n "$line" ] || continue
  [ "${line:0:1}" = "#" ] && continue
  tabs="${line//[^$TAB]/}"
  [ "${#tabs}" -eq 2 ] || die "$MARKERS:$lineno: want entry<TAB>path<TAB>string (exactly two tabs)"
  e="${line%%"$TAB"*}"; rest="${line#*"$TAB"}"; p="${rest%%"$TAB"*}"; s="${rest#*"$TAB"}"
  [[ $e =~ ^[0-9]+$ ]] || die "$MARKERS:$lineno: entry is not a number: $e"
  [[ $p =~ ^(index\.html|sw\.js|sw-boot\.js|bundles/\*/[A-Za-z0-9_.-]+|i18n/[A-Za-z0-9_-]+\.json)$ ]] \
    || die "$MARKERS:$lineno: unsupported served path: $p"
  [ -n "$s" ] || die "$MARKERS:$lineno: empty marker string"
  [[ $s != *$'\r'* ]] || die "$MARKERS:$lineno: carriage return in marker string (CRLF file?)"
  M_ENTRY+=("$((10#$e))"); M_PATH+=("$p"); M_STR+=("$s")
done <"$MARKERS"
[ "${#M_ENTRY[@]}" -gt 0 ] || die "no markers in $MARKERS"
ENTRIES="$(printf '%s\n' "${M_ENTRY[@]}" | sort -nu)"

declare -A MUST_ABSENT=()
if [ -n "$ABSENT_ARG" ]; then
  IFS=',' read -r -a _abs <<<"$ABSENT_ARG"
  for a in "${_abs[@]}"; do
    [[ $a =~ ^[0-9]+$ ]] || die "--absent wants numbers separated by commas, got: $a"
    grep -qx "$((10#$a))" <<<"$ENTRIES" || die "--absent names entry $a, which has no row in $MARKERS"
    MUST_ABSENT[$((10#$a))]=1
  done
fi

# ---- fetching --------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/element-patch-markers.XXXXXX")" || die "mktemp failed"
trap 'rm -rf "$WORK"' EXIT

declare -A FSTATE=()   # served path -> ok | "HTTP <code>"
declare -A FLOCAL=()   # served path -> local file
nfetch=0

# fetch_file <served-path>: one GET per path. Transport errors, 5xx and 429 end the run
# with exit 2; any other non-200 is recorded and fails the markers that need the file.
fetch_file() {
  local rel="$1" out code rc
  [ -z "${FSTATE[$rel]+x}" ] || return 0
  nfetch=$((nfetch + 1))
  out="$WORK/f$nfetch"
  code="$(curl -sS -L --compressed --max-redirs 3 --proto '=http,https' --proto-redir '=http,https' \
            --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" -A 'element-patch-markers/1' \
            -o "$out" -w '%{http_code}' -- "$URL/$rel" 2>"$WORK/curl.err")"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    die "GET /$rel failed (curl exit $rc): $(tr '\n' ' ' <"$WORK/curl.err")"
  fi
  case "$code" in
    200) FSTATE[$rel]=ok; FLOCAL[$rel]="$out" ;;
    5??|429) die "GET /$rel answered HTTP $code" ;;
    *) FSTATE[$rel]="HTTP $code" ;;
  esac
}

fetch_file index.html
[ "${FSTATE[index.html]}" = ok ] || die "GET /index.html answered ${FSTATE[index.html]}: is $URL an Element Web?"

BUNDLE_HASH=""
need_bundle=0; need_i18n=0
for p in "${M_PATH[@]}"; do
  case "$p" in
    bundles/\*/*) need_bundle=1 ;;
    i18n/*) need_i18n=1 ;;
  esac
done
if [ "$need_bundle" -eq 1 ]; then
  BUNDLE_HASH="$(grep -aoE 'bundles/[0-9a-f]{8,40}/' "${FLOCAL[index.html]}" | head -n 1 | sed -E 's#^bundles/##; s#/$##')"
fi
if [ "$need_i18n" -eq 1 ]; then
  fetch_file i18n/languages.json
fi

# resolve <marker-path>: sets RESOLVED to the served path and returns 0, or sets RESOLVE_ERR
# and returns 1. Not run in a subshell (the variables would be lost).
RESOLVED=""; RESOLVE_ERR=""
resolve() {
  local p="$1" name f
  RESOLVED=""; RESOLVE_ERR=""
  case "$p" in
    bundles/\*/*)
      if [ -z "$BUNDLE_HASH" ]; then RESOLVE_ERR="index.html names no bundles/<hash>/ directory"; return 1; fi
      RESOLVED="bundles/$BUNDLE_HASH/${p#bundles/*/}" ;;
    i18n/*)
      if [ "${FSTATE[i18n/languages.json]}" != ok ]; then RESOLVE_ERR="i18n/languages.json: ${FSTATE[i18n/languages.json]}"; return 1; fi
      name="${p#i18n/}"; name="${name%.json}"
      f="$(grep -aoE "\"${name}\.[0-9a-f]+\.json\"" "${FLOCAL[i18n/languages.json]}" | head -n 1 | tr -d '"')"
      if [ -z "$f" ]; then RESOLVE_ERR="i18n/languages.json lists no ${name}.<hash>.json"; return 1; fi
      RESOLVED="i18n/$f" ;;
    *) RESOLVED="$p" ;;
  esac
}

# Resolve every row once and fetch each distinct file once.
declare -a R_SERVED=() R_ERR=()
for i in "${!M_ENTRY[@]}"; do
  if resolve "${M_PATH[i]}"; then
    R_SERVED[i]="$RESOLVED"; R_ERR[i]=""
    fetch_file "$RESOLVED"
  else
    R_SERVED[i]=""; R_ERR[i]="$RESOLVE_ERR"
  fi
done

# ---- evaluation ------------------------------------------------------------
FAILS=0
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  want_absent=0; [ -n "${MUST_ABSENT[$entry]+x}" ] && want_absent=1
  total=0; present=0; bad=""; seen=""
  for i in "${!M_ENTRY[@]}"; do
    [ "${M_ENTRY[i]}" = "$entry" ] || continue
    total=$((total + 1))
    base="${R_SERVED[i]##*/}"; [ -n "$base" ] || base="${M_PATH[i]}"
    if [ -n "${R_ERR[i]}" ]; then
      bad+="${bad:+; }${M_PATH[i]}: ${R_ERR[i]}"
      continue
    fi
    if [ "${FSTATE[${R_SERVED[i]}]}" != ok ]; then
      bad+="${bad:+; }/${R_SERVED[i]}: ${FSTATE[${R_SERVED[i]}]}"
      continue
    fi
    n="$(grep -aoF -- "${M_STR[i]}" "${FLOCAL[${R_SERVED[i]}]}" | wc -l | tr -d ' ')"
    if [ "$n" -gt 0 ]; then
      present=$((present + 1))
      seen+="${seen:+; }$base '${M_STR[i]}' x$n"
      [ "$want_absent" -eq 1 ] && bad+="${bad:+; }$base has '${M_STR[i]}' x$n"
    else
      [ "$want_absent" -eq 1 ] || bad+="${bad:+; }$base lacks '${M_STR[i]}'"
    fi
  done
  if [ "$want_absent" -eq 1 ]; then
    if [ -z "$bad" ]; then
      res=pass; detail="absent as required (--absent): 0/$total markers present"
    else
      res=fail; detail="must be absent (--absent) but: $bad"
    fi
  else
    if [ -z "$bad" ]; then
      res=pass; detail="$present/$total markers present: $seen"
    else
      res=fail; detail="$present/$total markers present; $bad"
    fi
  fi
  [ "$res" = pass ] || FAILS=$((FAILS + 1))
  printf 'CHECK id=ew-marker.%s result=%s :: %s\n' "$entry" "$res" "$detail"
done <<<"$ENTRIES"

[ "$FAILS" -eq 0 ]
