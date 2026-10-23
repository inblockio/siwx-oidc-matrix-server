#!/usr/bin/env bash
#
# directory-search-accept.sh: acceptance tests for apply_directory_search in
# entrypoints/matrix_server.sh (registration of the inblock_directory Synapse module,
# docs/directory-search.md).
#
# WHY THIS EXISTS. The function decides whether an endpoint that returns directory
# rows exists at all, and for whom. Its value is in the paths a happy-path boot never
# takes: a list that is emptied must switch the endpoint off again, a malformed or
# unimportable setting must stop the start instead of serving half configured, other
# modules must survive, and with the setting unset the file must not change a byte.
#
# HOW. Like lk-jwt-membership-accept.sh: the function (plus directory_refuse and the
# class constant) is EXTRACTED from the working-tree entrypoint with sed and sourced in
# a subshell; the literal `/data/` is rewritten to a per-case scratch directory. The
# import check runs against a stub package (the module itself needs Synapse, which this
# script does not; the module's behaviour is tested by synapse-modules/run-tests.sh and
# its importability by the image build). Needs mikefarah yq v4 and python3.
#
# Usage:
#   scripts/directory-search-accept.sh
# Env:
#   SIWX_ACCEPT_SCRATCH   fixture base directory, on disk, never tmpfs
#                         (default ~/.cache/siwx-directory-search-accept)
#
# Exit code: non-zero if any case FAILs.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="${REPO_ROOT}/entrypoints/matrix_server.sh"

case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

REAL_YQ="$(command -v yq)" || { echo "need mikefarah yq v4 on PATH" >&2; exit 2; }
"$REAL_YQ" --version 2>&1 | grep -q 'mikefarah/yq.*version v4\.' \
  || { echo "need mikefarah yq v4, found: $("$REAL_YQ" --version 2>&1)" >&2; exit 2; }
command -v python3 >/dev/null || { echo "need python3" >&2; exit 2; }

BASE="${SIWX_ACCEPT_SCRATCH:-${XDG_CACHE_HOME:-$HOME/.cache}/siwx-directory-search-accept}"
mkdir -p "$BASE"
WORK="$(mktemp -d -p "$BASE" run.XXXXXX)"
trap 'chmod -R u+rwx "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

# --- extract the function under test -----------------------------------------
FNS="$WORK/fns.sh"
{
  grep '^DIRECTORY_MODULE_CLASS=' "$ENTRYPOINT"
  for f in directory_refuse apply_directory_search; do
    sed -n "/^${f}() {/,/^}/p" "$ENTRYPOINT"
  done
} | sed 's#/data/#${ACCEPT_DATA}/#g' > "$FNS"
for f in directory_refuse apply_directory_search; do
  grep -q "^${f}() {" "$FNS" || { echo "FAIL: could not extract ${f} from ${ENTRYPOINT}" >&2; exit 1; }
done
grep -q '^DIRECTORY_MODULE_CLASS=' "$FNS" || { echo "FAIL: could not extract DIRECTORY_MODULE_CLASS" >&2; exit 1; }
grep -q '\${ACCEPT_DATA}/homeserver.yaml' "$FNS" \
  || { echo "FAIL: extracted function does not reference homeserver.yaml" >&2; exit 1; }

# --- a stub of the module, so the import check has something to find -----------
STUB="$WORK/stub"; mkdir -p "$STUB/inblock_directory"
echo 'class DirectoryModule: pass' > "$STUB/inblock_directory/__init__.py"
NOSTUB="$WORK/nostub"; mkdir -p "$NOSTUB"

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

CLASS="inblock_directory.DirectoryModule"
OTHER="other_pkg.OtherModule"
SVC_A="@dir-service:example.org"
SVC_B="@dir-service-two:example.org"

PASS=0; FAILN=0
ok()   { echo "PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $1${2:+ -- $2}"; FAILN=$((FAILN+1)); }
check() { # check "name" cmd...   (cmd runs in the current shell; true = pass)
  local name="$1"; shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}
eq()  { [ "$1" = "$2" ]; }
has() { [[ "$1" == *"$2"* ]]; }

# new_case NAME [with_other]: sets D, HS and writes a fixture homeserver.yaml.
new_case() {
  D="$WORK/$1"; mkdir -p "$D"; HS="$D/homeserver.yaml"
  {
    echo 'server_name: "example.org"'
    echo 'public_baseurl: https://example.org/'
    if [ "${2:-}" = with_other ]; then
      echo 'modules:'
      echo "  - module: ${OTHER}"
      echo '    config:'
      echo '      keep: me'
    fi
  } > "$HS"
  OUT=""; RC=""
}

# run_fn [VAR=VAL ...]: runs the function in a subshell; sets RC, OUT (stderr+stdout).
# The stub is on PYTHONPATH unless the case passes its own PYTHONPATH.
run_fn() {
  OUT="$(env -u DIRECTORY_ADMITTED_SERVICES -u DIRECTORY_MAX_LIMIT -u GUEST_POLICY_USER_TYPE -u SIWX_DID_PROFILE_FIELD PYTHONPATH="$STUB" ACCEPT_DATA="$D" "$@" \
    bash -c 'source "$1"; apply_directory_search' _ "$FNS" 2>&1)"
  RC=$?
}

count()    { "$REAL_YQ" "[(.modules // [])[] | select(.module == \"${CLASS}\")] | length" "$HS"; }
other()    { "$REAL_YQ" "[(.modules // [])[] | select(.module == \"${OTHER}\")] | length" "$HS"; }
svcs()     { "$REAL_YQ" -o=json -I=0 "(.modules[] | select(.module == \"${CLASS}\")).config.admitted_services" "$HS"; }
maxlim()   { "$REAL_YQ" "(.modules[] | select(.module == \"${CLASS}\")).config.max_limit" "$HS"; }
cfgkeys()  { "$REAL_YQ" -o=json -I=0 "(.modules[] | select(.module == \"${CLASS}\")).config | keys" "$HS"; }
guesttype() { "$REAL_YQ" "(.modules[] | select(.module == \"${CLASS}\")).config.guest_user_type" "$HS"; }
didfield()  { "$REAL_YQ" "(.modules[] | select(.module == \"${CLASS}\")).config.did_field" "$HS"; }

# ---- (a) configured: entry written once, config exact, idempotent ----------------
new_case a_one
run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A"
check "a: exits 0" eq "$RC" 0
check "a: entry registered exactly once" eq "$(count)" 1
check "a: admitted_services is the single MXID" eq "$(svcs)" "[\"${SVC_A}\"]"
check "a: without DIRECTORY_MAX_LIMIT the config has no max_limit (module default)" eq "$(cfgkeys)" '["admitted_services","guest_user_type","did_field"]'
check "a: guest_user_type is the guest policy's default, io.inblock.guest" eq "$(guesttype)" io.inblock.guest
check "a: did_field is the field protection's default, io.inblock.did" eq "$(didfield)" io.inblock.did
check "a: says ENABLED and never prints an MXID" bash -c '[[ "$1" == *"Directory search: ENABLED for 1 service account(s)"* && "$1" != *"@"* ]]' _ "$OUT"
cp "$HS" "$D/hs.1"
run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A"
check "a: second run leaves homeserver.yaml byte-identical" cmp -s "$HS" "$D/hs.1"

new_case a_two_limit
run_fn DIRECTORY_ADMITTED_SERVICES=" ${SVC_A} , ${SVC_B} " DIRECTORY_MAX_LIMIT=7
check "a: two services with spaces around the commas: exits 0" eq "$RC" 0
check "a: both listed, trimmed, in order" eq "$(svcs)" "[\"${SVC_A}\",\"${SVC_B}\"]"
check "a: max_limit is a number" eq "$("$REAL_YQ" "(.modules[] | select(.module == \"${CLASS}\")).config.max_limit | tag" "$HS")" '!!int'
check "a: max_limit 7" eq "$(maxlim)" 7
run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A" DIRECTORY_MAX_LIMIT=50
check "a: a changed setting replaces the entry, still one" bash -c '[ "$1" = 1 ] && [ "$2" = "[\"$3\"]" ] && [ "$4" = 50 ]' _ "$(count)" "$(svcs)" "$SVC_A" "$(maxlim)"

# The module reads the same two values the guest policy and the DID field protection do.
new_case a_markers_env
run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A" GUEST_POLICY_USER_TYPE=org.example.visitor SIWX_DID_PROFILE_FIELD=org.example.identity
check "a: exits 0 with both markers set" eq "$RC" 0
check "a: guest_user_type is GUEST_POLICY_USER_TYPE" eq "$(guesttype)" org.example.visitor
check "a: did_field is SIWX_DID_PROFILE_FIELD" eq "$(didfield)" org.example.identity
check "a: both markers are said in the ENABLED line" bash -c '[[ "$1" == *"guest_user_type=org.example.visitor"* && "$1" == *"did_field=org.example.identity"* ]]' _ "$OUT"
run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A" GUEST_POLICY_USER_TYPE= SIWX_DID_PROFILE_FIELD=
check "a: set but empty means the default, as in the guest policy and the field protection" bash -c '[ "$1" = io.inblock.guest ] && [ "$2" = io.inblock.did ]' _ "$(guesttype)" "$(didfield)"
run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A" GUEST_POLICY_USER_TYPE=org.example.visitor SIWX_DID_PROFILE_FIELD=org.example.identity
cp "$HS" "$D/hs.1"
run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A" GUEST_POLICY_USER_TYPE=org.example.visitor SIWX_DID_PROFILE_FIELD=org.example.identity
check "a: a second run with both markers leaves homeserver.yaml byte-identical" cmp -s "$HS" "$D/hs.1"
run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A"
check "a: a boot without the variables writes the defaults back (re-asserted every boot)" bash -c '[ "$1" = io.inblock.guest ] && [ "$2" = io.inblock.did ] && [ "$3" = 1 ]' _ "$(guesttype)" "$(didfield)" "$(count)"

new_case a_port
run_fn DIRECTORY_ADMITTED_SERVICES="@dir-service:example.org:8448" DIRECTORY_MAX_LIMIT=1
check "a: a server name with a port and max_limit 1 are accepted" bash -c '[ "$1" = 0 ] && [ "$2" = 1 ]' _ "$RC" "$(maxlim)"

# ---- (b) other modules survive; a pre-existing duplicate collapses ---------------
new_case b_other with_other
run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A"
check "b: exits 0" eq "$RC" 0
check "b: our entry added" eq "$(count)" 1
check "b: the other module is kept, with its config" bash -c '[ "$1" = 1 ] && [ "$2" = me ]' _ "$(other)" "$("$REAL_YQ" ".modules[0].config.keep" "$HS")"
"$REAL_YQ" -i ".modules += [{\"module\": \"${CLASS}\", \"config\": {\"admitted_services\": [\"@old:example.org\"]}}]" "$HS"
check "b: (fixture now lists our module twice)" eq "$(count)" 2
run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A"
check "b: a doubly listed entry collapses to one with the new config" bash -c '[ "$1" = 1 ] && [ "$2" = "[\"$3\"]" ] && [ "$4" = 1 ]' _ "$(count)" "$(svcs)" "$SVC_A" "$(other)"

# ---- (c) off: unset, empty, blank -------------------------------------------------
for v in "unset|" "empty|DIRECTORY_ADMITTED_SERVICES=" "blank|DIRECTORY_ADMITTED_SERVICES=   "; do
  label="${v%%|*}"; setting="${v#*|}"
  new_case "c_${label}_fresh"
  cp "$HS" "$D/hs.0"
  run_fn ${setting:+"$setting"}
  check "c: $label on a file without our entry: exits 0, says disabled" bash -c '[ "$1" = 0 ] && [[ "$2" == *"Directory search: disabled"* ]]' _ "$RC" "$OUT"
  check "c: $label: homeserver.yaml is byte-identical (byte-neutral when off)" cmp -s "$HS" "$D/hs.0"

  new_case "c_${label}_stale" with_other
  "$REAL_YQ" -i ".modules += [{\"module\": \"${CLASS}\", \"config\": {\"admitted_services\": [\"${SVC_A}\"]}}]" "$HS"
  run_fn ${setting:+"$setting"}
  check "c: $label with an earlier entry: exits 0, says it removed it" bash -c '[ "$1" = 0 ] && [[ "$2" == *"removed the module entry"* ]]' _ "$RC" "$OUT"
  check "c: $label: our entry is gone, the other module stays" bash -c '[ "$1" = 0 ] && [ "$2" = 1 ]' _ "$(count)" "$(other)"

  new_case "c_${label}_only"
  "$REAL_YQ" -i ".modules += [{\"module\": \"${CLASS}\", \"config\": {\"admitted_services\": [\"${SVC_A}\"]}}]" "$HS"
  run_fn ${setting:+"$setting"}
  check "c: $label when ours was the only module: the empty modules key is dropped" eq "$("$REAL_YQ" 'has("modules")' "$HS")" false
done

# ---- (d) malformed values refuse to start and write nothing -----------------------
refuses() { # refuses LABEL VAR=VAL [VAR=VAL]
  local label="$1"; shift
  new_case "d_$(echo "$label" | tr -c 'a-z0-9\n' _)"
  cp "$HS" "$D/hs.0"
  run_fn "$@"
  check "d: $label: exits 1 with REFUSING TO START" bash -c '[ "$1" = 1 ] && [[ "$2" == *"REFUSING TO START: "* ]]' _ "$RC" "$OUT"
  check "d: $label: homeserver.yaml untouched" cmp -s "$HS" "$D/hs.0"
}
refuses "no @"            DIRECTORY_ADMITTED_SERVICES="dir-service:example.org"
refuses "no server"       DIRECTORY_ADMITTED_SERVICES="@dir-service"
refuses "space inside"    DIRECTORY_ADMITTED_SERVICES="@dir service:example.org"
refuses "trailing comma"  DIRECTORY_ADMITTED_SERVICES="${SVC_A},"
refuses "empty entry"     DIRECTORY_ADMITTED_SERVICES="${SVC_A},,${SVC_B}"
refuses "leading comma"   DIRECTORY_ADMITTED_SERVICES=",${SVC_A}"
refuses "yaml quote"      DIRECTORY_ADMITTED_SERVICES='@a"b:example.org'
refuses "yaml flow"       DIRECTORY_ADMITTED_SERVICES='@a:example.org, {x: y}'
refuses "shell expansion" DIRECTORY_ADMITTED_SERVICES='@$(id):example.org'
refuses "newline"         DIRECTORY_ADMITTED_SERVICES=$'@a:example.org\n@b:example.org'
refuses "max_limit 0"     DIRECTORY_ADMITTED_SERVICES="$SVC_A" DIRECTORY_MAX_LIMIT=0
refuses "max_limit 51"    DIRECTORY_ADMITTED_SERVICES="$SVC_A" DIRECTORY_MAX_LIMIT=51
refuses "max_limit text"  DIRECTORY_ADMITTED_SERVICES="$SVC_A" DIRECTORY_MAX_LIMIT=twenty
refuses "max_limit 20x"   DIRECTORY_ADMITTED_SERVICES="$SVC_A" DIRECTORY_MAX_LIMIT=20x
refuses "max_limit 07"    DIRECTORY_ADMITTED_SERVICES="$SVC_A" DIRECTORY_MAX_LIMIT=07
refuses "guest type space"     DIRECTORY_ADMITTED_SERVICES="$SVC_A" GUEST_POLICY_USER_TYPE="io inblock"
refuses "guest type yaml"      DIRECTORY_ADMITTED_SERVICES="$SVC_A" GUEST_POLICY_USER_TYPE='a"b'
refuses "guest type newline"   DIRECTORY_ADMITTED_SERVICES="$SVC_A" GUEST_POLICY_USER_TYPE=$'io.inblock.guest\nx'
refuses "guest type too long"  DIRECTORY_ADMITTED_SERVICES="$SVC_A" GUEST_POLICY_USER_TYPE="$(printf 'x%.0s' $(seq 256))"
refuses "did field uppercase"  DIRECTORY_ADMITTED_SERVICES="$SVC_A" SIWX_DID_PROFILE_FIELD=Io.Inblock.Did
refuses "did field digit start" DIRECTORY_ADMITTED_SERVICES="$SVC_A" SIWX_DID_PROFILE_FIELD=1did
refuses "did field space"      DIRECTORY_ADMITTED_SERVICES="$SVC_A" SIWX_DID_PROFILE_FIELD="io.inblock did"
refuses "did field newline"    DIRECTORY_ADMITTED_SERVICES="$SVC_A" SIWX_DID_PROFILE_FIELD=$'io.inblock.did\nx'
refuses "did field too long"   DIRECTORY_ADMITTED_SERVICES="$SVC_A" SIWX_DID_PROFILE_FIELD="$(printf 'x%.0s' $(seq 256))"
# the refusal never echoes the offending value (it may be a secret pasted into the wrong variable)
new_case d_no_echo
run_fn DIRECTORY_ADMITTED_SERVICES='not-an-mxid-canary-7f3a'
check "d: a refused value is not echoed" bash -c '[[ "$1" != *"canary-7f3a"* ]]' _ "$OUT"
for var in GUEST_POLICY_USER_TYPE SIWX_DID_PROFILE_FIELD; do
  new_case "d_no_echo_${var}"
  run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A" "${var}=Bad Value canary-9c1e"
  check "d: a refused ${var} is not echoed" bash -c '[ "$2" = 1 ] && [[ "$1" != *"canary-9c1e"* ]]' _ "$OUT" "$RC"
done
# off means off: a bad marker is nobody's business while the module is not asked for
new_case d_markers_ignored_when_off
cp "$HS" "$D/hs.0"
run_fn GUEST_POLICY_USER_TYPE="a b" SIWX_DID_PROFILE_FIELD="Not Valid"
check "d: bad markers are ignored while DIRECTORY_ADMITTED_SERVICES is empty" bash -c '[ "$1" = 0 ]' _ "$RC"
check "d: ... and homeserver.yaml stays byte-identical" cmp -s "$HS" "$D/hs.0"

# ---- (e) module not importable: refuses, writes nothing ---------------------------
new_case e_no_module with_other
cp "$HS" "$D/hs.0"
run_fn DIRECTORY_ADMITTED_SERVICES="$SVC_A" PYTHONPATH="$NOSTUB"
check "e: exits 1 and names the module" bash -c '[ "$1" = 1 ] && [[ "$2" == *"REFUSING TO START"*"inblock_directory"*"cannot be imported"* ]]' _ "$RC" "$OUT"
check "e: homeserver.yaml untouched" cmp -s "$HS" "$D/hs.0"
# off + not importable is fine: nothing is asked for
new_case e_off_no_module
run_fn PYTHONPATH="$NOSTUB"
check "e: setting empty and no module: exits 0" eq "$RC" 0

# ---- (f) failing writes -----------------------------------------------------------
refuses_write() { # refuses_write LABEL FAKE_FAIL_PATTERN
  new_case "f_$1"
  run_fn PATH="$FAKEBIN:$PATH" FAKE_YQ_FAIL="$2" DIRECTORY_ADMITTED_SERVICES="$SVC_A"
  check "f: $1: exits 1 with REFUSING TO START" bash -c '[ "$1" = 1 ] && [[ "$2" == *"REFUSING TO START: could not write the modules entry"* ]]' _ "$RC" "$OUT"
}
refuses_write modules_write 'strenv(DIR_CLASS)'
new_case f_reread_zero
run_fn PATH="$FAKEBIN:$PATH" FAKE_YQ_ECHO_FOR='select(.module ==' FAKE_YQ_ECHO=0 DIRECTORY_ADMITTED_SERVICES="$SVC_A"
check "f: reread finds nothing: refuses" bash -c '[ "$1" = 1 ] && [[ "$2" == *"entry is not in"*"after writing it"* ]]' _ "$RC" "$OUT"
new_case f_remove_fails
"$REAL_YQ" -i ".modules += [{\"module\": \"${CLASS}\", \"config\": {\"admitted_services\": [\"${SVC_A}\"]}}]" "$HS"
run_fn PATH="$FAKEBIN:$PATH" FAKE_YQ_FAIL='del(.modules[]'
check "f: removal fails: refuses to start" bash -c '[ "$1" = 1 ] && [[ "$2" == *"could not remove"* ]]' _ "$RC" "$OUT"

# ---- (g) wiring: called once, after the guest policy, before the DID-field guard ----
CALLS="$(grep -n '^  apply_[a-z_]*$' "$ENTRYPOINT" | sed 's/^\([0-9]*\):  /\1 /')"
n_dir="$(echo "$CALLS" | grep -c ' apply_directory_search$')"
l_dir="$(echo "$CALLS" | awk '$2 == "apply_directory_search" {print $1}')"
l_did="$(echo "$CALLS" | awk '$2 == "apply_did_field_protection" {print $1}')"
l_last="$(echo "$CALLS" | tail -n1 | awk '{print $2}')"
check "g: apply_directory_search is called exactly once" eq "$n_dir" 1
check "g: ... before apply_did_field_protection" bash -c '[ -n "$1" ] && [ -n "$2" ] && [ "$1" -lt "$2" ]' _ "$l_dir" "$l_did"
check "g: apply_did_field_protection is still the last apply_* call" eq "$l_last" apply_did_field_protection

# The two defaults the module is handed must be the ones the guest policy and the field
# protection use: every ${VAR:-default} spelling in the entrypoint names the same default.
for var in GUEST_POLICY_USER_TYPE SIWX_DID_PROFILE_FIELD; do
  defaults="$(grep -o "\${${var}:-[^}]*}" "$ENTRYPOINT" | sort -u)"
  check "g: ${var} has one default across the entrypoint" bash -c '[ "$(printf "%s\n" "$1" | grep -c .)" = 1 ]' _ "$defaults"
done
check "g: apply_directory_search reads both variables" bash -c \
  'grep -q "GUEST_POLICY_USER_TYPE:-" "$1" && grep -q "SIWX_DID_PROFILE_FIELD:-" "$1"' _ "$FNS"

echo
echo "directory-search-accept: ${PASS} passed, ${FAILN} failed"
[ "$FAILN" = 0 ]
