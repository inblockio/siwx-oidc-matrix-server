#!/bin/bash

ENV_FILE=./.env

SIWXOIDC_CLIENT_ID=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 13; echo)
SIWXOIDC_SECRET_ID=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 13; echo)
SIWXOIDC_HOST=
SIWXOIDC_PORT=
SIWXOIDC_DEFAULT_CLIENTS=
RUST_LOG="siwx_oidc=error,tower_http=error"
SIWXOIDC_BASE_URL=
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
echo "--ENABLE_DEBUG \"enable debug-mode (disable detach and set siwxoidc debug-level)\""
echo "--LETSENCRYPT_EMAIL (required) \"set letsencrypt-email\""
echo "--reset \"resets/delete all data\""
echo "--stop \"stop all containers\""

echo ""
echo ""

echo "SIWXOIDC-Config"
echo "--SIWXOIDC_CLIENT_ID \"set siwxoidc-client-id (if not set, we will generate one)\" !!!ONLY USE IT IF YOU KNOW WHAT YOU DO!!!"
echo "--SIWXOIDC_SECRET_ID \"set siwxoidc-secret-id (if not set, we will generate one)\" !!!ONLY USE IT IF YOU KNOW WHAT YOU DO!!!"
echo "--SIWXOIDC_HOST (required) \"set siwxoidc-server e.g. siwx-oidc.example.com\""
echo "--SIWXOIDC_PORT \"set siwxoidc-port e.g. 8081 \" !!!ONLY USE IT IF YOU KNOW WHAT YOU DO!!!"
echo "--SIWXOIDC_DEFAULT_CLIENTS \"set siwxoidc_default_clients e.g \"'{<SIWXOIDC_CLIENT_ID>=\"{\\\"secret\\\":\\\"<SIWXOIDC_SECRET_ID>\\\", \\\"metadata\\\": {\\\"redirect_uris\\\": [\\\"<MATRIX_BASE_URL>/_synapse/client/oidc/callback\\\"]}}\"}'\" \" !!!ONLY USE IT IF YOU KNOW WHAT YOU DO!!!"

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
    docker-compose down
}


function resetAllData() {
    read -r -p $'Destroying containers and deleting all data \n\tAre you sure? [y/N] ' response
    case "$response" in
                    [yY][eE][sS]|[yY])
                        docker-compose down -v
                        rm .env
                        ;;
                    *)
                        echo "Aborting..."
                        exit 0
                        ;;
                esac
}

function echoEroor() {
    text=$1
    echo "${bold}${red}${text}${reset}"
}


function startupServer() {
if [ "$ATTACH" == "true" ]; then
    docker-compose up
else
  docker-compose up -d
fi
}

function checkRequiredArguments() {

    if [[ -z "${LETSENCRYPT_EMAIL}" ]]; then
      echoEroor "missing LETSENCRYPT_EMAIL!!!!"
      echoEroor "use --LETSENCRYPT_EMAIL"
      printHelp
      exit 1
    fi

    if [[ -z "${MATRIX_HOST}" ]]; then
      echoEroor "missing MATRIX_HOST!!!!"
      echoEroor "use --MATRIX_HOST"
      printHelp
      exit 1
    fi

    if [[ -z "${SIWXOIDC_HOST}" ]]; then
      echoEroor "missing SIWXOIDC_HOST!!!!"
      echoEroor "use --SIWXOIDC_HOST"
      printHelp
      exit 1
    fi

}

function checkAutoCompletion() {
    if  test -z "$SIWXOIDC_BASE_URL"; then
      if test -z "$SIWXOIDC_PORT"; then
        SIWXOIDC_BASE_URL="https://${SIWXOIDC_HOST}"
      else
        SIWXOIDC_BASE_URL="https://${SIWXOIDC_HOST}:${SIWXOIDC_PORT}"
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

  if test -z "$SIWXOIDC_PORT"; then
      SIWXOIDC_PORT=8081
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
            --SIWXOIDC_CLIENT_ID)
                SIWXOIDC_CLIENT_ID="$2"
                shift
                shift
                ;;
            --SIWXOIDC_SECRET_ID)
                SIWXOIDC_SECRET_ID="$2"
                shift
                shift
                ;;
            --SIWXOIDC_HOST)
                SIWXOIDC_HOST="$2"
                shift
                shift
                ;;
            --SIWXOIDC_PORT)
                SIWXOIDC_PORT="$2"
                shift
                shift
                ;;
            --SIWXOIDC_DEFAULT_CLIENTS)
                SIWXOIDC_DEFAULT_CLIENTS="$2"
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

  if test -z "$SIWXOIDC_DEFAULT_CLIENTS"
  then
  SIWXOIDC_DEFAULT_CLIENTS="'{$SIWXOIDC_CLIENT_ID=\"{\\\"secret\\\":\\\"$SIWXOIDC_SECRET_ID\\\", \\\"metadata\\\": {\\\"redirect_uris\\\": [\\\"$MATRIX_BASE_URL/_synapse/client/oidc/callback\\\"]}}\"}'"
  fi

  if [ ! -f ./.env ]; then
      touch .env
  else
    rm .env
    touch .env
  fi

  echo "#SIWXOIDC-CONFIG" >> .env
  echo "SIWXOIDC_HOST=$SIWXOIDC_HOST" >> .env
  echo "SIWXOIDC_PORT=$SIWXOIDC_PORT" >> .env
  echo "SIWXOIDC_DEFAULT_CLIENTS=$SIWXOIDC_DEFAULT_CLIENTS" >> .env
  echo "SIWXOIDC_BASE_URL=$SIWXOIDC_BASE_URL" >> .env
  echo "RUST_LOG=$RUST_LOG" >> .env


  echo "#GENERAL_CONFIG"
  echo "LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL" >> .env



  echo "#MATRIX-CONFIG" >> .env
  echo "MATRIX_OIDC_CLIENT_ID=$SIWXOIDC_CLIENT_ID" >> .env
  echo "MATRIX_OIDC_SECRET_ID=$SIWXOIDC_SECRET_ID" >> .env
  echo "MATRIX_HOST=$MATRIX_HOST" >> .env
  echo "MATRIX_PORT=$MATRIX_PORT" >> .env
  echo "MATRIX_BASE_URL=$MATRIX_BASE_URL" >> .env
  echo "MATRIX_REPORT_STATS=$MATRIX_REPORT_STATS" >> .env
  echo "MATRIX_MESSAGE_LIFETIME=$MATRIX_MESSAGE_LIFETIME" >> .env

  startupServer

fi
