#!/usr/bin/env bash
# Hermetic test of where scripts/matrix-storage-controller.sh takes the MAS shared secret from: the systemd
# credential `mas_shared_secret` (found through $CREDENTIALS_DIRECTORY, which a LoadCredential setting of the unit
# creates) when the unit passes credentials, otherwise MAS_SHARED_SECRET in the stack's .env; a unit that passes
# credentials but not this one is an error, not a fall back. It runs the real script against a scratch stack with a
# stub `docker` that records what the script hands the container: the stdin (where the secret travels) and the
# argument vector (where it must never appear). Case 8 also runs the script the container executes, with a stub
# curl, to check that neither the secret nor the admin token reaches curl's argument vector. No network, no
# container runtime, no real secret: the values are generated here.
#
#   scripts/storage-controller-credential-test.sh        exit 0 = every assertion holds
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/matrix-storage-controller.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAILS=0
ok()  { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
bad() { FAILS=$((FAILS + 1)); printf 'FAIL %s\n' "$1"; }
assert() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

RUN_ENV=()  # extra NAME=value words for run()
rand() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

# A stack with a .env that holds the settings the script needs and, optionally, a MAS_SHARED_SECRET.
new_case() {  # new_case <name> [env-secret]
  C="$WORK/$1"; mkdir -p "$C/stack" "$C/bin" "$C/state" "$C/cred"
  {
    echo "MATRIX_HOST=example.org"
    echo "MATRIX_ADMIN_MXID=@admin:example.org"
    [ -z "${2:-}" ] || printf '%s=%s\n' MAS_SHARED_SECRET "$2"
  } > "$C/stack/.env"
  cat > "$C/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$ARGV_LOG"
cat >> "$STDIN_LOG"
printf '{"%s":"stub-tok-%s","expires_in":300}\n__HTTP__200' access_token "$$"
EOF
  chmod +x "$C/bin/docker"
  : > "$C/argv.log"; : > "$C/stdin.log"
}
# run <args...>: the controller against the case, with the credential directory in $CRED_DIR if set
run() {
  OUT="$(env -i PATH="$C/bin:$PATH" HOME="$C" STACK_DIR="$C/stack" STATE_DIR="$C/state" ARGV_LOG="$C/argv.log" STDIN_LOG="$C/stdin.log" \
        ${CRED_DIR:+CREDENTIALS_DIRECTORY="$CRED_DIR"} ${RUN_ENV[@]+"${RUN_ENV[@]}"} "$SCRIPT" "$@" 2>&1)"
  RC=$?
}
first_stdin() { head -n 1 "$C/stdin.log"; }

# 1. credential only: the .env holds no MAS_SHARED_SECRET at all (the secret-store layout)
S1="$(rand)"; new_case cred_only
printf '%s\n' "$S1" > "$C/cred/mas_shared_secret"
CRED_DIR="$C/cred" run notice "test"
assert "credential only: the notice is sent (exit 0)" test "$RC" = 0
assert "credential only: the first line on the container's stdin is the credential's value" test "$(first_stdin)" = "$S1"
assert "credential only: the value is in no argument vector" bash -c '! grep -qF -- "$1" "$2"' _ "$S1" "$C/argv.log"
assert "credential only: the value is not in the script's output" bash -c '! printf "%s" "$1" | grep -qF -- "$2"' _ "$OUT" "$S1"

# 2. no credential: .env as before the store
S2="$(rand)"; new_case env_only "$S2"
CRED_DIR="" run notice "test"
assert ".env only: the notice is sent (exit 0)" test "$RC" = 0
assert ".env only: the first line on the container's stdin is the .env value" test "$(first_stdin)" = "$S2"
assert ".env only: the value is in no argument vector" bash -c '! grep -qF -- "$1" "$2"' _ "$S2" "$C/argv.log"

# 3. both: the credential wins
S3="$(rand)"; S3b="$(rand)"; new_case both "$S3b"
printf '%s\n' "$S3" > "$C/cred/mas_shared_secret"
CRED_DIR="$C/cred" run notice "test"
assert "both: the credential wins over .env" test "$(first_stdin)" = "$S3"
assert "both: the .env value never reaches the container" bash -c '! grep -qF -- "$1" "$2"' _ "$S3b" "$C/stdin.log"

# 4. (B2) a credential directory without that credential is an error, never a quiet fall back to .env: a unit that
# passes credentials runs on the secret store, and a unit that names the wrong id must fail loudly
S4="$(rand)"; new_case other_cred "$S4"
printf 'x\n' > "$C/cred/another_credential"
CRED_DIR="$C/cred" run notice "test"
assert "another credential only: the controller stops (exit 1)" test "$RC" = 1
assert "another credential only: the error names the credential and says there is no fall back" bash -c 'printf "%s" "$1" | grep -q "mas_shared_secret credential is not among them; not falling back"' _ "$OUT"
assert "another credential only: the .env value is not used" bash -c '! grep -qF -- "$1" "$2"' _ "$S4" "$C/stdin.log"
assert "another credential only: no mint was attempted" test ! -s "$C/stdin.log"
assert "another credential only: the .env value is not in the output" bash -c '! printf "%s" "$1" | grep -qF -- "$2"' _ "$OUT" "$S4"

# 4b. (B2) every run logs which source the secret came from, by name only
S4b="$(rand)"; new_case source_cred
printf '%s\n' "$S4b" > "$C/cred/mas_shared_secret"
CRED_DIR="$C/cred" run notice "test"
assert "source line: the credential run logs 'credential'" bash -c 'printf "%s" "$1" | grep -q "MAS shared secret source: credential$"' _ "$OUT"
assert "source line: the value is not in the output" bash -c '! printf "%s" "$1" | grep -qF -- "$2"' _ "$OUT" "$S4b"
S4c="$(rand)"; new_case source_env "$S4c"
CRED_DIR="" run notice "test"
assert "source line: the .env run logs 'env'" bash -c 'printf "%s" "$1" | grep -q "MAS shared secret source: env$"' _ "$OUT"
assert "source line: the value is not in the output" bash -c '! printf "%s" "$1" | grep -qF -- "$2"' _ "$OUT" "$S4c"

# 5. neither: a loud failure that names the source and carries no value
new_case neither
CRED_DIR="" run notice "test"
assert "neither: the controller stops (exit 1)" test "$RC" = 1
assert "neither: the error names the missing secret and where it looked" bash -c 'printf "%s" "$1" | grep -q "MAS shared secret is empty or missing (MAS_SHARED_SECRET in "' _ "$OUT"
assert "neither: no mint was attempted" test ! -s "$C/stdin.log"

# 6. an empty credential is an error too, not a fall back to a stale .env value
S6="$(rand)"; new_case empty_cred "$S6"
: > "$C/cred/mas_shared_secret"
CRED_DIR="$C/cred" run notice "test"
assert "empty credential: the controller stops (exit 1)" test "$RC" = 1
assert "empty credential: it names the credential" bash -c 'printf "%s" "$1" | grep -q "the mas_shared_secret credential"' _ "$OUT"
assert "empty credential: the .env value is not used" bash -c '! grep -qF -- "$1" "$2"' _ "$S6" "$C/stdin.log"

# 7. a refused mint names the source of the secret and still prints no value
S7="$(rand)"; new_case refused
printf '%s\n' "$S7" > "$C/cred/mas_shared_secret"
cat > "$C/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$ARGV_LOG"
cat >> "$STDIN_LOG"
printf '{"error":"unauthorized"}\n__HTTP__401'
EOF
CRED_DIR="$C/cred" run notice "test"
assert "refused mint: exit 3" test "$RC" = 3
assert "refused mint: the hint names the credential as the source" bash -c 'printf "%s" "$1" | grep -q "MAS shared secret (the mas_shared_secret credential)"' _ "$OUT"
assert "refused mint: no value in the output" bash -c '! printf "%s" "$1" | grep -qF -- "$2"' _ "$OUT" "$S7"

# 8. (audit) inside the container: the stub docker RUNS the `sh -c` script it is handed, with a stub curl that records
# its argument vector. A process's argv is world-readable on the host (/proc/<pid>/cmdline, `ps`), container
# processes included, so the value must reach curl on stdin or from a file, never as an -H argument.
S8="$(rand)"; new_case in_container
printf '%s\n' "$S8" > "$C/cred/mas_shared_secret"
mkdir -p "$C/cbin"
cat > "$C/cbin/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$CURL_ARGV_LOG"
case " $* " in *" @- "*) cat >> "$CURL_STDIN_LOG" ;; esac
printf '{"%s":"stub-tok","expires_in":300}\n__HTTP__200' access_token
EOF
chmod +x "$C/cbin/curl"
cat > "$C/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ARGV_LOG"
envs=(); script=""
while [ $# -gt 0 ]; do
  case "$1" in
    -e) envs+=("$2"); shift 2 ;;
    sh) [ "${2:-}" = -c ] && { script="$3"; break; }; shift ;;
    *) shift ;;
  esac
done
env "${envs[@]}" PATH="$CURL_BIN:$PATH" sh -c "$script"
EOF
chmod +x "$C/bin/docker"
: > "$C/curl-argv.log"
RUN_ENV=(CURL_BIN="$C/cbin" CURL_ARGV_LOG="$C/curl-argv.log" CURL_STDIN_LOG="$C/curl-stdin.log")
CRED_DIR="$C/cred" run notice "test"
RUN_ENV=()
assert "in the container: curl ran (the mint was attempted)" test -s "$C/curl-argv.log"
assert "in the container: the MAS secret is in no argument vector of curl" bash -c '! grep -qF -- "$1" "$2"' _ "$S8" "$C/curl-argv.log"
# the positive controls: the credential and the admin token do reach curl, as a header read from curl's own stdin
assert "in the container: the mint and the notice both ran curl (two requests)" test "$(wc -l < "$C/curl-argv.log")" = 2
assert "in the container: the MAS secret reaches curl on its stdin as the Authorization header" bash -c 'grep -qxF -- "Authorization: Bearer $1" "$2"' _ "$S8" "$C/curl-stdin.log"
assert "in the container: the admin token is in no argument vector of curl" bash -c '! grep -qF -- "stub-tok" "$1"' _ "$C/curl-argv.log"
assert "in the container: the admin token reaches curl on its stdin as the Authorization header" bash -c 'grep -qxF -- "Authorization: Bearer stub-tok" "$1"' _ "$C/curl-stdin.log"
assert "in the container: neither value is in the script's output" bash -c '! printf "%s" "$1" | grep -qF -e "$2" -e stub-tok' _ "$OUT" "$S8"

echo "----"
echo "storage controller credential: $PASS passed, $FAILS failed"
[ "$FAILS" = 0 ]
