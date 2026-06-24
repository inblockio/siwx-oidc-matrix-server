#!/usr/bin/env bash
# =============================================================================
# adapters/siwx-oidc-realstack.sh — encapsulate the siwx-oidc real-stack e2e
# tests (siwx-oidc-e2eh repo) against the LOCAL hermetic stack (siwx-e2eh-*).
#
# Runs an integration TEST TARGET (the `--test <NAME>` file), passing through
# `--ignored` (these tests are #[ignore]'d so they only run on demand against a
# live stack). Optionally restricts to specific test fns appended after the
# target name. Streams stdout/stderr to the artifact file; returns cargo's RC.
#
# Usage:
#   adapters/siwx-oidc-realstack.sh <artifact_file> <test_target> [<test_fn> ...]
#     e.g. siwx-oidc-realstack.sh art.txt e2e_msc3861 full_lifecycle
#          siwx-oidc-realstack.sh art.txt e2e_msc3861            # whole target
#
# Env overrides:
#   OIDC_E2EH_DIR  default /home/waldknoten-01/siwx-oidc-e2eh
#   SIWEOIDC_HOST  default http://localhost:18081
#   MATRIX_HOST    default http://localhost:18080
# =============================================================================
set -uo pipefail

ARTIFACT="${1:?usage: siwx-oidc-realstack.sh <artifact_file> <test_target> [test_fn...]}"
shift
TARGET="${1:?need a test target (e.g. e2e_msc3861)}"
shift || true   # remaining args (if any) are specific test fns / filters

OIDC_E2EH_DIR="${OIDC_E2EH_DIR:-/home/waldknoten-01/siwx-oidc-e2eh}"
SIWEOIDC_HOST="${SIWEOIDC_HOST:-http://localhost:18081}"
MATRIX_HOST="${MATRIX_HOST:-http://localhost:18080}"

[ -d "$OIDC_E2EH_DIR" ] || { echo "siwx-oidc-realstack.sh: $OIDC_E2EH_DIR not found" >&2; exit 2; }
command -v cargo >/dev/null 2>&1 || { echo "siwx-oidc-realstack.sh: cargo not on PATH" >&2; exit 2; }

{
  echo "===== siwx-oidc real-stack adapter ====="
  echo "test target  : $TARGET"
  echo "test filters : ${*:-<whole target>}"
  echo "siweoidc host: $SIWEOIDC_HOST"
  echo "matrix host  : $MATRIX_HOST"
  echo "========================================"
} >>"$ARTIFACT"

set +e
( cd "$OIDC_E2EH_DIR" && \
  SIWEOIDC_HOST="$SIWEOIDC_HOST" \
  MATRIX_HOST="$MATRIX_HOST" \
  cargo test --test "$TARGET" -- --ignored --test-threads=1 --nocapture "$@" \
) >>"$ARTIFACT" 2>&1
RC=$?
set -e 2>/dev/null || true

exit "$RC"
