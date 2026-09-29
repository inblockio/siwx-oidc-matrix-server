#!/usr/bin/env bash
#
# did-field-guard-accept.sh — acceptance tests for the DID-profile-field startup
# guard in entrypoints/matrix_server.sh (apply_did_field_protection and the
# on-disk gate before /start.py).
#
# WHY THIS EXISTS. `io.inblock.did` is a three-sided contract (siwx-oidc's
# DID_PROFILE_FIELD, siwx-oidc-auth's copy, and this homeserver's
# experimental_features.msc4133_key_denylist) and the homeserver side fails
# OPEN: an absent or ineffective denylist leaves the field user-writable, which
# is the exact hole the feature closes. The guard's whole value is in its
# FAILURE paths, and a failure path nobody exercises is a failure path nobody
# has. So this script does not assert that the happy path works; it FALSIFIES
# the guard four ways and requires each one to refuse startup.
#
# HOW. Each case runs the WORKING-TREE entrypoint (bind-mounted, so this tests
# the file you are editing, never a baked copy) inside a real Synapse image,
# against a throwaway copy of a real `/start.py generate` homeserver.yaml, with
# /start.py replaced by a stub. "Synapse started" is therefore observable as a
# single marker line, with no homeserver actually booting.
#
# Usage:
#   scripts/did-field-guard-accept.sh
#   scripts/did-field-guard-accept.sh --patched IMG --stock IMG
#
# PATCHED defaults to the e2e harness's Synapse, built from
# dockerfiles/Dockerfile on demand (e2e-harness/images.sh).
#
# The STOCK image is load-bearing, not a convenience: case 4 is the one that
# proves a deployment which pinned an unpatched digest is refused. By default
# the script builds it from two things the repository already pins, so it
# cannot drift from what ships: the upstream image in dockerfiles/Dockerfile's
# FROM line (same Synapse version, same digest), plus /usr/bin/yq copied out
# of the PATCHED image. The entrypoint needs yq and upstream Synapse ships
# none, so plain `matrixdotorg/synapse` fails at the yq write instead of at the
# patch check. The result lacks the patch; nothing else it lacks (the baked
# entrypoint, LICENSE, NOTICE) is read by any case, since every case mounts
# the working-tree entrypoint. `--stock IMG` takes any unpatched Synapse image
# with yq at /usr/bin/yq instead.
#
# Env:
#   PATCHED_IMAGE / STOCK_IMAGE   same as --patched / --stock
#   STOCK_TAG                     tag for the built stock image
#                                 (default localhost/siwx-did-guard-stock:<vX.Y.Z>)
#   SIWX_ACCEPT_SCRATCH           fixture directory
#                                 (default ~/.cache/siwx-did-field-guard-accept)
#
# Exit code: non-zero if any case FAILs.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Default PATCHED image = the e2e harness's Synapse (dockerfiles/Dockerfile,
# resolved and built on demand by e2e-harness/images.sh, below). It used to be
# the hand-built `siwx-real-synapse:local` tag, which was deleted in an image
# cleanup on 2026-09-25 and could not be reproduced from its name. The STOCK
# default had the same flaw (a hand-built `siwx-real-synapse:mas159`); it is
# now built below from the Dockerfile's own pins.
PATCHED_IMAGE="${PATCHED_IMAGE:-}"
STOCK_IMAGE="${STOCK_IMAGE:-}"
STOCK_TAG="${STOCK_TAG:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --patched) PATCHED_IMAGE="$2"; shift 2 ;;
    --stock)   STOCK_IMAGE="$2";   shift 2 ;;
    -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

RT="$(command -v podman || command -v docker)" || { echo "need podman or docker" >&2; exit 2; }

if [ -z "${PATCHED_IMAGE}" ]; then
  # shellcheck source=../e2e-harness/images.sh
  . "${REPO_ROOT}/e2e-harness/images.sh"
  SIWX_OIDC_IMAGE_REF="${SIWX_OIDC_IMAGE_REF:-unused}"   # only the Synapse image is needed here
  e2eh_resolve_images || exit 2
  e2eh_ensure_one synapse "${SYNAPSE_IMAGE_REF}" "${E2EH_SYNAPSE_IS_DEFAULT}" e2eh_build_synapse SYNAPSE_IMAGE_REF || exit 2
  PATCHED_IMAGE="${SYNAPSE_IMAGE_REF}"
fi

# NOT /tmp. On the box this was written on /tmp is a RAM-backed tmpfs, and a
# scratch dir holding container-generated config there is charged to memory and
# belongs to no process. The cache dir is disk everywhere that matters.
SCRATCH="${SIWX_ACCEPT_SCRATCH:-${XDG_CACHE_HOME:-$HOME/.cache}/siwx-did-field-guard-accept}"
mkdir -p "${SCRATCH}"

# Default STOCK image: upstream Synapse at the digest dockerfiles/Dockerfile
# builds on, plus the PATCHED image's yq. Rebuilt on every run, which costs one
# cached layer, so it always follows the current FROM line and PATCHED image.
if [ -z "${STOCK_IMAGE}" ]; then
  STOCK_BASE="$(sed -n 's#^FROM[[:space:]]\{1,\}\(matrixdotorg/synapse:[^[:space:]]*\).*#\1#p' \
                  "${REPO_ROOT}/dockerfiles/Dockerfile" | head -1)"
  [ -n "${STOCK_BASE}" ] || { echo "cannot read the matrixdotorg/synapse FROM line of dockerfiles/Dockerfile" >&2; exit 2; }
  STOCK_VER="${STOCK_BASE#matrixdotorg/synapse:}"; STOCK_VER="${STOCK_VER%%@*}"
  STOCK_IMAGE="${STOCK_TAG:-localhost/siwx-did-guard-stock:${STOCK_VER}}"
  STOCK_CTX="${SCRATCH}/stock-build"
  mkdir -p "${STOCK_CTX}"
  # docker.io/ spelled out: podman resolves short names by configuration, and
  # a build must not depend on which registry that picks.
  printf 'FROM docker.io/%s\nCOPY --from=%s /usr/bin/yq /usr/bin/yq\n' \
    "${STOCK_BASE}" "${PATCHED_IMAGE}" > "${STOCK_CTX}/Containerfile"
  echo "[fixture] building ${STOCK_IMAGE}: docker.io/${STOCK_BASE} + yq from ${PATCHED_IMAGE}"
  "${RT}" build -q -t "${STOCK_IMAGE}" -f "${STOCK_CTX}/Containerfile" "${STOCK_CTX}" >/dev/null \
    || { echo "could not build the stock Synapse image" >&2; exit 2; }
fi

PASS_COUNT=0
FAIL_COUNT=0
pass() { PASS_COUNT=$((PASS_COUNT+1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf 'FAIL  %s\n' "$1"; }

# --- fixtures ---------------------------------------------------------------

# A REAL generated homeserver.yaml, not a hand-written stub: the guard re-reads
# the file Synapse itself produced, and a toy fixture could pass a check the
# real 1200-line document fails.
BASELINE="${SCRATCH}/baseline-homeserver.yaml"
if [ ! -s "${BASELINE}" ]; then
  echo "[fixture] generating a baseline homeserver.yaml with ${PATCHED_IMAGE}"
  # Generated into the container's OWN /data and catted out, with no bind mount.
  # `/start.py generate` chowns /data to 991:991, and under rootless podman that
  # lands on the host as an unprivileged SUBUID the invoking user cannot delete
  # (`rm -rf` then fails with EPERM and every later run reuses a stale fixture).
  # Streaming it out sidesteps the ownership question entirely.
  "${RT}" run --rm \
    -e SYNAPSE_SERVER_NAME=localhost -e SYNAPSE_REPORT_STATS=no \
    --entrypoint sh "${PATCHED_IMAGE}" \
    -c 'mkdir -p /data && /start.py generate >/dev/null 2>&1 && cat /data/homeserver.yaml' > "${BASELINE}"
  [ -s "${BASELINE}" ] || { echo "could not generate a baseline homeserver.yaml" >&2; exit 2; }
fi

# The stub that stands in for Synapse. Reaching it is the ONLY evidence that the
# entrypoint decided to start the server.
STUB="${SCRATCH}/stub-start.py"
cat > "${STUB}" <<'EOF'
#!/bin/sh
echo "STUB-START-PY-REACHED"
EOF
chmod +x "${STUB}"

# A `yq` shim that lands the WRONG field name. It sits on /usr/local/bin, which
# precedes /usr/bin on this image's PATH, and it exits 0 — so it reproduces the
# failure mode a plain exit-status check CANNOT see: the write "succeeds" and
# the file ends up carrying something else. Only a re-read catches this.
YQ_SHIM="${SCRATCH}/yq-decoy-shim"
cat > "${YQ_SHIM}" <<'EOF'
#!/bin/sh
for a in "$@"; do
  case "$a" in
    *msc4133_key_denylist*)
      exec /usr/bin/yq -i \
        '.experimental_features.msc4133_key_denylist = ["io.example.decoy"]' \
        /data/homeserver.yaml ;;
  esac
done
exec /usr/bin/yq "$@"
EOF
chmod +x "${YQ_SHIM}"

# --- runner -----------------------------------------------------------------
# Runs one case. Prints the container's combined output to $OUT and sets $RC.
# $1 image, $2 case name, remaining args are extra `run` flags.
# DATA_MOUNT_OPTS makes the config volume read-only for the write-failure case.
OUT=""; RC=0; CASE_DIR=""; DATA_MOUNT_OPTS="z"
run_case() {
  local img="$1" name="$2"; shift 2
  CASE_DIR="${SCRATCH}/case-${name}"
  rm -rf "${CASE_DIR}"; mkdir -p "${CASE_DIR}"
  cp "${BASELINE}" "${CASE_DIR}/homeserver.yaml"
  OUT="$("${RT}" run --rm \
    -v "${CASE_DIR}:/data:${DATA_MOUNT_OPTS}" \
    -v "${REPO_ROOT}/entrypoints/matrix_server.sh:/matrix_server_test.sh:ro,z" \
    -v "${STUB}:/start.py:ro,z" \
    -e MATRIX_HOST=localhost \
    -e MATRIX_PORT=8008 \
    -e MATRIX_BASE_URL=http://localhost:8008 \
    -e SIWEOIDC_INTERNAL_URL=http://siwx-oidc:8081 \
    -e MAS_SHARED_SECRET=accept-test-secret \
    "$@" \
    --entrypoint bash "${img}" /matrix_server_test.sh 2>&1)"
  RC=$?
}

# assertion helpers, each naming the case in its output
expect_rc()      { [ "$RC" = "$2" ] && pass "$1 (exit $RC)" || { fail "$1 — expected exit $2, got $RC"; printf '%s\n' "$OUT" | sed 's/^/      | /'; }; }
expect_out()     { printf '%s' "$OUT" | grep -qF -- "$2" && pass "$1" || { fail "$1 — output did not contain: $2"; printf '%s\n' "$OUT" | sed 's/^/      | /'; }; }
expect_not_out() { printf '%s' "$OUT" | grep -qF -- "$2" && { fail "$1 — output unexpectedly contained: $2"; printf '%s\n' "$OUT" | sed 's/^/      | /'; } || pass "$1"; }
expect_count()   { local n; n="$(printf '%s' "$OUT" | grep -cF -- "$2")"; [ "$n" = "$3" ] && pass "$1 (x$n)" || fail "$1 — expected $3 occurrences of '$2', got $n"; }
expect_denylist(){ local got; got="$(grep -A2 'msc4133_key_denylist' "${CASE_DIR}/homeserver.yaml" | tr -d ' \n')"; case "$got" in *"$2"*) pass "$1" ;; *) fail "$1 — on-disk denylist did not mention '$2' (got: $got)" ;; esac; }

echo "runtime: ${RT}"
echo "patched image: ${PATCHED_IMAGE}"
echo "stock image:   ${STOCK_IMAGE}"
echo

# --- 1. happy path ----------------------------------------------------------
echo "== 1. patched image, writable config: starts, and the denylist is on disk"
run_case "${PATCHED_IMAGE}" happy
expect_rc      "1.1 starts"                       0
expect_out     "1.2 reports the patch is present" "carries the MSC4133 write-ACL patch"
expect_out     "1.3 reaches Synapse"              "STUB-START-PY-REACHED"
expect_denylist "1.4 io.inblock.did is on disk"   "io.inblock.did"
expect_not_out "1.5 prints no unprotected banner" "IS NOT PROTECTED"

# --- 2. FALSIFICATION: the yq write cannot land -----------------------------
echo "== 2. patched image, /data read-only: the write fails and startup is refused"
DATA_MOUNT_OPTS="ro,z"; run_case "${PATCHED_IMAGE}" rofs; DATA_MOUNT_OPTS="z"
expect_rc      "2.1 refuses to start"             1
expect_out     "2.2 names the failed write"       "FAILED (yq exited non-zero"
expect_out     "2.3 says what is unprotected"     "IS NOT PROTECTED"
expect_out     "2.4 states the refusal"           "REFUSING TO START: a config write that silently did not happen"
expect_not_out "2.5 Synapse is never reached"     "STUB-START-PY-REACHED"

# --- 3. FALSIFICATION: the write succeeds but lands the WRONG field ---------
echo "== 3. patched image, sabotaged yq: denylist ends up with the wrong name"
run_case "${PATCHED_IMAGE}" decoy -v "${YQ_SHIM}:/usr/local/bin/yq:ro,z"
expect_rc       "3.1 refuses to start"            1
expect_out      "3.2 names the missing value"     "does NOT contain 'io.inblock.did'"
expect_not_out  "3.3 Synapse is never reached"    "STUB-START-PY-REACHED"
expect_denylist "3.4 the decoy really did land"   "io.example.decoy"

# --- 4. FALSIFICATION: stock (unpatched) Synapse ----------------------------
echo "== 4. stock Synapse: refuses to start by default"
run_case "${STOCK_IMAGE}" stock
expect_rc      "4.1 refuses to start"             1
expect_out     "4.2 names the missing patch"      "does NOT carry the MSC4133 write-ACL patch"
expect_out     "4.3 explains the consequence"     "SOMEONE ELSE'S DID"
expect_out     "4.4 names the escape hatch"       "SIWX_ALLOW_UNPROTECTED_DID_FIELD=1"
expect_not_out "4.5 Synapse is never reached"     "STUB-START-PY-REACHED"

# --- 5. the escape hatch ----------------------------------------------------
echo "== 5. stock Synapse + SIWX_ALLOW_UNPROTECTED_DID_FIELD=1: starts, loudly"
run_case "${STOCK_IMAGE}" hatch -e SIWX_ALLOW_UNPROTECTED_DID_FIELD=1
expect_rc    "5.1 starts"                         0
expect_out   "5.2 reaches Synapse"                "STUB-START-PY-REACHED"
expect_count "5.3 the banner is REPEATED"         "IS NOT PROTECTED" 2
expect_out   "5.4 attributes the override"        "SIWX_ALLOW_UNPROTECTED_DID_FIELD=1 is set"

# --- 6. FALSIFICATION: a field name Synapse can never serve -----------------
echo "== 6. a field name that violates the namespaced-identifier grammar"
run_case "${PATCHED_IMAGE}" badname -e SIWX_DID_PROFILE_FIELD='io.Inblock:did'
expect_rc      "6.1 refuses to start"             1
expect_out     "6.2 names the grammar"            "Common Namespaced Identifier Grammar"
expect_out     "6.3 states the refusal"           "REFUSING TO START: this is a typo in our own configuration"
expect_not_out "6.4 Synapse is never reached"     "STUB-START-PY-REACHED"
expect_not_out "6.5 no hatch is offered"          "SIWX_ALLOW_UNPROTECTED_DID_FIELD=1 to start anyway"

# --- 7. a legitimate rename still works -------------------------------------
echo "== 7. SIWX_DID_PROFILE_FIELD override still reaches disk"
run_case "${PATCHED_IMAGE}" rename -e SIWX_DID_PROFILE_FIELD='io.example.did'
expect_rc       "7.1 starts"                      0
expect_denylist "7.2 the override is on disk"     "io.example.did"

echo
printf 'PASS %d   FAIL %d\n' "${PASS_COUNT}" "${FAIL_COUNT}"
[ "${FAIL_COUNT}" = 0 ]
