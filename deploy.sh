#!/bin/bash
set -euo pipefail

# Deploy siwx-oidc-matrix-server stack to agentic.inblock.io
# Prerequisites:
#   - SSH access to root@agentic.inblock.io via ~/.ssh/id_ed25519
#   - portal-caddy-1 running on the server with portal-net network
#   - DNS records pointing matrix.inblock.io, siwx-oidc.inblock.io, element.inblock.io to 139.59.144.60

SERVER="root@agentic.inblock.io"
SSH_KEY="$HOME/.ssh/id_ed25519"
REMOTE_DIR="/home/matrix"
SIWX_OIDC_REPO="https://github.com/inblockio/siwx-oidc.git"
CADDYFILE_PATH="/home/portal/portal/Caddyfile"

echo "=== Deploying siwx-oidc-matrix-server to agentic.inblock.io ==="

# Determine the repo root (where this script lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "[1/6] Creating remote directory structure..."
ssh -i "$SSH_KEY" "$SERVER" "mkdir -p ${REMOTE_DIR}/{dockerfiles,entrypoints,config}"

echo ""
echo "[2/6] Copying deployment files..."
scp -i "$SSH_KEY" \
  "$SCRIPT_DIR/docker-compose.yml" \
  "$SCRIPT_DIR/start-matrix.sh" \
  "$SCRIPT_DIR/.env.example" \
  "$SERVER:${REMOTE_DIR}/"

scp -i "$SSH_KEY" \
  "$SCRIPT_DIR/dockerfiles/Dockerfile" \
  "$SCRIPT_DIR/dockerfiles/Dockerfile.element" \
  "$SERVER:${REMOTE_DIR}/dockerfiles/"

scp -i "$SSH_KEY" \
  "$SCRIPT_DIR/entrypoints/matrix_server.sh" \
  "$SCRIPT_DIR/entrypoints/element_entrypoint.sh" \
  "$SERVER:${REMOTE_DIR}/entrypoints/"

scp -i "$SSH_KEY" \
  "$SCRIPT_DIR/config/element-config.json" \
  "$SCRIPT_DIR/config/siwx-redirect.js" \
  "$SCRIPT_DIR/config/siwx-splash.html" \
  "$SCRIPT_DIR/config/inblockio_logo_dark.png" \
  "$SERVER:${REMOTE_DIR}/config/"

echo ""
echo "[3/6] Cloning/updating siwx-oidc source on server..."
ssh -i "$SSH_KEY" "$SERVER" bash -s << 'REMOTE_SCRIPT'
if [ -d /home/matrix/siwx-oidc/.git ]; then
  cd /home/matrix/siwx-oidc
  git fetch origin
  git checkout feat/msc3861 2>/dev/null || git checkout -b feat/msc3861 origin/feat/msc3861
  git reset --hard origin/feat/msc3861
  echo "siwx-oidc repo updated (feat/msc3861)."
else
  git clone -b feat/msc3861 https://github.com/inblockio/siwx-oidc.git /home/matrix/siwx-oidc
  echo "siwx-oidc repo cloned (feat/msc3861)."
fi
REMOTE_SCRIPT

echo ""
echo "[4/6] Making scripts executable and fixing paths..."
ssh -i "$SSH_KEY" "$SERVER" "chmod +x ${REMOTE_DIR}/start-matrix.sh ${REMOTE_DIR}/entrypoints/*.sh"
# Fix siwx-oidc build context for server layout (./siwx-oidc instead of ../siwx-oidc)
ssh -i "$SSH_KEY" "$SERVER" "sed -i 's|context: \.\./siwx-oidc|context: ./siwx-oidc|' ${REMOTE_DIR}/docker-compose.yml"

echo ""
echo "[5/6] Updating Caddyfile..."
ssh -i "$SSH_KEY" "$SERVER" bash -s << 'CADDYFILE_SCRIPT'
CADDYFILE="/home/portal/portal/Caddyfile"

# Check if matrix entries already exist
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
        respond `{"m.homeserver": {"base_url": "https://matrix.inblock.io"}}`
    }

    reverse_proxy matrix_synapse:8080
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
fi
CADDYFILE_SCRIPT

echo ""
echo "[6/6] Reloading Caddy..."
ssh -i "$SSH_KEY" "$SERVER" "docker exec portal-caddy-1 caddy reload --config /etc/caddy/Caddyfile"

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Next steps:"
echo "  1. SSH to the server:  ssh -i $SSH_KEY $SERVER"
echo "  2. cd ${REMOTE_DIR}"
echo "  3. Run first-time setup:"
echo "     ./start-matrix.sh \\"
echo "       --MATRIX_HOST matrix.inblock.io \\"
echo "       --SIWEOIDC_HOST siwx-oidc.inblock.io \\"
echo "       --CLIENT_HOST element.inblock.io"
echo ""
echo "  Or for debug mode (foreground, verbose logs):"
echo "     ./start-matrix.sh --ENABLE_DEBUG \\"
echo "       --MATRIX_HOST matrix.inblock.io \\"
echo "       --SIWEOIDC_HOST siwx-oidc.inblock.io \\"
echo "       --CLIENT_HOST element.inblock.io"
