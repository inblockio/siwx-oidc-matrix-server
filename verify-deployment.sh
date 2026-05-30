#!/bin/bash
set -uo pipefail

# Automated end-to-end verification of a live siwx-oidc-matrix-server deployment.
#
# Probes the PUBLIC endpoints (no SSH needed) and asserts the invariants that
# matter for the cross-signing identity-stability fix:
#   - siwx-oidc is up and its OIDC issuer byte-matches the well-known issuer
#     (trailing slash per RFC 8414, or Element's strict discovery rejects it).
#   - Synapse advertises siwx-oidc as its m.authentication issuer.
#   - Element Web ships force_verification:true so 4S recovery is mandatory
#     (device loss is recoverable instead of catastrophic).
#
# Optionally (--e2ee) runs the aqua-matrix-agent encrypted send/read smoke test,
# which exercises the full login -> provision -> device -> E2EE round trip
# against the live stack.
#
# Usage:
#   ./verify-deployment.sh [--e2ee]
#
# Env overrides (defaults target the inblock.io production hostnames):
#   MATRIX_HOST     (default matrix.inblock.io)
#   SIWEOIDC_HOST   (default siwx-oidc.inblock.io)
#   CLIENT_HOST     (default element.inblock.io)
#   E2E_TEST_REPO       (default https://github.com/inblockio/aqua-matrix-agent.git)
#   E2E_TEST_LOCAL_PATH (use a local checkout instead of cloning)

MATRIX_HOST="${MATRIX_HOST:-matrix.inblock.io}"
SIWEOIDC_HOST="${SIWEOIDC_HOST:-siwx-oidc.inblock.io}"
CLIENT_HOST="${CLIENT_HOST:-element.inblock.io}"
E2E_TEST_REPO="${E2E_TEST_REPO:-https://github.com/inblockio/aqua-matrix-agent.git}"
E2E_TEST_LOCAL_PATH="${E2E_TEST_LOCAL_PATH:-}"

# Canonical issuer must carry the trailing slash (RFC 8414 3.3 byte-match).
EXPECTED_ISSUER="https://${SIWEOIDC_HOST}/"

DO_E2EE=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --e2ee) DO_E2EE=true; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== Verifying deployment ==="
echo "  matrix:   https://${MATRIX_HOST}"
echo "  siwx-oidc: https://${SIWEOIDC_HOST}"
echo "  element:  https://${CLIENT_HOST}"
echo ""

# -- 1. siwx-oidc health ------------------------------------------------------
echo "[1] siwx-oidc health"
HEALTH_CODE=$(curl -sS -o /dev/null -w '%{http_code}' "https://${SIWEOIDC_HOST}/health" 2>/dev/null || echo "000")
if [ "$HEALTH_CODE" = "200" ]; then
  pass "/health returned 200"
else
  fail "/health returned ${HEALTH_CODE} (expected 200)"
fi

# -- 2. OIDC discovery + issuer byte-match ------------------------------------
echo "[2] OIDC discovery"
OIDC_META=$(curl -sS "https://${SIWEOIDC_HOST}/.well-known/openid-configuration" 2>/dev/null || echo "")
ISSUER=$(echo "$OIDC_META" | grep -o '"issuer"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"issuer"[[:space:]]*:[[:space:]]*"//; s/"$//')
if [ -z "$ISSUER" ]; then
  fail "no issuer in /.well-known/openid-configuration (got: ${OIDC_META:0:120})"
elif [ "$ISSUER" = "$EXPECTED_ISSUER" ]; then
  pass "issuer byte-matches '${EXPECTED_ISSUER}'"
else
  fail "issuer '${ISSUER}' != expected '${EXPECTED_ISSUER}'"
fi

# authorization_endpoint should be present for the login flow to work.
if echo "$OIDC_META" | grep -q '"authorization_endpoint"'; then
  pass "authorization_endpoint advertised"
else
  fail "authorization_endpoint missing from discovery document"
fi

# -- 3. Synapse well-known points at siwx-oidc --------------------------------
echo "[3] Matrix well-known"
WK_CLIENT=$(curl -sS "https://${MATRIX_HOST}/.well-known/matrix/client" 2>/dev/null || echo "")
if echo "$WK_CLIENT" | grep -q "\"base_url\"[[:space:]]*:[[:space:]]*\"https://${MATRIX_HOST}\""; then
  pass "m.homeserver.base_url is https://${MATRIX_HOST}"
else
  fail "m.homeserver.base_url not found (got: ${WK_CLIENT:0:160})"
fi
if echo "$WK_CLIENT" | grep -q "\"issuer\"[[:space:]]*:[[:space:]]*\"${EXPECTED_ISSUER}\""; then
  pass "m.authentication.issuer byte-matches '${EXPECTED_ISSUER}'"
else
  fail "m.authentication.issuer != '${EXPECTED_ISSUER}' (got: ${WK_CLIENT:0:200})"
fi

# -- 4. Element Web mandatory recovery (force_verification) -------------------
echo "[4] Element Web config"
ELEMENT_CFG=$(curl -sS "https://${CLIENT_HOST}/config.json" 2>/dev/null || echo "")
if [ -z "$ELEMENT_CFG" ]; then
  fail "could not fetch https://${CLIENT_HOST}/config.json"
else
  if echo "$ELEMENT_CFG" | grep -q '"force_verification"[[:space:]]*:[[:space:]]*true'; then
    pass "force_verification:true (4S recovery is mandatory)"
  else
    fail "force_verification not true -- device loss would be catastrophic"
  fi
  if echo "$ELEMENT_CFG" | grep -q "\"server_name\"[[:space:]]*:[[:space:]]*\"${MATRIX_HOST}\""; then
    pass "config points at server_name ${MATRIX_HOST}"
  else
    fail "config server_name != ${MATRIX_HOST} (template not rendered?)"
  fi
fi

# -- 5. Optional E2EE round-trip smoke test -----------------------------------
if [ "$DO_E2EE" = true ]; then
  echo "[5] E2EE round-trip smoke test"
  E2E_DIR=""
  if [ -n "$E2E_TEST_LOCAL_PATH" ] && [ -d "$E2E_TEST_LOCAL_PATH" ]; then
    E2E_DIR="$E2E_TEST_LOCAL_PATH"
    echo "  Using local test repo: $E2E_DIR"
  else
    E2E_DIR="/tmp/aqua-matrix-agent-e2e"
    if [ -d "$E2E_DIR/.git" ]; then
      git -C "$E2E_DIR" fetch origin >/dev/null 2>&1 && git -C "$E2E_DIR" checkout origin/main --detach >/dev/null 2>&1
    else
      rm -rf "$E2E_DIR"
      git clone --depth 1 "$E2E_TEST_REPO" "$E2E_DIR" >/dev/null 2>&1
    fi
  fi

  if [ ! -d "$E2E_DIR" ]; then
    fail "E2EE test repo unavailable"
  else
    echo "  Building test binary..."
    (cd "$E2E_DIR" && cargo build --release >/dev/null 2>&1) || true
    AGENT_BIN="$E2E_DIR/target/release/aqua-matrix-agent"
    AGENT_KEY="$E2E_DIR/agent.pem"
    if [ ! -f "$AGENT_BIN" ] || [ ! -f "$AGENT_KEY" ]; then
      fail "E2EE test binary or agent key missing"
    else
      TEST_STORE="/tmp/aqua-verify-smoke-$$"
      rm -rf "$TEST_STORE"
      MSG="verify-smoke-$(date +%s)"
      OUTPUT=$("$AGENT_BIN" --key-file "$AGENT_KEY" --store-dir "$TEST_STORE" \
        --message "$MSG" --read --read-limit 5 2>&1) || true
      if echo "$OUTPUT" | grep -q "$MSG"; then
        pass "E2EE message sent and read back"
      else
        fail "E2EE message readback not confirmed (login/provision/E2EE path)"
      fi
      rm -rf "$TEST_STORE"
    fi
  fi
fi

# -- Summary ------------------------------------------------------------------
echo ""
echo "=== Verification: ${PASS} passed, ${FAIL} failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All checks passed."
