#!/usr/bin/env bash
# =============================================================================
# adapters/connector.sh — encapsulate the aqua-matrix-agent (connector) e2e suite
# against the LOCAL hermetic stack (siwx-e2eh-*).
#
# Each invocation:
#   * generates TWO fresh throwaway ed25519 PKCS#8 PEMs (key A + key B) in a
#     fresh /tmp dir, and a fresh SIWX_E2E_STORE_ROOT dir — so the run never
#     touches the committed agent.pem / agent-b.pem identities or their durable
#     crypto stores (those bind to prod). Fresh keys => fresh local accounts.
#   * runs `cargo test --test e2e --features e2e` for the given test name(s),
#     pointed at the local siwx-oidc (:18081) + Synapse-via-caddy (:18080).
#   * streams the suite stdout/stderr to the artifact file passed as $1.
#   * returns cargo's exit code.
#
# Usage:
#   adapters/connector.sh <artifact_file> <test_name> [<test_name> ...]
#
# Env overrides (sane local defaults):
#   CONNECTOR_DIR   default /home/waldknoten-01/aqua-matrix-agent
#   SIWX_E2E_SIWX_URL   default http://localhost:18081
#   SIWX_E2E_MATRIX_URL default http://localhost:18080
# =============================================================================
set -uo pipefail

ARTIFACT="${1:?usage: connector.sh <artifact_file> <test_name>...}"
shift
[ "$#" -ge 1 ] || { echo "connector.sh: need >=1 test name" >&2; exit 2; }

CONNECTOR_DIR="${CONNECTOR_DIR:-/home/waldknoten-01/aqua-matrix-agent}"
SIWX_URL="${SIWX_E2E_SIWX_URL:-http://localhost:18081}"
MATRIX_URL="${SIWX_E2E_MATRIX_URL:-http://localhost:18080}"

[ -d "$CONNECTOR_DIR" ] || { echo "connector.sh: $CONNECTOR_DIR not found" >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "connector.sh: openssl not on PATH" >&2; exit 2; }
command -v cargo   >/dev/null 2>&1 || { echo "connector.sh: cargo not on PATH" >&2; exit 2; }

# Fresh throwaway material per run; cleaned up on return.
WORK="$(mktemp -d -t siwx-e2eh-connector.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

KEY_A="$WORK/key-a.pem"
KEY_B="$WORK/key-b.pem"
STORE_ROOT="$WORK/store"
mkdir -p "$STORE_ROOT"

# ed25519 PKCS#8 PEM (openssl genpkey emits PKCS#8 by default for ed25519).
openssl genpkey -algorithm ed25519 -out "$KEY_A" 2>>"$ARTIFACT" || { echo "connector.sh: keygen A failed" >&2; exit 2; }
openssl genpkey -algorithm ed25519 -out "$KEY_B" 2>>"$ARTIFACT" || { echo "connector.sh: keygen B failed" >&2; exit 2; }

{
  echo "===== connector adapter ====="
  echo "tests        : $*"
  echo "siwx url     : $SIWX_URL"
  echo "matrix url   : $MATRIX_URL"
  echo "key A / B    : $KEY_A / $KEY_B (fresh ed25519, throwaway)"
  echo "store root   : $STORE_ROOT (fresh, throwaway)"
  echo "============================="
} >>"$ARTIFACT"

# `--exact` requires the fully-qualified test name; the connector tests are free
# functions in tests/e2e.rs so the name IS the function name.
EXACT_ARGS=()
for t in "$@"; do EXACT_ARGS+=(--exact "$t"); done

set +e
( cd "$CONNECTOR_DIR" && \
  SIWX_E2E_SIWX_URL="$SIWX_URL" \
  SIWX_E2E_MATRIX_URL="$MATRIX_URL" \
  SIWX_E2E_KEY_A="$KEY_A" \
  SIWX_E2E_KEY_B="$KEY_B" \
  SIWX_E2E_STORE_ROOT="$STORE_ROOT" \
  cargo test --test e2e --features e2e -- --nocapture --test-threads=1 "${EXACT_ARGS[@]}" \
) >>"$ARTIFACT" 2>&1
RC=$?
set -e 2>/dev/null || true

exit "$RC"
