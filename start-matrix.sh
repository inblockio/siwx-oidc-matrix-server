#!/bin/bash

ENV_FILE=./.env

SIWEOIDC_CLIENT_ID=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 13; echo)
SIWEOIDC_SECRET_ID=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 13; echo)
SIWEOIDC_HOST=
SIWEOIDC_PORT=
SIWEOIDC_DEFAULT_CLIENTS=
RUST_LOG="siwx_oidc=error,tower_http=error"
SIWEOIDC_BASE_URL=
MATRIX_HOST=
MATRIX_PORT=
MATRIX_BASE_URL=
MATRIX_REPORT_STATS=no
MATRIX_MESSAGE_LIFETIME=4w
ATTACH=false
LETSENCRYPT_EMAIL=

#formatting
bold=$(tput bold)
red=$(tput setaf 1)
reset=$(tput sgr0)

function printHelp() {
echo "#################################################################"
echo "General"
echo "--ENABLE_DEBUG \"enable debug-mode (disable detach and set siwx-oidc debug-level)\""
echo "--LETSENCRYPT_EMAIL (required) \"set letsencrypt-email\""
echo "--reset \"resets/delete all data\""
echo "--stop \"stop all containers\""

echo ""
echo ""

echo "SIWX-OIDC Config"
echo "--SIWEOIDC_CLIENT_ID \"set siwx-oidc client-id (if not set, we will generate one)\" !!!ONLY USE IT IF YOU KNOW WHAT YOU DO!!!"
echo "--SIWEOIDC_SECRET_ID \"set siwx-oidc secret-id (if not set, we will generate one)\" !!!ONLY USE IT IF YOU KNOW WHAT YOU DO!!!"
echo "--SIWEOIDC_HOST (required) \"set siwx-oidc server e.g. siwx-oidc.example.com\""
echo "--SIWEOIDC_PORT \"set siwx-oidc port e.g. 8081 \" !!!ONLY USE IT IF YOU KNOW WHAT YOU DO!!!"
echo "--SIWEOIDC_DEFAULT_CLIENTS \"set siwx-oidc default_clients e.g \"'{<SIWEOIDC_CLIENT_ID>=\"{\\\"secret\\\":\\\"<SIWEOIDC_SECRET_ID>\\\", \\\"metadata\\\": {\\\"redirect_uris\\\": [\\\"<MATRIX_BASE_URL>/_synapse/client/oidc/callback\\\"]}}\"}'\" \" !!!ONLY USE IT IF YOU KNOW WHAT YOU DO!!!"

echo ""
echo ""

echo "MATRIX-Config"
echo "--MATRIX_HOST (required) \"set matrix-server e.g. matrix.example.com\""
echo "--MATRIX_PORT \"set matrix-port e.g. 8080 !!!ONLY USE IT IF YOU KNOW WHAT YOU DO!!!\""
echo "--MATRIX_MESSAGE_LIFETIME \"set message lifetime default: 4w"
echo "--MATRIX_REPORT_STATS \"default: no\""

echo ""
echo ""
echo "#################################################################"
}

function stopContainers() {
    docker compose down
}


function resetAllData() {
    read -r -p $'Destroying containers and deleting all data \n\tAre you sure? [y/N] ' response
    case "$response" in
                    [yY][eE][sS]|[yY])
                        docker compose down -v
                        rm .env
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
    docker compose up
else
  docker compose up -d
fi
}

function generateSigningKeyConfig() {
  # Generate persistent ES256 signing key in a TOML config file.
  # This file is mounted into the siwx-oidc container so the key
  # survives container restarts (tokens remain valid across redeploys).
  mkdir -p siwx-oidc-config
  if [ ! -f siwx-oidc-config/siwe-oidc.toml ]; then
    PEM=$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 2>/dev/null)
    cat > siwx-oidc-config/siwe-oidc.toml << TOMLEOF
signing_key_pem = """
${PEM}
"""
TOMLEOF
    echo "Generated persistent OIDC signing key in siwx-oidc-config/siwe-oidc.toml"
  else
    echo "OIDC signing key already exists, keeping existing key"
  fi
}

function checkRequiredArguments() {

    if [[ -z "${LETSENCRYPT_EMAIL}" ]]; then
      echoError "missing LETSENCRYPT_EMAIL!!!!"
      echoError "use --LETSENCRYPT_EMAIL"
      printHelp
      exit 1
    fi

    if [[ -z "${MATRIX_HOST}" ]]; then
      echoError "missing MATRIX_HOST!!!!"
      echoError "use --MATRIX_HOST"
      printHelp
      exit 1
    fi

    if [[ -z "${SIWEOIDC_HOST}" ]]; then
      echoError "missing SIWEOIDC_HOST!!!!"
      echoError "use --SIWEOIDC_HOST"
      printHelp
      exit 1
    fi

}

function checkAutoCompletion() {
    if  test -z "$SIWEOIDC_BASE_URL"; then
      if test -z "$SIWEOIDC_PORT"; then
        SIWEOIDC_BASE_URL="https://${SIWEOIDC_HOST}"
      else
        SIWEOIDC_BASE_URL="https://${SIWEOIDC_HOST}:${SIWEOIDC_PORT}"
      fi

    fi


    if test -z "$MATRIX_BASE_URL"; then
      if test -z "$MATRIX_PORT"; then
        MATRIX_BASE_URL="https://${MATRIX_HOST}"
      else
        MATRIX_BASE_URL="https://${MATRIX_HOST}:${MATRIX_PORT}"
      fi
    fi

}

function fillMissing() {

  if test -z "$SIWEOIDC_PORT"; then
      SIWEOIDC_PORT=8081
  fi

  if test -z "$MATRIX_PORT"; then
    MATRIX_PORT=8080
  fi

}



while [ "$#" -gt 0 ]; do
        case "$1" in
            --help)
              printHelp
              exit 1
              ;;
            --reset)
              resetAllData
              exit 1
              ;;
            --stop)
              stopContainers
              exit 1
              ;;
            --SIWEOIDC_CLIENT_ID)
                SIWEOIDC_CLIENT_ID="$2"
                shift
                shift
                ;;
            --SIWEOIDC_SECRET_ID)
                SIWEOIDC_SECRET_ID="$2"
                shift
                shift
                ;;
            --SIWEOIDC_HOST)
                SIWEOIDC_HOST="$2"
                shift
                shift
                ;;
            --SIWEOIDC_PORT)
                SIWEOIDC_PORT="$2"
                shift
                shift
                ;;
            --SIWEOIDC_DEFAULT_CLIENTS)
                SIWEOIDC_DEFAULT_CLIENTS="$2"
                shift
                shift
                ;;
            --ENABLE_DEBUG)
                RUST_LOG="siwx_oidc=debug,tower_http=trace"
                ATTACH=true
                shift
                ;;
            --MATRIX_HOST)
                MATRIX_HOST="$2"
                shift
                shift
                ;;
            --MATRIX_PORT)
                MATRIX_PORT="$2"
                shift
                shift
                ;;
            --MATRIX_MESSAGE_LIFETIME)
                MATRIX_MESSAGE_LIFETIME="$2"
                shift
                shift
                ;;
            --LETSENCRYPT_EMAIL)
                LETSENCRYPT_EMAIL="$2"
                shift
                shift
                ;;
            --MATRIX_REPORT_STATS)
                MATRIX_REPORT_STATS=yes
                shift
                ;;
                *)
                  echo "unknown arg ${1}"
                exit 0
                ;;
        esac
    done

checkRequiredArguments
checkAutoCompletion
fillMissing


if test -f "$ENV_FILE"; then
  source .env
  echo ".env found! skipping setup!"
  echo "if you want a new setup: rm .env && docker volume rm siwx-oidc-matrix-server_matrix_data"
  startupServer

else

  if test -z "$SIWEOIDC_DEFAULT_CLIENTS"
  then
  SIWEOIDC_DEFAULT_CLIENTS="'{$SIWEOIDC_CLIENT_ID=\"{\\\"secret\\\":\\\"$SIWEOIDC_SECRET_ID\\\", \\\"metadata\\\": {\\\"redirect_uris\\\": [\\\"$MATRIX_BASE_URL/_synapse/client/oidc/callback\\\"]}}\"}'"
  fi

  # Generate persistent OIDC signing key config
  generateSigningKeyConfig

  if [ ! -f ./.env ]; then
      touch .env
  else
    rm .env
    touch .env
  fi

  echo "#SIWEOIDC-CONFIG" >> .env
  echo "SIWEOIDC_HOST=$SIWEOIDC_HOST" >> .env
  echo "SIWEOIDC_PORT=$SIWEOIDC_PORT" >> .env
  echo "SIWEOIDC_DEFAULT_CLIENTS=$SIWEOIDC_DEFAULT_CLIENTS" >> .env
  echo "SIWEOIDC_BASE_URL=$SIWEOIDC_BASE_URL" >> .env
  echo "RUST_LOG=$RUST_LOG" >> .env


  echo "" >> .env
  echo "#GENERAL_CONFIG" >> .env
  echo "LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL" >> .env



  echo "#MATRIX-CONFIG" >> .env
  echo "MATRIX_OIDC_CLIENT_ID=$SIWEOIDC_CLIENT_ID" >> .env
  echo "MATRIX_OIDC_SECRET_ID=$SIWEOIDC_SECRET_ID" >> .env
  echo "MATRIX_HOST=$MATRIX_HOST" >> .env
  echo "MATRIX_PORT=$MATRIX_PORT" >> .env
  echo "MATRIX_BASE_URL=$MATRIX_BASE_URL" >> .env
  echo "MATRIX_REPORT_STATS=$MATRIX_REPORT_STATS" >> .env
  echo "MATRIX_MESSAGE_LIFETIME=$MATRIX_MESSAGE_LIFETIME" >> .env

  startupServer

fi
