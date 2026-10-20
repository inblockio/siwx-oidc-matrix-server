#!/usr/bin/env bash
#
# synapse-secret-store-e2e.sh: the secret store mode of the Synapse image, end to end,
# in containers (docs/synapse-secret-files.md). Companion of
# scripts/synapse-secret-store-accept.sh, which tests the entrypoint's logic without a
# runtime; this one proves what only a real image can:
#
#   1. the entrypoint's `yq -i` on the config works when the container runs as 991:991
#      (no gosu privilege drop), on a first boot that also runs `/start.py generate`;
#   2. a secret file that is readable only through its GROUP (mode 0440, owner root,
#      groups unrelated to 991) is readable once the container gets that group with
#      `group_add`, and is NOT readable without it (negative control);
#   3. a real Synapse reaches "Synapse now listening" and /health answers 200, with the
#      secrets read from files; the MAS shared secret read from its file is the one Synapse
#      accepts on /_synapse/mas/* (a wrong value is refused);
#   4. Synapse runs with --no-secrets-in-config, and an inline secret in a copy of the
#      config stops it (and does not without the flag);
#   5. no secret is in the container's environment, its logs or its data volume;
#   6. the refusals that need a runtime: a root container, a homeserver.yaml owned by
#      another uid, a secret file the container user (991) owns, a secret directory it
#      can write;
#   7. without the store variable the same image starts as it always did (root, gosu,
#      secrets in the environment, no flag).
#
# Everything is throwaway: public image, generated values, `--network none`, named
# volumes removed at the end. It prints exit codes and the entrypoint's own log lines,
# never the content of a file.
#
# Usage:  scripts/synapse-secret-store-e2e.sh --image IMAGE
# Env:    RT   container runtime (default: docker, else podman)
#
# Exit code: non-zero if any check FAILs.

set -uo pipefail

IMAGE=""
case "${1:-}" in
  --image) IMAGE="${2:-}" ;;
  -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
[ -n "$IMAGE" ] || { echo "usage: $0 --image IMAGE" >&2; exit 2; }
RT="${RT:-$(command -v docker || command -v podman)}" || { echo "need docker or podman" >&2; exit 2; }
command -v python3 >/dev/null || { echo "need python3" >&2; exit 2; }

P="p2e-$$-$RANDOM"
T="${XDG_CACHE_HOME:-$HOME/.cache}/siwx-synapse-secret-store-e2e/$P"   # logs of this run, on disk, never tmpfs
mkdir -p "$T"
CTRS=()
cleanup() {
  local c v
  rm -rf "$T"
  for c in "${CTRS[@]:-}"; do [ -z "$c" ] || "$RT" rm -f "$c" >/dev/null 2>&1; done
  # By name prefix: vol() runs in a command substitution, so it cannot extend an array here.
  for v in $("$RT" volume ls -q 2>/dev/null | grep "^${P}-"); do "$RT" volume rm -f "$v" >/dev/null 2>&1; done
}
trap cleanup EXIT

PASS=0; FAILN=0
ok()  { echo "PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $1${2:+ -- $2}"; FAILN=$((FAILN+1)); }
note() { echo "      $*"; }
rnd() { python3 -c 'import secrets; print(secrets.token_hex(24))'; }

V_MAS="$(rnd)"; V_MAC="$(rnd)"; V_FORM="$(rnd)"; V_AS="$(rnd)"; V_HS="$(rnd)"      # the store
V_NMAS="$(rnd)"; V_NAS="$(rnd)"; V_NHS="$(rnd)"                                    # mode off
V_LEAK="$(rnd)"; V_WRONG="$(rnd)"
VALUES=("$V_MAS" "$V_MAC" "$V_FORM" "$V_AS" "$V_HS" "$V_NMAS" "$V_NAS" "$V_NHS" "$V_LEAK" "$V_WRONG")
leaks_in() { # leaks_in FILE : a throwaway value is in the file
  local v; for v in "${VALUES[@]}"; do grep -qF -- "$v" "$1" && return 0; done; return 1
}

vol() { local v="$P-$1"; "$RT" volume create "$v" >/dev/null; echo "$v"; }
# helper IMG-as-root with the given mounts; stdin script via -c
helper() { "$RT" run --rm --network none --user 0 --entrypoint sh "$@"; }

SERVER=store.example.org
COMMON_ENV=(-e "SYNAPSE_SERVER_NAME=$SERVER" -e SYNAPSE_REPORT_STATS=no -e "MATRIX_HOST=$SERVER"
  -e "MATRIX_BASE_URL=http://$SERVER" -e MATRIX_PORT=8008 -e SIWEOIDC_BASE_URL=http://127.0.0.1:9)
GROUPS_ADD=(--group-add 5001 --group-add 5002 --group-add 5003)

wait_listening() { # wait_listening CONTAINER SECONDS : "Synapse now listening" appears; false if the container ends or time runs out
  local end=$((SECONDS + $2)) out
  while [ "$SECONDS" -lt "$end" ]; do
    out="$("$RT" logs "$1" 2>&1)"
    case "$out" in *"Synapse now listening on TCP port 8008"*) return 0 ;; esac
    [ "$("$RT" inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ] || return 1
    sleep 2
  done
  return 1
}

# --- the store: group-only readable files in a volume ---------------------------------------
SEC="$(vol sec)"
SETUP="$(cat <<'SETUPEOF'
set -e
cd /sec
printf "%s\n" "$V_MAS" > mas_shared_secret
printf "%s\n" "$V_MAC" > macaroon_secret_key
printf "%s\n" "$V_FORM" > form_secret
cat > lk_jwt_as_registration.yaml <<'EOF'
id: lk-jwt-service
as_token: "${V_AS}"
hs_token: "${V_HS}"
sender_localpart: _lk_jwt_service
url: null
namespaces:
  users:
    - exclusive: false
      regex: '^@[^:]+:store\.example\.org$'
io.element.msc4502.scopes:
  - "urn:matrix:client:io.element.msc4502:rooms:is_joined"
EOF
# The quoted heredoc above left the two ${...} references literal; fill them in.
sed -i "s/\${V_AS}/$V_AS/; s/\${V_HS}/$V_HS/" lk_jwt_as_registration.yaml
chown 0:5001 mas_shared_secret
chown 0:5002 macaroon_secret_key form_secret
chown 0:5003 lk_jwt_as_registration.yaml
chmod 0440 mas_shared_secret macaroon_secret_key form_secret lk_jwt_as_registration.yaml
chmod 0711 /sec
SETUPEOF
)"
helper -v "$SEC":/sec -e V_MAS="$V_MAS" -e V_MAC="$V_MAC" -e V_FORM="$V_FORM" -e V_AS="$V_AS" -e V_HS="$V_HS" "$IMAGE" -c "$SETUP" >/dev/null 2>&1 && ok "store volume: four files, owner root, groups 5001/5002/5003 (none is 991), mode 0440, directory 0711" || bad "store volume setup"

# A data volume owned by 991. It is made non-empty on purpose: the image declares /data as a
# volume, and a runtime copies the image's own /data (owned by root) into an EMPTY named
# volume at every mount, which would undo the chown.
chowned_data() {
  local v; v="$(vol "$1")"
  helper -v "$v":/data "$IMAGE" -c 'touch /data/.keep && chown 991:991 /data /data/.keep' >/dev/null 2>&1
  echo "$v"
}

STORE_RUN=(--network none --user 991:991 "${GROUPS_ADD[@]}" -v "$SEC":/run/secrets:ro)

# =================================================================================================
echo "== A. store mode, first boot, user 991:991, group_add (real Synapse)"
DATA_A="$(chowned_data data-a)"
A="$P-a"; CTRS+=("$A")
"$RT" run -d --name "$A" "${STORE_RUN[@]}" -v "$DATA_A":/data "${COMMON_ENV[@]}" -e SYNAPSE_SECRETS_DIR=/run/secrets "$IMAGE" >/dev/null
if wait_listening "$A" 240; then ok "A: \"Synapse now listening on TCP port 8008\" reached"; else bad "A: Synapse did not reach \"now listening\""; fi
"$RT" logs "$A" > "$T/a.log" 2>&1
note "entrypoint and start.py lines:"
grep -E '^(Secret store mode|First boot|DID field protection|Starting synapse with args|Generating|Creating)' "$T/a.log" | sed 's/^/      | /'
note "uid:gid of the container user: $("$RT" exec "$A" id -u):$("$RT" exec "$A" id -g)"
HEALTH="$("$RT" exec "$A" curl -sS -o /dev/null -w '%{http_code}' http://localhost:8008/health 2>&1)"
test "$HEALTH" = 200 && ok "A: /health answers 200" || bad "A: /health" "got $HEALTH"
test "$("$RT" exec "$A" id -u)" = 991 && ok "A: the container runs as uid 991 (no gosu switch)" || bad "A: uid"
grep -q 'Setting ownership' "$T/a.log" && bad "A: /start.py switched users (gosu path taken)" || ok "A: /start.py did not switch users"
grep -q 'Starting synapse with args -m synapse.app.homeserver --no-secrets-in-config --config-path /data/homeserver.yaml' "$T/a.log" \
  && ok "A: start.py hands --no-secrets-in-config to synapse.app.homeserver" || bad "A: start args line"
"$RT" exec "$A" sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < $p/cmdline 2>/dev/null; echo; done' > "$T/a.cmdlines" 2>&1
grep -q -- '-m synapse.app.homeserver --no-secrets-in-config' "$T/a.cmdlines" \
  && ok "A: the running Synapse process has --no-secrets-in-config in its command line" || bad "A: process command line"
"$RT" exec "$A" sh -c 'yq ".macaroon_secret_key_path, .form_secret_path, .matrix_authentication_service.secret_path, .app_service_config_files[]" /data/homeserver.yaml' > "$T/a.refs" 2>&1
note "references in the config (paths only):"; sed 's/^/      | /' "$T/a.refs"
test "$("$RT" exec "$A" yq '[.macaroon_secret_key, .form_secret, .registration_shared_secret, .registration_shared_secret_path, .matrix_authentication_service.secret] | map(select(. != null)) | length' /data/homeserver.yaml)" = 0 \
  && ok "A: no inline secret key in the config (generate's inline values were removed on this boot)" || bad "A: inline keys remain"
test "$("$RT" exec "$A" sh -c 'test -e /data/lk-jwt-as.yaml && echo present || echo absent')" = absent \
  && ok "A: /data/lk-jwt-as.yaml is not rendered" || bad "A: lk-jwt-as.yaml rendered"
"$RT" exec "$A" sh -c 'tr "\0" "\n" < /proc/1/environ | cut -d= -f1' > "$T/a.envnames" 2>&1
grep -qxE 'MAS_SHARED_SECRET|LK_JWT_AS_TOKEN|LK_JWT_HS_TOKEN|SYNAPSE_REGISTRATION_SHARED_SECRET|SYNAPSE_MACAROON_SECRET_KEY' "$T/a.envnames" \
  && bad "A: a secret variable name is in the container environment" || ok "A: no secret variable in the container environment (names checked, values never read)"
if leaks_in "$T/a.log"; then bad "A: a throwaway value is in the container log"; else ok "A: no throwaway value in the container log"; fi
GREP_ARGS=(); for v in "${VALUES[@]}"; do GREP_ARGS+=(-e "$v"); done
test "$("$RT" exec "$A" sh -c 'grep -rlF "$@" /data 2>/dev/null | wc -l' sh "${GREP_ARGS[@]}")" = 0 \
  && ok "A: no throwaway value anywhere in the /data volume" || bad "A: a value is in /data"
CODE_RIGHT="$("$RT" exec "$A" curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $V_MAS" 'http://localhost:8008/_synapse/mas/query_user?localpart=nobody' 2>&1)"
CODE_WRONG="$("$RT" exec "$A" curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $V_WRONG" 'http://localhost:8008/_synapse/mas/query_user?localpart=nobody' 2>&1)"
note "/_synapse/mas/query_user with the secret from its file: $CODE_RIGHT; with a wrong one: $CODE_WRONG"
if [ "$CODE_RIGHT" != "$CODE_WRONG" ] && { [ "$CODE_WRONG" = 403 ] || [ "$CODE_WRONG" = 401 ]; } && [ "$CODE_RIGHT" != 401 ] && [ "$CODE_RIGHT" != 403 ]; then
  ok "A: Synapse accepts exactly the MAS secret it read from its file"
else bad "A: MAS secret check" "right=$CODE_RIGHT wrong=$CODE_WRONG"; fi
"$RT" stop -t 30 "$A" >/dev/null 2>&1

echo "== A2. the same data volume, second boot (config already there)"
A2="$P-a2"; CTRS+=("$A2")
"$RT" run -d --name "$A2" "${STORE_RUN[@]}" -v "$DATA_A":/data "${COMMON_ENV[@]}" -e SYNAPSE_SECRETS_DIR=/run/secrets "$IMAGE" >/dev/null
if wait_listening "$A2" 240; then ok "A2: second boot reaches \"Synapse now listening\""; else bad "A2: second boot did not start"; fi
"$RT" logs "$A2" > "$T/a2.log" 2>&1
grep -q 'Setup already completed' "$T/a2.log" && ok "A2: the first-boot block was skipped" || bad "A2: first-boot block"
if leaks_in "$T/a2.log"; then bad "A2: a value is in the log"; else ok "A2: no throwaway value in the log"; fi
"$RT" stop -t 30 "$A2" >/dev/null 2>&1

# =================================================================================================
echo "== B. negative control: the same files, no group_add"
DATA_B="$(chowned_data data-b)"
OUT_B="$("$RT" run --rm --network none --user 991:991 -v "$SEC":/run/secrets:ro -v "$DATA_B":/data "${COMMON_ENV[@]}" -e SYNAPSE_SECRETS_DIR=/run/secrets "$IMAGE" 2>&1)"; RC_B=$?
echo "$OUT_B" | grep -E 'REFUSING' | sed 's/^/      | /'
if [ "$RC_B" != 0 ] && echo "$OUT_B" | grep -q 'secret file /run/secrets/mas_shared_secret (SYNAPSE_MAS_SECRET_FILE) is not readable by uid 991'; then ok "B: refused (rc=$RC_B), the file is named, the cause is the missing group"; else bad "B: expected a refusal" "rc=$RC_B"; fi
echo "$OUT_B" > "$T/b.log"; if leaks_in "$T/b.log"; then bad "B: a value is in the output"; else ok "B: no value in the output"; fi

echo "== C. refusals that need a runtime"
OUT_C="$("$RT" run --rm --network none -v "$SEC":/run/secrets:ro -v "$DATA_B":/data "${COMMON_ENV[@]}" -e SYNAPSE_SECRETS_DIR=/run/secrets "$IMAGE" 2>&1)"; RC_C=$?
echo "$OUT_C" | grep -E 'REFUSING' | sed 's/^/      | /'
if [ "$RC_C" != 0 ] && echo "$OUT_C" | grep -q 'the container runs as root'; then ok "C: a root container in store mode is refused (rc=$RC_C)"; else bad "C: root refusal" "rc=$RC_C"; fi
OUT_C2="$("$RT" run --rm "${STORE_RUN[@]}" -v "$DATA_B":/data "${COMMON_ENV[@]}" -e SYNAPSE_SECRETS_DIR=/run/secrets -e MAS_SHARED_SECRET="$V_LEAK" "$IMAGE" 2>&1)"; RC_C2=$?
echo "$OUT_C2" | grep -E 'REFUSING' | sed 's/^/      | /'
echo "$OUT_C2" > "$T/c2.log"
if [ "$RC_C2" != 0 ] && grep -q 'the environment variable MAS_SHARED_SECRET is set' "$T/c2.log" && ! leaks_in "$T/c2.log"; then ok "C: MAS_SHARED_SECRET in the environment is refused by name, value not printed"; else bad "C: env refusal" "rc=$RC_C2"; fi
# a config owned by another uid: yq -i would fail with permission denied
DATA_E="$(chowned_data data-e)"
helper -v "$DATA_A":/from -v "$DATA_E":/data "$IMAGE" -c 'cp /from/homeserver.yaml /data/homeserver.yaml; chown 1000:1000 /data/homeserver.yaml; chmod 0644 /data/homeserver.yaml' >/dev/null 2>&1
OUT_E="$("$RT" run --rm "${STORE_RUN[@]}" -v "$DATA_E":/data "${COMMON_ENV[@]}" -e SYNAPSE_SECRETS_DIR=/run/secrets "$IMAGE" 2>&1)"; RC_E=$?
echo "$OUT_E" | grep -E 'REFUSING' | sed 's/^/      | /'
if [ "$RC_E" != 0 ] && echo "$OUT_E" | grep -q 'homeserver.yaml is not writable by uid 991'; then ok "C: a config owned by another uid is refused before any write (rc=$RC_E)"; else bad "C: foreign-owned config" "rc=$RC_E"; fi

# =================================================================================================
echo "== D. --no-secrets-in-config is active: an inline secret in a copy of the config stops Synapse"
INLINE='not-a-secret-test-fixture'
# The copy swaps form_secret_path for an inline form_secret: the only change between the
# refused run and the control is the flag.
D_ARGS=("${STORE_RUN[@]}" -v "$DATA_A":/data --entrypoint sh -e SYNAPSE_CONFIG_PATH=/tmp/copy.yaml "$IMAGE")
OUT_D="$("$RT" run --rm "${D_ARGS[@]}" -c "cp /data/homeserver.yaml /tmp/copy.yaml && yq -i 'del(.form_secret_path) | .form_secret = \"$INLINE\"' /tmp/copy.yaml && exec /start.py run --no-secrets-in-config" 2>&1)"; RC_D=$?
echo "$OUT_D" | grep -E 'Starting synapse with args|in-line secret|ConfigError|Error in configuration' | sed 's/^/      | /'
if [ "$RC_D" != 0 ] && echo "$OUT_D" | grep -q 'Config options that expect an in-line secret as value are disabled'; then ok "D: with the flag, an inline form_secret is a start error (rc=$RC_D)"; else bad "D: flag proof" "rc=$RC_D"; fi
CTL="$P-d-control"; CTRS+=("$CTL")
"$RT" run -d --name "$CTL" "${STORE_RUN[@]}" -v "$DATA_A":/data --entrypoint sh -e SYNAPSE_CONFIG_PATH=/tmp/copy.yaml "$IMAGE" -c "cp /data/homeserver.yaml /tmp/copy.yaml && yq -i 'del(.form_secret_path) | .form_secret = \"$INLINE\"' /tmp/copy.yaml && exec /start.py run" >/dev/null
if wait_listening "$CTL" 240; then ok "D: control, the same copy WITHOUT the flag starts (so the refusal above is the flag's)"; else bad "D: control did not start"; fi
"$RT" rm -f "$CTL" >/dev/null 2>&1

# =================================================================================================
echo "== F. without the store variable: the image behaves as it always did"
DATA_F="$(vol data-f)"
F="$P-f"; CTRS+=("$F")
"$RT" run -d --name "$F" --network none -v "$DATA_F":/data "${COMMON_ENV[@]}" \
  -e MAS_SHARED_SECRET="$V_NMAS" -e LK_JWT_AS_TOKEN="$V_NAS" -e LK_JWT_HS_TOKEN="$V_NHS" "$IMAGE" >/dev/null
if wait_listening "$F" 240; then ok "F: mode off, root container, secrets in the environment: reaches \"Synapse now listening\""; else bad "F: mode off did not start"; fi
"$RT" logs "$F" > "$T/f.log" 2>&1
grep -E '^(Setting ownership|Starting synapse with args)' "$T/f.log" | sed 's/^/      | /'
grep -q 'Secret store mode' "$T/f.log" && bad "F: store mode lines appeared" || ok "F: no store-mode line"
grep -q 'Starting synapse with args -m synapse.app.homeserver --config-path /data/homeserver.yaml$' "$T/f.log" \
  && ok "F: start.py runs Synapse WITHOUT --no-secrets-in-config" || bad "F: start args line"
grep -q 'Setting ownership on /data to 991:991' "$T/f.log" && ok "F: the gosu path (root, then 991) is unchanged" || bad "F: ownership line"
test "$("$RT" exec "$F" yq '.matrix_authentication_service.secret' /data/homeserver.yaml)" = "$V_NMAS" \
  && ok "F: the MAS secret is still written inline, as before" || bad "F: inline MAS secret"
test "$("$RT" exec "$F" sh -c 'test -s /data/lk-jwt-as.yaml && echo yes')" = yes && ok "F: /data/lk-jwt-as.yaml is rendered, as before" || bad "F: lk-jwt-as.yaml"
if leaks_in "$T/f.log"; then bad "F: a value is in the log"; else ok "F: no value in the log"; fi
"$RT" stop -t 30 "$F" >/dev/null 2>&1

# =================================================================================================
# Audit cases (PR #73). run_to_end: start detached, wait until it exits (or time runs out), keep the log.
run_to_end() { # run_to_end NAME SECONDS LOGFILE run-args...
  local n="$1" s="$2" l="$3"; shift 3
  CTRS+=("$n")
  "$RT" run -d --name "$n" "$@" >/dev/null 2>&1
  timeout "$s" "$RT" wait "$n" >/dev/null 2>&1
  "$RT" logs "$n" > "$l" 2>&1
  "$RT" rm -f "$n" >/dev/null 2>&1
}
partial_in() { # partial_in VALUE FILE : any 12-character piece of VALUE is in FILE
  local v="$1" i
  for ((i=0; i+12<=${#v}; i++)); do grep -qF -- "${v:i:12}" "$2" && return 0; done
  return 1
}

echo "== G. AUD-4: switching back (mode off) on a volume a store-mode boot wrote"
# The operator removes SYNAPSE_SECRETS_DIR and gives the secrets back in the environment, as
# before the switch; the store stays mounted. apply_mas_config writes `secret` next to the
# `secret_path` store mode left, and Synapse's pydantic error repeats the block's tail.
# Only SYNAPSE_SECRETS_DIR is removed; user, group_add and the mounts stay, so the secret files
# stay readable and Synapse reaches the MAS block.
run_to_end "$P-g" 180 "$T/g.log" "${STORE_RUN[@]}" -v "$DATA_A":/data "${COMMON_ENV[@]}" \
  -e MAS_SHARED_SECRET="$V_NMAS" -e LK_JWT_AS_TOKEN="$V_NAS" -e LK_JWT_HS_TOKEN="$V_NHS" "$IMAGE"
grep -E 'Error in configuration|cannot be set|REFUSING' "$T/g.log" | sed -E 's/input_value=.*/input_value=<elided by the test>/; s/^/      | /'
if partial_in "$V_NMAS" "$T/g.log"; then bad "G: a piece of the MAS secret is in the log of the mode-off boot"; else ok "G: no piece of the MAS secret in the log of the mode-off boot"; fi

echo "== H. AUD-3: two registrations with one as_token (lk-jwt and a call-control registration)"
helper -v "$SEC":/sec -e V_AS="$V_AS" "$IMAGE" -c '
  sed -e "s/^id: .*/id: call-control/" -e "s/^sender_localpart: .*/sender_localpart: _call_control/" \
      -e "s/^hs_token: .*/hs_token: \"other-hs-token-fixture\"/" /sec/lk_jwt_as_registration.yaml > /sec/cc_as_registration.yaml
  chown 0:5003 /sec/cc_as_registration.yaml && chmod 0440 /sec/cc_as_registration.yaml' >/dev/null 2>&1
DATA_H="$(chowned_data data-h)"
run_to_end "$P-h" 240 "$T/h.log" "${STORE_RUN[@]}" -v "$DATA_H":/data "${COMMON_ENV[@]}" -e SYNAPSE_SECRETS_DIR=/run/secrets \
  -e SYNAPSE_APPSERVICE_FILES=/run/secrets/lk_jwt_as_registration.yaml,/run/secrets/cc_as_registration.yaml "$IMAGE"
grep -E 'Cannot reuse|REFUSING' "$T/h.log" | sed -E "s/${V_AS}/<the as_token>/g; s/^/      | /"
if leaks_in "$T/h.log"; then bad "H: the shared as_token is in the log"; else ok "H: the shared as_token is not in the log"; fi

echo "== I. AUD-9: a read-only root file system without a writable /tmp (yq -i needs one)"
DATA_I="$(chowned_data data-i)"
helper -v "$DATA_A":/from -v "$DATA_I":/data "$IMAGE" -c 'cp -a /from/. /data/ && chown -R 991:991 /data' >/dev/null 2>&1
# podman mounts a tmpfs on /tmp under --read-only unless told not to; Docker does not.
RO=(--read-only); case "$RT" in *podman*) RO+=(--read-only-tmpfs=false) ;; esac
run_to_end "$P-i" 120 "$T/i.log" "${STORE_RUN[@]}" "${RO[@]}" -v "$DATA_I":/data "${COMMON_ENV[@]}" -e SYNAPSE_SECRETS_DIR=/run/secrets "$IMAGE"
grep -E 'REFUSING|ERROR' "$T/i.log" | sed 's/^/      | /'
if grep -q 'REFUSING TO START (secret store mode).*/tmp' "$T/i.log"; then ok "I: refused, and the refusal names /tmp"; else bad "I: read-only /tmp" "the refusal does not name /tmp"; fi

echo "== J. F4: a secret file the container user owns, and a directory it can write"
# Copies of the store (owner root, groups 5001 to 5003, mode 0440, directory 0711, which start fine in A).
# J1: the macaroon file is 991's own (mode 0440, so not writable, and the mount is read-only: only the
# owner check can refuse it). J2: the directory is mode 0777 on a mount that is not read-only.
SEC_J1="$(vol sec-j1)"; SEC_J2="$(vol sec-j2)"
helper -v "$SEC":/from:ro -v "$SEC_J1":/sec "$IMAGE" -c 'cp -a /from/. /sec/ && chown 991:0 /sec/macaroon_secret_key' >/dev/null 2>&1 && ok "J: store copy with a file owned by 991" || bad "J: store copy 1"
helper -v "$SEC":/from:ro -v "$SEC_J2":/sec "$IMAGE" -c 'cp -a /from/. /sec/ && chmod 0777 /sec' >/dev/null 2>&1 && ok "J: store copy with a directory mode 0777" || bad "J: store copy 2"
DATA_J1="$(chowned_data data-j1)"; DATA_J2="$(chowned_data data-j2)"
run_to_end "$P-j1" 120 "$T/j1.log" --network none --user 991:991 "${GROUPS_ADD[@]}" -v "$SEC_J1":/run/secrets:ro -v "$DATA_J1":/data "${COMMON_ENV[@]}" -e SYNAPSE_SECRETS_DIR=/run/secrets "$IMAGE"
grep -E 'REFUSING' "$T/j1.log" | sed 's/^/      | /'
if grep -q 'REFUSING TO START (secret store mode): secret file /run/secrets/macaroon_secret_key (SYNAPSE_MACAROON_SECRET_FILE) is owned by uid 991' "$T/j1.log"; then ok "J1: a file owned by uid 991 is refused, named, on a read-only mount"; else bad "J1: owned file" "no owner refusal"; fi
run_to_end "$P-j2" 120 "$T/j2.log" --network none --user 991:991 "${GROUPS_ADD[@]}" -v "$SEC_J2":/run/secrets -v "$DATA_J2":/data "${COMMON_ENV[@]}" -e SYNAPSE_SECRETS_DIR=/run/secrets "$IMAGE"
grep -E 'REFUSING' "$T/j2.log" | sed 's/^/      | /'
if grep -q 'REFUSING TO START (secret store mode): secret file /run/secrets/mas_shared_secret (SYNAPSE_MAS_SECRET_FILE) sits in the directory /run/secrets, which is writable by uid 991' "$T/j2.log"; then ok "J2: a directory 991 can write is refused, named"; else bad "J2: writable directory" "no directory refusal"; fi
if leaks_in "$T/j1.log" || leaks_in "$T/j2.log"; then bad "J: a value is in a log"; else ok "J: no value in either log"; fi

echo
echo "passed: $PASS   failed: $FAILN"
[ "$FAILN" = 0 ]
