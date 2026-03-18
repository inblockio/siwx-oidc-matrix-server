#!/bin/bash
# Local smoke-test launcher.
# Generates .env.local (client credentials for siwx-oidc), then starts the stack.
# No proxy, no letsencrypt, no TLS certs needed.
#
# Usage:
#   ./start-local.sh          # start
#   ./start-local.sh --stop   # stop
#   ./start-local.sh --reset  # stop + delete volumes + .env.local
#   ./start-local.sh --build  # force rebuild images then start
#   ./start-local.sh --logs   # follow logs after starting
#
# After start, test with:
#   curl http://localhost:18081/.well-known/openid-configuration
#   curl http://localhost:18080/_matrix/client/versions
#
# Browser login requires host.docker.internal to resolve to 127.0.0.1.
# On Linux, add to /etc/hosts:
#   127.0.0.1 host.docker.internal

set -e

COMPOSE="docker-compose -f docker-compose.local.yml"
ENV_LOCAL=".env.local"
CLIENT_ID="testclient123"
CLIENT_SECRET="testsecret456"
MATRIX_CALLBACK="http://localhost:18080/_synapse/client/oidc/callback"

build_flag=""
logs_flag=""

for arg in "$@"; do
    case "$arg" in
        --stop)
            echo "Stopping local stack..."
            $COMPOSE down
            exit 0
            ;;
        --reset)
            echo "Stopping and removing all local volumes..."
            $COMPOSE down -v
            rm -f "$ENV_LOCAL"
            echo "Reset complete."
            exit 0
            ;;
        --build)
            build_flag="--build"
            ;;
        --logs)
            logs_flag="1"
            ;;
        *)
            echo "Unknown argument: $arg"
            echo "Usage: $0 [--stop|--reset|--build|--logs]"
            exit 1
            ;;
    esac
done

# Generate .env.local with SIWXOIDC_DEFAULT_CLIENTS in figment TOML inline-table format
# The outer {} is a TOML inline table; the inner value is a JSON string for ClientEntry.
if [ ! -f "$ENV_LOCAL" ]; then
    echo "Generating $ENV_LOCAL..."
    cat > "$ENV_LOCAL" <<EOF
SIWXOIDC_DEFAULT_CLIENTS={${CLIENT_ID}="{\"secret\":\"${CLIENT_SECRET}\", \"metadata\": {\"redirect_uris\": [\"${MATRIX_CALLBACK}\"]}}"}
EOF
    echo "Created $ENV_LOCAL"
fi

echo "Starting local stack (Matrix + siwx-oidc + Redis)..."
echo "  Matrix:    http://localhost:18080"
echo "  siwx-oidc: http://localhost:18081"

$COMPOSE up -d $build_flag

if [ -n "$logs_flag" ]; then
    $COMPOSE logs -f
fi

echo ""
echo "Stack is up. Quick smoke tests:"
echo "  curl -s http://localhost:18081/.well-known/openid-configuration | head -5"
echo "  curl -s http://localhost:18080/_matrix/client/versions | head -5"
