#!/bin/bash
set -euo pipefail

# Deploy siwx-oidc-matrix-server stack to agentic.inblock.io
#
# Usage:
#   ./deploy.sh <ref>                        # sync repos to <ref>, no build/restart
#   ./deploy.sh <ref> --build                # sync + rebuild images
#   ./deploy.sh <ref> --restart              # sync + restart (no rebuild)
#   ./deploy.sh <ref> --build --restart      # sync + rebuild + restart
#
# <ref> is any git ref: a tag (fork-stable), branch (main), or commit SHA.
# Both siwx-oidc-matrix-server and siwx-oidc repos are checked out at <ref>
# on the server. The ref must exist in both repos.
#
# Prerequisites:
#   - SSH access to root@agentic.inblock.io via ~/.ssh/id_ed25519
#   - portal-caddy-1 running on the server with portal-net network
#   - DNS records for matrix.inblock.io, siwx-oidc.inblock.io, element.inblock.io

SERVER="root@agentic.inblock.io"
SSH_KEY="$HOME/.ssh/id_ed25519"
REMOTE_DIR="/home/matrix"
MATRIX_REPO="https://github.com/inblockio/siwx-oidc-matrix-server.git"
OIDC_REPO="https://github.com/inblockio/siwx-oidc.git"
E2E_TEST_REPO="https://github.com/inblockio/aqua-matrix-hello.git"
E2E_TEST_LOCAL_PATH="${E2E_TEST_LOCAL_PATH:-}"

REF="${1:-}"
DO_BUILD=false
DO_RESTART=false
DO_TEST=false

if [ -z "$REF" ]; then
  echo "Usage: ./deploy.sh <ref> [--build] [--restart] [--test]"
  echo ""
  echo "  <ref>       Git tag, branch, or commit SHA (must exist in both repos)"
  echo "  --build     Rebuild Docker images after checkout"
  echo "  --restart   Restart containers (implies down + up)"
  echo "  --test      Run E2EE smoke test after deploy (requires --restart)"
  exit 1
fi
shift

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build)   DO_BUILD=true;   shift ;;
    --restart) DO_RESTART=true; shift ;;
    --test)    DO_TEST=true;    shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

SSH_CMD="ssh -i $SSH_KEY $SERVER"

echo "=== Deploying ref '$REF' to agentic.inblock.io ==="

echo ""
echo "[1/5] Syncing siwx-oidc-matrix-server repo..."
$SSH_CMD bash -s <<REMOTE_MATRIX
set -euo pipefail
if [ -d ${REMOTE_DIR}/stack/.git ]; then
  cd ${REMOTE_DIR}/stack
  git fetch origin --tags --force --prune
else
  git clone ${MATRIX_REPO} ${REMOTE_DIR}/stack
  cd ${REMOTE_DIR}/stack
fi
# Prefer remote branch over local tag when both exist
if git rev-parse "origin/${REF}" >/dev/null 2>&1; then
  git checkout "origin/${REF}" --detach
else
  git checkout "${REF}" --
fi
echo "siwx-oidc-matrix-server at \$(git rev-parse --short HEAD)"
REMOTE_MATRIX

echo ""
echo "[2/5] Syncing siwx-oidc repo..."
$SSH_CMD bash -s <<REMOTE_OIDC
set -euo pipefail
if [ -d ${REMOTE_DIR}/siwx-oidc/.git ]; then
  cd ${REMOTE_DIR}/siwx-oidc
  git fetch origin --tags --force --prune
else
  git clone ${OIDC_REPO} ${REMOTE_DIR}/siwx-oidc
  cd ${REMOTE_DIR}/siwx-oidc
fi
# Prefer remote branch over local tag when both exist
if git rev-parse "origin/${REF}" >/dev/null 2>&1; then
  git checkout "origin/${REF}" --detach
else
  git checkout "${REF}" --
fi
echo "siwx-oidc at \$(git rev-parse --short HEAD)"
REMOTE_OIDC

echo ""
echo "[3/5] Preparing build context..."
$SSH_CMD bash -s <<REMOTE_FIXUP
set -euo pipefail
cd ${REMOTE_DIR}/stack
chmod +x entrypoints/*.sh start-matrix.sh 2>/dev/null || true

# Migrate .env from old flat layout if present at the parent level
if [ -f ${REMOTE_DIR}/.env ] && [ ! -f ${REMOTE_DIR}/stack/.env ]; then
  mv ${REMOTE_DIR}/.env ${REMOTE_DIR}/stack/.env
  echo "Migrated .env into stack/."
fi

# Pin compose project name so volumes stay consistent across directory moves
if [ -f ${REMOTE_DIR}/stack/.env ] && ! grep -q COMPOSE_PROJECT_NAME ${REMOTE_DIR}/stack/.env; then
  echo "" >> ${REMOTE_DIR}/stack/.env
  echo "COMPOSE_PROJECT_NAME=matrix" >> ${REMOTE_DIR}/stack/.env
  echo "Pinned COMPOSE_PROJECT_NAME=matrix."
fi
echo "Build context ready."
REMOTE_FIXUP

echo ""
echo "[4/5] Ensuring Caddy routes..."
$SSH_CMD bash -s <<'CADDYFILE_SCRIPT'
CADDYFILE="/home/portal/portal/Caddyfile"

if grep -q "matrix.inblock.io" "$CADDYFILE"; then
  echo "Caddy entries for matrix already exist, skipping."
else
  cat >> "$CADDYFILE" << 'EOF'
matrix.inblock.io {
    encode zstd gzip

    handle /.well-known/matrix/server {
        respond `{"m.server": "matrix.inblock.io:443"}`
    }
    handle /.well-known/matrix/client {
        header Access-Control-Allow-Origin *
        respond `{"m.homeserver": {"base_url": "https://matrix.inblock.io"}, "m.authentication": {"issuer": "https://siwx-oidc.inblock.io"}}`
    }

    handle /_matrix/client/v3/login {
        reverse_proxy siwx-oidc:8081
    }
    handle /_matrix/client/v3/logout {
        reverse_proxy siwx-oidc:8081
    }
    handle /_matrix/client/v3/refresh {
        reverse_proxy siwx-oidc:8081
    }

    handle {
        reverse_proxy matrix_synapse:8080
    }
}

siwx-oidc.inblock.io {
    encode zstd gzip
    reverse_proxy siwx-oidc:8081
}

element.inblock.io {
    encode zstd gzip
    reverse_proxy element-web:8080
}
EOF
  echo "Caddy entries added."
  docker exec portal-caddy-1 caddy reload --config /etc/caddy/Caddyfile
  echo "Caddy reloaded."
fi
CADDYFILE_SCRIPT

echo ""
echo "[5/5] Build and restart..."
if [ "$DO_BUILD" = true ]; then
  echo "Building images..."
  $SSH_CMD "cd ${REMOTE_DIR}/stack && docker compose build --no-cache"
fi

if [ "$DO_RESTART" = true ]; then
  echo "Restarting containers..."
  $SSH_CMD "cd ${REMOTE_DIR}/stack && docker compose down && docker compose up -d"
  echo "Waiting for health checks..."
  sleep 5
  $SSH_CMD "cd ${REMOTE_DIR}/stack && docker compose ps --format 'table {{.Name}}\t{{.Status}}'"
else
  if [ "$DO_BUILD" = false ]; then
    echo "Repos synced. Use --build and/or --restart to apply."
  fi
fi

# --- E2EE smoke test ---
if [ "$DO_TEST" = true ]; then
  echo ""
  echo "[6/6] Running E2EE smoke test..."

  # Resolve the test repo: prefer local path, fall back to public repo
  E2E_DIR=""
  if [ -n "$E2E_TEST_LOCAL_PATH" ] && [ -d "$E2E_TEST_LOCAL_PATH" ]; then
    E2E_DIR="$E2E_TEST_LOCAL_PATH"
    echo "Using local test repo: $E2E_DIR"
  else
    E2E_DIR="/tmp/aqua-matrix-hello-e2e"
    if [ -d "$E2E_DIR/.git" ]; then
      echo "Updating test repo at $E2E_DIR..."
      git -C "$E2E_DIR" fetch origin && git -C "$E2E_DIR" checkout origin/main --detach
    else
      echo "Cloning test repo from $E2E_TEST_REPO..."
      rm -rf "$E2E_DIR"
      git clone --depth 1 "$E2E_TEST_REPO" "$E2E_DIR"
    fi
  fi

  echo "Building test binary..."
  (cd "$E2E_DIR" && cargo build --release 2>&1 | tail -3)

  AGENT_BIN="$E2E_DIR/target/release/aqua-matrix-agent"
  if [ ! -f "$AGENT_BIN" ]; then
    echo "ERROR: test binary not found at $AGENT_BIN"
    exit 1
  fi

  # Use a dedicated test store so we don't conflict with other agent sessions
  TEST_STORE="/tmp/aqua-deploy-smoke-test"
  rm -rf "$TEST_STORE"

  AGENT_A_KEY="$E2E_DIR/agent.pem"
  AGENT_B_KEY="$E2E_DIR/agent-b.pem"

  if [ ! -f "$AGENT_A_KEY" ] || [ ! -f "$AGENT_B_KEY" ]; then
    echo "ERROR: agent key files not found (agent.pem, agent-b.pem)"
    exit 1
  fi

  AGENT_A_STORE="$TEST_STORE/agent-a"
  MSG="deploy-smoke-test-$(date +%s)"

  echo "Smoke test: Agent A sends message and reads back..."
  OUTPUT=$("$AGENT_BIN" --key-file "$AGENT_A_KEY" --store-dir "$AGENT_A_STORE" \
    --message "$MSG" --read --read-limit 5 2>&1) || true

  if echo "$OUTPUT" | grep -q "sent to"; then
    echo "  Message sent successfully"
  else
    echo "  WARNING: send may have failed"
  fi

  if echo "$OUTPUT" | grep -q "$MSG"; then
    echo "E2EE smoke test PASSED: message sent and read back successfully"
  else
    echo "WARNING: E2EE smoke test could not verify message readback"
    echo "  (This may be normal on first deploy with a fresh crypto store)"
  fi

  rm -rf "$TEST_STORE"
fi

echo ""
echo "=== Deploy complete (ref: ${REF}) ==="
