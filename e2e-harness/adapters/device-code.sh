#!/usr/bin/env bash
# =============================================================================
# adapters/device-code.sh — encapsulate the RFC 8628 device-code e2e test
# (target `e2e_device_code`) against the LOCAL hermetic stack (siwx-e2eh-*).
#
# Needs MAS_SHARED_SECRET (for the /oauth2/introspect check); read from
# .env.e2e at the repo root unless already set in the environment. Streams
# stdout/stderr to the artifact file; returns cargo's exit code.
#
# Usage:
#   adapters/device-code.sh <artifact_file> [<test_fn> ...]
#     ($test_fn defaults to the whole e2e_device_code target — its single
#      #[ignore]'d test device_code_grant_end_to_end.)
#
# Env overrides:
#   SIWX_OIDC_DIR  siwx-oidc checkout. Default: <parent of this repo>/siwx-oidc
#                  (repo-relative, NOT a hardcoded $HOME path). OIDC_E2EH_DIR is
#                  still honoured as the legacy override name.
#   ENV_FILE       default <repo-root>/.env.e2e
#   SIWEOIDC_HOST  default http://localhost:18081
#   MATRIX_HOST    default http://localhost:18080
#   MAS_SHARED_SECRET  default: read from ENV_FILE
#
# Exit codes: 2 = could not run (precondition); 3 = ran but judged nothing
# (filter matched no test); otherwise cargo's own code. See adapters/_common.sh.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$SCRIPT_DIR/_common.sh"

ARTIFACT="${1:?usage: device-code.sh <artifact_file> [test_fn...]}"
shift || true

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="e2e_device_code"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env.e2e}"
SIWEOIDC_HOST="${SIWEOIDC_HOST:-http://localhost:18081}"
MATRIX_HOST="${MATRIX_HOST:-http://localhost:18080}"

# Sets $SIWX_OIDC_DIR_RESOLVED, or exits 2 having written the reason to $ARTIFACT.
resolve_siwx_oidc_dir "$ARTIFACT" "$TARGET"
OIDC_DIR="$SIWX_OIDC_DIR_RESOLVED"

command -v cargo >/dev/null 2>&1 || adapter_die "$ARTIFACT" 2 \
  "ADAPTER PRECONDITION FAILED: cargo not on PATH."

# Refuse to run against an unexpected / unreproducible checkout. Recording the
# revision was never enough — the harness would otherwise test whatever branch
# this sibling checkout happened to be sitting on.
assert_checkout_revision "$ARTIFACT" "$OIDC_DIR" "siwx-oidc checkout" \
  "${E2E_EXPECT_SHA:-}" "${E2E_EXPECT_REF:-}"

# Source MAS_SHARED_SECRET from .env.e2e if not already provided.
if [ -z "${MAS_SHARED_SECRET:-}" ]; then
  [ -f "$ENV_FILE" ] || adapter_die "$ARTIFACT" 2 \
    "ADAPTER PRECONDITION FAILED: $ENV_FILE not found and MAS_SHARED_SECRET unset."
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi
[ -n "${MAS_SHARED_SECRET:-}" ] || adapter_die "$ARTIFACT" 2 \
  "ADAPTER PRECONDITION FAILED: MAS_SHARED_SECRET still unset after sourcing $ENV_FILE."

{
  echo "===== device-code adapter (RFC 8628) ====="
  echo "checkout     : $OIDC_DIR"
  echo "revision     : $(describe_checkout "$OIDC_DIR")"
  echo "test target  : $TARGET"
  echo "test filters : ${*:-<whole target>}"
  echo "siweoidc host: $SIWEOIDC_HOST"
  echo "matrix host  : $MATRIX_HOST"
  echo "mas secret   : <loaded from env>"
  echo "=========================================="
} >>"$ARTIFACT"

CARGO_OUT="$(mktemp -t siwx-adapter-out.XXXXXX)"
trap 'rm -f "$CARGO_OUT"' EXIT

set +e
( cd "$OIDC_DIR" && \
  SIWEOIDC_HOST="$SIWEOIDC_HOST" \
  MATRIX_HOST="$MATRIX_HOST" \
  MAS_SHARED_SECRET="$MAS_SHARED_SECRET" \
  cargo test --test "$TARGET" -- --ignored --nocapture "$@" \
) >"$CARGO_OUT" 2>&1
RC=$?
set -e 2>/dev/null || true

cat "$CARGO_OUT" >>"$ARTIFACT"
assert_tests_actually_ran "$ARTIFACT" "$CARGO_OUT" "$RC"; RC=$?
report_skip_markers      "$ARTIFACT" "$CARGO_OUT" "$RC"; RC=$?
exit "$RC"
