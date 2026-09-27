#!/usr/bin/env bash
# Prove the Element Web resolve-did-search patch carries siwx-oidc's golden
# DID -> localpart vectors byte for byte.
#
# The chain this closes:
#   siwx-oidc src/mxid.rs  ==  tests/fixtures/localpart-vectors.json   (siwx-oidc: tests/localpart_vectors.rs)
#   that fixture           ==  the block embedded in the patch's test   (THIS script)
#   the embedded block     ==  what utils/didLocalpart.ts computes       (the patch's vitest suite)
# so the hand-copied formula in Element cannot drift from the provider without
# one of the three failing.
#
# Usage:
#   scripts/check-did-localpart-vectors.sh [FIXTURE]
# FIXTURE defaults to the file at siwx-oidc's origin/main, fetched with `gh api`
# (set SIWX_OIDC_REF to check another ref), or pass a local path.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
patch="$here/patches/element-web/resolve-did-search.patch"
begin='// BEGIN siwx-oidc tests/fixtures/localpart-vectors.json'
end='// END siwx-oidc tests/fixtures/localpart-vectors.json'

if [[ $# -ge 1 ]]; then
  fixture="$(cat "$1")"
else
  ref="${SIWX_OIDC_REF:-main}"
  fixture="$(gh api -H 'Accept: application/vnd.github.raw' \
    "repos/inblockio/siwx-oidc/contents/tests/fixtures/localpart-vectors.json?ref=$ref")"
fi

# The embedded block: added lines of the patch between the markers, '+' stripped,
# then the text between the template literal's backticks.
embedded="$(awk -v b="+$begin" -v e="+$end" '
  $0 == b { on = 1; next }
  $0 == e { on = 0 }
  on { sub(/^\+/, ""); print }
' "$patch" | python3 -c '
import sys
s = sys.stdin.read()
start = s.index("`") + 1
stop = s.index("`", start)
sys.stdout.write(s[start:stop])
')"

if [[ -z "$embedded" ]]; then
  echo "FAIL: no embedded vector block found in $patch" >&2
  exit 1
fi

if diff <(printf '%s\n' "$fixture") <(printf '%s\n' "$embedded") >/dev/null; then
  echo "OK: resolve-did-search.patch carries siwx-oidc's localpart vectors verbatim"
else
  echo "FAIL: the patch's embedded vectors differ from siwx-oidc's fixture:" >&2
  diff <(printf '%s\n' "$fixture") <(printf '%s\n' "$embedded") >&2 || true
  exit 1
fi
