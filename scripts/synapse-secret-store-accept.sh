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
ALL_VALUES=("$V_MAS" "$V_LKAS" "$V_LKHS" "$V_GEN_REG" "$V_GEN_MAC" "$V_GEN_FORM" "$V_S_MAS" "$V_S_MAC" "$V_S_FORM" "$V_S_AS" "$V_S_HS" "$V_LEAK")

# --- stand-ins on PATH and PYTHONPATH --------------------------------------------------
FAKEBIN="$WORK/fakebin"; mkdir -p "$FAKEBIN"
# id: `id -u` answers 0 when FAKE_ID_ROOT=1, to reach the root refusal without being root.
cat > "$FAKEBIN/id" <<FAKE
#!/usr/bin/env bash
if [ "\${FAKE_ID_ROOT:-}" = 1 ] && [ "\${1:-}" = "-u" ]; then echo 0; exit 0; fi
exec "$REAL_ID" "\$@"
FAKE
chmod +x "$FAKEBIN/id"

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
run_entry() {
  local entry="$1" d="$2"; shift 2
  RUNN=$((RUNN+1))
  prepare_entry "$entry" "$RUNDIR/entry.$RUNN.sh" "$d"
  LOG="$RUNDIR/out.$RUNN.log"
  env -i PATH="$FAKEBIN:$YQ_DIR:/usr/local/bin:/usr/bin:/bin" HOME="$d" \
    PYTHONPATH="$FAKEPKG" ACCEPT_DATA="$d" \
    ACCEPT_GEN_REG="$V_GEN_REG" ACCEPT_GEN_MAC="$V_GEN_MAC" ACCEPT_GEN_FORM="$V_GEN_FORM" \
    MATRIX_HOST=example.org MATRIX_BASE_URL=https://example.org MATRIX_PORT=8008 \
    SIWEOIDC_BASE_URL=https://auth.example.org MATRIX_MESSAGE_LIFETIME=4w \
    "$@" bash "$RUNDIR/entry.$RUNN.sh" > "$LOG" 2>&1
  RC=$?
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

# new_hs_fixture : a plain homeserver.yaml in $D (an existing deployment), no secrets.
new_hs_fixture() {
  cat > "$D/homeserver.yaml" <<EOF
server_name: "example.org"
public_baseurl: https://example.org/
app_service_config_files:
  - $D/other-as.yaml
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
cp "$D/sec/mas_shared_secret" "$D/alt/mas.txt"; cp "$D/sec/lk_jwt_as_registration.yaml" "$D/alt/as-a.yaml"; cp "$D/sec/lk_jwt_as_registration.yaml" "$D/alt/as-b.yaml"
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
  new_dir "r-empty-$f"; new_hs_fixture; chmod u+w "$D/sec/$f"; : > "$D/sec/$f"; cp "$D/homeserver.yaml" "$D/.hs.before"
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
