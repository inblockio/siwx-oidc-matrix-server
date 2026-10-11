#!/usr/bin/env bash
#
# lk-jwt-membership-accept.sh — acceptance tests for apply_lk_jwt_membership in
# entrypoints/matrix_server.sh (the MSC4502 flag and the lk-jwt application-service
# registration).
#
# WHY THIS EXISTS. The function writes a credential-bearing registration that can act
# as any local user (the users namespace is every local user), and a boot that gets it
# wrong either leaves Synapse unable to start (a bad write) or leaves an unreviewed
# namespace behind (a bad regex). Its value is in its refusal and idempotency paths,
# which a happy-path run never exercises. Audit finding F5 of PR #46: "no repo accept
# script for this function".
#
# HOW. The function (plus lk_jwt_refuse and synapse_runtime_ids, which it calls) is
# EXTRACTED from the working-tree entrypoint with sed and sourced in a subshell, so
# this tests the file you are editing and never boots the rest of the entrypoint. The
# only transformation: the literal `/data/` is rewritten to a per-case scratch
# directory, because the function hard-codes /data. Every case gets a fresh scratch
# directory and a fixture homeserver.yaml. It needs mikefarah yq v4 (the entrypoint's
# own yq); the image ships one, CI installs a pinned one.
#
# REGEX SEMANTICS. Synapse compiles each namespace regex with re.compile and tests it
# with `namespace.regex.match(test_string)` (synapse/appservice/__init__.py,
# ApplicationService._matches_regex, v1.162), i.e. re.match: anchored at the start
# only. The regex carries its own `$`, so these tests use re.compile(r).match(s) too.
#
# Usage:
#   scripts/lk-jwt-membership-accept.sh                # needs yq v4 and python3 on PATH
#   scripts/lk-jwt-membership-accept.sh --image IMG    # re-run inside IMG with podman/docker
#                                                      # (any image with yq v4 + python3,
#                                                      # e.g. the built Synapse image)
# Env:
#   SIWX_ACCEPT_SCRATCH   fixture base directory, on disk, never tmpfs
#                         (default ~/.cache/siwx-lk-jwt-membership-accept)
#
# Exit code: non-zero if any case FAILs.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="${REPO_ROOT}/entrypoints/matrix_server.sh"

if [ "${1:-}" = "--image" ]; then
  [ -n "${2:-}" ] || { echo "--image needs an image" >&2; exit 2; }
  RT="$(command -v podman || command -v docker)" || { echo "need podman or docker" >&2; exit 2; }
  exec "$RT" run --rm ${SIWX_ACCEPT_CONTAINER_NAME:+--name "$SIWX_ACCEPT_CONTAINER_NAME"} \
    -v "${REPO_ROOT}:/w:ro,Z" --entrypoint bash "$2" /w/scripts/lk-jwt-membership-accept.sh
fi
case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

REAL_YQ="$(command -v yq)" || { echo "need mikefarah yq v4 on PATH" >&2; exit 2; }
"$REAL_YQ" --version 2>&1 | grep -q 'mikefarah/yq.*version v4\.' \
  || { echo "need mikefarah yq v4, found: $("$REAL_YQ" --version 2>&1)" >&2; exit 2; }
command -v python3 >/dev/null || { echo "need python3" >&2; exit 2; }

BASE="${SIWX_ACCEPT_SCRATCH:-${XDG_CACHE_HOME:-$HOME/.cache}/siwx-lk-jwt-membership-accept}"
mkdir -p "$BASE"
WORK="$(mktemp -d -p "$BASE" run.XXXXXX)"
trap 'chmod -R u+rwx "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

# --- extract the function under test -----------------------------------------
FNS="$WORK/fns.sh"
for f in synapse_runtime_ids lk_jwt_refuse apply_lk_jwt_membership; do
  sed -n "/^${f}() {/,/^}/p" "$ENTRYPOINT"
done | sed 's#/data/#${ACCEPT_DATA}/#g' > "$FNS"
for f in synapse_runtime_ids lk_jwt_refuse apply_lk_jwt_membership; do
  grep -q "^${f}() {" "$FNS" || { echo "FAIL: could not extract ${f} from ${ENTRYPOINT}" >&2; exit 1; }
done
grep -q '\${ACCEPT_DATA}/homeserver.yaml' "$FNS" \
  || { echo "FAIL: extracted function does not reference homeserver.yaml" >&2; exit 1; }

# --- fake yq: delegates, except on a matching argument string ------------------
FAKEBIN="$WORK/fakebin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/yq" <<'FAKE'
#!/usr/bin/env bash
if [ -n "${FAKE_YQ_FAIL:-}" ] && [[ "$*" == *"$FAKE_YQ_FAIL"* ]]; then exit 1; fi
if [ -n "${FAKE_YQ_ECHO_FOR:-}" ] && [[ "$*" == *"$FAKE_YQ_ECHO_FOR"* ]]; then echo "${FAKE_YQ_ECHO:-}"; exit 0; fi
exec "$REAL_YQ" "$@"
FAKE
chmod +x "$FAKEBIN/yq"
export REAL_YQ

TOK_AS="$(printf 'a%.0s' $(seq 1 40))"
TOK_HS="$(printf 'b%.0s' $(seq 1 40))"

PASS=0; FAILN=0
ok()   { echo "PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $1${2:+ -- $2}"; FAILN=$((FAILN+1)); }
check() { # check "name" cmd...   (cmd runs in the current shell; true = pass)
  local name="$1"; shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}

# new_case NAME [SERVER_NAME_YAML_LINE|-] ; sets D, HS, REG and writes a fixture.
new_case() {
  CASE="$1"; D="$WORK/$1"; mkdir -p "$D"; HS="$D/homeserver.yaml"; REG="$D/lk-jwt-as.yaml"
  {
    [ "${2:-}" = "-" ] || echo "${2-server_name: \"example.org\"}"
    echo 'public_baseurl: https://example.org/'
    echo 'app_service_config_files:'
    echo "  - $D/other-as.yaml"
  } > "$HS"
  OUT=""; RC=""
}

# run_fn AS_TOKEN HS_TOKEN [VAR=VAL ...] : runs the function in a subshell; sets RC, OUT (stderr+stdout)
run_fn() {
  local a="$1" h="$2"; shift 2
  OUT="$(env -u UID -u GID ACCEPT_DATA="$D" LK_JWT_AS_TOKEN="$a" LK_JWT_HS_TOKEN="$h" "$@" \
    bash -c 'source "$1"; apply_lk_jwt_membership' _ "$FNS" 2>&1)"
  RC=$?
}

listed_count() { "$REAL_YQ" "[(.app_service_config_files // [])[] | select(. == \"$REG\")] | length" "$HS"; }
other_kept()   { "$REAL_YQ" "[(.app_service_config_files // [])[] | select(. == \"$D/other-as.yaml\")] | length" "$HS"; }
msc_flag()     { "$REAL_YQ" '.experimental_features.msc4502_enabled' "$HS"; }
re_match()     { python3 -I -c 'import re,sys; sys.exit(0 if re.compile(sys.argv[1]).match(sys.argv[2]) else 1)' "$1" "$2"; }
export -f re_match
no_reg()       { [ ! -e "$REG" ]; }
eq()           { [ "$1" = "$2" ]; }
has()          { [[ "$1" == *"$2"* ]]; }

# ---- (a) configured, run twice: identical files, listed once, flag true -------
new_case a_configured
run_fn "$TOK_AS" "$TOK_HS"
check "a: first run exits 0" eq "$RC" 0
check "a: msc4502_enabled is true" eq "$(msc_flag)" true
check "a: registration listed exactly once" eq "$(listed_count)" 1
check "a: the other registration is left alone" eq "$(other_kept)" 1
check "a: registration file is mode 600" eq "$(stat -c %a "$REG")" 600
check "a: registration holds the as_token, url null, the scope" \
  bash -c 'grep -q "as_token: \"'"$TOK_AS"'\"" "$1" && grep -q "^url: null$" "$1" && grep -q "rooms:is_joined" "$1"' _ "$REG"
check "a: registration has the non-exclusive users namespace" \
  eq "$("$REAL_YQ" '.namespaces.users[0].exclusive' "$REG")" false
cp "$HS" "$D/hs.1"; cp "$REG" "$D/reg.1"
run_fn "$TOK_AS" "$TOK_HS"
check "a: second run exits 0" eq "$RC" 0
check "a: second run leaves homeserver.yaml byte-identical" cmp -s "$HS" "$D/hs.1"
check "a: second run leaves the registration byte-identical" cmp -s "$REG" "$D/reg.1"
check "a: still listed exactly once after two runs" eq "$(listed_count)" 1
# a duplicated pre-existing entry collapses to one
new_case a_dup
"$REAL_YQ" -i ".app_service_config_files += [\"$REG\", \"$REG\"]" "$HS"
run_fn "$TOK_AS" "$TOK_HS"
check "a: a doubly-listed entry collapses to exactly one" eq "$(listed_count)" 1

# ---- (b) the users regex ------------------------------------------------------
new_case b_regex
run_fn "$TOK_AS" "$TOK_HS"
RX="$("$REAL_YQ" '.namespaces.users[0].regex' "$REG")"
echo "      regex for example.org: $RX (matched with re.match, as Synapse does)"
check "b: matches a local user" re_match "$RX" "@alice:example.org"
check "b: matches a local user with punctuation in the localpart" re_match "$RX" "@a.b-c_d=e/f:example.org"
check "b: refuses a remote user" bash -c '! re_match "$@"' _ "$RX" "@alice:other.org"
check "b: refuses a server_name that merely starts with ours" bash -c '! re_match "$@"' _ "$RX" "@alice:example.org.evil.com"
check "b: refuses a server_name matching only if the dot were a wildcard" bash -c '! re_match "$@"' _ "$RX" "@alice:exampleXorg"
check "b: refuses a subdomain" bash -c '! re_match "$@"' _ "$RX" "@alice:sub.example.org"
check "b: refuses a localpart containing ':'" bash -c '! re_match "$@"' _ "$RX" "@al:ice:example.org"
check "b: refuses an empty localpart" bash -c '! re_match "$@"' _ "$RX" "@:example.org"
new_case b_port 'server_name: "example.org:8448"'
run_fn "$TOK_AS" "$TOK_HS"
RXP="$("$REAL_YQ" '.namespaces.users[0].regex' "$REG")"
check "b: a server_name with a port is accepted and matches its own users" re_match "$RXP" "@alice:example.org:8448"
check "b: ... and refuses the same name without the port" bash -c '! re_match "$@"' _ "$RXP" "@alice:example.org"

# ---- (c) server_name missing / null / empty / the string "null" ----------------
for v in "-|missing" 'server_name: null|null' 'server_name: ""|empty' 'server_name: "null"|the string "null"'; do
  line="${v%%|*}"; label="${v##*|}"
  new_case "c_$(echo "$label" | tr -c 'a-z\n' _)" "$line"
  run_fn "$TOK_AS" "$TOK_HS"
  check "c: server_name $label: exits 0" eq "$RC" 0
  check "c: server_name $label: says 'not configured' and why" bash -c '[[ "$1" == *"lk-jwt AS registration not configured"* && "$1" == *"server_name"*"missing or has characters"* ]]' _ "$OUT"
  check "c: server_name $label: no registration file written" no_reg
  check "c: server_name $label: nothing listed" eq "$(listed_count)" 0
  check "c: server_name $label: flag still written" eq "$(msc_flag)" true
done

# ---- (d) failing writes: exit 1 with the refuse message ------------------------
refuses() { # refuses NAME FAKE_FAIL_PATTERN EXPECTED_MESSAGE_FRAGMENT [ECHO_FOR ECHO]
  new_case "d_$1"
  if [ -n "${4:-}" ]; then
    run_fn "$TOK_AS" "$TOK_HS" PATH="$FAKEBIN:$PATH" FAKE_YQ_ECHO_FOR="$4" FAKE_YQ_ECHO="$5"
  else
    run_fn "$TOK_AS" "$TOK_HS" PATH="$FAKEBIN:$PATH" FAKE_YQ_FAIL="$2"
  fi
  check "d: $1: exits 1" eq "$RC" 1
  check "d: $1: message names the cause and refuses to start" \
    bash -c '[[ "$1" == *"ERROR: lk-jwt AS registration: "*"$2"*"Refusing to start Synapse."* ]]' _ "$OUT" "$3"
}
refuses msc4502_write   'msc4502_enabled'   'could not set msc4502_enabled'
check "d: msc4502_write: no registration written" no_reg
refuses remove_old      '$l - ['            'could not remove the old entry'
check "d: remove_old: no registration written" no_reg
refuses list_add        '+= ['              'could not add'
refuses reread_zero     '' 'is not listed once' 'select(. ==' 0
refuses reread_two      '' 'is not listed once' 'select(. ==' 2
# the registration write itself: a directory squats on the path, so `cat > $reg` fails
new_case d_reg_write
mkdir "$REG"
run_fn "$TOK_AS" "$TOK_HS"
check "d: reg_write: exits 1" eq "$RC" 1
check "d: reg_write: message is 'could not write'" bash -c '[[ "$1" == *"ERROR: lk-jwt AS registration: could not write "*"Refusing to start Synapse."* ]]' _ "$OUT"
check "d: reg_write: nothing listed" eq "$(listed_count)" 0
# a genuinely read-only homeserver.yaml (not enforceable for root, so skipped there)
if [ "$(id -u)" != 0 ]; then
  new_case d_readonly
  chmod 444 "$HS"; chmod 555 "$D"
  run_fn "$TOK_AS" "$TOK_HS"
  chmod 755 "$D"
  check "d: read-only homeserver.yaml: exits 1 with the refuse message" \
    bash -c '[ "$1" = 1 ] && [[ "$2" == *"ERROR: lk-jwt AS registration: could not set msc4502_enabled"*"Refusing to start Synapse."* ]]' _ "$RC" "$OUT"
else
  echo "SKIP  d: read-only homeserver.yaml (running as root: permissions do not bind)"
fi

# ---- (e) server_name with a disallowed character --------------------------------
for v in 'ex_ample.org|underscore' 'exa mple.org|space' "a.org'x|quote" '[::1]|IPv6 literal' 'ex@mple.org|at sign' 'example.org/|slash'; do
  name="${v%%|*}"; label="${v##*|}"
  new_case "e_$(echo "$label" | tr -c 'a-z\n' _)" "server_name: \"$name\""
  run_fn "$TOK_AS" "$TOK_HS"
  check "e: server_name with $label: exits 0 (unconfigured, not a crash)" eq "$RC" 0
  check "e: server_name with $label: 'not configured' with the charset reason" \
    bash -c '[[ "$1" == *"not configured"*"characters outside [A-Za-z0-9.:-]"* ]]' _ "$OUT"
  check "e: server_name with $label: no registration, nothing listed" bash -c '[ ! -e "$1" ] && [ "$2" = 0 ]' _ "$REG" "$(listed_count)"
done

# ---- (f) function off: tokens missing/half-set/identical/short ---------------------
for v in '||no tokens' "$TOK_AS||only the AS token" "|$TOK_HS|only the HS token" "$TOK_AS|$TOK_AS|identical tokens" 'short|short|short tokens' "${TOK_AS}!|$TOK_HS|a token outside the charset"; do
  a="${v%%|*}"; rest="${v#*|}"; h="${rest%%|*}"; label="${rest#*|}"
  new_case "f_$(echo "$label" | tr -c 'a-z\n' _)"
  # a previous configured boot: stale registration file + list entry, which must be removed
  echo stale > "$REG"; "$REAL_YQ" -i ".app_service_config_files += [\"$REG\"]" "$HS"
  run_fn "$a" "$h"
  check "f: $label: exits 0 (a supported state)" eq "$RC" 0
  check "f: $label: 'not configured' message with the token rule" \
    bash -c '[[ "$1" == *"lk-jwt AS registration not configured; MSC4502 membership checks unavailable"*"must be two different values of 32+"* ]]' _ "$OUT"
  check "f: $label: stale registration file removed" no_reg
  check "f: $label: our entry removed from app_service_config_files" eq "$(listed_count)" 0
  check "f: $label: the other registration is kept" eq "$(other_kept)" 1
  check "f: $label: the unconditional msc4502_enabled write still ran" eq "$(msc_flag)" true
done
# off, on a file that has no app_service_config_files at all: still ends with a list, flag set
new_case f_no_list
printf 'server_name: "example.org"\n' > "$HS"
run_fn "" ""
check "f: no app_service_config_files key: exits 0, list is empty, flag true" \
  bash -c '[ "$1" = 0 ] && [ "$2" = 0 ] && [ "$3" = true ]' _ "$RC" "$(listed_count)" "$(msc_flag)"

echo
echo "lk-jwt-membership-accept: ${PASS} passed, ${FAILN} failed"
[ "$FAILN" = 0 ]
