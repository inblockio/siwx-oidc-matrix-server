#!/bin/bash

ENV_FILE=./.env.local

SIWEOIDC_CLIENT_ID=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 13; echo)
SIWEOIDC_SECRET_ID=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 13; echo)
SIWEOIDC_PORT=80
SIWEOIDC_HOST=localhost
RUST_LOG="siwe_oidc=error,tower_http=error"
MATRIX_HOST=localhost
MATRIX_PORT=8080
MATRIX_REPORT_STATS=no
MATRIX_MESSAGE_LIFETIME=4w
ATTACH=false
WALLETCONNECT_PROJECT_ID=

#formatting
bold=$(tput bold)
red=$(tput setaf 1)
reset=$(tput sgr0)

function printHelp() {
echo "#################################################################"
echo "Local Development Mode"
echo ""
echo "--WALLETCONNECT_PROJECT_ID (required) \"set WalletConnect project ID from cloud.walletconnect.com\""
echo "--ENABLE_DEBUG \"enable debug-mode (disable detach and set siweoidc debug-level)\""
echo "--MATRIX_PORT \"set matrix-port (default: 8080)\""
echo "--SIWEOIDC_PORT \"set siweoidc-port (default: 8081)\""
echo "--MATRIX_MESSAGE_LIFETIME \"set message lifetime (default: 4w)\""
echo "--reset \"resets/delete all data\""
echo "--stop \"stop all containers\""
echo "#################################################################"
}

function stopContainers() {
    docker compose -f docker-compose-local.yml --env-file .env.local down
}

function resetAllData() {
    read -r -p $'Destroying containers and deleting all data \n\tAre you sure? [y/N] ' response
    case "$response" in
                    [yY][eE][sS]|[yY])
                        docker compose -f docker-compose-local.yml --env-file .env.local down -v
                        rm -f .env.local
                        ;;
                    *)
                        echo "Aborting..."
                        exit 0
                        ;;
                esac
}

function echoError() {
    text=$1
    echo "${bold}${red}${text}${reset}"
}

function startupServer() {
if [ "$ATTACH" == "true" ]; then
    docker compose -f docker-compose-local.yml --env-file .env.local up --build
else
    docker compose -f docker-compose-local.yml --env-file .env.local up --build -d
fi
}

while [ "$#" -gt 0 ]; do
        case "$1" in
            --help)
              printHelp
              exit 0
              ;;
            --reset)
              resetAllData
              exit 0
              ;;
            --stop)
              stopContainers
              exit 0
              ;;
            --ENABLE_DEBUG)
                RUST_LOG="siwe_oidc=debug,tower_http=trace"
                ATTACH=true
                shift
                ;;
            --WALLETCONNECT_PROJECT_ID)
                WALLETCONNECT_PROJECT_ID="$2"
                shift
                shift
                ;;
            --MATRIX_PORT)
                MATRIX_PORT="$2"
                shift
                shift
                ;;
            --SIWEOIDC_PORT)
                SIWEOIDC_PORT="$2"
                shift
                shift
                ;;
            --MATRIX_MESSAGE_LIFETIME)
                MATRIX_MESSAGE_LIFETIME="$2"
                shift
                shift
                ;;
            *)
              echo "unknown arg ${1}"
              exit 1
              ;;
        esac
    done

if [[ -z "${WALLETCONNECT_PROJECT_ID}" ]]; then
    echoError "missing WALLETCONNECT_PROJECT_ID!!!!"
    echoError "use --WALLETCONNECT_PROJECT_ID"
    printHelp
    exit 1
fi

SIWEOIDC_BASE_URL="http://localhost:${SIWEOIDC_PORT}"
MATRIX_BASE_URL="http://localhost:${MATRIX_PORT}"
SIWEOIDC_DEFAULT_CLIENTS="'{${SIWEOIDC_CLIENT_ID}=\"{\\\"secret\\\":\\\"${SIWEOIDC_SECRET_ID}\\\", \\\"metadata\\\": {\\\"redirect_uris\\\": [\\\"${MATRIX_BASE_URL}/_synapse/client/oidc/callback\\\"]}}\"}'"

if test -f "$ENV_FILE"; then
    echo ".env.local found! skipping setup!"
    echo "if you want a new setup: rm .env.local && docker volume rm siwx-oidc-matrix-server_matrix_data"
    startupServer
else
    cat > .env.local <<EOF
#SIWEOIDC-CONFIG
SIWEOIDC_HOST=${SIWEOIDC_HOST}
SIWEOIDC_PORT=${SIWEOIDC_PORT}
SIWEOIDC_DEFAULT_CLIENTS=${SIWEOIDC_DEFAULT_CLIENTS}
SIWEOIDC_BASE_URL=${SIWEOIDC_BASE_URL}
RUST_LOG=${RUST_LOG}
#GENERAL_CONFIG
WALLETCONNECT_PROJECT_ID=${WALLETCONNECT_PROJECT_ID}
#MATRIX-CONFIG
MATRIX_OIDC_CLIENT_ID=${SIWEOIDC_CLIENT_ID}
MATRIX_OIDC_SECRET_ID=${SIWEOIDC_SECRET_ID}
MATRIX_HOST=${MATRIX_HOST}
MATRIX_PORT=${MATRIX_PORT}
MATRIX_BASE_URL=${MATRIX_BASE_URL}
MATRIX_REPORT_STATS=${MATRIX_REPORT_STATS}
MATRIX_MESSAGE_LIFETIME=${MATRIX_MESSAGE_LIFETIME}
EOF

    startupServer
fi
