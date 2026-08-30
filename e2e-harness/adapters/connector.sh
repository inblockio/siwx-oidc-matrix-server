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
#   * returns cargo's exit code, AFTER the shared honesty guards.
#
# -----------------------------------------------------------------------------
# 2026-08-30 — THIS ADAPTER PREVIOUSLY HAD NO HONESTY GUARDS AT ALL.
#
# It never sourced adapters/_common.sh, so it had:
#   * no zero-tests guard  -> `cargo test --exact <name>` exits 0 when the name
#     matches NOTHING, so a renamed/mistyped connector test was reported by
#     run.sh as a PASS while asserting nothing. This is defect class (b) from
#     the harness audit, and it was fully live here for all FIVE connector
#     checks — 5 of the 13 "pass" results in the last recorded full run.
#   * no skip-marker reporting,
#   * no revision assertion (it tested whatever branch the sibling
#     aqua-matrix-agent checkout happened to be on),
#   * and its precondition failures `echo`'d to stderr only, leaving a
#     ZERO-BYTE artifact — indistinguishable from "the check produced nothing".
#
# All four are fixed below by using _common.sh, the same as its siblings.
# -----------------------------------------------------------------------------
#
# Usage:
#   adapters/connector.sh <artifact_file> <test_name> [<test_name> ...]
#
# Env overrides (sane local defaults):
#   CONNECTOR_DIR   default /home/waldknoten-01/aqua-matrix-agent
#   SIWX_E2E_SIWX_URL   default http://localhost:18081
#   SIWX_E2E_MATRIX_URL default http://localhost:18080
#   CONNECTOR_EXPECT_SHA / CONNECTOR_EXPECT_REF
#       if set, the connector checkout MUST be at that revision/branch or the
#       adapter refuses to run (exit 2). Deliberately NOT the same variable as
#       the siwx-oidc E2E_EXPECT_SHA — this is a different repository.
#
# Exit codes: 2 = could not run (precondition); 3 = ran but judged nothing
# (filter matched no test); 4 = ran but skipped past assertions (strict mode);
# otherwise cargo's own code. See adapters/_common.sh.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$SCRIPT_DIR/_common.sh"

ARTIFACT="${1:?usage: connector.sh <artifact_file> <test_name>...}"
shift
# Make sure the artifact exists before anything can fail into it, so a
# precondition failure can never leave a zero-byte file.
: >>"$ARTIFACT"
[ "$#" -ge 1 ] || adapter_die "$ARTIFACT" 2 \
  "ADAPTER PRECONDITION FAILED: connector.sh needs >=1 test name."

CONNECTOR_DIR="${CONNECTOR_DIR:-/home/waldknoten-01/aqua-matrix-agent}"
SIWX_URL="${SIWX_E2E_SIWX_URL:-http://localhost:18081}"
MATRIX_URL="${SIWX_E2E_MATRIX_URL:-http://localhost:18080}"

[ -d "$CONNECTOR_DIR" ] || adapter_die "$ARTIFACT" 2 \
  "ADAPTER PRECONDITION FAILED: connector checkout not found at '$CONNECTOR_DIR'." \
  "  Set CONNECTOR_DIR=/path/to/aqua-matrix-agent."
[ -f "$CONNECTOR_DIR/Cargo.toml" ] || adapter_die "$ARTIFACT" 2 \
  "ADAPTER PRECONDITION FAILED: '$CONNECTOR_DIR' exists but has no Cargo.toml — not a Rust checkout."
# The connector is a cargo WORKSPACE: the target lives at
# crates/aqua-matrix-agent/tests/e2e.rs, not at <root>/tests/e2e.rs. `cargo test
# --test e2e` from the workspace root resolves it fine, so the check must be
# layout-agnostic — an earlier flat-layout assumption here failed all five
# connector checks with a bogus precondition error.
CONNECTOR_E2E_TARGET="$(find "$CONNECTOR_DIR" -path '*/tests/e2e.rs' -not -path '*/target/*' -print -quit 2>/dev/null)"
[ -n "$CONNECTOR_E2E_TARGET" ] || adapter_die "$ARTIFACT" 2 \
  "ADAPTER PRECONDITION FAILED: test target 'e2e' (tests/e2e.rs) not found anywhere under $CONNECTOR_DIR." \
  "  Looked for '*/tests/e2e.rs' excluding target/. Wrong checkout, wrong branch, or the target was renamed."
command -v openssl >/dev/null 2>&1 || adapter_die "$ARTIFACT" 2 \
  "ADAPTER PRECONDITION FAILED: openssl not on PATH."
command -v cargo   >/dev/null 2>&1 || adapter_die "$ARTIFACT" 2 \
  "ADAPTER PRECONDITION FAILED: cargo not on PATH."

# Refuse to run against an unexpected / unreproducible checkout.
assert_checkout_revision "$ARTIFACT" "$CONNECTOR_DIR" "connector checkout" \
  "${CONNECTOR_EXPECT_SHA:-}" "${CONNECTOR_EXPECT_REF:-}"

# Fresh throwaway material per run; cleaned up on return.
WORK="$(mktemp -d -t siwx-e2eh-connector.XXXXXX)"
CARGO_OUT="$(mktemp -t siwx-connector-out.XXXXXX)"
cleanup() { rm -rf "$WORK"; rm -f "$CARGO_OUT"; }
trap cleanup EXIT

KEY_A="$WORK/key-a.pem"
KEY_B="$WORK/key-b.pem"
STORE_ROOT="$WORK/store"
mkdir -p "$STORE_ROOT"

# ed25519 PKCS#8 PEM (openssl genpkey emits PKCS#8 by default for ed25519).
openssl genpkey -algorithm ed25519 -out "$KEY_A" 2>>"$ARTIFACT" \
  || adapter_die "$ARTIFACT" 2 "ADAPTER PRECONDITION FAILED: ed25519 keygen A failed."
openssl genpkey -algorithm ed25519 -out "$KEY_B" 2>>"$ARTIFACT" \
  || adapter_die "$ARTIFACT" 2 "ADAPTER PRECONDITION FAILED: ed25519 keygen B failed."

{
  echo "===== connector adapter ====="
  echo "checkout     : $CONNECTOR_DIR"
  echo "revision     : $(describe_checkout "$CONNECTOR_DIR")"
  echo "e2e target   : $CONNECTOR_E2E_TARGET"
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
) >"$CARGO_OUT" 2>&1
RC=$?
set -e 2>/dev/null || true

cat "$CARGO_OUT" >>"$ARTIFACT"
# THE GUARD THIS ADAPTER WAS MISSING: cargo exits 0 when --exact matches no
# test, so without this a renamed connector test is a silent green.
assert_tests_actually_ran "$ARTIFACT" "$CARGO_OUT" "$RC"; RC=$?
report_skip_markers      "$ARTIFACT" "$CARGO_OUT" "$RC"; RC=$?
exit "$RC"
