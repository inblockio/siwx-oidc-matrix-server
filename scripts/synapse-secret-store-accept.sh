#!/usr/bin/env bash
#
# synapse-secret-store-accept.sh: acceptance tests for the secret store mode of
# entrypoints/matrix_server.sh (docs/synapse-secret-files.md).
#
# WHY THIS EXISTS. Store mode is the switch that takes every secret out of the Synapse
# container's environment and out of homeserver.yaml. A boot that gets it wrong either
# takes Matrix down (a refusal that should not fire, a write that does not land) or
# leaves a secret inline (the failure the mode exists to prevent). And the image must
# behave EXACTLY as before when the mode is off. The cases below pin both.
#
# HOW. The whole working-tree entrypoint is copied with two rewrites: the literal
# `/data` becomes a per-case scratch directory and `/start.py` becomes a stub that
# records its arguments (and, for `generate`, writes a homeserver.yaml shaped like
# Synapse's own, with throwaway inline secrets). The copy runs under `env -i`, so no
# variable of the caller leaks in. Every secret value is generated at run time, and
# after the run no log may contain any of them. It needs mikefarah yq v4 (the
# entrypoint's own yq), python3 and bash; no container runtime. CI installs a pinned yq.
#
# BYTE IDENTITY WITHOUT STORE MODE. With the mode off, the rendered homeserver.yaml and
# lk-jwt-as.yaml must equal what the entrypoint rendered before the mode existed:
#   * always: against the committed golden (scripts/testdata/synapse-secret-store/
#     nostore.golden, values masked), made by the entrypoint of the commit before;
#   * when SIWX_ACCEPT_BASELINE names an older entrypoint: byte for byte against it
#     (the same scratch directory, so not even a path differs).
#
# Usage:
#   scripts/synapse-secret-store-accept.sh                  # needs yq v4, python3 and bash on PATH
#   SIWX_ACCEPT_BASELINE=/path/to/old/matrix_server.sh scripts/synapse-secret-store-accept.sh
#   SIWX_ACCEPT_BASELINE=/path/to/old/matrix_server.sh scripts/synapse-secret-store-accept.sh --write-golden
# Env:
#   SIWX_ACCEPT_SCRATCH   scratch base directory, on disk, never tmpfs
#                         (default ~/.cache/siwx-synapse-secret-store-accept)
#
# Exit code: non-zero if any case FAILs.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="${REPO_ROOT}/entrypoints/matrix_server.sh"
GOLDEN="${REPO_ROOT}/scripts/testdata/synapse-secret-store/nostore.golden"
BASELINE="${SIWX_ACCEPT_BASELINE:-}"
WRITE_GOLDEN=0
case "${1:-}" in
  "") ;;
  --write-golden) WRITE_GOLDEN=1 ;;
  -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac
[ "$WRITE_GOLDEN" = 0 ] || [ -n "$BASELINE" ] \
  || { echo "--write-golden needs SIWX_ACCEPT_BASELINE (the golden is made by the old entrypoint)" >&2; exit 2; }
[ -z "$BASELINE" ] || [ -f "$BASELINE" ] || { echo "SIWX_ACCEPT_BASELINE is not a file: $BASELINE" >&2; exit 2; }

REAL_YQ="$(command -v yq)" || { echo "need mikefarah yq v4 on PATH" >&2; exit 2; }
"$REAL_YQ" --version 2>&1 | grep -q 'mikefarah/yq.*version v4\.' \
  || { echo "need mikefarah yq v4, found: $("$REAL_YQ" --version 2>&1)" >&2; exit 2; }
command -v python3 >/dev/null || { echo "need python3" >&2; exit 2; }
REAL_ID="$(command -v id)"
[ "$("$REAL_ID" -u)" != 0 ] || { echo "run as a non-root user: store mode refuses a root container, so every case would refuse" >&2; exit 2; }
YQ_DIR="$(dirname "$REAL_YQ")"

BASE="${SIWX_ACCEPT_SCRATCH:-${XDG_CACHE_HOME:-$HOME/.cache}/siwx-synapse-secret-store-accept}"
mkdir -p "$BASE"
WORK="$(mktemp -d -p "$BASE" run.XXXXXX)"
trap 'chmod -R u+rwx "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

PASS=0; FAILN=0
ok()  { echo "PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $1${2:+ -- $2}"; FAILN=$((FAILN+1)); }
check() { # check "name" cmd...   (cmd runs in the current shell; true = pass)
  local name="$1"; shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}

rnd() { python3 -c 'import secrets; print(secrets.token_hex(24))'; }

# --- throwaway values, generated now ---------------------------------------------------
V_MAS="$(rnd)"; V_LKAS="$(rnd)"; V_LKHS="$(rnd)"                  # environment, mode off
V_GEN_REG="$(rnd)"; V_GEN_MAC="$(rnd)"; V_GEN_FORM="$(rnd)"        # what `generate` writes inline
V_S_MAS="$(rnd)"; V_S_MAC="$(rnd)"; V_S_FORM="$(rnd)"              # store files
V_S_AS="$(rnd)"; V_S_HS="$(rnd)"                                   # store registration
V_LEAK="$(rnd)"                                                    # a secret put into the environment
V_F_AS="$(rnd)"; V_F_HS="$(rnd)"                                   # the registration an existing config already lists
ALL_VALUES=("$V_MAS" "$V_LKAS" "$V_LKHS" "$V_GEN_REG" "$V_GEN_MAC" "$V_GEN_FORM" "$V_S_MAS" "$V_S_MAC" "$V_S_FORM" "$V_S_AS" "$V_S_HS" "$V_LEAK" "$V_F_AS" "$V_F_HS")

# --- stand-ins on PATH and PYTHONPATH --------------------------------------------------
FAKEBIN="$WORK/fakebin"; mkdir -p "$FAKEBIN"
# id: `id -u` answers 0 when FAKE_ID_ROOT=1, to reach the root refusal without being root, and
# FAKE_ID_UID otherwise when that is set. The fixtures are owned by the user who runs this script, so
# a boot is given another uid as its "container user" (run_entry sets one), the way the image's uid 991
# owns none of the mounted secret files; FAKE_ID_UID=<the real uid> makes the files the container user's own.
cat > "$FAKEBIN/id" <<FAKE
#!/usr/bin/env bash
if [ "\${FAKE_ID_ROOT:-}" = 1 ] && [ "\${1:-}" = "-u" ]; then echo 0; exit 0; fi
if [ -n "\${FAKE_ID_UID:-}" ] && [ "\${1:-}" = "-u" ]; then echo "\$FAKE_ID_UID"; exit 0; fi
exec "$REAL_ID" "\$@"
FAKE
chmod +x "$FAKEBIN/id"
REAL_UID="$("$REAL_ID" -u)"; FAKE_UID=$((REAL_UID + 1))

# A Synapse that carries the MSC4133 write-ACL patch, as far as the entrypoint's own
# probe can tell (synapse_enforces_did_field_denylist reads two marker strings).
FAKEPKG="$WORK/fakepkg"; mkdir -p "$FAKEPKG/synapse/config" "$FAKEPKG/synapse/handlers"
: > "$FAKEPKG/synapse/__init__.py"
echo "msc4133_key_denylist" > "$FAKEPKG/synapse/config/experimental.py"
echo "msc4133_key_denylist" > "$FAKEPKG/synapse/handlers/profile.py"

# /start.py: `generate` writes what Synapse's `--generate-config` writes (inline
# secrets included); anything else records its arguments, which is all the entrypoint's
# last line decides.
STUB="$WORK/start-stub"
cat > "$STUB" <<'STUBEOF'
#!/usr/bin/env bash
case "${1:-}" in
  generate)
    cat > "${ACCEPT_DATA}/homeserver.yaml" <<EOF
# Configuration file for Synapse.
server_name: "${MATRIX_HOST}"
pid_file: ${ACCEPT_DATA}/homeserver.pid
listeners:
  - port: 8008
    tls: false
    type: http
    x_forwarded: true
    resources:
      - names: [client, federation]
        compress: false
  - port: 8448
    tls: true
    type: http
    resources:
      - names: [federation]
database:
  name: sqlite3
  args:
    database: ${ACCEPT_DATA}/homeserver.db
log_config: "${ACCEPT_DATA}/log.config"
media_store_path: ${ACCEPT_DATA}/media_store
registration_shared_secret: "${ACCEPT_GEN_REG}"
report_stats: false
macaroon_secret_key: "${ACCEPT_GEN_MAC}"
form_secret: "${ACCEPT_GEN_FORM}"
signing_key_path: "${ACCEPT_DATA}/signing.key"
trusted_key_servers:
  - server_name: "matrix.org"
EOF
    ;;
  *) printf 'ARGS:%s\n' "$*" > "${ACCEPT_DATA}/.start-args" ;;
esac
STUBEOF
chmod +x "$STUB"

# prepare_entry SRC DEST D : the entrypoint with /data and /start.py rewritten.
prepare_entry() {
  sed -e "s#/data\\b#${3}#g" -e "s#/start\\.py#${STUB}#g" "$1" > "$2"
}

# run_entry ENTRYFILE D [VAR=VAL ...] : one boot. Sets RC; the combined output is in
# $LOG (one file per call, outside the data directory so that a read-only data
# directory can be tested).
RUNN=0
RUNDIR="$WORK/_runs"; mkdir -p "$RUNDIR"
# The directories that hold the secret files ($D/sec, $D/alt) are read-only while a boot runs, as a
# read-only mount is, and writable again afterwards so that a case can go on changing its fixtures.
# A case that tests a writable directory names it in WRITABLE_DIRS (space separated) for one boot.
WRITABLE_DIRS=""
lock_store_dirs() { # lock_store_dirs lock|unlock D
  local x
  for x in "$2/sec" "$2/alt"; do
    [ -d "$x" ] || continue
    case " $WRITABLE_DIRS " in *" $x "*) continue ;; esac
    if [ "$1" = lock ]; then chmod a-w "$x"; else chmod u+w "$x"; fi
  done
}
run_entry() {
  local entry="$1" d="$2"; shift 2
  RUNN=$((RUNN+1))
  prepare_entry "$entry" "$RUNDIR/entry.$RUNN.sh" "$d"
  LOG="$RUNDIR/out.$RUNN.log"
  lock_store_dirs lock "$d"
  env -i PATH="$FAKEBIN:$YQ_DIR:/usr/local/bin:/usr/bin:/bin" HOME="$d" \
    PYTHONPATH="$FAKEPKG" ACCEPT_DATA="$d" FAKE_ID_UID="$FAKE_UID" \
    ACCEPT_GEN_REG="$V_GEN_REG" ACCEPT_GEN_MAC="$V_GEN_MAC" ACCEPT_GEN_FORM="$V_GEN_FORM" \
    MATRIX_HOST=example.org MATRIX_BASE_URL=https://example.org MATRIX_PORT=8008 \
    SIWEOIDC_BASE_URL=https://auth.example.org MATRIX_MESSAGE_LIFETIME=4w \
    "$@" bash "$RUNDIR/entry.$RUNN.sh" > "$LOG" 2>&1
  RC=$?
  lock_store_dirs unlock "$d"
}

# The environment of a boot with the mode off: the secrets are in it, as today.
NOSTORE_ENV=("MAS_SHARED_SECRET=$V_MAS" "LK_JWT_AS_TOKEN=$V_LKAS" "LK_JWT_HS_TOKEN=$V_LKHS")

# new_dir NAME : a fresh data directory, with a store directory holding fresh files.
new_dir() {
  D="$WORK/$1"; rm -rf "$D"; mkdir -p "$D/sec"
  printf '%s\n' "$V_S_MAS" > "$D/sec/mas_shared_secret"
  printf '%s\n' "$V_S_MAC" > "$D/sec/macaroon_secret_key"
  printf '%s\n' "$V_S_FORM" > "$D/sec/form_secret"
  cat > "$D/sec/lk_jwt_as_registration.yaml" <<EOF
id: lk-jwt-service
as_token: "$V_S_AS"
hs_token: "$V_S_HS"
sender_localpart: _lk_jwt_service
url: null
namespaces:
  users:
    - exclusive: false
      regex: '^@[^:]+:example\.org\$'
EOF
  chmod 0440 "$D"/sec/*
}

# new_hs_fixture : a plain config in $D (an existing deployment), no inline secrets. It lists one
# registration of another service. The file exists and has its own id and tokens: a listed entry
# that is not a readable regular file is refused (F1).
new_hs_fixture() {
  cat > "$D/homeserver.yaml" <<EOF
server_name: "example.org"
public_baseurl: https://example.org/
app_service_config_files:
  - $D/other-as.yaml
EOF
  cat > "$D/other-as.yaml" <<EOF
id: foreign-service
as_token: "$V_F_AS"
hs_token: "$V_F_HS"
sender_localpart: _foreign_service
url: null
namespaces:
  users:
    - exclusive: false
      regex: '^@foreign_[^:]+:example\.org\$'
EOF
}

masked() { # masked FILE SCRATCH_DIR : the file with every throwaway value and the scratch dir masked
  # The key next to a masked value names which secret it was, so one placeholder does.
  sed -e "s#${2}#/data#g" \
      -e "s#${V_MAS}#<redacted>#g" -e "s#${V_LKAS}#<redacted>#g" -e "s#${V_LKHS}#<redacted>#g" \
      -e "s#${V_GEN_REG}#<redacted>#g" -e "s#${V_GEN_MAC}#<redacted>#g" -e "s#${V_GEN_FORM}#<redacted>#g" "$1"
}

has_value() { # has_value FILE... : any throwaway value in any of the files
  local v f
  for f in "$@"; do
    [ -e "$f" ] || continue
    for v in "${ALL_VALUES[@]}"; do grep -qF -- "$v" "$f" && return 0; done
  done
  return 1
}
no_value_in_dir_but_sec() { # no value anywhere under $D except the store files themselves
  local f
  while IFS= read -r f; do has_value "$f" && { echo "value found in $f" >&2; return 1; }; done \
    < <(find "$D" -type f -not -path "$D/sec/*")
  return 0
}
yqv() { "$REAL_YQ" "$@"; }

# =====================================================================================
echo "== static"
check "the entrypoint never turns on xtrace" bash -c "! grep -nE '^[[:space:]]*set[[:space:]]+-[a-z]*x|xtrace' '$ENTRYPOINT'"
check "the entrypoint parses (bash -n)" bash -n "$ENTRYPOINT"

# =====================================================================================
echo "== mode off: the same bytes as before"
render_nostore() { # render_nostore ENTRYFILE OUTDIR : first boot, then a second boot
  local entry="$1" out="$2"
  rm -rf "$WORK/render" "$out"; mkdir -p "$WORK/render" "$out/boot1" "$out/boot2"
  D="$WORK/render"
  run_entry "$entry" "$D" "${NOSTORE_ENV[@]}"
  RC1=$RC; cp "$LOG" "$out/boot1.log"
  cp "$D/homeserver.yaml" "$D/lk-jwt-as.yaml" "$out/boot1/" 2>/dev/null
  cp "$D/.start-args" "$out/boot1/start-args" 2>/dev/null
  run_entry "$entry" "$D" "${NOSTORE_ENV[@]}"
  RC2=$RC; cp "$LOG" "$out/boot2.log"
  cp "$D/homeserver.yaml" "$D/lk-jwt-as.yaml" "$out/boot2/" 2>/dev/null
}
render_nostore "$ENTRYPOINT" "$WORK/new"
check "mode off: first boot exits 0" test "$RC1" = 0
check "mode off: second boot exits 0" test "$RC2" = 0
check "mode off: the second boot changes no byte (idempotent)" bash -c "cmp '$WORK/new/boot1/homeserver.yaml' '$WORK/new/boot2/homeserver.yaml' && cmp '$WORK/new/boot1/lk-jwt-as.yaml' '$WORK/new/boot2/lk-jwt-as.yaml'"
check "mode off: the last line starts /start.py with no argument" test "$(cat "$WORK/new/boot1/start-args")" = "ARGS:"
check "mode off: the inline secrets are where they always were" bash -c "
  test \"\$(yq '.matrix_authentication_service.secret' '$WORK/new/boot1/homeserver.yaml')\" = '$V_MAS' &&
  test \"\$(yq '.macaroon_secret_key' '$WORK/new/boot1/homeserver.yaml')\" = '$V_GEN_MAC' &&
  yq -e '.app_service_config_files[] | select(. == \"$WORK/render/lk-jwt-as.yaml\")' '$WORK/new/boot1/homeserver.yaml' >/dev/null"
check "mode off: no *_path key is written" bash -c "! grep -qE 'secret_path|secret_key_path|form_secret_path' '$WORK/new/boot1/homeserver.yaml'"

{ echo "### homeserver.yaml (first boot)"; masked "$WORK/new/boot1/homeserver.yaml" "$WORK/render"
  echo "### lk-jwt-as.yaml (first boot)"; masked "$WORK/new/boot1/lk-jwt-as.yaml" "$WORK/render"
  echo "### homeserver.yaml (second boot)"; masked "$WORK/new/boot2/homeserver.yaml" "$WORK/render"; } > "$WORK/new.golden"

if [ -n "$BASELINE" ]; then
  render_nostore "$BASELINE" "$WORK/old"
  check "baseline entrypoint: both boots exit 0" test "$RC1$RC2" = 00
  for f in boot1/homeserver.yaml boot1/lk-jwt-as.yaml boot2/homeserver.yaml boot2/lk-jwt-as.yaml; do
    check "mode off: $f is byte-identical to the baseline entrypoint's" cmp "$WORK/old/$f" "$WORK/new/$f"
  done
  if [ "$WRITE_GOLDEN" = 1 ]; then
    { echo "### homeserver.yaml (first boot)"; masked "$WORK/old/boot1/homeserver.yaml" "$WORK/render"
      echo "### lk-jwt-as.yaml (first boot)"; masked "$WORK/old/boot1/lk-jwt-as.yaml" "$WORK/render"
      echo "### homeserver.yaml (second boot)"; masked "$WORK/old/boot2/homeserver.yaml" "$WORK/render"; } > "$WORK/old.golden"
    mkdir -p "$(dirname "$GOLDEN")"; cp "$WORK/old.golden" "$GOLDEN"; echo "wrote $GOLDEN"
  fi
fi
if [ -f "$GOLDEN" ]; then
  check "mode off: the render equals the committed golden (values masked)" bash -c "diff -u '$GOLDEN' '$WORK/new.golden' >&2"
else
  bad "mode off: committed golden exists" "$GOLDEN is missing"
fi

# =====================================================================================
echo "== store mode: first boot on an empty data directory"
new_dir s1
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
S1=$D; S1LOG=$LOG
check "first boot: exits 0" test "$RC" = 0
check "first boot: Synapse is started with run --no-secrets-in-config" test "$(cat "$S1/.start-args")" = "ARGS:run --no-secrets-in-config"
check "first boot: the three secret keys are *_path references to the store files" bash -c "
  test \"\$(yq '.macaroon_secret_key_path' '$S1/homeserver.yaml')\" = '$S1/sec/macaroon_secret_key' &&
  test \"\$(yq '.form_secret_path' '$S1/homeserver.yaml')\" = '$S1/sec/form_secret' &&
  test \"\$(yq '.matrix_authentication_service.secret_path' '$S1/homeserver.yaml')\" = '$S1/sec/mas_shared_secret'"
check "first boot: no inline secret key is left (generate's three, and the MAS secret)" bash -c "
  test \"\$(yq '[.macaroon_secret_key, .form_secret, .registration_shared_secret, .registration_shared_secret_path, .matrix_authentication_service.secret] | map(select(. != null)) | length' '$S1/homeserver.yaml')\" = 0"
check "first boot: MAS stays enabled with its endpoint" bash -c "
  test \"\$(yq '.matrix_authentication_service.enabled' '$S1/homeserver.yaml')\" = true &&
  test \"\$(yq '.matrix_authentication_service.endpoint' '$S1/homeserver.yaml')\" = https://auth.example.org"
check "first boot: MSC4502 stays enabled" test "$(yqv '.experimental_features.msc4502_enabled' "$S1/homeserver.yaml")" = true
check "first boot: the registration is the store file, listed once; no lk-jwt-as.yaml is rendered" bash -c "
  test \"\$(yq '.app_service_config_files | length' '$S1/homeserver.yaml')\" = 1 &&
  test \"\$(yq '.app_service_config_files[0]' '$S1/homeserver.yaml')\" = '$S1/sec/lk_jwt_as_registration.yaml' &&
  test ! -e '$S1/lk-jwt-as.yaml'"
check "first boot: no throwaway value is anywhere in the data directory or the log" no_value_in_dir_but_sec
check "first boot: the log says store mode and names no value" bash -c "grep -q 'Secret store mode: MAS, macaroon and form' '$S1LOG'"
check "first boot: the DID field denylist is still written" test "$(yqv '.experimental_features.msc4133_key_denylist[0]' "$S1/homeserver.yaml")" = io.inblock.did

# Everything but the secret keys is the same as with the mode off.
strip_secret_keys() {
  yqv 'del(.macaroon_secret_key, .form_secret, .registration_shared_secret, .registration_shared_secret_path, .matrix_authentication_service.secret, .macaroon_secret_key_path, .form_secret_path, .matrix_authentication_service.secret_path, .app_service_config_files)' "$1"
}
check "first boot: apart from the secret keys and the registration list, homeserver.yaml equals the mode-off render" bash -c "
  diff <(yq 'del(.macaroon_secret_key, .form_secret, .registration_shared_secret, .matrix_authentication_service.secret, .app_service_config_files)' '$WORK/new/boot1/homeserver.yaml' | sed 's#$WORK/render#X#g') \
       <(yq 'del(.macaroon_secret_key_path, .form_secret_path, .matrix_authentication_service.secret_path, .app_service_config_files)' '$S1/homeserver.yaml' | sed 's#$S1#X#g') >&2"

echo "== store mode: a second boot, and switching an existing mode-off deployment"
cp "$S1/homeserver.yaml" "$WORK/s1.before"
run_entry "$ENTRYPOINT" "$S1" "SYNAPSE_SECRETS_DIR=${S1}/sec"
check "second boot: exits 0 and changes no byte" bash -c "test $RC = 0 && cmp '$WORK/s1.before' '$S1/homeserver.yaml'"

new_dir s2
run_entry "$ENTRYPOINT" "$D" "${NOSTORE_ENV[@]}"          # the deployment as it is today
S2=$D
test "$RC" = 0 || bad "switch: the mode-off boot that seeds the case exits 0" "rc=$RC"
cp "$S2/lk-jwt-as.yaml" "$WORK/s2.legacy-registration"
run_entry "$ENTRYPOINT" "$S2" "SYNAPSE_SECRETS_DIR=${S2}/sec"
check "switch: exits 0" test "$RC" = 0
check "switch: the inline MAS, macaroon, form and registration secrets are gone from homeserver.yaml" bash -c "
  ! grep -qF -e '$V_MAS' -e '$V_GEN_MAC' -e '$V_GEN_FORM' -e '$V_GEN_REG' '$S2/homeserver.yaml'"
check "switch: the old rendered lk-jwt-as.yaml is unlisted" bash -c "
  test \"\$(yq '[.app_service_config_files[] | select(. == \"$S2/lk-jwt-as.yaml\")] | length' '$S2/homeserver.yaml')\" = 0"
check "switch: the old rendered lk-jwt-as.yaml is left on disk untouched (the operator deletes it)" cmp "$WORK/s2.legacy-registration" "$S2/lk-jwt-as.yaml"
check "switch: the store registration is listed exactly once" bash -c "
  test \"\$(yq '[.app_service_config_files[] | select(. == \"$S2/sec/lk_jwt_as_registration.yaml\")] | length' '$S2/homeserver.yaml')\" = 1"
LAST_LOG="$LOG"
check "switch: the log names no value" bash -c "! grep -qF -e '$V_MAS' -e '$V_GEN_MAC' -e '$V_S_MAS' -e '$V_S_AS' '$LAST_LOG'"

echo "== store mode: settings"
new_dir s3; mkdir -p "$D/alt"
cp "$D/sec/mas_shared_secret" "$D/alt/mas.txt"; cp "$D/sec/lk_jwt_as_registration.yaml" "$D/alt/as-a.yaml"
# A second registration Synapse would accept: its own id, sender and tokens (two copies of one
# file are refused by Synapse itself, "Cannot reuse ID").
sed -e 's/^id: .*/id: second-service/' -e 's/^sender_localpart: .*/sender_localpart: _second_service/' \
  -e "s/^as_token: .*/as_token: \"$V_LKAS\"/" -e "s/^hs_token: .*/hs_token: \"$V_LKHS\"/" \
  "$D/sec/lk_jwt_as_registration.yaml" > "$D/alt/as-b.yaml"
chmod 0440 "$D/alt/as-b.yaml"     # a store file: the container user cannot write it
new_hs_fixture
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_MAS_SECRET_FILE=$D/alt/mas.txt" "SYNAPSE_APPSERVICE_FILES=$D/alt/as-a.yaml,$D/alt/as-b.yaml"
S3=$D
check "overrides: exits 0; the MAS file and two registration files are used" bash -c "
  test $RC = 0 &&
  test \"\$(yq '.matrix_authentication_service.secret_path' '$S3/homeserver.yaml')\" = '$S3/alt/mas.txt' &&
  test \"\$(yq '.app_service_config_files | length' '$S3/homeserver.yaml')\" = 3"
new_dir s4; new_hs_fixture; rm "$D/sec/lk_jwt_as_registration.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES="
check "no registration (SYNAPSE_APPSERVICE_FILES set empty): exits 0, only the foreign entry stays" bash -c "
  test $RC = 0 && test \"\$(yq '.app_service_config_files | length' '$D/homeserver.yaml')\" = 1"

echo "== store mode: refusals (nothing is written, no value is printed)"
refuses() { # refuses NAME EXPECTED_TEXT : RC != 0, the text is in the log, homeserver.yaml unchanged
  local name="$1" text="$2"
  if [ "$RC" != 0 ] && grep -qF -- "$text" "$LOG" && grep -q 'REFUSING TO START (secret store mode)' "$LOG" \
     && { [ ! -f "$D/homeserver.yaml" ] || cmp -s "$D/homeserver.yaml" "$D/.hs.before"; } \
     && ! has_value "$LOG"; then
    ok "$name"
  else
    bad "$name" "rc=$RC; expected: $text; log: $(head -c 300 "$LOG" | tr '\n' ' ')"
  fi
}
refuse_case() { # refuse_case NAME EXPECTED_TEXT [VAR=VAL ...] : fresh dir + fixture, one boot
  local name="$1" text="$2"; shift 2
  new_dir "r-${name//[^A-Za-z0-9]/_}"; new_hs_fixture; cp "$D/homeserver.yaml" "$D/.hs.before"
  run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "$@"
  refuses "$name" "$text"
}
DENY_LIST="OTHER,EXTRA_PASSWORD"; BAD_LIST="a-b"; GLOB_LIST="*"
for v in MAS_SHARED_SECRET LK_JWT_AS_TOKEN LK_JWT_HS_TOKEN SYNAPSE_REGISTRATION_SHARED_SECRET SYNAPSE_MACAROON_SECRET_KEY SIWEOIDC_SIGNING_KEY_PEM LIVEKIT_SECRET; do
  refuse_case "env $v is refused" "the environment variable $v is set" "$v=$V_LEAK"
done
refuse_case "env var that is set but empty is refused too" "the environment variable MAS_SHARED_SECRET is set" "MAS_SHARED_SECRET="
refuse_case "SYNAPSE_SECRET_ENV_DENY adds names" "the environment variable EXTRA_PASSWORD is set" "SYNAPSE_SECRET_ENV_DENY=${DENY_LIST}" "EXTRA_PASSWORD=$V_LEAK"
refuse_case "SYNAPSE_SECRET_ENV_DENY rejects a malformed entry" "not an environment variable name" "SYNAPSE_SECRET_ENV_DENY=${BAD_LIST}"
refuse_case "SYNAPSE_SECRET_ENV_DENY never globs" "not an environment variable name" "SYNAPSE_SECRET_ENV_DENY=${GLOB_LIST}"
refuse_case "SYNAPSE_APPSERVICE_FILES never globs" "SYNAPSE_APPSERVICE_FILES must be an absolute path" "SYNAPSE_APPSERVICE_FILES=/run/*.yaml"
refuse_case "running as root is refused" "the container runs as root" "FAKE_ID_ROOT=1"
refuse_case "UID in the environment is refused" "the environment variable UID is set" "UID=991"

new_dir r-rel; new_hs_fixture; cp "$D/homeserver.yaml" "$D/.hs.before"
REL_DIR=relative/dir
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${REL_DIR}"
refuses "a relative SYNAPSE_SECRETS_DIR is refused" "SYNAPSE_SECRETS_DIR must be an absolute directory path"

for f in mas_shared_secret macaroon_secret_key form_secret lk_jwt_as_registration.yaml; do
  new_dir "r-miss-$f"; new_hs_fixture; rm "$D/sec/$f"; cp "$D/homeserver.yaml" "$D/.hs.before"
  run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
  refuses "missing $f is refused and the file is named" "secret file $D/sec/$f"
  new_dir "r-empty-$f"; new_hs_fixture; chmod u+w "$D/sec/$f"; : > "$D/sec/$f"; chmod 0440 "$D/sec/$f"; cp "$D/homeserver.yaml" "$D/.hs.before"
  run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
  refuses "empty $f is refused and the file is named" "secret file $D/sec/$f"
done
new_dir r-dir; new_hs_fixture; rm "$D/sec/form_secret"; mkdir "$D/sec/form_secret"; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
refuses "a directory in place of a file is refused" "is not a regular file"
if true; then
  new_dir r-unreadable; new_hs_fixture; chmod 000 "$D/sec/macaroon_secret_key"; cp "$D/homeserver.yaml" "$D/.hs.before"
  run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
  refuses "an unreadable file is refused with owner, mode and group hint" "secret file $D/sec/macaroon_secret_key"
  check "the unreadable-file message names uid, gid and groups" grep -q 'not readable by uid' "$LOG"
  new_dir r-ro-hs; new_hs_fixture; chmod 0444 "$D/homeserver.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
  run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
  refuses "a homeserver.yaml the user cannot write is refused (yq -i would fail)" "homeserver.yaml is not writable"
  new_dir r-ro-data; new_hs_fixture; cp "$D/homeserver.yaml" "$D/.hs.before"; chmod 0555 "$D"
  run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
  chmod 0755 "$D"
  refuses "a data directory the user cannot write is refused" "is not writable by uid"
fi

echo "== store mode: inline secrets that --no-secrets-in-config does not check"
i=0
for spec in \
  "password_config.pepper|.password_config.pepper" \
  "email.smtp_pass|.email.smtp_pass" \
  "jwt_config.secret|.jwt_config.secret" \
  "turn_password|.turn_password" \
  "database.args.password|.database.args.password"; do
  i=$((i+1)); name="${spec%%|*}"; key="${spec#*|}"
  new_dir "r-inline-$i"; new_hs_fixture
  K="$key" V="$V_LEAK" yqv -i 'eval(strenv(K)) = strenv(V)' "$D/homeserver.yaml"
  cp "$D/homeserver.yaml" "$D/.hs.before"
  run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
  # Refused before anything is written: the file is unchanged.
  if [ "$RC" != 0 ] && grep -qF -- "inline secret at ${key}" "$LOG" && ! has_value "$LOG" && cmp -s "$D/homeserver.yaml" "$D/.hs.before"; then ok "inline $name is refused and named, value not printed"; else bad "inline $name is refused and named" "rc=$RC $(head -c 300 "$LOG" | tr '\n' ' ')"; fi
done
new_dir r-inline-oidc; new_hs_fixture
V="$V_LEAK" yqv -i '.oidc_providers = [{"idp_id": "a", "client_secret": strenv(V)}]' "$D/homeserver.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
if [ "$RC" != 0 ] && grep -qF 'inline secret at .oidc_providers[].client_secret' "$LOG" && ! has_value "$LOG"; then ok "inline oidc_providers[].client_secret is refused and named, value not printed"; else bad "inline oidc client_secret is refused" "rc=$RC"; fi
new_dir r-inline-empty; new_hs_fixture
yqv -i '.password_config.pepper = ""' "$D/homeserver.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
check "an empty pepper is not a secret: exits 0" test "$RC" = 0

echo "== audit (PR #73): cases the first version missed"
# AUD-1: `read` stops at the first newline, so a deny entry on a second line is never checked.
NL_LIST="$(printf 'OTHER\nEXTRA_PASSWORD')"
refuse_case "AUD-1 SYNAPSE_SECRET_ENV_DENY on two lines checks both" "the environment variable EXTRA_PASSWORD is set" "SYNAPSE_SECRET_ENV_DENY=${NL_LIST}" "EXTRA_PASSWORD=$V_LEAK"
# AUD-2: a compose file that keeps `env_file: .env` passes every secret of that file. The
# fixed list names seven; a secret-shaped name outside it (one the dev compose reads from .env)
# must be refused too, while the store mode's own *_FILE / *_DIR / *_DENY settings pass.
refuse_case "AUD-2 a secret-shaped variable outside the fixed list is refused" "the environment variable AQUA_MAIL_WEBMAIL_CLIENT_SECRET is set" "AQUA_MAIL_WEBMAIL_CLIENT_SECRET=$V_LEAK"
# AUD-3: two registrations with the same as_token. Synapse refuses them with an error that
# prints the token (synapse/config/appservice.py, "Cannot reuse as_token"); the entrypoint
# must refuse first, naming the files, never the token.
new_dir r-dup-token; new_hs_fixture; cp "$D/homeserver.yaml" "$D/.hs.before"
sed -e 's/^id: lk-jwt-service$/id: call-control/' -e 's/^sender_localpart: .*/sender_localpart: _call_control/' \
  -e "s/^hs_token: .*/hs_token: \"$V_LKHS\"/" "$D/sec/lk_jwt_as_registration.yaml" > "$D/sec/cc.yaml"; chmod 0440 "$D/sec/cc.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES=$D/sec/lk_jwt_as_registration.yaml,$D/sec/cc.yaml"
refuses "AUD-3 two registrations with one as_token are refused before Synapse prints the token" "as_token"
# AUD-4: rolling the switch back (mode off on a config a store-mode boot wrote). apply_mas_config
# writes `secret` next to the `secret_path` store mode left; Synapse's MasConfigModel refuses
# both, and its pydantic error repeats the whole block as input_value, the secret included.
new_dir s-rollback
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
test "$RC" = 0 || bad "AUD-4 seed: the store-mode boot exits 0" "rc=$RC"
run_entry "$ENTRYPOINT" "$D" "${NOSTORE_ENV[@]}"
check "AUD-4 mode off after store mode: matrix_authentication_service never holds both secret and secret_path" \
  test "$(yqv '.matrix_authentication_service | (has("secret") and has("secret_path"))' "$D/homeserver.yaml")" = false
# AUD-5: the switch leaves the old rendered registration (both tokens, readable by Synapse) on
# the volume by design; the boot must at least say so, naming the file, so the operator's
# "delete the old copies" step is not forgotten.
check "AUD-5 switch: the log names the left-over /data/lk-jwt-as.yaml" grep -qF "$S2/lk-jwt-as.yaml" "$LAST_LOG"
# AUD-6: a file holding only whitespace passes `-s`, and Synapse strips it to "": the macaroon
# key then silently falls back to one derived from the signing key (synapse/config/key.py).
new_dir r-blank; new_hs_fixture; chmod u+w "$D/sec/macaroon_secret_key"; printf '\n' > "$D/sec/macaroon_secret_key"; chmod 0440 "$D/sec/macaroon_secret_key"; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
refuses "AUD-6 a secret file holding only whitespace is refused like an empty one" "secret file $D/sec/macaroon_secret_key"
check "AUD-6 the refusal says whitespace (not a permission or emptiness refusal)" grep -q 'holds nothing but whitespace' "$LOG"
# AUD-7: inline secrets Synapse 1.163 reads that neither its flag nor SS_INLINE_KEYS checks.
i=0
for key in '.oidc_config.client_secret' '.databases.main.args.password'; do
  i=$((i+1)); new_dir "r-aud7-$i"; new_hs_fixture
  K="$key" V="$V_LEAK" yqv -i 'eval(strenv(K)) = strenv(V)' "$D/homeserver.yaml"
  run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
  if [ "$RC" != 0 ] && grep -qF -- "inline secret at" "$LOG" && ! has_value "$LOG"; then ok "AUD-7 inline $key is refused"; else bad "AUD-7 inline $key is refused" "rc=$RC"; fi
done
new_dir r-aud7-jwtkey; new_hs_fixture
V="$V_LEAK" yqv -i '.oidc_providers = [{"idp_id": "a", "client_secret_jwt_key": {"key": strenv(V), "jwt_header": {"alg": "ES256"}}}]' "$D/homeserver.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
if [ "$RC" != 0 ] && grep -qF -- "inline secret at" "$LOG" && ! has_value "$LOG"; then ok "AUD-7 inline oidc_providers[].client_secret_jwt_key.key is refused"; else bad "AUD-7 inline oidc_providers[].client_secret_jwt_key.key is refused" "rc=$RC"; fi
# AUD-8: a secret file the container user can write is not a read-only store mount (for
# example SYNAPSE_MAS_SECRET_FILE pointed into the data volume).
new_dir r-writable; new_hs_fixture; chmod 0640 "$D/sec/mas_shared_secret"; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
refuses "AUD-8 a secret file writable by the container user is refused" "secret file $D/sec/mas_shared_secret"
# AUD-10: the entries store mode adds are never taken out again. Dropping the registration
# (SYNAPSE_APPSERVICE_FILES set empty) or moving it to a new file name leaves the old store path
# listed: Synapse then loads a registration the operator removed, or fails on a file that is no
# longer mounted, or refuses two files with one id.
new_dir s-unlist
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
test "$RC" = 0 || bad "AUD-10 seed: the store-mode boot exits 0" "rc=$RC"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES="
check "AUD-10 SYNAPSE_APPSERVICE_FILES set empty unlists the registration an earlier store boot listed" \
  test "$(yqv '[(.app_service_config_files // [])[] | select(. == "'"$D"'/sec/lk_jwt_as_registration.yaml")] | length' "$D/homeserver.yaml")" = 0
cp "$D/sec/lk_jwt_as_registration.yaml" "$D/sec/lk_jwt_as_registration-2.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES=$D/sec/lk_jwt_as_registration-2.yaml"
check "AUD-10 a renamed registration file replaces the old entry (one entry with id lk-jwt-service)" \
  test "$(yqv '.app_service_config_files | length' "$D/homeserver.yaml")" = 1

echo "== audit (PR #73): the fixes, further cases"
second_registration() { # second_registration DEST : a valid registration with its own id, sender and tokens, read-only
  sed -e 's/^id: .*/id: second-service/' -e 's/^sender_localpart: .*/sender_localpart: _second_service/' \
    -e "s/^as_token: .*/as_token: \"$V_LKAS\"/" -e "s/^hs_token: .*/hs_token: \"$V_LKHS\"/" \
    "$D/sec/lk_jwt_as_registration.yaml" > "$1"
  chmod 0440 "$1"
}
# AUD-1: the whole SYNAPSE_APPSERVICE_FILES value is read, a newline separates.
new_dir r-nl-files; new_hs_fixture; second_registration "$D/sec/second.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES=$(printf '%s\n%s' "$D/sec/lk_jwt_as_registration.yaml" "$D/sec/second.yaml")"
check "AUD-1 SYNAPSE_APPSERVICE_FILES on two lines lists both files" bash -c "
  test $RC = 0 && test \"\$(yq '.app_service_config_files | length' '$D/homeserver.yaml')\" = 3"
new_dir r-nl-bad; new_hs_fixture; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES=$(printf '%s\n%s' "$D/sec/lk_jwt_as_registration.yaml" "/run/*.yaml")"
refuses "AUD-1 a bad entry on the second line of SYNAPSE_APPSERVICE_FILES is refused" "SYNAPSE_APPSERVICE_FILES must be an absolute path"

# AUD-2: any secret-looking name, any URL with a password, in any variable.
refuse_case "AUD-2 the name check is case-insensitive" "the environment variable my_api_key is set" "my_api_key=$V_LEAK"
refuse_case "AUD-2 a name bash cannot import is seen too" "the environment variable a.b_PASSWORD is set" "a.b_PASSWORD=$V_LEAK"
refuse_case "AUD-2 a secret-shaped name that is set but empty is refused" "the environment variable SOME_SERVICE_TOKEN is set" "SOME_SERVICE_TOKEN="
# The URLs are assembled from parts and the generated value (a literal would read as a committed password).
url_with_password() { printf '%s' "$1" : // "$2" : "$3" @ "$4"; }   # SCHEME USER PASSWORD HOST-AND-PATH
refuse_case "AUD-2 a URL with a password in any variable is refused" "the environment variable UPSTREAM_DSN is set to a URL that carries a password" "UPSTREAM_DSN=$(url_with_password postgres synapse "$V_LEAK" db.example.org/synapse)"
refuse_case "AUD-2 a URL with a password and no user is refused" "the environment variable CACHE_URL is set to a URL that carries a password" "CACHE_URL=$(url_with_password redis '' "$V_LEAK" cache.example.org)"
refuse_case "AUD-2 a variable with the word PEM in its name is refused" "the environment variable TLS_CERT_PEM is set" "TLS_CERT_PEM=$V_LEAK"
new_dir r-ok-env; new_hs_fixture
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "UPSTREAM_URL=https://deploy@example.org/repo" "OTHER_URL=https://example.org:8448/x@y" \
  "GIT_URL=https://deploy@example.org@git.example.org/repo" "GIT_URL_PORT=https://deploy@example.org@git.example.org:8443/repo" "PORT_URL=https://deploy@example.org:8443/x@y" \
  "SYNAPSE_SERVER_NAME=example.org" "SYNAPSE_REPORT_STATS=no" "MATRIX_RETENTION_ENABLED=false" "SYNAPSE_SECRET_ENV_DENY=${DENY_LIST}"
check "AUD-2 non-secret names, URLs without a password (also with an at sign in the user name) and the store settings pass" test "$RC" = 0

# AUD-3: the same id; the same as_token as a registration that stays listed; the realistic
# switch, where the registration file keeps the tokens the legacy rendered file already has.
new_dir r-dup-id; new_hs_fixture; second_registration "$D/sec/second.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
sed -i 's/^id: .*/id: lk-jwt-service/' "$D/sec/second.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES=$D/sec/lk_jwt_as_registration.yaml,$D/sec/second.yaml"
refuses "AUD-3 two registrations with one id are refused, the files named" "have the same id"
new_dir r-dup-hs; new_hs_fixture; second_registration "$D/sec/second.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
sed -i "s/^hs_token: .*/hs_token: \"$V_S_HS\"/" "$D/sec/second.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES=$D/sec/lk_jwt_as_registration.yaml,$D/sec/second.yaml"
refuses "AUD-3 two registrations with one hs_token are refused" "have the same hs_token"
new_dir r-dup-cross; new_hs_fixture; second_registration "$D/sec/second.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
sed -i "s/^hs_token: .*/hs_token: \"$V_S_AS\"/" "$D/sec/second.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES=$D/sec/lk_jwt_as_registration.yaml,$D/sec/second.yaml"
refuses "AUD-3 the as_token of one registration as the hs_token of another is refused" "is the as_token of"
new_dir r-dup-foreign; new_hs_fixture; second_registration "$D/other-as.yaml"
sed -i "s/^as_token: .*/as_token: \"$V_S_AS\"/" "$D/other-as.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
refuses "AUD-3 a registration already listed in the config with the same as_token is refused" "have the same as_token"
new_dir r-dup-bad; new_hs_fixture; printf 'id: x\n' > "$D/sec/second.yaml"; chmod 0440 "$D/sec/second.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES=$D/sec/second.yaml"
refuses "AUD-3 a registration without as_token and hs_token is refused" "is not a registration Synapse can load"
new_dir s-keep-tokens
run_entry "$ENTRYPOINT" "$D" "MAS_SHARED_SECRET=$V_MAS" "LK_JWT_AS_TOKEN=$V_S_AS" "LK_JWT_HS_TOKEN=$V_S_HS"
test "$RC" = 0 || bad "AUD-3 seed: the mode-off boot with the store's tokens exits 0" "rc=$RC"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
check "AUD-3 the switch with the SAME tokens in the store file and the old rendered file: exits 0, only the store file is listed" bash -c "
  test $RC = 0 &&
  test \"\$(yq '[.app_service_config_files[] | select(. == \"$D/lk-jwt-as.yaml\")] | length' '$D/homeserver.yaml')\" = 0 &&
  test \"\$(yq '[.app_service_config_files[] | select(. == \"$D/sec/lk_jwt_as_registration.yaml\")] | length' '$D/homeserver.yaml')\" = 1"

# AUD-4: the refusal when the mode is off on a config the store mode wrote.
new_dir s-rollback-2
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
test "$RC" = 0 || bad "AUD-4 seed: the store-mode boot exits 0" "rc=$RC"
cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "${NOSTORE_ENV[@]}"
refuses "AUD-4 mode off on a store-mode config is refused, nothing written" "matrix_authentication_service.secret_path"
check "AUD-4 the refusal says to fix forward" grep -q 'fix forward' "$LOG"
for k in macaroon_secret_key_path form_secret_path; do
  new_dir "r-off-$k"; new_hs_fixture; K=".$k" yqv -i 'eval(strenv(K)) = "/run/secrets/x"' "$D/homeserver.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
  run_entry "$ENTRYPOINT" "$D" "${NOSTORE_ENV[@]}"
  refuses "AUD-4 mode off with $k set is refused" "has .$k"
done

# AUD-5: no left-over line when there is none.
check "AUD-5 no left-over line on a first boot" bash -c "! grep -q 'left over' '$S1LOG'"

# AUD-6: the shapes of whitespace, and the accepted ones.
i=0
for fmt in ' %s\n' '%s \n' '%s\n\n' '%s\r\n' '%s\t' '\n%s\n'; do
  i=$((i+1)); new_dir "r-ws-$i"; new_hs_fixture
  chmod u+w "$D/sec/form_secret"; printf "$fmt" "$V_S_FORM" > "$D/sec/form_secret"; chmod 0440 "$D/sec/form_secret"
  cp "$D/homeserver.yaml" "$D/.hs.before"
  run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
  refuses "AUD-6 whitespace shape $i around a secret value is refused" "secret file $D/sec/form_secret"
  check "AUD-6 shape $i: the message says leading or trailing whitespace" grep -q 'has leading or trailing whitespace' "$LOG"
done
all_printable() { # every byte from 0x21 to 0x7e, once, in order (built at run time)
  local c; for ((c=33; c<=126; c++)); do printf '%b' "\\0$(printf '%03o' "$c")"; done
}
new_dir r-ws-ok; new_hs_fixture
chmod u+w "$D/sec/form_secret" "$D/sec/macaroon_secret_key"
printf '%s' "$V_S_FORM" > "$D/sec/form_secret"                  # no final newline
printf '%s%s\n' "$(all_printable)" "$V_S_MAC" > "$D/sec/macaroon_secret_key"   # F2: the whole printable range, both ends included
chmod 0440 "$D/sec/form_secret" "$D/sec/macaroon_secret_key"
# A registration is YAML: blank lines, spaces and non-ASCII text in it are fine (F2 narrows the three raw values only).
chmod u+w "$D/sec/lk_jwt_as_registration.yaml"; printf '\n\n# caf\xc3\xa9 and some spaces\n\n' >> "$D/sec/lk_jwt_as_registration.yaml"; chmod 0440 "$D/sec/lk_jwt_as_registration.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
check "AUD-6 no final newline, every printable ASCII byte in a raw value, and blank lines, spaces and non-ASCII text in a registration pass" test "$RC" = 0

# AUD-9: an unwritable TMPDIR.
new_dir r-tmpdir; new_hs_fixture; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "TMPDIR=$D/no-such-dir"
refuses "AUD-9 an unwritable TMPDIR is refused and named" "$D/no-such-dir is not a writable directory"

# SYNAPSE_CONFIG_DIR / SYNAPSE_CONFIG_PATH: only the config this script secures.
refuse_case "a SYNAPSE_CONFIG_DIR other than /data is refused" "SYNAPSE_CONFIG_DIR is set to something other than" "SYNAPSE_CONFIG_DIR=/etc/synapse"
refuse_case "a SYNAPSE_CONFIG_PATH other than /data/homeserver.yaml is refused" "SYNAPSE_CONFIG_PATH is set to something other than" "SYNAPSE_CONFIG_PATH=/etc/synapse/other.yaml"
new_dir r-cfg-ok; new_hs_fixture
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_CONFIG_DIR=$D" "SYNAPSE_CONFIG_PATH=$D/homeserver.yaml"
check "SYNAPSE_CONFIG_DIR and SYNAPSE_CONFIG_PATH naming /data and its config pass" test "$RC" = 0

# AUD-10: a foreign entry stays, the store's own entry goes.
new_dir s-unlist-2; new_hs_fixture
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
test "$RC" = 0 || bad "AUD-10 seed: the store-mode boot exits 0" "rc=$RC"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES="
check "AUD-10 the foreign entry stays, the store entry goes, and the log says which" bash -c "
  test $RC = 0 &&
  test \"\$(yq '.app_service_config_files | length' '$D/homeserver.yaml')\" = 1 &&
  test \"\$(yq '.app_service_config_files[0]' '$D/homeserver.yaml')\" = '$D/other-as.yaml' &&
  grep -qF '$D/sec/lk_jwt_as_registration.yaml is no longer in SYNAPSE_APPSERVICE_FILES' '$LOG'"

echo "== re-review of PR #73 (F1 to F4): each case below failed on the version before its fix"
add_listed() { # add_listed ENTRY : list one more registration in the existing config of $D
  P="$1" yqv -i '.app_service_config_files += [strenv(P)]' "$D/homeserver.yaml"
}

# F1: an entry the config already lists that is not a safe path, or not a readable regular file, was
# skipped by the duplicate check. A skipped registration can share its as_token with a store file, and
# Synapse's own error for that prints the token. Refused now, by (sanitized) name.
new_dir f1-unsafe; new_hs_fixture; second_registration "$D/other as.yaml"
sed -i "s/^as_token: .*/as_token: \"$V_S_AS\"/" "$D/other as.yaml"; add_listed "$D/other as.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
refuses "F1 a listed registration whose path is not a safe path is refused, not skipped (here it shares an as_token with a store file)" "$D/other?as.yaml"
new_dir f1-relative; new_hs_fixture; add_listed "relative/as.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
refuses "F1 a listed registration with a relative path is refused" "relative/as.yaml"
new_dir f1-missing; new_hs_fixture; add_listed "$D/gone-as.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
refuses "F1 a listed registration whose file does not exist is refused" "$D/gone-as.yaml"
new_dir f1-unreadable; new_hs_fixture; chmod 000 "$D/other-as.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
refuses "F1 a listed registration the container user cannot read is refused" "$D/other-as.yaml"
new_dir f1-dir; new_hs_fixture; rm "$D/other-as.yaml"; mkdir "$D/other-as.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
refuses "F1 a listed registration that is a directory is refused" "$D/other-as.yaml"
check "F1 the refusal says what to do (fix the entry or remove it)" grep -q 'Fix the entry or remove it' "$LOG"
# The entries this mode itself replaces or unlists need no file: the legacy rendered registration and
# the store directory's own entries.
new_dir f1-own; new_hs_fixture; add_listed "$D/lk-jwt-as.yaml"; add_listed "$D/sec/removed-as.yaml"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
check "F1 the legacy registration and a removed store entry may be listed without a file: exit 0, both are gone" bash -c "
  test $RC = 0 &&
  test \"\$(yq '[.app_service_config_files[] | select(. == \"$D/lk-jwt-as.yaml\" or . == \"$D/sec/removed-as.yaml\")] | length' '$D/homeserver.yaml')\" = 0 &&
  test \"\$(yq '[.app_service_config_files[] | select(. == \"$D/other-as.yaml\")] | length' '$D/homeserver.yaml')\" = 1"

# F2: the three raw values (MAS, macaroon, form) are refused when any byte, a final newline apart, is
# outside printable ASCII 0x21 to 0x7e: a space, a control byte, DEL or a byte of 0x80 and up inside the
# value would be read differently by Synapse (which strips it, and decodes it as UTF-8) and by the
# other consumer of the value (which sends it as a header or compares bytes).
declare -A RAW_WHAT=([mas_shared_secret]=SYNAPSE_MAS_SECRET_FILE [macaroon_secret_key]=SYNAPSE_MACAROON_SECRET_FILE [form_secret]=SYNAPSE_FORM_SECRET_FILE)
F2_SHAPES=('%s %s\n' '%s\t%s\n' '%s\r%s\n' '%s\n%s\n' '%s\x01%s\n' '%s\x7f%s\n' '%s\xc3\xa9%s\n' '%s\xff%s\n' '%s\x00%s\n' '%s%s\xc3\xa9')
for f in mas_shared_secret macaroon_secret_key form_secret; do
  i=0
  for fmt in "${F2_SHAPES[@]}"; do
    i=$((i+1)); new_dir "f2-$f-$i"; new_hs_fixture
    chmod u+w "$D/sec/$f"; printf "$fmt" "${V_S_MAC:0:20}" "${V_S_MAC:20}" > "$D/sec/$f"; chmod 0440 "$D/sec/$f"
    cp "$D/homeserver.yaml" "$D/.hs.before"
    run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
    refuses "F2 $f: byte shape $i outside printable ASCII is refused" "secret file $D/sec/$f (${RAW_WHAT[$f]}) holds a byte outside printable ASCII"
  done
done
new_dir f2-reg-blank; new_hs_fixture; chmod u+w "$D/sec/lk_jwt_as_registration.yaml"; printf '\n \n\t\n' > "$D/sec/lk_jwt_as_registration.yaml"; chmod 0440 "$D/sec/lk_jwt_as_registration.yaml"
cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"
refuses "F2 a registration holding only whitespace is still refused (the non-blank rule stays)" "secret file $D/sec/lk_jwt_as_registration.yaml"
check "F2 the registration refusal is the whitespace one" grep -q 'holds nothing but whitespace' "$LOG"

# F3: the user name of a URL may hold an at sign; the userinfo ends at the last one before the host.
refuse_case "F3 a URL whose user name holds an at sign and that has a password is refused" "the environment variable UPSTREAM_DSN is set to a URL that carries a password" "UPSTREAM_DSN=$(url_with_password postgres 'synapse@example.org' "$V_LEAK" db.example.org/synapse)"
refuse_case "F3 a password that holds an at sign is refused" "the environment variable UPSTREAM_DSN is set to a URL that carries a password" "UPSTREAM_DSN=$(url_with_password postgres synapse "x@${V_LEAK}" db.example.org/synapse)"
refuse_case "F3 an at sign in the user name and in the password is refused" "the environment variable UPSTREAM_DSN is set to a URL that carries a password" "UPSTREAM_DSN=$(url_with_password postgres 'synapse@example.org' "x@${V_LEAK}" db.example.org/synapse)"

# F4: a read-only mount is not enough on its own to keep the container user from the secret. The owner
# of a file can change its mode, and a directory the user can write lets it replace the file.
new_dir f4-owner; new_hs_fixture; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "FAKE_ID_UID=$REAL_UID"
refuses "F4 a secret file owned by the container user is refused" "secret file $D/sec/mas_shared_secret (SYNAPSE_MAS_SECRET_FILE) is owned by uid $REAL_UID"
new_dir f4-dir; new_hs_fixture; cp "$D/homeserver.yaml" "$D/.hs.before"
WRITABLE_DIRS="$D/sec"; run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec"; WRITABLE_DIRS=""
refuses "F4 a secret file in a directory the container user can write is refused" "secret file $D/sec/mas_shared_secret (SYNAPSE_MAS_SECRET_FILE) sits in the directory $D/sec, which is writable by uid"
new_dir f4-alt; new_hs_fixture; mkdir "$D/alt"; cp "$D/sec/mas_shared_secret" "$D/alt/mas.txt"; cp "$D/homeserver.yaml" "$D/.hs.before"
WRITABLE_DIRS="$D/alt"; run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_MAS_SECRET_FILE=$D/alt/mas.txt"; WRITABLE_DIRS=""
refuses "F4 the directory of an overridden secret file is judged too (the store directory is read-only, this one is not)" "sits in the directory $D/alt"
new_dir f4-reg-dir; new_hs_fixture; mkdir "$D/alt"; cp "$D/sec/lk_jwt_as_registration.yaml" "$D/alt/as.yaml"; cp "$D/homeserver.yaml" "$D/.hs.before"
WRITABLE_DIRS="$D/alt"; run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_APPSERVICE_FILES=$D/alt/as.yaml"; WRITABLE_DIRS=""
refuses "F4 a registration file in a writable directory is refused too" "sits in the directory $D/alt"
new_dir f4-link; new_hs_fixture; mkdir "$D/rw"; cp "$D/sec/mas_shared_secret" "$D/rw/mas"; ln -s "$D/rw/mas" "$D/sec/mas-link"; cp "$D/homeserver.yaml" "$D/.hs.before"
run_entry "$ENTRYPOINT" "$D" "SYNAPSE_SECRETS_DIR=${D}/sec" "SYNAPSE_MAS_SECRET_FILE=$D/sec/mas-link"
refuses "F4 a link in a read-only directory to a file in a writable one is refused (the resolved directory is judged)" "sits in the directory $D/rw"
check "F4 the refusals say what to do (read-only mount, no write permission for the container user)" grep -q 'read-only' "$LOG"

echo "== no value anywhere"
LEAKS=0
for l in "$RUNDIR"/out.*.log "$WORK"/new/*.log "$WORK"/old/*.log; do
  [ -e "$l" ] || continue
  # A refusal case puts V_LEAK into the environment on purpose; it must still not be printed.
  if has_value "$l"; then echo "value in $l" >&2; LEAKS=$((LEAKS+1)); fi
done
check "no log of any boot contains a throwaway value" test "$LEAKS" = 0

echo
echo "passed: $PASS   failed: $FAILN"
[ "$FAILN" = 0 ]
