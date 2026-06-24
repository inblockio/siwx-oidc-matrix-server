#!/usr/bin/env bash
# =============================================================================
# adapters/device-code.sh — encapsulate the RFC 8628 device-code e2e test
# (siwx-oidc-e2eh repo, target `e2e_device_code`) against the LOCAL hermetic
# stack (siwx-e2eh-*).
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
#   OIDC_E2EH_DIR  default /home/waldknoten-01/siwx-oidc-e2eh
#   ENV_FILE       default <repo-root>/.env.e2e
#   SIWEOIDC_HOST  default http://localhost:18081
#   MATRIX_HOST    default http://localhost:18080
#   MAS_SHARED_SECRET  default: read from ENV_FILE
# =============================================================================
set -uo pipefail

ARTIFACT="${1:?usage: device-code.sh <artifact_file> [test_fn...]}"
shift || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OIDC_E2EH_DIR="${OIDC_E2EH_DIR:-/home/waldknoten-01/siwx-oidc-e2eh}"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env.e2e}"
SIWEOIDC_HOST="${SIWEOIDC_HOST:-http://localhost:18081}"
MATRIX_HOST="${MATRIX_HOST:-http://localhost:18080}"

[ -d "$OIDC_E2EH_DIR" ] || { echo "device-code.sh: $OIDC_E2EH_DIR not found" >&2; exit 2; }
command -v cargo >/dev/null 2>&1 || { echo "device-code.sh: cargo not on PATH" >&2; exit 2; }

# Source MAS_SHARED_SECRET from .env.e2e if not already provided.
if [ -z "${MAS_SHARED_SECRET:-}" ]; then
  [ -f "$ENV_FILE" ] || { echo "device-code.sh: $ENV_FILE not found and MAS_SHARED_SECRET unset" >&2; exit 2; }
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi
: "${MAS_SHARED_SECRET:?device-code.sh: MAS_SHARED_SECRET still unset after sourcing $ENV_FILE}"

{
  echo "===== device-code adapter (RFC 8628) ====="
  echo "test target  : e2e_device_code"
  echo "test filters : ${*:-<whole target>}"
  echo "siweoidc host: $SIWEOIDC_HOST"
  echo "matrix host  : $MATRIX_HOST"
  echo "mas secret   : <loaded from env>"
  echo "=========================================="
} >>"$ARTIFACT"

set +e
( cd "$OIDC_E2EH_DIR" && \
  SIWEOIDC_HOST="$SIWEOIDC_HOST" \
  MATRIX_HOST="$MATRIX_HOST" \
  MAS_SHARED_SECRET="$MAS_SHARED_SECRET" \
  cargo test --test e2e_device_code -- --ignored --nocapture "$@" \
) >>"$ARTIFACT" 2>&1
RC=$?
set -e 2>/dev/null || true

exit "$RC"
